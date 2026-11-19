// /api/health for the base.win control centre: public fields only (its own
// address and instance, the campaign's address, whether entry is set up and
// which keys it holds, whether sign-up is open, whether the door's key is
// set) — never a secret, never the campaign's switch, nothing about people.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { bootstrap } from '../db/schema.js';

const V = JSON.parse(readFileSync(new URL('./entry-vector.json', import.meta.url), 'utf8'));
const KEYS = ['BASE_PLATFORM_PUBKEY', 'STARBASE_OWN_URL', 'RENDER_EXTERNAL_URL', 'STARBASE_PUBLIC_URL', 'BASE_DOOR_KEY', 'STARBASE_OPEN_SIGNUP'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let db;

before(async () => {
  db = await freshDb();
  for (const k of KEYS) delete process.env[k];
});
after(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});
const health = async () => (await app.request('/api/health')).json();

test('the exact fields', async () => {
  const h = await health();
  assert.deepEqual(Object.keys(h).sort(), [
    'address', 'build', 'campaignMade', 'commit', 'database', 'doorKey', 'entry', 'env', 'instance', 'ok', 'organization',
    'ownOrigin', 'platformKids', 'service', 'setupOpen', 'tzdataCurrent',
  ]);
  assert.match(h.instance, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(h.ownOrigin, null);
  assert.equal(h.address, null);
  assert.deepEqual(h.platformKids, []);
  assert.equal(h.setupOpen, true);
  assert.equal(h.campaignMade, false);
  assert.equal(h.doorKey, false);
});

test('entry: no-key, bad-key, no-origin, ready; the kids held', async () => {
  assert.equal((await health()).entry, 'no-key');
  process.env.BASE_PLATFORM_PUBKEY = 'junk, also junk';
  let h = await health();
  assert.equal(h.entry, 'bad-key');
  assert.deepEqual(h.platformKids, []);
  process.env.BASE_PLATFORM_PUBKEY = V.publicKey;
  h = await health();
  assert.equal(h.entry, 'no-origin');
  assert.deepEqual(h.platformKids, ['cd935ce9']);
  process.env.RENDER_EXTERNAL_URL = 'https://Base-Win-Example.onrender.com/';
  h = await health();
  assert.equal(h.entry, 'ready');
  assert.equal(h.ownOrigin, 'https://base-win-example.onrender.com');
  process.env.STARBASE_OWN_URL = 'http://127.0.0.1:5630';
  assert.equal((await health()).ownOrigin, 'http://127.0.0.1:5630');
  process.env.BASE_PLATFORM_PUBKEY = `${V.otherPublicKey},${V.publicKey}`;
  assert.deepEqual((await health()).platformKids, [V.otherKid, 'cd935ce9']);
  // The key closes first-run sign-up on a server with no campaign — and
  // that is not a campaign made: campaignMade says whether a workspace exists.
  assert.equal((await health()).setupOpen, false);
  assert.equal((await health()).campaignMade, false);
  process.env.STARBASE_OPEN_SIGNUP = '1';
  assert.equal((await health()).setupOpen, true);
  delete process.env.STARBASE_OPEN_SIGNUP;
});

test('address and doorKey follow their settings; the door key never shows', async () => {
  process.env.STARBASE_PUBLIC_URL = 'https://base.win/example/';
  process.env.BASE_DOOR_KEY = 'door-key-0123456789abcdef0123456789abcdef';
  const res = await app.request('/api/health');
  const text = await res.text();
  const h = JSON.parse(text);
  assert.equal(h.address, 'https://base.win/example');
  assert.equal(h.doorKey, true);
  assert.ok(!text.includes(process.env.BASE_DOOR_KEY));
  process.env.STARBASE_PUBLIC_URL = 'not an address';
  assert.equal((await health()).address, null);
  delete process.env.BASE_DOOR_KEY;
  assert.equal((await health()).doorKey, false);
});

test('the instance is kept across a restart on the same database; the switch changes nothing here', async () => {
  const first = (await health()).instance;
  await bootstrap(db); // what boot runs again: the tables, the identity row
  assert.equal((await health()).instance, first);
  process.env.STARBASE_OPEN_SIGNUP = '1';
  const mgr = new Client();
  assert.equal((await mgr.signup({ name: 'Morgan Example', email: 'morgan@example.org' })).status, 201);
  delete process.env.STARBASE_OPEN_SIGNUP;
  const before = await health();
  assert.equal(before.campaignMade, true);
  assert.equal((await mgr.action('workspace.operatorEntry', { on: false })).status, 200);
  const afterOff = await health();
  delete before.build; delete afterOff.build;
  assert.deepEqual(afterOff, before);
});

test('the app’s page: no plugins, no foreign <base>; a framing rule left alone', async () => {
  const res = await app.request('/');
  const csp = res.headers.get('Content-Security-Policy') || '';
  if (res.status === 200 && /text\/html/.test(res.headers.get('Content-Type') || '')) {
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
  }
  // The API's JSON carries none.
  assert.equal((await app.request('/api/health')).headers.get('Content-Security-Policy'), null);
});
