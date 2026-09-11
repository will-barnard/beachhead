const path = require('path');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  domain: process.env.BEACHHEAD_DOMAIN || '',

  db: {
    connectionString: process.env.DATABASE_URL || 'postgresql://beachhead:beachhead@localhost:5432/beachhead',
  },

  auth: {
    jwtSecret: process.env.AUTH_JWT_SECRET || 'beachhead-dev-secret-change-me',
    cookieName: process.env.AUTH_COOKIE_NAME || 'beachhead_token',
  },

  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },

  deploy: {
    baseDir: process.env.DEPLOY_BASE_DIR || path.join(__dirname, '..', '..', 'deployments'),
    dockerNetwork: process.env.DOCKER_NETWORK || 'beachhead-net',
  },

  healthCheck: {
    timeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT, 10) || 120000,
    interval: parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 3000,
  },

  // Standalone (app-independent) certificate management. Beachhead writes the
  // acme-companion user-data file and reads issued certs from the shared certs
  // volume so they can be downloaded and installed on other machines (e.g. a NAS).
  certs: {
    dir: process.env.CERTS_DIR || '/etc/nginx/certs',
    // Path acme-companion reads inside its OWN container; Beachhead delivers the
    // file there via `docker cp` (no host bind mount — avoids permission/inode issues).
    acmeUserDataPath: process.env.ACME_USER_DATA_PATH || '/app/letsencrypt_user_data',
    acmeContainer: process.env.ACME_CONTAINER || 'beachhead-letsencrypt',
    // nginx-proxy container name — used to validate + reload after Beachhead
    // reconciles the shared ACME challenge location (see ensureChallengeLocation).
    proxyContainer: process.env.PROXY_CONTAINER || 'beachhead-proxy',
    // The shared vhost.d/default file, bind-mounted into this container, into
    // nginx-proxy, and into acme-companion. Beachhead keeps exactly one ACME
    // challenge location here so acme-companion can't create a duplicate.
    vhostDefaultPath: process.env.VHOST_DEFAULT_PATH || '/etc/nginx/vhost.d/default',
    // How often to re-assert the canonical vhost.d/default (ms). Catches
    // duplicates acme-companion may add during its own hourly loop.
    challengeReconcileMs: parseInt(process.env.CHALLENGE_RECONCILE_MS, 10) || 120000,
  },

  // Self-update — rebuilds/restarts Beachhead itself (see services/selfUpdate.js).
  // containerName must match docker-compose.yml's `container_name: beachhead-api`
  // for this container so the repo directory can be discovered from its
  // Compose-assigned label rather than requiring a separate env var.
  selfUpdate: {
    containerName: process.env.BEACHHEAD_CONTAINER_NAME || 'beachhead-api',
    updaterContainerName: process.env.SELF_UPDATER_CONTAINER || 'beachhead-self-updater',
    updaterImage: process.env.SELF_UPDATER_IMAGE || 'alpine:3.20',
  },
};

module.exports = config;
