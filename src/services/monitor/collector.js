const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const db = require('../../db');
const config = require('../../config');
const logger = require('../../logger');
const Apps = require('../../models/apps');
const Deployments = require('../../models/deployments');
const Settings = require('../../models/settings');
const Monitor = require('../../models/monitor');
const { readBeachheadConfig } = require('../composeWrapper');
const dockerApi = require('./dockerApi');
const alerts = require('./alerts');
const { getRules, severityFor } = require('./rules');
const P = require('./parse');

/**
 * The collector — one tick a minute.
 *
 * WHAT "HOST" MEANS: everything is read from inside the beachhead-api
 * container. /proc/meminfo, /proc/stat and statfs('/') are not namespaced,
 * so on Linux they describe the real host and on macOS they describe Docker
 * Desktop's VM — which is the ceiling containers actually hit on the mac
 * mini (its memory slider and disk-image size), not the Mac's own RAM.
 * The same code reports the right thing on both.
 *
 * Cadences (all inside the one timer, so there's a single loop to reason
 * about):
 *   every tick (60s)  host, disks, container stats, container state,
 *                     deploy checks, event-alert sweep, heartbeat
 *   every 2 min       HTTPS probe of each live app through nginx-proxy
 *   every 15 min      docker disk breakdown, disk-full + memory-leak trends
 *   every 6 h         certificate expiry
 *   every hour        rollups + retention
 *
 * Each section is isolated: one failing (Docker restarting, DB blip) doesn't
 * stop the others, and the failure is visible in the snapshot.
 */

const TICK_MS = 60_000;
const PROBE_EVERY_MS = 2 * 60_000;
const SLOW_EVERY_MS = 15 * 60_000;
const CERT_EVERY_MS = 6 * 3600_000;
const ROLLUP_EVERY_MS = 3600_000;
const INFO_EVERY_MS = 3600_000;
const STATS_CONCURRENCY = 6;
// Probes identify themselves so nginx/activity-log.conf can drop them —
// otherwise a probe every 2 min would keep every on-demand app awake forever.
const PROBE_USER_AGENT = 'Beachhead-Monitor/1.0';

const state = {
  startedAt: null,
  lastTickAt: null,
  tickMs: null,
  errors: {},           // section → last error message
  host: null,
  disks: [],
  containers: [],
  dockerInfo: null,
  dockerDf: null,
  certs: [],
  probes: [],
  deploys: { stuck: [], failed: [] },
  dbSizeBytes: null,
  heartbeat: null,
};

const timers = { probe: 0, slow: 0, cert: 0, rollup: 0, info: 0 };
let prevProcStat = null;
const prevRaw = new Map();         // container id → previous raw stats
const bhConfigCache = new Map();   // deployment id → beachhead.json (or null)
let interval = null;
let ticking = false;

// ── lifecycle ──

async function start() {
  if (interval) return;
  state.startedAt = new Date().toISOString();
  await alerts.init();
  // First tick shortly after boot so the dashboard has data quickly, but not
  // during the startup reconcile storm.
  setTimeout(() => tick(), 10_000).unref?.();
  interval = setInterval(() => tick(), TICK_MS);
  interval.unref?.();
  // Certs: first check a couple of minutes in, then every 6h.
  timers.cert = Date.now() - CERT_EVERY_MS + 2 * 60_000;
  logger.info('System monitor started');
}

function stop() {
  if (interval) clearInterval(interval);
  interval = null;
}

