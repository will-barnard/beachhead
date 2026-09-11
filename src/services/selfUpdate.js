/**
 * Self-update — rebuilds and restarts Beachhead itself from a dashboard
 * button, instead of SSHing in and running ./update.sh by hand.
 *
 * The tricky part: `docker compose up -d --build` on Beachhead's own stack
 * recreates the beachhead-api container itself. If that command ran inside
 * beachhead-api's own Node process, the process (and its container) would be
 * torn down mid-update — the classic "a service can't cleanly restart
 * itself from inside itself" problem.
 *
 * So instead this launches a short-lived SIBLING container (not part of the
 * beachhead-api process or the compose project's lifecycle) that does the
 * actual git pull + rebuild + restart, using the same docker.sock this
 * container already has mounted. It survives beachhead-api being recreated
 * partway through, and keeps running to completion as an independent
 * container. Its logs are read back afterwards with `docker logs` — no
 * extra log file or shared volume needed.
 *
 * The sidecar needs the beachhead repo checked out on the HOST (so
 * `docker compose build` uploads the right build context to the host
 * daemon, and so `git pull` writes back to the same checkout `update.sh`
 * would). Rather than requiring a new env var for that path, it's read off
 * the `com.docker.compose.project.working_dir` label Compose already
 * stamps on every container in the project — the exact host directory
 * docker-compose.yml lives in.
 */

const { exec } = require('./docker');
const config = require('../config');
const logger = require('../logger');

/**
 * The host path of the beachhead checkout, discovered from Compose's own
 * label on the running beachhead-api container (no new config needed).
 */
async function getRepoDir() {
  const { stdout } = await exec(
    'docker',
    ['inspect', '-f', '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}', config.selfUpdate.containerName],
    { timeout: 10000, silent: true }
  );
  const dir = stdout.trim();
  if (!dir) {
    throw new Error(`Could not determine the Beachhead repo directory from ${config.selfUpdate.containerName}'s Compose labels`);
  }
  return dir;
}

async function inspectUpdater() {
  const name = config.selfUpdate.updaterContainerName;
  try {
    const { stdout } = await exec(
      'docker',
      ['inspect', '-f', '{{.State.Running}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}', name],
      { timeout: 10000, silent: true }
    );
    const [runningStr, exitCodeStr, startedAt, finishedAt] = stdout.trim().split('|');
    return {
      exists: true,
      running: runningStr === 'true',
      exitCode: parseInt(exitCodeStr, 10),
      startedAt,
      finishedAt,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Kick off the update. Returns immediately once the sidecar is launched —
 * it does not wait for the update to finish (it can't: this very process's
 * container may be recreated partway through).
 */
async function startUpdate() {
  const existing = await inspectUpdater();
  if (existing.exists && existing.running) {
    throw new Error('An update is already in progress');
  }

  const repoDir = await getRepoDir();
  const name = config.selfUpdate.updaterContainerName;

  // Clear out any previous (finished) run so `docker logs` only ever shows
  // the most recent attempt.
  try {
    await exec('docker', ['rm', '-f', name], { timeout: 15000, silent: true });
  } catch { /* fine if it never existed */ }

  // alpine ships neither git, bash, nor a docker client — install them fresh
  // each run rather than maintaining a bespoke image. --network host so
  // update.sh's own `curl localhost:$API_PORT/api/health` check (written
  // assuming it runs directly on the host, same as when Will SSHes in and
  // runs it by hand) resolves correctly.
  const script = [
    'set -e',
    'echo "==> Installing update tooling (git, bash, docker CLI)..."',
    'apk add --no-cache git bash docker-cli docker-cli-compose curl >/dev/null',
    `cd '${repoDir}'`,
    'exec bash ./update.sh',
  ].join('\n');

  const args = [
    'run', '-d',
    '--name', name,
    '--network', 'host',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${repoDir}:${repoDir}`,
    '-w', repoDir,
    config.selfUpdate.updaterImage,
    'sh', '-c', script,
  ];

  await exec('docker', args, { timeout: 30000 });
  logger.info(`Self-update started (container ${name}, repo ${repoDir})`);
  return { started: true, repoDir };
}

/**
 * Current status + recent log output, for the dashboard to poll. Safe to
 * call at any point, including while beachhead-api itself is mid-restart
 * (the caller just won't get a response until the new container is up).
 */
async function getStatus() {
  const name = config.selfUpdate.updaterContainerName;
  const info = await inspectUpdater();

  if (!info.exists) {
    return { status: 'never_run', log: '' };
  }

  let log = '';
  try {
    const { stdout, stderr } = await exec('docker', ['logs', '--tail', '400', name], { timeout: 10000, silent: true });
    log = [stdout, stderr].filter(Boolean).join('\n');
  } catch { /* container may have just been removed */ }

  if (info.running) {
    return { status: 'running', startedAt: info.startedAt, log };
  }
  const status = info.exitCode === 0 ? 'success' : 'failed';
  return { status, exitCode: info.exitCode, startedAt: info.startedAt, finishedAt: info.finishedAt, log };
}

module.exports = {
  getRepoDir,
  startUpdate,
  getStatus,
};
