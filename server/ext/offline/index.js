// Offline field mode — the server half.
//
//   sql   signs.client_id: the offline outbox's key for a sign request, so a
//         request replayed after reconnecting is the same request (sign.place
//         dedupes on it, per workspace). person.create dedupes on a client-made
//         id and contact.log already has its own client_id.
//   api   GET /api/map/config (signed in, every role): which map tiles to draw.
//         Desk roles also get `setup` — where the tiles come from and which
//         STARBASE_TILE_* settings were ignored — so whoever set them sees it
//         on the map (a mistyped value is otherwise only a server-log line).
//
// Map tiles come from OpenStreetMap unless the deployment names its own
// provider (OSM's volunteer servers are not for heavy use — a big team in
// election week should switch):
//   STARBASE_TILE_URL          https://…/{z}/{x}/{y}.png  ({s} optional)
//   STARBASE_TILE_ATTRIBUTION  the provider's credit line (links allowed)
//   STARBASE_TILE_MAX_ZOOM     1–22 (default 19)
// Or a provider by name, its address and credit filled in:
//   STARBASE_TILE_PROVIDER     stadia — Stadia Maps' Alidade Smooth (STARBASE_TILE_URL,
//                              if set, wins over it)
//   STARBASE_TILE_KEY          the provider's key, if it isn't set to know the
//                              campaign's own web address (phones can see it)
// Read on every request, so a restart is all a change needs.
// Google Maps instead (lib/gtiles.js): whenever GOOGLE_MAPS_SERVER_KEY is
// set (a key with the Map Tiles API enabled), unless GOOGLE_MAPS_TILES=off.
// The map then draws /tiles/{z}/{x}/{y}.png from Starbase (signed in), which
// fetches each tile from Google; STARBASE_TILE_* is ignored while it's on.
//   GOOGLE_TILES_DAILY_MAX   tiles a day (the campaign's day); past it the
//                            tiles answer 503 until midnight and phones turn
//                            to the free map by themselves. Default: none.
// The Clean look (CARTO's free map) only with the campaign's own CARTO key:
// since late August 2026 CARTO answers a request with no key with a picture
// reading "API KEY REQUIRED", which loads like any tile — a map of no streets.
//   STARBASE_TILE_CARTO_KEY  CARTO's free basemap key (phones can see it, as
//                            CARTO's browser keys are meant to be used)
//   STARBASE_TILE_CLEAN=off  never offer CARTO, key or not. The free map
//                            behind Google stays (OpenStreetMap then).
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb } from '../../db/client.js';
import { loadContext, SESSION_COOKIE } from '../../lib/auth.js';
import { googleTilesOn, googleTilesSetting, googleKey, fetchTile, creditFor, attribution as googleCredit, TILE_PATH as GOOGLE_PATH, MAX_ZOOM as GOOGLE_MAX, MAP_TYPES, mapType } from '../../lib/gtiles.js';
import { here } from '../../lib/mount.js';
import { scrub } from '../../lib/googleerr.js';
import { tilesLeft, secondsToMidnight } from '../../lib/gusage.js';
import { placesFor } from '../../lib/places.js';

export const sql = `
alter table signs add column if not exists client_id uuid;
create unique index if not exists signs_client_idx on signs (workspace_id, client_id) where client_id is not null;
`;

export const TILE_DEFAULTS = Object.freeze({
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
});

// Providers by name (STARBASE_TILE_PROVIDER). Stadia's credit is the one its
// documentation shows for its OpenMapTiles-based styles.
const PRESETS = {
  stadia: {
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 20,
  },
};

// A tile template the map can use: http(s), with {z}, {x} and {y}.
const validUrl = (v) => {
  const s = String(v || '').trim();
  if (!/^https?:\/\/[^\s/]+\/\S*$/i.test(s) || s.length > 1000) return null;
  if (!['{z}', '{x}', '{y}'].every((p) => s.includes(p))) return null;
  return s;
};

