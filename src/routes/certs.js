const { Router } = require('express');
const StandaloneCerts = require('../models/standaloneCerts');
const certs = require('../services/certs');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const logger = require('../logger');

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// A single DNS hostname (lowercase). No scheme, no port, no wildcard.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Normalise the domains input (array or comma/space separated string). */
function parseDomains(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(/[\s,]+/);
  return [...new Set(list.map(d => String(d || '').trim().toLowerCase()).filter(Boolean))];
}

/**
 * GET /api/certs
 * List standalone certs with their issue/expiry status.
 */
router.get('/', async (req, res) => {
  try {
    const rows = await StandaloneCerts.findAll();
    res.json(rows.map(certs.withStatus));
  } catch (err) {
    logger.error('Failed to list standalone certs', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/certs
 * Body: { name?, domains: string[] | "a.com, b.com" }
 * Creates a standalone cert definition and asks acme-companion to issue it.
 */
router.post('/', async (req, res) => {
  try {
    const domains = parseDomains(req.body?.domains);
    const name = req.body?.name ? String(req.body.name).trim() : null;

    if (domains.length === 0) {
      return res.status(400).json({ error: 'At least one domain is required' });
    }
    if (domains.length > 100) {
      return res.status(400).json({ error: 'Too many domains for a single certificate (max 100)' });
    }
    const bad = domains.find(d => !HOSTNAME.test(d));
    if (bad) {
      return res.status(400).json({ error: `Invalid hostname: "${bad}" (use a bare domain like nas.example.com)` });
    }

    // Warn on domains already covered by another standalone cert.
    const existing = await StandaloneCerts.findAll();
    const clash = existing.find(c => (c.domains || []).some(d => domains.includes(d)));
    if (clash) {
      return res.status(409).json({ error: `A standalone cert already covers one of those domains (cert #${clash.id})` });
    }

    const cert = await StandaloneCerts.create({ name, domains });
    logger.info(`Standalone cert #${cert.id} created for ${domains.join(', ')}`);

    // Rewrite acme-companion's user-data file and trigger issuance now.
    await certs.sync();

    res.status(201).json(certs.withStatus(cert));
  } catch (err) {
    logger.error('Failed to create standalone cert', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/certs/:id/refresh
 * Re-signal acme-companion to run its service loop (issue/renew) immediately.
 */
router.post('/:id/refresh', async (req, res) => {
  try {
    const cert = await StandaloneCerts.findById(req.params.id);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    const signalled = await certs.sync();
    res.json({ message: signalled ? 'Renewal check triggered' : 'Queued — acme-companion will pick it up within the hour', cert: certs.withStatus(cert) });
  } catch (err) {
    logger.error('Failed to refresh standalone cert', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/certs/:id/download/:type
 * Download an issued cert file. type ∈ fullchain | key | chain | cert.
 */
router.get('/:id/download/:type', async (req, res) => {
  try {
    const cert = await StandaloneCerts.findById(req.params.id);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });

    const type = req.params.type;
    if (!Object.prototype.hasOwnProperty.call(certs.DOWNLOADABLE, type)) {
      return res.status(400).json({ error: `Unknown file type "${type}"` });
    }

    const file = certs.getDownload(cert, type);
    if (!file) {
      return res.status(404).json({ error: 'Certificate not issued yet — check back shortly after adding it' });
    }

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (err) {
    logger.error('Failed to download standalone cert', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/certs/:id
 * Remove the cert definition and update acme-companion's user-data file.
 * (The already-issued cert files remain in the certs volume until acme prunes them.)
 */
router.delete('/:id', async (req, res) => {
  try {
    const cert = await StandaloneCerts.findById(req.params.id);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });

    await StandaloneCerts.delete(cert.id);
    logger.info(`Standalone cert #${cert.id} deleted (${(cert.domains || []).join(', ')})`);
    await certs.sync();

    res.json({ message: 'Certificate removed' });
  } catch (err) {
    logger.error('Failed to delete standalone cert', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
