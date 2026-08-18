const fs = require('fs');
const path = require('path');
const Deployments = require('../models/deployments');
const Apps = require('../models/apps');
const AppEndpoints = require('../models/appEndpoints');
const ServicePorts = require('../models/servicePorts');
const StaticSites = require('../models/staticSites');
const EnvVars = require('../models/envVars');
const { EnvFiles } = require('../models/envFiles');
const { generateOverride, writeOverrideFile, readBeachheadConfig, readNamedVolumes, readAllServiceNames, readServiceVolumes, readBuildableServices, generateStatefulOverride, stripHostPorts } = require('./composeWrapper');
const { exec, gitClone, dockerComposeUp, dockerComposeUpNoBuild, dockerComposeUpStateful, stopContainersUsingVolume, stopComposeProject, dockerComposeDown, dockerComposeLogs, ensureNetwork } = require('./docker');
const { checkHealth } = require('./healthCheck');
const config = require('../config');
const logger = require('../logger');
const BuildJobs = require('../models/buildJobs');
const Settings = require('../models/settings');
const proxyNetwork = require('./proxyNetwork');
const onDemand = require('./onDemand');
const construction = require('./construction');

const STATES = Deployments.STATES;
const POLL_INTERVAL = 5000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — mark stuck deployments as FAILED

let running = false;

// Apps currently being reconciled by startup recovery. Startup recovery and a
// real deployment must never `compose up` the same app at the same time - they
// would fight over the same container names. A deployment for an app in this
// set is deferred back to PENDING and picked up on a later poll.
const reconciling = new Set();

async function transition(deployment, state, logMsg) {
  logger.info(`[deploy #${deployment.id}] ${state}: ${logMsg || ''}`);
  return Deployments.updateState(deployment.id, state, `[${state}] ${logMsg || ''}`);
}

/**
 * Safely quote a value for a .env file.
 *
 * Quotes anything that is not a plain bare token. The previous version only
 * quoted newlines, quotes and shell metacharacters, which left values
 * containing SPACES unquoted:
 *
 *   EMAIL_FROM=Chicago Electric Piano <no-reply@example.com>
 *
 * Whether that survives depends on which .env parser reads it - Docker
 * Compose's interpolation parser, its env_file parser, docker --env-file, and
 * dotenv all differ, and older versions differ again. Quoting removes the
 * question entirely:
 *
 *   EMAIL_FROM='Chicago Electric Piano <no-reply@example.com>'
 *
 * Bare tokens are left unquoted so existing values (URLs, keys, hostnames)
 * render unchanged and diffs stay readable.
 */
const BARE_ENV_TOKEN = /^[A-Za-z0-9_.@:\/+=-]*$/;