// CARTO's free basemaps: only with a key (above). The parameter name is
// CARTO's FAQ's, read through a search extract (carto.com isn't reachable
// from where this was built).
export const CARTO_KEY_PARAM = 'key';
const isCarto = (url) => /(^|\.)basemaps\.cartocdn\.com$/i.test(hostOf(url));
const hasCartoKey = (url) => new RegExp(`[?&]${CARTO_KEY_PARAM}=`).test(String(url));
const cartoKey = (env) => String(env.STARBASE_TILE_CARTO_KEY ?? '').trim();
const withCartoKey = (url, key) => `${url}${url.includes('?') ? '&' : '?'}${CARTO_KEY_PARAM}=${encodeURIComponent(key)}`;

const warned = new Set();
const warnOnce = (msg) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`map tiles: ${msg}`);
};

// ignored: which settings were set but can't be used ('url', 'maxZoom').
export const tileConfig = (env = process.env) => {
  const out = { ...TILE_DEFAULTS, ignored: [] };
  if (googleTilesOn(env)) {
    return { url: GOOGLE_PATH, attribution: googleCredit(), maxZoom: GOOGLE_MAX, ignored: [] };
  }
  // A deliberate 0/off is quietly off, and so is no setting with no key
  // (nothing set up, nothing wrong); on without a key, or a value that isn't
  // a yes or a no, is said on the map's sheet.
  const google = googleTilesSetting(env);
  if (google === 'on') {
    out.ignored.push('google');
    warnOnce('GOOGLE_MAPS_TILES=1 needs GOOGLE_MAPS_SERVER_KEY — using OpenStreetMap');
  } else if (google === 'unknown') {
    out.ignored.push('google');
    warnOnce(`GOOGLE_MAPS_TILES=${String(env.GOOGLE_MAPS_TILES).trim().slice(0, 40)} isn’t understood — use 1`);
  }
  const presetName = String(env.STARBASE_TILE_PROVIDER ?? '').trim().toLowerCase();
  const preset = PRESETS[presetName] || null;
  if (presetName && !preset) {
    out.ignored.push('provider');
    warnOnce(`STARBASE_TILE_PROVIDER=${presetName.slice(0, 40)} isn’t known — use stadia`);
  }
  if (preset) {
    const key = String(env.STARBASE_TILE_KEY ?? '').trim();
    out.url = key ? `${preset.url}?api_key=${encodeURIComponent(key)}` : preset.url;
    out.attribution = preset.attribution;
    out.maxZoom = preset.maxZoom;
  }
  if (env.STARBASE_TILE_URL) {
    const url = validUrl(env.STARBASE_TILE_URL);
    if (url) {
      out.url = url;
      if (!preset || !url.startsWith(preset.url)) out.maxZoom = TILE_DEFAULTS.maxZoom;
      // An address on CARTO (the docs once suggested one for the quiet look):
      // the key added when there is one; without it, kept as set and said.
      if (isCarto(url) && !hasCartoKey(url)) {
        if (cartoKey(env)) out.url = withCartoKey(url, cartoKey(env));
        else {
          out.ignored.push('carto-key');
          warnOnce('STARBASE_TILE_URL points at CARTO, which needs a key now (STARBASE_TILE_CARTO_KEY)');
        }
      }
    } else {
      out.ignored.push('url');
      warnOnce('STARBASE_TILE_URL needs http(s) and {z}/{x}/{y} — using OpenStreetMap');
    }
  }
  // A custom provider without its own credit line gets none rather than
  // OpenStreetMap's (that would be a false credit).
  if (env.STARBASE_TILE_ATTRIBUTION != null && env.STARBASE_TILE_ATTRIBUTION !== '') {
    out.attribution = String(env.STARBASE_TILE_ATTRIBUTION).slice(0, 500);
  } else if (!/openstreetmap\.org\//i.test(out.url) && !(preset && out.url.startsWith(preset.url))) {
    out.attribution = '';
  }
  if (env.STARBASE_TILE_MAX_ZOOM) {
    const z = Number(env.STARBASE_TILE_MAX_ZOOM);
    if (Number.isInteger(z) && z >= 1 && z <= 22) out.maxZoom = z;
    else {
      out.ignored.push('maxZoom');
      warnOnce('STARBASE_TILE_MAX_ZOOM must be a whole number 1–22 — using 19');
    }
  }
  return out;
};