async function tick() {
  if (ticking) return; // a slow Docker daemon shouldn't stack ticks
  ticking = true;
  const t0 = Date.now();
  const now = new Date();
  const samples = [];
  let coreOk = true;

  try {
    const rules = await getRules();

    if (t0 - timers.info > INFO_EVERY_MS || !state.dockerInfo) {
      await section('dockerInfo', async () => {
        const i = await dockerApi.info();
        state.dockerInfo = {
          serverVersion: i.ServerVersion,
          operatingSystem: i.OperatingSystem,
          kernel: i.KernelVersion,
          ncpu: i.NCPU,
          memTotalBytes: i.MemTotal,
          dockerRootDir: i.DockerRootDir,
          containers: i.Containers,
          images: i.Images,
        };
        timers.info = t0;
      });
    }

    coreOk = (await section('host', () => collectHost(now, samples))) && coreOk;
    await section('disks', () => collectDisks(now, samples));
    coreOk = (await section('containers', () => collectContainers(now, samples))) && coreOk;

    await section('samples', () => Monitor.insertSamples(samples));

    await section('evaluate', () => evaluateState(rules));
    await section('deploys', () => evaluateDeploys(rules));
    await section('events', () => alerts.sweepEvents());

    if (t0 - timers.probe >= PROBE_EVERY_MS) {
      timers.probe = t0;
      await section('probes', () => probeApps(rules));
    }
    if (t0 - timers.slow >= SLOW_EVERY_MS) {
      timers.slow = t0;
      await section('dockerDf', collectDockerDf);
      await section('trends', () => evaluateTrends(rules));
      await section('dbSize', async () => { state.dbSizeBytes = await Monitor.databaseSizeBytes(); });
    }
    if (t0 - timers.cert >= CERT_EVERY_MS) {
      timers.cert = t0;
      await section('certs', () => checkCerts(rules));
    }
    if (t0 - timers.rollup >= ROLLUP_EVERY_MS) {
      timers.rollup = t0;
      await section('rollup', async () => {
        await Monitor.rollupAndPrune();
        await Monitor.pruneResolvedAlerts(90);
      });
    }

    // Dead-man's switch: only ping when the parts that matter actually ran,
    // so a wedged Docker daemon stops the pings and the outside service
    // emails you.
    if (coreOk) await section('heartbeat', pingHeartbeat);
  } finally {
    state.lastTickAt = now.toISOString();
    state.tickMs = Date.now() - t0;
    ticking = false;
  }
}

async function section(name, fn) {
  try {
    await fn();
    delete state.errors[name];
    return true;
  } catch (err) {
    state.errors[name] = err.message;
    logger.warn(`Monitor ${name} failed: ${err.message}`);
    return false;
  }
}

// ── host ──

async function collectHost(now, samples) {
  let mem;
  try {
    mem = P.parseMeminfo(await fs.promises.readFile('/proc/meminfo', 'utf8'));
  } catch {
    // Not Linux (running `npm run dev` straight on macOS) — os.freemem() is
    // the best we can do there.
    const total = os.totalmem();
    const free = os.freemem();
    mem = { totalBytes: total, availableBytes: free, usedBytes: total - free, usedPct: P.round(((total - free) / total) * 100), swapTotalBytes: 0, swapUsedBytes: 0, swapUsedPct: 0 };
  }

  let load;
  try { load = P.parseLoadavg(await fs.promises.readFile('/proc/loadavg', 'utf8')); }
  catch { const [a, b, c] = os.loadavg(); load = { load1: a, load5: b, load15: c }; }

  let cpuPct = null;
  try {
    const cur = P.parseProcStat(await fs.promises.readFile('/proc/stat', 'utf8'));
    cpuPct = P.cpuPctFromProcStat(prevProcStat, cur);
    prevProcStat = cur;
  } catch { /* no /proc/stat off Linux */ }

  const ncpu = state.dockerInfo?.ncpu || os.cpus().length || 1;
  state.host = {
    ...mem,
    ...load,
    ncpu,
    loadPerCore: P.round(load.load5 / ncpu, 2),
    cpuPct,
    uptimeSec: Math.round(os.uptime()),
  };
  samples.push({
    ts: now, kind: 'host', subject: 'host',
    data: pickNumbers(state.host, ['usedPct', 'usedBytes', 'totalBytes', 'swapUsedPct', 'cpuPct', 'load1', 'load5', 'loadPerCore']),
  });
}

/**
 * Disks: the filesystem holding Docker's storage (images, volumes, build
 * cache — the container's own root fs lives there) and the deploy directory.
 * On Linux these are usually the same disk and only one is reported; on
 * Docker Desktop the deploy dir is the Mac's disk, shared into the VM, and
 * shows up separately.
 */
