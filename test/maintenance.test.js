/*
 * Tests for disk maintenance: deploy pruning (images included), the orphan
 * sweep's idea of what is safe to remove, settings validation, and the host
 * script's syntax.
 *
 * Run: node test/maintenance.test.js   (also part of `npm test`)
 *
 * No database, no Docker — docker exec, the db and the models are replaced
 * with in-memory fakes through require.cache before the module loads.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-maint-'));
process.env.DEPLOY_BASE_DIR = baseDir;

// ── fakes ──

const calls = [];
let dockerState;
function resetDocker() {
  calls.length = 0;
  dockerState = {
    containers: [
      'c1 running deploy-10',     // active deploy
      'c2 exited deploy-5',       // paused app — deploy still in the DB
      'c3 exited deploy-3',       // orphan, stopped → remove
      'c4 running deploy-2',      // orphan but running → leave
      'c5 exited shop-stateful',  // not a deploy project → leave
    ],
    images: {
      'sha:i10': 'deploy-10',
      'sha:i3': 'deploy-3',
      'sha:i3b': 'deploy-3',
      'sha:i2': 'deploy-2',
      'sha:s': 'shop-stateful',
    },
    inUse: new Set(['sha:i2']),
  };
}

async function fakeExec(cmd, args) {
  calls.push([cmd, ...args].join(' '));
  const a = args.join(' ');
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  if (a.startsWith('ps -a --filter label=com.docker.compose.project --format')) return ok(dockerState.containers.join('\n'));
  if (a.startsWith('ps -aq --filter label=com.docker.compose.project=')) {
    const project = a.split('=').pop();
    return ok(dockerState.containers.filter((c) => c.endsWith(` ${project}`)).map((c) => c.split(' ')[0]).join('\n'));
  }
  if (a === 'image ls -q --filter label=com.docker.compose.project') return ok(Object.keys(dockerState.images).join('\n'));
  if (a.startsWith('image ls -q --filter label=com.docker.compose.project=')) {
    const project = a.split('=').pop();
    return ok(Object.entries(dockerState.images).filter(([, p]) => p === project).map(([id]) => id).join('\n'));
  }
  if (a.startsWith('image inspect')) {
    const ids = args.slice(3);
    return ok(ids.map((id) => `${id} ${dockerState.images[id]}`).join('\n'));
  }
  if (a.startsWith('image rm ')) {
    if (dockerState.inUse.has(args[2])) throw new Error('image is being used by running container');
    return ok();
  }
  if (a === 'image prune -f') return ok('Total reclaimed space: 0B');
  if (a.startsWith('builder prune')) return ok('Total:\t1.2GB');
  return ok();
}

const composeDowns = [];
const stopped = [];
const FakeDocker = {
  exec: fakeExec,
  async dockerComposeDown(cwd, override, opts) { composeDowns.push({ cwd, override, opts }); },
  async stopComposeProject(p) { stopped.push(p); return 1; },
  RUN_LOG_OPTS: [],
};

const settingsStore = {};
const FakeSettings = {
  async get(k) { return settingsStore[k] ?? null; },
  async set(k, v) { settingsStore[k] = v; },
  async getAll() { return { ...settingsStore }; },
};

let deletedIds = [];
const FakeDeployments = {
  async findPrunableByAppId() { return [7, 8]; },
  async deleteByIds(ids) { deletedIds = ids; return ids.length; },
};
const FakeApps = { async findAll() { return []; }, async findById() { return null; } };
const FakeDb = { async query(sql) { return { rows: /FROM deployments/.test(sql) ? [{ id: 10 }, { id: 9 }, { id: 5 }] : [] }; } };
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('src/services/docker.js', FakeDocker);
stub('src/models/settings.js', FakeSettings);
stub('src/models/deployments.js', FakeDeployments);
stub('src/models/apps.js', FakeApps);
stub('src/db/index.js', FakeDb);
stub('src/logger.js', silent);

const maintenance = require('../src/services/maintenance');

// ── tests ──

check('sweep removes stopped containers and images of deploys no longer in the DB, nothing else', async () => {
  resetDocker();
  const r = await maintenance.dockerSweep();
  const rms = calls.filter((c) => c.startsWith('docker rm '));
  assert.deepStrictEqual(rms, ['docker rm c3'], 'only the stopped orphan container goes');
  const imgRms = calls.filter((c) => c.startsWith('docker image rm ')).map((c) => c.split(' ').pop()).sort();
  assert.deepStrictEqual(imgRms, ['sha:i2', 'sha:i3', 'sha:i3b'], 'never tries kept deploys or non-deploy projects');
  assert.strictEqual(r.imagesRemoved, 2, 'the in-use image is not counted');
  assert.strictEqual(r.containersRemoved, 1);
  assert.strictEqual(r.orphanDeploys, 2);
  assert.strictEqual(r.buildCacheReclaimed, '1.2GB');
  assert.ok(calls.some((c) => c.includes('builder prune -f --filter until=72h')), 'build cache keeps recent layers');
  assert.ok(!calls.some((c) => /volume/.test(c)), 'volumes are never touched');
});

check('pruning a deploy removes its images and directory; kept deploys are not passed in', async () => {
  resetDocker();
  composeDowns.length = 0; stopped.length = 0;
  const d7 = path.join(baseDir, 'app-1', 'deploy-7');
  const d8 = path.join(baseDir, 'app-1', 'deploy-8');
  fs.mkdirSync(d7, { recursive: true });
  fs.mkdirSync(d8, { recursive: true });
  fs.writeFileSync(path.join(d7, 'beachhead.override.yml'), 'services:\n  backend:\n    image: ghcr.io/will/app-backend:d7\n  frontend:\n    container_name: x\n');
  dockerState.images['sha:old7'] = 'deploy-7';

  const r = await maintenance.pruneDeployments({ id: 1, name: 'app', active_deployment_id: 10 }, 2);

  assert.strictEqual(r.pruned, 2);
  assert.deepStrictEqual(deletedIds, [7, 8]);
  assert.strictEqual(composeDowns.length, 1, 'compose down only where an override exists');
  assert.deepStrictEqual(composeDowns[0].opts, { removeImages: true });
  assert.deepStrictEqual(stopped, ['deploy-8'], 'label-based stop when the override is missing');
  assert.ok(calls.includes('docker image rm ghcr.io/will/app-backend:d7'), 'registry images from remote builds go too');
  assert.ok(calls.includes('docker image rm sha:old7'), 'label fallback catches what compose left');
  assert.ok(!fs.existsSync(d7) && !fs.existsSync(d8), 'deploy directories removed');
});

check('settings: defaults, validation, round-trip', async () => {
  for (const k of Object.keys(settingsStore)) delete settingsStore[k];
  assert.deepStrictEqual(await maintenance.getSettings(), { enabled: true, keep_deploys: 2, host_enabled: true, journal_max: '200M' });
  await assert.rejects(maintenance.saveSettings({ keep_deploys: 0 }), /keep_deploys/);
  await assert.rejects(maintenance.saveSettings({ journal_max: 'lots' }), /journal_max/);
  const s = await maintenance.saveSettings({ enabled: false, keep_deploys: '3', journal_max: '500m', host_enabled: false });
  assert.deepStrictEqual(s, { enabled: false, keep_deploys: 3, host_enabled: false, journal_max: '500M' });
});

check('auto-prune after deploy respects the enabled switch and never throws', async () => {
  settingsStore.maintenance_enabled = 'false';
  deletedIds = [];
  await maintenance.autoPruneAfterDeploy({ id: 1, name: 'app' });
  assert.deepStrictEqual(deletedIds, [], 'disabled → nothing pruned');
  settingsStore.maintenance_enabled = 'true';
  const orig = FakeDeployments.findPrunableByAppId;
  FakeDeployments.findPrunableByAppId = async () => { throw new Error('db down'); };
  await maintenance.autoPruneAfterDeploy({ id: 1, name: 'app' }); // must not throw
  FakeDeployments.findPrunableByAppId = orig;
});

check('host script and sidecar command are valid POSIX sh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-sh-'));
  fs.writeFileSync(path.join(dir, 'host.sh'), maintenance.HOST_SCRIPT);
  fs.writeFileSync(path.join(dir, 'sidecar.sh'), maintenance.SIDECAR_CMD);
  execFileSync('sh', ['-n', path.join(dir, 'host.sh')]);
  execFileSync('sh', ['-n', path.join(dir, 'sidecar.sh')]);
});

// ── run ──

(async () => {
  console.log('\nDisk maintenance');
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
  }
  fs.rmSync(baseDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
