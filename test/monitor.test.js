/*
 * Tests for the system monitor: parsing, thresholds, the alert lifecycle,
 * crash-loop detection, email rendering, and the compose-override runtime
 * defaults (log rotation + resource limits).
 *
 * Run: node test/monitor.test.js   (also part of `npm test`)
 *
 * No database, no Docker, no network — the model and notifier are replaced
 * with in-memory fakes through require.cache before the modules load.
 */

const assert = require('assert');
const path = require('path');
const yaml = require('js-yaml');

let pass = 0, fail = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

// ── fakes ──

const fakeRows = [];
let nextId = 1;
const FakeMonitor = {
  async loadOpenAlerts() { return fakeRows.filter((r) => !r.resolved_at); },
  async openAlert(f) {
    const row = { id: nextId++, key: f.key, rule: f.rule, severity: f.severity, subject: f.subject, message: f.message, details: f.details || null, opened_at: new Date(), last_seen_at: new Date(), resolved_at: null, notified_severity: null };
    fakeRows.push(row);
    return { ...row };
  },
  async touchAlert(id, f) {
    const row = fakeRows.find((r) => r.id === id);
    Object.assign(row, { severity: f.severity, message: f.message, last_seen_at: new Date() });
    return { ...row };
  },
  async resolveAlert(id, by) {
    const row = fakeRows.find((r) => r.id === id && !r.resolved_at);
    if (!row) return null;
    row.resolved_at = new Date(); row.resolved_by = by;
    return { ...row };
  },
  async markNotified() {},
};
const sent = [];
const FakeNotify = { enqueue: (i) => sent.push(i) };

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('src/models/monitor.js', FakeMonitor);
stub('src/services/monitor/notify.js', FakeNotify);

const P = require('../src/services/monitor/parse');
const { DEFAULT_RULES, severityFor } = require('../src/services/monitor/rules');
const alerts = require('../src/services/monitor/alerts');
const { generateOverride, generateStatefulOverride } = require('../src/services/composeWrapper');

const rule = (id, extra = {}) => ({ id, enabled: true, ...DEFAULT_RULES[id], ...extra });

// ── parse ──

check('meminfo uses MemAvailable, not MemFree', () => {
  const m = P.parseMeminfo('MemTotal: 8000000 kB\nMemFree: 500000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n');
  assert.strictEqual(m.totalBytes, 8000000 * 1024);
  assert.strictEqual(m.usedPct, 50);
  assert.strictEqual(m.swapUsedPct, 25);
});

check('meminfo without swap reports 0%', () => {
  const m = P.parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
  assert.strictEqual(m.usedPct, 75);
  assert.strictEqual(m.swapUsedPct, 0);
});

check('/proc/stat CPU% across two samples', () => {
  const a = P.parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3');
  const b = P.parseProcStat('cpu  150 0 150 900 0 0 0 0 0 0\n');
  assert.strictEqual(P.cpuPctFromProcStat(a, b), 50);
  assert.strictEqual(P.cpuPctFromProcStat(null, b), null);
});

const statsRaw = (total, sys, usage, limit, inactive = 0) => ({
  cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: sys, online_cpus: 4 },
  memory_stats: { usage, limit, stats: { inactive_file: inactive } },
  networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
  blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 5 }, { op: 'Write', value: 7 }] },
  pids_stats: { current: 12 },
});

check('container stats: CPU from previous sample, cache excluded from memory', () => {
  const host = 8 * 1024 ** 3;
  const prev = statsRaw(1e9, 100e9, 0, host);
  const cur = statsRaw(2e9, 110e9, 600 * 1024 ** 2, host, 100 * 1024 ** 2);
  const s = P.normalizeContainerStats(cur, prev, host);
  assert.strictEqual(s.cpuPct, 40);          // 1e9/10e9 * 4 cores * 100
  assert.strictEqual(s.cpuPctOfHost, 10);
  assert.strictEqual(s.memBytes, 500 * 1024 ** 2);
  assert.strictEqual(s.memLimited, false);   // limit == host → no real limit
  assert.strictEqual(s.netRxBytes, 11);
  assert.strictEqual(s.blkWriteBytes, 7);
  assert.strictEqual(s.pids, 12);
});