async function collectDisks(now, samples) {
  const targets = [
    { label: 'docker', path: '/', description: 'Docker storage (images, volumes, build cache)' },
    { label: 'deployments', path: config.deploy.baseDir, description: 'Deploy directory' },
  ];
  const disks = [];
  for (const t of targets) {
    let s;
    try { s = await fs.promises.statfs(t.path); } catch { continue; }
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    // Same filesystem as one already listed? Skip rather than alert twice.
    if (disks.some((d) => d.totalBytes === total && Math.abs(d.freeBytes - avail) < total * 0.001)) continue;
    // "used" against what a non-root process can still write (bavail), which
    // is what a container will hit — ext4 reserves ~5% for root.
    const used = total - avail;
    disks.push({
      label: t.label, path: t.path, description: t.description,
      totalBytes: total, freeBytes: avail, usedBytes: used,
      usedPct: total ? P.round((used / total) * 100) : 0,
      daysLeft: state.disks.find((d) => d.label === t.label)?.daysLeft ?? null,
    });
  }
  state.disks = disks;
  for (const d of disks) {
    samples.push({ ts: now, kind: 'disk', subject: d.label, data: pickNumbers(d, ['usedPct', 'usedBytes', 'totalBytes', 'freeBytes']) });
  }
}

// ── containers ──

async function collectContainers(now, samples) {
  const list = await dockerApi.listContainers(true);
  const owners = await resolveOwners(list);
  const hostMem = state.host?.totalBytes || state.dockerInfo?.memTotalBytes || 0;

  const running = list.filter((c) => c.State === 'running');
  const stats = await mapLimit(running, STATS_CONCURRENCY, async (c) => {
    try {
      const raw = await dockerApi.stats(c.Id);
      const s = P.normalizeContainerStats(raw, prevRaw.get(c.Id), hostMem);
      prevRaw.set(c.Id, raw);
      return [c.Id, s];
    } catch {
      return [c.Id, null];
    }
  });
  const statsById = new Map(stats);
  // Forget containers that no longer exist.
  for (const id of prevRaw.keys()) if (!list.some((c) => c.Id === id)) prevRaw.delete(id);

  state.containers = list.map((c) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id.slice(0, 12);
    const o = owners.get(c.Id) || {};
    const health = /\((unhealthy|healthy|health: starting)\)/.exec(c.Status || '')?.[1] || null;
    return {
      id: c.Id.slice(0, 12),
      name,
      image: c.Image,
      state: c.State,
      status: c.Status,
      health,
      project: c.Labels?.['com.docker.compose.project'] || null,
      service: c.Labels?.['com.docker.compose.service'] || null,
      owner: o.owner || 'unknown',
      appId: o.appId ?? null,
      appName: o.appName ?? null,
      stats: statsById.get(c.Id) || null,
    };
  });

  for (const c of state.containers) {
    if (!c.stats) continue;
    samples.push({
      ts: now, kind: 'container', subject: c.name, appId: c.appId, service: c.service,
      data: pickNumbers(c.stats, ['cpuPct', 'cpuPctOfHost', 'memBytes', 'memPct', 'memLimitBytes', 'netRxBytes', 'netTxBytes', 'blkReadBytes', 'blkWriteBytes', 'pids']),
    });
  }
}

/**
 * Container → owning app, using the same conventions as routes/system.js:
 * per-deploy projects are `deploy-<id>`, stateful projects `<slug>-stateful`.
 */
async function resolveOwners(list) {
  const apps = await Apps.findAll();
  const bySlug = new Map(apps.map((a) => [slugify(a.name), a]));
  const byId = new Map(apps.map((a) => [a.id, a]));
  const deployIds = [];
  for (const c of list) {
    const m = /^deploy-(\d+)$/.exec(c.Labels?.['com.docker.compose.project'] || '');
    if (m) deployIds.push(Number(m[1]));
  }
  const rows = deployIds.length ? await Deployments.findAppIdsByIds(deployIds) : [];
  const deployToApp = new Map(rows.map((r) => [r.id, r.app_id]));

  const out = new Map();
  for (const c of list) {
    const project = c.Labels?.['com.docker.compose.project'] || '';
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    let entry = { owner: 'unknown' };
    const dm = /^deploy-(\d+)$/.exec(project);
    if (project === 'beachhead' || INFRA.includes(name)) entry = { owner: 'beachhead' };
    else if (dm) {
      const app = byId.get(deployToApp.get(Number(dm[1])));
      entry = { owner: 'app', appId: app?.id ?? null, appName: app?.name ?? null, deployId: Number(dm[1]) };
    } else if (project.endsWith('-stateful')) {
      const app = bySlug.get(project.replace(/-stateful$/, ''));
      entry = { owner: 'stateful', appId: app?.id ?? null, appName: app?.name ?? null };
    } else if (name.startsWith('static-site-')) entry = { owner: 'static-site' };
    out.set(c.Id, entry);
  }
  return out;
}

