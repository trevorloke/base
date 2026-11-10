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
//     say;
//   · where the people fit they come whole: a door with room around it has
//     its pin at zoom 17, every door at 18;
//   · "Whole list" goes back; an empty part of the map says "Nobody on file
//     here · Back to your list";
//   · on a 390 px phone the first view fits, nothing scrolls sideways, and
//     after a finger drag the picture is still one sheet (its tiles lap: no
//     line of the street map between two of them).
//
//   (cd web && npm run build) && node e2e-map.mjs        (its own server on :4948)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
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

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off', GEOCODE_ON_SAVE: 'off',
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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#fafaf8"/><path d="M0 128H256M128 0V256" stroke="#e2e3e0" stroke-width="2"/></svg>';
const EMAIL = `map+${Date.now().toString(36)}@example.org`;
const PASSWORD = 'surrey-forward-2026';
let signedUp = false;
const context = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver', serviceWorkers: 'block', ...opts });
  await ctx.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg }));
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

// ONLY=layout,tiles node e2e-map.mjs runs just those parts (list · layout · tiles · turfs · placing · check).
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

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failed = e;
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
if (failed) { console.error('FAILED', failed); process.exit(1); }
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
