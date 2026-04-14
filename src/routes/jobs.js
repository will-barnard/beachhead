const express = require('express');
const logger = require('../logger');
const BuildJobs = require('../models/buildJobs');
const Settings = require('../models/settings');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/jobs/next
 * Claim the next pending build job. Used by remote workers.
 * Requires auth (Bearer token).
 */
router.post('/next', requireAuth, async (req, res) => {
  try {
    const workerId = req.body.worker_id || req.user.username || 'unknown';
    const job = await BuildJobs.claimNext(workerId);

    if (!job) {
      return res.status(204).send();
    }

    // Include registry config so the worker knows where to push
    const registry = await Settings.getRegistryConfig();

    res.json({
      id: job.id,
      deployment_id: job.deployment_id,
      app_id: job.app_id,
      service: job.service,
      dockerfile: job.dockerfile,
      build_context: job.build_context,
      image_tag: job.image_tag,
      repo_url: job.repo_url,
      branch: job.branch,
      registry: {
        url: registry.url,
        user: registry.user,
        password: registry.password,
      },
    });
  } catch (err) {
    logger.error(`Failed to claim build job: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/jobs/:id/status
 * Update build job state + append logs. Used by remote workers mid-build.
 */
router.post('/:id/status', requireAuth, async (req, res) => {
  const { state, log } = req.body;
  const id = parseInt(req.params.id, 10);

  const allowed = [BuildJobs.STATES.BUILDING, BuildJobs.STATES.PUSHING];
  if (!allowed.includes(state)) {
    return res.status(400).json({ error: `Invalid state: ${state}` });
  }

  try {
    const job = await BuildJobs.updateState(id, state, log);
    if (!job) return res.status(404).json({ error: 'Build job not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error(`Failed to update build job ${id}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/jobs/:id/complete
 * Mark a build job as SUCCESS or FAILED. Used by remote workers.
 */
router.post('/:id/complete', requireAuth, async (req, res) => {
  const { success, log } = req.body;
  const id = parseInt(req.params.id, 10);
  const state = success ? BuildJobs.STATES.SUCCESS : BuildJobs.STATES.FAILED;

  try {
    const job = await BuildJobs.updateState(id, state, log);
    if (!job) return res.status(404).json({ error: 'Build job not found' });
    logger.info(`Build job #${id} completed: ${state}`);
    res.json({ ok: true, state });
  } catch (err) {
    logger.error(`Failed to complete build job ${id}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/jobs
 * List recent build jobs (admin only, for dashboard visibility).
 */
router.get('/', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const db = require('../db');
    const { rows } = await db.query(
      'SELECT * FROM build_jobs ORDER BY created_at DESC LIMIT 50',
    );
    res.json(rows);
  } catch (err) {
    logger.error('Failed to list build jobs', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
