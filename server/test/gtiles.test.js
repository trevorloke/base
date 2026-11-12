// Google Maps as the field map's tiles (lib/gtiles.js + ext/offline):
// /api/map/config points the map at /tiles/…, which Starbase serves from
// Google with a session it keeps. Google is mocked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { _resetForTest, probeTiles, tilesHealth } from '../lib/gtiles.js';

let mgr;
const realFetch = globalThis.fetch;
const env = { ...process.env };
const log = [];
let sessionN = 0;
let tileStatus = 200;
let viewportStatus = 200;
let sessionAnswer = null; // { status, body }: Google refuses the session
const tileAnswers = []; // { status, body }: the next tiles' answers, in turn
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname !== 'tile.googleapis.com') return realFetch(url, init);
    log.push({ path: u.pathname, key: u.searchParams.get('key'), session: u.searchParams.get('session'), body: init?.body });
    if (u.pathname === '/v1/createSession') {
      if (sessionAnswer) return new Response(JSON.stringify(sessionAnswer.body), { status: sessionAnswer.status });
      sessionN += 1;
      return new Response(JSON.stringify({ session: `sess-${sessionN}`, expiry: String(Math.floor(Date.now() / 1000) + 14 * 86400), tileWidth: 256, tileHeight: 256, imageFormat: 'png' }), { status: 200 });
    }
    if (u.pathname === '/tile/v1/viewport') {
      if (viewportStatus !== 200) return new Response('{"error":{"code":500}}', { status: viewportStatus });
      return new Response(JSON.stringify({ copyright: 'Map data ©2026 Google & <Partners>', maxZoomRects: [] }), { status: 200 });
    }
    const next = tileAnswers.shift();
    if (next) return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status });
    if (tileStatus !== 200) return new Response('no', { status: tileStatus });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GOOGLE_MAPS_TILES', 'GOOGLE_MAPS_SERVER_KEY', 'GOOGLE_MAPS_TILE_TYPE', 'STARBASE_TILE_CLEAN']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

const get = (path, cookie) => app.request(path, { headers: cookie ? { cookie } : {} });

test('off by default: OpenStreetMap, and /tiles is not a thing', async () => {
  delete process.env.GOOGLE_MAPS_TILES;
  const cfg = await (await get('/api/map/config', mgr.cookie)).json();
  assert.match(cfg.tiles.url, /openstreetmap/);
  assert.equal((await get('/tiles/14/2611/5636.png', mgr.cookie)).status, 404);
  // Turned on without a key: still OpenStreetMap, and the desk is told.
  process.env.GOOGLE_MAPS_TILES = '1';
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  const noKey = await (await get('/api/map/config', mgr.cookie)).json();
  assert.match(noKey.tiles.url, /openstreetmap/);
  assert.deepEqual(noKey.setup.ignored, ['google']);
});

test('on: the map draws /tiles from Starbase, credited to Google, up to zoom 22', async () => {
  process.env.GOOGLE_MAPS_TILES = '1';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'tiles-key';
  _resetForTest();
  const cfg = await (await get('/api/map/config', mgr.cookie)).json();
  assert.equal(cfg.tiles.url, '/tiles/{z}/{x}/{y}.png');
  assert.match(cfg.tiles.attribution, /Google/);
  assert.equal(cfg.tiles.maxZoom, 22);
  assert.equal(cfg.setup.source, 'Google Maps');
});

