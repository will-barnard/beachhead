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

/**
 * Container name and on-disk config path for an auto-pause (on-demand)
 * placeholder. Keyed by service so multi-endpoint apps can have one
 * placeholder per paused public service.
 */
function autoPauseContainerName(appId, service) {
  const safe = String(service || 'public').replace(/[^a-zA-Z0-9-]/g, '-');
  return `beachhead-autopause-${appId}-${safe}`;
}

function autoPauseConfigPath(appId, service) {
  const safe = String(service || 'public').replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(config.deploy.baseDir, `app-${appId}`, `autopause-${safe}.conf`);
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

/**
 * Generate the nginx config for an auto-pause (on-demand) placeholder.
 *
 * The placeholder serves an HTML page that pings Beachhead's wake endpoint.
 * It also exposes `/__bh_wake__` and `/__bh_status__` as same-origin proxies
 * to the Beachhead API so the page doesn't need CORS to call across the
 * dashboard's domain.
 */
function generateAutoPauseConfig({ appId, customHtml, idleSeconds }) {
  // The HTML is rendered into the nginx config as a single-quoted string.
  // We escape backslashes and single quotes for nginx, then use the literal
  // value in `return 200`.
  const html = (customHtml && String(customHtml).trim()) || defaultWakeHtml(idleSeconds);
  const escapedHtml = String(html)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

  // Resolution-at-request-time: without this nginx tries to resolve
  // `beachhead-api` at config load and crashes if the lookup fails for any
  // reason (e.g. the API restarted just before the placeholder did). Using
  // Docker's embedded DNS (127.0.0.11) plus a variable for proxy_pass
  // defers DNS to request time, so transient resolution failures only fail
  // the wake fetch — they don't take down the whole placeholder.
  return `server {
  listen 80 default_server;
  server_name _;

  resolver 127.0.0.11 valid=30s ipv6=off;
  set $bh_api http://beachhead-api:3000;

  # Wake endpoint — same-origin proxy into Beachhead's API.
  # Held open until the app is healthy (or the upstream times out),
  # so the client can simply reload on a 200 response.
  location = /__bh_wake__ {
    proxy_pass $bh_api/api/wake/${appId};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
    proxy_connect_timeout 5s;
    proxy_send_timeout 10s;
    # If the API is briefly unreachable, fall through to a JSON-shaped
    # 502 so the wake page's retry loop has something to work with.
    proxy_intercept_errors on;
    error_page 502 503 504 = @wake_unreachable;
  }

  location = /__bh_status__ {
    proxy_pass $bh_api/api/wake/${appId}/status;
    proxy_set_header Host $host;
    proxy_intercept_errors on;
    error_page 502 503 504 = @wake_unreachable;
  }

  location @wake_unreachable {
    default_type application/json;
    return 502 '{"error":"beachhead api unreachable"}';
  }

  # Wake page: same content for every path so a curl/wget user also sees
  # something useful instead of a 404.
  location / {
    default_type text/html;
    add_header Cache-Control "no-store" always;
    return 200 '${escapedHtml}';
  }
}
`;
}

function defaultWakeHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Waking up&hellip;</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; color: #333; background: #fafafa; display: grid; place-items: center; }
  .card { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { margin: 0 0 .25rem; font-size: 1.4rem; font-weight: 600; }
  p { margin: 0; color: #666; }
  .spinner { width: 32px; height: 32px; border: 3px solid #e0e0e0; border-top-color: #555; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1.25rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { color: #b00; margin-top: .75rem; font-size: .9rem; }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Waking up&hellip;</h1>
    <p>This site sleeps when idle. It will be ready in a few seconds.</p>
    <p class="err" id="err" hidden></p>
  </div>
<script>
(function () {
  // Wake-page retry policy:
  //   - Always retry until success — transient 502s right at the start are
  //     normal (nginx-proxy hasn't routed yet, beachhead-api one tick behind).
  //   - Retry quickly so a real wake feels instant: 500 ms between attempts.
  //   - Stay quiet for the first ~20 s so a normal cold start (which is
  //     usually well under that) never shows a user-facing error.
  //   - Only after that do we surface what's going wrong, and we keep
  //     retrying — the user can leave the tab open and recover automatically.
  var QUIET_MS = 20000;
  var RETRY_MS = 500;

  var err = document.getElementById("err");
  var startedAt = Date.now();
  function maybeShowError(msg) {
    if (Date.now() - startedAt < QUIET_MS) return;
    err.textContent = msg + " \\u2014 still trying\\u2026";
    err.hidden = false;
  }

  function attempt() {
    fetch("/__bh_wake__", { method: "POST", cache: "no-store" })
      .then(function (r) {
        if (r.ok) { window.location.reload(); return; }
        maybeShowError("Wake returned " + r.status);
        setTimeout(attempt, RETRY_MS);
      })
      .catch(function (e) {
        maybeShowError("Wake error: " + ((e && e.message) || e));
        setTimeout(attempt, RETRY_MS);
      });
  }

  attempt();
})();
</script>
</body>
</html>`;
}

/**
 * Start an auto-pause placeholder for a single (app, service) pair.
 * The placeholder serves the given hostnames via nginx-proxy and renders
 * the wake page.
 *
 * `hosts` MUST contain every hostname the live app was claiming (primary +
 * www mirror + staging host as appropriate). nginx-proxy and acme-companion
 * both compare this list against the existing cert's SANs; if it doesn't
 * match, acme-companion will try to re-provision the cert and during that
 * gap nginx-proxy serves its built-in self-signed cert — and HSTS-pinned
 * browsers refuse to load the page with "certificate invalid".
 *
 * Accepts either `hosts` (preferred, array) or legacy `domain` (string).
 */
async function startAutoPausePlaceholder({ app, service, hosts, domain, customHtml }) {
  const hostList = Array.isArray(hosts) && hosts.length > 0
    ? hosts.filter(Boolean)
    : (domain ? [domain] : []);
  if (hostList.length === 0) {
    throw new Error('startAutoPausePlaceholder: no hostnames provided');
  }
  const hostsCsv = hostList.join(',');

  const appDir = path.join(config.deploy.baseDir, `app-${app.id}`);
  fs.mkdirSync(appDir, { recursive: true });

  const configPath = autoPauseConfigPath(app.id, service);
  const conf = generateAutoPauseConfig({
    appId: app.id,
    customHtml: customHtml || app.wake_page_html,
    idleSeconds: app.idle_timeout_seconds,
  });
  fs.writeFileSync(configPath, conf, 'utf8');

  // Defensive: ensure beachhead-net exists.
  try {
    await exec('docker', ['network', 'inspect', config.deploy.dockerNetwork], { timeout: 10000, silent: true });
  } catch {
    await exec('docker', ['network', 'create', config.deploy.dockerNetwork], { timeout: 10000 });
  }

  const name = autoPauseContainerName(app.id, service);
  // Recreate so config edits take effect immediately.
  try { await exec('docker', ['rm', '-f', name], { timeout: 15000, silent: true }); } catch {}

  await exec('docker', [
    'run', '-d',
    '--name', name,
    '--network', config.deploy.dockerNetwork,
    '--restart', 'unless-stopped',
    '-e', `VIRTUAL_HOST=${hostsCsv}`,
    '-e', 'VIRTUAL_PORT=80',
    '-e', `LETSENCRYPT_HOST=${hostsCsv}`,
    '-v', `${configPath}:/etc/nginx/conf.d/default.conf:ro`,
    '-l', `beachhead.app=${app.id}`,
    '-l', `beachhead.service=${service}`,
    '-l', 'beachhead.role=auto-pause-placeholder',
    'nginx:alpine',
  ], { timeout: 60000 });

  logger.info(`Auto-pause placeholder up: app=${app.name} service=${service} hosts=${hostsCsv}`);
  return name;
}

/**
 * Stop and remove every auto-pause placeholder for an app.
 * Best-effort — never throws. Matches by label so we don't have to remember
 * which services were placeholdered.
 */
async function stopAutoPausePlaceholders(appId) {
  try {
    const { stdout } = await exec('docker', [
      'ps', '-a',
      '--filter', `label=beachhead.app=${appId}`,
      '--filter', 'label=beachhead.role=auto-pause-placeholder',
      '--format', '{{.Names}}',
    ], { timeout: 10000, silent: true });
    const names = stdout.trim().split('\n').filter(Boolean);
    for (const n of names) {
      try { await exec('docker', ['rm', '-f', n], { timeout: 15000, silent: true }); } catch {}
    }
    if (names.length > 0) {
      logger.info(`Removed ${names.length} auto-pause placeholder(s) for app ${appId}`);
    }
  } catch (err) {
    logger.warn(`stopAutoPausePlaceholders(${appId}): ${err.message}`);
  }
}

module.exports = {
  pauseContainerName,
  autoPauseContainerName,
  generatePauseConfig,
  generateAutoPauseConfig,
  defaultWakeHtml,
  startPausePlaceholder,
  stopPausePlaceholder,
  startAutoPausePlaceholder,
  stopAutoPausePlaceholders,
  isContainerRunning,
};