check('container stats: a real mem_limit is detected', () => {
  const s = P.normalizeContainerStats(statsRaw(1, 1, 256 * 1024 ** 2, 512 * 1024 ** 2), null, 8 * 1024 ** 3);
  assert.strictEqual(s.memLimited, true);
  assert.strictEqual(s.memPct, 50);
  assert.strictEqual(s.cpuPct, null); // no previous sample yet
});

check('hoursUntil projects a steady climb', () => {
  const t0 = Date.now() - 6 * 3600e3;
  const pts = Array.from({ length: 7 }, (_, i) => ({ t: t0 + i * 3600e3, v: 100 + i * 10 }));
  // 160 now, +10/h → 40 more to 200 = 4h
  assert.strictEqual(P.hoursUntil(pts, 200), 4);
});

check('hoursUntil ignores flat, falling, short or noisy series', () => {
  const t0 = Date.now() - 6 * 3600e3;
  const flat = Array.from({ length: 7 }, (_, i) => ({ t: t0 + i * 3600e3, v: 100 }));
  const falling = flat.map((p, i) => ({ ...p, v: 100 - i }));
  const short = flat.slice(0, 3).map((p, i) => ({ ...p, v: 100 + i }));
  const saw = flat.map((p, i) => ({ ...p, v: i % 2 ? 300 : 100 + i }));
  assert.strictEqual(P.hoursUntil(flat, 200), null);
  assert.strictEqual(P.hoursUntil(falling, 200), null);
  assert.strictEqual(P.hoursUntil(short, 200), null);
  assert.strictEqual(P.hoursUntil(saw, 1000, { minR2: 0.85 }), null);
});

check('exit codes: stop/kill are intentional, others are crashes', () => {
  assert.strictEqual(P.isUnexpectedExit(0), false);
  assert.strictEqual(P.isUnexpectedExit('143'), false);
  assert.strictEqual(P.isUnexpectedExit(137), false);
  assert.strictEqual(P.isUnexpectedExit(1), true);
  assert.strictEqual(P.isUnexpectedExit('2'), true);
});

// ── thresholds ──

check('severityFor: above-direction thresholds', () => {
  const r = rule('host_memory');
  assert.strictEqual(severityFor(r, 50), null);
  assert.strictEqual(severityFor(r, 85), 'warning');
  assert.strictEqual(severityFor(r, 96), 'critical');
});

check('severityFor: clear margin keeps an open alert open just under the line', () => {
  const r = rule('host_memory'); // warn 85, margin 3
  assert.strictEqual(severityFor(r, 83, false), null);
  assert.strictEqual(severityFor(r, 83, true), 'warning');
  assert.strictEqual(severityFor(r, 81, true), null);
});

check('severityFor: below-direction (days left) and disabled rules', () => {
  const r = rule('disk_days_left'); // warn 7, crit 2
  assert.strictEqual(severityFor(r, 30), null);
  assert.strictEqual(severityFor(r, 6), 'warning');
  assert.strictEqual(severityFor(r, 1.5), 'critical');
  assert.strictEqual(severityFor(r, null), null);
  assert.strictEqual(severityFor({ ...r, enabled: false }, 1), null);
});

check('severityFor: rule with no critical level only warns', () => {
  assert.strictEqual(severityFor(rule('container_cpu'), 99), 'warning');
});

// ── alert lifecycle ──

const mem = (severity = 'warning', forTicks = 3) => ({ key: 'host_memory:host', rule: 'host_memory', severity, subject: 'host', message: `Memory ${severity}`, forTicks });

check('alert opens only after forTicks consecutive firings', async () => {
  await alerts.init();
  sent.length = 0;
  await alerts.evaluate(['host_memory'], [mem()]);
  await alerts.evaluate(['host_memory'], [mem()]);
  assert.strictEqual(alerts.isOpen('host_memory:host'), false);
  await alerts.evaluate(['host_memory'], [mem()]);
  assert.strictEqual(alerts.isOpen('host_memory:host'), true);
  assert.deepStrictEqual(sent.map((s) => s.type), ['opened']);
});

