const { exec } = require('./docker');
const Apps = require('../models/apps');
const logger = require('../logger');

/**
 * Per-app proxy networks.
 *
 * The original Beachhead model put every app's public-facing service onto a
 * single shared `beachhead-net`. That works for routing (nginx-proxy can see
 * everyone) but causes DNS collisions: Docker Compose adds the service name
 * (e.g. `backend`) as a network alias on every network the service joins, so
 * two apps both naming a service `backend` will resolve `backend` to either
 * one from inside any container that's also on the shared network.
 *
 * Fix: each app gets its own proxy network (`bh-app-${appId}`). The user's
 * compose services live there, not on the shared beachhead-net. The two
 * infra containers that need to reach every app — nginx-proxy and the
 * acme-companion (letsencrypt) — are dynamically attached to each per-app
 * network on app creation and detached on app deletion.
 *
 * Static sites and pause placeholders intentionally stay on beachhead-net.
 * They're single-container nginx instances with unique container names and
 * no compose-managed service alias, so they can't participate in the
 * collision.
 */

const PROXY_CONTAINER = 'beachhead-proxy';
const LETSENCRYPT_CONTAINER = 'beachhead-letsencrypt';
const INFRA_CONTAINERS = [PROXY_CONTAINER, LETSENCRYPT_CONTAINER];

/**
 * Deterministic per-app network name. Tied to app ID (not slug) so renames
 * never strand the network and we can always recompute it from the app row.
 */
function networkNameForApp(app) {
  return `bh-app-${app.id}`;
}

/**
 * Create the network if it doesn't exist. Idempotent — safe to call repeatedly.
 */
async function ensureNetwork(networkName) {
  try {
    await exec('docker', ['network', 'inspect', networkName], { timeout: 10000 });
    return false; // already existed
  } catch {
    await exec('docker', ['network', 'create', networkName], { timeout: 15000 });
    logger.info(`Created Docker network: ${networkName}`);
    return true; // newly created
  }
}

/**
 * Connect a container to a network if it's not already connected.
 * Returns true if a new connection was made.
 *
 * Docker's `network connect` errors with "endpoint already exists" when the
 * container is already on the network — we treat that as success.
 */
async function connectContainer(networkName, container) {
  try {
    await exec('docker', ['network', 'connect', networkName, container], { timeout: 15000 });
    logger.info(`Connected ${container} to ${networkName}`);
    return true;
  } catch (err) {
    const msg = err.message || '';
    if (/already exists in network|is already attached to network/i.test(msg)) {
      return false;
    }
    // The infra containers might not be running yet (e.g. first boot before
    // docker compose up of the beachhead stack). Don't crash startup — the
    // next reconciliation pass will catch up.
    if (/No such container/i.test(msg)) {
      logger.warn(`Cannot connect ${container} to ${networkName}: container not present yet`);
      return false;
    }
    throw err;
  }
}

/**
 * Disconnect a container from a network if it's currently connected.
 * Best-effort — never throws.
 */
async function disconnectContainer(networkName, container) {
  try {
    await exec('docker', ['network', 'disconnect', '--force', networkName, container], { timeout: 15000 });
    logger.info(`Disconnected ${container} from ${networkName}`);
  } catch (err) {
    const msg = err.message || '';
    if (/is not connected to network|No such container|No such network/i.test(msg)) {
      return;
    }
    logger.warn(`Disconnect ${container} from ${networkName} failed: ${msg}`);
  }
}

/**
 * Remove a Docker network. Best-effort — won't throw if the network has
 * remaining endpoints (caller can retry after stopping containers).
 */
async function removeNetwork(networkName) {
  try {
    await exec('docker', ['network', 'rm', networkName], { timeout: 10000 });
    logger.info(`Removed Docker network: ${networkName}`);
  } catch (err) {
    logger.warn(`Could not remove network ${networkName}: ${err.message}`);
  }
}

/**
 * Ensure the per-app proxy network exists, infra containers are attached,
 * and the app row records the network name. Idempotent and safe to call
 * on every Beachhead startup as a self-heal.
 *
 * Returns the network name.
 */
async function ensureForApp(app) {
  const networkName = app.proxy_network_name || networkNameForApp(app);

  await ensureNetwork(networkName);

  for (const container of INFRA_CONTAINERS) {
    await connectContainer(networkName, container);
  }

  if (app.proxy_network_name !== networkName) {
    await Apps.update(app.id, { proxy_network_name: networkName });
  }

  return networkName;
}

/**
 * Tear down a per-app proxy network. Detaches infra containers and removes
 * the network. Caller is responsible for having stopped the app's own
 * containers first (otherwise removeNetwork will leave the network in place
 * with a warning, which is harmless but noisy).
 */
async function tearDownForApp(app) {
  const networkName = app.proxy_network_name || networkNameForApp(app);
  for (const container of INFRA_CONTAINERS) {
    await disconnectContainer(networkName, container);
  }
  await removeNetwork(networkName);
}

/**
 * Reconcile every app's proxy network on Beachhead startup.
 *
 * - Creates the network for any app missing one.
 * - Re-attaches infra containers in case they were force-recreated.
 * - Persists the assigned network name on first migration.
 *
 * Does NOT migrate any actually-running deploy containers off beachhead-net.
 * That happens naturally on the next deploy: the override generator now
 * targets the per-app network, so a fresh blue/green swap moves the public
 * service over. Until then, the worst case is the same DNS collision the
 * fix addresses — no regression.
 */
async function reconcileAll() {
  let apps;
  try {
    apps = await Apps.findAll();
  } catch (err) {
    logger.error(`proxyNetwork.reconcileAll: failed to load apps: ${err.message}`);
    return;
  }

  for (const app of apps) {
    try {
      await ensureForApp(app);
    } catch (err) {
      logger.warn(`proxyNetwork.reconcileAll: app ${app.id} (${app.name}) failed: ${err.message}`);
    }
  }
}

module.exports = {
  PROXY_CONTAINER,
  LETSENCRYPT_CONTAINER,
  INFRA_CONTAINERS,
  networkNameForApp,
  ensureNetwork,
  connectContainer,
  disconnectContainer,
  removeNetwork,
  ensureForApp,
  tearDownForApp,
  reconcileAll,
};
