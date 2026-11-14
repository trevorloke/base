// Google Maps in base.win — browser suite, with no real Google and no real
// B.C. service: base.win on :5340, a stand-in B.C. Address Geocoder on :5341
// and one stand-in Google on :5342 (Map Tiles: session, 2D tiles with
// "private, max-age=0, must-revalidate", the viewport credit; Places:
// autocomplete and details). The free map's tiles come from page.route; every
// request to *.google.com, *.googleapis.com or *.gov.bc.ca is aborted, and at
// the end no request has left 127.0.0.1 but those.
//
// GOOGLE_MAPS_SERVER_KEY=e2e-not-a-key and no GOOGLE_MAPS_TILES throughout.
// The server is started afresh (in memory) for each setting it needs:
//   A  only the key: Google is the map; Show → Map is Streets · Satellite ·
//      Terrain (no Muted, no Dark, no filter); the phone keeps no /tiles/;
//      offline with Google's tiles failing, "No signal — the street map is
//      back when you are…"; New door offers own doors then B.C.'s rows and
//      no Google rows, and Google saw no autocomplete; Directions on a door
//      card's More, a walk-list door's More, a shift and a sign; the notice
//      line on the Show sheet and last on Your profile; as a manager and as
//      a volunteer, at 1440x900 and 390x844.
//   B  ADDRESS_SUGGEST=google: Google's rows and logo (after the list, not
//      in it); a pick says Loading…, then "Pinned on the map"; one session
//      for the asks and the pick, no `location` in the field mask; a pick
//      B.C. can't place asks for a tap; Edit person takes a pick's street,
//      unit, city and postal code and is placed by B.C.; then Google refusing
//      Places: B.C.'s rows, no logo, one refused call, and Services flagged.
//   C  ADDRESS_SUGGEST=google and Google refusing tiles: the free map, and
//      New door asks with nogoogle=1 and gets no Google rows.
//   D  GOOGLE_MAPS_TILES=off: every Directions link is still there.
//
//   (cd web && npm run build) && node e2e-gmaps.mjs     (ports PORT, PORT+1, PORT+2; PORT default 5340)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5340;
const BC_PORT = PORT + 1;
const G_PORT = PORT + 2;
const SHOTS = process.env.SHOTS || '/tmp/basewin-gmaps-shots';
mkdirSync(SHOTS, { recursive: true });
// ONLY=A2,B7 node e2e-gmaps.mjs runs just those parts (A1 A2 A3 A8 A9 A · B4 B7 B5 B · C · D).
const ONLY = new Set(String(process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean));
const want = (part) => !ONLY.size || ONLY.has(part);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};
const isUuid = (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(x || ''));
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(150); } return fn(); };

// ── Google's logo, for this run only when the real file isn't in the build ──
const LOGO = join(ROOT, 'web/dist/google/google-maps-logo.svg');
const madeLogo = !existsSync(LOGO);
if (madeLogo) {
  mkdirSync(join(ROOT, 'web/dist/google'), { recursive: true });
  writeFileSync(LOGO, '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="16"><text x="0" y="13" font-size="13">Test logo</text></svg>');
}

// ── The stand-in B.C. service: suggestions (autoComplete) and placing ──
const feature = (n, street, type, lng, lat) => ({
  geometry: { coordinates: [lng, lat] },
  properties: { civicNumber: n, civicNumberSuffix: '', streetName: street, streetType: type, streetDirection: '',
    localityName: 'Surrey', fullAddress: `${n} ${street} ${type}, Surrey, BC`, matchPrecision: 'CIVIC_NUMBER', score: 96 },
});
const BOOK = {
  '13450 104 Ave': feature(13450, '104', 'Ave', -122.8466, 49.1906),
  '13460 104 Ave': feature(13460, '104', 'Ave', -122.8461, 49.1907),
};
const bc = { asked: 0 };
const bcServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  bc.asked += 1;
  const q = (u.searchParams.get('addressString') || '').toLowerCase().replace(/,.*$/, '').replace(/^\S+ - /, '').trim();
  const hits = u.searchParams.get('autoComplete') === 'true'
    ? Object.entries(BOOK).filter(([k]) => k.toLowerCase().includes(q)).map(([, f]) => f)
    : Object.entries(BOOK).filter(([k]) => q.startsWith(k.toLowerCase())).map(([, f]) => f).slice(0, 1);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ features: hits }));
});
await new Promise((r) => bcServer.listen(BC_PORT, '127.0.0.1', r));

