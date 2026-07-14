const fs = require('fs');
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
  const lines = [
    '# Managed by Beachhead — do not edit by hand.',
    '# acme-companion standalone certificate definitions (ACME_STANDALONE_CERTS).',
    '',
  ];
  const ids = certs.map(identifierFor);
  lines.push(`ACME_STANDALONE_CERTS=(${ids.map(bashQuote).join(' ')})`);
  for (const cert of certs) {
    const id = identifierFor(cert);
    const hosts = (cert.domains || []).map(bashQuote).join(' ');
    lines.push(`ACME_${id}_HOST=(${hosts})`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the user-data file to the path acme-companion reads (via bind mount).
 */
async function writeUserData() {
  const certs = await StandaloneCerts.findAll();
  const content = generateUserData(certs);
  fs.writeFileSync(config.certs.userDataPath, content, 'utf8');
  try { fs.chmodSync(config.certs.userDataPath, 0o600); } catch { /* best-effort */ }
  logger.info(`Wrote acme standalone user-data (${certs.length} cert def(s)) to ${config.certs.userDataPath}`);
  return content;
}

/**
 * Ask acme-companion to run its service loop now, so a newly-added cert is
 * picked up immediately instead of at the next hourly tick. Best-effort — if
 * the exec fails, acme-companion still processes the change within the hour.
 */
async function signalAcme() {
  try {
    await exec('docker', ['exec', config.certs.acmeContainer, '/app/signal_le_service'], { timeout: 30000, silent: true });
    logger.info('Signalled acme-companion to reload standalone certs');
    return true;
  } catch (err) {
    logger.warn(`Could not signal acme-companion (${config.certs.acmeContainer}); change applies within the hour: ${err.message}`);
    return false;
  }
}

/** Write the user-data file and signal acme-companion. */
async function sync() {
  await writeUserData();
  return signalAcme();
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
  writeUserData,
  signalAcme,
  sync,
  getStatus,
  withStatus,
  getDownload,
  DOWNLOADABLE,
  primaryDomain,
};
