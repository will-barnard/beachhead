/**
 * Reverse Proxy Targets — runtime.
 *
 * Forwards 80/443 traffic for one or more domains to an arbitrary host:port
 * Beachhead does NOT run (e.g. a NAS on the same LAN). Beachhead has no
 * mechanic to route nginx-proxy to a non-Docker target directly — nginx-proxy
 * only discovers containers on beachhead-net via docker-gen watching the
 * Docker socket for VIRTUAL_HOST/VIRTUAL_PORT/LETSENCRYPT_HOST env vars.
 *
 * So, same shape as static sites (services/staticSites.js): a tiny
 * nginx:alpine sidecar container on beachhead-net carries those env vars.
 * nginx-proxy and acme-companion pick it up automatically — no override
 * file, no compose project, no signalling needed. The only difference from
 * a static site is what the sidecar's own nginx.conf does: instead of
 * serving a bind-mounted directory, it proxy_pass'es to the real target.
 * TLS still terminates at Beachhead; the connection onward to the target
 * is whatever target_scheme says (typically plain HTTP to a LAN device).
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('./docker');
const config = require('../config');
const logger = require('../logger');

const BASE = path.join(config.deploy.baseDir, 'reverse-proxy-targets');

function containerName(id) {
  return `reverse-proxy-${id}`;
}

function confPath(id) {
  return path.join(BASE, `target-${id}.conf`);
}

/**
 * Render the sidecar's nginx conf. Mounted straight over the stock image's
 * /etc/nginx/conf.d/default.conf.
 *
 * `resolver 127.0.0.11` + a $upstream variable (rather than a bare
 * proxy_pass) mirrors the same rule Beachhead apps must follow for
 * cross-service calls: nginx resolves proxy_pass hostnames at config load
 * time otherwise, and a target that's briefly unreachable at container
 * start (or a LAN hostname instead of a literal IP) would wedge the sidecar
 * with "host not found in upstream" until it's manually restarted.
 */
function renderConf(target) {
  const upstream = `${target.target_scheme}://${target.target_host}:${target.target_port}`;

  const extra = [];
  if (target.websocket) {
    extra.push(
      '        proxy_http_version 1.1;',
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection "upgrade";'
    );
  }
  if (target.target_scheme === 'https') {
    extra.push('        proxy_ssl_server_name on;');
    if (target.verify_tls === false) {
      extra.push('        proxy_ssl_verify off;');
    }
  }

  return [
    '# Managed by Beachhead — do not edit by hand. Regenerated on every change.',
    'server {',
    '    listen 80;',
    '    server_name _;',
    '',
    '    resolver 127.0.0.11 valid=30s ipv6=off;',
    '',
    '    client_max_body_size 0;',
    '    proxy_read_timeout 3600s;',
    '    proxy_send_timeout 3600s;',
    '',
    '    location / {',
    `        set $upstream ${upstream};`,
    '        proxy_pass $upstream;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    ...extra,
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Start (or restart) the sidecar for a target. Idempotent — an existing
 * container is removed first. Call after create, after any field changes
 * (domains, target host/port/scheme, websocket, verify_tls), and re-enable.
 */
async function startContainer(target) {
  const name = containerName(target.id);
  fs.mkdirSync(BASE, { recursive: true });
  const confFile = confPath(target.id);
  fs.writeFileSync(confFile, renderConf(target), 'utf8');

  const hosts = target.domains.join(',');

  try {
    await exec('docker', ['rm', '-f', name], { timeout: 15000, silent: true });
  } catch { /* container may not exist */ }

  const args = [
    'run', '-d',
    '--name', name,
    '--restart', 'unless-stopped',
    '--network', config.deploy.dockerNetwork,
    '-e', `VIRTUAL_HOST=${hosts}`,
    '-e', 'VIRTUAL_PORT=80',
    '-e', `LETSENCRYPT_HOST=${hosts}`,
    '-v', `${confFile}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:alpine',
  ];
  await exec('docker', args, { timeout: 30000 });
  logger.info(`Reverse proxy target started: ${name} → ${target.target_scheme}://${target.target_host}:${target.target_port} (${hosts})`);
}

async function stopContainer(id) {
  try {
    await exec('docker', ['rm', '-f', containerName(id)], { timeout: 15000, silent: true });
  } catch { /* ok if not running */ }
}

function removeConf(id) {
  try { fs.unlinkSync(confPath(id)); } catch { /* ok if never written */ }
}

/** Apply a target's current `enabled` state: running if enabled, stopped if not. */
async function apply(target) {
  if (target.enabled) {
    await startContainer(target);
  } else {
    await stopContainer(target.id);
  }
}

/**
 * On Beachhead boot, reconcile every target: start containers for enabled
 * targets that aren't already running, stop any left running for a target
 * that's since been disabled. Containers carry --restart unless-stopped so
 * this mostly catches cases where they were removed or Docker lost state.
 */
async function startupEnsureRunning() {
  const ReverseProxyTargets = require('../models/reverseProxyTargets');
  const targets = await ReverseProxyTargets.findAll();
  for (const target of targets) {
    if (!target.enabled) {
      await stopContainer(target.id).catch(() => {});
      continue;
    }
    try {
      const { stdout } = await exec(
        'docker',
        ['inspect', '-f', '{{.State.Running}}', containerName(target.id)],
        { timeout: 10000, silent: true }
      );
      if (stdout.trim() === 'true') continue;
    } catch { /* container missing — start it below */ }

    try {
      await startContainer(target);
    } catch (err) {
      logger.warn(`[startup] reverse proxy target ${target.id}: ${err.message}`);
    }
  }
}

module.exports = {
  containerName,
  confPath,
  renderConf,
  startContainer,
  stopContainer,
  removeConf,
  apply,
  startupEnsureRunning,
};
