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
 */
async function dockerComposeUp(cwd, overrideFile) {
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (overrideFile) args.push('-f', overrideFile);
  args.push('up', '-d', '--build');
  await exec('docker', args, { cwd, timeout: 600000 });
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

module.exports = {
  exec,
  gitClone,
  dockerComposeBuild,
  dockerComposeUp,
  dockerComposeDown,
  dockerComposeLogs,
  dockerComposeRecreate,
  ensureNetwork,
};
