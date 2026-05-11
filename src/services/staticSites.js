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
 * Layout under config.deploy.baseDir:
 *
 *   static-sites/site-<id>/public/        ← what nginx serves (bind-mounted)
 *   static-sites-git/site-<id>/work/      ← clone + build dir (git mode only)
 *   static-sites-git/site-<id>/log        ← last deploy log (tail mirrored to db)
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
  fs.cpSync(sourceDir, staging, { recursive: true, dereference: false, errorOnExist: false });

  // Swap. rmSync the old, rename staging to target.
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  logSink(`Published ${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'} from ${subpath} → ${target}`);
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
  siteDir,
  webRoot,
  containerName,
  // runtime
  startContainer,
  stopContainer,
  // git-mode
  deployFromGit,
  // recovery
  startupEnsureRunning,
};