test('a tile: signed in only; one Google session shared and reused; bytes, type and a day of cache', async () => {
  log.length = 0;
  assert.equal((await get('/tiles/14/2611/5636.png')).status, 401, 'no cookie');
  const r = await get('/tiles/14/2611/5636.png', mgr.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(Buffer.from(await r.arrayBuffer()).compare(PNG), 0);
  const r2 = await get('/tiles/14/2612/5636.png', mgr.cookie);
  assert.equal(r2.status, 200);
  assert.equal(log.filter((l) => l.path === '/v1/createSession').length, 1, 'one session for both tiles');
  assert.equal(JSON.parse(log[0].body).mapType, 'roadmap');
  assert.ok(log.every((l) => l.key === 'tiles-key'));
  const tiles = log.filter((l) => l.path.startsWith('/v1/2dtiles/'));
  assert.deepEqual(tiles.map((l) => l.path), ['/v1/2dtiles/14/2611/5636', '/v1/2dtiles/14/2612/5636']);
  assert.ok(tiles.every((l) => l.session === 'sess-1'));
});

test('bad coordinates are refused; a rejected session is renewed once; Google down is a 502', async () => {
  for (const p of ['/tiles/23/0/0.png', '/tiles/3/9/0.png', '/tiles/a/0/0.png', '/tiles/-1/0/0.png']) {
    assert.equal((await get(p, mgr.cookie)).status, 400, p);
  }
  log.length = 0;
  tileStatus = 403; // Google no longer takes the session
  const r = await get('/tiles/10/160/350.png', mgr.cookie);
  assert.equal(r.status, 502);
  assert.equal(log.filter((l) => l.path === '/v1/createSession').length, 1, 'a new session was tried');
  assert.equal(log.filter((l) => l.path.startsWith('/v1/2dtiles/')).length, 2, 'then the tile once more');
  tileStatus = 200;
  assert.equal((await get('/tiles/10/160/350.png', mgr.cookie)).status, 200, 'the new session works');
});

test('other looks: Satellite and Terrain offered with Google on; each its own session; an unknown look is the standard one', async () => {
  process.env.GOOGLE_MAPS_TILES = '1';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'tiles-key';
  tileStatus = 200;
  _resetForTest();
  log.length = 0;
  const cfg = await (await get('/api/map/config', mgr.cookie)).json();
  assert.deepEqual(cfg.views.map((v) => [v.key, v.label, v.url, Boolean(v.fallback)]), [
    ['satellite', 'Satellite', '/tiles/{z}/{x}/{y}.png?t=satellite', false],
    ['terrain', 'Terrain', '/tiles/{z}/{x}/{y}.png?t=terrain', false],
    // The free map the map goes to by itself while Google isn't answering:
    // never 'clean' (nearly every phone has that saved as its pick).
    ['free', 'Free map', 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', true],
  ]);
  assert.ok(!cfg.views.some((v) => v.key === 'clean'));
  process.env.STARBASE_TILE_CLEAN = 'off';
  assert.ok(!(await (await get('/api/map/config', mgr.cookie)).json()).views.some((v) => v.fallback), 'STARBASE_TILE_CLEAN=off: no free map');
  delete process.env.STARBASE_TILE_CLEAN;
  assert.equal((await get('/tiles/14/2611/5636.png?t=satellite', mgr.cookie)).status, 200);
  assert.equal((await get('/tiles/14/2611/5636.png?t=satellite', mgr.cookie)).status, 200);
  assert.equal((await get('/tiles/14/2611/5636.png?t=bogus', mgr.cookie)).status, 200);
  const made = log.filter((l) => l.path === '/v1/createSession').map((l) => JSON.parse(l.body).mapType);
  assert.deepEqual(made, ['satellite', 'roadmap'], 'one satellite session reused; bogus → the standard look');
  delete process.env.GOOGLE_MAPS_TILES;
  const off = await (await get('/api/map/config', mgr.cookie)).json();
  assert.deepEqual(off.views.map((v) => [v.key, v.label]), [['clean', 'Clean']], 'OpenStreetMap: Clean, a quiet map of the same streets (Muted and Dark are the phone’s own)');
  assert.match(off.views[0].url, /^https:\/\/\{s\}\.basemaps\.cartocdn\.com\/light_all\//);
  assert.match(off.views[0].attribution, /OpenStreetMap/);
  process.env.STARBASE_TILE_CLEAN = 'off';
  assert.equal((await (await get('/api/map/config', mgr.cookie)).json()).views, undefined, 'STARBASE_TILE_CLEAN=off leaves it out');
  delete process.env.STARBASE_TILE_CLEAN;
});

// ── Why a good key failed, and no hammering after a refusal ──
// Google's real answer to a key it doesn't know (captured live).
const KEY_INVALID = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'tile.googleapis.com' } }] } };
const sessions = () => log.filter((l) => l.path === '/v1/createSession').length;
const google = (key = 'tiles-key') => {
  process.env.GOOGLE_MAPS_TILES = '1';
  process.env.GOOGLE_MAPS_SERVER_KEY = key;
  delete process.env.GOOGLE_MAPS_TILE_TYPE;
  sessionAnswer = null;
  tileAnswers.length = 0;
  tileStatus = 200;
  _resetForTest();
  log.length = 0;
};