check('a gap resets the streak', async () => {
  await alerts.evaluate(['host_swap'], [{ key: 'host_swap:host', rule: 'host_swap', severity: 'warning', message: 's', forTicks: 2 }]);
  await alerts.evaluate(['host_swap'], []);
  await alerts.evaluate(['host_swap'], [{ key: 'host_swap:host', rule: 'host_swap', severity: 'warning', message: 's', forTicks: 2 }]);
  assert.strictEqual(alerts.isOpen('host_swap:host'), false);
});

check('escalation to critical notifies; repeat at same severity does not', async () => {
  sent.length = 0;
  await alerts.evaluate(['host_memory'], [mem('warning')]);
  await alerts.evaluate(['host_memory'], [mem('critical')]);
  await alerts.evaluate(['host_memory'], [mem('critical')]);
  assert.deepStrictEqual(sent.map((s) => s.type), ['escalated']);
});

check('another rule family never resolves this alert', async () => {
  await alerts.evaluate(['cert_expiry'], [], { clearTicks: 1 });
  assert.strictEqual(alerts.isOpen('host_memory:host'), true);
});

check('resolves after clearTicks absent; emails the resolve only if the open was emailed', async () => {
  sent.length = 0;
  // Pretend the open/escalation email went out.
  alerts.openAlerts().find((a) => a.key === 'host_memory:host').notified_severity = 'critical';
  await alerts.evaluate(['host_memory'], []);
  assert.strictEqual(alerts.isOpen('host_memory:host'), true);
  await alerts.evaluate(['host_memory'], []);
  assert.strictEqual(alerts.isOpen('host_memory:host'), false);
  assert.deepStrictEqual(sent.map((s) => s.type), ['resolved']);

  // Same again but never emailed → silent resolve.
  sent.length = 0;
  await alerts.evaluate(['host_load'], [{ key: 'host_load:host', rule: 'host_load', severity: 'warning', message: 'l', forTicks: 1 }]);
  sent.length = 0;
  await alerts.evaluate(['host_load'], [], { clearTicks: 1 });
  assert.strictEqual(alerts.isOpen('host_load:host'), false);
  assert.strictEqual(sent.length, 0);
});

check('event alerts open at once and expire after their TTL', async () => {
  await alerts.fire({ key: 'container_oom:web', rule: 'container_oom', severity: 'critical', message: 'oom' }, 60);
  assert.strictEqual(alerts.isOpen('container_oom:web'), true);
  // State evaluation of the same rule family must not resolve an event alert.
  await alerts.evaluate(['container_oom'], [], { clearTicks: 1 });
  assert.strictEqual(alerts.isOpen('container_oom:web'), true);
  alerts.openAlerts().find((a) => a.key === 'container_oom:web').last_seen_at = new Date(Date.now() - 61 * 60000);
  await alerts.sweepEvents();
  assert.strictEqual(alerts.isOpen('container_oom:web'), false);
});

check('open alerts survive a restart (init reloads them, no duplicate open)', async () => {
  await alerts.evaluate(['disk_used'], [{ key: 'disk_used:docker', rule: 'disk_used', severity: 'warning', message: 'd', forTicks: 1 }]);
  await alerts.init();
  sent.length = 0;
  await alerts.evaluate(['disk_used'], [{ key: 'disk_used:docker', rule: 'disk_used', severity: 'warning', message: 'd', forTicks: 1 }]);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(fakeRows.filter((r) => r.key === 'disk_used:docker' && !r.resolved_at).length, 1);
});

// ── crash-loop detection ──

