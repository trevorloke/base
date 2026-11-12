// Google Maps as the field map's tiles, through Starbase. Google's Map Tiles
// API hands out tiles against a session, not a plain {z}/{x}/{y} address, so
// the map asks Starbase for /tiles/{z}/{x}/{y}.png (signed in) and Starbase
// fetches each tile from Google with a session it keeps and renews. Tiles
// come back with a day's cache life, and the phone's service worker keeps
// the ones it has drawn for offline canvassing, as with any provider.
//   GOOGLE_MAPS_TILES=1         turn it on
//   GOOGLE_MAPS_SERVER_KEY      a key with the Map Tiles API enabled
//   GOOGLE_MAPS_TILE_TYPE       roadmap (default) | satellite | terrain — the
//                               map's standard look; each person can also pick
//                               the others (/tiles/…png?t=satellite)
// Google's terms ask for its attribution on the map and have their own
// rules on caching and use; the campaign should check them before relying
// on this in the field.
// GOOGLE_MAPS_TILES_URL: a stand-in for Google (tests, local checks) — not for use.
//
// When Google refuses (a bad key, billing off, the API not enabled, quota
// used up) its own words are kept (lib/googleerr.js) and no call goes to
// Google for a minute (30 s after quota), whichever look was asked: every
// phone panning would otherwise send dozens of refused calls a second.
import { googleTrouble } from './googleerr.js';
import { geoBox } from './org.js';

const API = (process.env.GOOGLE_MAPS_TILES_URL || 'https://tile.googleapis.com/v1').replace(/\/$/, '');
export const TILE_PATH = '/tiles/{z}/{x}/{y}.png';
export const MAX_ZOOM = 22;