test('one reading of the settings: a key or a 1 pasted with a newline works, on the map and in Services alike', async () => {
  google(' tiles-key\n');
  process.env.GOOGLE_MAPS_TILES = '1\n';
  const cfg = await (await get('/api/map/config', mgr.cookie)).json();
  assert.equal(cfg.tiles.url, '/tiles/{z}/{x}/{y}.png');
  assert.equal((await get('/tiles/14/2611/5636.png', mgr.cookie)).status, 200);
  assert.ok(log.every((l) => l.key === 'tiles-key'), 'the key is sent trimmed');
  const services = await (await get('/api/connections', mgr.cookie)).json();
  const tiles = services.services.find((x) => x.key === 'tiles');
  assert.deepEqual([tiles.name, tiles.state], ['Map background (Google Map Tiles)', 'ready']);
  for (const on of ['true', 'Yes', ' on ']) {
    process.env.GOOGLE_MAPS_TILES = on;
    assert.equal((await (await get('/api/map/config', mgr.cookie)).json()).tiles.url, '/tiles/{z}/{x}/{y}.png', on);
  }
  // A deliberate off is quietly off; a value that isn't a yes or a no is said.
  for (const off of ['0', 'off', 'false', '']) {
    process.env.GOOGLE_MAPS_TILES = off;
    const c = await (await get('/api/map/config', mgr.cookie)).json();
    assert.match(c.tiles.url, /openstreetmap/, off);
    assert.deepEqual(c.setup.ignored, [], off);
  }
  process.env.GOOGLE_MAPS_TILES = 'maybe';
  const unsure = await (await get('/api/map/config', mgr.cookie)).json();
  assert.match(unsure.tiles.url, /openstreetmap/);
  assert.deepEqual(unsure.setup.ignored, ['google']);
});

test('a refused key: 50 tiles make one call to Google, then 503 with Retry-After, on every look', async () => {
  google('bad-key');
  sessionAnswer = { status: 400, body: KEY_INVALID };
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    for (let i = 0; i < 50; i += 1) {
      const r = await get(`/tiles/14/${2600 + i}/5636.png`, mgr.cookie);
      assert.equal(r.status, 503);
      assert.ok(Number(r.headers.get('retry-after')) > 0 && Number(r.headers.get('retry-after')) <= 60);
      assert.doesNotMatch(await r.text(), /bad-key/);
    }
    assert.equal(sessions(), 1, 'exactly one createSession');
    // One pause per server: Satellite isn't asked either.
    assert.equal((await get('/tiles/14/2611/5636.png?t=satellite', mgr.cookie)).status, 503);
    assert.equal(log.length, 1, 'nothing more went to Google');
    const { last } = tilesHealth();
    assert.equal(last.code, 'key-invalid');
    assert.equal(last.said, 'API key not valid. Please pass a valid API key.');
    assert.equal(last.step, 'Recipe B step 6');
  } finally { console.warn = realWarn; }
  assert.ok(warns.length >= 1 && warns.every((w) => !/bad-key/.test(w)), 'no key in a log line');
});

