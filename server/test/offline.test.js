// Offline field mode, server half: every write the phone's outbox replays is
// recorded exactly once (person.create on a client-made id, sign.place on a
// client_id, contact.log on its client_id), shift.join/leave answer a replay
// with "already on it" / "not on it", and GET /api/map/config names the
// tiles (OpenStreetMap unless STARBASE_TILE_* say otherwise).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { tileConfig, tileSource, TILE_DEFAULTS } from '../ext/offline/index.js';

const tag = Math.random().toString(36).slice(2, 8);
let c; let other; let vol; let ws;

const events = async (who, action) => (await who.get('/api/events?since=0&limit=5000')).json.events
  .filter((e) => !action || e.action === action);

before(async () => {
  await freshDb();
  c = new Client();
  const r = await c.signup({ workspaceName: 'Offline Field', email: `offline.mgr+${tag}@example.org` });
  assert.equal(r.status, 201);
  ws = r.json.workspace.id;
  other = new Client();
  assert.equal((await other.signup({ workspaceName: 'Other Campaign', email: `offline.other+${tag}@example.org` })).status, 201);
  // A volunteer on the first campaign.
  const inv = await c.action('member.invite', { email: `offline.vol+${tag}@example.org`, role: 'volunteer' });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  vol = new Client();
  const token = inv.json.joinUrl.split('/join/')[1];
  const j = await vol.post('/api/auth/join', { token, name: 'Field Volunteer', password: 'knock-knock-2026' });
  assert.ok(j.status === 200 || j.status === 201, JSON.stringify(j.json));
});

const savedEnv = {};
const setEnv = (vars) => {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
};
after(() => setEnv(Object.fromEntries(Object.keys(savedEnv).map((k) => [k, savedEnv[k]]))));

test('person.create on a client-made id: a replay is the same person, logged once', async () => {
  const id = randomUUID();
  const input = { id, name: 'Ana Souza', address: '7155 124 St', lat: 49.1316, lng: -122.8521, phone: '604-555-0105' };
  const first = await c.action('person.create', input);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.person.id, id, 'the phone’s id is the person’s id');
  assert.equal(first.json.duplicate, undefined);

  const again = await c.action('person.create', input);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.person.id, id);
  assert.equal(again.json.person.name, 'Ana Souza');

  const found = (await c.get('/api/persons?q=Ana%20Souza')).json.persons;
  assert.equal(found.length, 1, 'one person, not two');
  const evs = (await events(c, 'person.create')).filter((e) => e.entity_id === id);
  assert.equal(evs.length, 1, 'one create event');
  assert.equal(evs[0].payload.id, id);

  // Without an id it still makes its own.
  const plain = await c.action('person.create', { name: 'Plain Create' });
  assert.equal(plain.status, 200);
  assert.match(plain.json.person.id, /^[0-9a-f-]{36}$/);
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('a person made offline can be knocked right after, in the same order the phone did it', async () => {
  const id = randomUUID();
  const knock = randomUUID();
  assert.equal((await c.action('person.create', { id, name: 'Maya Chen', address: '12390 72 Ave', lat: 49.1331, lng: -122.8495 })).status, 200);
  const k1 = await c.action('contact.log', { person_id: id, channel: 'door', outcome: 'contacted', rating: '1', client_id: knock });
  assert.equal(k1.status, 200, JSON.stringify(k1.json));
  const k2 = await c.action('contact.log', { person_id: id, channel: 'door', outcome: 'contacted', rating: '1', client_id: knock });
  assert.equal(k2.json.duplicate, true);
  const prof = (await c.get(`/api/persons/${id}`)).json;
  assert.equal(prof.person.rating, '1');
  assert.equal(prof.contacts.length, 1, 'the knock is recorded once');
});

