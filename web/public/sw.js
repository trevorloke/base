/* Starbase service worker — keeps the field app opening with no signal.
 *
 *   App shell   index.html + every built /assets/* file. Navigations are
 *               network-first (short timeout on bad signal) and fall back to
 *               the cached index.html; hashed assets are cache-first. On
 *               install, and whenever a newer index.html arrives, the whole
 *               build graph is fetched so lazy screens (Map, People…) open
 *               offline too. The files of the build before stay one more day
 *               (a tab opened before a deploy can still open its screens),
 *               then go. A kept page is only ever a stand-in for the
 *               network's: the newest one kept, never an older one.
 *   Its face    The fonts (/fonts/*) and the campaign's own pictures — the
 *               logo the page asks for early (<link … data-brand>, written
 *               by server/lib/brand.js; so is a heading face from the
 *               website's folder) — are kept with the build, so the
 *               app opens with no signal looking like itself. They are not
 *               named by their content, so they are fetched again whenever
 *               the page changes (a new build, a new brand).
 *   Map tiles   Tiles you've already looked at, in their own capped cache
 *               (~1500 tiles, oldest out first), so a turf seen with signal
 *               still draws offline. OpenStreetMap's and CARTO's (the Clean
 *               look) always; the map tells this worker any other provider
 *               (GET /api/map/config → postMessage { type: 'starbase:tiles',
 *               url }), kept across restarts. Only tiles the map itself
 *               asked for are kept — nothing is ever fetched ahead (tile
 *               servers' usage rules).
 *               A tile that can't be fetched and was never kept is a failed
 *               tile, as it is without this worker (the map counts them).
 *               Never the server's own tiles (/tiles/…, Google Maps through
 *               the server): Google's terms allow no offline use of its
 *               tiles, so they go straight to the network (the browser's
 *               own cache follows Google's max-age), and any kept before
 *               are thrown away on activate.
 *   Never       /api/* (live data and every write — the outbox in
 *               src/offline.js handles knocks), public form pages
 *               (/p /n /v /u /e /d), feature pages served to people
 *               outside the app (/r receipts, /lu ladder unsubscribe,
 *               /o and /c email open and click tracking), /join links, and
 *               pictures in messages (/media),
 *               or any non-GET.
 *
 * Bump VERSION to throw every cache away on the next activate.
 *
 * Under a client's path on a shared domain (base.win/imaginesurrey — the
 * worker's scope), every address below is under that path and the caches
 * carry its name: another campaign's base.win on the same domain has its own,
 * and this worker never touches them. At a site's root, BASE is '' and the
 * names are what they always were.
 */
const BASE = new URL(self.registration.scope).pathname.replace(/\/+$/, '');
const VERSION = 'v2';
const NAME = BASE ? `starbase-${BASE.slice(1)}` : 'starbase';
const SHELL = `${NAME}-shell-${VERSION}`;
const ASSETS = `${NAME}-assets-${VERSION}`;
const TILES = `${NAME}-tiles-${VERSION}`;
const META = `${NAME}-meta-${VERSION}`; // the map's tile provider
const KEEP = [SHELL, ASSETS, TILES, META];
// This worker's own caches, old versions included — never another client's.
const MINE = BASE ? new RegExp(`^${NAME}-(?:shell|assets|tiles|meta)-`) : /^starbase-(?:shell|assets|tiles|meta)-/;

const INDEX = `${BASE}/index.html`;
const SHELL_EXTRAS = [`${BASE}/manifest.webmanifest`];
// A path inside base.win: the address with the client's path taken off.
const inside = (pathname) => (BASE && (pathname === BASE || pathname.startsWith(`${BASE}/`)) ? pathname.slice(BASE.length) || '/' : pathname);
const NAV_TIMEOUT_MS = 4000;  // then show the cached app, let the network finish in the background
const TILE_TIMEOUT_MS = 5000;
const TILE_MAX = 1500;
const TILE_FRESH_MS = 7 * 24 * 3600 * 1000; // re-check a cached tile after a week
const TILE_AT = 'x-starbase-cached-at';
// When each file stopped being part of the build (path → ms), and how long
// it stays after that.
const OLD_FILES_KEY = '/__starbase/old-files';
const OLD_KEEP_MS = 24 * 3600 * 1000;

