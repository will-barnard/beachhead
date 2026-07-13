#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const WORKER_ENV_PATH = path.join(__dirname, '.env');
const MANAGED_ENV_HEADER = '# Managed by beachhead-worker config';
const MANAGED_SERVER_KEY_RE = /^BEACHHEAD_SERVER_(\d+)_(URL|TOKEN|ENABLED)$/;

// ─── Configuration ──────────────────────────────────────────────────
const CONFIG_DEFAULTS = {
  pollInterval: 5000,
  workDir: path.join(os.tmpdir(), 'beachhead-worker'),
};

function loadConfig() {
  // Priority: env vars → config file → defaults
  const configPath = process.env.BEACHHEAD_CONFIG || path.join(os.homedir(), '.beachhead-worker.json');
  let file = {};
  if (fs.existsSync(configPath)) {
    try { file = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* ignore */ }
  }

  const workerId = process.env.BEACHHEAD_WORKER_ID || file.workerId || os.hostname();
  const pollInterval = parseInt(process.env.BEACHHEAD_POLL_INTERVAL || file.pollInterval || CONFIG_DEFAULTS.pollInterval, 10);
  const workDir = process.env.BEACHHEAD_WORK_DIR || file.workDir || CONFIG_DEFAULTS.workDir;

  const githubToken = process.env.GITHUB_TOKEN || file.githubToken || null;
  const buildPlatform = process.env.BEACHHEAD_BUILD_PLATFORM || file.buildPlatform || null;
  const sshPrivateKey = process.env.SSH_PRIVATE_KEY || file.sshPrivateKey || null;
  const insecureTls = process.env.BEACHHEAD_INSECURE_TLS === '1' || process.env.BEACHHEAD_INSECURE_TLS === 'true' || file.insecureTls === true;

  // ── Multi-server support ──────────────────────────────────────────
  // Priority:
  //   1. BEACHHEAD_URLS + BEACHHEAD_TOKENS  (comma-separated, .env-safe)
  //   2. BEACHHEAD_SERVERS                  (JSON array)
  //   3. config file `servers` array
  //   4. single BEACHHEAD_URL + BEACHHEAD_TOKEN (backwards compat)
  let servers = [];

  if (process.env.BEACHHEAD_URLS) {
    const urls = process.env.BEACHHEAD_URLS.split(',').map(s => s.trim()).filter(Boolean);
    const tokens = (process.env.BEACHHEAD_TOKENS || '').split(',').map(s => s.trim());
    if (urls.length !== tokens.filter(Boolean).length) die('BEACHHEAD_URLS and BEACHHEAD_TOKENS must have the same number of comma-separated entries');
    servers = urls.map((u, i) => ({ serverUrl: u.replace(/\/$/, ''), token: tokens[i] }));
  } else if (process.env.BEACHHEAD_SERVERS && process.env.BEACHHEAD_SERVERS.trim()) {
    let parsed;
    try { parsed = JSON.parse(process.env.BEACHHEAD_SERVERS); } catch { die('BEACHHEAD_SERVERS must be valid JSON'); }
    if (!Array.isArray(parsed)) die('BEACHHEAD_SERVERS must be a JSON array');
    servers = parsed.map(s => ({
      serverUrl: (s.url || s.serverUrl || '').replace(/\/$/, ''),
      token: s.token || '',
    })).filter(s => s.serverUrl && s.token);
    if (servers.length === 0) die('BEACHHEAD_SERVERS contained no valid entries (each needs url and token)');
  } else if (Array.isArray(file.servers) && file.servers.length > 0) {
    servers = file.servers.map(s => ({
      serverUrl: (s.url || s.serverUrl || '').replace(/\/$/, ''),
      token: s.token || '',
    })).filter(s => s.serverUrl && s.token);
    if (servers.length === 0) die('Config file `servers` array contained no valid entries');
  } else {
    // Single-server backwards compat
    const singleUrl = process.env.BEACHHEAD_URL || file.serverUrl;
    const singleToken = process.env.BEACHHEAD_TOKEN || file.token;
    if (!singleUrl) die('Missing BEACHHEAD_URL (or BEACHHEAD_URLS / BEACHHEAD_SERVERS in config file)');
    if (!singleToken) die('Missing BEACHHEAD_TOKEN (or BEACHHEAD_TOKENS / BEACHHEAD_SERVERS in config file)');
    servers = [{ serverUrl: singleUrl.replace(/\/$/, ''), token: singleToken }];
  }

  return { servers, workerId, pollInterval, workDir, githubToken, buildPlatform, sshPrivateKey, insecureTls };
}

