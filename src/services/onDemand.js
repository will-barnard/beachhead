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
 * Confirm a container actually reached the "running" state — useful right
 * after `docker run` so we don't proceed thinking a placeholder is up when
 * its nginx config crashed and the container exited.
 */
async function isContainerRunning(name) {
  try {
    const { stdout } = await exec('docker', [
      'inspect', '-f', '{{.State.Running}}', name,
    ], { timeout: 5000, silent: true });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Wait up to `timeoutMs` for `name` to be in the running state. Returns
 * true on success, false on timeout. Polls cheaply.
 */
async function waitUntilRunning(name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isContainerRunning(name)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/**
 * Auto-pause an app. Idempotent — calling on an already auto-paused app is a
 * no-op. Returns true if any work was done.
 *
 * Order is deliberate to avoid a 503 window:
 *   1. Start placeholders FIRST and verify each one stayed up.
 *   2. Give nginx-proxy a few seconds to register them via docker-gen.
 *   3. Mark the app auto_paused so the wake endpoint will trigger.
 *   4. Stop the live containers.
 *
 * If any placeholder fails to start, we tear down whatever we've started
 * and bail out without touching the live containers — the app keeps
 * running and we'll try again on the next idle sweep.
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

  // ── 1. Start placeholders FIRST and verify each one is actually up. ──
  const publicServices = await publicServiceDomains({ app, bhConfig });
  const alwaysOn = new Set(app.always_on_services || []);
  const placeholdersToCreate = publicServices.filter(({ service }) => !alwaysOn.has(service));

  if (placeholdersToCreate.length === 0) {
    // Edge case: every public service is always-on. There's nothing to
    // placeholder; just record auto_paused for accounting and stop the
    // non-public stoppables below.
    logger.info(`onDemand.autoPause: app ${app.name} has no pause-able public services (all always-on)`);
  } else {
    const startedNames = [];
    for (const { service, domain } of placeholdersToCreate) {
      try {
        const name = await startAutoPausePlaceholder({ app, service, domain });
        const alive = await waitUntilRunning(name, 5000);
        if (!alive) {
          // Capture the container's logs so the operator can see WHY it
          // exited (almost always an nginx config error).
          let logsExcerpt = '';
          try {
            const { stdout, stderr } = await exec('docker', ['logs', '--tail', '40', name], { timeout: 5000, silent: true });
            logsExcerpt = ((stdout || '') + (stderr || '')).trim().slice(-1000);
          } catch { /* best-effort */ }
          throw new Error(`placeholder ${name} exited immediately. Last log lines:\n${logsExcerpt || '(none captured)'}`);
        }
        startedNames.push(name);
      } catch (err) {
        logger.error(`onDemand.autoPause: aborting — placeholder for ${service}/${domain} failed: ${err.message}`);
        // Roll back any placeholders we already started so we don't end up
        // double-routing the user's domain to a half-working placeholder.
        await stopAutoPausePlaceholders(app.id);
        return false;
      }
    }
    logger.info(`onDemand.autoPause: ${startedNames.length} placeholder(s) up for ${app.name}: ${startedNames.join(', ')}`);

    // ── 2. Give nginx-proxy a moment to notice the new container(s). ──
    //   docker-gen debounces config reloads (default ~2s). If we stop the
    //   live upstream before nginx-proxy has the placeholder registered,
    //   visitors get a 503 in the gap.
    await new Promise(r => setTimeout(r, 3000));
  }

  // ── 3. Now it's safe to flip the auto_paused flag. ──
  await Apps.update(app.id, { auto_paused: true });

  // ── 4. Stop transient services that aren't always-on. ──
  if (plan.stoppableTransient.length > 0) {
    try {
      const ids = plan.stoppableTransient.map(svc => `${slug}-${svc}-d${dep.id}`);
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

  // ── 5. Stop stateful project if no stateful service is always-on. ──
  if (plan.statefulServices.length > 0 && plan.alwaysOnStateful.length === 0) {
    try {
      await stopComposeProject(`${slug}-stateful`);
      logger.info(`onDemand.autoPause: stopped stateful project for ${app.name}`);
    } catch (err) {
      logger.warn(`onDemand.autoPause: failed to stop stateful project for ${app.name}: ${err.message}`);
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

// Per-app mutex for the pause/wake state machine. Both autoPause and
// autoWake acquire it so a wake request that arrives mid-pause can't
// interleave with the pause sequence (and vice versa). Each entry is the
// promise of the currently-running transition; subsequent callers wait for
// it before starting their own.
const transitionLocks = new Map();
async function withTransitionLock(appId, fn) {
  const prev = transitionLocks.get(appId);
  let release;
  const ours = new Promise(r => { release = r; });
  // Chain after any in-flight transition so we run after it settles.
  const chain = (prev || Promise.resolve()).then(() => fn()).finally(() => {
    // Clear the slot only if no newer waiter took our place.
    if (transitionLocks.get(appId) === ours) transitionLocks.delete(appId);
    release();
  });
  transitionLocks.set(appId, ours);
  return chain;
}

// Public-facing wrappers — same names as before, now mutex-guarded.
function autoPauseLocked(app) {
  return withTransitionLock(app.id, () => autoPause(app));
}
function autoWakeLocked(app) {
  return withTransitionLock(app.id, () => autoWake(app));
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
        // Mutex-guarded so a wake request that arrives concurrently waits
        // until our pause settles (or vice versa).
        await autoPauseLocked(app);
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
  autoPause: autoPauseLocked,
  autoWake: autoWakeLocked,
  idleSweep,
  listAppServices,
};
