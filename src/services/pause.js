const fs = require('fs');
const path = require('path');
const { exec } = require('./docker');
const config = require('../config');
const logger = require('../logger');

/**
 * Per-app "pause placeholder" containers.
 *
 * When an app is paused, its actual deploy containers are stopped and we run
 * a tiny nginx:alpine in their place that handles the app's domain. This:
 *   - Lets nginx-proxy keep serving the domain (otherwise no vhost would exist).
 *   - Keeps the Let's Encrypt cert renewing through acme-companion.
 *   - Returns a 302 to a custom redirect URL, or a default maintenance page.
 *
 * The placeholder is named `beachhead-pause-{appId}` and is labeled so it can
 * be recognized for cleanup or audit.
 */

function pauseContainerName(appId) {
  return `beachhead-pause-${appId}`;
}

function pauseConfigPath(appId) {
  return path.join(config.deploy.baseDir, `app-${appId}`, 'pause-config.conf');
}

function escapeForNginxString(str) {
  // Inside nginx single-quoted strings, only backslash and single-quote need escaping.
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function generatePauseConfig(redirectUrl) {
  if (redirectUrl) {
    const escaped = escapeForNginxString(redirectUrl);
    return `server {
  listen 80 default_server;
  server_name _;
  location / {
    return 302 '${escaped}';
  }
}
`;
  }
  return `server {
  listen 80 default_server;
  server_name _;
  location / {
    default_type text/html;
    return 503 '<!doctype html><html><head><meta charset="utf-8"><title>Site Paused</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.5rem;color:#333;line-height:1.5}h1{margin-bottom:.5rem}p{color:#666}</style></head><body><h1>Site temporarily unavailable</h1><p>This site has been paused by its administrator. Please check back later.</p></body></html>';
  }
}
`;
}

async function isContainerRunning(name) {
  try {
    const { stdout } = await exec('docker', [
      'ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}',
    ], { timeout: 10000 });
    return stdout.trim() === name;
  } catch {
    return false;
  }
}

/**
 * Start (or replace) the pause placeholder container for an app.
 * Reads `app.domain` and `app.paused_redirect_url` to configure the redirect.
 */
async function startPausePlaceholder(app) {
  const appDir = path.join(config.deploy.baseDir, `app-${app.id}`);
  fs.mkdirSync(appDir, { recursive: true });

  const configPath = pauseConfigPath(app.id);
  fs.writeFileSync(configPath, generatePauseConfig(app.paused_redirect_url), 'utf8');

  // Make sure the proxy network exists (defensive — usually already created by docker-compose up of the proxy)
  try {
    await exec('docker', ['network', 'inspect', config.deploy.dockerNetwork], { timeout: 10000 });
  } catch {
    await exec('docker', ['network', 'create', config.deploy.dockerNetwork], { timeout: 10000 });
  }

  // Remove any existing placeholder so we can re-create with current config
  await stopPausePlaceholder(app.id);

  const name = pauseContainerName(app.id);
  await exec('docker', [
    'run', '-d',
    '--name', name,
    '--network', config.deploy.dockerNetwork,
    '--restart', 'unless-stopped',
    '-e', `VIRTUAL_HOST=${app.domain}`,
    '-e', 'VIRTUAL_PORT=80',
    '-e', `LETSENCRYPT_HOST=${app.domain}`,
    '-v', `${configPath}:/etc/nginx/conf.d/default.conf:ro`,
    '-l', `beachhead.app=${app.id}`,
    '-l', 'beachhead.role=pause-placeholder',
    'nginx:alpine',
  ], { timeout: 60000 });

  logger.info(`Pause placeholder started for app ${app.name} (${app.domain})${app.paused_redirect_url ? ` → ${app.paused_redirect_url}` : ' (default maintenance page)'}`);
}

/**
 * Stop and remove the pause placeholder container for an app.
 * Best-effort — does not throw if the container isn't there.
 */
async function stopPausePlaceholder(appId) {
  const name = pauseContainerName(appId);
  try {
    await exec('docker', ['stop', name], { timeout: 30000 });
  } catch {
    // Container may not exist — that's fine
  }
  try {
    await exec('docker', ['rm', '-f', name], { timeout: 10000 });
  } catch {
    // Same — best-effort cleanup
  }
}

module.exports = {
  pauseContainerName,
  generatePauseConfig,
  startPausePlaceholder,
  stopPausePlaceholder,
  isContainerRunning,
};
