const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Apps = require('../models/apps');
const Deployments = require('../models/deployments');
const AppEndpoints = require('../models/appEndpoints');
const { exec, dockerComposeUpNoBuild, dockerComposeUpStateful, stopComposeProject } = require('./docker');
const { readBeachheadConfig, readAllServiceNames } = require('./composeWrapper');
const { startAutoPausePlaceholder, stopAutoPausePlaceholders } = require('./pause');
const { checkHealth } = require('./healthCheck');
const config = require('../config');
const logger = require('../logger');

/**
 * On-demand (scale-to-zero) orchestration.
 *
 * Three operations:
 *   - autoPause(app)  — stop transient + (optionally) stateful services that
 *                       aren't in always_on_services, swap in placeholders.
 *   - autoWake(app)   — start everything back up, remove placeholders.
 *   - idleSweep()     — periodic scan; auto-pauses every candidate app whose
 *                       last_active_at is older than its idle_timeout.
 *
 * Manual pause (services/pause.js + the /pause route) is kept distinct: an
 * app that's manually paused is skipped by the idle sweep, and waking from
 * an auto-pause does NOT clear a manual pause.
 */

/**
 * Plan which services should keep running and which should stop, given the
 * app's `always_on_services` list and the deployment's compose file.
 */
function planPause({ deployDir, app, bhConfig }) {
  const allServices = readAllServiceNames(deployDir);
  const statefulServices = Array.isArray(bhConfig?.stateful_services) ? bhConfig.stateful_services : [];
  const alwaysOn = new Set(app.always_on_services || []);

  // If the user listed a stateful service as always-on, it stays. Otherwise
  // it pauses too — that's the whole point of scale-to-zero.
  const alwaysOnTransient = allServices.filter(s => alwaysOn.has(s) && !statefulServices.includes(s));
  const stoppableTransient = allServices.filter(s => !alwaysOn.has(s) && !statefulServices.includes(s));
  const alwaysOnStateful = statefulServices.filter(s => alwaysOn.has(s));
  const stoppableStateful = statefulServices.filter(s => !alwaysOn.has(s));

  return { allServices, statefulServices, alwaysOnTransient, stoppableTransient, alwaysOnStateful, stoppableStateful };
}

/**
 * Map each public-facing service (primary + endpoints) → its public domain.
 * Used to figure out which placeholders to start when auto-pausing.
 */
async function publicServiceDomains({ app, bhConfig }) {
  const out = [];
  const primary = bhConfig?.public_service || app.public_service;
  if (primary) out.push({ service: primary, domain: app.domain });
  const endpoints = await AppEndpoints.findByAppId(app.id);
  for (const ep of endpoints) {
    out.push({ service: ep.service, domain: ep.domain });
  }
  return out;
}

