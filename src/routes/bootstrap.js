const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
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
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
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

function postJson(url, body, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const opts = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      timeout: timeoutMs,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.error || json.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Invalid JSON from ${url} (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
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
                       updateHostEnv('AUTH_COOKIE_NAME', 'brew_token') &&
                       updateHostEnv('AUTH_MODE', 'local');

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
 * Connect to an existing remote brew-auth instance.
 * The user provides the brew-auth URL, workspace name/slug, and their super admin credentials.
 * This registers a workspace in brew-auth and stores the connection details.
 */
router.post('/connect-auth', async (req, res) => {
  if (!isBootstrapMode()) {
    return res.status(403).json({ error: 'Auth is already configured' });
  }

  const { auth_url, workspace_name, workspace_slug, beachhead_url, admin_email, admin_password } = req.body;

  if (!auth_url || !workspace_name || !workspace_slug || !admin_email || !admin_password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const baseUrl = auth_url.replace(/\/+$/, '');

  try {
    // 1. Log in to remote brew-auth to get a token
    logger.info(`Bootstrap: logging into remote brew-auth at ${baseUrl}`);
    const loginResult = await postJson(`${baseUrl}/api/auth/login`, {
      email: admin_email,
      password: admin_password,
    });

    if (!loginResult.token) {
      return res.status(401).json({ error: 'Login failed — no token returned' });
    }

    // 2. Register this Beachhead as a workspace
    const beachheadUrl = beachhead_url || (config.domain ? `https://${config.domain}` : '');
    logger.info(`Bootstrap: registering workspace "${workspace_slug}" at remote brew-auth`);
    const wsResult = await postJson(
      `${baseUrl}/api/workspaces/register`,
      { name: workspace_name, slug: workspace_slug, url: beachheadUrl },
      { Authorization: `Bearer ${loginResult.token}` }
    );

    // 3. Verify JWKS is reachable
    const jwksUrl = `${baseUrl}/.well-known/jwks.json`;
    const issuer = baseUrl;

    const jwks = await fetchJson(jwksUrl, 10000);
    if (!jwks || !jwks.keys) {
      return res.status(503).json({ error: `JWKS not available at ${jwksUrl}` });
    }

    // 4. Persist connection details
    updateHostEnv('AUTH_JWKS_URL', jwksUrl);
    updateHostEnv('AUTH_ISSUER', issuer);
    updateHostEnv('AUTH_COOKIE_NAME', 'brew_token');
    updateHostEnv('AUTH_MODE', 'remote');
    updateHostEnv('AUTH_WORKSPACE_ID', wsResult.workspaceId);
    updateHostEnv('AUTH_WORKSPACE_SLUG', wsResult.slug);
    updateHostEnv('AUTH_WORKSPACE_API_KEY', wsResult.apiKey);

    // Update in-memory config
    config.auth.mode = 'remote';
    config.auth.workspaceId = wsResult.workspaceId;
    config.auth.workspaceSlug = wsResult.slug;
    config.auth.workspaceApiKey = wsResult.apiKey;

    logger.info(`Bootstrap: connected to remote brew-auth, workspace="${wsResult.slug}" id=${wsResult.workspaceId}`);

    res.json({
      message: 'Connected to remote brew-auth. Activate auth to start requiring authentication.',
      workspace_id: wsResult.workspaceId,
      workspace_slug: wsResult.slug,
      auth_url: baseUrl,
    });
  } catch (err) {
    logger.error(`Bootstrap connect-auth failed: ${err.message}`);
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

  let jwksUrl, issuer;

  if (config.auth.mode === 'remote') {
    // Remote mode: use the configured values from connect-auth
    jwksUrl = process.env.AUTH_JWKS_URL;
    issuer = process.env.AUTH_ISSUER;
    if (!jwksUrl) {
      return res.status(400).json({ error: 'Remote auth not configured. Run connect-auth first.' });
    }
  } else {
    // Local mode: look up brew-auth app
    const brewAuth = await Apps.findByName('brew-auth');
    if (!brewAuth) {
      return res.status(400).json({ error: 'brew-auth app not found. Run configure-auth first.' });
    }
    jwksUrl = `https://${brewAuth.domain}/.well-known/jwks.json`;
    issuer = `https://${brewAuth.domain}`;
  }

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

  // Persist to host .env (may already be written by configure-auth / connect-auth)
  updateHostEnv('AUTH_JWKS_URL', jwksUrl);
  updateHostEnv('AUTH_ISSUER', issuer);

  logger.info('Bootstrap: auth activated — bootstrap mode ended');

  res.json({ message: 'Auth activated. Beachhead now requires authentication.' });
});

/**
 * Get bootstrap status: whether auth is configured, app deployed, JWKS reachable.
 */
router.get('/status', async (req, res) => {
  const mode = config.auth.mode || process.env.AUTH_MODE || '';

  if (mode === 'remote') {
    // Remote mode — no local brew-auth app
    const hasJwks = !!(config.auth.jwksUrl || process.env.AUTH_JWKS_URL);
    return res.json({
      step: isBootstrapMode() ? (hasJwks ? 'awaiting-activation' : 'not-configured') : 'active',
      bootstrap: isBootstrapMode(),
      mode: 'remote',
      auth_url: config.auth.issuer || process.env.AUTH_ISSUER || '',
      workspace_id: config.auth.workspaceId || '',
      workspace_slug: config.auth.workspaceSlug || '',
    });
  }

  // Local mode
  const brewAuth = await Apps.findByName('brew-auth');

  if (!brewAuth) {
    return res.json({ step: 'not-configured', bootstrap: isBootstrapMode(), mode: '' });
  }

  // Check latest deployment
  const deployments = await Deployments.findByAppId(brewAuth.id, 1);
  const lastDeploy = deployments[0] || null;

  res.json({
    step: isBootstrapMode() ? 'awaiting-activation' : 'active',
    bootstrap: isBootstrapMode(),
    mode: 'local',
    app_id: brewAuth.id,
    domain: brewAuth.domain,
    last_deploy: lastDeploy ? { id: lastDeploy.id, state: lastDeploy.state } : null,
  });
});

module.exports = router;