// ─── Helpers ────────────────────────────────────────────────────────
function normalizeEnvValue(value) {
  const trimmed = (value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitCommaEnv(value) {
  return normalizeEnvValue(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function maskToken(token) {
  if (!token) return '<missing>';
  const tail = token.slice(-6);
  return `<hidden:${token.length}>...${tail}`;
}

function parseEnvAssignment(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separatorIndex = line.indexOf('=');
  if (separatorIndex === -1) return null;
  return {
    key: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 1),
  };
}

function loadWorkerEnvState(envPath = WORKER_ENV_PATH) {
  if (!fs.existsSync(envPath)) die(`Worker env file not found: ${envPath}`);

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const env = {};
  const managed = new Map();

  for (const line of lines) {
    const assignment = parseEnvAssignment(line);
    if (!assignment) continue;
    env[assignment.key] = normalizeEnvValue(assignment.value);

    const match = assignment.key.match(MANAGED_SERVER_KEY_RE);
    if (!match) continue;

    const index = Number.parseInt(match[1], 10);
    const field = match[2];
    const current = managed.get(index) || { url: '', token: '', enabled: true };
    if (field === 'URL') current.url = normalizeEnvValue(assignment.value).replace(/\/$/, '');
    if (field === 'TOKEN') current.token = normalizeEnvValue(assignment.value);
    if (field === 'ENABLED') current.enabled = /^(1|true|yes)$/i.test(normalizeEnvValue(assignment.value));
    managed.set(index, current);
  }

  let servers = [];
  if (managed.size > 0) {
    servers = Array.from(managed.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([, server]) => ({
        url: server.url,
        token: server.token,
        enabled: server.enabled !== false,
      }))
      .filter((server) => server.url || server.token);
  } else if (env.BEACHHEAD_URLS || env.BEACHHEAD_TOKENS) {
    const urls = splitCommaEnv(env.BEACHHEAD_URLS || '');
    const tokens = splitCommaEnv(env.BEACHHEAD_TOKENS || '');
    if (urls.length !== tokens.length) {
      die('BEACHHEAD_URLS and BEACHHEAD_TOKENS must have the same number of comma-separated entries in worker/.env');
    }
    servers = urls.map((url, index) => ({
      url: url.replace(/\/$/, ''),
      token: tokens[index],
      enabled: true,
    }));
  } else if (env.BEACHHEAD_URL || env.BEACHHEAD_TOKEN) {
    if (!env.BEACHHEAD_URL || !env.BEACHHEAD_TOKEN) {
      die('BEACHHEAD_URL and BEACHHEAD_TOKEN must both be set when using single-server worker config');
    }
    servers = [{
      url: env.BEACHHEAD_URL.replace(/\/$/, ''),
      token: env.BEACHHEAD_TOKEN,
      enabled: true,
    }];
  }

  return { envPath, lines, servers };
}

function saveWorkerEnvState(state) {
  const activeServers = state.servers.filter((server) => server.enabled && server.url && server.token);
  const urlLine = `BEACHHEAD_URLS=${activeServers.map((server) => server.url).join(',')}`;
  const tokenLine = `BEACHHEAD_TOKENS=${activeServers.map((server) => server.token).join(',')}`;
  const managedLines = [];

  if (state.servers.length > 0) {
    managedLines.push(MANAGED_ENV_HEADER);
    state.servers.forEach((server, index) => {
      const serverNumber = index + 1;
      managedLines.push(`BEACHHEAD_SERVER_${serverNumber}_URL=${server.url}`);
      managedLines.push(`BEACHHEAD_SERVER_${serverNumber}_TOKEN=${server.token}`);
      managedLines.push(`BEACHHEAD_SERVER_${serverNumber}_ENABLED=${server.enabled ? '1' : '0'}`);
    });
  }

  const nextLines = [];
  let wroteUrls = false;
  let wroteTokens = false;

  for (const line of state.lines) {
    if (line.trim() === MANAGED_ENV_HEADER) continue;

    const assignment = parseEnvAssignment(line);
    if (!assignment) {
      nextLines.push(line);
      continue;
    }

    if (MANAGED_SERVER_KEY_RE.test(assignment.key)) continue;

    if (assignment.key === 'BEACHHEAD_URLS') {
      if (!wroteUrls) {
        nextLines.push(urlLine);
        wroteUrls = true;
      }
      continue;
    }

    if (assignment.key === 'BEACHHEAD_TOKENS') {
      if (!wroteTokens) {
        nextLines.push(tokenLine);
        wroteTokens = true;
      }
      continue;
    }

    nextLines.push(line);
  }

  if (!wroteUrls) nextLines.push(urlLine);
  if (!wroteTokens) nextLines.push(tokenLine);

  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
    nextLines.pop();
  }

  if (managedLines.length > 0) {
    nextLines.push('');
    nextLines.push(...managedLines);
  }

  fs.writeFileSync(state.envPath, `${nextLines.join('\n')}\n`, 'utf8');
}

function resolveServerIndex(servers, selector) {
  if (!selector) die('Missing server selector. Use an index from `config list` or an exact URL.');

  if (/^\d+$/.test(selector)) {
    const index = Number.parseInt(selector, 10) - 1;
    if (index < 0 || index >= servers.length) die(`Server index out of range: ${selector}`);
    return index;
  }

  const normalized = selector.replace(/\/$/, '');
  const index = servers.findIndex((server) => server.url === normalized);
  if (index === -1) die(`No server matched: ${selector}`);
  return index;
}

function printManagedServers(state) {
  if (state.servers.length === 0) {
    console.log(`No worker servers configured in ${state.envPath}`);
    return;
  }

  console.log(`Worker servers in ${state.envPath}:`);
  state.servers.forEach((server, index) => {
    const marker = server.enabled ? 'on ' : 'off';
    console.log(`  ${index + 1}. [${marker}] ${server.url}  ${maskToken(server.token)}`);
  });
}

function printConfigUsage() {
  console.log(`
Worker env manager

Usage:
  beachhead-worker config list
  beachhead-worker config enable <index|url> [--rebuild]
  beachhead-worker config disable <index|url> [--rebuild]
  beachhead-worker config toggle <index|url> [--rebuild]
  beachhead-worker config add <url> <token> [--disabled] [--rebuild]
  beachhead-worker config remove <index|url> [--rebuild]
  beachhead-worker config rebuild

Notes:
  - The command edits worker/.env and keeps BEACHHEAD_URLS / BEACHHEAD_TOKENS in sync.
  - Per-server settings are stored as BEACHHEAD_SERVER_<n>_* lines so URLs and tokens stay paired.
  - Use --rebuild to run docker compose up -d --build beachhead-worker after saving.
  `);
}

function runStreamingCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', ...opts });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}`));
      } else {
        resolve();
      }
    });
    proc.on('error', reject);
  });
}

