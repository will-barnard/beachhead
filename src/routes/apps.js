const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const Apps = require('../models/apps');
const Deployments = require('../models/deployments');
const EnvVars = require('../models/envVars');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { dockerComposeDown, dockerComposeRecreate } = require('../services/docker');
const { generateOverride, writeOverrideFile, readNamedVolumes } = require('../services/composeWrapper');
const config = require('../config');
const logger = require('../logger');

const router = Router();

// All app routes require auth + super_admin
router.use(requireAuth, requireSuperAdmin);

// List all apps
router.get('/', async (req, res) => {
  try {
    const apps = await Apps.findAll();
    res.json(apps);
  } catch (err) {
    logger.error('Failed to list apps', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single app
router.get('/:id', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    res.json(app);
  } catch (err) {
    logger.error('Failed to get app', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create app
router.post('/', async (req, res) => {
  try {
    const { name, repo_url, domain, branch, public_service, public_port, auto_deploy, stop_previous, webhook_secret, system_app } = req.body;

    if (!name || !repo_url || !domain) {
      return res.status(400).json({ error: 'name, repo_url, and domain are required' });
    }

    // Validate repo_url format
    if (!/^https?:\/\/.+/.test(repo_url)) {
      return res.status(400).json({ error: 'repo_url must be an HTTP(S) URL' });
    }

    // Validate domain format
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    // Validate branch (no path traversal or special chars)
    if (branch && (!/^[a-zA-Z0-9._\/-]+$/.test(branch) || branch.includes('..'))) {
      return res.status(400).json({ error: 'Invalid branch name' });
    }

    // Validate port range
    if (public_port !== undefined && public_port !== null && (public_port < 1 || public_port > 65535)) {
      return res.status(400).json({ error: 'public_port must be between 1 and 65535' });
    }

    // Normalize repo_url: strip .git suffix and trailing slashes so webhook matching is reliable
    const normalizedRepoUrl = repo_url.replace(/\.git$/, '').replace(/\/+$/, '');

    const existing = await Apps.findByDomain(domain);
    if (existing) {
      return res.status(409).json({ error: 'Domain already registered' });
    }

    const app = await Apps.create({
      name, repo_url: normalizedRepoUrl, domain, branch, public_service, public_port,
      auto_deploy, stop_previous, webhook_secret, system_app,
    });

    logger.info(`App created: ${app.name} (${app.domain})`);
    res.status(201).json(app);
  } catch (err) {
    logger.error('Failed to create app', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update app
router.put('/:id', async (req, res) => {
  try {
    const app = await Apps.update(req.params.id, req.body);
    if (!app) return res.status(404).json({ error: 'App not found' });
    res.json(app);
  } catch (err) {
    logger.error('Failed to update app', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete app
router.delete('/:id', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    // Tear down containers for all deployments before removing DB records
    const deployments = await Deployments.findByAppId(app.id, 1000);
    for (const dep of deployments) {
      const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${dep.id}`);
      try {
        await dockerComposeDown(deployDir, 'beachhead.override.yml');
        logger.info(`Stopped containers for deploy #${dep.id} (app ${app.name})`);
      } catch (err) {
        // Directory may no longer exist or containers already stopped — not fatal
        logger.warn(`Could not stop containers for deploy #${dep.id}: ${err.message}`);
      }
    }

    await Apps.delete(app.id);
    logger.info(`App deleted: ${app.name}`);
    res.json({ message: 'App deleted', app });
  } catch (err) {
    logger.error('Failed to delete app', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Trigger deployment for an app
router.post('/:id/deploy', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const deployment = await Deployments.create({
      app_id: app.id,
      commit_hash: req.body.commit_hash || null,
    });

    logger.info(`Deployment triggered for ${app.name}: deployment #${deployment.id}`);
    res.status(201).json(deployment);
  } catch (err) {
    logger.error('Failed to trigger deployment', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get deployment history for an app
router.get('/:id/deployments', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const deployments = await Deployments.findByAppId(app.id);
    res.json(deployments);
  } catch (err) {
    logger.error('Failed to get deployments', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single deployment
router.get('/:id/deployments/:deploymentId', async (req, res) => {
  try {
    const deployment = await Deployments.findById(req.params.deploymentId);
    if (!deployment || deployment.app_id !== parseInt(req.params.id, 10)) {
      return res.status(404).json({ error: 'Deployment not found' });
    }
    res.json(deployment);
  } catch (err) {
    logger.error('Failed to get deployment', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel all active (stuck) deployments for an app
router.post('/:id/cancel-deployment', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const cancelled = await Deployments.cancelActiveForApp(app.id);
    logger.info(`Cancelled ${cancelled} active deployment(s) for app ${app.id} (${app.name})`);
    res.json({ cancelled });
  } catch (err) {
    logger.error('Failed to cancel deployments', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enable www redirect: updates VIRTUAL_HOST/LETSENCRYPT_HOST to include www.{domain},
// writes a vhost.d redirect config, and force-recreates the running service.
const SAFE_HOSTNAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]+[a-zA-Z0-9]$/;

router.post('/:id/www', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    if (!app.domain) {
      return res.status(400).json({ error: 'App must have a domain configured' });
    }
    if (!SAFE_HOSTNAME.test(app.domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const dep = await Deployments.findLastSuccessful(app.id, -1);
    if (!dep) {
      return res.status(400).json({ error: 'No successful deployment found — deploy the app first' });
    }

    const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${dep.id}`);

    // public_service may live in beachhead.json rather than the DB row
    const bhConfig = require('../services/composeWrapper').readBeachheadConfig(deployDir);
    const publicService = bhConfig?.public_service || app.public_service;
    const publicPort = bhConfig?.public_port || app.public_port;

    if (!publicService) {
      return res.status(400).json({ error: 'No public_service found in app config or beachhead.json' });
    }

    // Persist flag
    await Apps.update(app.id, { www_redirect: true });

    // Regenerate override with www domains
    const envVars = await EnvVars.getByAppId(app.id);
    const namedVolumes = readNamedVolumes(deployDir);
    const overrideContent = generateOverride({
      appSlug: app.name,
      deployId: dep.id,
      publicService,
      domain: app.domain,
      publicPort: publicPort || 80,
      envVars,
      namedVolumes,
      wwwRedirect: true,
    });
    writeOverrideFile(deployDir, overrideContent);

    // Write nginx-proxy location config to redirect www → non-www
    const vhostdDir = '/etc/nginx/vhost.d';
    const locationFile = path.join(vhostdDir, `www.${app.domain}_location`);
    fs.writeFileSync(locationFile, `return 301 https://${app.domain}$request_uri;\n`, 'utf8');

    // Restart the service container to pick up the new env vars
    await dockerComposeRecreate(deployDir, 'beachhead.override.yml', publicService);

    logger.info(`WWW redirect enabled for ${app.name} (${app.domain})`);
    res.json({ message: `WWW enabled — cert request and redirect configured for www.${app.domain}` });
  } catch (err) {
    logger.error('Failed to enable www redirect', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
