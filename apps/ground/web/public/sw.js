/* Base Ground service worker — keeps the field app opening with no signal.
 *
 *   App shell   index.html + every built /assets/* file. Navigations are
 *               network-first (short timeout on bad signal) and fall back to
 *               the cached index.html; hashed assets are cache-first. On
 *               install, and whenever a newer index.html arrives, the whole
 *               build graph is fetched so lazy screens (Map, People…) open
 *               offline too, and files from older builds are dropped.
 *   Map tiles   Tiles you've already looked at, in their own capped cache
 *               (~1500 tiles, oldest out first), so a turf seen with signal
 *               still draws offline. OpenStreetMap by default; the map tells
 *               this worker its provider (GET /api/map/config →
 *               postMessage { type: 'base:tiles', url }), kept across
 *               restarts. Only tiles the map itself asked for are kept —
 *               nothing is ever fetched ahead (tile servers' usage rules).
 *   Never       /api/* (live data and every write — the outbox in
 *               src/offline.js handles knocks), public form pages
 *               (/p /n /v /u /e /d), feature pages served to people
 *               outside the app (/r receipts, /lu ladder unsubscribe,
 *               /o and /c email open and click tracking), /join links, and
 *               pictures in messages (/media),
 *               or any non-GET.
 *
 * On base.win (SUITE.md) each client has its own subdomain, its own origin,
 * and Base Ground runs at its root, so this worker's scope is the whole
 * host — Base Air's /air included. Base Air is never this worker's: every
 * request under /air goes straight to the network, so its pages are never
 * answered with Base Ground's shell, and its index.html never becomes the
 * offline copy of this app.
 *
 * Under a prefix (BASE_PATH, a deployment under a path): this worker is
 * registered at <prefix>/sw.js with the prefix as its scope, and every path
 * above is under it (<prefix>/api, <prefix>/assets …). Caches are one store
 * per origin, so it names its own after its prefix and never touches
 * another's. Navigations outside the two faces go straight to the network.
 *
 * Bump VERSION to throw every cache away on the next activate.
 */
// '/imaginesurrey', or '' when registered at the root.
const BASE = new URL(self.registration.scope).pathname.replace(/\/+$/, '');
const at = (path) => `${BASE}${path}`;
// '' at the root (the names caches had before prefixes); else 'imaginesurrey-'.
const NS = BASE ? `${BASE.slice(1).replace(/[^A-Za-z0-9_-]+/g, '-')}-` : '';
const VERSION = 'v2';
const SHELL = `base-${NS}shell-${VERSION}`;
const ASSETS = `base-${NS}assets-${VERSION}`;
const TILES = `base-${NS}tiles-${VERSION}`;
const META = `base-${NS}meta-${VERSION}`; // the map's tile provider
const KEEP = [SHELL, ASSETS, TILES, META];
// This worker's own caches, any version — the only ones it may drop.
const MINE = new RegExp(`^base-${NS.replace(/[.*+?^$()|[\]\\{}-]/g, '\\$&')}(?:shell|assets|tiles|meta)-v\\d+$`);

const INDEX = at('/index.html');
const SHELL_EXTRAS = [at('/manifest.webmanifest'), at('/icon.svg')];
const NAV_TIMEOUT_MS = 4000;  // then show the cached app, let the network finish in the background
const TILE_TIMEOUT_MS = 5000;
const TILE_MAX = 1500;
const TILE_FRESH_MS = 7 * 24 * 3600 * 1000; // re-check a cached tile after a week
const TILE_AT = 'x-base-cached-at';

// The server's own pages (unsubscribe, receipts, public lessons, tracking,
// pictures): straight to the network, never the app shell.
// (Tested against the path with the prefix taken off.)
const NEVER = /^\/(?:api|u|bu|r|lu|o|c|join|media|learn|learn-files|in|web)(?:\/|$)/;
// The other Base apps on this host (Base Air under /air): never this worker's.
const OTHER_APP = /^\/air(?:\/|$)/;
// The app's own screens: the field app and the desk. Only these get the app
// shell for a navigation.
const FACE = /^\/(?:field|ground)(?:\/|$)/;
// The path under this worker's prefix, or null for one outside it.
const inScope = (pathname) => (!BASE ? pathname
  : pathname === BASE ? '/' : pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) : null);