// The only readers of GOOGLE_MAPS_SERVER_KEY and GOOGLE_MAPS_TILES (the map,
// address lookup and Settings → Services all ask here), so a key pasted with
// a trailing space, or `1` with a newline, reads the same everywhere.
export const googleKey = (env = process.env) => String(env.GOOGLE_MAPS_SERVER_KEY ?? '').trim();
// → 'on' | 'off' | 'unknown' (something set that isn't a yes or a no).
export const googleTilesSetting = (env = process.env) => {
  const v = String(env.GOOGLE_MAPS_TILES ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return 'on';
  if (['', '0', 'false', 'no', 'off'].includes(v)) return 'off';
  return 'unknown';
};
export const googleTilesOn = (env = process.env) => googleTilesSetting(env) === 'on' && Boolean(googleKey(env));
// "Google Maps" in words where the map has no room for Google's logo (its
// tile policy allows the text where space is limited); the live credit for
// the view on screen is creditFor(), below.
export const attribution = () => `Google Maps · Map data &copy;${new Date().getFullYear()} Google`;

export const MAP_TYPES = ['roadmap', 'satellite', 'terrain'];
const sessions = new Map(); // mapType → { token, expiresAt (ms) }
const creating = new Map(); // mapType → the promise making its session

export const mapType = () => {
  const t = String(process.env.GOOGLE_MAPS_TILE_TYPE || '').trim();
  return MAP_TYPES.includes(t) ? t : 'roadmap';
};

// The last refusal, one per server (not per look): { at, until, code,
// plain, said, step, status }. Cleared by the first good tile (that ends the
// pause); lastTrouble keeps it for the Map check's "Failed at …".
let trouble = null;
let lastTrouble = null;
let lastOkAt = null;
const pauseMs = (code) => (code === 'quota' ? 30_000 : 60_000);
const refused = (status, said) => {
  const t = googleTrouble(status, said);
  const at = Date.now();
  const already = pausedFor() > 0; // (tiles already on their way when it began: said once)
  trouble = { at, until: at + pauseMs(t.code), status, ...t };
  lastTrouble = trouble;
  if (!already) console.warn(`map tiles: Google refused (${status} ${t.code}) — no calls to Google for ${pauseMs(t.code) / 1000} s`);
  return trouble;
};
const pausedFor = () => (trouble && Date.now() < trouble.until ? trouble.until - Date.now() : 0);
// What the Map check shows (Stage 2) — never the key.
export const tilesHealth = () => ({ last: lastTrouble ? { ...lastTrouble } : null, lastOkAt });

const keyParam = () => encodeURIComponent(googleKey());
const sessionBody = (type) => JSON.stringify({ mapType: type, language: 'en-CA', region: 'CA', ...(type === 'terrain' ? { layerTypes: ['layerRoadmap'] } : {}) });
const createSession = (type, signal) => fetch(`${API}/createSession?key=${keyParam()}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // terrain needs the roadmap layer on top (Google's rule).
  body: sessionBody(type),
  signal,
});
const getTile = (z, x, y, token, signal) => fetch(`${API}/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(token)}&key=${keyParam()}`, { signal });

class Refused extends Error {
  constructor(t) { super(`Google Map Tiles session: ${t.status} ${t.code}`); this.trouble = t; }
}

// A session lasts about two weeks; one request creates it for everyone. One
// per map type (Google ties the look to the session).
const getSession = async (type, fresh = false) => {
  const s = sessions.get(type);
  if (!fresh && s && Date.now() < s.expiresAt - 60_000) return s.token;
  if (!creating.has(type)) {
    creating.set(type, (async () => {
      const res = await createSession(type);
      if (!res.ok) throw new Refused(refused(res.status, await res.text().catch(() => '')));
      const body = await res.json();
      sessions.set(type, { token: body.session, expiresAt: Number(body.expiry) * 1000 || Date.now() + 86_400_000 });
      return body.session;
    })().finally(() => { creating.delete(type); }));
  }
  return creating.get(type);
};

// → { status, body: ArrayBuffer | null, type, retryAfter? } for one tile, of
// one look. While Google is refusing: 503 at once, with the seconds to wait.
export const fetchTile = async (z, x, y, look = mapType()) => {
  const kind = MAP_TYPES.includes(look) ? look : mapType();
  const wait = () => ({ status: 503, body: null, type: null, retryAfter: Math.max(1, Math.ceil(pausedFor() / 1000)) });
  if (pausedFor()) return wait();
  let res;
  try {
    res = await getTile(z, x, y, await getSession(kind));
    // Renew the session only when it may be what's wrong: Google says so,
    // or a 400/403 we can't place (Google's answer for a dead session with
    // a good key was never seen). Never for a 404 (no tile there), a key,
    // billing or quota refusal — a new session can't fix those. Once.
    if (res.status === 400 || res.status === 403 || res.status === 429) {
      const said = await res.text().catch(() => '');
      const t = googleTrouble(res.status, said);
      if (t.code === 'session' || t.code === 'other') {
        res = await getTile(z, x, y, await getSession(kind, true));
      } else {
        refused(res.status, said); // key, billing, API or quota: pause
        return wait();
      }
    }
  } catch (e) {
    if (e instanceof Refused) return wait();
    throw e;
  }
  if (!res.ok) return { status: res.status, body: null, type: null };
  trouble = null;
  lastOkAt = Date.now();
  return { status: 200, body: await res.arrayBuffer(), type: res.headers.get('content-type') || 'image/png' };
};

// ── One live check (Settings → Services; the Map check) ──
// Its own session, thrown away (never the one the phones use), and one tile
// over the middle of the campaign's area, in 8 s at most; it ignores the
// pause, and a good answer lifts it for every look. Cached 30 s per server,
// so repeated Checks spend one Google call at most every 30 s.
// → { ok, step: 'session'|'tile', code, plain, said, fix }
const PROBE_MS = 8000;
const PROBE_CACHE_MS = 30_000;
let probed = null; // { at, result } | { at, pending }
const tileAt = (lat, lng, z) => {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)),
    y: Math.min(n - 1, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)),
  };
};
const failed = (step, status, body) => {
  const t = googleTrouble(status, body);
  return { ok: false, step, code: t.code, plain: t.plain, said: t.said, fix: t.step };
};
const probeOnce = async () => {
  if (!googleKey()) return { ok: false, step: 'session', code: 'no-key', plain: 'GOOGLE_MAPS_SERVER_KEY isn’t set.', said: '', fix: 'Recipe B step 6' };
  const signal = AbortSignal.timeout(PROBE_MS);
  try {
    const type = mapType();
    const s = await createSession(type, signal);
    if (!s.ok) return failed('session', s.status, await s.text().catch(() => ''));
    const { session } = await s.json();
    const [south, west, north, east] = geoBox();
    const { x, y } = tileAt((south + north) / 2, (west + east) / 2, 12);
    const t = await getTile(12, x, y, session, signal);
    if (!t.ok) return failed('tile', t.status, await t.text().catch(() => ''));
    await t.arrayBuffer();
    trouble = null;
    lastOkAt = Date.now();
    return { ok: true, step: 'tile', code: null, plain: 'Google Map Tiles answering', said: '', fix: null };
  } catch (e) {
    const slow = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, step: 'session', code: slow ? 'timeout' : 'no-answer', plain: slow ? 'Google didn’t answer in 8 s.' : 'Google couldn’t be reached from this server.', said: '', fix: null };
  }
};
export const probeTiles = async () => {
  if (probed && Date.now() - probed.at < PROBE_CACHE_MS) return probed.result ?? probed.pending;
  const pending = probeOnce();
  probed = { at: Date.now(), pending };
  const result = await pending;
  if (probed?.pending === pending) probed = { at: probed.at, result };
  return result;
};

// ── The live credit (GET /api/map/credit) ──
// Google's credit for the part of the map on screen: "Google Maps · " and
// the copyright of its viewport answer. Asked with the session the phones
// already use (never a new one just for the credit); none yet, or Google
// refusing, and it is the static line. One answer per look, zoom and box
// (rounded outward to 0.05°) for an hour, 500 at most: panning about a
// street asks Google once.
const VIEWPORT = `${API.replace(/\/v1$/, '')}/tile/v1/viewport`;
const CREDIT_MS = 3_600_000;
const credits = new Map(); // key → { at, text }
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out05 = (v, up) => Number(((up ? Math.ceil : Math.floor)(v * 20) / 20).toFixed(2));
// box: { zoom, north, south, east, west }, look: a map type → { text }
export const creditFor = async (box, look = mapType()) => {
  const kind = MAP_TYPES.includes(look) ? look : mapType();
  const fallback = { text: attribution() };
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.round(Number(box.zoom))));
  const b = { north: out05(Number(box.north), true), south: out05(Number(box.south), false), east: out05(Number(box.east), true), west: out05(Number(box.west), false) };
  if (![z, ...Object.values(b)].every(Number.isFinite) || b.north > 90 || b.south < -90 || b.south > b.north) return fallback;
  const key = `${kind}:${z}:${b.south}:${b.west}:${b.north}:${b.east}`;
  const kept = credits.get(key);
  if (kept && Date.now() - kept.at < CREDIT_MS) return { text: kept.text };
  const s = sessions.get(kind);
  if (!s || pausedFor() || Date.now() >= s.expiresAt) return fallback;
  try {
    const q = new URLSearchParams({ session: s.token, zoom: String(z), north: String(b.north), south: String(b.south), east: String(b.east), west: String(b.west) });
    const res = await fetch(`${VIEWPORT}?${q}&key=${keyParam()}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return fallback;
    const said = String((await res.json())?.copyright || '').trim().slice(0, 300);
    if (!said) return fallback;
    const text = `Google Maps · ${escapeHtml(said)}`;
    if (credits.size >= 500) credits.delete(credits.keys().next().value);
    credits.set(key, { at: Date.now(), text });
    return { text };
  } catch {
    return fallback;
  }
};

// Tests: forget the sessions, the refusal, the probe and the credits between cases.
export const _resetForTest = () => { sessions.clear(); creating.clear(); trouble = null; lastTrouble = null; lastOkAt = null; probed = null; credits.clear(); };
