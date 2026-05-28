const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');
const StaticSites = require('../models/staticSites');
const Apps = require('../models/apps');
const AppEndpoints = require('../models/appEndpoints');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const siteRuntime = require('../services/staticSites');
const logger = require('../logger');

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// 8 GB upload limit
const upload = multer({ dest: '/tmp/beachhead-uploads', limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

/**
 * Unzip a .zip file into the web root.
 */
function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', destDir]);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (err) => reject(new Error(`unzip failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`unzip failed: ${stderr || `exited with code ${code}`}`));
      resolve();
    });
  });
}

// Match Apps.routes#create — accept HTTPS or SSH git URLs, normalise away the
// .git suffix and trailing slashes so webhook lookups are deterministic.
function normaliseRepoUrl(repoUrl) {
  return repoUrl.replace(/\.git$/, '').replace(/\/+$/, '');
}
function isValidRepoUrl(repoUrl) {
  return /^https?:\/\/.+/.test(repoUrl) || /^git@[^:]+:.+\/.+/.test(repoUrl);
}

async function assertDomainAvailable(domain, ignoreSiteId = null) {
  const existingApp = await Apps.findByDomain(domain);
  if (existingApp) return `Domain already used by app "${existingApp.name}"`;
  const existingEndpoint = await AppEndpoints.findByDomain(domain);
  if (existingEndpoint) return 'Domain already used by an app endpoint';
  const existingSite = await StaticSites.findByDomain(domain);
  if (existingSite && existingSite.id !== ignoreSiteId) {
    return `Domain already used by static site "${existingSite.name}"`;
  }
  return null;
}

// ── Routes ──