const isTileHost = (host) => host === 'tile.openstreetmap.org' || host.endsWith('.tile.openstreetmap.org');

// The configured provider, from a template like
// https://{s}.tiles.example/streets/{z}/{x}/{y}.png?key=… → its host ({s} any
// subdomain) and the path before the first {…}.
const TILE_CONFIG_KEY = at('/__base/tiles');
const matcherFor = (template) => {
  const m = /^https?:\/\/([^/]+)(\/[^{]*)/i.exec(String(template || ''));
  if (!m) return null;
  const esc = (t) => t.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const host = new RegExp(`^${m[1].toLowerCase().split('{s}').map(esc).join('[a-z0-9-]+')}$`);
  return { host, path: m[2] };
};
let tileMatcher; // undefined: not read yet; null: OpenStreetMap only
const loadMatcher = () => {
  if (tileMatcher !== undefined) return Promise.resolve(tileMatcher);
  return caches.open(META)
    .then((c) => c.match(TILE_CONFIG_KEY))
    .then((r) => (r ? r.json() : null))
    .then((cfg) => { tileMatcher = cfg?.url ? matcherFor(cfg.url) : null; return tileMatcher; })
    .catch(() => { tileMatcher = null; return null; });
};
const isConfiguredTile = (url, m) => Boolean(m && m.host.test(url.hostname) && url.pathname.startsWith(m.path));

self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d.type !== 'base:tiles' || typeof d.url !== 'string' || d.url.length > 1000) return;
  const m = matcherFor(d.url);
  if (!m) return;
  tileMatcher = m;
  event.waitUntil?.(caches.open(META).then((c) => c.put(TILE_CONFIG_KEY, new Response(JSON.stringify({ url: d.url }), {
    headers: { 'content-type': 'application/json' },
  }))).catch(() => {}));
});
// The server's SPA fallback answers a missing /assets file with index.html
// (200, text/html) — never store that under a .js/.css name.
const isHtml = (res) => (res.headers.get('content-type') || '').includes('text/html');

// ── Install / activate ──

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const res = await fetch(INDEX, { cache: 'reload' });
    if (res.ok) await adoptIndex(res);
    const shell = await caches.open(SHELL);
    await Promise.all(SHELL_EXTRAS.map((url) => fetch(url, { cache: 'reload' })
      .then((r) => (r.ok ? shell.put(url, r) : null))
      .catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Starbase became Base Ground: the map tiles kept for no-signal canvassing
    // and the tile provider move to the new caches before the old ones go, so
    // a volunteer's offline map survives the rename.
    for (const [from, to, keyFrom, keyTo] of [
      ['starbase-tiles-v2', TILES],
      ['starbase-meta-v2', META, '/__starbase/tiles', TILE_CONFIG_KEY],
    ]) {
      if (!names.includes(from)) continue;
      try {
        const [src, dst] = await Promise.all([caches.open(from), caches.open(to)]);
        for (const req of await src.keys()) {
          const res = await src.match(req);
          if (!res) continue;
          const key = keyFrom && new URL(req.url).pathname === keyFrom ? keyTo : req;
          if (!(await dst.match(key))) await dst.put(key, res);
        }
      } catch { /* quota: the map refills with signal */ }
    }
    await Promise.all(names
      .filter((n) => (MINE.test(n) && !KEEP.includes(n)) || n.startsWith('starbase-'))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ── Routing ──

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTileHost(url.hostname)) {
    event.respondWith(tile(event, url));
    return;
  }
  // Base Ground's own tiles (Google Maps through the server): the same cache,
  // fetched with the sign-in cookie.
  const path = url.origin === self.location.origin ? inScope(url.pathname) : null;
  if (path !== null && path.startsWith('/tiles/')) {
    event.respondWith(tile(event, url, true));
    return;
  }
  // Another provider's tiles: images from elsewhere are checked against the
  // map's provider (read from the cache when the worker has just woken up);
  // anything else goes straight through, untouched.
  if (url.origin !== self.location.origin) {
    if (req.destination !== 'image') return;
    if (tileMatcher === null) return;
    if (tileMatcher && !isConfiguredTile(url, tileMatcher)) return;
    event.respondWith(loadMatcher().then((m) => (isConfiguredTile(url, m) ? tile(event, url) : fetch(req))));
    return;
  }
  // Outside this worker's prefix, the server's own pages, or another Base app
  // on this host (Base Air): not this worker's.
  if (path === null || NEVER.test(path) || OTHER_APP.test(path)) return; // straight to the network, untouched

  if (req.mode === 'navigate') {
    // At the root the worker has the whole site, as it always did (an old
    // home-screen icon opens /map, offline too) but Base Air's /air, above.
    // Under a prefix, only the app's own screens.
    if (!BASE || FACE.test(path) || path === '/') event.respondWith(navigate(event));
    return;
  }
  if (path.startsWith('/assets/')) {
    event.respondWith(asset(req));
    return;
  }
  if (SHELL_EXTRAS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, SHELL, url.pathname));
  }
});

