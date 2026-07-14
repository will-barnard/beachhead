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
    userDataPath: process.env.ACME_USER_DATA_PATH || '/app/nginx-host/letsencrypt_user_data',
    acmeContainer: process.env.ACME_CONTAINER || 'beachhead-letsencrypt',
  },
};

module.exports = config;
