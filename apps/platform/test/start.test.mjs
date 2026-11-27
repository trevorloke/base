// Starting the control centre (node apps/platform/server.mjs): on Render
// it never runs on the in-memory database. With RENDER set and DATABASE_URL
// empty it stops at once with one line that says what to do; anywhere else
// (a laptop, these tests) it starts in memory as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST, SETUP_CODE, SECRET, SIGNING } from './helpers.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = '5607';
// Only what the console reads: nothing of the machine's own settings.
const env = (over) => ({
  PATH: process.env.PATH, PORT, OPS_HOST: HOST, OPS_SETUP_CODE: SETUP_CODE, OPS_SECRET: SECRET, PLATFORM_SIGNING_KEY: SIGNING, ...over,
});
// Runs it until it exits, or until `until` shows in its output (then stops it).
const run = (over, { until = null, ms = 20_000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SERVER], { env: env(over), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let started = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), ms);
  child.stdout.on('data', (d) => {
    out += d;
    if (until && !started && until.test(out)) { started = true; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err, started }); });
});

test('on Render with no DATABASE_URL: it won’t start, and says why in one line', async () => {
  for (const DATABASE_URL of [undefined, '']) {
    const r = await run({ RENDER: 'true', ...(DATABASE_URL === undefined ? {} : { DATABASE_URL }) }, { until: /control centre on :/ });
    assert.equal(r.started, false, 'it never listened');
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    const lines = r.err.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, r.err);
    assert.match(lines[0], /^The control centre can’t start: DATABASE_URL is empty\./);
    assert.match(lines[0], /base-platform → Environment/);
    assert.match(lines[0], /Save and deploy\.$/);
  }
});

test('not on Render: it starts in memory, as on a laptop', async () => {
  const r = await run({}, { until: /control centre on :5607 for ops\.example\.org/ });
  assert.equal(r.started, true, r.err || r.out);
});
