// The demo walk: staging as render.yaml's staging block sets it up, with
// the sample made at its full size, read the way a demo visitor reads it.
// Every read the preset dump makes (staging-paths.js) answers the status
// recorded there, and nothing it answers is real: no listed real name
// (real-names.js), no phone outside 604-555-01xx, no email outside
// example.org, example.com and base.win, no link to anywhere but the
// server itself, base.win, example.org, example.com, schema.org and the
// free map's tiles. Then what NEUTRAL took away is still gone, one line
// each (STAGING.md section 1b).
//
// scripts/staging-check.mjs walks the deployed demo the same way, daily.
//
// The staging block is set before the server is loaded: shared/scale.js
// reads the opponents when it loads, and the test helper sets Imagine
// Surrey's brand when none is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stagingBlock, STARTING_FIELDS } from './sample-prints.js';
import { API_PATHS, PAGES, ANON, GONE, APP } from './staging-paths.js';
import { wrongIn } from './real-names.js';
import { OPPONENTS, SEGMENTS } from '../lib/samplecast.js';

// NODE_ENV is left out: it sets the cookies' Secure flag when the server
// loads, which an in-process request has no use for.
const BLOCK = stagingBlock();
delete BLOCK.NODE_ENV;
const saved = Object.fromEntries(Object.keys(BLOCK).map((k) => [k, process.env[k]]));
Object.assign(process.env, BLOCK);
const { freshDb } = await import('./helpers.js');
const { app } = await import('../index.js');
const { bootstrap } = await import('../db/schema.js');
const { seedSample } = await import('../lib/samplecampaign.js');
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const BUILT = existsSync(fileURLToPath(new URL('../../web/dist/index.html', import.meta.url)));
let db; let cookie; let made;
before(async () => {
  db = await freshDb();
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await db.query('drop schema if exists sample_meta cascade');
  await bootstrap(db);
  made = await seedSample(app, () => {}, 320);
  const r = await app.request('/api/auth/demo');
  assert.equal(r.status, 302);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

const read = async (path, signedIn = true) => {
  const res = await app.request(path, { headers: signedIn ? { cookie } : {} });
  const type = res.headers.get('content-type') || '';
  const text = /^(text\/|application\/(json|javascript|xml|manifest\+json))|\+xml|charset=/i.test(type) ? await res.text() : '';
  return { status: res.status, type, text };
};
const get = async (path) => JSON.parse((await read(path)).text);

test('the walk is the preset dump’s list, with the people read whole', () => {
  const DUMP = readFileSync(new URL('../../scripts/preset-dump.sh', import.meta.url), 'utf8');
  const listOf = (name) => new RegExp(`^${name}="([^"]+)"`, 'm').exec(DUMP)[1].split(/\s+/).filter(Boolean);
  assert.deepEqual(API_PATHS.map(([p]) => p), listOf('API').map((a) => `/api/${a === 'persons' ? 'persons?limit=500' : a}`));
  assert.deepEqual(PAGES.map(([p]) => p), listOf('PAGES'));
  assert.deepEqual(ANON.map(([p]) => p), ['/', '/join', '/donate', '/site/', '/manifest.webmanifest', '/signup', '/login', '/api/auth/setup']);
});

test('the sample is made in full from the staging block', async () => {
  assert.equal(BLOCK.BASE_ENV, 'staging');
  assert.equal(BLOCK.BASE_BRAND, 'base');
  assert.equal(BLOCK.BASE_SAMPLE, 'vancouver');
  assert.deepEqual(made, { people: 320, turfs: 4, knocks: made.knocks, shifts: 5, gifts: made.gifts, failed: 0 });
});

test('every read answers as recorded, and nothing in it is real', async (t) => {
  const wrong = [];
  const statuses = [];
  const reads = [
    ...API_PATHS.map(([path, status, app]) => ({ name: `GET ${path}`, path, status, app, signedIn: true })),
    ...PAGES.map(([path, status, app]) => ({ name: `GET ${path}`, path, status, app, signedIn: true })),
    ...ANON.map(([path, status, app]) => ({ name: `GET ${path} (signed out)`, path, status, app, signedIn: false })),
  ];
  for (const r of reads) {
    const got = await read(r.path, r.signedIn);
    const want = r.app === APP && !BUILT ? 404 : r.status;
    if (got.status !== want) statuses.push(`${r.name}: ${got.status}, not ${want}`);
    wrong.push(...wrongIn(r.name, got.text, { json: /json/.test(got.type) }));
  }
  t.diagnostic(`${reads.length} reads${BUILT ? '' : ' (no web/dist: the app’s own page answers 404)'}`);
  assert.deepEqual(statuses, [], 'a read answers a status other than the one recorded');
  assert.deepEqual(wrong, [], 'something real is on staging');
});

test('the people are the sample’s 320, read whole', async () => {
  const { persons, more } = await get('/api/persons?limit=500');
  assert.equal(persons.length, 320);
  assert.ok(!more);
  for (const p of persons) {
    assert.match(p.address, /^99\d\d /);
    assert.equal(p.city, 'Vancouver');
  }
});

test('each person’s dot, read back, is on their street’s piece of centreline', async () => {
  const { persons } = await get('/api/persons?limit=500');
  for (const p of persons) {
    const seg = SEGMENTS[p.address.slice(5)];
    assert.ok(seg, `${p.address}: its street has no piece`);
    const [[y1, x1], [y2, x2]] = seg;
    const f = (Number(p.address.slice(0, 4)) - 9900) / 100;
    assert.ok(Math.abs(Number(p.lat) - (y1 + f * (y2 - y1))) < 1e-6 && Math.abs(Number(p.lng) - (x1 + f * (x2 - x1))) < 1e-6, `${p.address}: ${p.lat}, ${p.lng}`);
  }
});

// STAGING.md 1b: what NEUTRAL took away, one line each.
test('N1: no sample people to load', async () => {
  const r = await app.request('/api/data/sample', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 404);
});

test('N2: none of Imagine Surrey’s pictures or icons is served', async () => {
  for (const path of GONE) {
    const r = await app.request(path);
    assert.equal(r.status, 404, path);
    // The answer says its own length, not the app page's it stands in for.
    const body = Buffer.from(await r.arrayBuffer());
    const said = r.headers.get('content-length');
    if (said !== null) assert.equal(Number(said), body.length, `${path}: says ${said} bytes, sends ${body.length}`);
  }
});

test('N3: the rating scale names exactly the cast’s three', async () => {
  const { scale } = await get('/api/scale');
  assert.deepEqual(scale.candidates.map((c) => [c.code, c.name, c.label]), OPPONENTS.map((o) => [o.code, o.name, o.label]));
  const me = await get('/api/auth/me');
  assert.deepEqual(me.org.candidates.map((c) => c.name), ['Avendrel', 'Brindlemoor', 'Castramont']);
});

test('N4: the fields are the ten every new campaign starts with, also after a restart', async () => {
  const names = async () => (await get('/api/fields')).fields.map((f) => f.name);
  const why = 'what a campaign starts with changed: raise SAMPLE_VERSION and update this list';
  assert.deepEqual(await names(), STARTING_FIELDS, why);
  await bootstrap(db); // what a restart runs
  assert.deepEqual(await names(), STARTING_FIELDS, `${why} (after a restart)`);
});

test('N5: no membership: no form, no Members report, no donor club', async () => {
  assert.equal((await app.request('/api/membership/form', { headers: { cookie } })).status, 404);
  const { reports } = await get('/api/quick-reports-menu');
  assert.ok(!reports.some((r) => /member/i.test(`${r.name} ${r.title}`)), JSON.stringify(reports.map((r) => r.title)));
  const { persons } = await get('/api/persons?limit=1');
  const id = persons[0].id;
  const r = await app.request('/api/actions/gift.log', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: id, amount_cents: 100000, date: new Date().toISOString().slice(0, 10), method: 'card' }),
  });
  assert.equal(r.status, 200);
  const { donor } = await get(`/api/persons/${id}`);
  assert.equal(donor.label, undefined, JSON.stringify(donor));
  assert.ok(!/star/i.test(JSON.stringify(donor)), JSON.stringify(donor));
});

test('N6: the website offers one look, base.win’s', async () => {
  const { skins } = await get('/api/site');
  assert.deepEqual(skins.map((s) => s.key), ['base']);
});
