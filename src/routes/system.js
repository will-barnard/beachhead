const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const Apps = require('../models/apps');
const Deployments = require('../models/deployments');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { exec, dockerComposeDown, stopComposeProject } = require('../services/docker');
const config = require('../config');
const logger = require('../logger');

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// ── Container Audit ──

/**
 * GET /api/system/containers
 * List all Docker containers on the host with their state, image, compose project, etc.
 * Groups containers by their likely owner (app, static site, beachhead infra, or unknown).
 */
router.get('/containers', async (req, res) => {
  try {
    const format = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.Labels}}';
    const { stdout } = await exec('docker', ['ps', '-a', '--format', format], { timeout: 15000 });
    const lines = stdout.trim().split('\n').filter(Boolean);

    const containers = lines.map(line => {
      const [id, name, image, status, state, labelsRaw] = line.split('\t');
      const labels = {};
      if (labelsRaw) {
        for (const pair of labelsRaw.split(',')) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) labels[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
      const project = labels['com.docker.compose.project'] || null;
      const service = labels['com.docker.compose.service'] || null;
      return { id: id.slice(0, 12), name, image, status, state, project, service };
    });

    // Load apps to map projects to app names
    const apps = await Apps.findAll();
    const appMap = new Map();
    const slugToApp = new Map();
    for (const app of apps) {
      appMap.set(app.id, app);
      const slug = (app.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
      slugToApp.set(slug, app);
    }

    // Classify each container
    const classified = containers.map(c => {
      let owner = 'unknown';
      let ownerDetail = null;

      if (c.name === 'beachhead' || c.project === 'beachhead') {
        owner = 'beachhead';
      } else if (c.project && /^deploy-\d+$/.test(c.project)) {
        const deployId = parseInt(c.project.replace('deploy-', ''), 10);
        owner = 'app-deploy';
        ownerDetail = `deploy-${deployId}`;
      } else if (c.name && c.name.startsWith('static-site-')) {
        owner = 'static-site';
        ownerDetail = c.name;
      } else if (c.project && c.project.endsWith('-stateful')) {
        owner = 'stateful';
        ownerDetail = c.project;
      } else if (c.name && /nginx-proxy|acme-companion/.test(c.name)) {
        owner = 'beachhead';
      }

      return { ...c, owner, ownerDetail };
    });

    // Batch-resolve deployId → appId for app-deploy containers
    const deployIds = classified
      .filter(c => c.owner === 'app-deploy')
      .map(c => parseInt(c.project?.replace('deploy-', ''), 10))
      .filter(id => !isNaN(id));
    const deployRows = await Deployments.findAppIdsByIds(deployIds);
    const deployIdToAppId = new Map(deployRows.map(r => [r.id, r.app_id]));

    // Enrich each container with appId + appName so the UI can co-group
    // stateful containers with their associated deploy containers.
    const enriched = classified.map(c => {
      if (c.owner === 'app-deploy') {
        const deployId = parseInt(c.project?.replace('deploy-', ''), 10);
        const appId = deployIdToAppId.get(deployId) ?? null;
        const app = appId ? appMap.get(appId) : null;
        return { ...c, appId, appName: app?.name ?? null };
      }
      if (c.owner === 'stateful') {
        const slug = c.ownerDetail?.replace(/-stateful$/, '') ?? null;
        const app = slug ? slugToApp.get(slug) : null;
        return { ...c, appId: app?.id ?? null, appName: app?.name ?? null };
      }
      return c;
    });

    res.json(enriched);
  } catch (err) {
    logger.error('Failed to list containers', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/system/containers/:id/stop
 * Stop a specific container by ID.
 */
router.post('/containers/:id/stop', async (req, res) => {
  try {
    const containerId = req.params.id;
    // Validate: must be hex, 12 chars (short ID)
    if (!/^[a-f0-9]{12}$/.test(containerId)) {
      return res.status(400).json({ error: 'Invalid container ID format' });
    }
    await exec('docker', ['stop', containerId], { timeout: 30000 });
    logger.info(`Container ${containerId} stopped via dashboard`);
    res.json({ message: `Container ${containerId} stopped` });
  } catch (err) {
    logger.error(`Failed to stop container ${req.params.id}`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/system/containers/:id/remove
 * Stop and remove a specific container by ID.
 */
router.post('/containers/:id/remove', async (req, res) => {
  try {
    const containerId = req.params.id;
    if (!/^[a-f0-9]{12}$/.test(containerId)) {
      return res.status(400).json({ error: 'Invalid container ID format' });
    }
    await exec('docker', ['rm', '-f', containerId], { timeout: 30000 });
    logger.info(`Container ${containerId} removed via dashboard`);
    res.json({ message: `Container ${containerId} removed` });
  } catch (err) {
    logger.error(`Failed to remove container ${req.params.id}`, err);
    res.status(500).json({ error: err.message });
  }
});

// ── Pruning ──

/**
 * POST /api/system/prune
 * Prune old deployments across all apps. Keeps `keep` successful deploys per app
 * (default 3). Tears down any running containers for pruned deploys, deletes the
 * deploy directory, and removes the DB record.
 */
router.post('/prune', async (req, res) => {
  try {
    const keep = Math.max(1, parseInt(req.body.keep, 10) || 3);
    const apps = await Apps.findAll();
    let totalPruned = 0;
    const details = [];

    for (const app of apps) {
      const prunable = await Deployments.findPrunableByAppId(app.id, app.active_deployment_id, keep);
      if (prunable.length === 0) continue;

      for (const deployId of prunable) {
        const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${deployId}`);
        // Stop containers if running
        try {
          if (fs.existsSync(path.join(deployDir, 'beachhead.override.yml'))) {
            await dockerComposeDown(deployDir, 'beachhead.override.yml');
          } else {
            await stopComposeProject(`deploy-${deployId}`);
          }
        } catch {
          // best-effort — containers may already be stopped
        }
        // Remove deploy directory
        if (fs.existsSync(deployDir)) {
          fs.rmSync(deployDir, { recursive: true, force: true });
        }
      }

      await Deployments.deleteByIds(prunable);
      totalPruned += prunable.length;
      details.push({ app: app.name, pruned: prunable.length });
      logger.info(`Pruned ${prunable.length} old deployment(s) for ${app.name}`);
    }

    // Also prune dangling Docker images
    try {
      await exec('docker', ['image', 'prune', '-f'], { timeout: 60000 });
    } catch {
      // non-fatal
    }

    res.json({ totalPruned, keep, details });
  } catch (err) {
    logger.error('System prune failed', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/apps/:id/prune
 * Prune old deployments for a specific app.
 */
router.post('/apps/:id/prune', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const keep = Math.max(1, parseInt(req.body.keep, 10) || 3);
    const prunable = await Deployments.findPrunableByAppId(app.id, app.active_deployment_id, keep);

    if (prunable.length === 0) {
      return res.json({ pruned: 0, keep, message: 'Nothing to prune' });
    }

    for (const deployId of prunable) {
      const deployDir = path.join(config.deploy.baseDir, `app-${app.id}`, `deploy-${deployId}`);
      try {
        if (fs.existsSync(path.join(deployDir, 'beachhead.override.yml'))) {
          await dockerComposeDown(deployDir, 'beachhead.override.yml');
        } else {
          await stopComposeProject(`deploy-${deployId}`);
        }
      } catch {
        // best-effort
      }
      if (fs.existsSync(deployDir)) {
        fs.rmSync(deployDir, { recursive: true, force: true });
      }
    }

    await Deployments.deleteByIds(prunable);
    logger.info(`Pruned ${prunable.length} deployment(s) for ${app.name} (keeping ${keep})`);
    res.json({ pruned: prunable.length, keep });
  } catch (err) {
    logger.error(`Prune failed for app ${req.params.id}`, err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