// ── The stand-in Google ──
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BILLING = JSON.stringify({ error: { code: 403, message: 'This API method requires billing to be enabled.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED' }] } });
const BLOCKED = JSON.stringify({ error: { code: 403, message: 'Requests to this API places.googleapis.com method google.maps.places.v1.Places.AutocompletePlaces are blocked.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED' }] } });
const PREDICTIONS = [
  { id: 'gp13450', main: '13450 104 Ave', types: ['street_address'] },
  { id: 'gp13450u', main: '204-13450 104 Ave', types: ['subpremise'] },
  { id: 'gp13459', main: '13459 104 Ave', types: ['street_address'] },
  { id: 'gp13470', main: '13470 104 Ave', types: ['street_address'] },
];
const DETAILS = {
  gp13450: { n: '13450', unit: null },
  gp13450u: { n: '13450', unit: '204' },
  gp13459: { n: '13459', unit: null }, // the B.C. stand-in has no such door
  gp13470: { n: '13470', unit: null, slow: true }, // answers after the server's 2.5 s
};
const g = { tiles: 'ok', places: 'ok', autocomplete: [], details: [], tileHits: 0, refusedPlaces: 0 };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const gServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (b) => { body += b; });
  req.on('end', () => {
    if (u.pathname === '/v1/places:autocomplete') {
      const b = JSON.parse(body || '{}');
      g.autocomplete.push({ input: b.input, session: b.sessionToken, key: req.headers['x-goog-api-key'] });
      if (g.places === 'blocked') { g.refusedPlaces += 1; json(res, 403, BLOCKED); return; }
      json(res, 200, { suggestions: PREDICTIONS.filter((p) => p.main.replace(/^\d+-/, '').startsWith(String(b.input || '').trim().slice(0, 9)))
        .map((p) => ({ placePrediction: { placeId: p.id, types: p.types, structuredFormat: { mainText: { text: p.main }, secondaryText: { text: 'Surrey, BC, Canada' } } } })) });
      return;
    }
    const m = /^\/v1\/places\/([^/]+)$/.exec(u.pathname);
    if (m) {
      g.details.push({ id: m[1], session: u.searchParams.get('sessionToken'), mask: req.headers['x-goog-fieldmask'] });
      if (g.places === 'blocked') { json(res, 403, BLOCKED); return; }
      const d = DETAILS[m[1]];
      if (!d) { json(res, 404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }); return; }
      setTimeout(() => json(res, 200, {
        formattedAddress: `${d.unit ? `${d.unit}-` : ''}${d.n} 104 Ave, Surrey, BC V3T 1V8, Canada`,
        addressComponents: [
          ...(d.unit ? [{ longText: d.unit, shortText: d.unit, types: ['subpremise'] }] : []),
          { longText: d.n, shortText: d.n, types: ['street_number'] },
          { longText: '104 Avenue', shortText: '104 Ave', types: ['route'] },
          { longText: 'Surrey', shortText: 'Surrey', types: ['locality', 'political'] },
          { longText: 'V3T 1V8', shortText: 'V3T 1V8', types: ['postal_code'] },
        ],
      }), d.slow ? 3500 : 0);
      return;
    }
    if (g.tiles === 'billing') { json(res, 403, BILLING); return; }
    if (u.pathname === '/v1/createSession') { json(res, 200, { session: 'e2e-session', expiry: String(Math.floor(Date.now() / 1000) + 86400) }); return; }
    if (u.pathname === '/tile/v1/viewport') { json(res, 200, { copyright: 'Map data ©2026 Google' }); return; }
    if (u.pathname.startsWith('/v1/2dtiles/')) {
      g.tileHits += 1;
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=0, must-revalidate' });
      res.end(PNG);
      return;
    }
    json(res, 404, { error: { code: 404, message: 'unknown' } });
  });
});
await new Promise((r) => gServer.listen(G_PORT, '127.0.0.1', r));

// ── base.win, started afresh for each setting ──
const BASE = `http://127.0.0.1:${PORT}`;
let server = null;
const stopServer = async () => {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGTERM');
  await new Promise((r) => { if (s.exitCode != null) r(); else s.on('exit', r); setTimeout(r, 5000); });
};
const startServer = async (extra = {}) => {
  await stopServer();
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off',
      GEOCODER: 'bc', BC_GEOCODER_URL: `http://127.0.0.1:${BC_PORT}`, GEOCODE_ON_SAVE: 'on',
      GOOGLE_MAPS_SERVER_KEY: 'e2e-not-a-key', GOOGLE_MAPS_TILES_URL: `http://127.0.0.1:${G_PORT}/v1`, GOOGLE_PLACES_URL: `http://127.0.0.1:${G_PORT}/v1`,
      GOOGLE_MAPS_TILES: '', ADDRESS_SUGGEST: '', ...extra,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30000);
    server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
};
process.on('exit', () => { server?.kill(); if (madeLogo) rmSync(join(ROOT, 'web/dist/google'), { recursive: true, force: true }); });
process.on('unhandledRejection', (e) => { console.log(`FAIL  stopped: ${e?.stack || e}`); process.exit(1); });

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'; // routes see the service worker's fetches too
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const leaks = [];
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1440, height: 900 } };
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ece9e1"/><path d="M0 128H256M128 0V256" stroke="#d8d4c8" stroke-width="3"/></svg>';
const free = { asked: 0 };
const contexts = [];
const newContext = async (opts = {}, { sw = false } = {}) => {
  const c = await browser.newContext({ deviceScaleFactor: 1, timezoneId: 'America/Vancouver', serviceWorkers: sw ? 'allow' : 'block', ...DESK, ...opts });
  await c.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/, (route) => { free.asked += 1; return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg }); });
  await c.route('**://*.google.com/**', (r) => r.abort());
  await c.route('**://*.googleapis.com/**', (r) => r.abort());
  await c.route('**://*.gov.bc.ca/**', (r) => r.abort());
  c.on('request', (r) => {
    const url = r.url();
    if (/^(data|blob|about):/.test(url)) return;
    const host = new URL(url).hostname;
    if (host === '127.0.0.1' || /basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(host)) return;
    if (/(^|\.)google\.com$|(^|\.)googleapis\.com$|(^|\.)gov\.bc\.ca$/.test(host)) return; // aborted above
    leaks.push(url);
  });
  contexts.push(c);
  return c;
};
// The same person in a context of another size (a phone: touch, 390 px).
const sized = async (c, opts) => newContext({ ...opts, storageState: await c.storageState() });
const pageIn = async (c, label) => {
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return p;
};
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (targets) for (const el of document.querySelectorAll(targets)) { if (!visible(el)) continue; const h = el.getBoundingClientRect().height; minTap = minTap == null ? h : Math.min(minTap, h); }
  // To a hundredth: a layout's sub-pixel rounding (47.9999) is still 48 px.
  return { yellow, overflow, minTap: minTap == null ? null : Math.round(minTap * 100) / 100 };
}, sel);
const words = (page, sel) => page.innerText(sel).then((t) => t.replace(/\s+/g, ' ').trim()).catch(() => '');