// The server's own pages (unsubscribe, receipts, public lessons, tracking,
// pictures, calendar files and links): straight to the network, never the
// app shell.
const NEVER = /^\/(?:api|u|bu|r|lu|o|c|join|media|learn|learn-files|cal)(?:\/|$)/;
// OpenStreetMap's tiles and CARTO's (the map's Clean look, the one it opens
// on): kept from the first tile, without waiting for the map to say which it
// draws — a worker just installed hears that a moment after its first tiles.
const isTileHost = (host) => host === 'tile.openstreetmap.org' || host.endsWith('.tile.openstreetmap.org')
  || host === 'basemaps.cartocdn.com' || host.endsWith('.basemaps.cartocdn.com');

// The configured provider, from a template like
// https://{s}.tiles.example/streets/{z}/{x}/{y}.png?key=… → its host ({s} any
// subdomain) and the path before the first {…}.
const TILE_CONFIG_KEY = '/__starbase/tiles';
const matcherFor = (template) => {
  const m = /^https?:\/\/([^/]+)(\/[^{]*)/i.exec(String(template || ''));
  if (!m) return null;
  const esc = (t) => t.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const host = new RegExp(`^${m[1].toLowerCase().split('{s}').map(esc).join('[a-z0-9-]+')}$`);
  return { host, path: m[2] };
};
let tileMatcher; // undefined: not read yet; null: OpenStreetMap only
// (What the map says while the note is being read wins: the note may be
// older, or not written yet.)
const loadMatcher = () => {
  if (tileMatcher !== undefined) return Promise.resolve(tileMatcher);
  const read = (m) => { if (tileMatcher === undefined) tileMatcher = m; return tileMatcher; };
  return caches.open(META)
    .then((c) => c.match(TILE_CONFIG_KEY))
    .then((r) => (r ? r.json() : null))
    .then((cfg) => read(cfg?.url ? matcherFor(cfg.url) : null))
    .catch(() => read(null));
};
const isConfiguredTile = (url, m) => Boolean(m && m.host.test(url.hostname) && url.pathname.startsWith(m.path));

self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d.type !== 'starbase:tiles' || typeof d.url !== 'string' || d.url.length > 1000) return;
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
    await Promise.all(names
      .filter((n) => MINE.test(n) && !KEEP.includes(n))
      .map((n) => caches.delete(n)));
    // Google's tiles kept by an older worker: gone (no offline use).
    if (names.includes(TILES)) {
      const cache = await caches.open(TILES);
      const kept = await cache.keys();
      await Promise.all(kept
        .filter((r) => { const u = new URL(r.url); return u.origin === self.location.origin && inside(u.pathname).startsWith('/tiles/'); })
        .map((r) => cache.delete(r)));
    }
    await self.clients.claim();
  })());
});

