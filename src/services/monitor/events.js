const dockerApi = require('./dockerApi');
const alerts = require('./alerts');
const { getRules } = require('./rules');
const { isUnexpectedExit } = require('./parse');
const logger = require('../../logger');

/**
 * Docker event listener — the two signals a 1-minute poll would miss.
 *
 *   oom  — the kernel killed a process in the container for exceeding its
 *          memory. The container may be back up before the next poll, so
 *          polling alone would never see it.
 *   die  — counted per container; 3+ unexpected exits in 10 minutes is a
 *          crash loop. A single crash that restarts cleanly isn't alerted;
 *          a container that stays down is caught by the collector's
 *          service_down check instead.
 *
 * Unhealthy healthchecks are a *state*, not an event, so they're read from
 * the container list each tick (survives a Beachhead restart, no missed
 * transitions).
 */

const CRASH_WINDOW_MS = 10 * 60 * 1000;
const CRASH_THRESHOLD = 3;

const crashes = new Map(); // container name → [timestamps]
let handle = null;
let stopped = true;
let lastEventAt = null;

function start() {
  stopped = false;
  connect();
}

function stop() {
  stopped = true;
  if (handle) handle.close();
  handle = null;
}

function connect() {
  if (stopped) return;
  handle = dockerApi.events(
    { type: ['container'], event: ['die', 'oom'] },
    (msg) => onEvent(msg).catch((e) => logger.warn(`Monitor event handling failed: ${e.message}`)),
    (err) => {
      handle = null;
      if (stopped) return;
      logger.warn(`Monitor: docker events stream closed${err ? ` (${err.message})` : ''} — reconnecting in 5s`);
      setTimeout(connect, 5000).unref?.();
    },
  );
}

async function onEvent(msg) {
  lastEventAt = Date.now();
  const action = msg.Action || msg.status || '';
  const attrs = msg.Actor?.Attributes || {};
  const name = attrs.name || (msg.Actor?.ID || msg.id || '').slice(0, 12);
  const rules = await getRules();

  if (action === 'oom') {
    if (!rules.container_oom.enabled) return;
    await alerts.fire({
      key: `container_oom:${name}`,
      rule: 'container_oom',
      severity: 'critical',
      subject: name,
      message: `${name} was killed for running out of memory`,
      details: { container: name, image: attrs.image, project: attrs['com.docker.compose.project'] },
    }, 60);
    return;
  }

  if (action === 'die' && isUnexpectedExit(attrs.exitCode)) {
    const now = Date.now();
    const list = (crashes.get(name) || []).filter((t) => now - t < CRASH_WINDOW_MS);
    list.push(now);
    crashes.set(name, list);
    if (list.length >= CRASH_THRESHOLD && rules.container_crashloop.enabled) {
      await alerts.fire({
        key: `container_crashloop:${name}`,
        rule: 'container_crashloop',
        severity: 'critical',
        subject: name,
        message: `${name} is crash-looping (${list.length} exits in 10 min, last exit code ${attrs.exitCode})`,
        details: { container: name, exitCode: Number(attrs.exitCode), crashes: list.length, project: attrs['com.docker.compose.project'] },
      }, 30);
    }
  }

  // Keep the map from growing with names of long-gone deploys.
  if (crashes.size > 500) {
    const now = Date.now();
    for (const [k, v] of crashes) if (!v.some((t) => now - t < CRASH_WINDOW_MS)) crashes.delete(k);
  }
}

function status() {
  return { connected: Boolean(handle), lastEventAt };
}

module.exports = { start, stop, status, _onEvent: onEvent };
