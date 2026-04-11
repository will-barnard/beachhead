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
};

module.exports = config;
