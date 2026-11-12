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

// ── The services behind the map, asked live, on their own endpoint ──
test('the services check: managers only; which street map and address service, whether each answers and Google’s words — never a key', async () => {
  const { _resetForTest } = await import('../lib/gtiles.js');
  const { _resetLookupForTest } = await import('../lib/geocode.js');
  const realFetch = globalThis.fetch;
  const prev = { t: process.env.GOOGLE_MAPS_TILES, k: process.env.GOOGLE_MAPS_SERVER_KEY, g: process.env.GEOCODER };
  let billing = true;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'tile.googleapis.com') {
      if (billing) return new Response(JSON.stringify({ error: { code: 403, message: 'This API method requires billing to be enabled. key=check-key', status: 'PERMISSION_DENIED', details: [{ reason: 'BILLING_DISABLED' }] } }), { status: 403 });
      if (u.pathname === '/v1/createSession') return new Response(JSON.stringify({ session: 's', expiry: String(Math.floor(Date.now() / 1000) + 86400) }), { status: 200 });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (u.hostname === 'geocoder.api.gov.bc.ca') {
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-122.84, 49.1] }, properties: { fullAddress: '100 Example St, Surrey, BC', score: 95, matchPrecision: 'CIVIC_NUMBER' } }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    process.env.GOOGLE_MAPS_TILES = '1';
    process.env.GOOGLE_MAPS_SERVER_KEY = 'check-key';
    delete process.env.GEOCODER;
    _resetForTest(); _resetLookupForTest();
    assert.equal((await staff.get('/api/map/check/services')).status, 403);
    assert.equal((await vol.get('/api/map/check/services')).status, 403);
    const bad = ok(await mgr.get('/api/map/check/services'));
    assert.deepEqual([bad.tiles.provider, bad.tiles.viaServer, bad.tiles.probe.ok, bad.tiles.probe.code, bad.tiles.probe.fix],
      ['Google Maps', true, false, 'billing', 'Recipe B step 2']);
    assert.match(bad.tiles.probe.plain, /^Billing isn’t turned on/);
    assert.match(bad.tiles.probe.said, /requires billing/);
    assert.deepEqual([bad.lookup.provider, bad.lookup.fallback, bad.lookup.probe.ok], ['BC Address Geocoder', null, true]);
    assert.ok(!JSON.stringify(bad).includes('check-key'), 'never the key');
    // The quick check is unchanged: no live call in it.
    const quick = ok(await mgr.get('/api/map/check'));
    assert.deepEqual(Object.keys(quick).sort(), ['area', 'build', 'commit', 'people', 'placing', 'tiles', 'turfs']);
    // Google answering again (past the 30 s the answer is kept).
    billing = false;
    _resetForTest(); _resetLookupForTest();
    const good = ok(await mgr.get('/api/map/check/services'));
    assert.equal(good.tiles.probe.ok, true);
    assert.equal(good.tiles.last, null);
    assert.ok(good.tiles.lastOkAt);
    // Google refused the phones' tiles a little while ago, and answers again
    // now: the check says Working, and when it failed and why.
    _resetForTest();
    billing = true;
    const { fetchTile } = await import('../lib/gtiles.js');
    await fetchTile(12, 650, 1400);
    billing = false;
    const after = ok(await mgr.get('/api/map/check/services'));
    assert.equal(after.tiles.probe.ok, true);
    assert.equal(after.tiles.last?.code, 'billing', 'the earlier failure is kept after a good answer');
    assert.match(after.tiles.last.plain, /^Billing isn’t turned on/);
    assert.ok(Date.parse(after.tiles.last.at) <= Date.parse(after.tiles.lastOkAt));
    // A provider the phones reach straight: named, not probed.
    delete process.env.GOOGLE_MAPS_TILES;
    const direct = ok(await mgr.get('/api/map/check/services'));
    assert.deepEqual([direct.tiles.provider, direct.tiles.viaServer, direct.tiles.probe], ['OpenStreetMap', false, null]);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['GOOGLE_MAPS_TILES', prev.t], ['GOOGLE_MAPS_SERVER_KEY', prev.k], ['GEOCODER', prev.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetForTest(); _resetLookupForTest();
  }
});

test('the services check answers within 8 s when Google doesn’t answer at all', async () => {
  const { _resetForTest } = await import('../lib/gtiles.js');
  const { _resetLookupForTest } = await import('../lib/geocode.js');
  const realFetch = globalThis.fetch;
  const prev = { t: process.env.GOOGLE_MAPS_TILES, k: process.env.GOOGLE_MAPS_SERVER_KEY, g: process.env.GEOCODER };
  // Never answers, until the caller gives up.
  globalThis.fetch = (url, init) => (new URL(String(url)).hostname !== 'tile.googleapis.com' ? realFetch(url, init) : new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  }));
  const awake = setInterval(() => {}, 1000); // (the probe's own timer doesn't keep a test alive)
  try {
    process.env.GOOGLE_MAPS_TILES = '1';
    process.env.GOOGLE_MAPS_SERVER_KEY = 'check-key';
    process.env.GEOCODER = 'off';
    _resetForTest(); _resetLookupForTest();
    const t0 = Date.now();
    const r = ok(await mgr.get('/api/map/check/services').finally(() => clearInterval(awake)));
    const took = Date.now() - t0;
    assert.ok(took < 9000, `answered in ${took} ms`);
    assert.deepEqual([r.tiles.probe.ok, r.tiles.probe.code], [false, 'timeout']);
    assert.deepEqual([r.lookup.provider, r.lookup.probe.code], ['off', 'off']);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['GOOGLE_MAPS_TILES', prev.t], ['GOOGLE_MAPS_SERVER_KEY', prev.k], ['GEOCODER', prev.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetForTest(); _resetLookupForTest();
  }
});
