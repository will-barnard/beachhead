const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { isBootstrapMode } = require('../middleware/auth');
const Apps = require('../models/apps');
const EnvVars = require('../models/envVars');
const Deployments = require('../models/deployments');

const router = express.Router();

const ENV_HOST_PATH = path.join(__dirname, '..', '..', '.env.host');

function updateHostEnv(key, value) {
  let content = '';
  try {
    content = fs.readFileSync(ENV_HOST_PATH, 'utf8');
  } catch {
    return false;
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  fs.writeFileSync(ENV_HOST_PATH, content, 'utf8');
  return true;
}

router.post('/configure-auth', async (req, res) => {
  if (!isBootstrapMode()) {
    return res.status(403).json({ error: 'Auth is already configured' });
  }

  const {
    auth_domain,
    auth_repo_url,
    db_password,
    auth_cookie_domain,
    super_admin_email,
    super_admin_password,
    resend_api_key,
    resend_from_email,
  } = req.body;

  if (!auth_domain || !auth_repo_url || !db_password || !auth_cookie_domain ||
      !super_admin_email || !super_admin_password || !resend_api_key || !resend_from_email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // 1. Create brew-auth app
    const app = await Apps.create({
      name: 'brew-auth',
      repo_url: auth_repo_url,
      domain: auth_domain,
      branch: 'main',
      public_service: 'frontend',
      public_port: 80,
      auto_deploy: true,
      stop_previous: true,
      system_app: true,
    });

    logger.info(`Bootstrap: created brew-auth app id=${app.id}`);

    // 2. Set all env vars
    const envVars = {
      DB_PASSWORD: db_password,
      AUTH_COOKIE_DOMAIN: auth_cookie_domain,
      AUTH_ISSUER: `https://${auth_domain}`,
      AUTH_URL: `https://${auth_domain}`,
      SUPER_ADMIN_EMAIL: super_admin_email,
      SUPER_ADMIN_PASSWORD: super_admin_password,
      RESEND_API_KEY: resend_api_key,
      RESEND_FROM_EMAIL: resend_from_email,
    };

    for (const [key, value] of Object.entries(envVars)) {
      await EnvVars.set({ app_id: app.id, key, value });
    }

    logger.info(`Bootstrap: set ${Object.keys(envVars).length} env vars for brew-auth`);

    // 3. Update host .env with auth config for Beachhead itself
    const jwksUrl = `https://${auth_domain}/.well-known/jwks.json`;
    const issuer = `https://${auth_domain}`;

    const envUpdated = updateHostEnv('AUTH_JWKS_URL', jwksUrl) &&
                       updateHostEnv('AUTH_ISSUER', issuer);

    if (!envUpdated) {
      logger.warn('Bootstrap: could not update host .env file — auth will not persist across restarts');
    }

    // 4. Update in-memory config so bootstrap mode ends immediately
    config.auth.jwksUrl = jwksUrl;
    config.auth.issuer = issuer;
    process.env.AUTH_JWKS_URL = jwksUrl;
    process.env.AUTH_ISSUER = issuer;

    logger.info('Bootstrap: auth config updated in-memory, bootstrap mode ended');

    // 5. Trigger initial deploy
    const deployment = await Deployments.create({ app_id: app.id });
    logger.info(`Bootstrap: triggered brew-auth deployment id=${deployment.id}`);

    res.json({
      message: 'Auth configured successfully. brew-auth is deploying.',
      app_id: app.id,
      deployment_id: deployment.id,
    });
  } catch (err) {
    logger.error(`Bootstrap configure-auth failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
