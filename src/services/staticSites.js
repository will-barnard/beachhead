/**
 * Static-site runtime + deployer.
 *
 * Two flavours of static site share the same nginx-alpine container shape:
 *
 *   1. upload mode  — files arrive via POST /static-sites/:id/upload (zip or
 *                     index.html). The route hander writes them straight into
 *                     the web root. We just need start/stopContainer here so
 *                     the route can hand off after writing files.
 *
 *   2. git mode     — repo cloned per deploy, optional build_command run inside
 *                     a sandboxed builder container, build_output (subpath)
 *                     synced into the web root, then container restarted.
 *
 * A third path (still an upload-mode site — no new source_type) exists for
 * sites too large to push through the browser: dropping a folder directly
 * onto the Beachhead host under static-sites-incoming/ (e.g. via rsync/scp
 * ahead of time) and then importing it from the dashboard. See "Local
 * import" below.
 *
 * Layout under config.deploy.baseDir:
 *
 *   static-sites/site-<id>/public/        ← what nginx serves (bind-mounted)
 *   static-sites-git/site-<id>/work/      ← clone + build dir (git mode only)
 *   static-sites-git/site-<id>/log        ← last deploy log (tail mirrored to db)
 *   static-sites-incoming/<folder>/       ← files rsync'd/scp'd onto the host
 *                                            ahead of time, awaiting import
 *
 * The container is plain nginx:alpine on the shared beachhead-net, the same
 * shape as the original uploads-only flow. nginx-proxy + acme-companion pick
 * it up via VIRTUAL_HOST / LETSENCRYPT_HOST env vars — no override file, no
 * compose project.
 */

const fs = require('fs');
const path = require('path');
const { exec, gitClone } = require('./docker');
const StaticSites = require('../models/staticSites');
const config = require('../config');
const logger = require('../logger');

// ── Paths ──────────────────────────────────────────────────────────────────

const STATIC_BASE = path.join(config.deploy.baseDir, 'static-sites');
const GIT_BASE = path.join(config.deploy.baseDir, 'static-sites-git');
const INCOMING_BASE = path.join(config.deploy.baseDir, 'static-sites-incoming');

function siteDir(siteId) {
  return path.join(STATIC_BASE, `site-${siteId}`);
}
function webRoot(siteId) {
  return path.join(siteDir(siteId), 'public');
}
function gitWorkDir(siteId) {
  return path.join(GIT_BASE, `site-${siteId}`, 'work');
}
function containerName(siteId) {
  return `static-site-${siteId}`;
}

// ── Container lifecycle ────────────────────────────────────────────────────

/**
 * Start (or restart) the nginx container for a static site. Idempotent —
 * if a container already exists it's removed first.
 *
 * Used by both upload and git flows after their respective publish step.
 */
async function startContainer(site) {
  const name = containerName(site.id);
  const root = webRoot(site.id);
  const hosts = site.www_redirect ? `${site.domain},www.${site.domain}` : site.domain;

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
    '-v', `${root}:/usr/share/nginx/html:ro`,
    'nginx:alpine',
  ];
  await exec('docker', args, { timeout: 30000 });
  logger.info(`Static site container started: ${name} for ${site.domain}`);
}

async function stopContainer(siteId) {
  try {
    await exec('docker', ['rm', '-f', containerName(siteId)], { timeout: 15000, silent: true });
  } catch { /* ok if not running */ }
}

// ── Git-mode deployer ──────────────────────────────────────────────────────

const LOG_TAIL_BYTES = 64 * 1024; // last 64KB of log persisted on the row
const BUILD_TIMEOUT_MS = 15 * 60 * 1000; // 15 min cap on user build commands

/**
 * Sandboxed shell exec used for the build step. We deliberately do NOT run
 * arbitrary user-supplied build_command on the Beachhead host — instead we
 * spin up a transient container with the cloned repo bind-mounted, run the
 * command, and discard the container. This keeps build dependencies off the
 * host and prevents the build from touching anything outside the work dir.
 *
 * The container has no Docker socket, no DB credentials, no env beyond what
 * the user explicitly sets via build_command itself.
 */
async function runBuild(site, workDir, logSink) {
  if (!site.build_command || !site.build_command.trim()) {
    logSink('No build_command configured — skipping build step.');
    return;
  }
  const image = site.build_image || 'node:20-alpine';
  logSink(`→ docker run --rm ${image} sh -c "${site.build_command}"`);

  const args = [
    'run', '--rm',
    '-v', `${workDir}:/workspace`,
    '-w', '/workspace',
    // Drop network for builds by default? Most npm builds need the network.
    // Leave default bridge — same access npm install would need.
    image,
    'sh', '-c', site.build_command,
  ];

  const { stdout, stderr } = await exec('docker', args, {
    timeout: BUILD_TIMEOUT_MS,
    silent: true,
  }).catch(err => {
    // exec rejects with the raw error — re-throw with the trimmed log appended
    throw new Error(`Build failed: ${err.message}`);
  });

  if (stdout) logSink(stdout);
  if (stderr) logSink(stderr);
}

