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
const API = process.env.GOOGLE_MAPS_TILES_URL || 'https://tile.googleapis.com/v1';
export const TILE_PATH = '/tiles/{z}/{x}/{y}.png';
export const MAX_ZOOM = 22;

export const googleTilesOn = (env = process.env) => env.GOOGLE_MAPS_TILES === '1' && Boolean(env.GOOGLE_MAPS_SERVER_KEY);
export const attribution = () => `Map data &copy;${new Date().getFullYear()} Google`;

export const MAP_TYPES = ['roadmap', 'satellite', 'terrain'];
const sessions = new Map(); // mapType → { token, expiresAt (ms) }
const creating = new Map(); // mapType → the promise making its session

export const mapType = () => (MAP_TYPES.includes(process.env.GOOGLE_MAPS_TILE_TYPE) ? process.env.GOOGLE_MAPS_TILE_TYPE : 'roadmap');

// A session lasts about two weeks; one request creates it for everyone. One
// per map type (Google ties the look to the session).
const getSession = async (type, fresh = false) => {
  const s = sessions.get(type);
  if (!fresh && s && Date.now() < s.expiresAt - 60_000) return s.token;
  if (!creating.has(type)) {
    creating.set(type, (async () => {
      const res = await fetch(`${API}/createSession?key=${encodeURIComponent(process.env.GOOGLE_MAPS_SERVER_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // terrain needs the roadmap layer on top (Google's rule).
        body: JSON.stringify({ mapType: type, language: 'en-CA', region: 'CA', ...(type === 'terrain' ? { layerTypes: ['layerRoadmap'] } : {}) }),
      });
      if (!res.ok) throw new Error(`Google Map Tiles session: ${res.status}`);
      const body = await res.json();
      sessions.set(type, { token: body.session, expiresAt: Number(body.expiry) * 1000 || Date.now() + 86_400_000 });
      return body.session;
    })().finally(() => { creating.delete(type); }));
  }
  return creating.get(type);
};

// → { status, body: ArrayBuffer | null, type } for one tile, of one look.
export const fetchTile = async (z, x, y, look = mapType()) => {
  const kind = MAP_TYPES.includes(look) ? look : mapType();
  const get = async (token) => fetch(`${API}/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(token)}&key=${encodeURIComponent(process.env.GOOGLE_MAPS_SERVER_KEY)}`);
  let res = await get(await getSession(kind));
  // A session Google no longer accepts: make a new one and try once more.
  if (res.status === 400 || res.status === 403 || res.status === 404) {
    res = await get(await getSession(kind, true));
  }
  if (!res.ok) return { status: res.status, body: null, type: null };
  return { status: 200, body: await res.arrayBuffer(), type: res.headers.get('content-type') || 'image/png' };
};

// Tests: forget the session between cases.
export const _resetForTest = () => { sessions.clear(); creating.clear(); };
