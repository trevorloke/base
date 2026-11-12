// The map's check for managers (ext/mapcheck, GET /api/map/check): one
// answer that says which of the ways a map can look empty applies — who is
// on file and who is on the map, who waits for a pin and who has no address
// at all (never placed by guessing: counted here), how many live outside the
// campaign's area, the turfs, the placing run, the street map in use and
// the build the server hands out.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr;
let staff;
let vol;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const join = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name.toLowerCase()}.check@example.org`, role });
  const c = new Client();
  ok(await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'map-check-pass-1' }));
  return c;
};

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Map check', jurisdiction: 'bc-municipal' });
  staff = await join('staff', 'Staff');
  vol = await join('volunteer', 'Walker');
  // Three on the map in Surrey, one whose address is in Prince George, two
  // with an address and no pin yet, one with no address at all.
  for (const [i, lat, lng] of [[1, 49.105, -122.85], [2, 49.11, -122.84], [3, 49.19, -122.8], [4, 53.91, -122.75]]) {
    await mgr.createPerson(`Placed ${i} Example`, { address: `${100 + i} Example St`, lat, lng });
  }
  await mgr.createPerson('Waiting 1 Example', { address: '201 Example St' });
  await mgr.createPerson('Waiting 2 Example', { address: '202 Example St' });
  await mgr.createPerson('No Address Example', { phone: '604-555-0131' });
  ok(await mgr.action('turf.create', { name: 'Check turf', polygon: [[49.1, -122.86], [49.1, -122.83], [49.12, -122.83]] }));
});

test('one answer says who is on the map, who is not and why, and what the map is drawn from', async () => {
  const prev = process.env.STARBASE_GEO_BOUNDS;
  delete process.env.STARBASE_GEO_BOUNDS; // the campaign's box: Surrey's
  const r = ok(await mgr.get('/api/map/check'));
  if (prev !== undefined) process.env.STARBASE_GEO_BOUNDS = prev;
  assert.deepEqual(r.people, { total: 7, onMap: 4, waiting: 2, noAddress: 1 });
  assert.deepEqual([r.area.inside, r.area.outside], [3, 1], 'one lives outside the campaign’s area');
  assert.deepEqual(r.area.box, [49.002, -122.92, 49.222, -122.67]);
  assert.equal(r.turfs, 1);
  assert.deepEqual([r.placing.state, r.placing.remaining, r.placing.retryAt, r.placing.off], ['idle', 2, null, false]);
  assert.deepEqual([r.tiles.source, r.tiles.custom, r.tiles.clean], ['OpenStreetMap', false, true]);
  assert.ok('build' in r && 'commit' in r);
});

test('it says when address lookup is turned off, and which street map a campaign set', async () => {
  const prev = { g: process.env.GEOCODER, t: process.env.STARBASE_TILE_URL };
  process.env.GEOCODER = 'off';
  process.env.STARBASE_TILE_URL = 'https://tiles.example/{z}/{x}/{y}.png?key=not-shown';
  const r = ok(await mgr.get('/api/map/check'));
  for (const [k, v] of [['GEOCODER', prev.g], ['STARBASE_TILE_URL', prev.t]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  assert.equal(r.placing.off, true);
  assert.deepEqual([r.tiles.source, r.tiles.custom, r.tiles.clean], ['tiles.example', true, false]);
  assert.ok(!JSON.stringify(r).includes('not-shown'), 'never the whole address: it may carry a key');
});

test('managers only', async () => {
  assert.equal((await staff.get('/api/map/check')).status, 403);
  assert.equal((await vol.get('/api/map/check')).status, 403);
  assert.equal((await new Client().get('/api/map/check')).status, 401);
});
