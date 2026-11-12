// A map people can see — browser suite for a list too big to load at once.
// Its own server treats a few hundred made-up people as a city's worth
// (STARBASE_MAP_ALL=40: asked for by the part of the map on screen; at most
// 60 people whole and 200 doors as dots in one view), so every way the map
// draws a big list is reached with a small one:
//   · the first view is the campaign's own list — two people filed in another
//     city don't zoom it out — drawn as shaded patches, with the count in
//     people, a key and "Each square is a block — zoom in for doors", and the
//     patches asked for once;
//   · zooming in while the answer is on its way keeps what was drawn and says
//     "Loading…" — never "0", never an empty map; an answer that fails says
//     "Unavailable — Try again";
//   · a link to one person in the busiest block shows their door and card,
//     the doors around it as dots (the count in doors, on screen), and a tap
//     on a dot opens that door; the filter sheet counts what the dots can
//     say, and a rating nobody there has is "0 doors", not "Nobody on file
//     here";
//   · where the people fit they come whole: a door with room around it has
//     its pin at zoom 17, every door at 18;
//   · "Whole list" goes back; an empty part of the map says "Nobody on file
//     here · Back to your list" — as soon as nobody is on screen, just past
//     the list's edge too;
//   · on a 390 px phone the first view fits, nothing scrolls sideways, and
//     after a finger drag the picture is still one sheet (its tiles lap: no
//     line of the street map between two of them);
//   · layout: the map fills its place in a browser without :has() or dvh, on
//     a phone held sideways, and the Show sheet scrolls inside the map, each
//     choice's dot beside its name;
//   · the street map says when it isn't loading: one switch to the other
//     provider by itself — only if that one answers — then "The street map
//     isn’t loading" with one tap (to the other only if it has just
//     answered; a look tapped is theirs once its streets come); with the
//     service worker in control a failed tile is a failure; with weak
//     signal, or a flicker, the streets it kept still draw (back to the
//     person's pick by itself — drawn too with no signal), and their pick
//     is theirs again once it answers (asked every minute); tiles that never
//     answer (the signal gone while a view was loading) are said too, view
//     by view and zoom by zoom, and a note said of slow tiles goes by itself
//     once they come;
//   · turfs come as outlines at once; a turf's counts load when its sheet
//     opens ("Loading…", never "No doors" on the way);
//   · an import that leaves addresses without a pin starts the placing run
//     by itself (a stand-in address lookup on :4949), the map shows its
//     progress, and after a pause it tries again with nobody tapping;
//   · the Map check (managers) says which trouble a map has, in one screen;
//   · a phone reopened with no answer shows the doors it kept, and the line
//     that says so lies clear of the zoom and corner buttons; on "My turf"
//     no "Unavailable" for the list's answers, which aren't drawn there; a
//     manager's big list, which keeps no doors, says "Unavailable — Try
//     again" alone — and once it answers again, nothing about kept doors.
//
//   (cd web && npm run build) && node e2e-map.mjs        (its own server on :4948, the stand-in lookup on :4949)
//   ONLY=tiles,check node e2e-map.mjs                    just those parts: list · layout · tiles · turfs · placing · check · kept
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4948;
const SHOTS = process.env.SHOTS || join(tmpdir(), 'basewin-map-shots');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};

// A stand-in for the BC Address Geocoder (the real one can't be reached from
// a test, and a test must not lean on it): "<n> Placing Way" is found at a
// spot of its own, after geo.ms; geo.mode 'down' answers 503 to everything.
const geo = { mode: 'ok', ms: 200, asked: 0 };
const geocoder = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams.get('addressString') || '';
  geo.asked += 1;
  setTimeout(() => {
    if (geo.mode === 'down') { res.writeHead(503); res.end('busy'); return; }
    const n = Number(/^\d+/.exec(q)?.[0] || 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ features: [{
      geometry: { coordinates: [Number((-122.83 + (n % 20) * 0.0004).toFixed(6)), Number((49.105 + Math.floor((n % 400) / 20) * 0.0003).toFixed(6))] },
      properties: { score: 97, matchPrecision: 'CIVIC_NUMBER', fullAddress: q },
    }] }));
  }, geo.ms);
});
await new Promise((resolve) => geocoder.listen(PORT + 1, '127.0.0.1', resolve));

// Background jobs are on (the placing run is one): looked at every 400 ms.
// A round where no lookup answers is tried again at once, and a paused run
// tries again by itself after 8 s (15 minutes, outside a test).
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), GEOCODE_ON_SAVE: 'off',
    STARBASE_JOBS: 'on', STARBASE_JOBS_EVERY_MS: '400', GEOCODER: 'bc', BC_GEOCODER_URL: `http://127.0.0.1:${PORT + 1}`,
    GEOCODE_BACKOFF_MS: '0', GEOCODE_RETRY_MS: '8000',
    STARBASE_MAP_ALL: '40', STARBASE_MAP_VIEW: '60', STARBASE_MAP_DOTS: '200',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});
const BASE = `http://127.0.0.1:${PORT}`;

// (With this on, the tile routes below also answer what a service worker
// fetches — the part that checks a failed tile under one needs it.)
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#fafaf8"/><path d="M0 128H256M128 0V256" stroke="#e2e3e0" stroke-width="2"/></svg>';
const EMAIL = `map+${Date.now().toString(36)}@example.org`;
const PASSWORD = 'surrey-forward-2026';
let signedUp = false;
const standIn = { status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg };
// tiles: false — the part that tests the street map answers the tile hosts itself.
const context = async (opts = {}, { tiles = true } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver', serviceWorkers: 'block', ...opts });
  if (tiles) await ctx.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => route.fulfill(standIn));
  const r = signedUp
    ? await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASSWORD } })
    : await ctx.request.post(`${BASE}/api/auth/signup`, { data: { name: 'Riley Manager', email: EMAIL, password: PASSWORD, workspaceName: 'Big list', jurisdiction: 'bc-municipal' } });
  if (!r.ok()) throw new Error(`sign-in ${r.status()} ${await r.text()}`);
  signedUp = true;
  return ctx;
};

// ── The list: a city's worth in miniature ──
//   the city   14 × 12 doors, about 660 m apart (one person each)
//   a block    8 × 8 doors, about 28 m apart
//   a busy row 6 × 6 doors, 12 m apart, two people each — more people than
//              one view takes whole, at any zoom
//   two people filed in Prince George
const DOORS = [];
const at = (n) => Number(n.toFixed(6));
for (let i = 0; i < 14; i += 1) for (let j = 0; j < 12; j += 1) DOORS.push({ part: 'city', lat: at(49.09 + i * 0.006), lng: at(-122.9 + j * 0.009), address: `${1000 + i * 12 + j} City Rd`, people: 1 });
for (let i = 0; i < 8; i += 1) for (let j = 0; j < 8; j += 1) DOORS.push({ part: 'block', lat: at(49.13 + i * 0.00025), lng: at(-122.85 + j * 0.0004), address: `${2000 + i * 8 + j} Block St`, people: 1 });
for (let i = 0; i < 6; i += 1) for (let j = 0; j < 6; j += 1) DOORS.push({ part: 'row', i, j, lat: at(49.134 + i * 0.00011), lng: at(-122.85 + j * 0.00016), address: `${3000 + i * 6 + j} Busy Row`, people: 2 });
const AWAY = [{ lat: 53.91, lng: -122.75, address: '1 Far St', people: 1 }, { lat: 53.912, lng: -122.75, address: '2 Far St', people: 1 }];
const PEOPLE = DOORS.reduce((n, d) => n + d.people, 0);

const ctx = await context();
const post = async (path, data) => {
  const r = await ctx.request.post(`${BASE}/api${path}`, { data });
  if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
};
const jobs = [];
for (const d of [...DOORS, ...AWAY]) {
  for (let k = 0; k < d.people; k += 1) {
    jobs.push(async () => {
      const p = (await post('/actions/person.create', { name: `${d.address.split(' ')[0]}${k ? 'b' : ''} Example`, address: d.address, city: 'Surrey', lat: d.lat, lng: d.lng })).person;
      (d.ids ||= []).push(p.id);
    });
  }
}
for (let i = 0; i < jobs.length; i += 12) await Promise.all(jobs.slice(i, i + 12).map((fn) => fn()));
const row = (i, j) => DOORS.find((d) => d.part === 'row' && d.i === i && d.j === j);
// In the busy row: three doors say yes, two are voting Locke.
for (const [i, j, rating] of [[0, 0, '1'], [0, 1, '1'], [0, 2, '2'], [5, 0, '4B'], [5, 1, '4B']]) {
  await post('/actions/contact.log', { person_id: row(i, j).ids[0], channel: 'door', outcome: 'contacted', rating });
}

