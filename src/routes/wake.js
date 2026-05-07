const { Router } = require('express');
const Apps = require('../models/apps');
const onDemand = require('../services/onDemand');
const logger = require('../logger');

/**
 * Public wake endpoint.
 *
 * Mounted at /api/wake/:id WITHOUT auth — the placeholder served on the
 * app's own domain calls this via a same-origin proxy (`/__bh_wake__`).
 *
 * The endpoint is naturally rate-limited:
 *   - the global apiLimiter on /api caps all callers at 300 req/min/IP
 *   - onDemand.autoWake is single-flight per app, so concurrent wake
 *     requests share one underlying start
 *
 * The endpoint blocks until the app is healthy and returns 200, so the
 * client-side wake page can simply reload on success.
 */

const router = Router();

router.post('/:id', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    if (!app.on_demand) return res.status(409).json({ error: 'App is not on-demand' });
    if (app.paused) return res.status(409).json({ error: 'App is manually paused' });
    if (!app.auto_paused) return res.json({ status: 'awake' });

    await onDemand.autoWake(app);
    res.json({ status: 'awake' });
  } catch (err) {
    logger.error(`Wake failed for app ${req.params.id}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

router.get('/:id/status', async (req, res) => {
  try {
    const app = await Apps.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    res.json({
      on_demand: !!app.on_demand,
      paused: !!app.paused,
      auto_paused: !!app.auto_paused,
      idle_timeout_seconds: app.idle_timeout_seconds || null,
      last_active_at: app.last_active_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
