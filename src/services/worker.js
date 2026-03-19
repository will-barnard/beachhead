const fs = require('fs');
const path = require('path');
const Deployments = require('../models/deployments');
const Apps = require('../models/apps');
const EnvVars = require('../models/envVars');
const { EnvFiles } = require('../models/envFiles');
const { generateOverride, writeOverrideFile, readBeachheadConfig, readNamedVolumes } = require('./composeWrapper');
const { exec, gitClone, dockerComposeUp, dockerComposeDown, dockerComposeLogs, ensureNetwork } = require('./docker');
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

    if (!publicService) {
      throw new Error('No public_service defined (set in app config or beachhead.json)');
    }

    // ── ENV_INJECTION ──
    await transition(deployment, STATES.ENV_INJECTION, 'Injecting environment variables');
    const envVars = await EnvVars.getByAppId(app.id);
    const namedVolumes = readNamedVolumes(deployDir);
    const overrideContent = generateOverride({
      appSlug: app.name,
      deployId: deployment.id,
      publicService,
      domain: app.domain,
      publicPort: publicPort || 80,
      envVars,
      namedVolumes,
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
    await dockerComposeUp(deployDir, 'beachhead.override.yml');

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

    // Stop the previous deployment's containers now that the new one is healthy.
    if (app.stop_previous !== false) {
      const prevDeployment = await Deployments.findLastSuccessful(app.id, deployment.id);
      if (prevDeployment) {
        const prevDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${prevDeployment.id}`);
        const prevOverride = path.join(prevDir, 'beachhead.override.yml');
        if (fs.existsSync(prevOverride)) {
          try {
            logger.info(`[deploy #${deployment.id}] Stopping previous deployment #${prevDeployment.id}`);
            await dockerComposeDown(prevDir, 'beachhead.override.yml');
          } catch (stopErr) {
            logger.warn(`[deploy #${deployment.id}] Could not stop previous deployment: ${stopErr.message}`);
          }
        }
      }
    }

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

function start() {
  if (running) return;
  running = true;
  logger.info('Deployment worker started');
  poll();
}

function stop() {
  running = false;
  logger.info('Deployment worker stopped');
}

module.exports = { start, stop };
