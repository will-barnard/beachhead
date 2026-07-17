const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('./docker');
const StandaloneCerts = require('../models/standaloneCerts');
const config = require('../config');
const logger = require('../logger');

/**
 * Standalone certificate service.
 *
 * Beachhead's machine owns 80/443 and runs acme-companion, so it can obtain and
 * auto-renew Let's Encrypt certificates for hostnames that aren't served by any
 * app here (e.g. a NAS behind the same public IP). We drive acme-companion's
 * built-in "standalone certificates" feature by writing a bash user-data file
 * (ACME_STANDALONE_CERTS) that it reads, then reading the issued cert files back
 * out of the shared certs volume for download.
 *
 * acme-companion stores each cert under <certsDir>/<primary-domain>/ as
 * fullchain.pem, key.pem, chain.pem and cert.pem.
 */

// Files acme-companion writes per cert directory, and how we expose them.
const DOWNLOADABLE = {
  fullchain: 'fullchain.pem',
  key: 'key.pem',
  chain: 'chain.pem',
  cert: 'cert.pem',
};

// ── Shared ACME challenge location (vhost.d/default) ─────────────────
//
// nginx-proxy proxies /.well-known/acme-challenge/ straight to the app unless a
// higher-priority location intercepts it, so a single standing block is
// required to serve HTTP-01 tokens (for both app certs and standalone certs).
// acme-companion tries to add its OWN copy when standalone certs are present,
// producing a `duplicate location` that makes nginx fail to load — taking every
// site down. Beachhead therefore OWNS this file and re-asserts exactly one
// canonical block, stripping any duplicate acme-companion injects.
const CANONICAL_VHOST_DEFAULT = `# Managed by Beachhead — do not edit by hand.
#
# EXACTLY ONE \`location ^~ /.well-known/acme-challenge/\` may exist in the
# config included into every vhost. This single block serves HTTP-01 challenge
# tokens (written to the shared html webroot by acme-companion) for BOTH normal
# app certs and app-independent standalone certs.
#
# acme-companion will try to add its OWN duplicate copy of this location
# (wrapped in "## Start/End of configuration add by letsencrypt container")
# whenever standalone certs are configured. Two identical locations make nginx
# fail to load with \`duplicate location "/.well-known/acme-challenge/"\`, which
# takes ALL sites down and silently blocks every reload. Beachhead's
# certs.ensureChallengeLocation() rewrites this file to the canonical form
# below and reloads nginx on boot, after every standalone-cert change, and on a
# periodic timer — so any duplicate acme-companion injects is stripped
# automatically. Do NOT add a second challenge block anywhere.
location ^~ /.well-known/acme-challenge/ {
    auth_basic off;
    allow all;
    root /usr/share/nginx/html;
    try_files $uri =404;
}

client_max_body_size 8192m;

# Allow large uploads (e.g. 6 GB static site zips) to transfer without timing out.
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
client_body_timeout 3600s;
`;

/**
 * Re-assert the canonical vhost.d/default so there is exactly one ACME
 * challenge location, then reload nginx-proxy. Idempotent: if the file already
 * matches, it does nothing. If acme-companion has appended a duplicate block,
 * this overwrites it back to the single canonical form and reloads.
 *
 * The reload only fires after `nginx -t` passes, so a transient bad state never
 * takes the proxy down. Best-effort — never throws.
 */
async function ensureChallengeLocation() {
  const filePath = config.certs.vhostDefaultPath;
  const proxy = config.certs.proxyContainer;
  try {
    let current = null;
    try { current = fs.readFileSync(filePath, 'utf8'); } catch { /* missing → write it */ }
    if (current === CANONICAL_VHOST_DEFAULT) {
      return { changed: false };
    }
    fs.writeFileSync(filePath, CANONICAL_VHOST_DEFAULT, 'utf8');
    // Validate before reloading — if the wider config is somehow broken, keep
    // the currently-loaded config rather than reloading into a failure.
    await exec('docker', ['exec', proxy, 'nginx', '-t'], { timeout: 15000, silent: true });
    await exec('docker', ['exec', proxy, 'nginx', '-s', 'reload'], { timeout: 15000, silent: true });
    logger.info('Reconciled ACME challenge location in vhost.d/default and reloaded nginx-proxy');
    return { changed: true, error: null };
  } catch (err) {
    logger.warn(`ensureChallengeLocation failed: ${err.message}`);
    return { changed: false, error: err.message };
  }
}

