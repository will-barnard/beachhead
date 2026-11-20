/**
 * Disk maintenance — keeps a Beachhead host from slowly filling its disk.
 *
 * Every deploy builds fresh images under a new Compose project
 * (deploy-N), and nothing used to remove them: an instance that had been
 * deploying for a few months was found with 307 images, ~7 GB of them dead.
 * Host-level logs (systemd journal, old snap revisions, the apt cache) grow
 * the same way on a cloud VM's small boot disk.
 *
 * Three layers:
 *
 *   pruneDeployments(app, keep)
 *       Remove deploys beyond the newest `keep` successful ones (and every
 *       failed one), including the images they built. Kept deploys keep
 *       their images, so rollback to them still works without a rebuild.
 *       Runs automatically after every successful deploy, and from the
 *       dashboard's prune buttons.
 *
 *   dockerSweep()
 *       Daily. Images and stopped containers left behind by deploys that no
 *       longer exist in the database (older Beachhead versions never removed
 *       them), dangling images, and build cache older than a few days.
 *       Never touches running containers, paused apps (their deploy is still
 *       in the database), or volumes.
 *
 *   hostMaintenance()
 *       Daily, Linux hosts only. Caps the systemd journal, keeps two snap
 *       revisions and removes disabled ones, and empties the apt cache. Runs
 *       in a short-lived privileged sidecar that enters the host's
 *       namespaces — the same docker.sock access Beachhead already has, so
 *       no new privilege. Skipped on Docker Desktop, where the "host" is
 *       Docker's own VM.
 *
 * Container log rotation is not here: composeWrapper.applyRuntimeDefaults
 * already writes json-file max-size/max-file into every app override.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const db = require('../db');
const config = require('../config');
const logger = require('../logger');
const Settings = require('../models/settings');
const Deployments = require('../models/deployments');
const Apps = require('../models/apps');
const { exec, dockerComposeDown, stopComposeProject } = require('./docker');

const CHECK_EVERY_MS = 60 * 60 * 1000;       // look once an hour…
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;    // …run once a day
const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000;  // let startup reconcile settle first
const BUILD_CACHE_KEEP = '72h';
const HOST_SIDECAR_NAME = 'beachhead-host-maintenance';
const DEPLOY_PROJECT_RE = /^deploy-(\d+)$/;

const DEFAULTS = {
  enabled: true,
  keep_deploys: 2,
  host_enabled: true,
  journal_max: '200M',
};
const JOURNAL_RE = /^\d+[KMG]$/;

let timer = null;
let firstTimer = null;
let runningNow = false;

// ── Settings ──────────────────────────────────

async function getSettings() {
  const all = await Settings.getAll();
  const keep = parseInt(all.maintenance_keep_deploys, 10);
  return {
    enabled: all.maintenance_enabled !== 'false',
    keep_deploys: Number.isInteger(keep) && keep >= 1 ? keep : DEFAULTS.keep_deploys,
    host_enabled: all.maintenance_host_enabled !== 'false',
    journal_max: JOURNAL_RE.test(all.maintenance_journal_max || '') ? all.maintenance_journal_max : DEFAULTS.journal_max,
  };
}

async function saveSettings(input = {}) {
  if ('enabled' in input) await Settings.set('maintenance_enabled', input.enabled === false ? 'false' : 'true');
  if ('host_enabled' in input) await Settings.set('maintenance_host_enabled', input.host_enabled === false ? 'false' : 'true');
  if ('keep_deploys' in input) {
    const n = parseInt(input.keep_deploys, 10);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw badRequest('keep_deploys must be a whole number from 1 to 20');
    await Settings.set('maintenance_keep_deploys', String(n));
  }
  if ('journal_max' in input) {
    const v = String(input.journal_max || '').trim().toUpperCase();
    if (!JOURNAL_RE.test(v)) throw badRequest('journal_max must be a size like 200M or 1G');
    await Settings.set('maintenance_journal_max', v);
  }
  return getSettings();
}

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

// ── Deploy pruning ────────────────────────────

/**
 * Remove an app's deployments beyond the newest `keep` successful ones (plus
 * every failed one that isn't active): containers, the images they built,
 * the deploy directory and the database row.
 */
async function pruneDeployments(app, keep) {
  const prunable = await Deployments.findPrunableByAppId(app.id, app.active_deployment_id, keep);
  if (prunable.length === 0) return { pruned: 0, imagesRemoved: 0 };

  let imagesRemoved = 0;
  for (const deployId of prunable) {
    imagesRemoved += await removeDeploy(app.id, deployId);
  }
  await Deployments.deleteByIds(prunable);
  logger.info(`[maintenance] Pruned ${prunable.length} deployment(s) for ${app.name} (keeping ${keep}), ${imagesRemoved} image(s) removed`);
  return { pruned: prunable.length, imagesRemoved };
}