// Core containers that must always be running. Names are fixed in
// docker-compose.yml (see the README's "one Beachhead per VM" note).
const INFRA = ['beachhead-api', 'beachhead-db', config.certs.proxyContainer, config.certs.acmeContainer];

// ── state rules (every tick) ──

async function evaluateState(rules) {
  const firings = [];
  const h = state.host;
  const add = (rule, subject, value, message, details, forTicksOverride) => {
    const key = `${rule}:${subject}`;
    const sev = severityFor(rules[rule], value, alerts.isOpen(key));
    if (sev) firings.push({ key, rule, severity: sev, subject, message: message(sev), details, forTicks: forTicksOverride ?? rules[rule].forTicks });
  };

  if (h) {
    add('host_memory', 'host', h.usedPct, () => `Memory ${h.usedPct}% used (${fmtBytes(h.usedBytes)} of ${fmtBytes(h.totalBytes)})`, { usedPct: h.usedPct });
    if (h.swapTotalBytes > 0) add('host_swap', 'host', h.swapUsedPct, () => `Swap ${h.swapUsedPct}% used`, { swapUsedPct: h.swapUsedPct });
    add('host_load', 'host', h.loadPerCore, () => `Load ${h.load5} on ${h.ncpu} cores (${h.loadPerCore}× per core)`, { load5: h.load5, ncpu: h.ncpu });
  }
  for (const d of state.disks) {
    add('disk_used', d.label, d.usedPct, () => `${d.description}: ${d.usedPct}% full (${fmtBytes(d.freeBytes)} free)`, { usedPct: d.usedPct, freeBytes: d.freeBytes });
  }

  for (const c of state.containers) {
    if (c.state === 'running' && c.stats) {
      if (c.stats.memLimited) {
        add('container_mem_limit', c.name, c.stats.memPct, () => `${c.name} at ${c.stats.memPct}% of its ${fmtBytes(c.stats.memLimitBytes)} memory limit`, { memBytes: c.stats.memBytes });
      } else {
        add('container_mem_host', c.name, c.stats.memPct, () => `${c.name} using ${fmtBytes(c.stats.memBytes)} (${c.stats.memPct}% of host) with no memory limit`, { memBytes: c.stats.memBytes });
      }
      add('container_cpu', c.name, c.stats.cpuPctOfHost, () => `${c.name} using ${c.stats.cpuPctOfHost}% of all CPU`, { cpuPct: c.stats.cpuPct });
    }
    if (c.health === 'unhealthy' && rules.container_unhealthy.enabled) {
      firings.push({ key: `container_unhealthy:${c.name}`, rule: 'container_unhealthy', severity: 'warning', subject: c.name, message: `${c.name} healthcheck is failing`, forTicks: 2 });
    }
  }

  // Core containers.
  if (rules.infra_down.enabled) {
    for (const name of INFRA) {
      const c = state.containers.find((x) => x.name === name);
      if (!c || c.state !== 'running') {
        firings.push({ key: `infra_down:${name}`, rule: 'infra_down', severity: 'critical', subject: name, message: `${name} is ${c ? c.state : 'missing'}`, forTicks: rules.infra_down.forTicks });
      }
    }
  }

  if (rules.service_down.enabled) firings.push(...(await serviceDownFirings(rules)));

  await alerts.evaluate(
    ['host_memory', 'host_swap', 'host_load', 'disk_used', 'container_mem_limit', 'container_mem_host', 'container_cpu', 'container_unhealthy', 'infra_down', 'service_down'],
    firings,
  );
}

/**
 * Apps that should be serving but have a service down. Skips apps that are
 * paused (manually or by on-demand idle), mid-deploy, or never deployed.
 * Services listed in beachhead.json `monitor.ignore_services` are skipped —
 * for one-shot jobs like a migration container that's meant to exit.
 */
