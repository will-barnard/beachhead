const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const Apps = require('../models/apps');
const AppEndpoints = require('../models/appEndpoints');
const Deployments = require('../models/deployments');
const EnvVars = require('../models/envVars');
const StaticSites = require('../models/staticSites');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { dockerComposeDown, dockerComposeRecreate } = require('../services/docker');
const { generateOverride, writeOverrideFile, readBeachheadConfig, readNamedVolumes } = require('../services/composeWrapper');
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
      return res.status(409).json({ error: 'Domain already registered to another app' });
    }
    const existingEndpoint = await AppEndpoints.findByDomain(domain);
    if (existingEndpoint) {
      return res.status(409).json({ error: 'Domain already used by an app endpoint' });
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

/**
 * Helper to regenerate the compose override for the current deployment of an app.
 * Used by both the www route and endpoint mutations.
 */
async function regenerateOverride(app) {
  const dep = await Deployments.findLastSuccessful(app.id, -1);
  if (!dep) return null;

  const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${dep.id}`);
  const bhConfig = readBeachheadConfig(deployDir);
  const publicService = bhConfig?.public_service || app.public_service;
  const publicPort = bhConfig?.public_port || app.public_port;

  if (!publicService) return null;

  const envVars = await EnvVars.getByAppId(app.id);
  const namedVolumes = readNamedVolumes(deployDir);
  const endpoints = await AppEndpoints.findByAppId(app.id);
  const additionalEndpoints = endpoints.map(ep => ({
    service: ep.service,
    domain: ep.domain,
    port: ep.port || 80,
    wwwRedirect: ep.www_redirect || false,
  }));

  const overrideContent = generateOverride({
    appSlug: app.name,
    deployId: dep.id,
    publicService,
    domain: app.domain,
    publicPort: publicPort || 80,
    envVars,
    namedVolumes,
    wwwRedirect: app.www_redirect || false,
    additionalEndpoints,
  });
  writeOverrideFile(deployDir, overrideContent);

  return { dep, deployDir, publicService };
}

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

    // Persist flag
    await Apps.update(app.id, { www_redirect: true });
    app.www_redirect = true;

    const result = await regenerateOverride(app);
    if (!result) {
      return res.status(400).json({ error: 'No successful deployment found or no public_service configured' });
    }

    // Write nginx-proxy location config to redirect www → non-www
    const vhostdDir = '/etc/nginx/vhost.d';
    const locationFile = path.join(vhostdDir, `www.${app.domain}_location`);
    fs.writeFileSync(locationFile, `return 301 https://${app.domain}$request_uri;\n`, 'utf8');

    // Restart the service container to pick up the new env vars
    await dockerComposeRecreate(result.deployDir, 'beachhead.override.yml', result.publicService);

    logger.info(`WWW redirect enabled for ${app.name} (${app.domain})`);
    res.json({ message: `WWW enabled — cert request and redirect configured for www.${app.domain}` });
  } catch (err) {
    logger.error('Failed to enable www redirect', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Additional Endpoints (multi-service apps) ──

// List endpoints for an app
router.get('/:id/endpoints', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    const endpoints = await AppEndpoints.findByAppId(app.id);
    res.json(endpoints);
  } catch (err) {
    logger.error('Failed to list endpoints', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add endpoint
router.post('/:id/endpoints', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const { service, domain, port } = req.body;
    if (!service || !domain) {
      return res.status(400).json({ error: 'service and domain are required' });
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }
    if (port !== undefined && port !== null && (port < 1 || port > 65535)) {
      return res.status(400).json({ error: 'port must be between 1 and 65535' });
    }

    // Prevent adding an endpoint for the primary service (it already has a domain on the apps table)
    const dep = await Deployments.findLastSuccessful(app.id, -1);
    if (dep) {
      const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${dep.id}`);
      const bhConfig = readBeachheadConfig(deployDir);
      const primaryService = bhConfig?.public_service || app.public_service;
      if (primaryService && service === primaryService) {
        return res.status(400).json({ error: `"${service}" is the primary service — update its domain on the app instead` });
      }
    }

    // Check domain uniqueness across apps, endpoints, and static sites
    const existingApp = await Apps.findByDomain(domain);
    if (existingApp) {
      return res.status(409).json({ error: `Domain already used by app "${existingApp.name}"` });
    }
    const existingEndpoint = await AppEndpoints.findByDomain(domain);
    if (existingEndpoint) {
      return res.status(409).json({ error: 'Domain already used by another endpoint' });
    }
    const existingStatic = await StaticSites.findByDomain(domain);
    if (existingStatic) {
      return res.status(409).json({ error: `Domain already used by static site "${existingStatic.name}"` });
    }

    const endpoint = await AppEndpoints.create({ app_id: app.id, service, domain, port });
    logger.info(`Endpoint added for ${app.name}: ${service} -> ${domain}`);

    // Regenerate override so the new endpoint is included on next deploy.
    // If there's a running deployment, update it live.
    const result = await regenerateOverride(app);
    if (result) {
      try {
        await dockerComposeRecreate(result.deployDir, 'beachhead.override.yml', service);
      } catch (err) {
        logger.warn(`Could not live-update endpoint container: ${err.message}`);
      }
    }

    res.status(201).json(endpoint);
  } catch (err) {
    if (err.message?.includes('idx_app_endpoints_app_service')) {
      return res.status(409).json({ error: 'This service already has an endpoint for this app' });
    }
    logger.error('Failed to add endpoint', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete endpoint
router.delete('/:id/endpoints/:endpointId', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const endpoint = await AppEndpoints.findById(req.params.endpointId);
    if (!endpoint || endpoint.app_id !== app.id) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    await AppEndpoints.delete(endpoint.id);
    logger.info(`Endpoint removed for ${app.name}: ${endpoint.service} -> ${endpoint.domain}`);

    // Regenerate override to remove the endpoint
    await regenerateOverride(app);

    res.json({ message: 'Endpoint deleted' });
  } catch (err) {
    logger.error('Failed to delete endpoint', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enable www redirect for an additional endpoint
router.post('/:id/endpoints/:endpointId/www', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const endpoint = await AppEndpoints.findById(req.params.endpointId);
    if (!endpoint || endpoint.app_id !== app.id) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
    if (!SAFE_HOSTNAME.test(endpoint.domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    await AppEndpoints.update(endpoint.id, { www_redirect: true });
    endpoint.www_redirect = true;

    const result = await regenerateOverride(app);
    if (!result) {
      return res.status(400).json({ error: 'No successful deployment found' });
    }

    // Write vhost.d redirect config
    const vhostdDir = '/etc/nginx/vhost.d';
    const locationFile = path.join(vhostdDir, `www.${endpoint.domain}_location`);
    fs.writeFileSync(locationFile, `return 301 https://${endpoint.domain}$request_uri;\n`, 'utf8');

    // Restart the endpoint's service container
    try {
      await dockerComposeRecreate(result.deployDir, 'beachhead.override.yml', endpoint.service);
    } catch (err) {
      logger.warn(`Could not restart endpoint container: ${err.message}`);
    }

    logger.info(`WWW redirect enabled for endpoint ${endpoint.service} -> ${endpoint.domain}`);
    res.json({ message: `WWW enabled for www.${endpoint.domain}` });
  } catch (err) {
    logger.error('Failed to enable www for endpoint', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
