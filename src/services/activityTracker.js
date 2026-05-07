const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Apps = require('../models/apps');
const logger = require('../logger');

/**
 * Activity tracker — feeds the on-demand idle sweeper.
 *
 * nginx-proxy is configured (via nginx/activity-log.conf, mounted into the
 * container) to write a structured access log to /var/log/nginx-activity/access.log.
 * The Beachhead container mounts the same volume read-only and we tail the
 * file with `tail -F`, parse out the Host header, and bump `last_active_at`
 * on the matching app row.
 *
 * Each log line is space-separated:
 *   <host> <iso8601-time> <method> <status> <upstream-time>
 *
 * We coalesce updates: hosts seen during a short flush window are written in
 * a single SQL update per flush, keyed by app id rather than domain. This
 * keeps DB writes cheap even if traffic is heavy.
 */

const ACCESS_LOG_PATH = process.env.ACTIVITY_LOG_PATH || '/var/log/nginx-activity/access.log';
const FLUSH_INTERVAL_MS = 5_000;
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;       // remember domain→appIds resolution for 5 min

// In-flight buffer of hosts seen since the last flush.
const pendingHosts = new Set();
// Cache of host → [appId,...] so we don't query Apps for every line.
// Entry shape: { ids: number[], expiresAt: number }
const hostToAppCache = new Map();

let tailProcess = null;
let flushTimer = null;
let stopped = false;

/**
 * Resolve a list of unique hostnames to a flat list of unique app ids.
 * Cached briefly to avoid hammering the DB on bursts of traffic.
 */
async function resolveHosts(hosts) {
  const now = Date.now();
  const uncached = [];
  const ids = new Set();

  for (const host of hosts) {
    const entry = hostToAppCache.get(host);
    if (entry && entry.expiresAt > now) {
      for (const id of entry.ids) ids.add(id);
    } else {
      uncached.push(host);
    }
  }

  if (uncached.length > 0) {
    // We need per-host resolution so cache entries are accurate. One query
    // per flush isn't a meaningful cost.
    for (const host of uncached) {
      try {
        const matched = await Apps.findIdsByAnyDomain([host]);
        hostToAppCache.set(host, { ids: matched, expiresAt: now + HOST_CACHE_TTL_MS });
        for (const id of matched) ids.add(id);
      } catch (err) {
        logger.warn(`activityTracker: lookup failed for host '${host}': ${err.message}`);
      }
    }
  }

  return Array.from(ids);
}

async function flush() {
  if (pendingHosts.size === 0) return;
  const hosts = Array.from(pendingHosts);
  pendingHosts.clear();

  try {
    const appIds = await resolveHosts(hosts);
    if (appIds.length === 0) return;
    await Apps.bumpLastActive(appIds);
  } catch (err) {
    logger.warn(`activityTracker.flush failed: ${err.message}`);
  }
}

function scheduleFlush() {
  if (flushTimer || stopped) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flush();
    if (!stopped && pendingHosts.size > 0) scheduleFlush();
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive just for this timer.
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * Parse one access-log line and queue the host for the next flush.
 *
 * Line format: `<host> <time> <method> <status> <upstream-time>`
 * We accept anything that has a non-empty first field; everything past the
 * host is ignored. nginx may log `-` for missing values (e.g. a 444 with no
 * upstream) — that's fine, only the first field matters.
 */
function consumeLine(line) {
  if (!line) return;
  const sp = line.indexOf(' ');
  const host = sp === -1 ? line : line.slice(0, sp);
  if (!host || host === '-' || host === '_') return;
  // Strip an optional trailing port (rare with nginx-proxy but harmless).
  const colon = host.indexOf(':');
  const cleaned = colon === -1 ? host : host.slice(0, colon);
  if (!cleaned) return;
  pendingHosts.add(cleaned.toLowerCase());
  scheduleFlush();
}

function startTail() {
  // tail -F handles log rotation and waits for the file to appear if it
  // hasn't been created yet (nginx-proxy creates it on first request).
  // -n 0 means "don't replay history on startup".
  tailProcess = spawn('tail', ['-F', '-n', '0', ACCESS_LOG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  tailProcess.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      try { consumeLine(line); } catch (err) {
        logger.warn(`activityTracker: parse error on line: ${err.message}`);
      }
    }
  });

  tailProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    // tail prints "no such file or directory" when the log doesn't exist
    // yet. -F retries every second so we can ignore the warning.
    if (text && !/No such file|cannot open/i.test(text)) {
      logger.warn(`activityTracker tail stderr: ${text}`);
    }
  });

  tailProcess.on('exit', (code, signal) => {
    tailProcess = null;
    if (stopped) return;
    logger.warn(`activityTracker tail exited (code=${code} signal=${signal}) — restarting in 5s`);
    setTimeout(() => { if (!stopped) startTail(); }, 5000);
  });

  tailProcess.on('error', (err) => {
    logger.error(`activityTracker tail spawn error: ${err.message}`);
  });
}

function start() {
  if (tailProcess) return;
  // If the file isn't there yet AND the directory doesn't exist either,
  // tail -F will still wait for it. But we log a hint on first start so a
  // misconfiguration is obvious in the logs.
  try {
    const dir = path.dirname(ACCESS_LOG_PATH);
    if (!fs.existsSync(dir)) {
      logger.warn(`activityTracker: ${dir} does not exist yet — make sure the nginx-activity volume is mounted`);
    }
  } catch { /* nbd */ }

  stopped = false;
  startTail();
  logger.info(`Activity tracker started (tailing ${ACCESS_LOG_PATH})`);
}

function stop() {
  stopped = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (tailProcess) {
    try { tailProcess.kill('SIGTERM'); } catch { /* ok */ }
    tailProcess = null;
  }
}

module.exports = { start, stop, _consumeLine: consumeLine, _flush: flush };
