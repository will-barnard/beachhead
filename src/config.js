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
    jwksUrl: process.env.AUTH_JWKS_URL || '',
    issuer: process.env.AUTH_ISSUER || '',
    cookieName: process.env.AUTH_COOKIE_NAME || 'access_token',
    workspaceId: process.env.AUTH_WORKSPACE_ID || '',
    workspaceSlug: process.env.AUTH_WORKSPACE_SLUG || '',
    workspaceApiKey: process.env.AUTH_WORKSPACE_API_KEY || '',
    mode: process.env.AUTH_MODE || '', // 'local' or 'remote'
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
