const fs = require('fs');
const path = require('path');
const { exec } = require('./docker');
const config = require('../config');
const logger = require('../logger');

/**
 * Per-app "under construction" placeholder containers.
 *
 * Context: when an app is in staging-only mode (`apps.staging_only`), the
 * compose override deliberately drops the primary domain from VIRTUAL_HOST and
 * serves only the staging host — so a client can preview the site before they
 * have paid, without the real domain going live. The side effect is that the
 * real domain has no vhost registered at all, and nginx-proxy answers with its
 * bare default 503.
 *
 * This module replaces that bare 503 with a branded "under construction" page.
 * It runs a tiny nginx:alpine container named `beachhead-construction-{appId}`
 * that claims the primary domain (and its www mirror, when the app uses one).
 * Because it advertises LETSENCRYPT_HOST as well, acme-companion provisions and
 * keeps renewing the real domain's certificate while the site is held back —
 * so the cert is already warm the moment the client goes live.
 *
 * Lifecycle (see syncForApp): the placeholder should exist if and only if
 *     app.construction_page && app.staging_only && !app.paused
 * Pause has its own placeholder (services/pause.js) which claims the same
 * hostnames, so the two must never run at once.
 *
 * Page content comes from three structured fields — heading, message, contact —
 * resolved per-app first, then falling back to the global defaults stored in
 * the settings table. Beachhead renders them into a fixed, escaped template;
 * operators never hand-write HTML, so there is no injection surface and no
 * nginx string-escaping to get wrong.
 */

const CONTAINER_ROLE = 'construction-placeholder';

const DEFAULT_HEADING = 'Coming Soon';
const DEFAULT_MESSAGE = 'This site is currently under construction. Please check back soon.';

// Generous caps — these are rendered into a single HTML file, not a database
// index. Long enough for a real paragraph, short enough that a paste accident
// can't fill the deploy volume.
const MAX_HEADING_LEN = 200;
const MAX_MESSAGE_LEN = 2000;
const MAX_CONTACT_LEN = 254;

function constructionContainerName(appId) {
  return `beachhead-construction-${appId}`;
}

function constructionConfigPath(appId) {
  return path.join(config.deploy.baseDir, `app-${appId}`, 'construction.conf');
}