function envQuote(value) {
  const str = String(value ?? '');
  if (BARE_ENV_TOKEN.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

const BUILD_JOB_POLL_INTERVAL = 3000;   // how often to check if remote builds are done
const BUILD_JOB_TIMEOUT = 15 * 60 * 1000; // 15 min max wait for remote builds

/**
 * Enqueue build jobs for each buildable service and wait for them to finish.
 * Returns a map of { service: imageTag } on success.
 * Throws if any build fails or times out.
 */
async function remoteBuild(deployment, app, deployDir) {
  const registry = await Settings.getRegistryConfig();
  if (!registry.url) {
    throw new Error('Remote builds enabled but no registry URL configured (Settings → Registry URL)');
  }

  const buildableServices = readBuildableServices(deployDir);
  if (buildableServices.length === 0) {
    logger.info(`[deploy #${deployment.id}] No buildable services found — skipping remote build`);
    return null; // fall through to local compose up
  }

  const slug = (app.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  const imageOverrides = {};

  // Note: build jobs include repo_url and branch so the remote worker can clone.
  // We store these in extra columns on the build_jobs row via a JOIN — but since
  // the job claim endpoint can read from apps, we just store what we need.
  for (const svc of buildableServices) {
    const imageTag = `${registry.url}/${slug}-${svc.service}:d${deployment.id}`;
    const job = await BuildJobs.create({
      deployment_id: deployment.id,
      app_id: app.id,
      service: svc.service,
      dockerfile: svc.dockerfile,
      build_context: svc.context,
      image_tag: imageTag,
    });
    imageOverrides[svc.service] = imageTag;
    logger.info(`[deploy #${deployment.id}] Enqueued build job #${job.id} for ${svc.service} → ${imageTag}`);
  }

  // Poll until all build jobs are done
  const deadline = Date.now() + BUILD_JOB_TIMEOUT;
  while (Date.now() < deadline) {
    const status = await BuildJobs.checkDeploymentStatus(deployment.id);
    if (status.done) {
      if (!status.success) {
        const failedNames = status.failed.map(j => j.service).join(', ');
        throw new Error(`Remote build failed for service(s): ${failedNames}`);
      }
      logger.info(`[deploy #${deployment.id}] All remote builds completed successfully`);

      // Login to the registry so we can pull the images
      if (registry.user && registry.password) {
        const registryHost = registry.url.split('/')[0];
        logger.info(`[deploy #${deployment.id}] Logging in to registry ${registryHost}`);
        await new Promise((resolve, reject) => {
          const proc = require('child_process').spawn('docker', ['login', registryHost, '-u', registry.user, '--password-stdin'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          proc.stdin.write(registry.password);
          proc.stdin.end();
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker login exited with code ${code}`)));
          proc.on('error', reject);
        });
      }

      // Pull images on the local Docker daemon
      for (const [service, tag] of Object.entries(imageOverrides)) {
        logger.info(`[deploy #${deployment.id}] Pulling ${tag}`);
        await exec('docker', ['pull', tag], { timeout: 120000 });
      }

      return imageOverrides;
    }
    // Wait before polling again
    await new Promise(r => setTimeout(r, BUILD_JOB_POLL_INTERVAL));
  }

  // Timed out — fail remaining jobs
  await BuildJobs.failAllForDeployment(deployment.id, 'Timed out waiting for remote build');
  throw new Error('Remote builds timed out');
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

    // Remove host port bindings — nginx-proxy handles routing and host ports
    // prevent blue-green deploys when old containers still hold the port.
    stripHostPorts(deployDir);

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

    // Load static LAN port mappings (opt-in per service). Bind to the
    // configured LAN IP for true LAN-only exposure.
    const staticPorts = await ServicePorts.findEnabledByAppId(app.id);
    const lanBindIp = await Settings.getLanBindIp();

    // Compose the staging host (e.g. "acme.dev.example.com") if both the
    // global staging root and the app's staging subdomain are set.
    let stagingHost = null;
    if (app.staging_subdomain) {
      const stagingRoot = await Settings.getStagingRootDomain();
      if (stagingRoot) stagingHost = `${app.staging_subdomain}.${stagingRoot}`;
    }

    // Ensure the per-app proxy network exists and that the infra containers
    // are attached. Idempotent — covers freshly-created apps (already wired
    // by routes/apps.js#create) and apps migrated from the old shared
    // beachhead-net (no proxy_network_name yet).
    const appProxyNetwork = await proxyNetwork.ensureForApp(app);
    app.proxy_network_name = appProxyNetwork;

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
      stagingHost,
      stagingOnly: app.staging_only || false,
      proxyNetwork: appProxyNetwork,
      staticPorts,
      lanBindIp,
    });
    writeOverrideFile(deployDir, overrideContent);

    // Write a .env file for any unscoped env vars (many apps read from .env)
    const globalEnvVars = envVars.filter((v) => !v.target_service && !v.env_file_id);
    if (globalEnvVars.length > 0) {
      // UNIQUE(app_id, key, target_service) does not constrain rows where
      // target_service IS NULL, because Postgres treats NULLs as distinct. That
      // let duplicate globals accumulate. Keep the last write and say so, so a
      // stale duplicate cannot silently win.
      const seen = new Map();
      for (const v of globalEnvVars) {
        if (seen.has(v.key)) {
          logger.warn(`[deploy #${deployment.id}] duplicate global env var ${v.key} - using the most recently written value`);
        }
        seen.set(v.key, v);
      }
      const deduped = [...seen.values()];
      logger.info(`[deploy #${deployment.id}] writing .env with ${deduped.length} var(s): ${deduped.map((v) => v.key).join(', ')}`);
      const envContent = deduped.map((v) => `${v.key}=${envQuote(v.value)}`).join('\n') + '\n';
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

    // Check build mode — remote workers build + push images, local does compose up --build
    const buildMode = await Settings.getBuildMode();
    let imageOverrides = null;

    if (buildMode === 'remote') {
      await transition(deployment, STATES.BUILDING, 'Waiting for remote build workers…');
      imageOverrides = await remoteBuild(deployment, app, deployDir);

      // If remote build returned overrides, regenerate the override file with image refs
      if (imageOverrides) {
        const updatedOverride = generateOverride({
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
          imageOverrides,
          stagingHost,
          stagingOnly: app.staging_only || false,
          proxyNetwork: appProxyNetwork,
          staticPorts,
          lanBindIp,
        });
        writeOverrideFile(deployDir, updatedOverride);
        fs.chmodSync(path.join(deployDir, 'beachhead.override.yml'), 0o600);
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
      fs.writeFileSync(statefulOverridePath, generateStatefulOverride(statefulNetwork, namedVolumes), 'utf8');
      fs.chmodSync(statefulOverridePath, 0o600);

      // On the first deployment after stateful_services is added, the database may
      // still be running under the old per-deploy project and holding the data
      // directory. Stop those containers first (one-time brief restart) so the
      // stateful project can take ownership.
      const statefulVolumes = readServiceVolumes(deployDir, statefulServices);
      for (const vol of statefulVolumes) {
        await stopContainersUsingVolume(vol, statefulProject);
      }

      logger.info(`[deploy #${deployment.id}] Starting stateful services under project '${statefulProject}': ${statefulServices.join(', ')}`);
      await dockerComposeUpStateful(deployDir, statefulProject, statefulServices, 'beachhead.stateful.override.yml');
    }

    // A published host port is a singleton resource — if the previous
    // deployment's container is still holding it, the new container can't bind
    // and `compose up` fails with "port is already allocated". For apps that
    // opt into static LAN ports we therefore stop the previous deployment
    // *before* starting the new one (brief downtime on this app only), instead
    // of relying on the usual post-health blue/green swap. Apps without static
    // ports keep zero-downtime deploys.
    if (staticPorts.length > 0 && app.stop_previous !== false) {
      const prevDepId = app.active_deployment_id;
      const prevDeployment = prevDepId
        ? await Deployments.findById(prevDepId)
        : await Deployments.findLastSuccessful(app.id, deployment.id);
      if (prevDeployment && prevDeployment.id !== deployment.id) {
        const prevDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${prevDeployment.id}`);
        const prevOverride = path.join(prevDir, 'beachhead.override.yml');
        const prevProjectName = path.basename(prevDir);
        logger.info(`[deploy #${deployment.id}] Static port(s) configured — stopping previous deployment #${prevDeployment.id} before start to free host port(s)`);
        try {
          if (fs.existsSync(prevOverride)) {
            await dockerComposeDown(prevDir, 'beachhead.override.yml');
          } else {
            await stopComposeProject(prevProjectName);
          }
        } catch (e) {
          logger.warn(`[deploy #${deployment.id}] Pre-start stop failed: ${e.message} — falling back to label-based stop`);
          await stopComposeProject(prevProjectName);
        }
      }
    }

    // Start only the transient (non-stateful) services under the deploy-specific project.
    // If all services are transient, pass an empty array (starts everything).
    const allServices = readAllServiceNames(deployDir);
    const transientServices = allServices.filter(s => !statefulServices.includes(s));

    if (imageOverrides) {
      // Remote-built: images already pulled, no build needed
      await dockerComposeUpNoBuild(deployDir, 'beachhead.override.yml', transientServices);
    } else {
      // Local build: compose up --build (existing behavior)
      await dockerComposeUp(deployDir, 'beachhead.override.yml', transientServices);
    }

    // ── PROXY_SETUP ──
    await transition(deployment, STATES.PROXY_SETUP, `Proxy configured for ${app.domain} -> ${publicService}:${publicPort || 80}`);
    // The nginx-proxy container reads VIRTUAL_HOST/VIRTUAL_PORT env vars automatically.
    // No explicit proxy config needed — the override already injects those vars.

    // ── VERIFY_HEALTH ──
    const healthPath = bhConfig?.health_check || '/';
    // In staging-only mode the primary domain has no VIRTUAL_HOST registered
    // on purpose (generateOverride only wires up stagingHost) — checking
    // app.domain here would always 503/timeout even on a healthy deploy.
    const healthCheckDomain = (app.staging_only && stagingHost) ? stagingHost : app.domain;
    await transition(deployment, STATES.VERIFY_HEALTH, `Checking health of ${healthCheckDomain}${healthPath}`);
    const healthy = await checkHealth(healthCheckDomain, { path: healthPath });
    if (!healthy) {
      throw new Error(`Health check failed for ${healthCheckDomain}`);
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

    // A deploy recreates the public container, which re-registers its
    // VIRTUAL_HOSTs with nginx-proxy. In staging-only mode that list excludes
    // the primary domain, so re-assert the under-construction placeholder here
    // — otherwise a deploy would silently drop the domain back to a bare 503.
    // No-op when the page isn't enabled.
    await construction.syncForApp(app);

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
 * Regenerate the compose override for an existing deployment using the
 * current Beachhead generator. Called by startupCleanup so apps that
 * predate later override-format changes (e.g. the per-app proxy network
 * migration) pick up the new shape on the next Beachhead restart without
 * needing a fresh clone+build. Container names stay stable so compose
 * recreates the existing container in place.
 */
async function regenerateOverride({ app, deployment, deployDir, publicService, publicPort, statefulNetwork, proxyNetworkName }) {
  if (!publicService) return; // no public service => nothing to override
  const envVars = await EnvVars.getByAppId(app.id);
  const namedVolumes = readNamedVolumes(deployDir);
  const endpoints = await AppEndpoints.findByAppId(app.id);
  const additionalEndpoints = endpoints.map(ep => ({
    service: ep.service, domain: ep.domain, port: ep.port || 80, wwwRedirect: ep.www_redirect || false,
  }));
  const staticPorts = await ServicePorts.findEnabledByAppId(app.id);
  const lanBindIp = await Settings.getLanBindIp();
  let stagingHost = null;
  if (app.staging_subdomain) {
    const stagingRoot = await Settings.getStagingRootDomain();
    if (stagingRoot) stagingHost = `${app.staging_subdomain}.${stagingRoot}`;
  }
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
    stagingHost,
    stagingOnly: app.staging_only || false,
    proxyNetwork: proxyNetworkName,
    staticPorts,
    lanBindIp,
  });
  writeOverrideFile(deployDir, overrideContent);
  fs.chmodSync(path.join(deployDir, 'beachhead.override.yml'), 0o600);
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

// Idle sweep runs much less often than the deployment poll. Rather than spin
// up a separate timer, we time-stamp the last sweep and only call it when
// enough time has elapsed.
const IDLE_SWEEP_INTERVAL_MS = 60_000;
let lastIdleSweepAt = 0;

async function poll() {
  if (!running) return;

  try {
    // Periodically recover stuck deployments
    await recoverStaleDeployments();

    // On-demand idle sweep — auto-pauses on-demand apps that have been idle
    // past their threshold. Cheap when there are no candidates, so safe to
    // call from the same loop.
    if (Date.now() - lastIdleSweepAt >= IDLE_SWEEP_INTERVAL_MS) {
      lastIdleSweepAt = Date.now();
      try {
        await onDemand.idleSweep();
      } catch (err) {
        logger.warn(`onDemand idle sweep failed: ${err.message}`);
      }
    }

    const job = await Deployments.getNextPending();
    if (job) {
      if (reconciling.has(job.app_id)) {
        await Deployments.updateState(job.id, STATES.PENDING, '[PENDING] Waiting — startup recovery in progress for this app');
        logger.info(`[deploy #${job.id}] Deferred — startup recovery in progress for app ${job.app_id}`);
        if (running) setTimeout(poll, POLL_INTERVAL);
        return;
      }

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
/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

// Docker operations are I/O bound, but reconciling every app at once would
// hammer a small VM. Three at a time keeps startup quick without thrashing.
const STARTUP_CONCURRENCY = 3;

async function startupCleanup() {
  try {
    const apps = await Apps.findAll();
    const startedAt = Date.now();

    await mapWithConcurrency(apps, STARTUP_CONCURRENCY, async (app) => {
      // Don't bring paused apps back up. The pause placeholder has its own
      // --restart unless-stopped policy and Docker will revive it on its own.
      // Without this guard, a hard reset would re-launch a paused app's stateful
      // services and any transient services whose compose project still has
      // them registered — exactly the regression that lets a pre-existing boot
      // loop keep consuming the VM after pause.
      if (app.paused) {
        logger.info(`[startup] Skipping paused app ${app.name}`);
        return;
      }

      // Prefer the explicitly tracked active deployment; fall back to last successful
      const current = app.active_deployment_id
        ? await Deployments.findById(app.active_deployment_id)
        : await Deployments.findLastSuccessful(app.id, -1);

      if (!current) return;

      const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${current.id}`);
      const overridePath = path.join(deployDir, 'beachhead.override.yml');
      if (!fs.existsSync(overridePath)) return;

      // Claim the app BEFORE the first await. poll() checks this set, so
      // claiming first closes the window where a deployment could be picked up
      // between the check below and the claim.
      reconciling.add(app.id);
      const appStartedAt = Date.now();
      try {
        // A queued or in-flight deployment supersedes "make the old one run".
        // Reconciling underneath it would fight over container names.
        if (await Deployments.hasActiveForApp(app.id, -1)) {
          logger.info(`[startup] Skipping ${app.name} — a deployment is already in progress`);
          return;
        }

        logger.info(`[startup] Ensuring deployment #${current.id} is running for ${app.name}`);
        // Make sure the shared infra network exists (defensive — usually
        // created by Beachhead's own compose stack) and that this app's
        // per-app proxy network is provisioned with infra attached.
        await ensureNetwork(config.deploy.dockerNetwork);
        let appProxyNetwork = null;
        try {
          appProxyNetwork = await proxyNetwork.ensureForApp(app);
          app.proxy_network_name = appProxyNetwork;
        } catch (err) {
          logger.warn(`[startup] proxy network setup failed for ${app.name}: ${err.message}`);
        }

        // Also ensure stateful services are running
        const bhConfig = readBeachheadConfig(deployDir);
        const statefulServices = Array.isArray(bhConfig?.stateful_services) ? bhConfig.stateful_services : [];
        const slug = (app.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
        const statefulNetwork = statefulServices.length > 0 ? `${slug}-internal` : null;
        if (statefulServices.length > 0) {
          await ensureNetwork(statefulNetwork);
          const statefulOverridePath = path.join(deployDir, 'beachhead.stateful.override.yml');
          if (fs.existsSync(statefulOverridePath)) {
            await dockerComposeUpStateful(deployDir, `${slug}-stateful`, statefulServices, 'beachhead.stateful.override.yml');
          }
        }

        // Regenerate the override file so existing deployments pick up the
        // current generator's output — in particular, the per-app proxy
        // network. Container names are stable (they include deployId) so
        // compose detects the network change and recreates the container in
        // place; existing images stay cached, no rebuild needed.
        if (appProxyNetwork) {
          try {
            await regenerateOverride({
              app, deployment: current, deployDir, publicService: bhConfig?.public_service || app.public_service,
              publicPort: bhConfig?.public_port || app.public_port, statefulNetwork,
              proxyNetworkName: appProxyNetwork,
            });
          } catch (err) {
            logger.warn(`[startup] Could not regenerate override for ${app.name}: ${err.message}`);
          }
        }

        // Only start transient (non-stateful) services — never start stateful services
        // (e.g. postgres) under the per-deploy project during startup recovery.
        const allServices = readAllServiceNames(deployDir);
        const transientServices = allServices.filter(s => !statefulServices.includes(s));
        await dockerComposeUp(deployDir, 'beachhead.override.yml', transientServices);

        // Stop stray containers from other deploy projects for this app.
        // Guards against crashes mid-deploy that leave old containers registered
        // with nginx-proxy under the same VIRTUAL_HOST.
        await stopOtherDeployContainers(app.id, current.id);
        logger.info(`[startup] ${app.name} ready in ${Math.round((Date.now() - appStartedAt) / 1000)}s`);
      } catch (err) {
        logger.warn(`[startup] Could not start deployment #${current.id} for ${app.name}: ${err.message}`);
      } finally {
        reconciling.delete(app.id);
      }
    });

    logger.info(`[startup] Recovery finished for ${apps.length} app(s) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
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

  // Start polling for queued deployments IMMEDIATELY.
  //
  // This used to be `Promise.all([...]).finally(() => poll())`, so the queue was
  // not read until startup recovery had finished reconciling every app - a
  // serial walk doing `docker compose up` per app. On a five app host that was
  // roughly fifteen minutes during which a deployment triggered from the
  // dashboard simply sat in PENDING with nothing in the logs to explain it.
  //
  // Recovery now runs concurrently. The `reconciling` set keeps the two from
  // touching the same app at once: a deployment for an app being reconciled is
  // deferred back to PENDING, and recovery skips any app that already has a
  // deployment in flight.
  poll();

  Promise.all([startupCleanup(), startupStaticSites()]).catch((err) => {
    logger.error('Startup recovery failed', err);
  });
}

function stop() {
  running = false;
  logger.info('Deployment worker stopped');
}

module.exports = { start, stop, envQuote, mapWithConcurrency };
