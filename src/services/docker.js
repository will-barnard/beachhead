const { execFile } = require('child_process');
const logger = require('../logger');

/**
 * Execute a command safely and return { stdout, stderr, exitCode }.
 * Uses execFile to avoid shell injection.
 */
function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // Only pass essential env vars to subprocesses — don't leak DATABASE_URL, secrets, etc.
    const safeEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      DOCKER_HOST: process.env.DOCKER_HOST,
      COMPOSE_BAKE: 'false',   // disable buildx bake (requires buildx, exits 255 without it)
      ...options.env,
    };

    const opts = {
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: options.timeout || 300000, // 5 min default
      cwd: options.cwd,
      env: safeEnv,
    };

    execFile(command, args, opts, (err, stdout, stderr) => {
      if (err) {
        logger.error(`Command failed: ${command} ${args.join(' ')}`, {
          exitCode: err.code,
          stderr: stderr?.slice(0, 2000),
        });
        return reject(new Error(`${command} failed: ${stderr || err.message}`));
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}

/**
 * Git clone a repository.
 */
async function gitClone(repoUrl, branch, destDir) {
  await exec('git', ['clone', '--depth', '1', '--branch', branch, '--', repoUrl, destDir]);
}

/**
 * Docker compose build.
 */
async function dockerComposeBuild(cwd, overrideFile) {
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (overrideFile) args.push('-f', overrideFile);
  args.push('build');
  await exec('docker', args, { cwd, timeout: 600000 }); // 10 min for builds
}

/**
 * Docker compose up.
 * Pass `services` to only start specific services (used to exclude stateful singletons).
 * When a services list is given, --no-deps prevents Docker Compose from starting
 * unlisted dependency services (e.g. postgres via depends_on) — stateful services
 * are already managed separately and must not be started by the transient project.
 */
async function dockerComposeUp(cwd, overrideFile, services = []) {
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (overrideFile) args.push('-f', overrideFile);
  args.push('up', '-d', '--build');
  if (services.length > 0) {
    args.push('--no-deps'); // stateful services managed separately
    args.push(...services);
  }
  await exec('docker', args, { cwd, timeout: 600000 });
}

/**
 * Stop any running containers that have a specific named volume mounted.
 * Called before starting a stateful service for the first time to migrate it
 * from an unmanaged per-deploy container to the fixed stateful project.
 * Returns the number of containers stopped.
 */
async function stopContainersUsingVolume(volumeName) {
  try {
    const { stdout } = await exec('docker', ['ps', '--filter', `volume=${volumeName}`, '--format', '{{.Names}}'], { timeout: 10000 });
    const containers = stdout.trim().split('\n').filter(Boolean);
    for (const name of containers) {
      logger.warn(`Stopping container '${name}' holding volume '${volumeName}' — migrating to stateful project (one-time)`);
      try {
        await exec('docker', ['stop', name], { timeout: 30000 });
      } catch (e) {
        logger.warn(`Could not stop container '${name}': ${e.message}`);
      }
    }
    return containers.length;
  } catch {
    return 0;
  }
}

/**
 * Docker compose up for stateful singleton services (e.g. postgres).
 * Uses a fixed project name so the containers survive across deploys and are
 * never recreated by the per-deploy blue/green swap.
 *
 * --no-recreate: if the container is already running, leave it untouched.
 * --wait:        block until the service's healthcheck passes before returning,
 *                so transient services (backend) start after the DB is ready.
 */
async function dockerComposeUpStateful(cwd, projectName, services, overrideFile) {
  if (!services || services.length === 0) return;
  const args = ['compose', '-p', projectName, '-f', 'docker-compose.yml'];
  if (overrideFile) args.push('-f', overrideFile);
  args.push('up', '-d', '--no-recreate', '--wait', ...services);
  await exec('docker', args, { cwd, timeout: 120000 }); // 2 min — just waiting for healthcheck
}

/**
 * Docker compose down (for cleanup / rollback).
 */
async function dockerComposeDown(cwd, overrideFile) {
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (overrideFile) args.push('-f', overrideFile);
  args.push('down', '--remove-orphans');
  await exec('docker', args, { cwd, timeout: 120000 });
}

/**
 * Capture docker compose logs (best-effort, for debugging failed deploys).
 * Falls back to docker logs for individual containers if compose logs fails.
 */
async function dockerComposeLogs(cwd, overrideFile) {
  // Try compose logs first
  try {
    const args = ['compose', '-f', 'docker-compose.yml'];
    if (overrideFile) args.push('-f', overrideFile);
    args.push('logs', '--no-color', '--tail', '100');
    const { stdout, stderr } = await exec('docker', args, { cwd, timeout: 15000 });
    const output = (stdout || '') + (stderr || '');
    if (output.trim()) return output;
  } catch {
    // compose logs failed — fall through to container-level fallback
  }

  // Fallback: list running containers from the project and get logs individually
  try {
    const args = ['compose', '-f', 'docker-compose.yml'];
    if (overrideFile) args.push('-f', overrideFile);
    args.push('ps', '-a', '--format', '{{.Name}}');
    const { stdout } = await exec('docker', args, { cwd, timeout: 10000 });
    const containers = (stdout || '').trim().split('\n').filter(Boolean);
    const logs = [];
    for (const name of containers) {
      try {
        const result = await exec('docker', ['logs', '--tail', '50', name], { timeout: 10000 });
        logs.push(`=== ${name} ===\n${(result.stdout || '') + (result.stderr || '')}`);
      } catch {
        logs.push(`=== ${name} === (failed to get logs)`);
      }
    }
    return logs.join('\n') || '(no container logs found)';
  } catch (err) {
    return `(failed to capture logs: ${err.message})`;
  }
}

/**
 * Ensure Docker network exists.
 */
async function ensureNetwork(networkName) {
  try {
    await exec('docker', ['network', 'inspect', networkName]);
  } catch {
    logger.info(`Creating Docker network: ${networkName}`);
    await exec('docker', ['network', 'create', networkName]);
  }
}

/**
 * Docker compose up with --force-recreate for a specific service, no rebuild.
 * Used to apply updated env vars (e.g. VIRTUAL_HOST/LETSENCRYPT_HOST) without a full redeploy.
 */
async function dockerComposeRecreate(cwd, overrideFile, serviceName) {
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (overrideFile) args.push('-f', overrideFile);
  args.push('up', '-d', '--force-recreate', '--no-build', serviceName);
  await exec('docker', args, { cwd, timeout: 120000 });
}

/**
 * Docker compose up without building — restarts existing images.
 * Used for rollbacks where the images are already in the local Docker cache.
 * Mirrors dockerComposeUp but omits --build so no rebuild is attempted.
 */
async function dockerComposeUpNoBuild(cwd, overrideFile, services = []) {
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (overrideFile) args.push('-f', overrideFile);
  args.push('up', '-d', '--no-build');
  if (services.length > 0) {
    args.push('--no-deps');
    args.push(...services);
  }
  await exec('docker', args, { cwd, timeout: 300000 });
}

module.exports = {
  exec,
  gitClone,
  dockerComposeBuild,
  dockerComposeUp,
  dockerComposeUpNoBuild,
  dockerComposeUpStateful,
  stopContainersUsingVolume,
  dockerComposeDown,
  dockerComposeLogs,
  dockerComposeRecreate,
  ensureNetwork,
};
