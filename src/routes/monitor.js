const { Router } = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const Settings = require('../models/settings');
const Monitor = require('../models/monitor');
const monitor = require('../services/monitor');
const { getRules, saveOverrides, DEFAULT_RULES } = require('../services/monitor/rules');
const notify = require('../services/monitor/notify');
const logger = require('../logger');

/**
 * /api/system/monitor — health, metrics and alerts for this instance.
 *
 * Mounted ahead of /api/system in server.js. Admin-only like the rest of the
 * system routes; Cabana will authenticate with a long-lived token from
 * Settings → Users → "worker token" until it gets scoped machine tokens.
 */

const router = Router();
router.use(requireAuth, requireSuperAdmin);

const MASK = '••••••••';
const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const SERIES_FIELDS = {
  host: ['usedPct', 'swapUsedPct', 'cpuPct', 'loadPerCore'],
  disk: ['usedPct', 'usedBytes', 'freeBytes'],
  container: ['cpuPct', 'cpuPctOfHost', 'memBytes', 'memPct', 'memLimitBytes', 'pids'],
};

// GET /health — summary. Stable shape; Cabana depends on it.
router.get('/health', async (req, res) => {
  try {
    res.json(await monitor.buildHealth());
  } catch (err) {
    logger.error('Monitor health failed', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /snapshot — everything the collector last saw (dashboard Health page).
router.get('/snapshot', async (req, res) => {
  try {
    const health = await monitor.buildHealth();
    const s = monitor.collector.getSnapshot();
    res.json({ ...health, detail: s });
  } catch (err) {
    logger.error('Monitor snapshot failed', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /metrics?kind=host|disk|container&subject=host&range=6h
router.get('/metrics', async (req, res) => {
  const kind = String(req.query.kind || 'host');
  const subject = String(req.query.subject || (kind === 'host' ? 'host' : ''));
  const range = RANGES[req.query.range] ? req.query.range : '6h';
  if (!SERIES_FIELDS[kind]) return res.status(400).json({ error: `kind must be one of ${Object.keys(SERIES_FIELDS).join(', ')}` });
  if (!subject) return res.status(400).json({ error: 'subject is required' });
  try {
    const points = await Monitor.series({ kind, subject, sinceMs: RANGES[range], fields: SERIES_FIELDS[kind] });
    res.json({ kind, subject, range, fields: SERIES_FIELDS[kind], points });
  } catch (err) {
    logger.error('Monitor metrics failed', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /alerts?status=open|resolved|all&limit=100
router.get('/alerts', async (req, res) => {
  try {
    res.json(await Monitor.listAlerts({ status: req.query.status, limit: req.query.limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /alerts/:id/resolve — dismiss by hand. If the condition is still
// true it will reopen on the next evaluation, which is the point.
router.post('/alerts/:id/resolve', async (req, res) => {
  try {
    const row = await monitor.alerts.resolveById(req.params.id, req.user?.username || 'manual');
    if (!row) return res.status(404).json({ error: 'No open alert with that id' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /run — run a collector tick now (Refresh button).
router.post('/run', async (req, res) => {
  try {
    await monitor.collector.tick();
    res.json(await monitor.buildHealth());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /config — thresholds, email and heartbeat settings.
router.get('/config', async (req, res) => {
  try {
    const s = await Settings.getAll();
    res.json({
      instanceName: s.instance_name || '',
      instanceId: s.instance_id || null,
      rules: await getRules(),
      defaults: DEFAULT_RULES,
      email: {
        enabled: s.monitor_email_enabled === 'true',
        to: s.monitor_email_to || '',
        from: s.monitor_email_from || '',
        apiKey: s.resend_api_key ? MASK : '',
        minSeverity: s.monitor_email_min_severity || 'warning',
        envFallback: {
          apiKey: Boolean(process.env.RESEND_API_KEY),
          to: Boolean(process.env.ALERT_EMAIL_TO),
          from: Boolean(process.env.ALERT_EMAIL_FROM),
        },
      },
      heartbeatUrl: s.monitor_heartbeat_url || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /config — any subset of { instanceName, rules, email, heartbeatUrl }.
router.put('/config', async (req, res) => {
  const body = req.body || {};
  try {
    if ('instanceName' in body) {
      const v = String(body.instanceName || '').trim();
      if (v.length > 80) return res.status(400).json({ error: 'instanceName must be 80 characters or fewer' });
      await Settings.set('instance_name', v);
    }
    if (body.rules) await saveOverrides(body.rules);
    if (body.email) {
      const e = body.email;
      if ('enabled' in e) await Settings.set('monitor_email_enabled', e.enabled ? 'true' : 'false');
      if ('to' in e) {
        const list = String(e.to || '').split(',').map((x) => x.trim()).filter(Boolean);
        const bad = list.find((x) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x));
        if (bad) return res.status(400).json({ error: `Not an email address: ${bad}` });
        await Settings.set('monitor_email_to', list.join(', '));
      }
      if ('from' in e) {
        const v = String(e.from || '').trim();
        // Resend accepts "addr@x.com" or "Name <addr@x.com>"; the domain must
        // be verified in Resend or sends will 403.
        if (v && !/^([^<>]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v)) return res.status(400).json({ error: 'from must look like alerts@example.com or "Beachhead <alerts@example.com>"' });
        await Settings.set('monitor_email_from', v);
      }
      if ('apiKey' in e && e.apiKey !== MASK) await Settings.set('resend_api_key', String(e.apiKey || '').trim());
      if ('minSeverity' in e) {
        if (!['warning', 'critical'].includes(e.minSeverity)) return res.status(400).json({ error: 'minSeverity must be "warning" or "critical"' });
        await Settings.set('monitor_email_min_severity', e.minSeverity);
      }
    }
    if ('heartbeatUrl' in body) {
      const v = String(body.heartbeatUrl || '').trim();
      if (v && !/^https:\/\/\S+$/.test(v)) return res.status(400).json({ error: 'heartbeatUrl must be an https:// URL' });
      await Settings.set('monitor_heartbeat_url', v);
    }
    logger.info(`Monitor config updated by ${req.user?.username || 'bootstrap'}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /test-email — send a test through the saved settings.
router.post('/test-email', async (req, res) => {
  try {
    await notify.sendTest();
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
