const fs = require('fs');
const path = require('path');
const Deployments = require('../models/deployments');
const Apps = require('../models/apps');
const AppEndpoints = require('../models/appEndpoints');
const StaticSites = require('../models/staticSites');
const EnvVars = require('../models/envVars');
const { EnvFiles } = require('../models/envFiles');
const { generateOverride, writeOverrideFile, readBeachheadConfig, readNamedVolumes, readAllServiceNames, readServiceVolumes, generateStatefulOverride } = require('./composeWrapper');
const { exec, gitClone, dockerComposeUp, dockerComposeUpStateful, stopContainersUsingVolume, stopComposeProject, dockerComposeDown, dockerComposeLogs, ensureNetwork } = require('./docker');
const { checkHealth } = require('./healthCheck');
const config = require('../config');
const logger = require('../logger');

const STATES = Deployments.STATES;
const POLL_INTERVAL = 5000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — mark stuck deployments as FAILED

let running = false;

async function transition(deployment, state, logMsg) {
  logger.info(`[deploy #${deployment.id}] ${state}: ${logMsg || ''}`);
  return Deployments.updateState(deployment.id, state, `[${state}] ${logMsg || ''}`);
}

/**
 * Safely quote a value for a .env file.
 * Wraps in single quotes if it contains newlines, quotes, or shell-special chars.
 */