// ── Routing ──

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTileHost(url.hostname)) {
    // (The map asking whether the provider answers at all asks from a
    // script, not as a picture, and with no-store: the network's answer,
    // never a tile kept here. Either says so: a browser whose cache is
    // switched off — developer tools — hands this worker 'reload' instead.)
    if (req.cache === 'no-store' || req.destination === '') return;
    event.respondWith(tile(event, url));
    return;
  }
  // Starbase's own tiles (Google Maps through the server): straight to the
  // network, never kept, never served from here (Google's terms).
  if (url.origin === self.location.origin && inside(url.pathname).startsWith('/tiles/')) {
    event.respondWith(fetch(req));
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
  // Another client's base.win on the same domain: not this worker's business.
  if (BASE && !(url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) return;
  if (NEVER.test(inside(url.pathname))) return; // straight to the network, untouched

  if (req.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }
  const path = inside(url.pathname);
  // The fonts include a heading face the app takes from the website's own
  // folder (Montserrat, when the campaign's brand asks for it).
  if (path.startsWith('/assets/') || path.startsWith('/fonts/') || path.startsWith('/site-assets/fonts/')) {
    event.respondWith(asset(req));
    return;
  }
  if (SHELL_EXTRAS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, SHELL, url.pathname));
    return;
  }
  // The campaign's logo: from the cache when the page named it (syncAssets),
  // so the header keeps it with no signal. Any other picture: the network.
  if (req.destination === 'image') event.respondWith(kept(req));
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
  // Out of time: the page kept by now — a newer one may have arrived for
  // another tab (or an earlier try) while this one waited.
  return Promise.race([
    network.then((res) => (res.status >= 500 ? cached : res), () => cached),
    delay(NAV_TIMEOUT_MS).then(() => shell.match(INDEX)).then((newest) => newest || cached, () => cached),
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

async function kept(req) {
  const cache = await caches.open(ASSETS);
  return (await cache.match(req.url, { ignoreVary: true })) || fetch(req);
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
    // Same build: nothing to fetch — only files whose extra day is up go.
    if (old === html) { await retireOld(null); return; }
  }
  const shell = await caches.open(SHELL);
  await shell.put(INDEX, res);
  await syncAssets(html);
}

// Two ways a build file names another: "assets/Map-x1.js" (index.html, CSS,
// Vite's preload map) and "./Map-x1.js" (a chunk importing its neighbour).
// The page also names the fonts' stylesheet, which names the font files
// ("/fonts/…", the client's path in front when there is one), and the
// campaign's own pictures: the links the server marks data-brand.
const ASSET_REF = /\/?assets\/[A-Za-z0-9._-]+\.(?:js|css|svg|png|jpe?g|webp|gif|woff2?|ttf)\b/g;
const SIBLING_REF = /["'`]\.\/([A-Za-z0-9._-]+\.(?:js|css))["'`]/g;
const FONT_REF = new RegExp(`["'(](${BASE}/fonts/[A-Za-z0-9._-]+\\.(?:css|woff2?))["')]`, 'g');
const BRAND_LINK = /<link\b[^>]*\sdata-brand\b[^>]*>/gi;
const refsIn = (text, inAssets = false) => {
  const out = new Set((text.match(ASSET_REF) || []).map((p) => `${BASE}${p.startsWith('/') ? p : `/${p}`}`));
  if (inAssets) for (const m of text.matchAll(SIBLING_REF)) out.add(`${BASE}/assets/${m[1]}`);
  for (const m of text.matchAll(FONT_REF)) out.add(m[1]);
  for (const link of text.match(BRAND_LINK) || []) {
    const href = /\shref="([^"]+)"/i.exec(link)?.[1].replace(/&amp;/g, '&');
    // Only this server's own (and, under a client's path, only that client's).
    if (href && href.startsWith(`${BASE}/`) && !href.startsWith('//')) out.add(href);
  }
  return [...out];
};
// A build's own files carry their content in their name and never change.
const named = (path) => path.startsWith(`${BASE}/assets/`);

async function syncAssets(html) {
  const cache = await caches.open(ASSETS);
  const want = new Set();
  const queue = refsIn(html);
  let complete = true;
  while (queue.length && want.size < 300) {
    const path = queue.shift();
    if (want.has(path)) continue;
    want.add(path);
    // Fonts and the campaign's pictures keep their names when they change:
    // asked for again (the page changed, or this would not be running) — and
    // the copy already here stands when there is no answer.
    const had = await cache.match(path);
    let res = named(path) ? had : null;
    if (!res) {
      try {
        res = await fetch(path, named(path) ? undefined : { cache: 'no-cache' });
        if (!res.ok || isHtml(res)) res = null;
        else await cache.put(path, res.clone());
      } catch {
        res = null;
      }
      if (!res && !had) complete = false;
      res = res || had;
      if (!res) continue;
    }
    if (/\.(?:js|css)$/.test(path)) {
      const text = await res.text().catch(() => '');
      for (const ref of refsIn(text, true)) if (!want.has(ref)) queue.push(ref);
    }
  }
  // Files from older builds go — but only once the new build is fully in,
  // so a failed sync never leaves the app with nothing.
  if (complete) await retireOld(want);
}