const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const asked = [];
page.on('request', (r) => { if (/\/api\/map\//.test(r.url())) asked.push(r.url().replace(/^.*\/api\/map\//, '')); });

// What the map says about itself.
const mapState = () => page.evaluate(() => {
  const el = document.querySelector('.map-canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const words = (s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() || null;
  return {
    zoom: Number(el.dataset.zoom), doors: Number(el.dataset.doors), view: el.dataset.view || null,
    bounds: (el.dataset.bounds || '').split(',').map(Number),
    box: { x: r.x, y: r.y, w: r.width, h: r.height },
    pill: words('.map-filter-btn'), busy: words('.map-filter-btn__busy'), key: words('.map-key'), note: words('.map-zoomnote'),
    nobody: words('.map-nobody'), retry: words('.map-retry'), card: words('aside.door-card'),
    pins: el.querySelectorAll('.map-pin').length, chosen: el.querySelectorAll('.map-pin--selected').length,
  };
});
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  let st = await mapState();
  while (!(st && fn(st)) && Date.now() < end) { await sleep(150); st = await mapState(); }
  return st || {};
};
const settled = (fn = () => true) => until((s) => s.view && !s.busy && !/Loading/.test(s.pill || '') && fn(s));
const numberIn = (pill) => Number((/([\d,]+)\s+(?:people|person|doors?)\b/.exec(pill || '') || [])[1]?.replace(/,/g, '') ?? NaN);
const inside = ([s, w, n, e], d) => d.lat > s && d.lat < n && d.lng > w && d.lng < e;
const merc = (lat) => Math.asinh(Math.tan((lat * Math.PI) / 180));
const pointOf = (st, d) => {
  const [s, w, n, e] = st.bounds;
  return [st.box.x + ((d.lng - w) / (e - w)) * st.box.w, st.box.y + ((merc(n) - merc(d.lat)) / (merc(n) - merc(s))) * st.box.h];
};
// Is there ink on the map's canvas at these screen points? (0–255 each)
const inkAt = (pts) => page.evaluate((points) => points.map(([x, y]) => {
  let most = 0;
  for (const c of document.querySelectorAll('canvas.map-dots-tile')) {
    const r = c.getBoundingClientRect();
    if (!c.width || x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
    const a = c.getContext('2d').getImageData(Math.floor(((x - r.left) / r.width) * c.width), Math.floor(((y - r.top) / r.height) * c.height), 1, 1).data[3];
    most = Math.max(most, a);
  }
  return most;
}), pts);
// (A tap on + or − while the last zoom is still moving is ignored: each one
// waits for the map to land on its new zoom.)
const zoomBy = async (sel, times = 1) => {
  for (let i = 0; i < times; i += 1) {
    const was = (await mapState())?.zoom;
    await page.click(sel);
    await until((s) => s.zoom !== was, 4000);
    await sleep(200);
  }
};

// ONLY=layout,tiles node e2e-map.mjs runs just those parts (list · layout · tiles · turfs · placing · check · kept).
const ONLY = new Set(String(process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean));
const want = (part) => !ONLY.size || ONLY.has(part);

let failed = null;
try {
  if (want('list')) {
    // ══ 1. The first view: the campaign's own list, as a picture ══
    await page.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    let st = await settled((s) => s.view === 'density');
    await sleep(600);
    st = await mapState();
    await page.screenshot({ path: `${SHOTS}/1-first-view-1440.png` });
    const first = st;
    check('a big list opens as a picture: patches, not doors', st.view === 'density' && st.doors === 0, JSON.stringify({ view: st.view, zoom: st.zoom, pill: st.pill }));
    check('…on the campaign’s own list: two people filed in another city don’t zoom it out', st.zoom >= 12 && DOORS.every((d) => inside(st.bounds, d)) && !AWAY.some((d) => inside(st.bounds, d)), `zoom ${st.zoom} · ${st.bounds}`);
    check('the count is in people, and counts what is on screen', /people/.test(st.pill || '') && numberIn(st.pill) === PEOPLE, `${st.pill} (on screen: ${PEOPLE}; on file: ${PEOPLE + 2})`);
    check('a key says what the colours are, and what a square is', /Not asked yet.*Yes.*Undecided.*Opposed/.test(st.key || '') && /Each square is a block — zoom in for doors/.test(st.key || ''), st.key);
    const patches = asked.filter((u) => u.startsWith('density'));
    check('the patches were asked for once', patches.length === 1, `${patches.length} requests: ${patches.map((u) => u.slice(0, 60)).join(' | ')}`);
    // A patch is a filled square of the map, not a small disc in the middle of one.
    const [dlat, dlng] = /cell=([\d.]+),([\d.]+)/.exec(patches[0] || '').slice(1).map(Number);
    const lone = DOORS.find((d) => d.part === 'city' && d.lat === 49.09 && d.lng === -122.9);
    const mid = { lat: (Math.floor(lone.lat / dlat) + 0.5) * dlat, lng: (Math.floor(lone.lng / dlng) + 0.5) * dlng };
    const [mx, my] = pointOf(st, mid);
    const side = (dlng / (st.bounds[3] - st.bounds[1])) * st.box.w;
    const ink = await inkAt([[mx, my], [mx - side * 0.36, my - side * 0.36], [mx + side * 0.36, my + side * 0.36], [mx + side * 0.36, my - side * 0.36], [mx - side * 0.8, my]]);
    check('a patch is a shaded square, edge to edge (and its neighbour with nobody in it is bare)', ink.slice(0, 4).every((a) => a > 200) && ink[4] === 0, `ink at its middle, three corners, next door: ${ink} (a patch is ${side.toFixed(1)} px)`);
    check('“Whole list” is one tap away', await page.locator('.map-fab--list:has-text("Whole list")').isVisible());

    // ══ 2. Zooming in while the answer is on its way ══
    let hold = 2500;
    await page.route(/\/api\/map\/(doors\?bbox|density)/, async (route) => { await sleep(hold); await route.continue().catch(() => {}); });
    const upTo15 = Math.ceil(15 - first.zoom);
    await zoomBy('.leaflet-control-zoom-in', upTo15);
    await sleep(700);
    st = await mapState();
    // (The block's own patch is still painted where the block is.)
    const kept = (await inkAt([pointOf(st, { lat: 49.1309, lng: -122.8486 })]))[0];
    await page.screenshot({ path: `${SHOTS}/2-zooming-while-loading.png` });
    check('zoomed past 15, the answer still out: what was drawn stays, the count is not 0', st.zoom >= 15 && st.view === 'density' && kept > 200 && numberIn(st.pill) > 0 && !/\b0\b/.test(st.pill || ''), JSON.stringify({ zoom: st.zoom, view: st.view, pill: st.pill, ink: kept }));
    check('…and it says “Loading…” beside the count', /Loading…/.test(st.busy || ''), st.pill);
    st = await settled((s) => s.view !== 'density' || s.note);
    check('the answer in: doors, and the count in doors', st.view === 'dots' && /doors?\b/.test(st.pill || '') && !st.busy, JSON.stringify({ view: st.view, pill: st.pill, note: st.note }));
    await page.unroute(/\/api\/map\/(doors\?bbox|density)/);
    // An answer that never comes: said, with a way to try again — the doors drawn stay.
    const drawnDoors = st.doors;
    await page.route(/\/api\/map\/doors\?bbox/, (route) => route.abort('failed'));
    await zoomBy('.leaflet-control-zoom-in', 1);
    st = await until((s) => s.retry, 8000);
    check('no answer for the part on screen: “Unavailable — Try again”, and what was drawn stays', /Unavailable — Try again/.test(st.retry || '') && st.view === 'dots' && st.doors === drawnDoors && !/\b0 doors/.test(st.pill || ''), JSON.stringify({ retry: st.retry, view: st.view, doors: st.doors, pill: st.pill }));
    await page.unroute(/\/api\/map\/doors\?bbox/);
    await page.click('.map-retry');
    st = await settled((s) => !s.retry);
    check('Try again loads it', !st.retry && st.view && /doors?\b/.test(st.pill || ''), JSON.stringify({ view: st.view, pill: st.pill }));

    // ══ 3. A link to one person in the busiest block ══
    const who = row(3, 3);
    await page.goto(`${BASE}/admin/map?person=${who.ids[0]}`, { waitUntil: 'domcontentloaded' });
    st = await until((s) => s.card && s.view, 12000);
    await sleep(500);
    st = await mapState();
    await page.screenshot({ path: `${SHOTS}/3-link-to-a-person-busy-block.png` });
    check('a link to a person shows their door and their card, however busy the place', /3021 Busy Row/.test(st.card || '') && st.chosen === 1 && st.zoom >= 17, JSON.stringify({ zoom: st.zoom, view: st.view, chosen: st.chosen, card: (st.card || '').slice(0, 60) }));
    check('…with the doors around it as dots (more people here than one view takes whole)', st.view === 'dots' && st.doors >= 30, JSON.stringify({ view: st.view, doors: st.doors }));
    await page.keyboard.press('Escape');
    st = await settled((s) => !s.card);
    const onScreen = DOORS.filter((d) => inside(st.bounds, d)).length;
    check('the count is in doors, and counts what is on screen', /doors/.test(st.pill || '') && numberIn(st.pill) === onScreen, `${st.pill} (on screen: ${onScreen})`);
    check('the key says a dot is a door', /Each dot is a door/.test(st.key || ''), st.key);
    // A tap on a dot opens that door.
    const other = row(1, 4);
    await page.mouse.click(...pointOf(st, other));
    st = await until((s) => s.card, 6000);
    check('a tap on a dot opens that door', /3010 Busy Row/.test(st.card || '') && st.chosen === 1, (st.card || 'no card').slice(0, 80));
    await page.keyboard.press('Escape');
    await settled((s) => !s.card);
    // The filter sheet: what dots can say (a household's band), and no more.
    await page.click('.map-filter-btn');
    await page.waitForSelector('.map-fsheet');
    const sheetN = async (label) => (await page.locator(`.map-fsheet .map-fopt:has-text("${label}") .map-fopt__n`).innerText()).trim();
    const [yes, opposed, signs, ones] = [await sheetN('Yes (1–2)'), await sheetN('Opposed'), await sheetN('Has a sign'), await sheetN('Strong yes (1)')];
    check('the sheet counts the doors by band; what dots can’t say is left blank, not 0', yes === '3' && opposed === '2' && signs === '' && ones === '', JSON.stringify({ yes, opposed, signs, ones }));
    await page.click('.map-fsheet .map-fopt:has-text("Strong yes (1)")');
    st = await settled((s) => /Strong yes/.test(s.pill || '') && s.doors === 2);
    check('“Strong yes (1)”: the server keeps the dots to those doors', st.doors === 2 && numberIn(st.pill) === 2, JSON.stringify({ doors: st.doors, pill: st.pill }));
    // A rating nobody on screen has: the answer holds that rating's doors
    // only, so none in it is not nobody on file here (it said "Nobody on file
    // here · Back to your list" over a row full of doors).
    await page.click('.map-filter-btn');
    await page.click('.map-fsheet .map-fopt:has-text("McCallum")');
    st = await settled((s) => /McCallum/.test(s.pill || '') && s.doors === 0);
    await sleep(700);
    st = await mapState();
    await page.screenshot({ path: `${SHOTS}/3-a-rating-nobody-here-has.png` });
    check('a rating nobody on screen has (“Voting McCallum”): “0 doors” — and no “Nobody on file here” over a row full of doors',
      /McCallum/.test(st.pill || '') && st.view === 'dots' && st.doors === 0 && numberIn(st.pill) === 0 && !st.nobody, JSON.stringify({ pill: st.pill, view: st.view, doors: st.doors, nobody: st.nobody }));
    // What dots can’t say is said in a sentence, with no empty count beside the filter’s name.
    await page.click('.map-filter-btn');
    await page.click('.map-fsheet .map-fopt:has-text("Has a sign")');
    st = await settled((s) => /Has a sign/.test(s.pill || ''));
    const chip = await page.evaluate(() => Math.round(document.querySelector('.map-filter-btn__n')?.getBoundingClientRect().width || 0));
    check('“Has a sign” from this far: “Zoom in to see signs”, and no empty count', st.note === 'Zoom in to see signs' && chip === 0, JSON.stringify({ note: st.note, pill: st.pill, chip }));
    await page.click('.map-filter-btn');
    await page.click('.map-fsheet .map-fopt[data-band="all"]');
    await settled((s) => /All/.test(s.pill || ''));
    // Further out: dots while they fit, then patches again — and it says why.
    await zoomBy('.leaflet-control-zoom-out', 2);
    st = await settled((s) => s.zoom <= 15.5);
    check('zoom 15: still every door a dot', st.zoom === 15 && st.view === 'dots' && st.doors > 60, JSON.stringify({ zoom: st.zoom, view: st.view, doors: st.doors, pill: st.pill }));
    await zoomBy('.leaflet-control-zoom-out', 1);
    st = await settled((s) => s.view === 'density');
    await page.screenshot({ path: `${SHOTS}/3-too-many-doors-for-dots.png` });
    check('too many doors for dots: patches, “Zoom in to see each door”, the count in people', st.view === 'density' && /Zoom in to see each door/.test(st.note || '') && /people/.test(st.pill || ''), JSON.stringify({ zoom: st.zoom, view: st.view, note: st.note, pill: st.pill }));

    // ══ 4. Where the people fit, they come whole: pins from zoom 17 where there is room ══
    const far = DOORS.find((d) => d.part === 'city' && d.lat === 49.102 && d.lng === -122.882);
    await page.goto(`${BASE}/admin/map?person=${far.ids[0]}`, { waitUntil: 'domcontentloaded' });
    st = await until((s) => s.card && s.view, 12000);
    check('a quiet part of the list: the people themselves', st.view === 'rows' && /City Rd/.test(st.card || '') && st.zoom === 17, JSON.stringify({ zoom: st.zoom, view: st.view, card: (st.card || '').slice(0, 40) }));
    await page.keyboard.press('Escape');
    st = await settled((s) => !s.card);
    await page.screenshot({ path: `${SHOTS}/4-zoom-17-pins-where-they-fit.png` });
    const doorsHere = DOORS.filter((d) => inside(st.bounds, d)).length;
    check('zoom 17: a door with room around it has its pin', st.zoom === 17 && st.pins >= 1 && numberIn(st.pill) === doorsHere, JSON.stringify({ zoom: st.zoom, pins: st.pins, pill: st.pill, onScreen: doorsHere }));
    await zoomBy('.leaflet-control-zoom-in', 1);
    st = await settled((s) => s.zoom >= 18);
    check('zoom 18: pins', st.pins >= 1 && st.view === 'rows', JSON.stringify({ zoom: st.zoom, pins: st.pins }));

    // ══ 5. Back to the list, from anywhere ══
    await page.click('.map-fab--list');
    st = await settled((s) => s.view === 'density' && s.zoom < 14);
    check('“Whole list” goes back to the first view', Math.abs(st.zoom - first.zoom) <= 0.25 && DOORS.every((d) => inside(st.bounds, d)) && numberIn(st.pill) === PEOPLE, JSON.stringify({ zoom: st.zoom, first: first.zoom, pill: st.pill }));
    await ctx.grantPermissions(['geolocation']);
    await ctx.setGeolocation({ latitude: 49.3, longitude: -123.3 }); // out in the strait
    await page.click('.map-fab[aria-label="Locate me"]');
    st = await until((s) => s.nobody, 10000);
    await page.screenshot({ path: `${SHOTS}/5-nobody-on-file-here.png` });
    check('a part of the map with nobody in it says so, with the way back', /Nobody on file here/.test(st.nobody || '') && /Back to your list/.test(st.nobody || ''), JSON.stringify({ zoom: st.zoom, nobody: st.nobody, pill: st.pill }));
    await page.click('.map-nobody button');
    st = await settled((s) => s.view === 'density' && !s.nobody && numberIn(s.pill) === PEOPLE);
    check('“Back to your list” goes back', !st.nobody && numberIn(st.pill) === PEOPLE, JSON.stringify({ zoom: st.zoom, pill: st.pill }));
    // Just past the list's edge: its last squares have only just left the
    // screen, and the part asked for — the screen and some — still holds
    // them. Nobody is on screen, and that is what the note goes by ("0
    // people" over an empty map, the key still explaining squares, and no
    // way back said).
    const edge = (Math.floor(Math.max(...DOORS.map((d) => d.lng)) / dlng) + 1) * dlng; // the east side of the list's last square
    const past = (s) => (s.bounds[1] - edge) / (s.bounds[3] - s.bounds[1]); // how far past it the screen starts, in screens
    for (let i = 0; i < 8 && Math.abs(past(st) - 0.1) > 0.03; i += 1) {
      const dx = Math.max(-500, Math.min(500, (0.1 - past(st)) * st.box.w));
      const [x, y] = [st.box.x + st.box.w / 2, st.box.y + st.box.h / 2];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - dx, y, { steps: 6 });
      await sleep(150); // (let go standing still: the map doesn't glide on)
      await page.mouse.up();
      await sleep(400);
      st = await mapState();
    }
    await sleep(900);
    st = await settled();
    await page.screenshot({ path: `${SHOTS}/5-just-past-the-edge.png` });
    check('just past the list’s edge (its last squares off the screen, still in the part asked for): nobody on screen, so it says so, with the way back',
      past(st) > 0.02 && past(st) < 0.15 && Math.floor(st.zoom) === Math.floor(first.zoom) && numberIn(st.pill) === 0 && /Nobody on file here/.test(st.nobody || '') && !/Each square/.test(st.key || ''),
      JSON.stringify({ past: Number(past(st).toFixed(3)), zoom: st.zoom, pill: st.pill, nobody: st.nobody, key: st.key }));
    await page.click('.map-nobody button').catch(() => page.click('.map-fab--list'));
    st = await settled((s) => s.view === 'density' && !s.nobody && numberIn(s.pill) === PEOPLE);

    // ══ 6. A phone ══
    const pctx = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await pctx.newPage();
    phone.on('pageerror', (e) => errors.push(`[phone] ${e.message}`));
    await phone.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
    await phone.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.view === 'density' && /people/.test(document.querySelector('.map-filter-btn')?.innerText || ''), null, { timeout: 12000 }).catch(() => {});
    await sleep(800);
    await phone.screenshot({ path: `${SHOTS}/6-first-view-390.png` });
    const ph = await phone.evaluate(() => {
      const el = document.querySelector('.map-canvas');
      const rect = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) } : null; };
      return {
        view: el?.dataset.view, bounds: (el?.dataset.bounds || '').split(',').map(Number),
        pill: document.querySelector('.map-filter-btn')?.innerText.replace(/\s+/g, ' ').trim(), key: rect('.map-key'), list: rect('.map-fab--list'),
        sideways: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    check('a phone: the whole list as a picture, the count in people', ph.view === 'density' && DOORS.every((d) => inside(ph.bounds, d)) && numberIn(ph.pill) === PEOPLE, JSON.stringify({ view: ph.view, pill: ph.pill }));
    check('…the key and “Whole list” on screen, a full-size tap, nothing scrolls sideways', ph.key && ph.key.l >= 0 && ph.key.r <= 390 && ph.list && ph.list.r <= 390 && ph.list.h >= 48 && ph.sideways <= 0, JSON.stringify(ph));
    // A finger drag leaves the map a fraction of a pixel off (and some phones'
    // pixels are a fraction of one anyway). The picture's tiles lap over each
    // other, so no line of the street map shows between two of them.
    const touch = await pctx.newCDPSession(phone);
    const finger = (type, x, y) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await finger('touchStart', 180.4, 420.2);
    for (let i = 1; i <= 12; i += 1) await finger('touchMove', 180.4 + (61.3 * i) / 12, 420.2 + (37.7 * i) / 12);
    await sleep(250);
    await finger('touchEnd');
    await sleep(900);
    const lap = await phone.evaluate(() => {
      const el = document.querySelector('.map-canvas');
      const tiles = [...el.querySelectorAll('.leaflet-patches-pane canvas.map-dots-tile')].map((c) => ({ r: c.getBoundingClientRect(), w: parseFloat(c.style.width) }));
      const k = tiles.length ? tiles[0].r.width / tiles[0].w : 1; // between whole zooms the tiles are stretched
      const laps = [];
      for (const { r: a } of tiles) for (const { r: b } of tiles) {
        if (Math.abs(b.top - a.top) < 0.5 && Math.abs(b.left - a.left - 256 * k) < 2) laps.push(a.right - b.left);
        if (Math.abs(b.left - a.left) < 0.5 && Math.abs(b.top - a.top - 256 * k) < 2) laps.push(a.bottom - b.top);
      }
      return { view: el.dataset.view, tiles: tiles.length, pairs: laps.length, least: laps.length ? +Math.min(...laps).toFixed(3) : null, needs: +(k / window.devicePixelRatio).toFixed(3), mapAt: el.querySelector('.leaflet-map-pane').style.transform };
    });
    check('…after a finger drag the picture is still one sheet: its tiles lap, no line of map between two', lap.view === 'density' && lap.pairs > 0 && lap.least >= lap.needs - 0.01, JSON.stringify(lap));
    await pctx.close();
  }

  // ══ 7. Layout: the map fills its place, whatever the browser knows ══
  if (want('layout')) {
    // A browser that doesn't know a piece of CSS drops what uses it. Chromium
    // knows :has() and dvh, so that is imitated: those rules (or
    // declarations) are taken out of the stylesheets on their way in.
    const without = (lctx, what) => lctx.route(/\/assets\/[^?]+\.css(\?|$)/, async (route) => {
      const res = await route.fetch();
      const css = await res.text();
      await route.fulfill({
        response: res,
        body: what === 'has' ? css.replace(/(^|[{}])([^{}]*:has\([^{}]*)\{[^{}]*\}/g, '$1') : css.replace(/[\w-]+\s*:[^;{}]*\ddvh[^;{}]*;?/g, ''),
      });
    });
    const boxes = (pg) => pg.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } : null; };
      // Can it be tapped — or is something else (the sidebar) lying over it?
      const reach = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); const el = b && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return Boolean(el && el.closest(s)); };
      return {
        nav: r('.nav'), map: r('.map-page'), zoomBox: r('.leaflet-control-zoom'), add: r('.map-fab--add'),
        pill: reach('.map-filter-btn'), zoom: reach('.leaflet-control-zoom-in'), at: Number(document.querySelector('.map-canvas')?.dataset.zoom),
        scrolls: document.scrollingElement.scrollHeight - window.innerHeight, sideways: document.scrollingElement.scrollWidth - window.innerWidth,
      };
    });
    const openAt = async (w, h, path, strip = null) => {
      const lctx = await context({ viewport: { width: w, height: h }, ...(w <= 720 ? { isMobile: true, hasTouch: true } : {}) });
      if (strip) await without(lctx, strip);
      const pg = await lctx.newPage();
      pg.on('pageerror', (e) => errors.push(`[layout ${w}x${h}] ${e.message}`));
      await pg.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      await pg.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.view, null, { timeout: 12000 }).catch(() => {});
      await sleep(500);
      return { lctx, pg, at: await boxes(pg) };
    };
    const brief = (b) => JSON.stringify({ nav: b.nav && [b.nav.l, b.nav.r], map: b.map && [b.map.l, b.map.t, b.map.w, b.map.h], pill: b.pill, zoom: b.zoom, scrolls: b.scrolls, at: b.at });

    const desk = await openAt(1440, 900, '/admin/map');
    check('a desktop: the map beside the sidebar, the whole height, and no stray strip of page to scroll', desk.at.map.l >= desk.at.nav.r && desk.at.map.w >= 1440 - 232 - 60 && desk.at.map.h >= 800 && desk.at.scrolls <= 0, brief(desk.at));

    // The Show sheet is taller than the map on a laptop: it scrolls inside it.
    const sheetIn = async (pg) => {
      await pg.click('.map-filter-btn');
      await pg.waitForSelector('.map-fsheet');
      return pg.evaluate(() => {
        const sheet = document.querySelector('.map-fsheet');
        const map = document.querySelector('.map-page').getBoundingClientRect();
        const before = sheet.getBoundingClientRect();
        const last = sheet.lastElementChild;
        last.scrollIntoView({ block: 'end' });
        const l = last.getBoundingClientRect();
        const el = document.elementFromPoint(l.left + Math.min(l.width, 40) / 2, l.top + l.height / 2);
        return {
          bottom: Math.round(before.bottom), mapBottom: Math.round(map.bottom), tall: sheet.scrollHeight, shown: sheet.clientHeight,
          lastWords: (last.innerText || '').trim().slice(0, 40), lastReached: Boolean(el && last.contains(el)) && l.bottom <= map.bottom + 1,
          // (Reaching it must scroll the sheet — not the page, and not the map under its own frame.)
          pageScrolled: Math.round(window.scrollY) + Math.round(document.querySelector('.map-page').scrollTop),
        };
      });
    };
    let sh = await sheetIn(desk.pg);
    await desk.pg.screenshot({ path: `${SHOTS}/7-show-sheet-1440x900.png` });
    check('1440×900: the Show sheet ends inside the map, and its last line can be reached', sh.bottom <= sh.mapBottom && sh.lastReached && sh.pageScrolled === 0, JSON.stringify(sh));
    // “Unrated” beside a whole voter list’s count: the word stays in one piece.
    const word = await desk.pg.evaluate(() => {
      const opt = document.querySelector('.map-fsheet .map-fopt[data-band="unrated"]');
      const label = opt.querySelector('.map-fopt__label');
      const n = opt.querySelector('.map-fopt__n');
      n.textContent = '300,049';
      opt.scrollIntoView({ block: 'center' });
      const lines = Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight));
      const [o, nb] = [opt.getBoundingClientRect(), n.getBoundingClientRect()];
      return { label: label.innerText, lines, countInside: nb.right <= o.right + 0.5 && nb.left >= o.left && nb.bottom <= o.bottom + 0.5, height: Math.round(o.height) };
    });
    check('“Unrated” beside “300,049” is one word on one line, the count whole', word.label === 'Unrated' && word.lines === 1 && word.countInside && word.height >= 48, JSON.stringify(word));
    // Each choice's dot stays beside its name, whatever the count beside it
    // ("Strong yes (1)" beside a whole list's 27,282: the dot sat on a line of its own above it).
    const beside = await desk.pg.evaluate(() => [...document.querySelectorAll('.map-fsheet .map-fopt')].map((opt) => {
      const n = opt.querySelector('.map-fopt__n');
      if (n) n.textContent = '27,282';
      const label = opt.querySelector('.map-fopt__label');
      const [d, l] = [opt.querySelector('.map-fopt__dot').getBoundingClientRect(), label.getBoundingClientRect()];
      const mid = d.top + d.height / 2;
      return { label: label.innerText.trim(), beside: mid >= l.top && mid <= l.bottom && d.right <= l.left + 0.5 && l.left - d.right <= 16 };
    }));
    const apart = beside.filter((x) => !x.beside).map((x) => x.label);
    check('each choice’s dot sits beside its name, whatever the count (it sat alone above “Strong yes (1)”)', beside.length >= 8 && apart.length === 0, JSON.stringify({ apart, of: beside.length }));
    await desk.lctx.close();
    const laptop = await openAt(1280, 720, '/admin/map');
    sh = await sheetIn(laptop.pg);
    await laptop.pg.screenshot({ path: `${SHOTS}/7-show-sheet-1280x720.png` });
    check('1280×720: the same — it scrolls inside the map (it was cut off below it)', sh.bottom <= sh.mapBottom && sh.tall > sh.shown && sh.lastReached && sh.pageScrolled === 0, JSON.stringify(sh));
    await laptop.lctx.close();

    // No :has(): the sidebar's room and the map's width come from a class the shell sets.
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      const ref = w === 1440 ? desk.at : (await (async () => { const o = await openAt(w, h, '/admin/map'); await o.lctx.close(); return o.at; })());
      const old = await openAt(w, h, '/admin/map', 'has');
      if (w === 1024) await old.pg.screenshot({ path: `${SHOTS}/7-no-has-1024x768.png` });
      check(`a browser without :has(), ${w}×${h}: the map is where it is everywhere else, nothing under the sidebar`,
        old.at.map.l === ref.map.l && old.at.map.w === ref.map.w && old.at.map.l >= old.at.nav.r && old.at.pill && old.at.zoom, `${brief(old.at)} · with :has(): ${brief(ref)}`);
      await old.lctx.close();
    }
    // No dvh: a vh height comes first, so the map is never 0 px tall.
    const oldPhone = await openAt(390, 844, '/map', 'dvh');
    await oldPhone.pg.screenshot({ path: `${SHOTS}/7-no-dvh-390x844.png` });
    check('a phone browser without dvh: the map still fills the screen (it was 0 px tall)', oldPhone.at.map.h >= 600 && oldPhone.at.map.w === 390, brief(oldPhone.at));
    await oldPhone.lctx.close();
    const oldDesk = await openAt(1440, 900, '/admin/map', 'dvh');
    check('…and on a desktop without it, the whole height', oldDesk.at.map.h === desk.at.map.h, `${oldDesk.at.map.h} px (with dvh: ${desk.at.map.h})`);
    await oldDesk.lctx.close();

    // A phone held sideways: the map fits the window, so nothing has to be scrolled past it.
    const turned = await openAt(844, 390, '/admin/map');
    await turned.pg.screenshot({ path: `${SHOTS}/7-phone-sideways-844x390.png` });
    check('a phone held sideways: no page to scroll, the zoom buttons and “+ Door” on screen',
      turned.at.scrolls <= 0 && turned.at.zoomBox.b <= 390 && turned.at.add.b <= 390 && turned.at.map.h >= 280, `${brief(turned.at)} zoom buttons end ${turned.at.zoomBox.b}, + Door ends ${turned.at.add?.b}`);
    await turned.lctx.close();
  }

  // ══ 8. The street map says when it isn't loading ══
  if (want('tiles')) {
    // Which tile host answers is the test: clean is CARTO (the look the map
    // opens on), base is OpenStreetMap (Standard, Muted, Dark). up 'asked':
    // a flicker — the one tile the map asks for itself (a fetch) gets
    // through, and `through` of the map's own tiles (images), no more (no
    // service worker only: under one, every tile is a fetch). up 'hang':
    // never answered, not refused (weak signal as it usually is) — after
    // `some` more tiles, which come. drop: its next tiles never answer;
    // hold: the rest answer after that long.
    const tiled = async (opts = {}) => {
      const tctx = await context(opts, { tiles: false });
      const net = { up: { clean: true, base: true, own: true }, hold: { clean: 0, base: 0, own: 0 }, asked: { clean: 0, base: 0, own: 0 }, through: { clean: 0, base: 0, own: 0 }, some: { clean: 0, base: 0, own: 0 }, drop: { clean: 0, base: 0, own: 0 } };
      const answer = (who) => async (route) => {
        net.asked[who] += 1;
        if (net.drop[who] > 0) { net.drop[who] -= 1; return; }
        if (net.up[who] === 'hang') {
          if (net.some[who] > 0) { net.some[who] -= 1; await route.fulfill(standIn).catch(() => {}); }
          return;
        }
        if (net.hold[who]) await sleep(net.hold[who]);
        const flicker = net.up[who] === 'asked' && (route.request().resourceType() === 'fetch' || (net.through[who] > 0 && net.through[who]--));
        await (net.up[who] === true || flicker ? route.fulfill(standIn) : route.abort('connectionrefused')).catch(() => {});
      };
      await tctx.route(/basemaps\.cartocdn\.com/, answer('clean'));
      await tctx.route(/tile\.openstreetmap\.org/, answer('base'));
      await tctx.route(/tiles\.example\//, answer('own'));
      const pg = await tctx.newPage();
      pg.on('pageerror', (e) => errors.push(`[tiles] ${e.message}`));
      return { tctx, pg, net };
    };
    const tileState = (pg) => pg.evaluate(() => {
      const el = document.querySelector('.map-canvas');
      const words = (s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() || null;
      return {
        tiles: el?.dataset.tiles || '', look: (document.querySelector('.map-page')?.className.match(/map-view--(\w+)/) || [])[1] || null,
        note: words('.map-tilenote'),
        loaded: el ? [...el.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded')].filter((i) => i.complete && i.naturalWidth > 0).length : 0,
        ground: el ? getComputedStyle(el).backgroundColor : null, pick: localStorage.getItem('starbase:map:view'),
      };
    }).catch(() => ({}));
    // Until fn(state) — and what the line under the count said on the way (the "switched" one goes after a few seconds).
    const tilesUntil = async (pg, fn, ms = 12000) => {
      const end = Date.now() + ms;
      let said = null;
      for (;;) {
        const s = await tileState(pg);
        said = s.note || said;
        if (fn(s) || Date.now() > end) return { ...s, said };
        await sleep(150);
      }
    };

    // The look's own provider refuses: one switch to the other, by itself.
    let t = await tiled();
    t.net.up.clean = false;
    await t.pg.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    let ts = await tilesUntil(t.pg, (s) => /switched to/.test(s.note || '') && s.tiles === 'ok');
    await sleep(600);
    await t.pg.screenshot({ path: `${SHOTS}/8-street-map-switched-by-itself.png` });
    check('the street map’s provider refuses: the map switches to the other one by itself, and says so',
      ts.look === 'muted' && ts.tiles === 'ok' && ts.loaded > 0 && ts.said === 'The street map wasn’t loading — switched to Muted', JSON.stringify(ts));
    check('…the ground behind the tiles is the app’s paper, not Leaflet’s grey; the person’s own choice of look is untouched',
      ts.ground === 'rgb(232, 235, 243)' && ts.pick === null, JSON.stringify({ ground: ts.ground, pick: ts.pick }));
    // The other refuses too: that is the signal, not a provider — back to
    // their own pick by itself (its streets are the ones a phone keeps), and
    // said, with one tap to ask again: not to the other, which has just not
    // answered.
    t.net.up.base = false;
    await t.pg.click('.leaflet-control-zoom-in');
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''));
    await sleep(1200);
    ts = { ...ts, ...(await tileState(t.pg)) };
    await t.pg.screenshot({ path: `${SHOTS}/8-street-map-not-loading.png` });
    check('the other refuses too: back to their own pick by itself, and “The street map isn’t loading” with one tap to try again — not to the other, which has just not answered',
      /^The street map isn’t loading/.test(ts.note || '') && /Try again/.test(ts.note || '') && ts.look === 'clean' && ts.tiles === 'down' && ts.pick === null, JSON.stringify(ts));
    t.net.up.clean = true;
    await t.pg.click('.map-tilenote button');
    ts = await tilesUntil(t.pg, (s) => s.look === 'clean' && s.tiles === 'ok' && !s.note);
    check('one tap: their street map is asked again, it loads and the note goes', ts.look === 'clean' && ts.tiles === 'ok' && ts.loaded > 0 && !ts.note && ts.pick === null, JSON.stringify(ts));
    // Their pick refuses again and the other answers: the map has gone
    // somewhere by itself once already, so the switch is their tap — and the
    // look they tap is theirs once its streets come.
    t.net.up.clean = false;
    t.net.up.base = true;
    await t.pg.click('.leaflet-control-zoom-in');
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''));
    check('their pick refuses again, the other answers: no second switch by itself — one tap to the other', ts.look === 'clean' && /Try Muted/.test(ts.note || ''), JSON.stringify(ts));
    await t.pg.click('.map-tilenote button');
    ts = await tilesUntil(t.pg, (s) => s.look === 'muted' && s.tiles === 'ok' && s.pick === 'muted' && !s.note);
    check('…tapped: its streets come, and that look is their choice from now on', ts.look === 'muted' && ts.tiles === 'ok' && ts.loaded > 0 && !ts.note && ts.pick === 'muted', JSON.stringify(ts));
    // A look tapped whose streets then don't come (a flicker let the map's
    // one tile through, and one of the view's) is not their choice: back to the pick.
    t.net.up.base = false;
    t.net.up.clean = 'asked';
    await t.pg.click('.leaflet-control-zoom-out');
    ts = await tilesUntil(t.pg, (s) => /Try Clean/.test(s.note || ''));
    t.net.through.clean = 1;
    await t.pg.click('.map-tilenote button');
    await sleep(1500);
    ts = await tilesUntil(t.pg, (s) => s.look === 'muted' && /isn’t loading/.test(s.note || ''), 15000);
    check('a look tapped whose streets don’t come after all: back to their pick, which stays their choice',
      ts.look === 'muted' && ts.pick === 'muted' && /isn’t loading/.test(ts.note || ''), JSON.stringify(ts));
    await t.tctx.close();

    // Nothing at all after six seconds (a host that never answers): the same switch.
    t = await tiled();
    t.net.hold.clean = 20000;
    const t0 = Date.now();
    await t.pg.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    ts = await tilesUntil(t.pg, (s) => /switched to Muted/.test(s.note || ''), 14000);
    const took = Date.now() - t0;
    ts = await tilesUntil(t.pg, (s) => s.tiles === 'ok', 6000);
    check('no tile at all after six seconds: the same switch', ts.look === 'muted' && ts.tiles === 'ok' && ts.loaded > 0 && took > 5500 && took < 11000, `${took} ms · ${JSON.stringify(ts)}`);
    await t.tctx.close();

    // A campaign's own provider has no second one: said, with Try again.
    t = await tiled();
    await t.tctx.route('**/api/map/config', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { tiles: { url: 'https://tiles.example/{z}/{x}/{y}.png', attribution: 'Example Tiles', maxZoom: 19 }, setup: { source: 'tiles.example', custom: true, ignored: [], maxZoom: 19 } } });
    });
    t.net.up.own = false;
    await t.pg.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''));
    check('a campaign’s own street map isn’t loading: said, with “Try again” (there is no other provider to switch to)',
      /^The street map isn’t loading/.test(ts.note || '') && /Try again/.test(ts.note || '') && t.net.asked.clean === 0 && t.net.asked.base === 0, JSON.stringify({ ...ts, asked: t.net.asked }));
    t.net.up.own = true;
    await t.pg.click('.map-tilenote button');
    ts = await tilesUntil(t.pg, (s) => s.tiles === 'ok' && !s.note);
    check('…Try again asks for it again, and it loads', ts.tiles === 'ok' && ts.loaded > 0 && !ts.note, JSON.stringify(ts));
    await t.tctx.close();

    // With the service worker in control, a tile that can't be fetched is a
    // failure — it was answered with a blank square and counted as loaded.
    t = await tiled({ serviceWorkers: 'allow' });
    t.net.up.clean = false;
    t.net.up.base = false;
    await t.pg.goto(`${BASE}/admin/`, { waitUntil: 'domcontentloaded' });
    const controlled = await t.pg.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((resolve) => {
      if (navigator.serviceWorker.controller) resolve(true);
      else { navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true)); setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), 8000); }
    }))).catch(() => false);
    await t.pg.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''), 15000);
    await sleep(600);
    await t.pg.screenshot({ path: `${SHOTS}/8-street-map-not-loading-service-worker.png` });
    check('under the service worker a tile that fails is a failure: none “loaded”, and the map says so',
      controlled && ts.loaded === 0 && ts.tiles === 'down' && /^The street map isn’t loading/.test(ts.note || ''), JSON.stringify({ controlled, ...ts }));
    await t.tctx.close();

    // The map's own keys (Shift+arrow, 240 px a press): exact both ways.
    const pan = async (pg, key, times) => {
      await pg.focus('.map-canvas');
      for (let i = 0; i < times; i += 1) {
        const was = await pg.evaluate(() => document.querySelector('.map-canvas').dataset.bounds);
        await pg.keyboard.press(`Shift+${key}`);
        await pg.waitForFunction((b) => document.querySelector('.map-canvas').dataset.bounds !== b, was, { timeout: 3000 }).catch(() => {});
        await sleep(350);
      }
    };

    // In the field, with the service worker keeping the streets looked at:
    // the map opened with signal on Clean (CARTO), its tiles on screen kept.
    const keptStreets = async () => {
      const k = await tiled({ serviceWorkers: 'allow' });
      await k.pg.goto(`${BASE}/admin/`, { waitUntil: 'domcontentloaded' });
      k.ruled = await k.pg.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((resolve) => {
        if (navigator.serviceWorker.controller) resolve(true);
        else { navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true)); setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), 8000); }
      }))).catch(() => false);
      await k.pg.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
      // The street map's tiles on screen: how many, how many drawn, from where.
      k.onScreen = () => k.pg.evaluate(() => {
        const el = document.querySelector('.map-canvas');
        const box = el.getBoundingClientRect();
        const vis = [...el.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')].filter((i) => {
          const r = i.getBoundingClientRect();
          return r.right > box.left + 1 && r.left < box.right - 1 && r.bottom > box.top + 1 && r.top < box.bottom - 1;
        });
        const drawn = vis.filter((i) => i.classList.contains('leaflet-tile-loaded') && i.complete && i.naturalWidth > 0);
        return { n: vis.length, drawn: drawn.length, hosts: [...new Set(vis.map((i) => new URL(i.src).hostname.replace(/^[a-d]\./, '')))] };
      }).catch(() => ({}));
      // Screens away, into streets this browser never looked at, and back.
      k.pan = (key, times) => pan(k.pg, key, times);
      k.kept = {};
      for (let i = 0; i < 40 && !(k.kept.n >= 4 && k.kept.drawn === k.kept.n); i += 1) { await sleep(250); k.kept = await k.onScreen(); }
      await sleep(2500); // (the worker keeps what came)
      return k;
    };
    // Every street kept on screen drawn, from the kept look's provider.
    const allKept = (kept, now) => kept.n >= 4 && now.n === kept.n && now.drawn === now.n && now.hosts.join() === 'basemaps.cartocdn.com';

    // Weak signal: the phone says it is online, but the tile hosts don't
    // answer. The street map the worker kept is the one to keep drawing — no
    // switch to a provider whose streets were never kept, by itself or by
    // the note's one tap: panned away and back, the kept streets draw; with
    // no signal at all, too. (The switch threw them away for the rest of the
    // page's life; so did a tap on "Try Muted", and it was saved as their look.)
    t = await keptStreets();
    const { kept } = t;
    t.net.up.clean = false;
    t.net.up.base = false;
    await t.pan('ArrowRight', 15);
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''), 20000);
    await t.pg.screenshot({ path: `${SHOTS}/8-weak-signal-away.png` });
    check('weak signal (online, the tile hosts not answering): no switch — the other provider doesn’t answer either — and the map says its street map isn’t loading, one tap to try again',
      t.ruled && ts.look === 'clean' && ts.tiles === 'down' && /^The street map isn’t loading/.test(ts.note || '') && /Try again/.test(ts.note || ''), JSON.stringify({ ruled: t.ruled, ...ts }));
    await t.pg.click('.map-tilenote button');
    await sleep(1500);
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''), 15000);
    check('…the tap asks this street map again: still Clean, and nothing saved as their look', ts.look === 'clean' && ts.pick === null && /Try again/.test(ts.note || ''), JSON.stringify(ts));
    await t.pan('ArrowLeft', 15);
    await sleep(3000);
    const back = await t.onScreen();
    ts = await tileState(t.pg);
    await t.pg.screenshot({ path: `${SHOTS}/8-weak-signal-back.png` });
    check('…back over the streets this browser kept, every tile on screen draws (the switch had thrown them away)',
      allKept(kept, back) && ts.look === 'clean', JSON.stringify({ kept, back, look: ts.look, note: ts.note }));
    await t.tctx.setOffline(true);
    await t.pan('ArrowRight', 1);
    await t.pan('ArrowLeft', 1);
    await sleep(2000);
    const off = await t.onScreen();
    await t.pg.screenshot({ path: `${SHOTS}/8-weak-signal-offline.png` });
    check('…and with no signal at all, still every one', allKept(kept, off), JSON.stringify(off));
    await t.tctx.close();

    // A flicker: while the map pans into new streets its own provider's
    // tiles fail, but the one tile it asks of the other gets through — so it
    // goes there by itself. With no signal the person's pick is drawn (its
    // streets are the ones this browser kept); signal back with their pick
    // still refusing, the one that answers; and when the signal goes weak
    // there too, back to the pick by itself, the kept streets drawn.
    t = await keptStreets();
    const keptF = t.kept;
    t.net.up.clean = false;
    await t.pan('ArrowRight', 15);
    // (Its "switched" line, said for eight seconds from the first press, may be gone by the last.)
    ts = await tilesUntil(t.pg, (s) => s.look === 'muted' && s.tiles === 'ok', 20000);
    check('a flicker (the look’s own tiles fail, the other provider’s one tile gets through): it goes there by itself',
      ts.look === 'muted' && ts.tiles === 'ok' && ts.pick === null, JSON.stringify(ts));
    await t.tctx.setOffline(true);
    await t.pan('ArrowLeft', 15);
    await sleep(2500);
    const offF = await t.onScreen();
    ts = await tileState(t.pg);
    await t.pg.screenshot({ path: `${SHOTS}/8-flicker-offline.png` });
    check('…no signal: their own pick is drawn, and every street this browser kept with it', ts.look === 'clean' && allKept(keptF, offF), JSON.stringify({ look: ts.look, kept: keptF, off: offF }));
    await t.tctx.setOffline(false);
    ts = await tilesUntil(t.pg, (s) => s.look === 'muted' && s.tiles === 'ok', 12000);
    check('…signal back, their pick still refusing: the street map that answers', ts.look === 'muted' && ts.tiles === 'ok', JSON.stringify(ts));
    t.net.up.base = false;
    await t.pan('ArrowUp', 15);
    ts = await tilesUntil(t.pg, (s) => s.look === 'clean' && /isn’t loading/.test(s.note || ''), 20000);
    check('…then weak signal there too: back to their pick by itself, “The street map isn’t loading”, one tap to try again',
      ts.look === 'clean' && /Try again/.test(ts.note || '') && ts.pick === null, JSON.stringify(ts));
    await t.pan('ArrowDown', 15);
    await sleep(3000);
    const backF = await t.onScreen();
    await t.pg.screenshot({ path: `${SHOTS}/8-flicker-back.png` });
    check('…back over the streets this browser kept, every tile draws', allKept(keptF, backF), JSON.stringify({ kept: keptF, back: backF }));
    await t.tctx.close();

    // Weak signal as it usually is — tiles that never answer, not refusals —
    // and it goes while a view is loading: three of its tiles come, the rest
    // never do. One tile that never answers keeps Leaflet's go of asking
    // open, and the six-second look was that go's: six seconds in some had
    // come and none had failed, and the views moved to after that had no look
    // at all — blank streets, and the map said nothing. Back over the
    // streets this browser kept, they are drawn and the note goes by itself.
    t = await keptStreets();
    const keptG = t.kept;
    t.net.up.clean = 'hang';
    t.net.some.clean = 3;
    t.net.up.base = 'hang';
    await t.pan('ArrowRight', 4);
    await sleep(7500);
    const part = await tileState(t.pg);
    await t.pan('ArrowRight', 12);
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''), 20000);
    await t.pg.screenshot({ path: `${SHOTS}/8-never-answers-new-streets.png` });
    check('the signal goes while a view is loading (three of its tiles come, the rest never answer), then new streets where nothing answers: the map says its street map isn’t loading, one tap to try again',
      part.tiles === 'ok' && !part.note && ts.look === 'clean' && ts.tiles === 'down' && /^The street map isn’t loading/.test(ts.note || '') && /Try again/.test(ts.note || '') && ts.pick === null,
      JSON.stringify({ part: { tiles: part.tiles, note: part.note }, ...ts, asked: t.net.asked }));
    await t.pan('ArrowLeft', 16);
    ts = await tilesUntil(t.pg, (s) => !s.note && s.tiles === 'ok', 15000);
    const backG = await t.onScreen();
    await t.pg.screenshot({ path: `${SHOTS}/8-never-answers-kept.png` });
    check('…back over the streets this browser kept (nothing answering still): every one drawn, and the note goes by itself',
      allKept(keptG, backG) && ts.look === 'clean' && ts.tiles === 'ok' && !ts.note && ts.pick === null, JSON.stringify({ kept: keptG, back: backG, look: ts.look, tiles: ts.tiles, note: ts.note }));
    await t.tctx.close();

    // The same after a switch by itself, with tiles that never answer: the
    // look's own provider stops answering and the one tile asked of the other
    // comes, so the map goes there; a few of its tiles come, then nothing
    // answers any more. Back over the streets this browser kept — by another
    // way, so none of that look's own kept tiles come on the way and end the
    // go of asking — it is back on their pick by itself and they draw (it
    // stayed on the other, blank, until the phone went offline).
    t = await keptStreets();
    const keptH = t.kept;
    t.net.up.clean = 'hang';
    await t.pan('ArrowRight', 15);
    const went = await tilesUntil(t.pg, (s) => s.look === 'muted' && s.tiles === 'ok', 25000);
    t.net.up.base = 'hang';
    t.net.some.base = 4;
    await t.pan('ArrowDown', 6);
    await sleep(1000);
    await t.pan('ArrowLeft', 15);
    await t.pan('ArrowUp', 6);
    ts = await tilesUntil(t.pg, (s) => s.look === 'clean', 20000);
    await sleep(3000);
    const backH = await t.onScreen();
    ts = { ...ts, ...(await tileState(t.pg)) };
    await t.pg.screenshot({ path: `${SHOTS}/8-never-answers-back.png` });
    check('…after a switch by itself, the same there (a few tiles come, then nothing answers): back over the streets this browser kept, their pick again by itself, every tile drawn and no note',
      went.look === 'muted' && ts.look === 'clean' && allKept(keptH, backH) && !ts.note && ts.pick === null,
      JSON.stringify({ went: went.look, look: ts.look, note: ts.note, kept: keptH, back: backH }));
    await t.tctx.close();

    // A slow signal: new streets, six seconds and not one tile — said —
    // then they come, all but one that never answers (so the view is never
    // "done"). The note goes by itself (it stood over streets drawn until
    // the map was next moved to a whole new view).
    t = await keptStreets();
    t.net.up.base = 'hang';
    t.net.hold.clean = 14000;
    t.net.drop.clean = 1;
    await t.pan('ArrowRight', 6);
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''), 14000);
    const slowSaid = ts.note;
    ts = await tilesUntil(t.pg, (s) => !s.note && s.tiles === 'ok', 16000);
    // (It goes once most of the screen is drawn; the last of them a moment after.)
    await sleep(5000);
    ts = { ...ts, ...(await tileState(t.pg)) };
    const slowOn = await t.onScreen();
    await t.pg.screenshot({ path: `${SHOTS}/8-slow-signal-came.png` });
    check('a slow signal (six seconds and not one tile of the new streets, then they come, all but one that never answers): said — and the note goes by itself over the streets drawn',
      /^The street map isn’t loading/.test(slowSaid || '') && !ts.note && ts.tiles === 'ok' && ts.look === 'clean' && slowOn.n >= 4 && slowOn.drawn >= slowOn.n - 1 && ts.pick === null,
      JSON.stringify({ said: slowSaid, note: ts.note, tiles: ts.tiles, look: ts.look, on: slowOn }));
    await t.tctx.close();

    // An earlier tile still out, then nothing answers and the map is zoomed
    // in: the zoom before's streets, stretched under the ones on their way,
    // are not this view's (they counted as streets drawn, and blurred
    // streets stood there with nothing said).
    t = await keptStreets();
    t.net.up.base = 'hang';
    t.net.drop.clean = 1;
    await t.pan('ArrowRight', 6);
    await sleep(2500);
    const partZ = await tileState(t.pg);
    t.net.up.clean = 'hang';
    for (let i = 0; i < 2; i += 1) { await t.pg.click('.leaflet-control-zoom-in'); await sleep(900); }
    ts = await tilesUntil(t.pg, (s) => /isn’t loading/.test(s.note || ''), 20000);
    await t.pg.screenshot({ path: `${SHOTS}/8-never-answers-zoomed-in.png` });
    check('an earlier tile still out, then nothing answers and the map is zoomed in: the stretched streets of the zoom before are not this view’s — the map says its street map isn’t loading, one tap to try again',
      partZ.tiles === 'ok' && !partZ.note && ts.look === 'clean' && ts.tiles === 'down' && /^The street map isn’t loading/.test(ts.note || '') && /Try again/.test(ts.note || '') && ts.pick === null,
      JSON.stringify({ part: { tiles: partZ.tiles, note: partZ.note }, ...ts }));
    await t.tctx.close();

    // A switch made by itself lasts while the signal does: when signal comes
    // back, the person's own pick is asked first — still refusing, the map
    // stays on the one that answers (no flip back and forth); answering, it
    // goes back to their pick.
    t = await tiled();
    t.net.up.clean = false;
    await t.pg.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    ts = await tilesUntil(t.pg, (s) => s.look === 'muted' && s.tiles === 'ok');
    const noSignalFor = async (ms) => { await t.tctx.setOffline(true); await sleep(ms); await t.tctx.setOffline(false); };
    await noSignalFor(800);
    ts = await tilesUntil(t.pg, () => false, 5000);
    check('signal back while their own pick’s provider still refuses: the map stays on the street map that answers',
      ts.look === 'muted' && ts.tiles === 'ok' && !/isn’t loading/.test(ts.said || ''), JSON.stringify(ts));
    t.net.up.clean = true;
    await noSignalFor(800);
    // (Their pick is drawn while it is asked: past the ask, it must still be.)
    ts = await tilesUntil(t.pg, (s) => s.look === 'clean' && s.tiles === 'ok' && s.loaded > 0);
    await sleep(5000);
    ts = { ...ts, ...(await tileState(t.pg)) };
    check('…and once it answers: back to their own pick, Clean, by itself', ts.look === 'clean' && ts.tiles === 'ok' && ts.loaded > 0 && ts.pick === null && !ts.note, JSON.stringify(ts));
    await t.tctx.close();

    // …nor does the map wait for the signal to drop: on the street map it
    // went to by itself, their pick is asked again every minute.
    t = await tiled();
    await t.tctx.clock.install();
    t.net.up.clean = false;
    await t.pg.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    ts = await tilesUntil(t.pg, (s) => s.look === 'muted' && s.tiles === 'ok');
    t.net.up.clean = true;
    await t.pg.clock.fastForward(30_000);
    const halfway = (await tilesUntil(t.pg, () => false, 1500)).look;
    await t.pg.clock.fastForward(31_000);
    ts = await tilesUntil(t.pg, (s) => s.look === 'clean' && s.tiles === 'ok' && s.loaded > 0, 10000);
    check('on the street map it went to by itself, their pick is asked again every minute: answering, back to it',
      halfway === 'muted' && ts.look === 'clean' && ts.tiles === 'ok' && ts.loaded > 0 && ts.pick === null && !ts.note, JSON.stringify({ halfway, ...ts }));
    await t.tctx.close();
  }

  // ══ 9. Turfs don't hold the map up ══
  if (want('turfs')) {
    // The block (64 doors), the busy row (36 doors, two people each, five of them knocked) and a field with nobody in it.
    const ring = (s, w, n, e) => [[s, w], [s, e], [n, e], [n, w]];
    const [block, busy, field] = [
      (await post('/actions/turf.create', { name: 'The block', polygon: ring(49.1298, -122.8503, 49.132, -122.8469) })).turf,
      (await post('/actions/turf.create', { name: 'Busy row', polygon: ring(49.13395, -122.85005, 49.1347, -122.8491) })).turf,
      (await post('/actions/turf.create', { name: 'Empty field', polygon: ring(49.2, -122.75, 49.205, -122.745) })).turf,
    ];
    const tp = await ctx.newPage();
    tp.on('pageerror', (e) => errors.push(`[turfs] ${e.message}`));
    const turfAsks = [];
    tp.on('request', (r) => { if (/\/api\/turfs/.test(r.url())) turfAsks.push(r.url().replace(/^.*\/api/, '')); });
    await tp.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    await tp.waitForFunction(() => document.querySelectorAll('.map-canvas path.map-turf').length >= 2, null, { timeout: 12000 }).catch(() => {});
    const outlines = await tp.locator('.map-canvas path.map-turf').count();
    check('the map asks for turfs as outlines — names and shapes, nobody inside read — and draws them',
      turfAsks.includes('/turfs?outline=1') && !turfAsks.includes('/turfs') && outlines >= 2, `${turfAsks.join(' ')} · ${outlines} outlines`);

    // A turf's counts come when its sheet opens.
    const sheet = () => tp.evaluate(() => {
      const words = (s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() || null;
      return { title: words('.turf-sheet .mapsheet-title'), progress: words('.turf-progress__text'), retry: words('.turf-retry'), walk: Boolean(document.querySelector('.turf-sheet a.btn-primary')) };
    });
    const sheetUntil = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      let s = await sheet();
      while (!fn(s) && Date.now() < end) { await sleep(120); s = await sheet(); }
      return s;
    };
    const counted = async (t) => (await (await ctx.request.get(`${BASE}/api/turfs/${t.id}`)).json()).turf;
    const leftIn = (t) => `${t.doors - t.doorsDone} doors left`;
    const truth = await counted(block);
    const busyTruth = await counted(busy);
    await tp.route(`**/api/turfs/${block.id}`, async (route) => { await sleep(2500); await route.continue().catch(() => {}); });
    await tp.goto(`${BASE}/admin/map?turf=${block.id}`, { waitUntil: 'domcontentloaded' });
    let ss = await sheetUntil((s) => s.title);
    await sleep(400);
    ss = await sheet();
    check('a turf’s sheet opens at once: its name, the walk list, and “Loading…” where its counts go — never “No doors” on the way',
      ss.title === 'The block' && ss.walk && ss.progress === 'Loading…', JSON.stringify(ss));
    ss = await sheetUntil((s) => /left|done|No doors/.test(s.progress || ''));
    await tp.screenshot({ path: `${SHOTS}/9-turf-sheet-counts.png` });
    check('…then the server’s own counts', truth.doors === 64 && ss.progress === leftIn(truth), `${ss.progress} (server: ${truth.doors} doors, ${truth.doorsDone} done, ${truth.people} people)`);
    await tp.unroute(`**/api/turfs/${block.id}`);
    // No answer: said, with a way to try again.
    await tp.route(`**/api/turfs/${busy.id}`, (route) => route.abort('failed'));
    await tp.goto(`${BASE}/admin/map?turf=${busy.id}`, { waitUntil: 'domcontentloaded' });
    ss = await sheetUntil((s) => s.retry, 15000);
    check('no answer for a turf’s counts: “Unavailable — Try again”, never a 0', /Unavailable — Try again/.test(ss.retry || '') && !/\b0\b|No doors/.test(ss.progress || ''), JSON.stringify(ss));
    await tp.unroute(`**/api/turfs/${busy.id}`);
    await tp.click('.turf-retry');
    ss = await sheetUntil((s) => /left/.test(s.progress || ''));
    check('…Try again brings them', busyTruth.doors === 36 && ss.progress === leftIn(busyTruth) && !ss.retry, `${JSON.stringify(ss)} (server: ${busyTruth.doors} doors, ${busyTruth.doorsDone} done)`);
    await tp.goto(`${BASE}/admin/map?turf=${field.id}`, { waitUntil: 'domcontentloaded' });
    ss = await sheetUntil((s) => /No doors/.test(s.progress || ''));
    check('a turf with nobody in it says “No doors” — once the server has said so', ss.progress === 'No doors', JSON.stringify(ss));
    await tp.close();
  }

  // ══ 10. People get onto the map by themselves ══
  if (want('placing')) {
    const status = async () => (await ctx.request.get(`${BASE}/api/geocode/status`)).json();
    const mp = await ctx.newPage();
    mp.on('pageerror', (e) => errors.push(`[placing] ${e.message}`));
    const chip = () => mp.evaluate(() => document.querySelector('.map-unloc__chip')?.innerText.replace(/\s+/g, ' ').trim() || null).catch(() => null);
    const pillNumber = () => mp.evaluate(() => Number((/([\d,]+)\s+people/.exec(document.querySelector('.map-filter-btn')?.innerText || '') || [])[1]?.replace(/,/g, '') ?? NaN)).catch(() => NaN);
    const onMap = async () => (await (await ctx.request.get(`${BASE}/api/map/check`)).json()).people;
    const before = await onMap();

    // An import of 260 people at 260 addresses, none with a pin — three rounds of lookups.
    geo.mode = 'ok';
    geo.ms = 200;
    const imp = await post('/data/import', { rows: Array.from({ length: 260 }, (_, i) => ({ name: `Placing ${i} Example`, address: `${400 + i} Placing Way`, city: 'Surrey' })) });
    const st0 = await status();
    check('an import that leaves addresses without a pin starts the placing run by itself', imp.created === 260 && st0.state === 'running', JSON.stringify({ created: imp.created, state: st0.state, remaining: st0.remaining }));
    // The map, opened after it: the run's progress, without opening anything.
    await mp.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    const said = new Set();
    for (const end = Date.now() + 40000; Date.now() < end;) {
      const c = await chip();
      if (c) said.add(c);
      if (said.size && !c && (await status()).state === 'done') break;
      await sleep(250);
    }
    const counts = [...said].map((c) => /^Placing addresses · ([\d,]+) of 260$/.exec(c)?.[1]).filter(Boolean).map(Number);
    check('the map shows the run’s progress without opening anything: “Placing addresses · N of 260”, N moving',
      counts.length >= 1 && counts.some((n) => n > 0 && n < 260), [...said].join(' | '));
    const after = await onMap();
    await mp.waitForFunction((n) => new RegExp(`${n} people`).test(document.querySelector('.map-filter-btn')?.innerText || ''), before.onMap + 260 - 2, { timeout: 15000 }).catch(() => {});
    await mp.screenshot({ path: `${SHOTS}/10-placed-by-itself.png` });
    check('when it is done they are on the map (the two filed in another city aside), and the note is gone',
      after.onMap === before.onMap + 260 && after.waiting === 0 && (await chip()) === null && (await pillNumber()) === after.onMap - 2, JSON.stringify({ before, after, chip: await chip(), pill: await pillNumber() }));

    // Lookups stop answering: the run pauses, says when it tries again — and does, with nobody tapping.
    geo.mode = 'down';
    geo.ms = 10;
    await post('/data/import', { rows: Array.from({ length: 6 }, (_, i) => ({ name: `Later ${i} Example`, address: `${900 + i} Placing Way`, city: 'Surrey' })) });
    for (const end = Date.now() + 15000; Date.now() < end && (await status()).state !== 'paused';) await sleep(150);
    const paused = await status();
    await mp.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('.map-unloc__chip', { timeout: 10000 }).catch(() => {});
    const pausedChip = await chip();
    await mp.click('.map-unloc__chip').catch(() => {});
    await sleep(500);
    const panel = await mp.evaluate(() => document.querySelector('.map-unloc')?.innerText.replace(/\s+/g, ' ').trim() || '');
    await mp.screenshot({ path: `${SHOTS}/10-placing-paused.png` });
    check('lookups not answering: the run pauses, and the map says so and when it tries again',
      paused.state === 'paused' && Boolean(paused.retryAt) && /^Placing addresses paused/.test(pausedChip || '') && /isn’t answering/.test(panel) && /tries again/.test(panel), JSON.stringify({ state: paused.state, retryAt: paused.retryAt, chip: pausedChip, panel: panel.slice(0, 200) }));
    geo.mode = 'ok';
    for (const end = Date.now() + 25000; Date.now() < end && (await status()).state !== 'done';) await sleep(250);
    const resumed = await status();
    for (const end = Date.now() + 15000; Date.now() < end && (await chip()) !== null;) await sleep(250);
    check('…and it does, by itself: nobody tapped Carry on, everyone is placed, the note is gone',
      resumed.state === 'done' && resumed.remaining === 0 && (await onMap()).waiting === 0 && (await chip()) === null, JSON.stringify({ state: resumed.state, remaining: resumed.remaining, chip: await chip() }));

    // A whole voter file's counts wear their separators.
    await mp.route('**/api/geocode/status', (route) => route.fulfill({ json: { state: 'running', located: 12000, copied: 400, missed: 0, errors: 0, lastError: null, retryAt: null, remaining: 137600, unmatched: 0, jobs: true } }));
    await mp.route(/\/api\/map\/doors$/, async (route) => { const res = await route.fetch(); await route.fulfill({ response: res, json: { ...(await res.json()), unlocated: 137600 } }); });
    await mp.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    await mp.waitForFunction(() => /150,000/.test(document.querySelector('.map-unloc__chip')?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
    const big1 = await chip();
    await mp.unroute('**/api/geocode/status');
    await mp.route('**/api/geocode/status', (route) => route.fulfill({ json: { state: 'stopped', located: 12000, copied: 400, missed: 0, errors: 0, lastError: null, retryAt: null, remaining: 277625, unmatched: 0, jobs: true } }));
    await mp.unroute(/\/api\/map\/doors$/);
    await mp.route(/\/api\/map\/doors$/, async (route) => { const res = await route.fetch(); await route.fulfill({ response: res, json: { ...(await res.json()), unlocated: 277625 } }); });
    await mp.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    // (The map opens on the copy this browser kept — the count before — and then the server's.)
    await mp.waitForFunction(() => /Not on map 277/.test(document.querySelector('.map-unloc__chip')?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
    const big2 = await chip();
    check('counts wear their separators: “Placing addresses · 12,400 of 150,000”, “Not on map 277,625”',
      big1 === 'Placing addresses · 12,400 of 150,000' && big2 === 'Not on map 277,625', `${big1} | ${big2}`);
    await mp.close();
  }

  // ══ 11. The map's check, for managers ══
  if (want('check')) {
    const fmt = (n) => Number(n).toLocaleString('en-CA');
    const openCheck = async (pg) => {
      await pg.click('.map-filter-btn');
      await pg.waitForSelector('.map-fsheet');
      await pg.click('.map-fsheet__check');
      await pg.waitForSelector('.map-check .map-check__row', { timeout: 10000 });
      await sleep(400);
      const rows = await pg.$$eval('.map-check .map-check__row', (els) => els.map((r) => ({
        key: r.dataset.key, label: r.querySelector('dt')?.innerText.trim(), value: r.querySelector('dd')?.innerText.replace(/\s+/g, ' ').trim(), warn: r.classList.contains('is-warn'),
      })));
      return Object.fromEntries(rows.map((r) => [r.key, r]));
    };
    const cp = await ctx.newPage();
    cp.on('pageerror', (e) => errors.push(`[check] ${e.message}`));
    await cp.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    await cp.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.tiles === 'ok', null, { timeout: 12000 }).catch(() => {});
    const truth = await (await ctx.request.get(`${BASE}/api/map/check`)).json();
    let lines = await openCheck(cp);
    await cp.screenshot({ path: `${SHOTS}/11-map-check-1440.png` });
    const v = (k) => lines[k]?.value || '';
    check('Map check: the people on file, on the map and not on it, as the server counts them',
      v('file') === fmt(truth.people.total) && v('onmap') === fmt(truth.people.onMap) && v('offmap').startsWith(fmt(truth.people.waiting + truth.people.noAddress)), JSON.stringify({ file: v('file'), onmap: v('onmap'), offmap: v('offmap'), truth: truth.people }));
    check('…how many live outside the campaign’s area, the turfs, the placing run',
      v('area').startsWith(`${fmt(truth.area.outside)} `) && truth.area.outside === 2 && v('turfs') === fmt(truth.turfs) && Boolean(v('placing')), JSON.stringify({ area: v('area'), turfs: v('turfs'), placing: v('placing') }));
    check('…the street map in use and that its tiles came; this page against the server’s build; the map’s size on screen',
      /^Clean/.test(v('tiles')) && /[1-9]\d* loaded/.test(v('tiles')) && /0 failed/.test(v('tiles')) && v('build') === 'Up to date' && /^\d[\d,]* × \d+ px/.test(v('screen')), JSON.stringify({ tiles: v('tiles'), build: v('build'), screen: v('screen') }));
    check('…with nothing flagged when nothing is wrong', Object.values(lines).every((l) => !l.warn), Object.values(lines).filter((l) => l.warn).map((l) => `${l.label}: ${l.value}`).join(' | '));
    await cp.close();

    // Each trouble is flagged in its own line — one screenshot says which.
    const bad = await context({}, { tiles: false });
    await bad.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => route.abort('connectionrefused'));
    // (retryAt: when the paused run tries again — in a while, or long gone by.)
    const troubles = (retryIn) => async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: {
        ...body,
        people: { total: 300052, onMap: 22424, waiting: 277625, noAddress: 3 },
        area: { ...body.area, inside: 22422, outside: 2 },
        placing: { ...body.placing, state: 'paused', located: 22000, copied: 424, missed: 0, remaining: 277625, lastError: 'geocoder 503', retryAt: new Date(Date.now() + retryIn).toISOString() },
        build: 'index-NEWER000.js',
      } });
    };
    await bad.route('**/api/map/check', troubles(15 * 60000));
    const bp = await bad.newPage();
    bp.on('pageerror', (e) => errors.push(`[check troubles] ${e.message}`));
    await bp.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
    await bp.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.tiles === 'down' && /isn’t loading/.test(document.querySelector('.map-tilenote')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
    lines = await openCheck(bp);
    await bp.screenshot({ path: `${SHOTS}/11-map-check-troubles-1440.png` });
    const flagged = Object.values(lines).filter((l) => l.warn).map((l) => l.key).sort().join(',');
    check('troubles are flagged line by line: people waiting for a pin, a paused placing run, a street map that isn’t loading, an older page',
      flagged === 'build,offmap,placing,tiles' && /277,628/.test(lines.offmap.value) && /Paused/.test(lines.placing.value) && /tries again/.test(lines.placing.value)
        && /isn’t loading/.test(lines.tiles.value) && /older than the server/i.test(lines.build.value), JSON.stringify(Object.values(lines).map((l) => `${l.warn ? '!' : ' '}${l.label}: ${l.value}`)));
    // On a phone one screenshot must show them too: the flagged lines first,
    // each whole on screen with nothing scrolled (the last lines were a scroll
    // away). And a paused run long past its time to try again says its try
    // was due then — not "tries again at" a time gone by.
    await bp.keyboard.press('Escape');
    await bad.unroute('**/api/map/check');
    await bad.route('**/api/map/check', troubles(-2 * 3600_000));
    await bp.setViewportSize({ width: 390, height: 844 });
    await sleep(400);
    lines = await openCheck(bp);
    await bp.screenshot({ path: `${SHOTS}/11-map-check-troubles-390.png` });
    const seen = await bp.evaluate(() => {
      const sheet = document.querySelector('.map-check');
      const box = sheet.getBoundingClientRect();
      const rows = [...sheet.querySelectorAll('.map-check__row')];
      const firstCalm = rows.findIndex((r) => !r.classList.contains('is-warn'));
      return {
        scrolled: sheet.scrollTop, top: Math.round(box.top), bottom: Math.round(box.bottom), shown: sheet.clientHeight, tall: sheet.scrollHeight,
        flaggedFirst: rows.every((r, i) => r.classList.contains('is-warn') === (firstCalm < 0 || i < firstCalm)),
        flaggedInView: rows.filter((r) => r.classList.contains('is-warn')).every((r) => { const b = r.getBoundingClientRect(); return b.top >= box.top && b.bottom <= box.bottom + 0.5; }),
      };
    });
    check('…and on a phone one screenshot shows them all: the flagged lines first, each on screen with nothing scrolled',
      Object.values(lines).filter((l) => l.warn).length === 4 && seen.scrolled === 0 && seen.flaggedFirst && seen.flaggedInView, JSON.stringify(seen));
    check('…a paused run long past its time says its try was due then, not that it “tries again” at a time gone by',
      /^Paused — was due to try again at \d{1,2}:\d\d [ap]m$/.test(lines.placing.value), lines.placing.value);
    await bad.close();

    // On a phone, in the field app (a manager is shown a volunteer's screens there; the check is still theirs).
    const pc = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pp = await pc.newPage();
    pp.on('pageerror', (e) => errors.push(`[check phone] ${e.message}`));
    await pp.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
    await pp.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.view, null, { timeout: 12000 }).catch(() => {});
    lines = await openCheck(pp);
    await pp.screenshot({ path: `${SHOTS}/11-map-check-390.png` });
    const fit = await pp.evaluate(() => {
      const r = document.querySelector('.map-check').getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), sideways: document.documentElement.scrollWidth - window.innerWidth, close: Math.round(document.querySelector('.map-check .mapsheet-close').getBoundingClientRect().height) };
    });
    check('on a phone: the same lines, nothing scrolls sideways, a full-size ✕', Object.keys(lines).length >= 8 && fit.left >= 0 && fit.right <= 390 && fit.sideways <= 0 && fit.close >= 48, JSON.stringify({ lines: Object.keys(lines), ...fit }));
    const allIn = await pp.evaluate(() => { const s = document.querySelector('.map-check'); return { tall: s.scrollHeight, shown: s.clientHeight }; });
    check('…every line of it on the screen at once, “Checked” and all (one screenshot)', allIn.tall <= allIn.shown + 1, JSON.stringify(allIn));
    await pc.close();
  }

  // ══ 12. The doors a phone kept, and no answer ══
  if (want('kept')) {
    // A phone that has lost its signal reopens the map from what it kept: one
    // line along the bottom says so — clear of the zoom buttons and the
    // buttons in the corner ("My turf", "Whole list", Locate me, "+ Door"),
    // each still a tap away (it lay over "−" and "My turf"). On "My turf" a
    // volunteer sees their own doors, whole: the list's answers for the view
    // aren't drawn there, so their not coming is no "Unavailable". And the
    // line is said only over doors in fact drawn: a big list's doors come by
    // the view, a manager's phone keeps none, and there "Unavailable — Try
    // again" says it alone (the line stood over an empty map).
    const ring = (s, w, n, e) => [[s, w], [s, e], [n, e], [n, w]];
    const turf = (await post('/actions/turf.create', { name: 'Kept block', polygon: ring(49.1298, -122.8503, 49.132, -122.8469) })).turf;
    const invite = await post('/actions/member.invite', { email: `walker+${Date.now().toString(36)}@example.org`, role: 'volunteer' });
    // The map's reads, unanswered (no signal, and the phone doesn't know it).
    const noAnswer = (c) => c.route(/\/api\/map\/(doors|density)/, (route) => route.abort('internetdisconnected'));
    // …or refused by the server, which the same line says in the server's words.
    const REFUSAL = 'The list isn’t answering — try again in a minute';
    const refused = (c) => c.route(/\/api\/map\/(doors|density)/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: REFUSAL }) }));
    const corners = (pg) => pg.evaluate(() => {
      const rect = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const line = document.querySelector('.error.map-error');
      const n = line && rect(line);
      const buttons = [...document.querySelectorAll('.leaflet-control-zoom a, .map-fabs button')].map((btn) => {
        const b = rect(btn);
        const hit = document.elementFromPoint((b.l + b.r) / 2, (b.t + b.b) / 2);
        return {
          name: (btn.getAttribute('aria-label') || btn.title || btn.innerText || '').trim(),
          under: Boolean(n && b.l < n.r && n.l < b.r && b.t < n.b && n.t < b.b),
          tap: Boolean(hit && (hit === btn || btn.contains(hit))),
        };
      });
      const words = (s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() || null;
      // (A tap on the line itself reaches what is under it: a door.)
      const mid = n && document.elementFromPoint((n.l + n.r) / 2, (n.t + n.b) / 2);
      const sheet = document.querySelector('.map-sheet');
      const s = sheet && rect(sheet);
      return {
        note: words('.error.map-error'), retry: words('.map-retry'), pill: words('.map-filter-btn'), through: Boolean(mid && !mid.closest('.error.map-error')),
        doors: Number(document.querySelector('.map-canvas')?.dataset.doors),
        sheet: s ? words('.map-sheet .mapsheet-title') : null, underSheet: Boolean(n && s && s.l < n.r && n.l < s.r && s.t < n.b && n.t < s.b), buttons,
      };
    });
    const blocked = (k) => k.buttons.filter((b) => b.under || !b.tap).map((b) => b.name);
    // Opened with signal (the phone keeps the doors), then again with none.
    const keptThenNone = async (c, pg, path, { none = noAnswer, says = '.error.map-error' } = {}) => {
      await pg.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      await pg.waitForFunction(() => Object.keys(localStorage).some((k) => k.endsWith(':doors')), null, { timeout: 15000 }).catch(() => {});
      await none(c);
      await pg.reload({ waitUntil: 'domcontentloaded' });
      await pg.waitForSelector(says, { timeout: 15000 }).catch(() => {});
      await sleep(1000);
      return corners(pg);
    };

    // A volunteer, on a phone, on their turf.
    const vc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', serviceWorkers: 'block' });
    await vc.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => route.fulfill(standIn));
    const joined = await vc.request.post(`${BASE}/api/auth/join`, { data: { token: invite.joinUrl.split('/').pop(), name: 'Walker Example', password: 'knock-knock-2026' } });
    if (!joined.ok()) throw new Error(`join ${joined.status()} ${await joined.text()}`);
    await post('/actions/turf.assign', { turf_id: turf.id, user_id: (await joined.json()).user.id });
    const vp = await vc.newPage();
    vp.on('pageerror', (e) => errors.push(`[kept] ${e.message}`));
    let k = await keptThenNone(vc, vp, '/map');
    await vp.screenshot({ path: `${SHOTS}/12-kept-my-turf-390x844.png` });
    check('a volunteer’s phone reopened with no answer, on their turf: one line says it shows the doors it kept — clear of the zoom buttons and “My turf”, each still a tap away',
      k.note === 'No signal — showing the doors already loaded' && /My turf/.test(k.pill || '') && k.buttons.some((b) => b.name === 'My turf') && blocked(k).length === 0,
      JSON.stringify({ ...k, blocked: blocked(k) }));
    check('…a tap on the line reaches the door under it', k.through, JSON.stringify({ through: k.through }));
    check('…and on “My turf” (their own doors, whole) no “Unavailable — Try again” for the list’s answers, which aren’t drawn there', k.retry === null, JSON.stringify({ retry: k.retry, pill: k.pill }));
    // On "All" those answers are the map: their not coming is said.
    await vp.goto(`${BASE}/map?show=all`, { waitUntil: 'domcontentloaded' });
    await vp.waitForSelector('.map-retry', { timeout: 15000 }).catch(() => {});
    k = await corners(vp);
    check('…on “All” they are the map: “Unavailable — Try again” (and their own doors, kept, still drawn and said)',
      k.retry === 'Unavailable — Try again' && /^Show: All/.test(k.pill || '') && k.doors > 0 && k.note === 'No signal — showing the doors already loaded', JSON.stringify({ retry: k.retry, pill: k.pill, doors: k.doors, note: k.note }));
    await vc.close();

    // A manager in the field app on a phone ("Whole list", Locate me), and at a desk (and "+ Door").
    // No answer: a big list keeps no doors on a manager's phone, so no line
    // says it is showing them — "Unavailable — Try again" says it alone.
    // Refused by the server: the line (the server's words) lies clear of the
    // same buttons.
    for (const [w, h, path, corner] of [[390, 844, '/map', ['Whole list', 'Locate me']], [1440, 900, '/admin/map', ['Whole list', 'Locate me', 'Add a door']]]) {
      const mc = await context(w <= 720 ? { viewport: { width: w, height: h }, isMobile: true, hasTouch: true } : {});
      const mp = await mc.newPage();
      mp.on('pageerror', (e) => errors.push(`[kept ${w}] ${e.message}`));
      k = await keptThenNone(mc, mp, path, { says: '.map-retry' });
      await mp.screenshot({ path: `${SHOTS}/12-kept-${w}x${h}.png` });
      check(`${w}×${h}, a manager’s big list (no doors kept) and no answer: “Unavailable — Try again” says it alone — no line about doors over a map with none`,
        k.retry === 'Unavailable — Try again' && k.note === null && k.doors === 0 && /^Show: All/.test(k.pill || ''),
        JSON.stringify({ retry: k.retry, note: k.note, doors: k.doors, pill: k.pill }));
      // The reads answer again (the phone never said it was offline) and
      // "Try again" is tapped: the view comes, and closer in the doors drawn
      // were just loaded — no line says they are ones the phone kept (it
      // stood there, in red, until the page was loaded again).
      await mc.unroute(/\/api\/map\/(doors|density)/);
      await mp.click('.map-retry');
      await mp.waitForFunction(() => document.querySelector('.map-canvas')?.dataset.view === 'density' && !document.querySelector('.map-retry'), null, { timeout: 15000 }).catch(() => {});
      await mp.focus('.map-canvas');
      for (let i = 0; i < 8 && !((await corners(mp)).doors > 0); i += 1) { await mp.keyboard.press('+'); await sleep(900); }
      await sleep(1500);
      k = await corners(mp);
      await mp.screenshot({ path: `${SHOTS}/12-answer-back-${w}x${h}.png` });
      check(`${w}×${h}, the reads answer again and “Try again” is tapped: closer in, the doors drawn were just loaded — no line says they are kept ones`,
        k.doors > 0 && k.note === null && k.retry === null && /doors?\b/.test(k.pill || ''), JSON.stringify({ doors: k.doors, note: k.note, retry: k.retry, pill: k.pill }));
      k = await keptThenNone(mc, mp, path, { none: refused });
      await mp.screenshot({ path: `${SHOTS}/12-refused-${w}x${h}.png` });
      check(`${w}×${h}, refused by the server: the line says so in its words, clear of the zoom buttons and ${corner.join(', ')}`,
        k.note === REFUSAL && corner.every((c) => k.buttons.some((b) => b.name === c)) && blocked(k).length === 0,
        JSON.stringify({ ...k, blocked: blocked(k) }));
      await mc.close();
    }
    // A laptop with a turf's sheet open: the corner buttons move beside the
    // sheet, towards the zoom buttons — the line stays clear of both, and of the sheet.
    const lc = await context({ viewport: { width: 1024, height: 768 } });
    const lp = await lc.newPage();
    lp.on('pageerror', (e) => errors.push(`[kept 1024] ${e.message}`));
    k = await keptThenNone(lc, lp, `/admin/map?turf=${turf.id}`, { none: refused });
    await lp.screenshot({ path: `${SHOTS}/12-refused-sheet-1024x768.png` });
    check('1024×768 with a turf’s sheet open: the line clear of the zoom buttons, the buttons beside the sheet, and the sheet',
      k.note === REFUSAL && k.sheet === 'Kept block' && !k.underSheet && k.buttons.length >= 5 && blocked(k).length === 0,
      JSON.stringify({ ...k, blocked: blocked(k) }));
    await lc.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failed = e;
} finally {
  await browser.close().catch(() => {});
  server.kill();
  geocoder.close();
}
if (failed) { console.error('FAILED', failed); process.exit(1); }
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