function envQuote(value) {
  if (/[\n\r"'\\$`!#]/.test(value)) {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
  return value;
}

async function processDeployment(deployment) {
  const app = await Apps.findById(deployment.app_id);
  if (!app) {
    await transition(deployment, STATES.FAILED, 'App not found');
    return;
  }

  const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${deployment.id}`);

  try {
    // ── CLONING ──
    await transition(deployment, STATES.CLONING, `Cloning ${app.repo_url} (${app.branch})`);

    // Clean up if directory already exists (e.g. retried after crash)
    if (fs.existsSync(deployDir)) {
      fs.rmSync(deployDir, { recursive: true, force: true });
    }
    fs.mkdirSync(deployDir, { recursive: true });
    await gitClone(app.repo_url, app.branch, deployDir);

    // Read beachhead.json if present (can override public_service, public_port)
    const bhConfig = readBeachheadConfig(deployDir);
    const publicService = bhConfig?.public_service || app.public_service;
    const publicPort = bhConfig?.public_port || app.public_port;
    const statefulServices = Array.isArray(bhConfig?.stateful_services) ? bhConfig.stateful_services : [];

    // Derive slug the same way generateOverride does (for consistent naming).
    const slug = (app.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
    // Fixed network name shared between the stateful project and each transient deploy.
    const statefulNetwork = statefulServices.length > 0 ? `${slug}-internal` : null;

    if (!publicService) {
      throw new Error('No public_service defined (set in app config or beachhead.json)');
    }

    // ── ENV_INJECTION ──
    await transition(deployment, STATES.ENV_INJECTION, 'Injecting environment variables');
    const envVars = await EnvVars.getByAppId(app.id);
    const namedVolumes = readNamedVolumes(deployDir);

    // Load additional endpoints for multi-service apps
    const endpoints = await AppEndpoints.findByAppId(app.id);
    const additionalEndpoints = endpoints.map(ep => ({
      service: ep.service,
      domain: ep.domain,
      port: ep.port || 80,
      wwwRedirect: ep.www_redirect || false,
    }));

    const overrideContent = generateOverride({
      appSlug: app.name,
      deployId: deployment.id,
      publicService,
      domain: app.domain,
      publicPort: publicPort || 80,
      envVars,
      namedVolumes,
      wwwRedirect: app.www_redirect || false,
      statefulNetwork,
      additionalEndpoints,
    });
    writeOverrideFile(deployDir, overrideContent);

    // Write a .env file for any unscoped env vars (many apps read from .env)
    const globalEnvVars = envVars.filter((v) => !v.target_service && !v.env_file_id);
    if (globalEnvVars.length > 0) {
      const envContent = globalEnvVars.map((v) => `${v.key}=${envQuote(v.value)}`).join('\n');
      const envPath = path.join(deployDir, '.env');
      fs.writeFileSync(envPath, envContent, 'utf8');
      fs.chmodSync(envPath, 0o600);
    }

    // Write any explicitly-defined env files to their specified paths
    const envFiles = await EnvFiles.getByAppId(app.id);
    for (const envFile of envFiles) {
      if (!envFile.vars || envFile.vars.length === 0) continue;
      const filePath = path.join(deployDir, envFile.path);
      const fileDir = path.dirname(filePath);
      fs.mkdirSync(fileDir, { recursive: true });
      const fileContent = envFile.vars.map((v) => `${v.key}=${envQuote(v.value)}`).join('\n') + '\n';
      fs.writeFileSync(filePath, fileContent, 'utf8');
      fs.chmodSync(filePath, 0o600);
    }

    // Set restrictive permissions on override file (contains env vars)
    fs.chmodSync(path.join(deployDir, 'beachhead.override.yml'), 0o600);

    // ── BUILDING ──
    await transition(deployment, STATES.BUILDING, 'Building containers');
    await ensureNetwork(config.deploy.dockerNetwork);

    // Pre-create any explicitly named volumes so Docker Compose treats them as external
    // (avoids "volume already exists but was created for project X" warnings/errors
    // when each deploy runs as a different Compose project).
    for (const vol of namedVolumes) {
      try {
        await exec('docker', ['volume', 'create', vol.name]);
        logger.info(`[deploy #${deployment.id}] Ensured volume: ${vol.name}`);
      } catch {
        // volume likely already exists — that's fine
      }
    }

    // ── STARTING_CONTAINERS ──
    await transition(deployment, STATES.STARTING_CONTAINERS, 'Starting containers');

    // Start stateful services (e.g. postgres) under a fixed project so they survive
    // blue/green swaps and are never recreated by per-deploy compose up calls.
    if (statefulServices.length > 0) {
      const statefulProject = `${slug}-stateful`;

      // Ensure the shared internal network exists before either project references it.
      await ensureNetwork(statefulNetwork);

      // Write a minimal overlay that pins the `internal` network to the fixed name.
      // Both the stateful project and the transient project apply this overlay so
      // every service (postgres, backend) is on the same Docker network.
      const statefulOverridePath = path.join(deployDir, 'beachhead.stateful.override.yml');
      fs.writeFileSync(statefulOverridePath, generateStatefulOverride(statefulNetwork), 'utf8');
      fs.chmodSync(statefulOverridePath, 0o600);

      // On the first deployment after stateful_services is added, the database may
      // still be running under the old per-deploy project and holding the data
      // directory. Stop those containers first (one-time brief restart) so the
      // stateful project can take ownership.
      const statefulVolumes = readServiceVolumes(deployDir, statefulServices);
      for (const vol of statefulVolumes) {
        await stopContainersUsingVolume(vol);
      }

      logger.info(`[deploy #${deployment.id}] Starting stateful services under project '${statefulProject}': ${statefulServices.join(', ')}`);
      await dockerComposeUpStateful(deployDir, statefulProject, statefulServices, 'beachhead.stateful.override.yml');
    }

    // Start only the transient (non-stateful) services under the deploy-specific project.
    // If all services are transient, pass an empty array (starts everything).
    const allServices = readAllServiceNames(deployDir);
    const transientServices = allServices.filter(s => !statefulServices.includes(s));
    await dockerComposeUp(deployDir, 'beachhead.override.yml', transientServices);

    // ── PROXY_SETUP ──
    await transition(deployment, STATES.PROXY_SETUP, `Proxy configured for ${app.domain} -> ${publicService}:${publicPort || 80}`);
    // The nginx-proxy container reads VIRTUAL_HOST/VIRTUAL_PORT env vars automatically.
    // No explicit proxy config needed — the override already injects those vars.

    // ── VERIFY_HEALTH ──
    const healthPath = bhConfig?.health_check || '/';
    await transition(deployment, STATES.VERIFY_HEALTH, `Checking health of ${app.domain}${healthPath}`);
    const healthy = await checkHealth(app.domain, { path: healthPath });
    if (!healthy) {
      throw new Error(`Health check failed for ${app.domain}`);
    }

    // ── SUCCESS ──
    await transition(deployment, STATES.SUCCESS, 'Deployment successful');

    // Record this as the active deployment before tearing down the old one.
    await Apps.update(app.id, { active_deployment_id: deployment.id });

    // Stop the previous deployment's containers now that the new one is healthy.
    if (app.stop_previous !== false) {
      // Prefer the explicitly tracked active deployment over a DB scan so
      // rollbacks are correctly accounted for.
      const prevDepId = app.active_deployment_id;
      const prevDeployment = prevDepId
        ? await Deployments.findById(prevDepId)
        : await Deployments.findLastSuccessful(app.id, deployment.id);
      if (prevDeployment && prevDeployment.id !== deployment.id) {
        const prevDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${prevDeployment.id}`);
        const prevOverride = path.join(prevDir, 'beachhead.override.yml');
        const prevProjectName = path.basename(prevDir); // e.g. "deploy-122"
        logger.info(`[deploy #${deployment.id}] Stopping previous deployment #${prevDeployment.id}`);
        try {
          if (fs.existsSync(prevOverride)) {
            await dockerComposeDown(prevDir, 'beachhead.override.yml');
          } else {
            logger.warn(`[deploy #${deployment.id}] Override file missing for #${prevDeployment.id} — using label-based stop`);
            await stopComposeProject(prevProjectName);
          }
        } catch (stopErr) {
          // compose down failed (e.g. partial state from a previous migration) — fall back
          // to stopping containers directly by their compose project label so stale
          // containers don't remain registered with nginx-proxy.
          logger.warn(`[deploy #${deployment.id}] Compose down failed: ${stopErr.message} — falling back to label-based stop`);
          await stopComposeProject(prevProjectName);
        }
      }
    }
    // Sweep for any other stray deploy containers beyond the one we just stopped.
    // Catches cases where earlier deploys weren't torn down (crashes, failed teardowns)
    // and would otherwise share the same VIRTUAL_HOST on beachhead-net.
    await stopOtherDeployContainers(app.id, deployment.id);

    logger.info(`[deploy #${deployment.id}] Deployment complete for ${app.name}`);
  } catch (err) {
    logger.error(`[deploy #${deployment.id}] Failed: ${err.message}`);

    // Capture container logs before teardown for debugging
    try {
      const logs = await dockerComposeLogs(deployDir, 'beachhead.override.yml');
      if (logs) {
        logger.error(`[deploy #${deployment.id}] Container logs before rollback:\n${logs}`);
      }
    } catch {
      // best-effort
    }

    // Rollback: always attempt compose down to clean up any partially-started containers.
    // Even if nothing started, compose down is a no-op.
    try {
      logger.info(`[deploy #${deployment.id}] Rolling back — stopping containers`);
      await dockerComposeDown(deployDir, 'beachhead.override.yml');
    } catch (rollbackErr) {
      logger.error(`[deploy #${deployment.id}] Rollback failed: ${rollbackErr.message}`);
    }

    await Deployments.updateState(deployment.id, STATES.FAILED, `[FAILED] ${err.message}`);
  }
}

/**
 * Stop all deploy-project containers for an app EXCEPT the given keepDeployId.
 * Catches strays from crashes, failed teardowns, or duplicate deploys that share
 * the same VIRTUAL_HOST and cause nginx-proxy to route to unhealthy containers.
 */
async function stopOtherDeployContainers(appId, keepDeployId) {
  try {
    const deploys = await Deployments.findByAppId(appId, 100);
    for (const dep of deploys) {
      if (dep.id === keepDeployId) continue;
      const count = await stopComposeProject(`deploy-${dep.id}`);
      if (count > 0) {
        logger.info(`[cleanup] Stopped ${count} stray container(s) for deploy-${dep.id} (app #${appId})`);
      }
    }
  } catch (err) {
    logger.warn(`[cleanup] stopOtherDeployContainers(app #${appId}) failed: ${err.message}`);
  }
}

async function recoverStaleDeployments() {
  try {
    const recovered = await Deployments.failStale(STALE_THRESHOLD_MS);
    if (recovered > 0) {
      logger.warn(`Recovered ${recovered} stale deployment(s) stuck in intermediate state`);
    }
  } catch (err) {
    logger.error('Failed to recover stale deployments', err);
  }
}

async function poll() {
  if (!running) return;

  try {
    // Periodically recover stuck deployments
    await recoverStaleDeployments();

    const job = await Deployments.getNextPending();
    if (job) {
      // Check if this app already has an active (non-terminal) deployment
      const hasActive = await Deployments.hasActiveForApp(job.app_id, job.id);
      if (hasActive) {
        // Put it back to PENDING so it's retried later
        await Deployments.updateState(job.id, STATES.PENDING, '[PENDING] Waiting — another deployment for this app is in progress');
        logger.info(`[deploy #${job.id}] Deferred — active deployment already running for app ${job.app_id}`);
      } else {
        await processDeployment(job);
      }
    }
  } catch (err) {
    logger.error('Worker poll error', err);
  }

  if (running) {
    setTimeout(poll, POLL_INTERVAL);
  }
}

/**
 * On startup: for each app, ensure the active deployment's containers are running.
 * Does NOT tear down stale deployments — that's handled by the prune system on
 * demand so startup stays fast.
 */
async function startupCleanup() {
  try {
    const apps = await Apps.findAll();
    for (const app of apps) {
      // Prefer the explicitly tracked active deployment; fall back to last successful
      const current = app.active_deployment_id
        ? await Deployments.findById(app.active_deployment_id)
        : await Deployments.findLastSuccessful(app.id, -1);

      if (!current) continue;

      const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${current.id}`);
      const overridePath = path.join(deployDir, 'beachhead.override.yml');
      if (!fs.existsSync(overridePath)) continue;

      try {
        logger.info(`[startup] Ensuring deployment #${current.id} is running for ${app.name}`);
        await ensureNetwork(config.deploy.dockerNetwork);

        // Also ensure stateful services are running
        const bhConfig = readBeachheadConfig(deployDir);
        const statefulServices = Array.isArray(bhConfig?.stateful_services) ? bhConfig.stateful_services : [];
        if (statefulServices.length > 0) {
          const slug = (app.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
          const statefulNetwork = `${slug}-internal`;
          await ensureNetwork(statefulNetwork);
          const statefulOverridePath = path.join(deployDir, 'beachhead.stateful.override.yml');
          if (fs.existsSync(statefulOverridePath)) {
            await dockerComposeUpStateful(deployDir, `${slug}-stateful`, statefulServices, 'beachhead.stateful.override.yml');
          }
        }

        await dockerComposeUp(deployDir, 'beachhead.override.yml');

        // Stop stray containers from other deploy projects for this app.
        // Guards against crashes mid-deploy that leave old containers registered
        // with nginx-proxy under the same VIRTUAL_HOST.
        await stopOtherDeployContainers(app.id, current.id);
      } catch (err) {
        logger.warn(`[startup] Could not start deployment #${current.id} for ${app.name}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('Startup cleanup failed', err);
  }
}

/**
 * On startup: ensure all static site containers are running.
 * Containers are created with --restart unless-stopped, so they usually survive
 * reboots. This handles cases where containers were removed or Docker lost state.
 */
async function startupStaticSites() {
  try {
    const sites = await StaticSites.findAll();
    for (const site of sites) {
      const name = `static-site-${site.id}`;
      const root = path.join(config.deploy.baseDir, 'static-sites', `site-${site.id}`, 'public');

      // Skip if no files have been uploaded yet
      if (!fs.existsSync(root)) continue;

      // Check if container is already running
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', name], { timeout: 10000 });
        if (stdout.trim() === 'true') continue;
      } catch { /* container doesn't exist or inspect failed */ }

      // Container not running — start it
      try {
        logger.info(`[startup] Starting static site container: ${name} for ${site.domain}`);
        const hosts = site.www_redirect ? `${site.domain},www.${site.domain}` : site.domain;
        // Remove existing container if present but stopped
        try { await exec('docker', ['rm', '-f', name], { timeout: 10000 }); } catch { /* ok */ }
        await exec('docker', ['run', '-d',
          '--name', name,
          '--restart', 'unless-stopped',
          '--network', config.deploy.dockerNetwork,
          '-e', `VIRTUAL_HOST=${hosts}`,
          '-e', 'VIRTUAL_PORT=80',
          '-e', `LETSENCRYPT_HOST=${hosts}`,
          '-v', `${root}:/usr/share/nginx/html:ro`,
          'nginx:alpine',
        ], { timeout: 30000 });
      } catch (err) {
        logger.warn(`[startup] Could not start static site ${name}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('Static sites startup recovery failed', err);
  }
}

function start() {
  if (running) return;
  running = true;
  logger.info('Deployment worker started');
  Promise.all([startupCleanup(), startupStaticSites()]).finally(() => poll());
}

function stop() {
  running = false;
  logger.info('Deployment worker stopped');
}

module.exports = { start, stop };