async function detectComposeCommand() {
  try {
    await runCmd('docker', ['compose', 'version']);
    return { cmd: 'docker', prefixArgs: ['compose'] };
  } catch {
    // Fall through.
  }

  try {
    await runCmd('docker-compose', ['version']);
    return { cmd: 'docker-compose', prefixArgs: [] };
  } catch {
    die('Neither `docker compose` nor `docker-compose` is available.');
  }
}

async function rebuildWorkerContainer() {
  const compose = await detectComposeCommand();
  log('Rebuilding beachhead-worker container...');
  await runStreamingCmd(compose.cmd, [...compose.prefixArgs, 'up', '-d', '--build', 'beachhead-worker'], { cwd: __dirname });
  log('beachhead-worker container rebuilt');
}

async function handleConfigCommand(rawArgs) {
  const rebuild = rawArgs.includes('--rebuild');
  const disabled = rawArgs.includes('--disabled');
  const args = rawArgs.filter((arg) => arg !== '--rebuild' && arg !== '--disabled');
  const subcommand = args[0] || 'list';

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printConfigUsage();
    return;
  }

  if (subcommand === 'rebuild') {
    await rebuildWorkerContainer();
    return;
  }

  const state = loadWorkerEnvState();

  if (subcommand === 'list') {
    printManagedServers(state);
    return;
  }

  if (subcommand === 'add') {
    const url = args[1];
    const token = args[2];
    if (!url || !token) die('Usage: beachhead-worker config add <url> <token> [--disabled] [--rebuild]');
    state.servers.push({
      url: url.replace(/\/$/, ''),
      token,
      enabled: !disabled,
    });
    saveWorkerEnvState(state);
    log(`Added worker server ${url}`);
    if (rebuild) await rebuildWorkerContainer();
    return;
  }

  if (subcommand === 'enable' || subcommand === 'disable' || subcommand === 'toggle' || subcommand === 'remove') {
    const selector = args[1];
    const index = resolveServerIndex(state.servers, selector);
    const server = state.servers[index];

    if (subcommand === 'remove') {
      state.servers.splice(index, 1);
      saveWorkerEnvState(state);
      log(`Removed worker server ${server.url}`);
      if (rebuild) await rebuildWorkerContainer();
      return;
    }

    if (subcommand === 'enable') server.enabled = true;
    if (subcommand === 'disable') server.enabled = false;
    if (subcommand === 'toggle') server.enabled = !server.enabled;

    saveWorkerEnvState(state);
    log(`${server.enabled ? 'Enabled' : 'Disabled'} worker server ${server.url}`);
    if (rebuild) await rebuildWorkerContainer();
    return;
  }

  die(`Unknown config command: ${subcommand}`);
}

