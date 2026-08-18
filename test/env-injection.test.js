/*
 * Tests for environment variable injection.
 *
 * These cover the two paths a variable can take on its way into a container:
 *
 *   global (no target_service)  -> written to .env, picked up by Compose for
 *                                  ${VAR} interpolation and env_file
 *   targeted (target_service)   -> injected into that service's environment in
 *                                  beachhead.override.yml
 *
 * Run: npm test
 *
 * No database, no Docker, no network.
 */

const assert = require('assert');
const yaml = require('js-yaml');
const { envQuote, mapWithConcurrency } = require('../src/services/worker');
const { generateOverride } = require('../src/services/composeWrapper');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// Parse a .env line the way a strict parser would: everything after the first
// '=' is the value, and a single-quoted value is unwrapped.
function parseEnvLine(line) {
  const i = line.indexOf('=');
  const key = line.slice(0, i);
  let value = line.slice(i + 1);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return { key, value };
}

console.log('\n1. envQuote');

check('leaves a bare token unquoted', () => {
  assert.strictEqual(envQuote('re_abc123'), 're_abc123');
});

check('leaves a URL unquoted', () => {
  assert.strictEqual(envQuote('https://tickets.example.com'), 'https://tickets.example.com');
});

check('leaves a postgres URL unquoted', () => {
  const v = 'postgresql://postgres:pw@db:5432/tickets';
  assert.strictEqual(envQuote(v), v);
});

check('QUOTES a value containing spaces', () => {
  // The regression: this used to be emitted bare, so whether it survived
  // depended on which .env parser read it.
  const v = 'Chicago Electric Piano <no-reply@chicagoelectricpiano.com>';
  const quoted = envQuote(v);
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), `not quoted: ${quoted}`);
  assert.strictEqual(parseEnvLine(`EMAIL_FROM=${quoted}`).value, v);
});

check('quotes values with # so they are not read as comments', () => {
  const v = 'pass#word';
  assert.strictEqual(parseEnvLine(`K=${envQuote(v)}`).value, v);
});

check('quotes values with $ so they are not interpolated', () => {
  const v = 'literal$NOTAVAR';
  assert.ok(envQuote(v).startsWith("'"));
});

check('round-trips a value containing a single quote', () => {
  const v = "it's a value";
  assert.strictEqual(parseEnvLine(`K=${envQuote(v)}`).value, v);
});

check('round-trips every awkward value', () => {
  for (const v of [
    'Chicago Electric Piano <no-reply@x.com>',
    'a b c',
    'trailing ',
    ' leading',
    'semi;colon', 'pipe|char', 'amp&char', 'star*',
    'quote"double', "quote'single",
    'back\\slash', 'tick`char', 'bang!', 'hash#',
    'equals=inside', 'colon:inside',
  ]) {
    assert.strictEqual(parseEnvLine(`K=${envQuote(v)}`).value, v, `failed for ${JSON.stringify(v)}`);
  }
});

console.log('\n2. generateOverride: global vs targeted');

const base = {
  appSlug: 'admit', deployId: 7, publicService: 'frontend',
  domain: 'tickets.example.com', publicPort: 80, proxyNetwork: 'bh-app-1',
};

function overrideFor(envVars) {
  return yaml.load(generateOverride({ ...base, envVars }));
}

check('a GLOBAL var is not injected into any service', () => {
  // Globals belong in .env. Injecting them defaulted every global into the
  // public service - so the frontend received the database password and the
  // Resend API key, while the backend depended on .env alone.
  const doc = overrideFor([
    { key: 'EMAIL_FROM', value: 'Chicago Electric Piano <no-reply@x.com>', target_service: null },
    { key: 'DB_PASSWORD', value: 'hunter2', target_service: null },
  ]);
  const frontendEnv = JSON.stringify(doc.services.frontend.environment || {});
  assert.ok(!frontendEnv.includes('EMAIL_FROM'), `EMAIL_FROM leaked: ${frontendEnv}`);
  assert.ok(!frontendEnv.includes('hunter2'), `DB_PASSWORD leaked: ${frontendEnv}`);
});

check('a TARGETED var reaches exactly that service', () => {
  const doc = overrideFor([{ key: 'API_KEY', value: 'secret', target_service: 'backend' }]);
  const backend = doc.services.backend.environment;
  assert.strictEqual(backend.API_KEY ?? backend, 'secret', JSON.stringify(backend));
  const frontendEnv = JSON.stringify(doc.services.frontend.environment || {});
  assert.ok(!frontendEnv.includes('secret'), 'leaked into the public service');
});