async function serviceDownFirings(rules) {
  const apps = await Apps.findAll();
  const { rows: busy } = await db.query(`SELECT DISTINCT app_id FROM deployments WHERE state NOT IN ('SUCCESS', 'FAILED')`);
  const deploying = new Set(busy.map((r) => r.app_id));
  const firings = [];

  for (const app of apps) {
    if (!app.active_deployment_id || app.paused || app.auto_paused || deploying.has(app.id)) continue;
    const bh = bhConfigFor(app);
    const ignore = new Set(bh?.monitor?.ignore_services || []);
    const slug = slugify(app.name);
    const deployProject = `deploy-${app.active_deployment_id}`;
    const mine = state.containers.filter((c) => c.project === deployProject || c.project === `${slug}-stateful`);
    const transient = mine.filter((c) => c.project === deployProject);

    const problems = [];
    if (transient.length === 0) problems.push('no containers');
    for (const c of mine) {
      if (ignore.has(c.service)) continue;
      if (['exited', 'dead', 'restarting', 'created'].includes(c.state)) problems.push(`${c.service || c.name} ${c.state}`);
    }
    // A declared stateful service with no container at all.
    for (const s of bh?.stateful_services || []) {
      if (!ignore.has(s) && !mine.some((c) => c.project === `${slug}-stateful` && c.service === s)) problems.push(`${s} missing`);
    }
    if (problems.length) {
      firings.push({
        key: `service_down:${app.id}`, rule: 'service_down', severity: 'critical', subject: app.name,
        message: `${app.name}: ${problems.join(', ')}`, details: { appId: app.id, problems }, forTicks: rules.service_down.forTicks,
      });
    }
  }
  return firings;
}

// ── deployments (every tick) ──

async function evaluateDeploys(rules) {
  const stuckMin = rules.deploy_stuck.warn ?? 20;
  const stuck = rules.deploy_stuck.enabled ? await Monitor.stuckDeployments(stuckMin) : [];
  const failed = rules.deploy_failed.enabled ? await Monitor.appsWithFailedLatestDeploy() : [];
  state.deploys = { stuck, failed };

  const firings = [
    ...stuck.map((d) => ({
      key: `deploy_stuck:${d.id}`, rule: 'deploy_stuck', severity: 'warning', subject: d.app_name,
      message: `${d.app_name} deploy #${d.id} has been in ${d.state} for over ${stuckMin} min`, details: { deployId: d.id, state: d.state },
    })),
    ...failed.map((d) => ({
      key: `deploy_failed:${d.app_id}`, rule: 'deploy_failed', severity: 'warning', subject: d.app_name,
      message: `${d.app_name} deploy #${d.id} failed${d.lastLogLine ? ` — ${d.lastLogLine.replace(/^\[FAILED\]\s*/, '')}` : ''}`, details: { deployId: d.id },
    })),
  ];
  await alerts.evaluate(['deploy_stuck', 'deploy_failed'], firings, { clearTicks: 1 });
}

// ── HTTPS probes (every 2 min) ──

async function probeApps(rules) {
  const apps = await Apps.findAll();
  const { rows: busy } = await db.query(`SELECT DISTINCT app_id FROM deployments WHERE state NOT IN ('SUCCESS', 'FAILED')`);
  const deploying = new Set(busy.map((r) => r.app_id));
  const stagingRoot = await Settings.getStagingRootDomain();

  const targets = apps
    .filter((a) => a.active_deployment_id && a.domain && !a.paused && !a.auto_paused && !deploying.has(a.id))
    .map((a) => {
      const staging = a.staging_subdomain && stagingRoot ? `${a.staging_subdomain}.${stagingRoot}` : null;
      const host = a.staging_only && staging ? staging : a.domain;
      return { app: a, host, path: bhConfigFor(a)?.health_check || '/' };
    });

  const results = await mapLimit(targets, 4, async (t) => {
    const r = await probe(t.host, t.path);
    return { appId: t.app.id, appName: t.app.name, host: t.host, path: t.path, ...r, checkedAt: new Date().toISOString() };
  });
  state.probes = results;

  const firings = [];
  if (rules.http_down.enabled) {
    for (const r of results) {
      if (r.ok) continue;
      firings.push({
        key: `http_down:${r.appId}`, rule: 'http_down', severity: 'critical', subject: r.appName,
        message: `${r.host} is not responding (${r.error || `HTTP ${r.status}`})`, details: { host: r.host, status: r.status, error: r.error },
        forTicks: rules.http_down.forTicks,
      });
    }
  }
  await alerts.evaluate(['http_down'], firings, { clearTicks: 1 });
}

/**
 * Request the app through nginx-proxy over HTTPS with the real SNI + Host,
 * exactly as a visitor would, minus DNS. Plain HTTP isn't enough: nginx-proxy
 * answers it with a 301 itself, without touching the app. Falls back to HTTP
 * only when the host has no certificate yet. Down = 5xx or no response;
 * a 404 or 401 still proves the app is up.
 */