async function removeDeploy(appId, deployId) {
  const deployDir = path.join(config.deploy.baseDir, `app-${appId}`, `deploy-${deployId}`);
  const overridePath = path.join(deployDir, 'beachhead.override.yml');
  const project = `deploy-${deployId}`;

  // Registry images from remote builds carry a custom tag, so `--rmi local`
  // leaves them. Read them before the directory goes.
  const registryImages = readOverrideImages(overridePath);

  try {
    if (fs.existsSync(overridePath)) {
      await dockerComposeDown(deployDir, 'beachhead.override.yml', { removeImages: true });
    } else {
      await stopComposeProject(project);
    }
  } catch (err) {
    logger.warn(`[maintenance] compose down for ${project} failed: ${err.message} — removing by label`);
  }

  // Belt and braces: anything still labelled with this project (the override
  // was missing, or compose down failed part-way).
  await removeProjectContainers(project);
  let removed = await removeProjectImages(project);
  for (const ref of registryImages) {
    if (await removeImage(ref)) removed++;
  }

  if (fs.existsSync(deployDir)) fs.rmSync(deployDir, { recursive: true, force: true });
  return removed;
}

function readOverrideImages(overridePath) {
  try {
    const doc = yaml.load(fs.readFileSync(overridePath, 'utf8'));
    return Object.values(doc?.services || {}).map((s) => s?.image).filter((i) => typeof i === 'string' && i);
  } catch {
    return [];
  }
}

async function removeProjectContainers(project) {
  const ids = await lines('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
  if (ids.length) await quiet('docker', ['rm', '-f', ...ids]);
  return ids.length;
}

async function removeProjectImages(project) {
  const ids = [...new Set(await lines('docker', ['image', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]))];
  let removed = 0;
  for (const id of ids) if (await removeImage(id)) removed++;
  return removed;
}

// Not forced: an image a container still uses stays, which is the point.
async function removeImage(ref) {
  try {
    await exec('docker', ['image', 'rm', ref], { timeout: 60000, silent: true });
    return true;
  } catch {
    return false;
  }
}

/** Called by the worker after a deploy succeeds. Never throws. */
async function autoPruneAfterDeploy(app) {
  try {
    const s = await getSettings();
    if (!s.enabled) return;
    const fresh = (await Apps.findById(app.id)) || app;
    await pruneDeployments(fresh, s.keep_deploys);
  } catch (err) {
    logger.warn(`[maintenance] Auto-prune after deploy failed for ${app.name}: ${err.message}`);
  }
}

// ── Docker sweep ──────────────────────────────

async function dockerSweep() {
  const result = { orphanDeploys: 0, containersRemoved: 0, imagesRemoved: 0, danglingReclaimed: null, buildCacheReclaimed: null };

  // Deploy projects that no longer exist in the database. Older Beachhead
  // versions deleted the row and directory but left images and, sometimes,
  // stopped containers. Every deploy that still has a row is left alone —
  // that includes paused apps and kept rollback targets.
  const { rows } = await db.query('SELECT id FROM deployments');
  const known = new Set(rows.map((r) => String(r.id)));

  const ctrs = await lines('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{.ID}} {{.State}} {{.Label "com.docker.compose.project"}}']);
  const orphanProjects = new Set();
  for (const line of ctrs) {
    const [id, state, project] = line.split(' ');
    const m = DEPLOY_PROJECT_RE.exec(project || '');
    if (!m || known.has(m[1])) continue;
    orphanProjects.add(project);
    if (state === 'running') continue; // a running orphan is someone's problem, not a sweep's
    if (await quiet('docker', ['rm', id])) result.containersRemoved++;
  }

  // `docker image ls --format` can't print labels; inspect can.
  const imgIds = [...new Set(await lines('docker', ['image', 'ls', '-q', '--filter', 'label=com.docker.compose.project']))];
  const imgs = imgIds.length
    ? await lines('docker', ['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "com.docker.compose.project"}}', ...imgIds])
    : [];
  const seen = new Set();
  for (const line of imgs) {
    const [id, project] = line.split(' ');
    const m = DEPLOY_PROJECT_RE.exec(project || '');
    if (!m || known.has(m[1]) || seen.has(id)) continue;
    seen.add(id);
    orphanProjects.add(project);
    if (await removeImage(id)) result.imagesRemoved++;
  }
  result.orphanDeploys = orphanProjects.size;

  result.danglingReclaimed = await reclaimed('docker', ['image', 'prune', '-f']);
  // Keep recent cache so the next deploy of an active app stays fast.
  result.buildCacheReclaimed = await reclaimed('docker', ['builder', 'prune', '-f', '--filter', `until=${BUILD_CACHE_KEEP}`]);
  return result;
}