test('an id another campaign already holds is refused (409), not a crash', async () => {
  const theirs = await other.action('person.create', { id: randomUUID(), name: 'Their Person' });
  assert.equal(theirs.status, 200);
  const r = await c.action('person.create', { id: theirs.json.person.id, name: 'Collision' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already taken/);
  // And nothing of theirs leaks back.
  assert.equal(r.json.person, undefined);
});

test('volunteers still cannot add people, with or without an id', async () => {
  const r = await vol.action('person.create', { id: randomUUID(), name: 'Not Allowed' });
  assert.equal(r.status, 403);
});

test('sign.place on a client_id: a replay is the same request, once per campaign', async () => {
  const host = await c.createPerson('Sign Host', { address: '7120 124 St', lat: 49.131, lng: -122.852 });
  const client_id = randomUUID();
  const a = await c.action('sign.place', { person_id: host.id, kind: 'lawn', client_id });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const b = await c.action('sign.place', { person_id: host.id, kind: 'lawn', client_id });
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.sign.id, a.json.sign.id);
  assert.equal(b.json.sign.kind, 'lawn');
  const mine = (await c.get('/api/signs')).json.signs.filter((s) => s.person_id === host.id);
  assert.equal(mine.length, 1, 'one sign, not two');
  const evs = (await events(c, 'sign.place')).filter((e) => e.entity_id === a.json.sign.id);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].payload.client_id, client_id, 'the log keeps the outbox key');

  // The same key in another campaign is that campaign's own request.
  const o = await other.action('sign.place', { address: '15013 101 Ave', kind: 'lawn', client_id });
  assert.equal(o.status, 200);
  assert.notEqual(o.json.sign.id, a.json.sign.id);
  assert.equal(o.json.duplicate, undefined);

  // A volunteer's request dedupes too (they file them at the door).
  const vk = randomUUID();
  const v1 = await vol.action('sign.place', { person_id: host.id, kind: 'large', client_id: vk });
  const v2 = await vol.action('sign.place', { person_id: host.id, kind: 'large', client_id: vk });
  assert.equal(v1.status, 200);
  assert.equal(v2.json.duplicate, true);
  // The queued Undo for it: cancel once; a replayed cancel is "already gone".
  assert.equal((await vol.action('sign.cancel', { id: v1.json.sign.id })).status, 200);
  assert.equal((await vol.action('sign.cancel', { id: v1.json.sign.id })).status, 404);
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('shift.join / shift.leave replays answer "already on it" / "not on it"', async () => {
  const shift = (await c.action('shift.create', {
    title: 'Offline canvass', starts_at: new Date(Date.now() + 86400_000).toISOString(), capacity: 4,
  })).json.shift;
  const j1 = await vol.action('shift.join', { shift_id: shift.id });
  assert.equal(j1.status, 200, JSON.stringify(j1.json));
  const j2 = await vol.action('shift.join', { shift_id: shift.id });
  assert.equal(j2.status, 409);
  assert.match(j2.json.error, /already on this shift/, 'the outbox reads this as done');
  const detail = (await vol.get(`/api/shifts/${shift.id}`)).json;
  assert.equal(detail.assignees.filter((a) => a.status === 'confirmed').length, 1, 'on it once');

  const l1 = await vol.action('shift.leave', { shift_id: shift.id });
  assert.equal(l1.status, 200);
  const l2 = await vol.action('shift.leave', { shift_id: shift.id });
  assert.equal(l2.status, 404);
  assert.match(l2.json.error, /not on this shift/, 'the outbox reads this as done');
  // A real refusal reads differently: a missing shift.
  const gone = await vol.action('shift.join', { shift_id: randomUUID() });
  assert.equal(gone.status, 404);
  assert.match(gone.json.error, /shift not found/);
});