check('3 unexpected exits in 10 min opens a crash-loop alert; clean stops do not count', async () => {
  // events.js reads rules via getRules() → Settings → DB; stub that too.
  stub('src/services/monitor/rules.js', { getRules: async () => ({ container_oom: rule('container_oom'), container_crashloop: rule('container_crashloop') }), severityFor, DEFAULT_RULES });
  delete require.cache[require.resolve('../src/services/monitor/events')];
  const events = require('../src/services/monitor/events');
  const die = (code) => events._onEvent({ Action: 'die', Actor: { ID: 'abc', Attributes: { name: 'shop-backend-d9', exitCode: String(code) } } });
  await die(0); await die(143); await die(137);
  assert.strictEqual(alerts.isOpen('container_crashloop:shop-backend-d9'), false);
  await die(1); await die(1);
  assert.strictEqual(alerts.isOpen('container_crashloop:shop-backend-d9'), false);
  await die(1);
  assert.strictEqual(alerts.isOpen('container_crashloop:shop-backend-d9'), true);
});

// ── email rendering ──

check('email batches into one message, subject leads with the worst severity', () => {
  const realNotify = (() => {
    const p = require.resolve('../src/services/monitor/notify');
    const saved = require.cache[p];
    delete require.cache[p];
    const m = require('../src/services/monitor/notify');
    require.cache[p] = saved;
    return m;
  })();
  const at = new Date('2026-11-18T12:00:00Z');
  const { subject, html, text } = realNotify._render('mini', [
    { type: 'opened', alert: { severity: 'warning', message: 'Disk 82% full', opened_at: at } },
    { type: 'opened', alert: { severity: 'critical', message: 'web <oom>', opened_at: at } },
  ]);
  assert.ok(subject.startsWith('[mini] CRITICAL: Disk 82% full (+1 more)'), subject);
  assert.ok(html.includes('web &lt;oom&gt;'), 'html is escaped');
  assert.ok(text.includes('WARNING  Disk 82% full'));
});

// ── compose override runtime defaults ──

const base = { appSlug: 'Shop', deployId: 7, publicService: 'frontend', domain: 'shop.example.com', publicPort: 80, allServices: ['frontend', 'backend', 'postgres'], statefulServices: ['postgres'] };

check('every service gets log rotation by default', () => {
  const o = yaml.load(generateOverride(base));
  for (const s of ['frontend', 'backend']) {
    assert.deepStrictEqual(o.services[s].logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } });
  }
  assert.strictEqual(o.services.postgres, undefined, 'stateful service is not in the per-deploy override');
  assert.strictEqual(o.services.backend.mem_limit, undefined, 'no limit unless asked');
});

check('custom logging limits and logging: false', () => {
  const custom = yaml.load(generateOverride({ ...base, bhConfig: { logging: { max_size: '20m', max_file: 5 } } }));
  assert.deepStrictEqual(custom.services.backend.logging.options, { 'max-size': '20m', 'max-file': '5' });
  const off = yaml.load(generateOverride({ ...base, bhConfig: { logging: false } }));
  assert.strictEqual(off.services.backend.logging, undefined);
});

check('resources: default applies everywhere, per-service wins, junk ignored', () => {
  const o = yaml.load(generateOverride({ ...base, bhConfig: { resources: { default: { memory: '512m' }, backend: { memory: '1G', cpus: 1.5 }, frontend: { cpus: 'lots' } } } }));
  assert.strictEqual(o.services.frontend.mem_limit, '512m');
  assert.strictEqual(o.services.frontend.cpus, undefined);
  assert.strictEqual(o.services.backend.mem_limit, '1g');
  assert.strictEqual(o.services.backend.cpus, 1.5);
});

check('stateful override gets the same rotation and limits', () => {
  const o = yaml.load(generateStatefulOverride('shop-internal', [], { services: ['postgres'], bhConfig: { resources: { default: { memory: '256m' } } } }));
  assert.strictEqual(o.networks.internal.name, 'shop-internal');
  assert.strictEqual(o.services.postgres.mem_limit, '256m');
  assert.strictEqual(o.services.postgres.logging.driver, 'json-file');
  // Old two-argument callers still get a valid file with no services block.
  assert.strictEqual(yaml.load(generateStatefulOverride('n', [])).services, undefined);
});

// ── run ──

(async () => {
  console.log('\nSystem monitor');
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