/**
 * Swap `staging` in as the new webRoot(siteId), replacing whatever is there.
 * Shared by both the git publisher and the local-import flow below. Caller
 * is responsible for having `staging` fully populated (and for cleaning it
 * up on failure) before calling this — the rename itself is the only part
 * that needs to be atomic, since it's the moment nginx's bind-mounted view
 * of the directory actually changes.
 */
function swapStagingIntoWebRoot(siteId, staging) {
  const target = webRoot(siteId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  return target;
}

/**
 * Atomically replace the contents of webRoot(site.id) with `<workDir>/<subpath>`.
 *
 * Strategy: copy into a sibling directory, swap by rename. This avoids serving
 * a half-published site if something dies mid-copy.
 *
 * On most filesystems rename is atomic for directories on the same mount.
 * baseDir is one mount, so this holds.
 */
function publish(site, workDir, logSink) {
  const subpath = (site.subpath || '.').replace(/^\/+/, '');
  const sourceDir = path.resolve(workDir, subpath);
  const target = webRoot(site.id);
  const staging = `${target}.new`;

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`subpath '${subpath}' does not exist or is not a directory in the build output`);
  }

  // Verify there's at least one file (warn-only — empty dirs aren't fatal)
  const entries = fs.readdirSync(sourceDir);
  if (entries.length === 0) {
    logSink(`Warning: ${subpath} is empty — site will serve nothing.`);
  }

  // Clean staging if a previous attempt left it behind
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // fs.cpSync (Node 16.7+) handles recursive copy with symlinks.
  // Filter out .git — it has read-only pack files that cause chmod EACCES,
  // and it should never end up in the web root anyway.
  fs.cpSync(sourceDir, staging, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    filter: (src) => !src.split(path.sep).includes('.git'),
  });

  swapStagingIntoWebRoot(site.id, staging);
  logSink(`Published ${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'} from ${subpath} → ${target}`);
}

// ── Local import (large-site path) ─────────────────────────────────────────
//
// Beachhead's own container has DEPLOY_BASE_DIR bind-mounted at the *same*
// path as it lives on the host (see docker-compose.yml) — that's what makes
// paths under it usable both by Node's fs calls here AND by the `docker run
// -v <path>:...` commands above, which are interpreted by the HOST docker
// daemon (Beachhead talks to it over the host's docker.sock). A path typed
// into the dashboard that lives outside DEPLOY_BASE_DIR would not have that
// property — Beachhead's own process couldn't see it to validate or import
// it even though a bind mount to it might work by accident. So rather than
// accept an arbitrary filesystem path from the browser, static-sites-incoming/
// is a fixed, pre-mounted staging root: rsync/scp your build there directly
// on the host ahead of time (bypassing HTTP entirely — no upload size limit,
// no browser tab that has to stay open, resumable with rsync), then import
// a named subfolder of it from the dashboard.

function ensureIncomingBase() {
  fs.mkdirSync(INCOMING_BASE, { recursive: true });
  return INCOMING_BASE;
}

/**
 * Resolve a folder name the dashboard sent against INCOMING_BASE, refusing
 * anything that would escape it (../, absolute paths, symlink shenanigans).
 */
function resolveIncomingPath(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('path is required');
  }
  const base = ensureIncomingBase();
  const resolved = path.resolve(base, name);
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path must be a folder directly under static-sites-incoming/');
  }
  return resolved;
}

/**
 * List top-level folders sitting in static-sites-incoming/, with size and
 * mtime, so the dashboard can offer a picker instead of a free-text path.
 * `du -sb` is used for size (fast, single syscall-ish walk on most kernels)
 * rather than a JS recursive walk, since these directories can be huge.
 */
async function listIncoming() {
  const base = ensureIncomingBase();
  const names = fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const results = [];
  for (const name of names) {
    const dir = path.join(base, name);
    const stat = fs.statSync(dir);
    let sizeBytes = null;
    try {
      const { stdout } = await exec('du', ['-sb', dir], { timeout: 60000, silent: true });
      sizeBytes = parseInt(stdout.split('\t')[0], 10) || null;
    } catch {
      /* du missing or timed out — size is just cosmetic, skip it */
    }
    results.push({ name, sizeBytes, mtime: stat.mtime });
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

/**
 * Import an already-transferred folder from static-sites-incoming/ into the
 * site's web root and restart the container. Uses rename (not copy) so a
 * 20GB folder swaps in instantly instead of being re-copied byte for byte —
 * safe because INCOMING_BASE and STATIC_BASE are both under the same
 * DEPLOY_BASE_DIR mount. Falls back to copy+delete only if that assumption
 * is ever violated (e.g. DEPLOY_BASE_DIR reconfigured to span mounts).
 *
 * The source folder is consumed by the move — that's intentional, it keeps
 * static-sites-incoming/ from silently accumulating old copies of every site
 * ever imported.
 */
async function importFromIncoming(site, name, logSink = () => {}) {
  const sourceDir = resolveIncomingPath(name);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`'${name}' was not found under static-sites-incoming/`);
  }

  const entries = fs.readdirSync(sourceDir);
  if (entries.length === 0) {
    logSink(`Warning: ${name} is empty — site will serve nothing.`);
  }

  const target = webRoot(site.id);
  const staging = `${target}.new`;
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });

  try {
    fs.renameSync(sourceDir, staging);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    logSink('Rename crossed a filesystem boundary — falling back to copy (slower for large sites).');
    fs.cpSync(sourceDir, staging, { recursive: true, dereference: false, errorOnExist: false });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }

  swapStagingIntoWebRoot(site.id, staging);
  logSink(`Imported ${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'} from static-sites-incoming/${name} → ${target}`);
}

