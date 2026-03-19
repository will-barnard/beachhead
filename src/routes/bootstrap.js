const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
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

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
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

    // 3. Write auth config to host .env for persistence across restarts.
    // DO NOT activate auth in-memory yet — brew-auth must be healthy first.
    const jwksUrl = `https://${auth_domain}/.well-known/jwks.json`;
    const issuer = `https://${auth_domain}`;

    const envUpdated = updateHostEnv('AUTH_JWKS_URL', jwksUrl) &&
                       updateHostEnv('AUTH_ISSUER', issuer) &&
                       updateHostEnv('AUTH_COOKIE_NAME', 'brew_token');

    if (!envUpdated) {
      logger.warn('Bootstrap: could not update host .env file — run activate-auth after deploy');
    }

    // 4. Trigger initial deploy
    const deployment = await Deployments.create({ app_id: app.id });
    logger.info(`Bootstrap: triggered brew-auth deployment id=${deployment.id}`);

    res.json({
      message: 'brew-auth created and deploying. Activate auth once it is healthy.',
      app_id: app.id,
      deployment_id: deployment.id,
      auth_domain,
    });
  } catch (err) {
    logger.error(`Bootstrap configure-auth failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Activate auth: verify brew-auth JWKS is reachable, then end bootstrap mode.
 */
router.post('/activate-auth', async (req, res) => {
  if (!isBootstrapMode()) {
    return res.status(200).json({ message: 'Auth is already active' });
  }

  // Find brew-auth app to get its domain
  const brewAuth = await Apps.findByName('brew-auth');
  if (!brewAuth) {
    return res.status(400).json({ error: 'brew-auth app not found. Run configure-auth first.' });
  }

  const jwksUrl = `https://${brewAuth.domain}/.well-known/jwks.json`;
  const issuer = `https://${brewAuth.domain}`;

  // Verify JWKS endpoint is reachable
  try {
    const reachable = await fetchJson(jwksUrl, 10000);
    if (!reachable || !reachable.keys) {
      return res.status(503).json({
        error: `JWKS endpoint not ready at ${jwksUrl}. Wait for brew-auth to finish deploying.`,
      });
    }
  } catch (err) {
    return res.status(503).json({
      error: `Cannot reach JWKS at ${jwksUrl}: ${err.message}`,
    });
  }

  // Activate auth in-memory
  config.auth.jwksUrl = jwksUrl;
  config.auth.issuer = issuer;
  process.env.AUTH_JWKS_URL = jwksUrl;
  process.env.AUTH_ISSUER = issuer;

  // Persist to host .env (may already be written by configure-auth)
  updateHostEnv('AUTH_JWKS_URL', jwksUrl);
  updateHostEnv('AUTH_ISSUER', issuer);

  logger.info('Bootstrap: auth activated — bootstrap mode ended');

  res.json({ message: 'Auth activated. Beachhead now requires authentication.' });
});

/**
 * Get bootstrap status: whether auth is configured, app deployed, JWKS reachable.
 */
router.get('/status', async (req, res) => {
  const brewAuth = await Apps.findByName('brew-auth');

  if (!brewAuth) {
    return res.json({ step: 'not-configured', bootstrap: isBootstrapMode() });
  }

  // Check latest deployment
  const deployments = await Deployments.findByAppId(brewAuth.id, 1);
  const lastDeploy = deployments[0] || null;

  res.json({
    step: isBootstrapMode() ? 'awaiting-activation' : 'active',
    bootstrap: isBootstrapMode(),
    app_id: brewAuth.id,
    domain: brewAuth.domain,
    last_deploy: lastDeploy ? { id: lastDeploy.id, state: lastDeploy.state } : null,
  });
});

module.exports = router;