function probe(host, urlPath) {
  const proxy = config.certs.proxyContainer;
  const headers = { Host: host, 'User-Agent': PROBE_USER_AGENT };
  const once = (mod, opts) => new Promise((resolve) => {
    const started = Date.now();
    const req = mod.request({ host: proxy, path: urlPath, method: 'GET', headers, timeout: 10_000, ...opts }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, ms: Date.now() - started });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ error: err.code || err.message, ms: Date.now() - started }));
    req.end();
  });
  return (async () => {
    // Cert validity is checked separately (checkCerts); here we only care
    // whether the app answers, and we're connecting by container name.
    let r = await once(https, { port: 443, servername: host, rejectUnauthorized: false });
    if (r.error && /EPROTO|ECONNRESET|SSL|certificate/i.test(r.error)) {
      r = await once(http, { port: 80 });
      if (r.status >= 300 && r.status < 400) r = { ...r, error: 'HTTPS failed and HTTP only redirects' };
    }
    return { ...r, ok: !r.error && r.status < 500 };
  })();
}

// ── slow checks (every 15 min) ──

async function collectDockerDf() {
  const df = await dockerApi.systemDf();
  const images = df.Images || [];
  const vols = df.Volumes || [];
  const cache = df.BuildCache || [];
  const ctrs = df.Containers || [];
  const sum = (arr, f) => arr.reduce((a, x) => a + Math.max(0, f(x) || 0), 0);
  state.dockerDf = {
    at: new Date().toISOString(),
    images: { count: images.length, bytes: df.LayersSize || sum(images, (i) => i.Size), reclaimableBytes: sum(images.filter((i) => !i.Containers), (i) => i.Size - (i.SharedSize > 0 ? i.SharedSize : 0)) },
    containers: { count: ctrs.length, bytes: sum(ctrs, (c) => c.SizeRw) },
    volumes: {
      count: vols.length,
      bytes: sum(vols, (v) => v.UsageData?.Size),
      reclaimableBytes: sum(vols.filter((v) => v.UsageData?.RefCount === 0), (v) => v.UsageData?.Size),
      largest: vols.filter((v) => v.UsageData?.Size > 0).sort((a, b) => b.UsageData.Size - a.UsageData.Size).slice(0, 8)
        .map((v) => ({ name: v.Name, bytes: v.UsageData.Size, inUse: v.UsageData.RefCount > 0 })),
    },
    buildCache: { count: cache.length, bytes: sum(cache, (c) => c.Size), reclaimableBytes: sum(cache.filter((c) => !c.InUse), (c) => c.Size) },
  };
}

async function evaluateTrends(rules) {
  const firings = [];

  // Disk: project the last 24h of growth forward.
  for (const d of state.disks) {
    const pts = await Monitor.recentPoints({ kind: 'disk', subject: d.label, field: 'usedBytes', sinceMs: 24 * 3600_000 });
    const hours = P.hoursUntil(pts, d.totalBytes);
    d.daysLeft = hours == null ? null : P.round(hours / 24);
    const key = `disk_days_left:${d.label}`;
    const sev = severityFor(rules.disk_days_left, d.daysLeft, alerts.isOpen(key));
    if (sev) firings.push({ key, rule: 'disk_days_left', severity: sev, subject: d.label, message: `${d.description} on track to fill in ~${d.daysLeft} days`, details: { daysLeft: d.daysLeft } });
  }

  // Memory leaks: a steady climb over 6h, projected into the ceiling.
  if (rules.container_mem_leak.enabled) {
    for (const c of state.containers) {
      if (c.state !== 'running' || !c.stats?.memLimitBytes) continue;
      const pts = await Monitor.recentPoints({ kind: 'container', subject: c.name, field: 'memBytes', sinceMs: 6 * 3600_000 });
      const hours = P.hoursUntil(pts, c.stats.memLimitBytes, { minSpanMs: 3 * 3600_000, minR2: 0.85 });
      c.leakHours = hours;
      const key = `container_mem_leak:${c.name}`;
      const sev = severityFor(rules.container_mem_leak, hours, alerts.isOpen(key));
      if (sev) {
        const ceiling = c.stats.memLimited ? 'its memory limit' : 'all host memory';
        firings.push({ key, rule: 'container_mem_leak', severity: sev, subject: c.name, message: `${c.name} memory climbing steadily — reaches ${ceiling} in ~${Math.round(hours)}h`, details: { hours } });
      }
    }
  }

  await alerts.evaluate(['disk_days_left', 'container_mem_leak'], firings, { clearTicks: 1 });
}