check('the public service keeps its proxy variables', () => {
  const doc = overrideFor([{ key: 'API_KEY', value: 'secret', target_service: 'backend' }]);
  const env = doc.services.frontend.environment;
  const flat = Array.isArray(env) ? env.join('\n') : JSON.stringify(env);
  assert.ok(/VIRTUAL_HOST/.test(flat), flat);
  assert.ok(/LETSENCRYPT_HOST/.test(flat), flat);
});

check('a targeted value with spaces survives YAML serialisation', () => {
  const v = 'Chicago Electric Piano <no-reply@x.com>';
  const doc = overrideFor([{ key: 'EMAIL_FROM', value: v, target_service: 'backend' }]);
  const env = doc.services.backend.environment;
  assert.strictEqual(env.EMAIL_FROM, v, JSON.stringify(env));
});

check('a targeted value containing = is not split at the wrong place', () => {
  // The "KEY=value" string form is re-parsed at the first '='. The map form
  // has no such ambiguity.
  const v = 'a=b=c';
  const doc = overrideFor([{ key: 'WEIRD', value: v, target_service: 'backend' }]);
  assert.strictEqual(doc.services.backend.environment.WEIRD, v);
});

check('a targeted value with YAML-significant characters survives', () => {
  const doc = overrideFor([
    { key: 'COLON', value: 'key: value', target_service: 'backend' },
    { key: 'HASH', value: 'a # b', target_service: 'backend' },
    { key: 'QUOTE', value: '"quoted"', target_service: 'backend' },
  ]);
  const env = doc.services.backend.environment;
  assert.strictEqual(env.COLON, 'key: value');
  assert.strictEqual(env.HASH, 'a # b');
  assert.strictEqual(env.QUOTE, '"quoted"');
});

check('vars belonging to an explicit env file are not injected', () => {
  const doc = overrideFor([{ key: 'IN_FILE', value: 'x', target_service: 'backend', env_file_id: 3 }]);
  const backend = doc.services.backend;
  const flat = backend ? JSON.stringify(backend.environment || {}) : '';
  assert.ok(!flat.includes('IN_FILE'), flat);
});

check('mixed globals and targeted vars are separated correctly', () => {
  const doc = overrideFor([
    { key: 'GLOBAL_ONE', value: 'g1', target_service: null },
    { key: 'BACKEND_ONE', value: 'b1', target_service: 'backend' },
    { key: 'VERIFIER_ONE', value: 'v1', target_service: 'verifier' },
  ]);
  assert.strictEqual(doc.services.backend.environment.BACKEND_ONE, 'b1');
  assert.strictEqual(doc.services.verifier.environment.VERIFIER_ONE, 'v1');
  const all = JSON.stringify(doc.services);
  assert.ok(!all.includes('GLOBAL_ONE'), 'global leaked into a service');
});

console.log('\n3. mapWithConcurrency (startup recovery)');

async function concurrencyChecks() {
  await (async () => {
    const order = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
    });
    check('processes every item', () => assert.deepStrictEqual(order.sort(), [1, 2, 3, 4, 5]));
  })();

  await (async () => {
    let inFlight = 0, peak = 0;
    await mapWithConcurrency([...Array(12).keys()], 3, async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    check('never exceeds the concurrency limit', () => assert.ok(peak <= 3, `peak was ${peak}`));
    check('actually runs concurrently (not serial)', () => assert.ok(peak > 1, `peak was ${peak}`));
  })();

  await (async () => {
    // A slow app must not stop the others - this is the whole point. Serial
    // recovery over five apps is what made a queued deploy wait ~15 minutes.
    const done = [];
    const t0 = Date.now();
    await mapWithConcurrency([50, 5, 5, 5], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      done.push(ms);
    });
    const elapsed = Date.now() - t0;
    check('a slow item does not block the rest', () => assert.strictEqual(done[0], 5, JSON.stringify(done)));
    check('total time is bounded by the slowest, not the sum', () => assert.ok(elapsed < 65, `${elapsed}ms`));
  })();

  await (async () => {
    await mapWithConcurrency([], 3, async () => { throw new Error('should not run'); });
    check('handles an empty list', () => assert.ok(true));
  })();
}

concurrencyChecks().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});


