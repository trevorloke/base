// Starting the server (node server/index.js), as a host does.
//
// On Render with no DATABASE_URL the server refuses to start and says what to
// do in one line: the built-in database would live inside the container and
// be lost at the next deploy, while /api/health said ok. BASE_EMBEDDED_DB=1
// (a disk mounted on purpose) starts it; off Render nothing changes.
// /api/health says which store is in use: "postgres" or "embedded".
// It also says, loudly and without refusing, when production has no public
// address and when BASE_ENV on Render is neither production nor staging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { storeRefusal, storeOf } from '../db/client.js';
import { bootNotes } from '../index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const freePort = () => new Promise((ok, no) => {
  const s = createServer();
  s.once('error', no);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

// The settings a host could carry, cleared so each test names its own.
const CLEARED = ['NODE_TEST_CONTEXT', 'DATABASE_URL', 'RENDER', 'BASE_EMBEDDED_DB', 'BASE_ENV', 'BASE_PUBLIC_URL', 'NODE_ENV',
  'RENDER_EXTERNAL_URL', 'BASE_PATH', 'BASE_SAMPLE', 'BASE_SAMPLE_RESET', 'BASE_DEMO_EMAIL'];

// Start the server with these settings. → once it listens: { listening: true,
// health, out, err } (then stopped); if it exits first: { listening: false, code, out, err }.
const boot = async (settings) => {
  const port = await freePort();
  const env = { ...process.env };
  for (const k of CLEARED) delete env[k];
  // The built-in database in memory: nothing is written to this machine.
  Object.assign(env, { PORT: String(port), BASE_DATA: 'memory', BASE_JOBS: 'off' }, settings);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((ok) => child.on('exit', (code) => ok(code)));
  const listening = new Promise((ok) => {
    child.stdout.on('data', (d) => { out += d; if (out.includes(`base.win on :${port}`)) ok(true); });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const up = await Promise.race([listening, exited.then(() => false)]);
    if (!up) return { listening: false, code: await exited, out, err };
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await res.json();
    child.kill('SIGTERM');
    await exited;
    return { listening: true, status: res.status, health, out, err };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }
};
const lines = (text, re) => text.split('\n').filter((l) => re.test(l));

test('on Render with no DATABASE_URL the server refuses to start, and says what to do in one line', async () => {
  const r = await boot({ RENDER: 'true' });
  assert.equal(r.listening, false, 'it never answers a request');
  assert.equal(r.code, 1);
  const said = lines(r.err, /DATABASE_URL/);
  assert.equal(said.length, 1, r.err);
  assert.match(said[0], /not starting/);
  assert.match(said[0], /lost at the next deploy/);
  assert.match(said[0], /Render → this service → Environment → DATABASE_URL = the database’s Internal Database URL/);
  assert.match(said[0], /BASE_EMBEDDED_DB=1/);
  // An address of spaces is no address.
  assert.equal((await boot({ RENDER: 'true', DATABASE_URL: '  ' })).listening, false);
});

test('BASE_EMBEDDED_DB=1 on Render starts on the built-in database; health says so', async () => {
  // BASE_ENV misspelled, as it could be typed on Render: said once, treated as production.
  const r = await boot({ RENDER: 'true', BASE_EMBEDDED_DB: '1', BASE_ENV: 'Staging', BASE_PUBLIC_URL: 'https://example.base.win' });
  assert.equal(r.listening, true, r.err);
  assert.equal(r.status, 200);
  assert.equal(r.health.store, 'embedded');
  assert.equal(r.health.ok, true);
  assert.equal(r.health.env, 'production');
  assert.equal(lines(r.err, /DATABASE_URL/).length, 0, r.err);
  const said = lines(r.err, /BASE_ENV/);
  assert.equal(said.length, 1, r.err);
  assert.match(said[0], /“Staging”/);
  assert.match(said[0], /treated as production/);
});

test('off Render nothing changes: no DATABASE_URL starts on the built-in database', async () => {
  const r = await boot({ BASE_ENV: 'production' });
  assert.equal(r.listening, true, r.err);
  assert.equal(r.health.store, 'embedded');
  assert.equal(r.health.env, 'production');
  assert.equal(lines(r.err, /DATABASE_URL/).length, 0, r.err);
  // Production with no public address: one loud line, and it still starts.
  const said = lines(r.err, /BASE_PUBLIC_URL/);
  assert.equal(said.length, 1, r.err);
  assert.match(said[0], /is not set/);
  assert.match(said[0], /https:\/\/<name>\.base\.win/);
});

test('a local run says nothing more than before', async () => {
  const r = await boot({});
  assert.equal(r.listening, true, r.err);
  assert.equal(r.health.env, 'local');
  assert.equal(r.health.store, 'embedded');
  assert.equal(lines(r.err, /DATABASE_URL|BASE_ENV|BASE_PUBLIC_URL/).length, 0, r.err);
});

test('the refusal: only on Render, only with no address, never with the opt-out', () => {
  assert.match(storeRefusal({ RENDER: 'true' }), /DATABASE_URL/);
  assert.match(storeRefusal({ RENDER: 'true', DATABASE_URL: '', BASE_EMBEDDED_DB: '0' }), /DATABASE_URL/);
  assert.match(storeRefusal({ RENDER: 'true', BASE_EMBEDDED_DB: 'yes' }), /DATABASE_URL/, 'only "1" opts out');
  assert.equal(storeRefusal({ RENDER: 'true', DATABASE_URL: 'postgres://u:p@db/x' }), null);
  assert.equal(storeRefusal({ RENDER: 'true', BASE_EMBEDDED_DB: '1' }), null);
  assert.equal(storeRefusal({}), null, 'a local run');
  assert.equal(storeRefusal({ NODE_ENV: 'production', BASE_DATA: '/data/base-win' }), null, 'Docker with a volume');
  assert.ok(!storeRefusal({ RENDER: 'true' }).includes('\n'), 'one line');
});

test('the store’s name at /api/health', () => {
  assert.equal(storeOf({ kind: 'postgres' }), 'postgres');
  assert.equal(storeOf({ kind: 'pglite' }), 'embedded');
  // Not reachable (no database object): what the settings say it would be.
  assert.equal(storeOf(null, { DATABASE_URL: 'postgres://u:p@db/x' }), 'postgres');
  assert.equal(storeOf(null, {}), 'embedded');
});

test('the loud lines: production with no public address; an unknown BASE_ENV on Render', () => {
  const quiet = { BASE_ENV: 'production', BASE_PUBLIC_URL: 'https://example.base.win' };
  assert.deepEqual(bootNotes(quiet), []);
  assert.deepEqual(bootNotes({ ...quiet, RENDER: 'true' }), []);
  assert.deepEqual(bootNotes({ RENDER: 'true', BASE_ENV: 'staging' }), [], 'staging needs no public address to start');
  assert.deepEqual(bootNotes({}), [], 'a local run');

  const noUrl = bootNotes({ BASE_ENV: 'production', BASE_PUBLIC_URL: '  ' });
  assert.equal(noUrl.length, 1);
  assert.match(noUrl[0], /BASE_PUBLIC_URL is not set/);

  for (const typed of ['Staging', 'prod', 'PRODUCTION', 'stagin']) {
    const said = bootNotes({ RENDER: 'true', BASE_ENV: typed, BASE_PUBLIC_URL: 'https://example.base.win' });
    assert.equal(said.length, 1, typed);
    assert.ok(said[0].includes(`“${typed}”`), said[0]);
    assert.match(said[0], /treated as production/);
    assert.match(said[0], /stay off/);
  }
  const unset = bootNotes({ RENDER: 'true', BASE_PUBLIC_URL: 'https://example.base.win' });
  assert.equal(unset.length, 1);
  assert.match(unset[0], /BASE_ENV is not set/);
  // Both at once: both said.
  assert.equal(bootNotes({ RENDER: 'true' }).length, 2);
  // Off Render an unknown name is a developer's own business.
  assert.deepEqual(bootNotes({ BASE_ENV: 'dev' }), []);
  for (const l of bootNotes({ RENDER: 'true' })) assert.ok(!l.includes('\n'));
});