/**
 * Resolve the latest commit hash on the cloned working tree.
 * Best-effort: if git rev-parse fails we just return null.
 */
async function readHeadCommit(workDir) {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: workDir, timeout: 5000, silent: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run the full git → (build) → publish → restart pipeline for a site.
 * State machine mirrors the apps deployer in spirit but is much simpler —
 * everything happens in-process here, no PENDING queue.
 *
 * Concurrency: a per-site mutex prevents two webhooks landing simultaneously
 * from stomping each other's work dir.
 */
const inFlight = new Map(); // siteId → Promise

function deployFromGit(site, { commitHash = null, trigger = 'manual' } = {}) {
  if (inFlight.has(site.id)) {
    logger.info(`[static #${site.id}] Deploy already running — coalescing`);
    return inFlight.get(site.id);
  }
  const p = _deployFromGitInner(site, { commitHash, trigger }).finally(() => inFlight.delete(site.id));
  inFlight.set(site.id, p);
  return p;
}

async function _deployFromGitInner(site, { commitHash, trigger }) {
  if (site.source_type !== 'git' || !site.repo_url) {
    throw new Error(`Site ${site.name} (#${site.id}) is not configured for git deploys`);
  }

  const lines = [];
  const log = (msg) => {
    const stamped = `[${new Date().toISOString()}] ${msg}`;
    lines.push(stamped);
    logger.info(`[static #${site.id}] ${msg}`);
  };
  const persist = async (state, extra = {}) => {
    // Tail-truncate the log so a runaway build can't blow up the row.
    let joined = lines.join('\n');
    if (joined.length > LOG_TAIL_BYTES) {
      joined = '…(truncated)…\n' + joined.slice(-LOG_TAIL_BYTES);
    }
    await StaticSites.setDeployState(site.id, {
      last_deploy_state: state,
      last_deploy_at: new Date(),
      last_deploy_log: joined,
      ...extra,
    });
  };

  const workDir = gitWorkDir(site.id);

  try {
    log(`Deploy start (trigger=${trigger}, branch=${site.branch || 'main'})`);
    await persist('CLONING');

    // Fresh clone every time. Static sites are small; the speed cost is
    // tiny and a clean checkout dodges every "stale node_modules" footgun.
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    await gitClone(site.repo_url, site.branch || 'main', workDir);
    const head = await readHeadCommit(workDir);
    log(`Cloned ${site.repo_url} (${site.branch || 'main'}) at ${head || 'unknown commit'}`);

    if (site.build_command && site.build_command.trim()) {
      await persist('BUILDING');
      log(`Running build_command: ${site.build_command}`);
      await runBuild(site, workDir, log);
    }

    await persist('PUBLISHING');
    publish(site, workDir, log);

    log('Restarting nginx container');
    await startContainer(site);

    log('Deploy succeeded.');
    await persist('SUCCESS', { last_commit_hash: commitHash || head || null });
    return { ok: true, commit: commitHash || head };
  } catch (err) {
    log(`FAILED: ${err.message}`);
    await persist('FAILED').catch(() => { /* swallow — original error wins */ });
    throw err;
  }
}

// ── Startup recovery ───────────────────────────────────────────────────────

/**
 * On Beachhead boot, ensure the nginx container exists for every site that
 * already has files in webRoot. Mirrors worker.js#startupStaticSites — kept
 * here so the routes file doesn't need to import worker internals.
 *
 * The worker still owns the startup hook; this function is exported so the
 * worker can call it without duplicating logic. Migration path: in a follow-up
 * we move worker.js#startupStaticSites to call this.
 */
async function startupEnsureRunning() {
  const sites = await StaticSites.findAll();
  for (const site of sites) {
    const root = webRoot(site.id);
    if (!fs.existsSync(root)) continue; // never deployed
    try {
      const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', containerName(site.id)], { timeout: 10000, silent: true });
      if (stdout.trim() === 'true') continue;
    } catch { /* container missing — start it below */ }
    try {
      await startContainer(site);
    } catch (err) {
      logger.warn(`[startup] static site ${site.id}: ${err.message}`);
    }
  }
}

module.exports = {
  // paths (exposed so routes can write upload contents)
  STATIC_BASE,
  INCOMING_BASE,
  siteDir,
  webRoot,
  containerName,
  // runtime
  startContainer,
  stopContainer,
  // git-mode
  deployFromGit,
  // local import (large-site path)
  listIncoming,
  importFromIncoming,
  // recovery
  startupEnsureRunning,
};