// ── A campaign: a manager, a volunteer, doors, a turf, shifts and a sign ──
const TAG = Date.now().toString(36);
const seed = async () => {
  const mgr = await newContext();
  const su = await mgr.request.post(`${BASE}/api/auth/signup`, { data: { name: 'Riley Example', email: `riley+${TAG}@example.org`, password: 'surrey-forward-2026', workspaceName: 'Map campaign', jurisdiction: 'bc-municipal' } });
  if (!su.ok()) throw new Error(`signup ${su.status()} ${await su.text()}`);
  const post = async (c, path, data) => {
    const r = await c.request.post(`${BASE}/api${path}`, { data });
    if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
    return r.json();
  };
  const people = [];
  for (let i = 0; i < 6; i += 1) {
    people.push((await post(mgr, '/actions/person.create', { name: `Door${i} Example`, address: `${100 + i} Example St`, city: 'Surrey', phone: `604-555-01${String(10 + i)}`, lat: 49.105 + i * 0.0004, lng: -122.84 })).person);
  }
  // An own door at 13450 104 Ave (unit 2): the box offers it first, "On the map".
  const own = (await post(mgr, '/actions/person.create', { name: 'Unit Example', address: '13450 104 Ave', unit: '2', city: 'Surrey', lat: 49.1906, lng: -122.8466 })).person;
  const edit = (await post(mgr, '/actions/person.create', { name: 'Moving Example', address: '1 Old Rd', city: 'Surrey' })).person;
  const turf = (await post(mgr, '/actions/turf.create', { name: 'Example block', polygon: [[49.1, -122.845], [49.11, -122.845], [49.11, -122.835], [49.1, -122.835]] })).turf;
  const inv = await post(mgr, '/actions/member.invite', { email: `vol+${TAG}@example.org`, role: 'volunteer' });
  const vol = await newContext();
  const j = await vol.request.post(`${BASE}/api/auth/join`, { data: { token: inv.joinUrl.split('/').pop(), name: 'Vic Example', password: 'knock-knock-2026' } });
  if (!j.ok()) throw new Error(`join ${j.status()} ${await j.text()}`);
  const volId = (await (await vol.request.get(`${BASE}/api/auth/me`)).json()).user.id;
  await post(mgr, '/actions/turf.assign', { turf_id: turf.id, user_id: volId });
  const place = (await post(mgr, '/actions/place.save', { name: 'Fleetwood corner', lat: 49.15, lng: -122.8 })).place;
  const soon = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
  const pinned = (await post(mgr, '/actions/shift.create', { title: 'Corner wave', place_id: place.id, starts_at: soon(26), ends_at: soon(28), capacity: 4 })).shift;
  const worded = (await post(mgr, '/actions/shift.create', { title: 'Library table', location: 'Newton Library', starts_at: soon(30), ends_at: soon(32), capacity: 4 })).shift;
  const sign = (await post(mgr, '/actions/sign.place', { kind: 'lawn', person_id: people[0].id })).sign;
  return { mgr, vol, post, people, own, edit, turf, pinned, worded, sign };
};