// ── Host maintenance ──────────────────────────

/**
 * POSIX sh, run as root in the host's mount/pid/uts/ipc/net namespaces.
 * Idempotent: a second run changes nothing that the first one set.
 */
const HOST_SCRIPT = `
JMAX="\${JOURNAL_MAX:-200M}"

echo "==> systemd journal"
if command -v journalctl >/dev/null 2>&1 && [ -d /etc/systemd ]; then
  conf=/etc/systemd/journald.conf.d/50-beachhead.conf
  want="$(printf '# Managed by Beachhead disk maintenance\\n[Journal]\\nSystemMaxUse=%s' "$JMAX")"
  if [ "$(cat "$conf" 2>/dev/null)" != "$want" ]; then
    mkdir -p /etc/systemd/journald.conf.d
    printf '%s\\n' "$want" > "$conf"
    systemctl restart systemd-journald && echo "capped at $JMAX"
  else
    echo "already capped at $JMAX"
  fi
  journalctl --vacuum-size="$JMAX" 2>&1 | tail -n 1
  journalctl --disk-usage 2>&1
else
  echo "skipped (no journald)"
fi

echo "==> snap"
if command -v snap >/dev/null 2>&1; then
  snap set system refresh.retain=2 && echo "keeping 2 revisions per snap"
  n=0
  for pair in $(snap list --all 2>/dev/null | awk '/disabled/{print $1 "@" $3}'); do
    if snap remove "\${pair%@*}" --revision="\${pair#*@}" >/dev/null 2>&1; then
      echo "removed \${pair%@*} revision \${pair#*@}"
      n=$((n + 1))
    fi
  done
  echo "$n old revision(s) removed"
else
  echo "skipped (no snapd)"
fi

echo "==> package cache"
if command -v apt-get >/dev/null 2>&1; then
  apt-get clean && echo "apt cache cleared"
elif command -v dnf >/dev/null 2>&1; then
  dnf clean packages -q && echo "dnf cache cleared"
else
  echo "skipped"
fi

echo "==> disk"
df -h / | tail -n 1
`;

// The sidecar decodes the script, then hands it to the host's own /bin/sh.
// nsenter is in alpine's busybox; util-linux is the fallback.
const SIDECAR_CMD = [
  'command -v nsenter >/dev/null 2>&1 || apk add --no-cache util-linux >/dev/null',
  'S="$(printf %s "$SCRIPT_B64" | base64 -d)"',
  'exec nsenter -t 1 -m -u -i -n -p -- /bin/sh -c "$S"',
].join('; ');

async function isDockerDesktop() {
  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{.OperatingSystem}}'], { timeout: 15000, silent: true });
    return /docker desktop/i.test(stdout);
  } catch {
    return true; // can't tell — don't reach into a host we can't identify
  }
}

async function hostMaintenance(settings) {
  if (await isDockerDesktop()) return { skipped: 'Docker Desktop — the host is Docker\'s own VM' };

  await quiet('docker', ['rm', '-f', HOST_SIDECAR_NAME]);
  const { stdout, stderr } = await exec('docker', [
    'run', '--rm',
    '--name', HOST_SIDECAR_NAME,
    '--privileged', '--pid=host',
    '-e', `SCRIPT_B64=${Buffer.from(HOST_SCRIPT).toString('base64')}`,
    '-e', `JOURNAL_MAX=${settings.journal_max}`,
    config.selfUpdate.updaterImage,
    'sh', '-c', SIDECAR_CMD,
  ], { timeout: 300000 });
  return { output: `${stdout || ''}${stderr || ''}`.trim() };
}

// ── Orchestration ─────────────────────────────

/**
 * One full pass. `reason` is 'schedule' or 'manual'. Each part fails on its
 * own so one broken step never hides the others' results.
 */
