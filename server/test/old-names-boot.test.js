// A server set up before the rename keeps every setting it was given:
// started with only the older names (as every client's Render still has
// them), it runs exactly as it does with the new ones. With both names set
// and different, the new one is used, and the start-up log says so once per
// setting — naming the settings, never a value (shared/old-names.js,
// server/lib/adopt-old-names.js).
//
// The settings below are read when their files load (the slates, the
// secure-cookie switch, the brand), so this starts the real server:
// node server/index.js, with the built-in database in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { OLD_SETTINGS, settingNames } from '../../shared/old-names.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const freePort = () => new Promise((ok, no) => {
  const s = createServer();
  s.once('error', no);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

// Made-up values. Each run gets its own address for OWN_URL (the port).
const VALUES = {
  BASE_ENV: 'production',
  BASE_BRAND: 'imagine-surrey',
  BASE_ORG_NAME: 'Riverbend Forward',
  BASE_TZ: 'America/Edmonton',
  BASE_PUBLIC_URL: 'https://riverbend.example.org',
  BASE_SLATES: 'council:City council,parks:Parks board',
  BASE_CANDIDATES: '4A:Ashgrove:Opposed — Ashgrove Civic / Pell Ashgrove;4B:Brookmere:Opposed — Brookmere Now / Ida Brookmere',
  BASE_SECURE_COOKIES: '0',
  BASE_DATA: 'memory',
  BASE_JOBS: 'off',
  BASE_OPEN_SIGNUP: '1',
};
// Other made-up values, for the run where both names are set and differ.
const OTHER = {
  BASE_ORG_NAME: 'Lakeshore Together',
  BASE_TZ: 'America/Winnipeg',
  BASE_PUBLIC_URL: 'https://lakeshore.example.org',
  BASE_SLATES: 'council:Town council',
  BASE_CANDIDATES: '4A:Quillfeather:Opposed — Quill Party / Ro Quillfeather',
};

// Every spelling of every setting in the table, and the host's own, cleared:
// each run names only its own.
const CLEARED = ['NODE_TEST_CONTEXT', 'DATABASE_URL', 'RENDER', 'RENDER_EXTERNAL_URL', 'BASE_PATH', 'NODE_ENV',
  ...Object.keys(OLD_SETTINGS).flatMap(settingNames)];

const oldNames = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [OLD_SETTINGS[k], v]));

// Start the server, sign up the first manager, read what it says, stop it.
const boot = async (settings) => {
  const port = await freePort();
  const env = { ...process.env };
  for (const k of CLEARED) delete env[k];
  const own = `http://127.0.0.1:${port}`;
  Object.assign(env, { PORT: String(port) }, typeof settings === 'function' ? settings(own) : settings);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((ok) => child.on('exit', (code) => ok(code)));
  const listening = new Promise((ok) => {
    child.stdout.on('data', (d) => { out += d; if (new RegExp(` on :${port}\\b`).test(out)) ok(true); });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  try {
    const up = await Promise.race([listening, exited.then(() => false)]);
    if (!up) return { listening: false, code: await exited, out, err };
    const health = await (await fetch(`${own}/api/health`)).json();
    const signup = await fetch(`${own}/api/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Avery Example', email: 'avery@example.org', password: 'riverbend-pass-2026', workspaceName: 'Riverbend 2026', jurisdiction: 'bc-municipal' }),
    });
    const cookie = String(signup.headers.get('set-cookie') || '');
    const me = await (await fetch(`${own}/api/auth/me`, { headers: { cookie: cookie.split(';')[0] } })).json();
    child.kill('SIGTERM');
    await exited;
    return { listening: true, own, health, signupStatus: signup.status, cookie, me, out, err };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }
};

// What a run came to, in the parts that the settings decide.
const seen = (r) => ({
  service: r.health.service,
  env: r.health.env,
  ownOrigin: r.health.ownOrigin === r.own ? 'own' : r.health.ownOrigin,
  brand: r.health.brand,
  organization: r.health.organization,
  address: r.health.address,
  signup: r.signupStatus,
  secureCookie: /;\s*secure/i.test(r.cookie),
  tz: r.me.org?.tz,
  orgName: r.me.org?.name,
  slates: r.me.org?.slates,
  candidates: (r.me.org?.candidates || []).map((c) => `${c.code}:${c.name}`),
});

// Values distinctive enough that finding one in the log means it was printed.
const PLAIN = ['BASE_ORG_NAME', 'BASE_TZ', 'BASE_PUBLIC_URL', 'BASE_SLATES', 'BASE_CANDIDATES'];

const runs = {};
const once = (name, settings) => { runs[name] ??= boot(settings); return runs[name]; };
const withNew = () => once('new', (own) => ({ ...VALUES, BASE_OWN_URL: own }));
const withOld = () => once('old', (own) => oldNames({ ...VALUES, BASE_OWN_URL: own }));
const withBoth = () => once('both', (own) => ({ ...oldNames({ ...VALUES, ...OTHER, BASE_OWN_URL: own }), ...VALUES, BASE_OWN_URL: own }));

test('the new names alone: the server runs as set up', async () => {
  const r = await withNew();
  assert.equal(r.listening, true, r.err);
  const s = seen(r);
  assert.deepEqual(s, {
    service: 'base.win', env: 'production', ownOrigin: 'own', brand: 'imagine-surrey', organization: 'Riverbend Forward',
    address: 'https://riverbend.example.org', signup: 201, secureCookie: false, tz: 'America/Edmonton', orgName: 'Riverbend Forward',
    slates: [{ code: 'council', label: 'City council' }, { code: 'parks', label: 'Parks board' }],
    candidates: ['4A:Ashgrove', '4B:Brookmere'],
  });
  assert.doesNotMatch(r.out + r.err, /still works; rename it/, 'nothing to rename');
});

test('only the older names, as every client’s Render has them: the same server, and one line per older name, with no value', async () => {
  const [now, old] = [await withNew(), await withOld()];
  assert.equal(old.listening, true, old.err);
  assert.deepEqual(seen(old), seen(now));
  const log = old.out + old.err;
  const said = log.split('\n').filter((l) => /still works; rename it/.test(l));
  const set = [...Object.keys(VALUES), 'BASE_OWN_URL'];
  assert.equal(said.length, set.length, log);
  for (const k of set) {
    assert.ok(said.includes(`base.win: the setting ${OLD_SETTINGS[k]} still works; rename it to ${k} in Render.`), `${k}: ${log}`);
  }
  for (const k of PLAIN) assert.ok(!log.includes(VALUES[k]), `the log carries no value: ${k}`);
  assert.doesNotMatch(log, /differ/);
});

test('both names, different values: the new one is used, and the log says so once per setting, with no value', async () => {
  const [now, both] = [await withNew(), await withBoth()];
  assert.equal(both.listening, true, both.err);
  assert.deepEqual(seen(both), seen(now), 'every new value wins');
  const log = both.out + both.err;
  const differ = log.split('\n').filter((l) => /differ/.test(l));
  assert.deepEqual(differ.sort(), Object.keys(OTHER).map((k) => `base.win: ${k} and its older name are both set and differ; ${k} is used.`).sort());
  for (const k of PLAIN) {
    assert.ok(!log.includes(VALUES[k]), `the log carries no new value: ${k}`);
    assert.ok(!log.includes(OTHER[k]), `the log carries no older value: ${k}`);
  }
});