/**
 * Minimal HTTP client using built-in node modules (no dependencies).
 * Returns { status, data }.
 */
function apiRequest(serverUrl, method, path, body, token, insecureTls = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const mod = url.protocol === 'https:' ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      ...(insecureTls ? { rejectUnauthorized: false } : {}),
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = mod.request(opts, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data = null;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`${cmd} exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on('error', reject);
  });
}

// ─── Build Job Processing ───────────────────────────────────────────

async function processJob(config, server, job) {
  const { serverUrl, token } = server;
  const { workDir } = config;
  const jobDir = path.join(workDir, `job-${job.id}`);

  try {
    // Clean up any stale directory
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    fs.mkdirSync(jobDir, { recursive: true });

    // Report BUILDING
    await apiRequest(serverUrl, 'POST', `/api/jobs/${job.id}/status`, {
      state: 'BUILDING',
      log: `Worker ${config.workerId} starting build for ${job.service}`,
    }, token, config.insecureTls);

    // Clone the repo
    let cloneUrl = job.repo_url;
    const isSsh = /^git@/i.test(cloneUrl);

    // For HTTPS GitHub repos, inject token to authenticate private repos
    if (!isSsh && config.githubToken && /^https:\/\/github\.com\//i.test(cloneUrl)) {
      cloneUrl = cloneUrl.replace('https://github.com/', `https://x-access-token:${config.githubToken}@github.com/`);
    }

    // For SSH repos, write the private key to a temp file and set GIT_SSH_COMMAND
    let sshKeyFile = null;
    let cloneEnv = {};
    if (isSsh && config.sshPrivateKey) {
      sshKeyFile = path.join(os.tmpdir(), `beachhead-ssh-${process.pid}-${job.id}`);
      // Ensure key ends with newline (required by OpenSSH)
      const keyContent = config.sshPrivateKey.replace(/\\n/g, '\n').trimEnd() + '\n';
      fs.writeFileSync(sshKeyFile, keyContent, { mode: 0o600 });
      cloneEnv = {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${sshKeyFile} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
      };
    }

    log(`  Cloning ${job.repo_url} (${job.branch})...`);
    try {
      await runCmd('git', ['clone', '--depth', '1', '--branch', job.branch, cloneUrl, '.'], {
        cwd: jobDir,
        ...(isSsh && sshKeyFile ? { env: cloneEnv } : {}),
      });
    } finally {
      if (sshKeyFile && fs.existsSync(sshKeyFile)) fs.unlinkSync(sshKeyFile);
    }

    // Determine build context and dockerfile relative to repo root
    const buildContext = path.join(jobDir, job.build_context || '.');
    const dockerfile = job.dockerfile || 'Dockerfile';
    const dockerfilePath = path.join(buildContext, dockerfile);

    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Dockerfile not found: ${dockerfile} in ${job.build_context || '.'}`);
    }

    // Build the image
    log(`  Building image ${job.image_tag}...`);
    const buildArgs = ['build', '-t', job.image_tag, '-f', dockerfilePath];
    if (config.buildPlatform) buildArgs.push('--platform', config.buildPlatform);
    buildArgs.push(buildContext);
    await runCmd('docker', buildArgs);

    // Report PUSHING
    await apiRequest(serverUrl, 'POST', `/api/jobs/${job.id}/status`, {
      state: 'PUSHING',
      log: `Pushing ${job.image_tag}`,
    }, token, config.insecureTls);

    // Docker login if registry credentials provided
    if (job.registry?.user && job.registry?.password) {
      const registryHost = job.image_tag.split('/')[0];
      log(`  Logging in to ${registryHost}...`);
      // Pipe password via stdin to avoid exposing it in process args
      await new Promise((resolve, reject) => {
        const proc = spawn('docker', ['login', registryHost, '-u', job.registry.user, '--password-stdin'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.stdin.write(job.registry.password);
        proc.stdin.end();
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker login exited with code ${code}`)));
        proc.on('error', reject);
      });
    }

    // Push the image
    log(`  Pushing ${job.image_tag}...`);
    await runCmd('docker', ['push', job.image_tag]);

    // Report SUCCESS
    await apiRequest(serverUrl, 'POST', `/api/jobs/${job.id}/complete`, {
      success: true,
      log: `Build and push successful: ${job.image_tag}`,
    }, token, config.insecureTls);

    log(`  Job #${job.id} completed successfully`);
  } catch (err) {
    log(`  Job #${job.id} failed: ${err.message}`);
    if (err.stderr) log(`  stderr (last 4000 chars): ${err.stderr.slice(-4000)}`);
    const logMsg = [err.message, (err.stderr || '').slice(-4000)].join('\n').slice(0, 8000);
    try {
      await apiRequest(serverUrl, 'POST', `/api/jobs/${job.id}/complete`, {
        success: false,
        log: logMsg,
      }, token, config.insecureTls);
    } catch {
      log(`  WARNING: Failed to report failure for job #${job.id}`);
    }
  } finally {
    // Clean up
    try {
      if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

// ─── Main Loop ──────────────────────────────────────────────────────

async function pollOnce(config) {
  const { workerId } = config;

  // First: claim one job from each server that has work pending (fast, sequential)
  const claimed = [];
  for (const server of config.servers) {
    try {
      const { status, data } = await apiRequest(server.serverUrl, 'POST', '/api/jobs/next', { worker_id: workerId }, server.token, config.insecureTls);
      if (status === 204 || !data || !data.id) continue;
      log(`Claimed job #${data.id} from ${server.serverUrl}: service="${data.service}" image="${data.image_tag}"`);
      claimed.push({ server, job: data });
    } catch (err) {
      log(`Poll error for ${server.serverUrl}: ${err.message}`);
    }
  }

  if (claimed.length === 0) return false;

  // Then: process all claimed jobs in parallel so a long build on one server
  // doesn't block work from another server.
  await Promise.all(claimed.map(({ server, job }) => processJob(config, server, job)));
  return true;
}

async function startLoop(config) {
  log(`Beachhead Worker starting`);
  if (config.servers.length === 1) {
    log(`  Server: ${config.servers[0].serverUrl}`);
  } else {
    log(`  Servers (${config.servers.length}):`);
    config.servers.forEach((s, i) => log(`    [${i + 1}] ${s.serverUrl}`));
  }
  log(`  Worker ID: ${config.workerId}`);
  log(`  Poll Interval: ${config.pollInterval}ms`);
  log(`  Work Dir: ${config.workDir}`);

  fs.mkdirSync(config.workDir, { recursive: true });

  while (true) {
    try {
      const hadJob = await pollOnce(config);
      // If we just finished a job, immediately check for another
      if (hadJob) continue;
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, config.pollInterval));
  }
}

// ─── CLI Entry Point ────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || 'start';

if (command === 'start') {
  const config = loadConfig();
  startLoop(config).catch((e) => die(e.message));
} else if (command === 'run-once') {
  const config = loadConfig();
  pollOnce(config).then((had) => {
    if (!had) log('No pending jobs');
    process.exit(0);
  }).catch((e) => die(e.message));
} else if (command === 'config') {
  handleConfigCommand(args.slice(1)).catch((e) => die(e.message));
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
beachhead-worker — Remote build worker for Beachhead PaaS

Usage:
  beachhead-worker start       Start the worker loop (default)
  beachhead-worker run-once    Process one job and exit
  beachhead-worker config      Manage worker/.env server entries and rebuild
  beachhead-worker help        Show this help

Configuration (env vars or ~/.beachhead-worker.json):
  BEACHHEAD_URL             Beachhead server URL (single server)
  BEACHHEAD_TOKEN           API token / JWT (single server)
  BEACHHEAD_SERVERS         JSON array for multiple servers (overrides URL/TOKEN)
  BEACHHEAD_WORKER_ID       Worker identifier (default: hostname)
  BEACHHEAD_POLL_INTERVAL   Poll interval in ms (default: 5000)
  BEACHHEAD_WORK_DIR        Temp directory for builds (default: /tmp/beachhead-worker)
  GITHUB_TOKEN              GitHub PAT for cloning private repos (needs repo read scope)
  BEACHHEAD_BUILD_PLATFORM  Target platform for docker build (e.g. linux/amd64, linux/arm64)

Multi-server example (BEACHHEAD_SERVERS env var):
  '[{"url":"https://bh1.example.com","token":"tok1"},{"url":"https://bh2.example.com","token":"tok2"}]'

Config file example (~/.beachhead-worker.json):
  {
    "servers": [
      { "url": "https://bh1.example.com", "token": "tok1" },
      { "url": "https://bh2.example.com", "token": "tok2" }
    ],
    "workerId": "builder-01"
  }

Env management examples:
  beachhead-worker config list
  beachhead-worker config disable 2 --rebuild
  beachhead-worker config enable https://bh1.example.com
  beachhead-worker config add https://bh3.example.com tok3 --disabled
  `);
} else {
  die(`Unknown command: ${command}. Run "beachhead-worker help" for usage.`);
}