// ── certificates (every 6 h) ──

/**
 * Only hostnames Beachhead is currently serving — an old domain's leftover
 * cert expiring isn't an incident. acme-companion stores one cert per
 * LETSENCRYPT_HOST group under the first host and symlinks `<host>.crt` for
 * the rest, so certs are grouped by resolved file to alert once per cert.
 */
async function checkCerts(rules) {
  const hosts = new Set();
  const stagingRoot = await Settings.getStagingRootDomain();
  for (const a of await Apps.findAll()) {
    if (!a.domain) continue;
    hosts.add(a.domain);
    if (a.www_redirect) hosts.add(`www.${a.domain}`);
    if (a.staging_subdomain && stagingRoot) hosts.add(`${a.staging_subdomain}.${stagingRoot}`);
  }
  const extra = await db.query(`
    SELECT domain AS d, www_redirect AS www FROM app_endpoints
    UNION ALL SELECT unnest(domains), false FROM standalone_certs
    UNION ALL SELECT unnest(domains), false FROM reverse_proxy_targets WHERE enabled`);
  for (const r of extra.rows) { hosts.add(r.d); if (r.www) hosts.add(`www.${r.d}`); }
  if (config.domain) hosts.add(config.domain);

  const byFile = new Map();
  for (const host of hosts) {
    const candidates = [path.join(config.certs.dir, `${host}.crt`), path.join(config.certs.dir, host, 'fullchain.pem')];
    for (const p of candidates) {
      let real;
      try { real = await fs.promises.realpath(p); } catch { continue; }
      if (!byFile.has(real)) byFile.set(real, { file: real, hosts: [] });
      byFile.get(real).hosts.push(host);
      break;
    }
  }

  const certs = [];
  for (const entry of byFile.values()) {
    try {
      const x509 = new crypto.X509Certificate(await fs.promises.readFile(entry.file));
      const expires = new Date(x509.validTo);
      certs.push({ hosts: entry.hosts.sort(), expiresAt: expires.toISOString(), daysLeft: Math.floor((expires - Date.now()) / 86400_000) });
    } catch (err) {
      certs.push({ hosts: entry.hosts.sort(), error: err.message });
    }
  }
  certs.sort((a, b) => (a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9));
  state.certs = certs;

  const firings = [];
  for (const c of certs) {
    if (c.daysLeft == null) continue;
    const key = `cert_expiry:${c.hosts[0]}`;
    const sev = severityFor(rules.cert_expiry, c.daysLeft, alerts.isOpen(key));
    // Let's Encrypt renews at 30 days left, so reaching 14 means renewal has
    // been failing for two weeks.
    if (sev) firings.push({ key, rule: 'cert_expiry', severity: sev, subject: c.hosts[0], message: `Certificate for ${c.hosts.join(', ')} expires in ${c.daysLeft} days — renewal isn't happening`, details: c });
  }
  await alerts.evaluate(['cert_expiry'], firings, { clearTicks: 1 });
}

// ── heartbeat ──

async function pingHeartbeat() {
  const url = await Settings.get('monitor_heartbeat_url');
  if (!url) { state.heartbeat = null; return; }
  const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': PROBE_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  state.heartbeat = { at: new Date().toISOString(), status: res.status };
  if (!res.ok) throw new Error(`heartbeat URL returned ${res.status}`);
}

// ── helpers ──

function bhConfigFor(app) {
  const id = app.active_deployment_id;
  if (!id) return null;
  if (bhConfigCache.has(id)) return bhConfigCache.get(id);
  const dir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${id}`);
  const cfg = readBeachheadConfig(dir);
  bhConfigCache.set(id, cfg);
  if (bhConfigCache.size > 500) bhConfigCache.delete(bhConfigCache.keys().next().value);
  return cfg;
}

function slugify(name) {
  return (name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
}

function pickNumbers(obj, keys) {
  const out = {};
  for (const k of keys) if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) out[k] = obj[k];
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function fmtBytes(n) {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function getSnapshot() {
  return state;
}

module.exports = { start, stop, tick, getSnapshot, PROBE_USER_AGENT, _probe: probe };
