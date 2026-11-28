// /api/health names this service "base.win" now. Settings → Services' check
// of the public address (server/ext/connections) still knows a server on
// the older code by the word it answers with, during a rollout, and refuses
// anything else. And the health answer's address is the public one, never
// the host's machine address, whenever a public address is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { OLD_HEALTH_SERVICE, settingNames } from '../../shared/old-names.js';

const tag = Math.random().toString(36).slice(2, 8);
const PUB = 'https://riverbend.example.org';
const KEYS = [...['BASE_PUBLIC_URL', 'BASE_OWN_URL'].flatMap(settingNames), 'RENDER_EXTERNAL_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let answer = null; // what the stand-in public address says at /api/health
let mgr;

before(async () => {
  await freshDb();
  for (const k of KEYS) delete process.env[k];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.origin === PUB && u.pathname === '/api/health') return new Response(JSON.stringify(answer));
    throw new Error(`no stand-in for ${u.host}`);
  };
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Riverbend ${tag}`, email: `mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const check = async () => (await mgr.post('/api/connections/check', { key: 'public' })).json;

test('this server answers service: "base.win"', async () => {
  const h = await (await app.request('/api/health')).json();
  assert.equal(h.service, 'base.win');
});

test('the public address check: a server answering "base.win" or the older word is this base.win; anything else is not', async () => {
  process.env.BASE_PUBLIC_URL = PUB;
  answer = { ok: true, service: 'base.win', env: 'production' };
  assert.deepEqual(await check(), { key: 'public', ok: true, said: `${PUB} reaches this base.win (production)` });
  answer = { ok: true, service: OLD_HEALTH_SERVICE, env: 'staging' };
  assert.deepEqual(await check(), { key: 'public', ok: true, said: `${PUB} reaches this base.win (staging)` }, 'a server still on the older code, mid-rollout');
  for (const service of ['base-win', 'something-else', '', null, undefined]) {
    answer = { ok: true, service, env: 'production' };
    const r = await check();
    assert.equal(r.ok, false, String(service));
    assert.equal(r.said, `${PUB} answered 200, not this base.win`);
  }
});

test('the public address check, under the older setting name', async () => {
  delete process.env.BASE_PUBLIC_URL;
  process.env[settingNames('BASE_PUBLIC_URL')[1]] = PUB;
  answer = { ok: true, service: 'base.win', env: 'production' };
  assert.equal((await check()).ok, true);
  delete process.env[settingNames('BASE_PUBLIC_URL')[1]];
});

test('with a public address set, the health answer’s address is it, never the machine’s .onrender.com one', async () => {
  process.env.RENDER_EXTERNAL_URL = 'https://riverbend-a1b2.onrender.com';
  process.env.BASE_PUBLIC_URL = PUB;
  let h = await (await app.request('/api/health')).json();
  assert.equal(h.address, PUB);
  delete process.env.BASE_PUBLIC_URL;
  process.env[settingNames('BASE_PUBLIC_URL')[1]] = PUB;
  h = await (await app.request('/api/health')).json();
  assert.equal(h.address, PUB, 'under the older name too');
  delete process.env[settingNames('BASE_PUBLIC_URL')[1]];
  h = await (await app.request('/api/health')).json();
  assert.equal(h.address, null, 'no public address: none is made up from the machine’s');
});
