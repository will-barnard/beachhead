const { Router } = require('express');
const ReverseProxyTargets = require('../models/reverseProxyTargets');
const Apps = require('../models/apps');
const AppEndpoints = require('../models/appEndpoints');
const StaticSites = require('../models/staticSites');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const runtime = require('../services/reverseProxyTargets');
const logger = require('../logger');

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// Same shape as apps.js / staticSites.js's domain validation.
const HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
// Target host: LAN IP or bare hostname (e.g. a Synology's mDNS name).
// Restricted charset since this string is written straight into an nginx
// server block, not just used as a fetch target.
const TARGET_HOST = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$/;

function parseDomains(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(/[\s,]+/);
  return [...new Set(list.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean))];
}

/** Check a domain against every other domain-owning feature (both directions
 * are enforced: apps.js/staticSites.js also check reverse proxy targets). */
async function assertDomainAvailable(domain, excludeId = null) {
  const existingApp = await Apps.findByDomain(domain);
  if (existingApp) return `Domain already used by app "${existingApp.name}"`;
  const existingEndpoint = await AppEndpoints.findByDomain(domain);
  if (existingEndpoint) return 'Domain already used by an app endpoint';
  const existingSite = await StaticSites.findByDomain(domain);
  if (existingSite) return `Domain already used by static site "${existingSite.name}"`;
  const existingTarget = await ReverseProxyTargets.findByDomain(domain, excludeId);
  if (existingTarget) return `Domain already used by reverse proxy target "${existingTarget.name || existingTarget.domains[0]}"`;
  return null;
}

