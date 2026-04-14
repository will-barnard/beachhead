#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

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

  const serverUrl = process.env.BEACHHEAD_URL || file.serverUrl;
  const token = process.env.BEACHHEAD_TOKEN || file.token;
  const workerId = process.env.BEACHHEAD_WORKER_ID || file.workerId || os.hostname();
  const pollInterval = parseInt(process.env.BEACHHEAD_POLL_INTERVAL || file.pollInterval || CONFIG_DEFAULTS.pollInterval, 10);
  const workDir = process.env.BEACHHEAD_WORK_DIR || file.workDir || CONFIG_DEFAULTS.workDir;

  if (!serverUrl) die('Missing BEACHHEAD_URL (or serverUrl in config file)');
  if (!token) die('Missing BEACHHEAD_TOKEN (or token in config file)');

  return { serverUrl: serverUrl.replace(/\/$/, ''), token, workerId, pollInterval, workDir };
}

// ─── Helpers ────────────────────────────────────────────────────────
function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Minimal HTTP client using built-in node modules (no dependencies).
 * Returns { status, data }.
 */
function apiRequest(serverUrl, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const mod = url.protocol === 'https:' ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
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

async function processJob(config, job) {
  const { serverUrl, token, workDir } = config;
  const jobDir = path.join(workDir, `job-${job.id}`);

  try {
    // Clean up any stale directory
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    fs.mkdirSync(jobDir, { recursive: true });

    // Report BUILDING
    await apiRequest(serverUrl, 'POST', `/api/jobs/${job.id}/status`, {
      state: 'BUILDING',
      log: `Worker ${config.workerId} starting build for ${job.service}`,
    }, token);

    // Clone the repo
    log(`  Cloning ${job.repo_url} (${job.branch})...`);
    await runCmd('git', ['clone', '--depth', '1', '--branch', job.branch, job.repo_url, '.'], { cwd: jobDir });

    // Determine build context and dockerfile relative to repo root
    const buildContext = path.join(jobDir, job.build_context || '.');
    const dockerfile = job.dockerfile || 'Dockerfile';
    const dockerfilePath = path.join(buildContext, dockerfile);

    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Dockerfile not found: ${dockerfile} in ${job.build_context || '.'}`);
    }

    // Build the image
    log(`  Building image ${job.image_tag}...`);
    await runCmd('docker', [
      'build',
      '-t', job.image_tag,
      '-f', dockerfilePath,
      buildContext,
    ]);

    // Report PUSHING
    await apiRequest(serverUrl, 'POST', `/api/jobs/${job.id}/status`, {
      state: 'PUSHING',
      log: `Pushing ${job.image_tag}`,
    }, token);

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
    }, token);

    log(`  Job #${job.id} completed successfully`);
  } catch (err) {
    log(`  Job #${job.id} failed: ${err.message}`);
    const logMsg = [err.message, err.stderr || ''].join('\n').slice(0, 4000);
    try {
      await apiRequest(serverUrl, 'POST', `/api/jobs/${job.id}/complete`, {
        success: false,
        log: logMsg,
      }, token);
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
  const { serverUrl, token, workerId } = config;

  const { status, data } = await apiRequest(serverUrl, 'POST', '/api/jobs/next', { worker_id: workerId }, token);

  if (status === 204 || !data || !data.id) {
    return false; // no jobs
  }

  log(`Claimed job #${data.id}: service="${data.service}" image="${data.image_tag}"`);
  await processJob(config, data);
  return true;
}

async function startLoop(config) {
  log(`Beachhead Worker starting`);
  log(`  Server: ${config.serverUrl}`);
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
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
beachhead-worker — Remote build worker for Beachhead PaaS

Usage:
  beachhead-worker start       Start the worker loop (default)
  beachhead-worker run-once    Process one job and exit
  beachhead-worker help        Show this help

Configuration (env vars or ~/.beachhead-worker.json):
  BEACHHEAD_URL           Beachhead server URL (required)
  BEACHHEAD_TOKEN         API token / JWT (required)
  BEACHHEAD_WORKER_ID     Worker identifier (default: hostname)
  BEACHHEAD_POLL_INTERVAL Poll interval in ms (default: 5000)
  BEACHHEAD_WORK_DIR      Temp directory for builds (default: /tmp/beachhead-worker)

Config file example (~/.beachhead-worker.json):
  {
    "serverUrl": "https://beachhead.example.com",
    "token": "your-jwt-token",
    "workerId": "builder-01"
  }
  `);
} else {
  die(`Unknown command: ${command}. Run "beachhead-worker help" for usage.`);
}
