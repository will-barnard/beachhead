const { Router } = require('express');
const EnvVars = require('../models/envVars');
const Apps = require('../models/apps');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const logger = require('../logger');

const router = Router();

router.use(requireAuth, requireSuperAdmin);

// Get env vars for an app
router.get('/:appId/env', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.appId);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const vars = await EnvVars.getByAppId(app.id);
    res.json(vars);
  } catch (err) {
    logger.error('Failed to get env vars', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set env var
router.post('/:appId/env', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.appId);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const { key, value, target_service } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key and value are required' });
    }

    const envVar = await EnvVars.set({
      app_id: app.id,
      key,
      value,
      target_service,
    });

    logger.info(`Env var set for ${app.name}: ${key}`);
    res.status(201).json(envVar);
  } catch (err) {
    logger.error('Failed to set env var', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete env var
router.delete('/:appId/env/:envId', async (req, res) => {
  try {
    const envVar = await EnvVars.delete(req.params.envId);
    if (!envVar) return res.status(404).json({ error: 'Env var not found' });

    logger.info(`Env var deleted: ${envVar.key}`);
    res.json({ message: 'Env var deleted', envVar });
  } catch (err) {
    logger.error('Failed to delete env var', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
