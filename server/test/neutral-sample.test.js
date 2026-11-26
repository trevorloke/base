// "Load sample data" loads Imagine Surrey's own made-up people: voters on
// Surrey's streets, with its neighbourhoods, its shift and its turf. They
// are its set-up's (server/presets/, read only through lib/preset.js).
// Another campaign has no sample to load: the address is not found, its
// sign-in says so (so Today shows no card), and nothing of the sample is
// read. Clearing a sample loaded earlier still works for everyone.
// Then the same server as Imagine Surrey's, with the brand set after the
// server was loaded (as the test helper does): everything as it was.
// Unique emails and campaign names (test:pg can run a file twice on one database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { forgetBrand } from '../lib/brand.js';
import { presetFor, preset, brandHas } from '../lib/preset.js';
import { hasFeature } from '../../web/src/brand.js';

const tag = Math.random().toString(36).slice(2, 8);
const ok = (r, msg = '') => { assert.ok(r.status === 200 || r.status === 201, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const IS = presetFor('imagine-surrey');

const savedBrand = process.env.STARBASE_BRAND;
const wear = (brand) => { process.env.STARBASE_BRAND = brand; forgetBrand(); };
after(() => { if (savedBrand === undefined) delete process.env.STARBASE_BRAND; else process.env.STARBASE_BRAND = savedBrand; forgetBrand(); });

let db, mgr, ws;
let loaded = 0;
const count = async (table, where = 'true') => (await db.query(`select count(*)::int as n from ${table} where workspace_id = $1 and ${where}`, [ws])).rows[0].n;

before(async () => {
  db = await freshDb();
  wear('base');
  mgr = new Client();
  const r = ok(await mgr.signup({ workspaceName: `Kamloops Forward ${tag}`, email: `neutral.sample.${tag}@example.org`, jurisdiction: 'bc-municipal' }));
  ws = r.workspace.id;
});

test('another campaign: there is no sample to load, and nothing of one is made', async () => {
  wear('base');
  assert.equal(brandHas('sample'), false);
  assert.equal(preset().sample, null);
  const people = await count('persons');
  const r = await mgr.post('/api/data/sample', {});
  assert.equal(r.status, 404, JSON.stringify(r.json));
  assert.deepEqual(r.json, { error: 'not found' });
  assert.equal(await count('persons'), people, 'nobody was added');
  assert.equal(await count('shifts'), 0);
  assert.equal(await count('turfs'), 0);
  assert.equal(await count('events', "action = 'sample.load'"), 0, 'not even a line in the log');
  assert.ok(!ok(await mgr.get('/api/brief')).sampleLoaded);
  const fields = ok(await mgr.get('/api/fields')).fields.map((f) => f.name);
  for (const f of IS.sample.fields) assert.ok(!fields.includes(f.name), f.name);
  assert.equal((await mgr.req('DELETE', '/api/data/sample')).status, 200, 'clearing when there is none is still an answer');
});

test('another campaign: its sign-in says it has no sample, so Today offers no card', async () => {
  wear('base');
  const me = ok(await mgr.get('/api/auth/me'));
  assert.ok(Array.isArray(me.org.features));
  assert.ok(!me.org.features.includes('sample'), JSON.stringify(me.org.features));
  assert.equal(hasFeature(me, 'sample'), false, 'what Today asks before it draws the card');
  // The page itself says nothing of a sample either: no line for the card.
  const page = await (await app.request('/')).text();
  assert.doesNotMatch(page, /made-up|sampleLede/);
});

test('Imagine Surrey: the same sample loads, with its shift and its three movers, and its sign-in says it has one', async () => {
  wear('imagine-surrey');
  try {
    const me = ok(await mgr.get('/api/auth/me'));
    assert.ok(me.org.features.includes('sample'));
    assert.equal(hasFeature(me, 'sample'), true);
    const r = ok(await mgr.post('/api/data/sample', {}));
    assert.ok(r.people >= 45 && r.signs > 0 && r.gifts > 0, JSON.stringify(r));
    loaded = r.people;
    assert.equal((await mgr.post('/api/data/sample', {})).status, 409, 'loads once');
    const shift = (await db.query('select title, location, role, capacity from shifts where workspace_id = $1', [ws])).rows[0];
    assert.deepEqual([shift.title, shift.location, shift.role, shift.capacity], ['Saturday canvass — Newton (sample)', 'Newton Rec Centre, 13730 72 Ave', 'doorknocking', 8]);
    assert.deepEqual({ ...IS.sample.shift }, { title: 'Saturday canvass — Newton (sample)', place: 'Newton Rec Centre, 13730 72 Ave' });
    assert.ok(ok(await mgr.get('/api/brief')).sampleLoaded);
    // The three who moved (ext/moves): named by the loaded sample itself.
    const moved = (await db.query(
      "select count(*)::int as n from contacts c join persons p on p.id = c.person_id where c.workspace_id = $1 and c.outcome = 'moved' and p.name = any($2::text[])",
      [ws, ['Owen Price', 'Noah Wilson', 'George Bell']],
    )).rows[0].n;
    assert.equal(moved, 3);
    const fields = ok(await mgr.get('/api/fields')).fields.map((f) => f.name);
    for (const f of IS.sample.fields) assert.ok(fields.includes(f.name), f.name);
  } finally { wear('base'); }
});

test('another campaign: a sample loaded earlier is still cleared, and cannot be loaded again', async () => {
  wear('base');
  assert.ok(loaded >= 45 && await count('persons') >= loaded, 'the sample from before is here');
  assert.equal((await mgr.post('/api/data/sample', {})).status, 404);
  const cleared = await mgr.req('DELETE', '/api/data/sample');
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.cleared, loaded);
  assert.equal(cleared.json.message, `Sample data cleared — ${loaded} sample people removed.`);
  assert.ok(!ok(await mgr.get('/api/brief')).sampleLoaded);
  assert.equal(await count('shifts', 'deleted_at is null'), 0);
  assert.equal((await mgr.post('/api/data/sample', {})).status, 404, 'still nothing to load');
});