// Where the tiles come from, in a word: "OpenStreetMap", or the provider's
// host ("tiles.example") — never the whole address (it may carry a key).
const hostOf = (url) => { try { return new URL(String(url).replace(/\{s\}/g, 'a')).hostname; } catch { return ''; } };
export const tileSource = (url) => {
  if (url === GOOGLE_PATH) return 'Google Maps';
  if (url === TILE_DEFAULTS.url || /(^|\.)openstreetmap\.org$/i.test(hostOf(url))) return 'OpenStreetMap';
  if (/(^|\.)stadiamaps\.com$/i.test(hostOf(url))) return 'Stadia Maps';
  if (/(^|\.)cartocdn\.com$/i.test(hostOf(url))) return 'CARTO';
  return hostOf(url) || 'custom';
};

const DESK = ['manager', 'treasurer', 'staff'];
export const api = new Hono();
const CLEAN_VIEW = {
  key: 'clean',
  label: 'Clean',
  url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 20,
};
// Clean, with the campaign's CARTO key — or null: no key, or
// STARBASE_TILE_CLEAN=off. No address built here names CARTO without it.
export const cartoView = (env = process.env) => {
  const key = cartoKey(env);
  if (!key || env.STARBASE_TILE_CLEAN === 'off') return null;
  return { ...CLEAN_VIEW, url: withCartoKey(CLEAN_VIEW.url, key) };
};
// The free map behind Google, always there while Google is the map (phones
// turn to it by themselves while Google isn't answering, or past the daily
// ceiling): CARTO with its key, else OpenStreetMap's standard tiles.
export const freeView = (env = process.env) => {
  const carto = cartoView(env);
  const base = carto || { url: TILE_DEFAULTS.url, attribution: TILE_DEFAULTS.attribution, maxZoom: TILE_DEFAULTS.maxZoom };
  return { key: 'free', label: 'Free map', url: base.url, attribution: base.attribution, maxZoom: base.maxZoom, fallback: true };
};

api.get('/map/config', (c) => {
  const t = tileConfig();
  // The server's own tiles (Google through the server) are under the client's
  // path on base.win (lib/mount.js).
  const own = (u) => (u.startsWith('/') ? here(c, u) : u);
  const out = { tiles: { url: own(t.url), attribution: t.attribution, maxZoom: t.maxZoom } };
  // Other looks a person can pick on the map (Show → Map). With Google on:
  // its other map types, through the same key. (Muted and Dark are the
  // phone's own, over any tiles.)
  // Who Google is to the people using it (its terms ask that they're told):
  // the map, and the address box when Google's suggestions are on.
  const places = Boolean(googleKey()) && ['off', 'no-key', 'no-logo'].every((r) => placesFor(null) !== r);
  out.google = { tiles: t.url === GOOGLE_PATH, places };
  if (t.url === GOOGLE_PATH) {
    const words = { roadmap: 'Streets', satellite: 'Satellite', terrain: 'Terrain' };
    // The standard look's word (Show → Map: no Muted or Dark over Google's
    // tiles — its imagery may not be altered).
    out.standardLabel = words[mapType()];
    out.views = MAP_TYPES.filter((k) => k !== mapType()).map((k) => ({
      key: k, label: words[k], url: own(`${GOOGLE_PATH}?t=${k}`), attribution: t.attribution, maxZoom: t.maxZoom,
    }));
    // While Google isn't answering, volunteers keep streets: the map goes to
    // this free map by itself (never offered as a pick — key 'free', not
    // 'clean', which many phones have saved and would then draw in place of
    // Google). Always there: no setting removes it.
    out.views.push(freeView());
  } else if (t.url === TILE_DEFAULTS.url && cartoView()) {
    // On the standard OpenStreetMap tiles, with a CARTO key: Clean, a light,
    // quiet map of the same streets (CARTO's Positron) — no shop icons,
    // parking lots or house numbers, so the doors are what you see. The map
    // opens on it when it is offered (mapView.js defaultLook).
    out.views = [cartoView()];
  }
  // Desk roles: what took, so a mistyped setting shows on the map's sheet.
  if (DESK.includes(c.get('ctx')?.role)) {
    out.setup = { source: tileSource(t.url), custom: t.url !== TILE_DEFAULTS.url, ignored: t.ignored, maxZoom: t.maxZoom };
  }
  return c.json(out);
});

