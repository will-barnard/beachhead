const Settings = require('../../models/settings');

/**
 * Alert thresholds.
 *
 * Defaults live here; the dashboard saves overrides as JSON in the
 * `monitor_thresholds` setting, merged per rule so a new default added in a
 * later release still applies to an instance that has customised others.
 *
 *   direction 'above' — fires when value >= warn / crit (memory, disk)
 *   direction 'below' — fires when value <= warn / crit (days of disk left)
 *   forTicks          — consecutive collector ticks (≈ minutes) the condition
 *                       must hold before opening. Stops one spike from emailing.
 *   clearMargin       — once open, the value must drop this far past the warn
 *                       line to resolve. Stops a value sitting on the line from
 *                       flapping open/closed every minute.
 *
 * Rules with warn/crit = null are event or state rules (OOM, crash loop,
 * service down) — they have a fixed severity and only `enabled` is tunable.
 */
const DEFAULT_RULES = {
  host_memory:        { label: 'Host memory used',            unit: '%',     direction: 'above', warn: 85, crit: 95, forTicks: 3, clearMargin: 3 },
  host_swap:          { label: 'Swap used',                   unit: '%',     direction: 'above', warn: 50, crit: 80, forTicks: 5, clearMargin: 5 },
  host_load:          { label: 'Load per core (5 min avg)',   unit: '×',     direction: 'above', warn: 1.5, crit: 3, forTicks: 5, clearMargin: 0.2 },
  disk_used:          { label: 'Disk used',                   unit: '%',     direction: 'above', warn: 80, crit: 90, forTicks: 2, clearMargin: 2 },
  disk_days_left:     { label: 'Disk full projected in',      unit: 'days',  direction: 'below', warn: 7, crit: 2, forTicks: 1, clearMargin: 1 },
  container_mem_limit:{ label: 'Container memory (of its limit)', unit: '%', direction: 'above', warn: 90, crit: 98, forTicks: 3, clearMargin: 3 },
  container_mem_host: { label: 'Unlimited container memory (of host)', unit: '%', direction: 'above', warn: 40, crit: 60, forTicks: 3, clearMargin: 3 },
  container_cpu:      { label: 'Container CPU (of all cores)', unit: '%',    direction: 'above', warn: 80, crit: null, forTicks: 10, clearMargin: 5 },
  container_mem_leak: { label: 'Container memory will hit its ceiling in', unit: 'hours', direction: 'below', warn: 24, crit: 6, forTicks: 1, clearMargin: 2 },
  cert_expiry:        { label: 'Certificate expires in',      unit: 'days',  direction: 'below', warn: 14, crit: 5, forTicks: 1, clearMargin: 0 },
  deploy_stuck:       { label: 'Deployment not finished after', unit: 'min', direction: 'above', warn: 20, crit: null, forTicks: 1, clearMargin: 0 },

  container_oom:      { label: 'Container killed for running out of memory', severity: 'critical' },
  container_crashloop:{ label: 'Container restart loop (3+ crashes in 10 min)', severity: 'critical' },
  container_unhealthy:{ label: 'Container healthcheck failing', severity: 'warning' },
  service_down:       { label: 'App service not running', severity: 'critical', forTicks: 2 },
  infra_down:         { label: 'Beachhead core container not running', severity: 'critical', forTicks: 1 },
  http_down:          { label: 'App not responding over HTTPS', severity: 'critical', forTicks: 2 },
  deploy_failed:      { label: 'Latest deployment failed', severity: 'warning' },
};

const TUNABLE = ['warn', 'crit', 'forTicks', 'enabled'];

async function getRules() {
  let overrides = {};
  try {
    overrides = JSON.parse((await Settings.get('monitor_thresholds')) || '{}');
  } catch { overrides = {}; }
  const merged = {};
  for (const [id, def] of Object.entries(DEFAULT_RULES)) {
    merged[id] = { id, enabled: true, ...def, ...pick(overrides[id] || {}, TUNABLE) };
  }
  return merged;
}

/**
 * Validate and store overrides. Only known rules and tunable fields are kept;
 * anything equal to the default is dropped so defaults can move later.
 */
async function saveOverrides(input) {
  const clean = {};
  for (const [id, values] of Object.entries(input || {})) {
    const def = DEFAULT_RULES[id];
    if (!def) continue;
    const out = {};
    for (const field of TUNABLE) {
      if (!(field in (values || {}))) continue;
      const v = values[field];
      if (field === 'enabled') {
        if (v === false) out.enabled = false;
        continue;
      }
      if (v === null || v === '') { if (def[field] !== null && def[field] !== undefined) out[field] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error(`${id}.${field} must be a non-negative number`);
        err.status = 400;
        throw err;
      }
      if (n !== def[field]) out[field] = n;
    }
    if (Object.keys(out).length) clean[id] = out;
  }
  await Settings.set('monitor_thresholds', JSON.stringify(clean));
  return getRules();
}

/**
 * Severity for a value against a threshold rule, or null if it's fine.
 * `isOpen` applies the clear margin so an open alert needs real recovery.
 */
function severityFor(rule, value, isOpen = false) {
  if (!rule || !rule.enabled || value == null || Number.isNaN(value)) return null;
  const m = isOpen ? (rule.clearMargin || 0) : 0;
  if (rule.direction === 'below') {
    if (rule.crit != null && value <= rule.crit) return 'critical';
    if (rule.warn != null && value <= rule.warn + m) return 'warning';
    return null;
  }
  if (rule.crit != null && value >= rule.crit) return 'critical';
  if (rule.warn != null && value >= rule.warn - m) return 'warning';
  return null;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

module.exports = { DEFAULT_RULES, getRules, saveOverrides, severityFor };