// List static sites
router.get('/', async (req, res) => {
  try {
    const sites = await StaticSites.findAll();
    res.json(sites);
  } catch (err) {
    logger.error('Failed to list static sites', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single site
router.get('/:id', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });
    res.json(site);
  } catch (err) {
    logger.error('Failed to get static site', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Last deploy log (for git-backed sites). Cheap — single column read.
router.get('/:id/logs', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });
    res.json({
      state: site.last_deploy_state,
      at: site.last_deploy_at,
      commit: site.last_commit_hash,
      log: site.last_deploy_log || '',
    });
  } catch (err) {
    logger.error('Failed to get static site logs', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Create a static site.
 *
 * Accepts two source modes:
 *   { source_type: 'upload' (default), name, domain }
 *   { source_type: 'git',     name, domain, repo_url, branch?, subpath?,
 *                              build_command?, build_image?, webhook_secret?,
 *                              auto_deploy? }
 *
 * For git mode this only registers the site — content arrives on the first
 * POST /:id/deploy-from-git or via the matching GitHub webhook.
 */
router.post('/', async (req, res) => {
  try {
    const {
      name, domain,
      source_type, repo_url, branch, subpath, build_command, build_image,
      webhook_secret, auto_deploy,
    } = req.body;

    if (!name || !domain) {
      return res.status(400).json({ error: 'name and domain are required' });
    }
    const mode = source_type === 'git' ? 'git' : 'upload';

    if (mode === 'git') {
      if (!repo_url) return res.status(400).json({ error: 'repo_url is required for git mode' });
      if (!isValidRepoUrl(repo_url)) {
        return res.status(400).json({ error: 'repo_url must be an HTTPS URL or SSH git URL (git@host:org/repo)' });
      }
    }

    const conflict = await assertDomainAvailable(domain);
    if (conflict) return res.status(409).json({ error: conflict });

    const site = await StaticSites.create({
      name,
      domain,
      source_type: mode,
      repo_url: mode === 'git' ? normaliseRepoUrl(repo_url) : null,
      branch: mode === 'git' ? (branch || 'main') : null,
      subpath: mode === 'git' ? (subpath || '.') : null,
      build_command: mode === 'git' ? (build_command || null) : null,
      build_image: mode === 'git' ? (build_image || 'node:20-alpine') : null,
      webhook_secret: mode === 'git' ? (webhook_secret || null) : null,
      auto_deploy: mode === 'git' ? (auto_deploy !== false) : null,
    });

    // Seed a placeholder web root so an upload-mode site has something to
    // serve before its first upload, and so a git-mode site has a "build
    // pending" page until its first deploy lands.
    const root = siteRuntime.webRoot(site.id);
    fs.mkdirSync(root, { recursive: true });
    const message = mode === 'git'
      ? `<p>Awaiting first deploy from <code>${site.repo_url}</code> (${site.branch}).</p>`
      : `<p>Upload files to deploy this site.</p>`;
    fs.writeFileSync(
      path.join(root, 'index.html'),
      `<!DOCTYPE html><html><head><title>${site.name}</title></head><body><h1>${site.name}</h1>${message}</body></html>`,
      'utf8'
    );

    logger.info(`Static site created: ${site.name} (${site.domain}) [source=${mode}]`);
    res.status(201).json(site);
  } catch (err) {
    logger.error('Failed to create static site', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Update site settings. Accepts the writable subset (see model). Domain is
 * uniqueness-checked. source_type cannot be changed in place — that would
 * require destroying state from the prior mode.
 */
router.put('/:id', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });

    const {
      name, domain, www_redirect,
      repo_url, branch, subpath, build_command, build_image,
      webhook_secret, auto_deploy,
    } = req.body;

    if (req.body.source_type && req.body.source_type !== site.source_type) {
      return res.status(400).json({ error: 'source_type cannot be changed; delete and recreate the site' });
    }

    if (domain && domain !== site.domain) {
      const conflict = await assertDomainAvailable(domain, site.id);
      if (conflict) return res.status(409).json({ error: conflict });
    }
    if (repo_url !== undefined && repo_url !== null && !isValidRepoUrl(repo_url)) {
      return res.status(400).json({ error: 'repo_url must be an HTTPS URL or SSH git URL' });
    }

    const updated = await StaticSites.update(site.id, {
      name, domain, www_redirect,
      repo_url: repo_url ? normaliseRepoUrl(repo_url) : repo_url,
      branch, subpath, build_command, build_image,
      webhook_secret, auto_deploy,
    });

    // If domain changed, the running container's VIRTUAL_HOST needs refreshing.
    if (domain && domain !== site.domain) {
      try { await siteRuntime.startContainer(updated); } catch (e) {
        logger.warn(`Domain updated but container restart failed: ${e.message}`);
      }
    }

    res.json(updated);
  } catch (err) {
    logger.error('Failed to update static site', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload files (index.html or .zip) and deploy. Upload-mode sites only —
// uploading to a git-mode site is rejected so it can't get out of sync with
// the git source of truth.
router.post('/:id/upload', upload.single('file'), async (req, res) => {
  let tmpPath = null;
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });
    if (site.source_type === 'git') {
      return res.status(409).json({ error: 'This site is git-backed — use POST /:id/deploy-from-git instead' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    tmpPath = req.file.path;
    const originalName = req.file.originalname || '';
    const root = siteRuntime.webRoot(site.id);

    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    fs.mkdirSync(root, { recursive: true });

    if (originalName.endsWith('.zip')) {
      await unzip(tmpPath, root);
      const entries = fs.readdirSync(root);
      if (entries.length === 1) {
        const inner = path.join(root, entries[0]);
        if (fs.statSync(inner).isDirectory()) {
          for (const f of fs.readdirSync(inner)) {
            fs.renameSync(path.join(inner, f), path.join(root, f));
          }
          fs.rmdirSync(inner);
        }
      }
    } else {
      fs.copyFileSync(tmpPath, path.join(root, 'index.html'));
    }

    fs.unlinkSync(tmpPath);
    tmpPath = null;

    await siteRuntime.startContainer(site);
    await StaticSites.update(site.id, { name: site.name }); // touch updated_at

    logger.info(`Static site deployed: ${site.name} (${site.domain})`);
    res.json({ message: `Site deployed to ${site.domain}` });
  } catch (err) {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    logger.error('Failed to upload static site', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger a git deploy synchronously. Returns 200 with the final state on
 * success, 500 with the truncated log on failure. Coalesces with any other
 * in-flight deploy for the same site so two presses of the button just
 * subscribe to the same run.
 *
 * This is the manual counterpart to the webhook path. The webhook handler
 * fires-and-forgets; here we wait so the dashboard can show success/fail
 * in the same request cycle.
 */
router.post('/:id/deploy-from-git', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });
    if (site.source_type !== 'git') {
      return res.status(409).json({ error: 'This site is upload-backed; use POST /:id/upload' });
    }

    await siteRuntime.deployFromGit(site, { trigger: 'manual' });
    const refreshed = await StaticSites.findById(site.id);
    res.json({
      message: `Deploy succeeded for ${site.domain}`,
      state: refreshed.last_deploy_state,
      commit: refreshed.last_commit_hash,
    });
  } catch (err) {
    logger.error('Static git deploy failed', err);
    // Pull the persisted log tail so the client sees what happened
    const refreshed = await StaticSites.findById(req.params.id).catch(() => null);
    res.status(500).json({
      error: err.message,
      log: refreshed?.last_deploy_log || null,
    });
  }
});

// Restart the container without changing files. For upload mode this is "kick
// nginx"; for git mode use POST /:id/deploy-from-git instead (this just
// re-attaches whatever's already in webRoot).
router.post('/:id/deploy', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });

    const root = siteRuntime.webRoot(site.id);
    if (!fs.existsSync(path.join(root, 'index.html'))) {
      return res.status(400).json({ error: 'No files deployed yet' });
    }
    await siteRuntime.startContainer(site);
    res.json({ message: `Container started for ${site.domain}` });
  } catch (err) {
    logger.error('Failed to restart static site', err);
    res.status(500).json({ error: err.message });
  }
});

// Enable www redirect
router.post('/:id/www', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });

    await StaticSites.update(site.id, { www_redirect: true });
    site.www_redirect = true;

    const vhostdDir = '/etc/nginx/vhost.d';
    const locationFile = path.join(vhostdDir, `www.${site.domain}_location`);
    fs.writeFileSync(locationFile, `return 301 https://${site.domain}$request_uri;\n`, 'utf8');

    await siteRuntime.startContainer(site);

    logger.info(`WWW redirect enabled for static site ${site.name} (${site.domain})`);
    res.json({ message: `WWW enabled — cert request and redirect configured for www.${site.domain}` });
  } catch (err) {
    logger.error('Failed to enable www for static site', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete site
router.delete('/:id', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });

    await siteRuntime.stopContainer(site.id);

    const dir = siteRuntime.siteDir(site.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    await StaticSites.delete(site.id);
    logger.info(`Static site deleted: ${site.name}`);
    res.json({ message: 'Static site deleted' });
  } catch (err) {
    logger.error('Failed to delete static site', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