// The map's own state.
const tilesState = (p) => p.evaluate(() => document.querySelector('.map-canvas')?.dataset.tiles || null);
const tileSrcs = (p) => p.evaluate(() => [...document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')].map((i) => i.getAttribute('src') || ''));
const openMap = async (p, path) => {
  await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.map-canvas', { timeout: 15000 });
  await p.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.tiles === 'ok', null, { timeout: 15000 }).catch(() => {});
  await sleep(500);
};
const openShow = async (p) => {
  await p.click('.map-filter-btn');
  await p.waitForSelector('.map-fsheet', { timeout: 5000 });
};
const lookChips = (p) => p.$$eval('.map-fsheet .map-vchip', (els) => els.map((e) => e.innerText.trim()));
const openNewDoor = async (p) => {
  await p.click('.map-fab--add');
  await p.waitForSelector('form[aria-label="New door"] #nd-address', { timeout: 5000 });
};
const options = (p) => p.$$eval('.af-list [role="option"]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const typeAddress = async (p, sel, text) => {
  await p.fill(sel, '');
  await p.click(sel);
  await p.keyboard.type(text, { delay: 40 });
  await p.waitForSelector('.af-list [role="option"]', { timeout: 6000 }).catch(() => {});
  await sleep(400);
};
const logoAfterList = (p) => p.evaluate(() => {
  const list = document.querySelector('.af-list[role="listbox"]');
  const logo = document.querySelector('.af-attrib');
  return {
    logo: Boolean(logo),
    inside: Boolean(list && logo && list.contains(logo)),
    after: Boolean(list && logo && (list.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING)),
    options: document.querySelectorAll('.af-list [role="option"]').length,
    img: logo?.querySelector('img')?.getAttribute('src') || null,
    height: logo?.querySelector('img')?.getBoundingClientRect().height || null,
  };
});
const directionsIn = (p, scope) => p.$$eval(`${scope} a.directions, ${scope} a[aria-label^="Directions to"]`, (els) => els.map((a) => ({
  href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.innerText.trim(), label: a.getAttribute('aria-label'),
  inRating: Boolean(a.closest('.rate, .rating, .fk-rate, [role="radiogroup"]')), h: a.getBoundingClientRect().height,
})));
const WALK = /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=49\.\d+,-122\.\d+&travelmode=walking$/;
const DRIVE = /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=49\.\d+,-122\.\d+&travelmode=driving$/;
const relOk = (l) => l && l.target === '_blank' && l.rel === 'noopener noreferrer';

// Directions on a door card, a walk-list door, the shifts and the sign — for
// one person at one size. → { door, walk, pinned, worded, sign } (links)
const directionsTour = async (c, label, s, { app, phone }) => {
  const p = await pageIn(c, label);
  const out = {};
  const pre = app === 'admin' ? '/admin' : '';
  await openMap(p, `${pre}/map?person=${s.people[1].id}`);
  await p.waitForSelector('aside.door-card', { timeout: 10000 }).catch(() => {});
  const moreBtn = p.locator('aside.door-card .fk-more__btn').first();
  if (await moreBtn.count()) await moreBtn.click();
  await sleep(300);
  out.door = (await directionsIn(p, 'aside.door-card'))[0] || null;
  if (phone) await p.screenshot({ path: `${SHOTS}/${label}-door-more.png` });
  await p.goto(`${BASE}${pre}/turfs/${s.turf.id}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.walk-door__head', { timeout: 10000 }).catch(() => {});
  const head = p.locator('.walk-door__head').first();
  if ((await head.getAttribute('aria-expanded').catch(() => null)) !== 'true') await head.click().catch(() => {});
  await p.locator('.walk-panel .fk-more__btn').first().click().catch(() => {});
  await sleep(300);
  out.walk = (await directionsIn(p, '.walk-panel'))[0] || null;
  if (phone) await p.screenshot({ path: `${SHOTS}/${label}-walk-more.png` });
  out.walkMeasure = await measure(p, '.walk-panel a.directions');
  for (const k of ['pinned', 'worded']) {
    await p.goto(`${BASE}${pre}/shifts/${s[k].id}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.ops-lines', { timeout: 10000 }).catch(() => {});
    await sleep(300);
    out[k] = { links: await directionsIn(p, '.ops-lines'), text: await words(p, '.ops-lines') };
    if (phone && k === 'pinned') await p.screenshot({ path: `${SHOTS}/${label}-shift.png` });
  }
  out.shiftMeasure = await measure(p, '.ops-lines a.sch-maplink');
  await p.close();
  return out;
};

// ═══ A: only the key ═══
await startServer();
let s = await seed();
{
  // 1. Google is the map; Show → Map; no shade; Satellite and back.
  if (want('A1')) for (const [who, c0, app] of [['manager', s.mgr, 'admin'], ['volunteer', s.vol, 'field']]) {
    for (const [size, opts] of [['1440', DESK], ['390', PHONE]]) {
      const c = size === '390' ? await sized(c0, opts) : c0;
      const p = await pageIn(c, `${who}-${size}`);
      await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/map:view/.test(k)) localStorage.removeItem(k); localStorage.setItem('starbase:map:view', 'muted'); });
      const freeBefore = free.asked;
      await openMap(p, app === 'admin' ? '/admin/map' : '/map');
      const srcs = await tileSrcs(p);
      const filter = await p.evaluate(() => getComputedStyle(document.querySelector('.leaflet-tile-pane')).filter);
      check(`A1 ${who} ${size}: with only the key the map draws /tiles/ (a saved Muted drawn as Streets, no filter), nothing from the free map`,
        srcs.length > 0 && srcs.every((u) => /\/tiles\/\d+\/\d+\/\d+/.test(u)) && free.asked === freeBefore && filter === 'none',
        JSON.stringify({ srcs: srcs.slice(0, 2), free: free.asked - freeBefore, filter }));
      await openShow(p);
      const chips = await lookChips(p);
      check(`A1 ${who} ${size}: Show → Map is Streets · Satellite · Terrain, no Muted or Dark`, chips.join(' · ') === 'Streets · Satellite · Terrain', chips.join(' · '));
      const notice = await p.$eval('.map-fsheet .google-notice', (el) => ({ text: el.innerText.replace(/\s+/g, ' ').trim(), links: [...el.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]) })).catch(() => null);
      check(`A9 ${who} ${size}: the Show sheet ends with "Maps by Google. Google Maps terms · Google privacy", both links new-tab, noopener noreferrer`,
        notice && /^Maps by Google\. Google Maps terms · Google privacy$/.test(notice.text)
        && JSON.stringify(notice.links) === JSON.stringify([['https://maps.google.com/help/terms_maps/', '_blank', 'noopener noreferrer'], ['https://policies.google.com/privacy', '_blank', 'noopener noreferrer']]),
        JSON.stringify(notice));
      const m = await measure(p, '.map-fsheet .map-vchip');
      check(`A10 ${who} ${size}: the Show sheet — at most one primary, no sideways scroll${size === '390' ? ', looks ≥ 48 px' : ''}`,
        m.yellow <= 1 && m.overflow <= 0 && (size !== '390' || m.minTap >= 48), JSON.stringify(m));
      await p.screenshot({ path: `${SHOTS}/A-${who}-${size}-show.png` });
      await p.click('.map-fsheet .map-vchip:has-text("Satellite")');
      await sleep(600);
      const sat = await tileSrcs(p);
      await openShow(p).catch(() => {});
      const back = await lookChips(p);
      check(`A1 ${who} ${size}: Satellite picked, its tiles drawn, and Streets is there to pick back`, sat.some((u) => /satellite|\/tiles\//.test(u)) && back.includes('Streets'), JSON.stringify({ sat: sat.slice(0, 1), back }));
      await p.click('.map-fsheet .map-vchip:has-text("Streets")').catch(() => {});
      await sleep(400);
      if (size === '1440' || who === 'manager') await p.screenshot({ path: `${SHOTS}/A-${who}-${size}-map.png` });
      await p.close();
    }
  }

  // 2. The phone keeps no /tiles/; offline the map says so and its doors stay.
  if (want('A2')) {
    const c = await newContext(PHONE, { sw: true });
    await c.request.post(`${BASE}/api/auth/login`, { data: { email: `riley+${TAG}@example.org`, password: 'surrey-forward-2026' } });
    const p = await pageIn(c, 'sw');
    await openMap(p, '/admin/map');
    await p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.tiles === 'ok', null, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const kept = await p.evaluate(async () => {
      const out = [];
      for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(r.url);
      return { controlled: Boolean(navigator.serviceWorker?.controller), tiles: out.filter((u) => /\/tiles\//.test(u)) };
    });
    check('A2: under the service worker, after drawing Google’s tiles the phone keeps no /tiles/ entry', kept.controlled && kept.tiles.length === 0, JSON.stringify(kept));
    const r = await c.request.get(`${BASE}/tiles/15/5200/11200.png`);
    check('A2: the tile route passes Google’s "private, max-age=0, must-revalidate"', r.status() === 200 && r.headers()['cache-control'] === 'private, max-age=0, must-revalidate', `${r.status()} ${r.headers()['cache-control']}`);
    const doorsBefore = await p.evaluate(() => Number(document.querySelector('.map-canvas')?.dataset.doors || 0));
    // (setOffline doesn't reach what the service worker fetches: its /tiles/
    // fetches fail here as they do on a phone with no signal.)
    await c.route(/\/tiles\//, (r) => r.abort('internetdisconnected'));
    await c.setOffline(true);
    // Closer in: new tiles, none of them on the phone (the map's own + button).
    for (let i = 0; i < 2; i += 1) {
      await p.$eval('.leaflet-control-zoom-in', (el) => el.click());
      await sleep(900);
    }
    const line = await until(async () => { const t = await words(p, '.map-tilenote'); return /No signal — the street map is back when you are\. Your doors are all here\./.test(t) ? t : null; }, 12000);
    const doorsAfter = await p.evaluate(() => Number(document.querySelector('.map-canvas')?.dataset.doors || 0));
    const diag = await p.evaluate(() => ({ online: navigator.onLine, zoom: document.querySelector('.map-canvas')?.dataset.zoom,
      imgs: [...document.querySelectorAll('.leaflet-tile-pane img')].map((i) => `${i.complete && i.naturalWidth > 0 ? 'ok' : 'bad'}:${(i.getAttribute('src') || '').slice(-18)}`).slice(-6) }));
    check('A2: offline with Google’s tiles failing — "No signal — the street map is back when you are. Your doors are all here." and the doors still draw',
      Boolean(line) && doorsAfter > 0, JSON.stringify({ line: line || (await words(p, '.map-tilenote')), doorsBefore, doorsAfter, diag }));
    await p.screenshot({ path: `${SHOTS}/A-offline-390.png` });
    await c.setOffline(false);
    await c.unroute(/\/tiles\//);
    await p.close();
  }

  // 3. Only the key: New door offers own doors then B.C.'s rows — no Google.
  if (want('A3')) for (const [size, opts] of [['1440', DESK], ['390', PHONE]]) {
    const p = await pageIn(size === '390' ? await sized(s.mgr, opts) : s.mgr, `A3-${size}`);
    await openMap(p, '/admin/map');
    await openNewDoor(p);
    const before = g.autocomplete.length;
    await typeAddress(p, '#nd-address', '13450 104');
    const o = await options(p);
    const l = await logoAfterList(p);
    check(`A3 ${size}: only the key — own door first ("On the map"), then B.C.'s row; no Google rows or logo; Google saw no autocomplete`,
      o.length === 2 && /^2 – 13450 104 Ave Surrey · On the map$/.test(o[0]) && /^13450 104 Ave Surrey$/.test(o[1]) && !l.logo && g.autocomplete.length === before,
      JSON.stringify({ o, logo: l.logo, google: g.autocomplete.length - before }));
    const m = await measure(p, '.af-opt');
    check(`A10 ${size}: New door — one primary, no sideways scroll${size === '390' ? ', rows ≥ 48 px' : ''}`, m.yellow === 1 && m.overflow <= 0 && (size !== '390' || m.minTap >= 48), JSON.stringify(m));
    await p.screenshot({ path: `${SHOTS}/A-newdoor-bc-${size}.png` });
    await p.close();
  }

  // 8. Directions, by attribute only (never clicked).
  if (want('A8')) for (const [who, c, app] of [['manager', s.mgr, 'admin'], ['volunteer', s.vol, 'field']]) {
    for (const [size, opts] of [['1440', DESK], ['390', PHONE]]) {
      const label = `A8-${who}-${size}`;
      const t = await directionsTour(size === '390' ? await sized(c, opts) : c, label, s, { app, phone: size === '390' });
      check(`A8 ${who} ${size}: a door card’s More has Directions (walking, to the pin), new tab, noopener noreferrer, outside the ratings`,
        t.door && WALK.test(t.door.href) && relOk(t.door) && t.door.text === 'Directions' && !t.door.inRating && /^Directions to .+ in Google Maps$/.test(t.door.label || '')
        && (size !== '390' || t.door.h >= 48), JSON.stringify(t.door));
      check(`A8 ${who} ${size}: a walk-list door’s More has Directions (walking)`, t.walk && WALK.test(t.walk.href) && relOk(t.walk) && !t.walk.inRating && (size !== '390' || t.walk.h >= 48), JSON.stringify(t.walk));
      const pin = t.pinned.links;
      check(`A8 ${who} ${size}: a shift at a pinned place — its words, one "Directions" to the pin, no "Map ↗"`,
        pin.length === 1 && /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=49\.15,-122\.8$/.test(pin[0].href) && relOk(pin[0]) && pin[0].text === 'Directions'
        && /Fleetwood corner/.test(t.pinned.text) && !/Map ↗/.test(t.pinned.text) && (size !== '390' || pin[0].h >= 48), JSON.stringify(t.pinned));
      const wd = t.worded.links;
      check(`A8 ${who} ${size}: a shift at a place in words only — Directions to the words`,
        wd.length === 1 && /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=Newton%20Library/.test(wd[0].href) && !/travelmode/.test(wd[0].href) && relOk(wd[0]),
        JSON.stringify(t.worded));
    }
  }
  // A sign: Directions by car (the manager's Signs).
  if (want('A8')) {
    const p = await pageIn(s.mgr, 'A8-sign');
    await p.goto(`${BASE}/admin/signs`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.ops-item', { timeout: 10000 }).catch(() => {});
    const row = p.locator('.ops-item .ops-row').first();
    if (await row.count() && (await row.getAttribute('aria-expanded').catch(() => null)) === 'false') await row.click();
    await sleep(300);
    const links = await directionsIn(p, '.ops-item');
    check('A8: a sign’s Directions go by car (travelmode=driving), new tab, noopener noreferrer, the word "Directions", a full control tall', links.length >= 1
      && links.every((l) => DRIVE.test(l.href) && relOk(l) && l.text === 'Directions' && l.h >= 40), JSON.stringify(links));
    await p.close();
    // …and on a phone, 48 px.
    const pc = await sized(s.mgr, PHONE);
    const ph = await pageIn(pc, 'A8-sign-390');
    await ph.goto(`${BASE}/admin/signs`, { waitUntil: 'domcontentloaded' });
    await ph.waitForSelector('.ops-item', { timeout: 10000 }).catch(() => {});
    const prow = ph.locator('.ops-item .ops-row').first();
    if (await prow.count() && (await prow.getAttribute('aria-expanded').catch(() => null)) === 'false') await prow.click();
    await sleep(300);
    const plinks = await directionsIn(ph, '.ops-item');
    check('A8: a sign’s Directions is 48 px tall on a phone', plinks.length >= 1 && plinks.every((l) => l.h >= 48), JSON.stringify(plinks));
    await ph.screenshot({ path: `${SHOTS}/A8-sign-390.png` });
    await pc.close();
  }
  // 9. Your profile: the notice is the last line, after every card.
  if (want('A9')) for (const [who, c, path] of [['manager', s.mgr, '/admin/profile'], ['volunteer', s.vol, '/profile']]) {
    for (const [size, opts] of [['1440', DESK], ['390', PHONE]]) {
      const p = await pageIn(size === '390' ? await sized(c, opts) : c, `A9-${who}-${size}`);
      await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('.me-page .google-notice', { timeout: 10000 }).catch(() => {});
      const last = await p.evaluate(() => {
        const page = document.querySelector('.me-page');
        const el = page?.lastElementChild;
        return el ? { cls: el.className, text: el.innerText.replace(/\s+/g, ' ').trim(), links: [...el.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]) } : null;
      });
      check(`A9 ${who} ${size}: Your profile ends with the notice line (not a card), both links new-tab`,
        last && last.cls === 'google-notice' && /^Maps by Google\. Google Maps terms · Google privacy$/.test(last.text)
        && last.links.every(([, t, r]) => t === '_blank' && r === 'noopener noreferrer') && last.links.length === 2, JSON.stringify(last));
      const m = await measure(p, '.google-notice a');
      check(`A10 ${who} ${size}: Your profile — at most one primary, no sideways scroll${size === '390' ? ', links ≥ 48 px' : ''}`, m.yellow <= 1 && m.overflow <= 0 && (size !== '390' || m.minTap >= 48), JSON.stringify(m));
      await p.screenshot({ path: `${SHOTS}/A-profile-${who}-${size}.png`, fullPage: true });
      await p.close();
    }
  }
  // Settings → Services with the Places row off (the default).
  if (want('A')) {
    const p = await pageIn(s.mgr, 'A-services');
    await p.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.sv2-row', { timeout: 10000 }).catch(() => {});
    const row = await words(p, '.sv2-row:has(.sv2-name:text-is("Address suggestions (Google Places)"))');
    check('A: Services — Address suggestions (Google Places) off: "Off · the B.C. service (free) · Google’s suggestions need your confirmation first"',
      /Off · the B\.C\. service \(free\) · Google’s suggestions need your confirmation first/.test(row), row);
    const pins = await p.$$eval('.sv2-name', (els) => els.map((e) => e.innerText.trim()).filter((t) => /^Map pins/.test(t)));
    check('A: Services — the renamed row "Map pins (BC Address Geocoder)"', pins.includes('Map pins (BC Address Geocoder)'), pins.join(' | '));
    await p.screenshot({ path: `${SHOTS}/A-services-1440.png`, fullPage: true });
    await p.close();
  }
}

// ═══ B: ADDRESS_SUGGEST=google ═══
await startServer({ ADDRESS_SUGGEST: 'google' });
s = await seed();
{
  if (want('B4')) for (const [size, opts] of [['1440', DESK], ['390', PHONE]]) {
    const p = await pageIn(size === '390' ? await sized(s.mgr, opts) : s.mgr, `B4-${size}`);
    await openMap(p, '/admin/map');
    await openShow(p);
    const notice = await words(p, '.map-fsheet .google-notice');
    check(`B9 ${size}: with Places on, the Show sheet says "Maps and address suggestions by Google."`, /^Maps and address suggestions by Google\. Google Maps terms · Google privacy$/.test(notice), notice);
    await p.click('.map-fsheet .mapsheet-close');
    await openNewDoor(p);
    const a0 = g.autocomplete.length;
    const d0 = g.details.length;
    await typeAddress(p, '#nd-address', '13450 104');
    const o = await options(p);
    const l = await logoAfterList(p);
    check(`B4 ${size}: own door first, then Google’s rows ("Surrey, BC, Canada"), and Google’s logo after the list, outside it`,
      o.length >= 2 && /On the map/.test(o[0]) && o.slice(1).every((x) => /Surrey, BC, Canada$/.test(x)) && l.logo && !l.inside && l.after && l.options === o.length && /\/google\/google-maps-logo\.svg$/.test(l.img || '') && Math.round(l.height) === 16,
      JSON.stringify({ o, l }));
    const asks = g.autocomplete.slice(a0);
    check(`B4 ${size}: one session token for every ask, a v4 id, the key in X-Goog-Api-Key`,
      asks.length >= 1 && new Set(asks.map((x) => x.session)).size === 1 && /^[0-9a-f-]{36}$/.test(asks[0].session) && asks.every((x) => x.key === 'e2e-not-a-key'), JSON.stringify(asks));
    const m = await measure(p, '.af-opt');
    check(`B10 ${size}: Google’s rows — one primary, no sideways scroll${size === '390' ? ', rows ≥ 48 px' : ''}`, m.yellow === 1 && m.overflow <= 0 && (size !== '390' || m.minTap >= 48), JSON.stringify(m));
    await p.screenshot({ path: `${SHOTS}/B-newdoor-google-${size}.png` });
    // Pick a Google row: "Loading…", then the pin from B.C.
    const sawLoading = p.waitForFunction(() => [...document.querySelectorAll('.af-opt__sub')].some((e) => e.innerText === 'Loading…'), null, { timeout: 3000, polling: 20 }).then(() => true).catch(() => false);
    await p.click('.af-list .af-opt:has-text("13450 104 Ave"):not(:has-text("On the map"))');
    if (size === '390') await sleep(10).then(() => p.screenshot({ path: `${SHOTS}/B-pick-loading-${size}.png` }).catch(() => {}));
    const loading = await sawLoading;
    await until(async () => /Pinned on the map/.test(await words(p, '#nd-address-af-note')), 6000);
    const note = await words(p, '#nd-address-af-note');
    const det = g.details.slice(d0);
    check(`B4 ${size}: picking a Google row shows "Loading…", then "Pinned on the map — tap the map to move it"`, loading && /Pinned on the map — tap the map to move it/.test(note), JSON.stringify({ loading, note }));
    check(`B4 ${size}: one details call, with the same session and no location in the field mask`,
      det.length === 1 && det[0].session === asks[0].session && det[0].mask === 'addressComponents,formattedAddress' && !/location/.test(det[0].mask), JSON.stringify(det));
    await p.screenshot({ path: `${SHOTS}/B-picked-${size}.png` });
    // A pick B.C. can't place: "tap the map".
    await typeAddress(p, '#nd-address', '13459 104');
    await p.click('.af-list .af-opt:has-text("13459 104 Ave")').catch(() => {});
    const err = await until(async () => { const t = await words(p, 'form[aria-label="New door"] .error'); return /Couldn’t find that door on the map — tap the map where it is/.test(t) ? t : null; }, 6000);
    check(`B4 ${size}: a pick B.C. can’t place says "Couldn’t find that door on the map — tap the map where it is", the words stay`,
      Boolean(err) && /13459 104 Ave/.test(await p.inputValue('#nd-address')), `${err} · ${await p.inputValue('#nd-address')}`);
    await p.screenshot({ path: `${SHOTS}/B-tapthemap-${size}.png` });
    // Then a tap on the map: the pin is there and "tap the map" goes.
    const mb = await p.locator('.map-canvas').boundingBox();
    await p.mouse.click(mb.x + mb.width / 2, mb.y + 70);
    const tapped = await until(async () => /Pinned on the map/.test(await words(p, '#nd-address-af-note')), 4000);
    const errAfter = await words(p, 'form[aria-label="New door"] .error');
    await p.screenshot({ path: `${SHOTS}/B-tapped-${size}.png` });
    check(`B4 ${size}: after a tap on the map, "Pinned on the map" and no "tap the map" error`, tapped && !/tap the map/.test(errAfter), `${await words(p, '#nd-address-af-note')} · ${errAfter}`);
    await p.close();
  }

  // 7. Edit person at the desk: a Google pick fills street, unit, city, postal; placed by B.C.
  if (want('B7')) {
    const p = await pageIn(s.mgr, 'B7');
    await p.goto(`${BASE}/admin/people/${s.edit.id}`, { waitUntil: 'domcontentloaded' });
    await p.click('.pf-edit');
    await p.waitForSelector('#ed-address', { timeout: 5000 });
    // Leaving the box ends Google's session and takes its rows: none to pick
    // without one. Typing again asks again, in a new session, and that pick works.
    await typeAddress(p, '#ed-address', '13450 10');
    await p.keyboard.press('Tab');
    await sleep(400);
    await p.click('#ed-address');
    await sleep(400);
    const afterBlur = await options(p);
    check('B7: Edit person — the box left and come back to: Google’s rows are gone (no pick without a session)', afterBlur.length === 0, JSON.stringify(afterBlur));
    const a0 = g.autocomplete.length;
    const d0 = g.details.length;
    await p.keyboard.type('4', { delay: 40 });
    await p.waitForSelector('.af-list .af-opt:has-text("204-13450 104 Ave")', { timeout: 6000 }).catch(() => {});
    await sleep(300);
    await p.click('.af-list .af-opt:has-text("204-13450 104 Ave")');
    await until(async () => (await p.inputValue('#ed-unit')) === '204', 6000);
    const filled = { address: await p.inputValue('#ed-address'), unit: await p.inputValue('#ed-unit'), city: await p.inputValue('#ed-city'), postal: await p.inputValue('#ed-postal') };
    check('B7: Edit person — a Google pick fills street, unit, city and postal code', filled.address === '13450 104 Ave' && filled.unit === '204' && filled.city === 'Surrey' && filled.postal === 'V3T 1V8', JSON.stringify(filled));
    const asks7 = g.autocomplete.slice(a0);
    const det7 = g.details.slice(d0);
    check('B7: after coming back, one details call with the new typing run’s session', asks7.length >= 1 && det7.length === 1 && isUuid(det7[0].session) && asks7.every((x) => x.session === det7[0].session), JSON.stringify({ asks7, det7 }));
    await p.screenshot({ path: `${SHOTS}/B-edit-person-1440.png` });
    await p.click('form[aria-label="Edit details"] button[type="submit"]');
    const placed = await until(async () => {
      const r = await (await s.mgr.request.get(`${BASE}/api/persons/${s.edit.id}`)).json();
      return r.person?.lat != null ? r.person : null;
    }, 8000);
    check('B7: saved, and placed by B.C. (the stand-in’s pin) — on the map', placed && Math.abs(placed.lat - 49.1906) < 0.001 && Math.abs(placed.lng + 122.8466) < 0.001 && placed.unit === '204', JSON.stringify(placed && { lat: placed.lat, lng: placed.lng, unit: placed.unit }));
    await p.close();
  }
  // A Google pick with no answer in time: the words stay, and the line says so plainly.
  if (want('B7')) {
    const p = await pageIn(s.mgr, 'B7-fail');
    await p.goto(`${BASE}/admin/people/${s.edit.id}`, { waitUntil: 'domcontentloaded' });
    await p.click('.pf-edit');
    await p.waitForSelector('#ed-address', { timeout: 5000 });
    await typeAddress(p, '#ed-address', '13470 104');
    await p.click('.af-list .af-opt:has-text("13470 104 Ave")').catch(() => {});
    const line = await until(async () => { const t = await words(p, '#ed-address-af-note'); return /Couldn’t get that address/.test(t) ? t : null; }, 8000);
    check('B7: a Google pick that fails — "Couldn’t get that address — check it and save; it’s placed on the map when you save", the words kept',
      line === 'Couldn’t get that address — check it and save; it’s placed on the map when you save' && /13470 104 Ave/.test(await p.inputValue('#ed-address')), `${line} · ${await p.inputValue('#ed-address')}`);
    await p.screenshot({ path: `${SHOTS}/B-pick-failed-1440.png` });
    await p.close();
  }
  // Services: the Places row on, with today's counts.
  if (want('B')) {
    const p = await pageIn(s.mgr, 'B-services');
    await p.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.sv2-row', { timeout: 10000 }).catch(() => {});
    const row = await words(p, '.sv2-row:has(.sv2-name:text-is("Address suggestions (Google Places)"))');
    check('B: Services — Places on: "Google Places, then the B.C. service when Google is busy · Today: N of 300 asks"', /Google Places, then the B\.C\. service when Google is busy · Today: [\d,]+ of 300 asks/.test(row), row);
    await p.screenshot({ path: `${SHOTS}/B-services-on-1440.png`, fullPage: true });
    await p.close();
  }

  // 5. Google refusing Places: B.C.'s rows, no logo, one refused call; Services flagged.
  g.places = 'blocked';
  if (want('B5')) {
    const p = await pageIn(s.mgr, 'B5');
    await openMap(p, '/admin/map');
    await openNewDoor(p);
    const r0 = g.refusedPlaces;
    await typeAddress(p, '#nd-address', '13450 104 A');
    await p.keyboard.press('Backspace');
    await p.keyboard.press('Backspace');
    await sleep(700);
    await p.keyboard.type('v', { delay: 60 });
    await sleep(700);
    await typeAddress(p, '#nd-address', '13460 104');
    const o = await options(p);
    const l = await logoAfterList(p);
    check('B5: Google refusing Places — the box offers B.C.’s rows, no Google logo, and Google saw one refused call however many letters',
      o.some((x) => /^13460 104 Ave Surrey$/.test(x)) && !l.logo && g.refusedPlaces - r0 === 1, JSON.stringify({ o, logo: l.logo, refused: g.refusedPlaces - r0 }));
    await p.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.sv2-row', { timeout: 10000 }).catch(() => {});
    const sel = '.sv2-row:has(.sv2-name:text-is("Address suggestions (Google Places)"))';
    const row = await words(p, sel);
    check('B5: Services — Address suggestions (Google Places) flagged: "Add Map Tiles API and Places API (New) to it", Google said, Recipe B step 4',
      /Add Map Tiles API and Places API \(New\) to it/.test(row) && /Google said/.test(row) && /Recipe B step 4/.test(row), row);
    check('B5: …its badge is a warning, "Set up · not working", never a green "Set up"', (await p.locator(`${sel} .sv2-state--ready`).count()) === 0
      && /Set up · not working/.test(await p.locator(`${sel} .sv2-state`).innerText().catch(() => '')), await p.locator(`${sel} .sv2-state`).innerText().catch(() => ''));
    await p.locator(sel).scrollIntoViewIfNeeded().catch(() => {});
    await p.screenshot({ path: `${SHOTS}/B-services-paused-1440.png`, fullPage: true });
    // The Map check's Address suggestions line.
    await openMap(p, '/admin/map');
    await openShow(p);
    await p.click('.map-fsheet__check');
    await p.waitForFunction(() => /Not working|Working/.test(document.querySelector('.map-check [data-key="suggestsvc"]')?.innerText || ''), null, { timeout: 12000 }).catch(() => {});
    const line = await words(p, '.map-check [data-key="suggestsvc"]');
    const pinsLine = await words(p, '.map-check [data-key="lookupsvc"]');
    check('B5: the Map check — "Map pins", then "Address suggestions · Not working · Google Places" with Google’s words', /^Map pins/.test(pinsLine) && /Address suggestions/.test(line) && /Not working · Google Places/.test(line) && /Google said/.test(line), `${pinsLine} | ${line}`);
    await p.screenshot({ path: `${SHOTS}/B-mapcheck-1440.png` });
    await p.close();
  }
  g.places = 'ok';
}

// ═══ C: Google refusing tiles — the free map, and no Google rows ═══
g.tiles = 'billing';
await startServer({ ADDRESS_SUGGEST: 'google' });
s = await seed();
if (want('C')) {
  const p = await pageIn(s.mgr, 'C6');
  const asks = [];
  p.on('request', (r) => { if (/\/api\/address\/suggest/.test(r.url())) asks.push(r.url()); });
  await p.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.map-canvas', { timeout: 15000 });
  await until(async () => (await tileSrcs(p)).some((u) => /cartocdn|openstreetmap/.test(u)), 15000);
  const srcs = await tileSrcs(p);
  check('C6: Google refusing tiles — the free map draws', srcs.some((u) => /cartocdn|openstreetmap/.test(u)), JSON.stringify(srcs.slice(0, 2)));
  const a0 = g.autocomplete.length;
  await openNewDoor(p);
  await typeAddress(p, '#nd-address', '13450 104');
  const o = await options(p);
  const l = await logoAfterList(p);
  check('C6: over the free map New door asks with nogoogle=1 — no Google rows, no logo, no autocomplete',
    asks.length > 0 && asks.every((u) => /nogoogle=1/.test(u)) && !l.logo && o.every((x) => !/Surrey, BC, Canada$/.test(x)) && g.autocomplete.length === a0,
    JSON.stringify({ asks: asks.slice(-1), o, google: g.autocomplete.length - a0 }));
  await p.close();
}
g.tiles = 'ok';

// ═══ D: Google turned off — every Directions link still there ═══
await startServer({ GOOGLE_MAPS_TILES: 'off' });
s = await seed();
if (want('D')) {
  const t = await directionsTour(s.mgr, 'D8', s, { app: 'admin', phone: false });
  check('D8: Google off — Directions still on the door card, the walk list and both shifts',
    WALK.test(t.door?.href || '') && WALK.test(t.walk?.href || '') && t.pinned.links.length === 1 && t.worded.links.length === 1, JSON.stringify({ door: t.door?.href, walk: t.walk?.href }));
  const p = await pageIn(s.mgr, 'D9');
  await p.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  check('D9: Google off — no notice line on Your profile', !(await p.$('.google-notice')));
  await p.close();
}

// ── The end ──
check('no request left 127.0.0.1 but the aborted Google and B.C. ones (and the routed free-map tiles)', leaks.length === 0, leaks.slice(0, 5).join(' | '));
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
for (const c of contexts) await c.close().catch(() => {});
await browser.close();
await stopServer();
bcServer.close();
gServer.close();
if (madeLogo) rmSync(join(ROOT, 'web/dist/google'), { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