/** Bash-safe internal identifier for a cert row (used as the array key). */
function identifierFor(cert) {
  return `bh${cert.id}`;
}

/** Single-quote a value for the bash user-data file. Domains are validated to
 *  [a-z0-9.-] upstream, so this is belt-and-suspenders. */
function bashQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** The primary domain of a cert (acme-companion names the cert dir after it). */
function primaryDomain(cert) {
  return (cert.domains && cert.domains[0]) || null;
}

/**
 * Render the acme-companion user-data file from all standalone cert rows.
 */
function generateUserData(certs) {
  const ids = certs.map(identifierFor);
  const idList = ids.map(bashQuote).join(' ');
  const lines = [
    '# Managed by Beachhead — do not edit by hand.',
    '# acme-companion standalone certificate definitions.',
    '# Both the legacy LETSENCRYPT_* names (read by the service loop, incl. v2.4)',
    '# and the newer ACME_* aliases are emitted so this works across versions.',
    '',
    `LETSENCRYPT_STANDALONE_CERTS=(${idList})`,
    `ACME_STANDALONE_CERTS=(${idList})`,
  ];
  for (const cert of certs) {
    const id = identifierFor(cert);
    const hosts = (cert.domains || []).map(bashQuote).join(' ');
    lines.push(`LETSENCRYPT_${id}_HOST=(${hosts})`);
    lines.push(`ACME_${id}_HOST=(${hosts})`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Push the generated user-data file straight into the acme-companion container
 * at the path it reads (`/app/letsencrypt_user_data`), using `docker cp`.
 *
 * We deliberately avoid bind-mounting this file from the host: a single-file
 * bind mount can't be atomically replaced (the container pins the original
 * inode) and overwriting a host-owned file in place fails with EACCES under
 * Docker Desktop's file sharing. `docker cp` writes into the acme container's
 * own filesystem as root, sidestepping both problems entirely.
 *
 * Best-effort: returns false (rather than throwing) if acme-companion isn't
 * reachable yet, so callers — including request handlers — don't fail.
 */
async function pushUserData() {
  const certs = await StandaloneCerts.findAll();
  const content = generateUserData(certs);

  // Write to Beachhead's own (always-writable) temp dir first.
  const tmpPath = path.join(os.tmpdir(), 'beachhead-letsencrypt_user_data');
  fs.writeFileSync(tmpPath, content, 'utf8');

  try {
    await exec('docker', ['cp', tmpPath, `${config.certs.acmeContainer}:${config.certs.acmeUserDataPath}`], { timeout: 30000 });
    logger.info(`Copied acme standalone user-data (${certs.length} cert def(s)) into ${config.certs.acmeContainer}`);
    return { ok: true, error: null };
  } catch (err) {
    logger.warn(`Could not copy standalone user-data into acme-companion (${config.certs.acmeContainer}): ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
  }
}

/**
 * Ask acme-companion to run its service loop now, so a newly-added cert is
 * picked up immediately instead of at the next hourly tick. Best-effort — if
 * the exec fails, acme-companion still processes the change within the hour.
 */
async function signalAcme() {
  try {
    await exec('docker', ['exec', config.certs.acmeContainer, '/app/signal_le_service'], { timeout: 30000 });
    logger.info('Signalled acme-companion to reload standalone certs');
    return { ok: true, error: null };
  } catch (err) {
    logger.warn(`Could not signal acme-companion (${config.certs.acmeContainer}); change applies within the hour: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Push the user-data into acme-companion and signal it to reload.
 * Returns { pushed, signalled, error } so callers can surface failures.
 */
async function sync() {
  const push = await pushUserData();
  if (!push.ok) return { pushed: false, signalled: false, error: push.error };
  const signal = await signalAcme();
  // Adding/removing a standalone cert is exactly when acme-companion may inject
  // a duplicate challenge location into vhost.d/default — re-assert ours.
  await ensureChallengeLocation();
  return { pushed: true, signalled: signal.ok, error: signal.ok ? null : signal.error };
}

/**
 * Startup sync with a few retries — on a cold `compose up`, acme-companion may
 * still be starting when Beachhead boots. Best-effort; never throws.
 */
async function syncOnStartup(attempts = 3, delayMs = 5000) {
  for (let i = 0; i < attempts; i++) {
    const result = await sync();
    if (result.pushed) return result;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return { pushed: false, signalled: false, error: 'acme-companion not reachable' };
}

/**
 * Read back what acme-companion currently has in its user-data file, plus
 * whether the container is reachable. Used by the dashboard's diagnostics so
 * the operator can confirm a cert definition actually reached acme-companion.
 */
async function readAcmeUserData() {
  try {
    const { stdout } = await exec(
      'docker',
      ['exec', config.certs.acmeContainer, 'sh', '-c', `cat ${config.certs.acmeUserDataPath} 2>/dev/null || true`],
      { timeout: 15000, silent: true }
    );
    return { reachable: true, container: config.certs.acmeContainer, content: stdout || '' };
  } catch (err) {
    return { reachable: false, container: config.certs.acmeContainer, content: '', error: err.message };
  }
}

function certFilePath(cert, key) {
  const domain = primaryDomain(cert);
  if (!domain) return null;
  const filename = DOWNLOADABLE[key];
  if (!filename) return null;
  return path.join(config.certs.dir, domain, filename);
}

function readCertFile(cert, key) {
  const p = certFilePath(cert, key);
  if (!p || !fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    logger.warn(`Failed to read cert file ${p}: ${err.message}`);
    return null;
  }
}

/**
 * Status for a cert row: whether it's been issued yet and, if so, its expiry.
 */
function getStatus(cert) {
  const domain = primaryDomain(cert);
  const fullchain = readCertFile(cert, 'fullchain');
  if (!fullchain) {
    return { primary_domain: domain, issued: false, expires_at: null, days_remaining: null };
  }
  let expiresAt = null;
  let daysRemaining = null;
  try {
    const x509 = new crypto.X509Certificate(fullchain);
    const validTo = new Date(x509.validTo);
    if (!isNaN(validTo.getTime())) {
      expiresAt = validTo.toISOString();
      daysRemaining = Math.floor((validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    }
  } catch (err) {
    logger.warn(`Could not parse cert for ${domain}: ${err.message}`);
  }
  return { primary_domain: domain, issued: true, expires_at: expiresAt, days_remaining: daysRemaining };
}

/** cert row + status, for API responses. */
function withStatus(cert) {
  return { ...cert, status: getStatus(cert) };
}

/**
 * Build a downloadable file payload for a cert. Returns null if the requested
 * file doesn't exist yet (cert not issued).
 */
function getDownload(cert, key) {
  const content = readCertFile(cert, key);
  if (content === null) return null;
  const domain = primaryDomain(cert) || 'certificate';
  const suffix = key === 'key' ? 'key' : key; // fullchain|key|chain|cert
  return {
    filename: `${domain}.${suffix}.pem`,
    content,
    contentType: 'application/x-pem-file',
  };
}

module.exports = {
  identifierFor,
  generateUserData,
  pushUserData,
  signalAcme,
  sync,
  syncOnStartup,
  ensureChallengeLocation,
  CANONICAL_VHOST_DEFAULT,
  readAcmeUserData,
  getStatus,
  withStatus,
  getDownload,
  DOWNLOADABLE,
  primaryDomain,
};