// ── App shell ──

async function navigate(event) {
  const shell = await caches.open(SHELL);
  const cached = await shell.match(INDEX);
  const cachedCopy = cached ? cached.clone() : null; // for the "same build?" check
  const network = fetch(event.request);
  // Registered before anything hands the response to the page, so the clone
  // happens while the body is untouched; waitUntil keeps the worker alive
  // even if the cached copy wins the race below.
  event.waitUntil(network.then((res) => (
    // Only a real copy of the app replaces the cached one (an error page or a
    // redirect elsewhere must never become the offline shell).
    res.ok && !res.redirected && isHtml(res) ? adoptIndex(res.clone(), cachedCopy) : null
  )).catch(() => {}));
  if (!cached) return network.catch(() => offlinePage());
  // Network first, but don't leave a volunteer on a blank screen in a dead
  // zone, and don't show a server error page when the app itself is cached.
  return Promise.race([
    network.then((res) => (res.status >= 500 ? cached : res), () => cached),
    delay(NAV_TIMEOUT_MS).then(() => cached),
  ]);
}

async function asset(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && !isHtml(res)) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(event, cacheName, key) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key);
  const network = fetch(event.request);
  event.waitUntil(network.then((res) => (res.ok ? cache.put(key, res.clone()) : null)).catch(() => {}));
  return hit || network;
}

// A fresh index.html: store it, then make the assets cache hold exactly the
// build it points at — everything it loads, plus the lazy chunks those load.
async function adoptIndex(res, previous) {
  const html = await res.clone().text();
  if (previous) {
    const old = await previous.clone().text().catch(() => '');
    if (old === html) return; // same build — nothing to do
  }
  const shell = await caches.open(SHELL);
  await shell.put(INDEX, res);
  await syncAssets(html);
}