test('GET /api/map/config: OpenStreetMap by default, for every signed-in role', async () => {
  setEnv({ STARBASE_TILE_URL: null, STARBASE_TILE_ATTRIBUTION: null, STARBASE_TILE_MAX_ZOOM: null });
  const r = await vol.get('/api/map/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.tiles, { ...TILE_DEFAULTS });
  assert.match(r.json.tiles.attribution, /OpenStreetMap/);
  assert.equal(r.json.setup, undefined, 'a volunteer gets the tiles, not the setup');
  assert.deepEqual((await c.get('/api/map/config')).json.setup,
    { source: 'OpenStreetMap', custom: false, ignored: [], maxZoom: 19 });
  const signedOut = await new Client().get('/api/map/config');
  assert.equal(signedOut.status, 401);
});

test('STARBASE_TILE_* choose the provider; a bad value falls back to OpenStreetMap', async () => {
  setEnv({
    STARBASE_TILE_URL: 'https://tiles.example/streets/{z}/{x}/{y}.png?key=abc',
    STARBASE_TILE_ATTRIBUTION: '&copy; Example Tiles',
    STARBASE_TILE_MAX_ZOOM: '18',
  });
  const r = (await c.get('/api/map/config')).json.tiles;
  assert.deepEqual(r, { url: 'https://tiles.example/streets/{z}/{x}/{y}.png?key=abc', attribution: '&copy; Example Tiles', maxZoom: 18 });

  // A custom provider with no credit line set gets none (never a false OSM credit).
  setEnv({ STARBASE_TILE_ATTRIBUTION: null });
  assert.equal((await c.get('/api/map/config')).json.tiles.attribution, '');

  assert.equal(tileConfig({ STARBASE_TILE_URL: 'ftp://x/{z}/{x}/{y}' }).url, TILE_DEFAULTS.url);
  assert.equal(tileConfig({ STARBASE_TILE_URL: 'https://tiles.example/{z}/{x}.png' }).url, TILE_DEFAULTS.url, 'needs {y}');
  assert.equal(tileConfig({ STARBASE_TILE_MAX_ZOOM: '40' }).maxZoom, 19);
  assert.equal(tileConfig({ STARBASE_TILE_MAX_ZOOM: 'abc' }).maxZoom, 19);
  assert.equal(tileConfig({ STARBASE_TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' }).attribution, TILE_DEFAULTS.attribution,
    'an OpenStreetMap mirror keeps the OpenStreetMap credit');
  setEnv({ STARBASE_TILE_URL: null, STARBASE_TILE_MAX_ZOOM: null });
  assert.ok(ws);
});

test('a mistyped STARBASE_TILE_* is shown to desk roles, not only logged', async () => {
  // Taken: the desk sees the provider by its host (never the key in the address).
  setEnv({ STARBASE_TILE_URL: 'https://tiles.example/streets/{z}/{x}/{y}.png?key=abc', STARBASE_TILE_MAX_ZOOM: '18', STARBASE_TILE_ATTRIBUTION: null });
  let setup = (await c.get('/api/map/config')).json.setup;
  assert.deepEqual(setup, { source: 'tiles.example', custom: true, ignored: [], maxZoom: 18 });
  assert.ok(!JSON.stringify(setup).includes('key=abc'));

  // Mistyped: OpenStreetMap is drawn, and the desk is told which setting didn't take.
  setEnv({ STARBASE_TILE_URL: 'tiles.example/{z}/{x}/{y}.png', STARBASE_TILE_MAX_ZOOM: '25' });
  const r = (await c.get('/api/map/config')).json;
  assert.equal(r.tiles.url, TILE_DEFAULTS.url);
  assert.equal(r.tiles.maxZoom, 19);
  assert.deepEqual(r.setup, { source: 'OpenStreetMap', custom: false, ignored: ['url', 'maxZoom'], maxZoom: 19 });
  // A volunteer's browser never gets it.
  const v = (await vol.get('/api/map/config')).json;
  assert.equal(v.setup, undefined);
  assert.deepEqual(Object.keys(v), ['tiles', 'google'], 'a volunteer: the tiles and whether Google is used (its notice), never the setup (no other looks: no CARTO key)');
  assert.deepEqual(v.google, { tiles: false, places: false });

  setEnv({ STARBASE_TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', STARBASE_TILE_MAX_ZOOM: null });
  setup = (await c.get('/api/map/config')).json.setup;
  assert.equal(setup.source, 'OpenStreetMap', 'an OpenStreetMap mirror is still OpenStreetMap');
  assert.equal(tileSource('https://a.tiles.example:8443/{z}/{x}/{y}.png'), 'a.tiles.example');
  setEnv({ STARBASE_TILE_URL: null });
});

// Every tile address /api/map/config names, looks included.
const addresses = (cfg) => [cfg.tiles.url, ...(cfg.views || []).map((v) => v.url)];
const CARTO = /basemaps\.cartocdn\.com/;

test('no CARTO key: no Clean, and no address on CARTO anywhere — Google on or off, STARBASE_TILE_CLEAN unset or off, any provider', async () => {
  const combos = [];
  for (const google of [null, 'g-key']) {
    for (const clean of [null, 'off']) {
      for (const tileUrl of [null, 'https://tiles.example/{z}/{x}/{y}.png']) {
        for (const provider of [null, 'stadia']) combos.push({ google, clean, tileUrl, provider });
      }
    }
  }
  for (const k of combos) {
    setEnv({ STARBASE_TILE_CARTO_KEY: null, GOOGLE_MAPS_TILES: null, GOOGLE_MAPS_SERVER_KEY: k.google, STARBASE_TILE_CLEAN: k.clean, STARBASE_TILE_URL: k.tileUrl, STARBASE_TILE_PROVIDER: k.provider });
    for (const who of [c, vol]) {
      const cfg = (await who.get('/api/map/config')).json;
      const at = JSON.stringify(k);
      assert.ok(!addresses(cfg).some((u) => CARTO.test(u)), `${at}: ${addresses(cfg)}`);
      assert.ok(!(cfg.views || []).some((v) => v.key === 'clean'), at);
      // With Google the map, the free map behind it is always there: OpenStreetMap.
      if (k.google) {
        const free = cfg.views.filter((v) => v.fallback);
        assert.deepEqual(free.map((v) => [v.key, v.url, v.maxZoom]), [['free', TILE_DEFAULTS.url, 19]], at);
        assert.equal(free[0].attribution, TILE_DEFAULTS.attribution);
      }
    }
  }
  setEnv({ GOOGLE_MAPS_SERVER_KEY: null, STARBASE_TILE_CLEAN: null, STARBASE_TILE_URL: null, STARBASE_TILE_PROVIDER: null });
});

test('with the campaign’s CARTO key: Clean carries it; behind Google, CARTO unless STARBASE_TILE_CLEAN=off; never in setup', async () => {
  setEnv({ STARBASE_TILE_CARTO_KEY: ' carto key/1 ', GOOGLE_MAPS_TILES: null, GOOGLE_MAPS_SERVER_KEY: null, STARBASE_TILE_CLEAN: null, STARBASE_TILE_URL: null, STARBASE_TILE_PROVIDER: null });
  let cfg = (await c.get('/api/map/config')).json;
  assert.deepEqual(cfg.views.map((v) => v.key), ['clean']);
  assert.ok(cfg.views[0].url.endsWith(`?key=${encodeURIComponent('carto key/1')}`), cfg.views[0].url);
  assert.ok(!JSON.stringify(cfg.setup).includes('carto'), 'the key is never in setup');
  // Off: no Clean, key or not.
  setEnv({ STARBASE_TILE_CLEAN: 'off' });
  cfg = (await c.get('/api/map/config')).json;
  assert.equal(cfg.views, undefined);
  // Google the map: the free map behind it is CARTO with the key…
  setEnv({ STARBASE_TILE_CLEAN: null, GOOGLE_MAPS_SERVER_KEY: 'g-key' });
  cfg = (await vol.get('/api/map/config')).json;
  const free = cfg.views.filter((v) => v.fallback);
  assert.deepEqual(free.map((v) => [v.key, v.label]), [['free', 'Free map']]);
  assert.match(free[0].url, /^https:\/\/\{s\}\.basemaps\.cartocdn\.com\/.*\?key=carto%20key%2F1$/);
  assert.match(free[0].attribution, /CARTO/);
  // …and OpenStreetMap with STARBASE_TILE_CLEAN=off: still there.
  setEnv({ STARBASE_TILE_CLEAN: 'off' });
  cfg = (await vol.get('/api/map/config')).json;
  assert.deepEqual(cfg.views.filter((v) => v.fallback).map((v) => [v.key, v.url]), [['free', TILE_DEFAULTS.url]]);
  setEnv({ STARBASE_TILE_CARTO_KEY: null, GOOGLE_MAPS_SERVER_KEY: null, STARBASE_TILE_CLEAN: null });
});

test('a STARBASE_TILE_URL on CARTO: the key added where there is one; without one, kept as set and said', () => {
  const plain = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  const keyed = tileConfig({ STARBASE_TILE_URL: plain, STARBASE_TILE_CARTO_KEY: 'k1' });
  assert.equal(keyed.url, `${plain}?key=k1`);
  assert.deepEqual(keyed.ignored, []);
  const query = tileConfig({ STARBASE_TILE_URL: `${plain}?lang=en`, STARBASE_TILE_CARTO_KEY: 'k1' });
  assert.equal(query.url, `${plain}?lang=en&key=k1`);
  const own = tileConfig({ STARBASE_TILE_URL: `${plain}?key=theirs`, STARBASE_TILE_CARTO_KEY: 'k1' });
  assert.equal(own.url, `${plain}?key=theirs`, 'a key of the operator’s own is left alone');
  const none = tileConfig({ STARBASE_TILE_URL: plain });
  assert.deepEqual([none.url, none.ignored], [plain, ['carto-key']]);
  assert.equal(tileSource(keyed.url), 'CARTO');
});

test('STARBASE_TILE_PROVIDER=stadia: Stadia Maps’ address, credit and zoom in one setting; the address beats it; an unknown one is said', () => {
  const stadia = tileConfig({ STARBASE_TILE_PROVIDER: ' Stadia ' });
  assert.equal(stadia.url, 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png');
  assert.match(stadia.attribution, /Stadia Maps.*OpenMapTiles.*OpenStreetMap/);
  assert.equal(stadia.maxZoom, 20);
  assert.deepEqual(stadia.ignored, []);
  assert.equal(tileSource(stadia.url), 'Stadia Maps');
  // A key, where the provider can't be told the campaign's own address.
  const keyed = tileConfig({ STARBASE_TILE_PROVIDER: 'stadia', STARBASE_TILE_KEY: 'stadia-key ' });
  assert.equal(keyed.url, 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=stadia-key');
  assert.match(keyed.attribution, /Stadia Maps/);
  // STARBASE_TILE_URL wins over the preset.
  const own = tileConfig({ STARBASE_TILE_PROVIDER: 'stadia', STARBASE_TILE_URL: 'https://tiles.example/{z}/{x}/{y}.png' });
  assert.deepEqual([own.url, own.attribution, own.maxZoom], ['https://tiles.example/{z}/{x}/{y}.png', '', 19]);
  const unknown = tileConfig({ STARBASE_TILE_PROVIDER: 'mapbox' });
  assert.deepEqual([unknown.url, unknown.ignored], [TILE_DEFAULTS.url, ['provider']]);
  assert.equal(tileSource('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'), 'CARTO');
});

test('a provider of the campaign’s own (the preset or an address) offers no free map and no Clean', async () => {
  setEnv({ STARBASE_TILE_PROVIDER: 'stadia', STARBASE_TILE_URL: null });
  const pre = (await vol.get('/api/map/config')).json;
  assert.match(pre.tiles.url, /stadiamaps/);
  assert.equal(pre.views, undefined, 'no fallback for a direct provider');
  setEnv({ STARBASE_TILE_PROVIDER: null, STARBASE_TILE_URL: 'https://tiles.example/{z}/{x}/{y}.png' });
  assert.equal((await vol.get('/api/map/config')).json.views, undefined);
  // The credit line is every role's (with Google off: the provider's own).
  const credit = await vol.get('/api/map/credit?z=12&n=49.2&s=49.1&e=-122.8&w=-122.9');
  assert.deepEqual([credit.status, credit.json.text], [200, '']);
  setEnv({ STARBASE_TILE_URL: null });
});