function validatePort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// GET /api/reverse-proxy-targets — list
router.get('/', async (req, res) => {
  try {
    const targets = await ReverseProxyTargets.findAll();
    res.json(targets);
  } catch (err) {
    logger.error('Failed to list reverse proxy targets', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reverse-proxy-targets/:id
router.get('/:id', async (req, res) => {
  try {
    const target = await ReverseProxyTargets.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Reverse proxy target not found' });
    res.json(target);
  } catch (err) {
    logger.error('Failed to get reverse proxy target', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/reverse-proxy-targets
 * Body: { name?, domains: string[]|string, target_scheme?, target_host,
 *         target_port, websocket?, verify_tls? }
 */
router.post('/', async (req, res) => {
  try {
    const {
      name, domains: domainsInput,
      target_scheme = 'http', target_host, target_port,
      websocket = false, verify_tls = true,
    } = req.body || {};

    const domains = parseDomains(domainsInput);
    if (domains.length === 0) {
      return res.status(400).json({ error: 'At least one domain is required' });
    }
    const badDomain = domains.find((d) => !HOSTNAME.test(d));
    if (badDomain) {
      return res.status(400).json({ error: `Invalid hostname: "${badDomain}"` });
    }
    if (!['http', 'https'].includes(target_scheme)) {
      return res.status(400).json({ error: "target_scheme must be 'http' or 'https'" });
    }
    if (!target_host || !TARGET_HOST.test(String(target_host).trim())) {
      return res.status(400).json({ error: 'target_host must be a bare LAN IP or hostname (e.g. 192.168.1.50 or nas.local)' });
    }
    if (!validatePort(target_port)) {
      return res.status(400).json({ error: 'target_port must be between 1 and 65535' });
    }

    for (const domain of domains) {
      const conflict = await assertDomainAvailable(domain);
      if (conflict) return res.status(409).json({ error: conflict });
    }

    const target = await ReverseProxyTargets.create({
      name: name ? String(name).trim() : null,
      domains,
      target_scheme,
      target_host: String(target_host).trim(),
      target_port: Number(target_port),
      websocket: !!websocket,
      verify_tls: verify_tls !== false,
      enabled: true,
    });

    try {
      await runtime.startContainer(target);
    } catch (err) {
      logger.warn(`Reverse proxy target ${target.id} created but container failed to start: ${err.message}`);
      return res.status(201).json({ ...target, warning: `Saved, but the proxy container failed to start: ${err.message}` });
    }

    logger.info(`Reverse proxy target created: ${target.domains.join(', ')} → ${target.target_scheme}://${target.target_host}:${target.target_port}`);
    res.status(201).json(target);
  } catch (err) {
    logger.error('Failed to create reverse proxy target', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/reverse-proxy-targets/:id
 * Accepts the same fields as create. Restarts the sidecar so changes take
 * effect immediately (domain changes need a fresh VIRTUAL_HOST, target
 * changes need a fresh nginx.conf).
 */
router.put('/:id', async (req, res) => {
  try {
    const target = await ReverseProxyTargets.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Reverse proxy target not found' });

    const {
      name, domains: domainsInput,
      target_scheme, target_host, target_port,
      websocket, verify_tls,
    } = req.body || {};

    const fields = {};
    if (name !== undefined) fields.name = name ? String(name).trim() : null;

    if (domainsInput !== undefined) {
      const domains = parseDomains(domainsInput);
      if (domains.length === 0) {
        return res.status(400).json({ error: 'At least one domain is required' });
      }
      const badDomain = domains.find((d) => !HOSTNAME.test(d));
      if (badDomain) return res.status(400).json({ error: `Invalid hostname: "${badDomain}"` });
      for (const domain of domains) {
        const conflict = await assertDomainAvailable(domain, target.id);
        if (conflict) return res.status(409).json({ error: conflict });
      }
      fields.domains = domains;
    }

    if (target_scheme !== undefined) {
      if (!['http', 'https'].includes(target_scheme)) {
        return res.status(400).json({ error: "target_scheme must be 'http' or 'https'" });
      }
      fields.target_scheme = target_scheme;
    }
    if (target_host !== undefined) {
      if (!target_host || !TARGET_HOST.test(String(target_host).trim())) {
        return res.status(400).json({ error: 'target_host must be a bare LAN IP or hostname (e.g. 192.168.1.50 or nas.local)' });
      }
      fields.target_host = String(target_host).trim();
    }
    if (target_port !== undefined) {
      if (!validatePort(target_port)) {
        return res.status(400).json({ error: 'target_port must be between 1 and 65535' });
      }
      fields.target_port = Number(target_port);
    }
    if (websocket !== undefined) fields.websocket = !!websocket;
    if (verify_tls !== undefined) fields.verify_tls = !!verify_tls;

    const updated = await ReverseProxyTargets.update(target.id, fields);

    try {
      await runtime.apply(updated);
    } catch (err) {
      logger.warn(`Reverse proxy target ${updated.id} updated but container restart failed: ${err.message}`);
      return res.json({ ...updated, warning: `Saved, but the proxy container failed to restart: ${err.message}` });
    }

    res.json(updated);
  } catch (err) {
    logger.error('Failed to update reverse proxy target', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reverse-proxy-targets/:id/enable — toggle without deleting
router.post('/:id/enable', async (req, res) => {
  try {
    const target = await ReverseProxyTargets.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Reverse proxy target not found' });

    const enabled = req.body?.enabled !== false;
    const updated = await ReverseProxyTargets.update(target.id, { enabled });
    await runtime.apply(updated);

    res.json(updated);
  } catch (err) {
    logger.error('Failed to toggle reverse proxy target', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reverse-proxy-targets/:id/restart — re-run the sidecar without
// changing anything, e.g. after the target device came back up.
router.post('/:id/restart', async (req, res) => {
  try {
    const target = await ReverseProxyTargets.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Reverse proxy target not found' });
    if (!target.enabled) return res.status(409).json({ error: 'Target is disabled — enable it first' });

    await runtime.startContainer(target);
    res.json({ message: 'Restarted' });
  } catch (err) {
    logger.error('Failed to restart reverse proxy target', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reverse-proxy-targets/:id
router.delete('/:id', async (req, res) => {
  try {
    const target = await ReverseProxyTargets.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Reverse proxy target not found' });

    await runtime.stopContainer(target.id);
    runtime.removeConf(target.id);
    await ReverseProxyTargets.delete(target.id);

    logger.info(`Reverse proxy target deleted: ${target.domains.join(', ')}`);
    res.json({ message: 'Reverse proxy target removed' });
  } catch (err) {
    logger.error('Failed to delete reverse proxy target', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