async function runAll(reason = 'manual') {
  if (runningNow) throw Object.assign(new Error('Maintenance is already running'), { status: 409 });
  runningNow = true;
  const startedAt = new Date().toISOString();
  const result = { reason, startedAt };
  try {
    const settings = await getSettings();

    result.deploys = await step(async () => {
      const apps = await Apps.findAll();
      let pruned = 0;
      let imagesRemoved = 0;
      for (const app of apps) {
        const r = await pruneDeployments(app, settings.keep_deploys);
        pruned += r.pruned;
        imagesRemoved += r.imagesRemoved;
      }
      return { keep: settings.keep_deploys, pruned, imagesRemoved };
    });
    result.docker = await step(dockerSweep);
    result.host = settings.host_enabled
      ? await step(() => hostMaintenance(settings))
      : { skipped: 'turned off in settings' };

    result.finishedAt = new Date().toISOString();
    await Settings.set('maintenance_last_run_at', result.finishedAt);
    await Settings.set('maintenance_last_result', JSON.stringify(result));
    logger.info(`[maintenance] ${reason} run complete: ${summarize(result)}`);
    return result;
  } finally {
    runningNow = false;
  }
}

/**
 * Start a manual run in the background and return straight away — a host
 * pass with snap revisions to remove can outlast nginx-proxy's 60s timeout.
 * Poll getStatus() for `running` and `lastResult`.
 */
function startRun(reason = 'manual') {
  if (runningNow) throw Object.assign(new Error('Maintenance is already running'), { status: 409 });
  runAll(reason).catch((err) => logger.warn(`[maintenance] ${reason} run failed: ${err.message}`));
  return { started: true };
}

async function step(fn) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[maintenance] step failed: ${err.message}`);
    return { error: err.message };
  }
}

function summarize(r) {
  const parts = [];
  if (r.deploys && !r.deploys.error) parts.push(`${r.deploys.pruned} deploy(s) pruned`);
  if (r.docker && !r.docker.error) parts.push(`${r.docker.imagesRemoved} orphan image(s)`);
  if (r.host?.skipped) parts.push(`host skipped (${r.host.skipped})`);
  else if (r.host && !r.host.error) parts.push('host cleaned');
  return parts.join(', ') || 'see result';
}

async function getStatus() {
  const [settings, lastRunAt, lastResult] = await Promise.all([
    getSettings(),
    Settings.get('maintenance_last_run_at'),
    Settings.get('maintenance_last_result'),
  ]);
  let parsed = null;
  try { parsed = lastResult ? JSON.parse(lastResult) : null; } catch { parsed = null; }
  return {
    settings,
    running: runningNow,
    lastRunAt,
    lastResult: parsed,
    nextRunAt: settings.enabled && lastRunAt ? new Date(Date.parse(lastRunAt) + RUN_EVERY_MS).toISOString() : null,
    dockerDesktop: await isDockerDesktop(),
  };
}

// ── Scheduler ─────────────────────────────────

async function deployInFlight() {
  const { rows } = await db.query(`SELECT 1 FROM deployments WHERE state NOT IN ('SUCCESS', 'FAILED') LIMIT 1`);
  return rows.length > 0;
}

async function checkSchedule() {
  try {
    const s = await getSettings();
    if (!s.enabled || runningNow) return;
    const last = Date.parse((await Settings.get('maintenance_last_run_at')) || '') || 0;
    if (Date.now() - last < RUN_EVERY_MS) return;
    // Pruning cache or images mid-build is asking for a confusing failure.
    if (await deployInFlight()) return;
    await runAll('schedule');
  } catch (err) {
    logger.warn(`[maintenance] scheduled run failed: ${err.message}`);
  }
}

function start() {
  if (timer) return;
  firstTimer = setTimeout(checkSchedule, FIRST_CHECK_DELAY_MS);
  firstTimer.unref();
  timer = setInterval(checkSchedule, CHECK_EVERY_MS);
  timer.unref();
}

function stop() {
  clearTimeout(firstTimer);
  clearInterval(timer);
  timer = null;
}

// ── helpers ───────────────────────────────────

async function lines(cmd, args) {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 60000, silent: true });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function quiet(cmd, args) {
  try {
    await exec(cmd, args, { timeout: 60000, silent: true });
    return true;
  } catch {
    return false;
  }
}

async function reclaimed(cmd, args) {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 300000, silent: true });
    const m = stdout.match(/Total(?: reclaimed space)?:\s*(.+)/i);
    return m ? m[1].trim() : '0B';
  } catch (err) {
    return `failed: ${err.message.split('\n')[0]}`;
  }
}

module.exports = {
  start,
  stop,
  runAll,
  startRun,
  getStatus,
  getSettings,
  saveSettings,
  pruneDeployments,
  autoPruneAfterDeploy,
  dockerSweep,
  HOST_SCRIPT,
  SIDECAR_CMD,
};