function constructionPageDir(appId) {
  return path.join(config.deploy.baseDir, `app-${appId}`, 'construction-page');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve the effective page content for an app: per-app value if set and
 * non-blank, otherwise the global default, otherwise the built-in default.
 *
 * `defaults` is the object returned by Settings.getConstructionDefaults().
 */
function resolveContent(app, defaults = {}) {
  const pick = (appVal, globalVal, builtin) => {
    const a = appVal == null ? '' : String(appVal).trim();
    if (a) return a;
    const g = globalVal == null ? '' : String(globalVal).trim();
    if (g) return g;
    return builtin;
  };

  return {
    heading: pick(app.construction_heading, defaults.heading, DEFAULT_HEADING).slice(0, MAX_HEADING_LEN),
    message: pick(app.construction_message, defaults.message, DEFAULT_MESSAGE).slice(0, MAX_MESSAGE_LEN),
    contact: pick(app.construction_contact, defaults.contact, '').slice(0, MAX_CONTACT_LEN),
  };
}

/**
 * Turn the free-text contact field into a safe anchor.
 *
 * Accepts a bare email address, an explicit mailto:, or an http(s) URL.
 * Anything else is rendered as plain escaped text rather than a link — we
 * never emit an href we haven't recognised, so a stray `javascript:` value
 * can't become a clickable link.
 */
function renderContact(contact) {
  if (!contact) return '';
  const value = contact.trim();

  if (/^https?:\/\/[^\s<>"']+$/i.test(value)) {
    return `<p class="contact"><a href="${escapeHtml(value)}" rel="noopener">${escapeHtml(value)}</a></p>`;
  }

  const email = value.replace(/^mailto:/i, '');
  if (/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) {
    return `<p class="contact"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>`;
  }

  return `<p class="contact">${escapeHtml(value)}</p>`;
}

/**
 * Render the under-construction page.
 *
 * The message field is plain text; newlines become paragraph breaks so an
 * operator can write a couple of short paragraphs in the textarea without
 * needing markup.
 */
function renderConstructionHtml({ heading, message, contact }) {
  const paragraphs = String(message)
    .split(/\n\s*\n|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => `<p>${escapeHtml(s)}</p>`)
    .join('\n    ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f7f7f8;
    color: #24242a;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    box-sizing: border-box;
  }
  .card {
    max-width: 34rem;
    text-align: center;
  }
  .mark {
    width: 48px; height: 48px;
    margin: 0 auto 1.5rem;
    border-radius: 12px;
    background: #24242a;
    display: grid; place-items: center;
  }
  .mark svg { width: 26px; height: 26px; stroke: #f7f7f8; }
  h1 { margin: 0 0 .75rem; font-size: 1.75rem; font-weight: 650; letter-spacing: -0.01em; }
  p { margin: 0 0 .75rem; color: #5c5c66; line-height: 1.6; font-size: 1rem; }
  p:last-child { margin-bottom: 0; }
  .contact { margin-top: 1.5rem; font-size: .95rem; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    body { background: #131316; color: #ececf1; }
    p { color: #a0a0ab; }
    .mark { background: #ececf1; }
    .mark svg { stroke: #131316; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M10 21v-6h4v6"/>
      </svg>
    </div>
    <h1>${escapeHtml(heading)}</h1>
    ${paragraphs}
    ${renderContact(contact)}
  </main>
</body>
</html>
`;
}

/**
 * nginx config for the placeholder container.
 *
 * Status code is 503, not 200, and deliberately so: the site is temporarily
 * unavailable, not permanently this page. A 200 invites search engines to
 * index the placeholder as the site's real content and cache it; 503 plus
 * Retry-After and X-Robots-Tag tells crawlers to come back later and index
 * nothing. Browsers render the body normally either way.
 *
 * The page itself is a file mounted into the container rather than an inline
 * `return 503 '...'` string. nginx single-quoted strings can't embed an
 * apostrophe, and operator-supplied text is very likely to contain one
 * ("We'll be back shortly") — mounting the file sidesteps nginx string
 * escaping entirely.
 *
 * `location /` matches every path and unconditionally returns 503, so deep
 * links, curl, and stray asset requests all get the placeholder rather than a
 * bare 404. The error page is served from an internal-only location under an
 * obscure filename (not `/index.html`) deliberately: a real request path can't
 * collide with it, so there is no way to reach the file directly and receive a
 * 200 instead of the 503.
 */
const PAGE_FILENAME = '__bh_construction.html';

function generateConstructionConfig() {
  return `server {
  listen 80 default_server;
  server_name _;
  root /etc/nginx/construction;

  add_header Retry-After "3600" always;
  add_header X-Robots-Tag "noindex, nofollow" always;
  add_header Cache-Control "no-store" always;
  add_header X-Beachhead-Construction "1" always;

  error_page 503 /${PAGE_FILENAME};

  location = /${PAGE_FILENAME} {
    internal;
  }

  location / {
    return 503;
  }
}
`;
}

/**
 * Hostnames the placeholder must claim: everything the live app would be
 * serving if it weren't held back in staging-only mode, minus the staging
 * host (which the real containers are still serving).
 */
function hostsForApp(app) {
  const hosts = [];
  if (app.domain) hosts.push(app.domain);
  if (app.domain && app.www_redirect) hosts.push(`www.${app.domain}`);
  return hosts;
}

async function isRunning(appId) {
  const name = constructionContainerName(appId);
  try {
    const { stdout } = await exec('docker', [
      'ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}',
    ], { timeout: 10000, silent: true });
    return stdout.trim() === name;
  } catch {
    return false;
  }
}

/**
 * Start (or replace) the under-construction placeholder for an app.
 * Always recreates so content edits take effect immediately.
 */
async function startConstructionPlaceholder(app, defaults = {}) {
  const hosts = hostsForApp(app);
  if (hosts.length === 0) {
    throw new Error('startConstructionPlaceholder: app has no domain');
  }
  const hostsCsv = hosts.join(',');

  const appDir = path.join(config.deploy.baseDir, `app-${app.id}`);
  fs.mkdirSync(appDir, { recursive: true });

  const pageDir = constructionPageDir(app.id);
  fs.mkdirSync(pageDir, { recursive: true });
  const content = resolveContent(app, defaults);
  fs.writeFileSync(path.join(pageDir, PAGE_FILENAME), renderConstructionHtml(content), 'utf8');

  const configPath = constructionConfigPath(app.id);
  fs.writeFileSync(configPath, generateConstructionConfig(), 'utf8');

  // Defensive: the shared infra network normally already exists.
  try {
    await exec('docker', ['network', 'inspect', config.deploy.dockerNetwork], { timeout: 10000, silent: true });
  } catch {
    await exec('docker', ['network', 'create', config.deploy.dockerNetwork], { timeout: 10000 });
  }

  const name = constructionContainerName(app.id);
  try { await exec('docker', ['rm', '-f', name], { timeout: 15000, silent: true }); } catch {}

  await exec('docker', [
    'run', '-d',
    '--name', name,
    '--network', config.deploy.dockerNetwork,
    '--restart', 'unless-stopped',
    '-e', `VIRTUAL_HOST=${hostsCsv}`,
    '-e', 'VIRTUAL_PORT=80',
    // Keep the real domain's certificate provisioned and renewing while the
    // site is held back, so https:// works during the preview period and the
    // cert is already valid at go-live. Requires the client's DNS to point
    // here; if it doesn't yet, acme-companion simply retries and the page is
    // still served over plain HTTP in the meantime.
    '-e', `LETSENCRYPT_HOST=${hostsCsv}`,
    '-v', `${configPath}:/etc/nginx/conf.d/default.conf:ro`,
    '-v', `${pageDir}:/etc/nginx/construction:ro`,
    '-l', `beachhead.app=${app.id}`,
    '-l', `beachhead.role=${CONTAINER_ROLE}`,
    'nginx:alpine',
  ], { timeout: 60000 });

  logger.info(`Under-construction placeholder up: app=${app.name} hosts=${hostsCsv}`);
  return name;
}

/**
 * Stop and remove the placeholder for an app. Best-effort — never throws.
 * Matches by label as well as by name so a placeholder left behind by an
 * older naming scheme still gets cleaned up.
 */
async function stopConstructionPlaceholder(appId) {
  const name = constructionContainerName(appId);
  try { await exec('docker', ['rm', '-f', name], { timeout: 15000, silent: true }); } catch {}

  try {
    const { stdout } = await exec('docker', [
      'ps', '-a',
      '--filter', `label=beachhead.app=${appId}`,
      '--filter', `label=beachhead.role=${CONTAINER_ROLE}`,
      '--format', '{{.Names}}',
    ], { timeout: 10000, silent: true });
    for (const n of stdout.trim().split('\n').filter(Boolean)) {
      try { await exec('docker', ['rm', '-f', n], { timeout: 15000, silent: true }); } catch {}
    }
  } catch (err) {
    logger.warn(`stopConstructionPlaceholder(${appId}): ${err.message}`);
  }
}

/**
 * Whether an app should currently have a placeholder running.
 *
 * Paused apps are excluded because the pause placeholder claims the same
 * hostnames — two containers with the same VIRTUAL_HOST would make
 * nginx-proxy round-robin between them.
 */
function shouldRun(app) {
  return !!(app && app.construction_page && app.staging_only && !app.paused && app.domain);
}

/**
 * Bring the placeholder in line with the app's current state. This is the
 * function callers should reach for — it is idempotent and safe to call on
 * every state change (staging-only toggle, pause, unpause, deploy, startup).
 *
 * `defaults` is optional; when omitted the global settings are loaded here.
 * Never throws: a placeholder problem must not fail the operation that
 * triggered it.
 */
async function syncForApp(app, defaults) {
  try {
    if (!shouldRun(app)) {
      await stopConstructionPlaceholder(app.id);
      return false;
    }
    let resolved = defaults;
    if (!resolved) {
      // Required lazily to avoid a require cycle at module load.
      const Settings = require('../models/settings');
      resolved = await Settings.getConstructionDefaults();
    }
    await startConstructionPlaceholder(app, resolved);
    return true;
  } catch (err) {
    logger.warn(`Construction placeholder sync failed for app ${app?.id}: ${err.message}`);
    return false;
  }
}

/**
 * Re-render every running placeholder whose page inherits at least one field
 * from the global defaults. Called after the global copy is edited in
 * Settings so the change lands immediately on live placeholders.
 *
 * Apps that override all three fields are skipped — their page can't have
 * changed, and recreating the container would drop connections for nothing.
 */
async function refreshInheritingApps() {
  const Apps = require('../models/apps');
  const Settings = require('../models/settings');

  const apps = await Apps.findAll();
  const defaults = await Settings.getConstructionDefaults();

  const inheritsAnything = (app) => (
    !String(app.construction_heading || '').trim()
    || !String(app.construction_message || '').trim()
    || !String(app.construction_contact || '').trim()
  );

  let refreshed = 0;
  for (const app of apps) {
    if (!shouldRun(app) || !inheritsAnything(app)) continue;
    if (await syncForApp(app, defaults)) refreshed++;
  }
  if (refreshed > 0) {
    logger.info(`Refreshed ${refreshed} under-construction placeholder(s) after settings change`);
  }
  return refreshed;
}

/**
 * Reconcile every app on Beachhead startup. Placeholders carry
 * `--restart unless-stopped` so Docker usually revives them on its own; this
 * pass catches apps whose state changed while Beachhead was down, and removes
 * orphaned placeholders for apps that were taken live in the meantime.
 */
async function reconcileAll() {
  const Apps = require('../models/apps');
  const Settings = require('../models/settings');

  let apps;
  try {
    apps = await Apps.findAll();
  } catch (err) {
    logger.error(`construction.reconcileAll: failed to load apps: ${err.message}`);
    return;
  }

  let defaults = {};
  try {
    defaults = await Settings.getConstructionDefaults();
  } catch (err) {
    logger.warn(`construction.reconcileAll: could not load defaults: ${err.message}`);
  }

  for (const app of apps) {
    const wanted = shouldRun(app);
    const running = await isRunning(app.id);
    // Only act when reality and intent disagree — avoids needlessly
    // recreating every placeholder (and dropping its connections) on boot.
    if (wanted && !running) {
      await syncForApp(app, defaults);
    } else if (!wanted && running) {
      await stopConstructionPlaceholder(app.id);
      logger.info(`Removed stale under-construction placeholder for app ${app.name}`);
    }
  }
}

module.exports = {
  CONTAINER_ROLE,
  PAGE_FILENAME,
  DEFAULT_HEADING,
  DEFAULT_MESSAGE,
  MAX_HEADING_LEN,
  MAX_MESSAGE_LEN,
  MAX_CONTACT_LEN,
  constructionContainerName,
  constructionConfigPath,
  constructionPageDir,
  escapeHtml,
  resolveContent,
  renderConstructionHtml,
  generateConstructionConfig,
  hostsForApp,
  isRunning,
  shouldRun,
  startConstructionPlaceholder,
  stopConstructionPlaceholder,
  syncForApp,
  refreshInheritingApps,
  reconcileAll,
};
