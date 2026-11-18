const os = require('os');
const config = require('../../config');
const Settings = require('../../models/settings');
const Apps = require('../../models/apps');
const collector = require('./collector');
const events = require('./events');
const alerts = require('./alerts');
const { version } = require('../../../package.json');

/**
 * System monitor entry point.
 *
 * buildHealth() is the contract Cabana will poll across every instance, so
 * keep it stable and cheap: it reads only in-memory state plus one small
 * query, never Docker directly. Add fields; don't rename them.
 */

async function start() {
  await collector.start();
  events.start();
}

function stop() {
  collector.stop();
  events.stop();
}

async function instanceIdentity() {
  return {
    id: (await Settings.get('instance_id')) || null,
    name: (await Settings.get('instance_name')) || config.domain || os.hostname(),
    domain: config.domain || null,
    beachheadVersion: version,
  };
}

async function buildHealth() {
  const s = collector.getSnapshot();
  const open = alerts.openAlerts();
  const critical = open.filter((a) => a.severity === 'critical').length;
  const warning = open.filter((a) => a.severity === 'warning').length;

  // Stale data is its own status: a collector that stopped ticking must not
  // keep reporting the last good numbers as "ok".
  const ageMs = s.lastTickAt ? Date.now() - new Date(s.lastTickAt).getTime() : Infinity;
  let status = critical ? 'critical' : warning ? 'degraded' : 'ok';
  if (ageMs > 3 * 60_000) status = 'unknown';

  const apps = await Apps.findAll();
  const downAppIds = new Set(open.filter((a) => a.rule === 'service_down' || a.rule === 'http_down').map((a) => a.details?.appId ?? a.key.split(':')[1]).map(String));

  return {
    instance: {
      ...(await instanceIdentity()),
      docker: s.dockerInfo ? { version: s.dockerInfo.serverVersion, os: s.dockerInfo.operatingSystem, ncpu: s.dockerInfo.ncpu } : null,
    },
    status,
    checkedAt: s.lastTickAt,
    host: s.host ? {
      memUsedPct: s.host.usedPct,
      memTotalBytes: s.host.totalBytes,
      swapUsedPct: s.host.swapUsedPct,
      cpuPct: s.host.cpuPct,
      loadPerCore: s.host.loadPerCore,
      ncpu: s.host.ncpu,
    } : null,
    disks: s.disks.map((d) => ({ label: d.label, usedPct: d.usedPct, freeBytes: d.freeBytes, totalBytes: d.totalBytes, daysLeft: d.daysLeft })),
    containers: {
      total: s.containers.length,
      running: s.containers.filter((c) => c.state === 'running').length,
      unhealthy: s.containers.filter((c) => c.health === 'unhealthy').length,
    },
    apps: {
      total: apps.length,
      paused: apps.filter((a) => a.paused || a.auto_paused).length,
      down: apps.filter((a) => downAppIds.has(String(a.id))).length,
    },
    alerts: {
      critical,
      warning,
      open: open.map((a) => ({ id: a.id, rule: a.rule, severity: a.severity, subject: a.subject, message: a.message, openedAt: a.opened_at })),
    },
    collector: {
      startedAt: s.startedAt,
      tickMs: s.tickMs,
      errors: s.errors,
      events: events.status(),
      heartbeat: s.heartbeat,
    },
  };
}

module.exports = { start, stop, buildHealth, instanceIdentity, collector, alerts };