function slugify(name) {
  return (name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
}

/**
 * Auto-pause an app. Idempotent — calling on an already auto-paused app is a
 * no-op. Returns true if any work was done.
 */
async function autoPause(app) {
  if (!app.on_demand) return false;
  if (app.paused) return false;          // manual pause — don't touch
  if (app.auto_paused) return false;     // already paused
  if (app.system_app) return false;

  const dep = app.active_deployment_id ? await Deployments.findById(app.active_deployment_id) : null;
  if (!dep) {
    logger.warn(`onDemand.autoPause: app ${app.name} has no active deployment — skipping`);
    return false;
  }

  const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${dep.id}`);
  if (!fs.existsSync(path.join(deployDir, 'docker-compose.yml'))) {
    logger.warn(`onDemand.autoPause: deploy dir missing for app ${app.name} — skipping`);
    return false;
  }

  const bhConfig = readBeachheadConfig(deployDir);
  const plan = planPause({ deployDir, app, bhConfig });
  const slug = slugify(app.name);

  // Mark first so the activity tracker doesn't immediately resurrect us
  // mid-flight. last_active_at is left as-is so we can debug "how long was
  // it asleep?".
  await Apps.update(app.id, { auto_paused: true });

  // 1) Stop transient services that aren't always-on.
  if (plan.stoppableTransient.length > 0) {
    try {
      // We stop via container_name (deterministic from override) rather than
      // `compose stop <svc>` so we don't need the override file's exact path
      // mounted; this also cleanly leaves always-on containers running.
      const ids = [];
      for (const svc of plan.stoppableTransient) {
        ids.push(`${slug}-${svc}-d${dep.id}`);
      }
      // Filter to ones that actually exist & are running.
      const { stdout } = await exec('docker', ['ps', '--format', '{{.Names}}', '--filter', `label=com.docker.compose.project=deploy-${dep.id}`], { timeout: 10000, silent: true });
      const running = new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean));
      const toStop = ids.filter(id => running.has(id));
      if (toStop.length > 0) {
        await exec('docker', ['stop', ...toStop], { timeout: 60000, silent: true });
        logger.info(`onDemand.autoPause: stopped ${toStop.length} transient container(s) for ${app.name}: ${toStop.join(', ')}`);
      }
    } catch (err) {
      logger.warn(`onDemand.autoPause: failed to stop transient services for ${app.name}: ${err.message}`);
    }
  }

  // 2) Stop stateful project entirely if no stateful service is always-on.
  //    (Mixing partial stops on the stateful project is messy; keeping it
  //    all-or-nothing keeps semantics simple.)
  if (plan.statefulServices.length > 0 && plan.alwaysOnStateful.length === 0) {
    try {
      await stopComposeProject(`${slug}-stateful`);
      logger.info(`onDemand.autoPause: stopped stateful project for ${app.name}`);
    } catch (err) {
      logger.warn(`onDemand.autoPause: failed to stop stateful project for ${app.name}: ${err.message}`);
    }
  }

  // 3) Start a wake placeholder for every public-facing service we just stopped.
  //    Always-on public services keep serving normally — no placeholder.
  const publicServices = await publicServiceDomains({ app, bhConfig });
  const alwaysOn = new Set(app.always_on_services || []);
  for (const { service, domain } of publicServices) {
    if (alwaysOn.has(service)) continue;
    try {
      await startAutoPausePlaceholder({ app, service, domain });
    } catch (err) {
      logger.warn(`onDemand.autoPause: placeholder for ${service}/${domain} failed: ${err.message}`);
    }
  }

  logger.info(`App ${app.name} auto-paused (idle for ≥ ${app.idle_timeout_seconds}s)`);
  return true;
}

/**
 * Wake an app that was auto-paused. Bring services back up, wait for health,
 * remove placeholders, clear the auto_paused flag. Idempotent.
 */
async function autoWake(app) {
  // Refetch in case another wake call is in flight.
  const fresh = await Apps.findById(app.id);
  if (!fresh) throw new Error('App not found');
  if (!fresh.auto_paused) return { alreadyAwake: true };
  if (fresh.paused) throw new Error('App is manually paused — unpause it from the dashboard');

  const dep = fresh.active_deployment_id ? await Deployments.findById(fresh.active_deployment_id) : null;
  if (!dep) throw new Error('No active deployment to wake');

  const deployDir = path.join(config.deploy.baseDir, `app-${fresh.id}`, `deploy-${dep.id}`);
  if (!fs.existsSync(path.join(deployDir, 'beachhead.override.yml'))) {
    throw new Error('Deploy override missing on disk');
  }

  const bhConfig = readBeachheadConfig(deployDir);
  const slug = slugify(fresh.name);
  const statefulServices = Array.isArray(bhConfig?.stateful_services) ? bhConfig.stateful_services : [];

  // Bring stateful project back up first if needed.
  if (statefulServices.length > 0) {
    try {
      const statefulOverride = path.join(deployDir, 'beachhead.stateful.override.yml');
      if (fs.existsSync(statefulOverride)) {
        await dockerComposeUpStateful(deployDir, `${slug}-stateful`, statefulServices, 'beachhead.stateful.override.yml');
      }
    } catch (err) {
      throw new Error(`Stateful start failed: ${err.message}`);
    }
  }

  // Bring transient services back up. compose up --no-build is idempotent —
  // running services are left alone, stopped ones are recreated/started.
  const allServices = readAllServiceNames(deployDir);
  const transient = allServices.filter(s => !statefulServices.includes(s));
  try {
    await dockerComposeUpNoBuild(deployDir, 'beachhead.override.yml', transient);
  } catch (err) {
    throw new Error(`Transient start failed: ${err.message}`);
  }

  // Wait for health on the primary domain. Other endpoints are best-effort.
  const healthPath = bhConfig?.health_check || '/';
  const healthy = await checkHealth(fresh.domain, { path: healthPath });
  if (!healthy) {
    // Don't roll back — the user is staring at a wake page. Bumping
    // last_active_at lets the idle sweep retry rather than immediately
    // re-pausing.
    await Apps.update(fresh.id, { last_active_at: new Date() });
    throw new Error(`Health check failed for ${fresh.domain} after wake`);
  }

  // App is healthy — tear down placeholders and clear flag.
  await stopAutoPausePlaceholders(fresh.id);
  await Apps.update(fresh.id, { auto_paused: false, last_active_at: new Date() });

  logger.info(`App ${fresh.name} woken from auto-pause`);
  return { woken: true };
}

// Single-flight guard so concurrent wake requests don't double-up.
const wakeInFlight = new Map();
function wakeOnce(app) {
  if (wakeInFlight.has(app.id)) return wakeInFlight.get(app.id);
  const p = autoWake(app).finally(() => wakeInFlight.delete(app.id));
  wakeInFlight.set(app.id, p);
  return p;
}

/**
 * Periodic idle sweep — auto-pauses every on-demand app that's been idle
 * past its threshold. Called from the worker poll loop.
 */
async function idleSweep() {
  let candidates;
  try {
    candidates = await Apps.findIdleSweepCandidates();
  } catch (err) {
    logger.warn(`onDemand.idleSweep: failed to load candidates: ${err.message}`);
    return;
  }

  const now = Date.now();
  for (const app of candidates) {
    const lastActive = app.last_active_at ? new Date(app.last_active_at).getTime() : null;
    const idleSecs = app.idle_timeout_seconds || 1800;
    // If we've never seen activity, treat the active_deployment's creation
    // as the baseline so a freshly-deployed on-demand app doesn't get paused
    // before anyone has hit it. But if it's been idle for >2× the timeout
    // since deploy and still no activity, pause it anyway.
    let referenceMs = lastActive;
    if (!referenceMs && app.active_deployment_id) {
      try {
        const dep = await Deployments.findById(app.active_deployment_id);
        if (dep?.created_at) referenceMs = new Date(dep.created_at).getTime();
      } catch { /* fall through */ }
    }
    if (!referenceMs) continue;

    const idleMs = now - referenceMs;
    if (idleMs >= idleSecs * 1000) {
      try {
        await autoPause(app);
      } catch (err) {
        logger.warn(`onDemand.idleSweep: autoPause(${app.name}) failed: ${err.message}`);
      }
    }
  }
}

/**
 * Read the public-service list from the active deployment's docker-compose,
 * for showing the operator a checklist when configuring always_on_services.
 * Falls back to the compose file's `services` keys.
 */
function listAppServices(app) {
  if (!app.active_deployment_id) return [];
  const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${app.active_deployment_id}`);
  try {
    return readAllServiceNames(deployDir);
  } catch {
    return [];
  }
}

module.exports = {
  autoPause,
  autoWake: wakeOnce,
  idleSweep,
  listAppServices,
};
