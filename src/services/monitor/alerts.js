const Monitor = require('../../models/monitor');
const notify = require('./notify');
const logger = require('../../logger');

/**
 * Alert lifecycle.
 *
 * Two kinds of input:
 *
 *   evaluate(rules, firings) — state checks run on a cadence (memory, disk,
 *     service down…). A firing must persist `forTicks` evaluations to open,
 *     and an open alert must be absent `clearTicks` evaluations to resolve.
 *     Only alerts whose rule is in `rules` can be resolved by that call, so
 *     the cert check running every 6h never resolves a memory alert.
 *
 *   fire(firing, ttlMinutes) — events (OOM, crash loop). Open immediately;
 *     resolve once nothing new has arrived for ttlMinutes.
 *
 * Every open, escalation (warning → critical) and resolve is handed to the
 * notifier, which batches them into one email per flush.
 */

const open = new Map();          // key → alert row
const streaks = new Map();       // key → consecutive firing evaluations
const clearStreaks = new Map();  // key → consecutive absent evaluations
const eventTtl = new Map();      // key → minutes

const SEVERITY_RANK = { warning: 1, critical: 2 };

async function init() {
  open.clear();
  for (const row of await Monitor.loadOpenAlerts()) open.set(row.key, row);
  logger.info(`Monitor: ${open.size} open alert(s) restored`);
}

function isOpen(key) {
  return open.has(key);
}

function openAlerts() {
  return Array.from(open.values());
}

async function evaluate(rules, firings, { clearTicks = 2 } = {}) {
  const ruleSet = new Set(rules);
  const seen = new Set();

  for (const f of firings) {
    seen.add(f.key);
    clearStreaks.delete(f.key);
    const n = (streaks.get(f.key) || 0) + 1;
    streaks.set(f.key, n);
    const existing = open.get(f.key);
    if (existing) {
      await update(existing, f);
    } else if (n >= (f.forTicks || 1)) {
      await openNew(f);
    }
  }

  // Anything in these rule families that didn't fire this round.
  for (const key of Array.from(streaks.keys())) {
    if (!seen.has(key) && ruleOf(key, ruleSet)) streaks.delete(key);
  }
  for (const [key, alert] of Array.from(open.entries())) {
    if (seen.has(key) || !ruleSet.has(alert.rule) || eventTtl.has(key)) continue;
    const n = (clearStreaks.get(key) || 0) + 1;
    clearStreaks.set(key, n);
    if (n >= clearTicks) await resolve(alert, 'auto');
  }
}

async function fire(f, ttlMinutes = 30) {
  eventTtl.set(f.key, ttlMinutes);
  const existing = open.get(f.key);
  if (existing) return update(existing, f);
  return openNew(f);
}

/** Resolve event alerts that have gone quiet. Called every tick. */
async function sweepEvents() {
  const now = Date.now();
  for (const [key, alert] of Array.from(open.entries())) {
    const ttl = eventTtl.get(key) ?? EVENT_RULE_TTL[alert.rule];
    if (!ttl) continue;
    if (now - new Date(alert.last_seen_at).getTime() > ttl * 60000) {
      await resolve(alert, 'auto');
    }
  }
}

// Event TTLs for alerts restored from the DB after a restart (eventTtl is
// in-memory only).
const EVENT_RULE_TTL = { container_oom: 60, container_crashloop: 30 };

async function resolveById(id, by) {
  const alert = Array.from(open.values()).find((a) => a.id === Number(id));
  if (alert) return resolve(alert, by);
  return Monitor.resolveAlert(Number(id), by);
}

// ── internals ──

async function openNew(f) {
  const row = await Monitor.openAlert(f);
  open.set(f.key, row);
  logger.warn(`Monitor alert OPEN [${f.severity}] ${f.message}`);
  notify.enqueue({ type: 'opened', alert: row });
}

async function update(existing, f) {
  const escalated = SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity];
  // Avoid a DB write per alert per tick when nothing material changed; the
  // last_seen_at refresh still matters for event TTLs, so events always write.
  const changed = escalated || f.severity !== existing.severity || f.message !== existing.message || eventTtl.has(f.key);
  if (!changed) return;
  const row = await Monitor.touchAlert(existing.id, f);
  // The email flush may have marked the in-memory row notified after this
  // row was read; don't lose that.
  row.notified_severity = row.notified_severity || existing.notified_severity;
  open.set(f.key, row);
  if (escalated) {
    logger.warn(`Monitor alert ESCALATED [${f.severity}] ${f.message}`);
    notify.enqueue({ type: 'escalated', alert: row });
  }
}

async function resolve(alert, by) {
  const row = await Monitor.resolveAlert(alert.id, by);
  open.delete(alert.key);
  clearStreaks.delete(alert.key);
  streaks.delete(alert.key);
  eventTtl.delete(alert.key);
  if (row) {
    logger.info(`Monitor alert RESOLVED (${by}) ${alert.message}`);
    // Only tell you something cleared if you were told it opened.
    if (alert.notified_severity) notify.enqueue({ type: 'resolved', alert: row });
  }
  return row;
}

function ruleOf(key, ruleSet) {
  return ruleSet.has(String(key).split(':')[0]);
}

module.exports = { init, isOpen, openAlerts, evaluate, fire, sweepEvents, resolveById };