test('renewal only when it may help: never for a 404 or a key refusal; once for a session or an unplaced 400', async () => {
  google();
  assert.equal((await get('/tiles/14/2611/5636.png', mgr.cookie)).status, 200);
  assert.equal(sessions(), 1);
  // No data for that tile: passed on, the session kept.
  tileAnswers.push({ status: 404, body: { error: { code: 404, message: 'Tile not found.', status: 'NOT_FOUND' } } });
  assert.equal((await get('/tiles/14/2612/5636.png', mgr.cookie)).status, 404);
  assert.equal(sessions(), 1, 'a 404 makes no new session');
  // Google says the session ended: renewed exactly once, then the tile.
  tileAnswers.push({ status: 400, body: { error: { code: 400, message: 'The session token is expired.', status: 'INVALID_ARGUMENT' } } });
  assert.equal((await get('/tiles/14/2613/5636.png', mgr.cookie)).status, 200);
  assert.equal(sessions(), 2, 'one renewal');
  // An unplaced 400: renewed once, and the retried tile works.
  tileAnswers.push({ status: 400, body: 'Bad Request' });
  const r = await get('/tiles/14/2614/5636.png', mgr.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(sessions(), 3);
  // Both answers unplaced: one renewal only, then 502.
  tileAnswers.push({ status: 403, body: 'no' }, { status: 403, body: 'no' });
  assert.equal((await get('/tiles/14/2615/5636.png', mgr.cookie)).status, 502);
  assert.equal(sessions(), 4);
  // The key refused on a tile: no renewal, and the pause starts.
  tileAnswers.push({ status: 403, body: { error: { code: 403, message: 'Requests from referer <empty> are blocked.', status: 'PERMISSION_DENIED',
    details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } } });
  assert.equal((await get('/tiles/14/2616/5636.png', mgr.cookie)).status, 503);
  assert.equal(sessions(), 4, 'a key refusal never renews');
  assert.equal(tilesHealth().last.code, 'referrer');
  const before = log.length;
  assert.equal((await get('/tiles/14/2617/5636.png', mgr.cookie)).status, 503);
  assert.equal(log.length, before, 'paused');
});

test('the live check: its own session, never kept; a good answer lifts the pause; cached 30 s', async () => {
  google();
  sessionAnswer = { status: 403, body: { error: { code: 403, message: 'This API method requires billing to be enabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'BILLING_DISABLED' }] } } };
  assert.equal((await get('/tiles/14/2611/5636.png', mgr.cookie)).status, 503);
  assert.equal(tilesHealth().last.code, 'billing');
  const bad = await probeTiles();
  assert.deepEqual({ ok: bad.ok, step: bad.step, code: bad.code, fix: bad.fix }, { ok: false, step: 'session', code: 'billing', fix: 'Recipe B step 2' });
  assert.equal(sessions(), 2, 'the check asks even while paused');
  // Billing turned on: within 30 s the check gives its last answer, not a new call.
  sessionAnswer = null;
  assert.equal((await probeTiles()).ok, false);
  assert.equal(sessions(), 2, 'cached');
  _resetForTest();
  log.length = 0;
  sessionAnswer = { status: 403, body: { error: { code: 403, message: 'This API method requires billing to be enabled.', details: [{ reason: 'BILLING_DISABLED' }] } } };
  assert.equal((await get('/tiles/14/2611/5636.png', mgr.cookie)).status, 503, 'paused again');
  sessionAnswer = null;
  const good = await probeTiles();
  assert.equal(good.ok, true);
  assert.equal(tilesHealth().last.code, 'billing', 'kept for the Map check’s “Failed at …” (the next tile shows the pause is lifted)');
  const probeTile = log.find((l) => l.path.startsWith('/v1/2dtiles/12/'));
  assert.ok(probeTile, 'one tile at zoom 12 over the campaign');
  // The phones' own session is made fresh: the check's was thrown away.
  assert.equal((await get('/tiles/14/2611/5636.png', mgr.cookie)).status, 200);
  const tile = log.filter((l) => l.path.startsWith('/v1/2dtiles/14/')).at(-1);
  assert.notEqual(tile.session, probeTile.session);
  assert.equal(sessions(), 3);
});

test('the credit line: “Google Maps” in words; the live one for the view, asked once per box an hour, the static one on any trouble', async () => {
  google();
  const cfg = await (await get('/api/map/config', mgr.cookie)).json();
  assert.match(cfg.tiles.attribution, /^Google Maps · Map data &copy;\d{4} Google$/);
  const credit = (q) => get(`/api/map/credit?${q}`, mgr.cookie).then((r) => { assert.equal(r.status, 200); return r.json(); });
  const box = 'z=15&n=49.191&s=49.172&e=-122.83&w=-122.86';
  // No session yet: never a new one just for the credit.
  assert.equal((await credit(box)).text, cfg.tiles.attribution);
  assert.equal(sessions(), 0);
  assert.equal((await get('/tiles/15/5200/11300.png', mgr.cookie)).status, 200);
  const live = await credit(box);
  assert.equal(live.text, 'Google Maps · Map data ©2026 Google &amp; &lt;Partners&gt;', 'Google’s words, never as markup');
  // A small pan inside the same 0.05° box: no new call.
  assert.deepEqual(await credit('z=15&n=49.193&s=49.171&e=-122.831&w=-122.858'), live);
  const asked = log.filter((l) => l.path === '/tile/v1/viewport');
  assert.equal(asked.length, 1, 'two moves in one box: one viewport call');
  assert.equal(asked[0].session, log.find((l) => l.path.startsWith('/v1/2dtiles/')).session, 'the phones’ own session');
  // Google failing, or nonsense asked: the static line, never a 5xx.
  viewportStatus = 500;
  assert.equal((await credit('z=12&n=49.3&s=49.0&e=-122.6&w=-122.9')).text, cfg.tiles.attribution);
  assert.equal((await credit('z=a&n=x')).text, cfg.tiles.attribution);
  viewportStatus = 200;
  for (const l of log) assert.equal(l.key, 'tiles-key');
  assert.ok(!JSON.stringify(live).includes('tiles-key'));
});
