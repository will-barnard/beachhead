const { Router } = require('express');
const { EnvFiles } = require('../models/envFiles');
const Apps = require('../models/apps');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const logger = require('../logger');

const router = Router();

router.use(requireAuth, requireSuperAdmin);

// List env files (with their parsed vars) for an app
router.get('/:appId/env-files', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.appId);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const files = await EnvFiles.getByAppId(app.id);
    res.json(files);
  } catch (err) {
    logger.error('Failed to get env files', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create or update an env file by path — post path + raw content
router.post('/:appId/env-files', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.appId);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const { path, content } = req.body;
    if (!path || content === undefined) {
      return res.status(400).json({ error: 'path and content are required' });
    }

    // Prevent path traversal
    if (path.includes('..') || path.startsWith('/')) {
      return res.status(400).json({ error: 'path must be relative and cannot contain ..' });
    }

    const file = await EnvFiles.create({ app_id: app.id, path });
    await EnvFiles.saveContent({ fileId: file.id, rawContent: content });
    const saved = await EnvFiles.getByAppId(app.id);

    logger.info(`Env file saved for ${app.name}: ${path}`);
    res.status(201).json(saved.find((f) => f.id === file.id));
  } catch (err) {
    logger.error('Failed to save env file', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete an env file (vars cascade)
router.delete('/:appId/env-files/:fileId', async (req, res) => {
  try {
    const file = await EnvFiles.delete(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'Env file not found' });

    logger.info(`Env file deleted: ${file.path}`);
    res.json({ message: 'Env file deleted', file });
  } catch (err) {
    logger.error('Failed to delete env file', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