// Google's live credit for the part of the map on screen (lib/gtiles.js
// creditFor), signed in, every role: ?z&n&s&e&w&t (t: the look). Never a
// 5xx — anything wrong is the static credit line.
api.get('/map/credit', async (c) => {
  if (!googleTilesOn()) return c.json({ text: tileConfig().attribution });
  const q = c.req.query();
  try {
    return c.json(await creditFor({ zoom: q.z, north: q.n, south: q.s, east: q.e, west: q.w }, q.t || undefined));
  } catch {
    return c.json({ text: googleCredit() });
  }
});

// The Google tiles, for anyone signed in (the map sends the session cookie).
// Google's own cache rules, made private: never a longer life than Google
// gave, and none at all when it gave none. The service worker doesn't keep
// them (Google's terms: no offline use). A Google answer slower than its
// limit is 504, not a refusal (no pause); anything else thrown is 502.
export const privateCache = (google) => {
  const v = String(google || '').trim();
  if (!v) return 'private, no-cache';
  // Google's words, with `public` turned private (one signed-in person's copy).
  const parts = v.split(',').map((p) => p.trim()).filter((p) => p && !/^public$/i.test(p));
  return parts.some((p) => /^private$/i.test(p)) ? parts.join(', ') : ['private', ...parts].join(', ');
};
export const publicRoutes = new Hono();
publicRoutes.get('/tiles/:z/:x/:y', async (c) => {
  if (!googleTilesOn()) return c.text('Not found', 404);
  const ctx = await loadContext(await getDb(), getCookie(c, SESSION_COOKIE)).catch(() => null);
  if (!ctx) return c.text('Sign in to see the map', 401);
  const z = Number(c.req.param('z'));
  const [x, y] = [c.req.param('x'), c.req.param('y').replace(/\.png$/, '')].map(Number);
  const n = 2 ** z;
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > GOOGLE_MAX || x < 0 || y < 0 || x >= n || y >= n) {
    return c.text('No such tile', 400);
  }
  // Today's ceiling reached: the free map until the campaign's midnight.
  if (!tilesLeft()) return c.text('Map tiles unavailable', 503, { 'Retry-After': String(secondsToMidnight()) });
  let t;
  try {
    t = await fetchTile(z, x, y, c.req.query('t') || undefined);
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return c.text('Map tiles unavailable', 504);
    console.warn(`map tiles: ${scrub(e.message)}`);
    return c.text('Map tiles unavailable', 502);
  }
  // Google is refusing: no call to it until the pause ends (lib/gtiles.js).
  if (t.retryAfter) return c.text('Map tiles unavailable', 503, { 'Retry-After': String(t.retryAfter) });
  if (!t.body) return c.text('Map tiles unavailable', t.status === 404 ? 404 : 502);
  c.header('Content-Type', t.type);
  c.header('Cache-Control', privateCache(t.cacheControl));
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(t.body);
});