// A file that is no longer part of the build stays one more day — a tab
// opened before a deploy still finds the screens it has not opened yet —
// and then goes. want: the build's own files (a new build has just come
// in), or null to only let go of the ones whose day is up. A campaign
// picture is kept under its path and its ?v= stamp, so both are its name.
async function retireOld(want) {
  try {
    const meta = await caches.open(META);
    const since = await meta.match(OLD_FILES_KEY).then((r) => (r ? r.json() : {})).catch(() => ({}));
    if (!want && !Object.keys(since).length) return;
    const cache = await caches.open(ASSETS);
    const now = Date.now();
    const still = {};
    for (const k of await cache.keys()) {
      const u = new URL(k.url);
      const path = u.pathname + u.search;
      if (want ? (want.has(path) || want.has(u.pathname)) : !(path in since)) continue;
      const at = Number(since[path]) || now;
      if (now - at > OLD_KEEP_MS) await cache.delete(k);
      else still[path] = at;
    }
    await meta.put(OLD_FILES_KEY, new Response(JSON.stringify(still), { headers: { 'content-type': 'application/json' } }));
  } catch { /* a closed cache or no room: tried again with the next page */ }
}

// Shown only when nothing of the app is kept yet (its first open had no
// signal), so it can't know the campaign's colours: the app's own neutral
// grounds (shared/brand-look.js), sentence case, one button.
function offlinePage() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>base.win — offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafb;color:#14161a;
font:16px/1.5 'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:24px 16px;box-sizing:border-box}main{max-width:340px}
p{color:#656669;margin:0 0 16px}p.e{font-size:13px;font-weight:500}h1{font-size:22px;font-weight:600;letter-spacing:-0.02em;margin:0 0 8px}
button{font:600 16px/1.2 'Inter',system-ui,sans-serif;background:#1b1d22;color:#fff;border:0;border-radius:8px;padding:12px 18px;min-height:48px;cursor:pointer}
button:focus-visible{outline:2px solid #14161a;outline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#0f1012;color:#f4f5f6}p{color:#97989a}button{background:#f4f5f6;color:#14161a}button:focus-visible{outline-color:#f4f5f6}}</style></head>
<body><main><p class="e">base.win · offline</p><h1>No signal yet</h1>
<p>Open base.win once with signal and it will work offline after that.</p>
<button type="button" onclick="location.reload()">Try again</button></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ── Map tiles ──

let tilePuts = 0;

async function tile(event, url, own = false) {
  const cache = await caches.open(TILES);
  const key = url.href;
  const hit = await cache.match(key);
  const age = hit ? Date.now() - Number(hit.headers.get(TILE_AT) || 0) : Infinity;
  if (hit && age < TILE_FRESH_MS) return hit;

  const network = fetchTile(key, own);
  event.waitUntil(network.then((res) => (res?.ok ? storeTile(cache, key, res.clone()) : null)).catch(() => {}));
  const res = await (hit ? Promise.race([network, delay(TILE_TIMEOUT_MS).then(() => null)]) : network);
  if (res?.ok) return res;
  if (hit) return hit;
  if (res) return res; // the tile server's own answer (404 past the edge, 429…)
  // No CORS answer and nothing cached: try the plain request once, so a tile
  // server without CORS headers still draws online (it just isn't kept).
  // No answer that way either is a failed tile, and is handed on as one: the
  // map counts them and says when the street map isn't loading (a blank
  // square in its place read as a tile that had come).
  try {
    return await fetch(event.request);
  } catch {
    return Response.error();
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