// Two ways a build file names another: "./assets/Map-x1.js" (index.html,
// built with Vite's base './') or "assets/…" (CSS), and "./Map-x1.js" (a chunk
// importing its neighbour, Vite's preload map). Each becomes its address
// under the prefix: <prefix>/assets/Map-x1.js.
const ASSET_REF = /assets\/([A-Za-z0-9._-]+\.(?:js|css|svg|png|jpe?g|webp|gif|woff2?|ttf))\b/g;
const SIBLING_REF = /["'`]\.\/([A-Za-z0-9._-]+\.(?:js|css))["'`]/g;
const refsIn = (text, inAssets = false) => {
  const out = new Set([...text.matchAll(ASSET_REF)].map((m) => at(`/assets/${m[1]}`)));
  if (inAssets) for (const m of text.matchAll(SIBLING_REF)) out.add(at(`/assets/${m[1]}`));
  return [...out];
};

async function syncAssets(html) {
  const cache = await caches.open(ASSETS);
  const want = new Set();
  const queue = refsIn(html);
  let complete = true;
  while (queue.length && want.size < 300) {
    const path = queue.shift();
    if (want.has(path)) continue;
    want.add(path);
    let res = await cache.match(path);
    if (!res) {
      try {
        res = await fetch(path);
        if (!res.ok || isHtml(res)) { complete = false; continue; }
        await cache.put(path, res.clone());
      } catch {
        complete = false;
        continue;
      }
    }
    if (/\.(?:js|css)$/.test(path)) {
      const text = await res.text().catch(() => '');
      for (const ref of refsIn(text, true)) if (!want.has(ref)) queue.push(ref);
    }
  }
  // Drop files from older builds — but only once the new build is fully in,
  // so a failed sync never leaves the app with nothing.
  if (!complete) return;
  const keys = await cache.keys();
  await Promise.all(keys
    .filter((k) => !want.has(new URL(k.url).pathname))
    .map((k) => cache.delete(k)));
}

function offlinePage() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Base Ground — offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5fa;color:#161a2e;
font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:24px;box-sizing:border-box}main{max-width:340px}
p.e{font:600 12px system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#5d6481}
button{font:600 15px system-ui,sans-serif;background:#6d4aff;
color:#fff;border:0;border-radius:10px;padding:12px 18px;min-height:44px;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#0d1226;color:#e8eaf6}p.e{color:#9aa1c2}}</style></head>
<body><main><p class="e">Base Ground · offline</p><h1>No signal yet</h1>
<p>Open Base Ground once with signal and it will work offline after that.</p>
<button type="button" onclick="location.reload()">Try again</button></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ── Map tiles ──

let tilePuts = 0;

async function tile(event, url, own = false) {
  const cache = await caches.open(TILES);
  const key = url.href;
  const hit = await cache.match(key);
  const age = hit ? Date.now() - Number(hit.headers.get(TILE_AT) || hit.headers.get('x-starbase-cached-at') || 0) : Infinity; // tiles kept before the rename carry the old header
  if (hit && age < TILE_FRESH_MS) return hit;

  const network = fetchTile(key, own);
  event.waitUntil(network.then((res) => (res?.ok ? storeTile(cache, key, res.clone()) : null)).catch(() => {}));
  const res = await (hit ? Promise.race([network, delay(TILE_TIMEOUT_MS).then(() => null)]) : network);
  if (res?.ok) return res;
  if (hit) return hit;
  if (res) return res; // the tile server's own answer (404 past the edge, 429…)
  // No CORS answer and nothing cached: try the plain request once, so a tile
  // server without CORS headers still draws online (it just isn't kept).
  try {
    return await fetch(event.request);
  } catch {
    return blankTile();
  }
}

// CORS (not no-cors) so the response is readable: opaque responses can't be
// checked for errors and are charged megabytes each against storage quota.
// null = offline (or a server that doesn't send CORS headers).
async function fetchTile(href, own = false) {
  try {
    if (own) return await fetch(href, { mode: 'same-origin', credentials: 'same-origin' });
    return await fetch(href, { mode: 'cors', credentials: 'omit' });
  } catch {
    return null;
  }
}

async function storeTile(cache, key, res) {
  try {
    const body = await res.blob();
    const headers = new Headers({ 'content-type': res.headers.get('content-type') || 'image/png', [TILE_AT]: String(Date.now()) });
    await cache.delete(key); // re-insert at the end: recently refreshed tiles go out last
    await cache.put(key, new Response(body, { status: 200, headers }));
    tilePuts += 1;
    if (tilePuts % 50 === 1) await trimTiles(cache);
  } catch { /* quota or a closed cache — the tile just isn't kept */ }
}

async function trimTiles(cache) {
  const keys = await cache.keys(); // insertion order: oldest first
  const extra = keys.length - TILE_MAX;
  if (extra <= 0) return;
  await Promise.all(keys.slice(0, extra).map((k) => cache.delete(k)));
}

// Paper-coloured stand-in for a street we've never loaded: pins still sit on
// it, and it isn't a broken image.
function blankTile() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8ebf3"/><path d="M0 .5H256M.5 0V256" stroke="#d3d8e6" stroke-width="1"/></svg>';
  return new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
