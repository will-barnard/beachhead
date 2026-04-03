const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { execFile } = require('child_process');
const StaticSites = require('../models/staticSites');
const Apps = require('../models/apps');
const AppEndpoints = require('../models/appEndpoints');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { exec } = require('../services/docker');
const config = require('../config');
const logger = require('../logger');

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// ── Helpers ──

const STATIC_BASE = path.join(config.deploy.baseDir, 'static-sites');

function siteDir(siteId) {
  return path.join(STATIC_BASE, `site-${siteId}`);
}

function webRoot(siteId) {
  return path.join(siteDir(siteId), 'public');
}

function containerName(siteId) {
  return `static-site-${siteId}`;
}

// 10 MB upload limit
const upload = multer({ dest: '/tmp/beachhead-uploads', limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Start (or restart) the nginx container for a static site.
 * Uses the shared beachhead-net so nginx-proxy picks it up.
 */
async function startContainer(site) {
  const name = containerName(site.id);
  const root = webRoot(site.id);
  const hosts = site.www_redirect ? `${site.domain},www.${site.domain}` : site.domain;

  // Stop existing container if running (ignore errors)
  try {
    await exec('docker', ['rm', '-f', name], { timeout: 15000 });
  } catch { /* container may not exist */ }

  const args = [
    'run', '-d',
    '--name', name,
    '--restart', 'unless-stopped',
    '--network', config.deploy.dockerNetwork,
    '-e', `VIRTUAL_HOST=${hosts}`,
    '-e', 'VIRTUAL_PORT=80',
    '-e', `LETSENCRYPT_HOST=${hosts}`,
    '-v', `${root}:/usr/share/nginx/html:ro`,
    'nginx:alpine',
  ];

  await exec('docker', args, { timeout: 30000 });
  logger.info(`Static site container started: ${name} for ${site.domain}`);
}

async function stopContainer(siteId) {
  try {
    await exec('docker', ['rm', '-f', containerName(siteId)], { timeout: 15000 });
  } catch { /* ok if not running */ }
}

/**
 * Unzip a .zip file into the web root.
 */
function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-o', zipPath, '-d', destDir], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`unzip failed: ${stderr || err.message}`));
      resolve();
    });
  });
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

// Create static site (metadata only)
router.post('/', async (req, res) => {
  try {
    const { name, domain } = req.body;
    if (!name || !domain) {
      return res.status(400).json({ error: 'name and domain are required' });
    }

    // Check uniqueness across apps, app endpoints, and static sites
    const existingApp = await Apps.findByDomain(domain);
    if (existingApp) {
      return res.status(409).json({ error: `Domain already used by app "${existingApp.name}"` });
    }
    const existingEndpoint = await AppEndpoints.findByDomain(domain);
    if (existingEndpoint) {
      return res.status(409).json({ error: 'Domain already used by an app endpoint' });
    }
    const existingSite = await StaticSites.findByDomain(domain);
    if (existingSite) {
      return res.status(409).json({ error: `Domain already used by static site "${existingSite.name}"` });
    }

    const site = await StaticSites.create({ name, domain });

    // Create web root with a placeholder
    const root = webRoot(site.id);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'index.html'),
      `<!DOCTYPE html><html><head><title>${site.name}</title></head><body><h1>${site.name}</h1><p>Upload files to deploy this site.</p></body></html>`,
      'utf8'
    );

    logger.info(`Static site created: ${site.name} (${site.domain})`);
    res.status(201).json(site);
  } catch (err) {
    logger.error('Failed to create static site', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload files (index.html or .zip) and deploy
router.post('/:id/upload', upload.single('file'), async (req, res) => {
  let tmpPath = null;
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    tmpPath = req.file.path;
    const originalName = req.file.originalname || '';
    const root = webRoot(site.id);

    // Clear existing files
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    fs.mkdirSync(root, { recursive: true });

    if (originalName.endsWith('.zip')) {
      // Extract zip into web root
      await unzip(tmpPath, root);

      // If the zip contained a single top-level directory, hoist its contents
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
      // Single file — treat as index.html
      fs.copyFileSync(tmpPath, path.join(root, 'index.html'));
    }

    // Clean up temp file
    fs.unlinkSync(tmpPath);
    tmpPath = null;

    // Start or restart the container
    await startContainer(site);
    await StaticSites.update(site.id, { name: site.name }); // touch updated_at

    logger.info(`Static site deployed: ${site.name} (${site.domain})`);
    res.json({ message: `Site deployed to ${site.domain}` });
  } catch (err) {
    // Clean up temp file on error
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    logger.error('Failed to upload static site', err);
    res.status(500).json({ error: err.message });
  }
});

// Deploy (start/restart container for already-uploaded files)
router.post('/:id/deploy', async (req, res) => {
  try {
    const site = await StaticSites.findById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });

    const root = webRoot(site.id);
    if (!fs.existsSync(path.join(root, 'index.html'))) {
      return res.status(400).json({ error: 'No files uploaded yet — upload files first' });
    }

    await startContainer(site);
    res.json({ message: `Container started for ${site.domain}` });
  } catch (err) {
    logger.error('Failed to deploy static site', err);
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

    // Write vhost.d redirect config
    const vhostdDir = '/etc/nginx/vhost.d';
    const locationFile = path.join(vhostdDir, `www.${site.domain}_location`);
    fs.writeFileSync(locationFile, `return 301 https://${site.domain}$request_uri;\n`, 'utf8');

    // Restart container with updated hosts
    await startContainer(site);

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

    await stopContainer(site.id);

    // Remove files
    const dir = siteDir(site.id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    await StaticSites.delete(site.id);
    logger.info(`Static site deleted: ${site.name}`);
    res.json({ message: 'Static site deleted' });
  } catch (err) {
    logger.error('Failed to delete static site', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
