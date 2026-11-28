// Buildings and suites E2E (UNITS §9.2): one fresh in-memory Imagine Surrey
// campaign. A manager imports a made-up list through the real import page
// (the CSV has its own Latitude and Longitude, so nothing is looked up):
//   10388 134 St      Ana Example (main) + "10388 134 St Bsmt" (Ben Example)
//   10400 134 St      one lot north: Cy Example (main) + unit "Bsmt" (Dee)
//   10420 134 St      Eli Example (main) + unit "Coach house" + unit "Upper"
//   A-/B-10500 134 St a duplex with no main door (a house: Suite A, Suite B)
//   13450 104 Ave and 13450A 104 Ave, two pins 22 m apart
//   13520 104 Ave     a 6-unit low-rise written "Ste 101 13520 104 Ave"…
//   13600 104 Ave     a 24-unit mid-rise written "#201-13600 104 Ave"…
// A turf covers them all, with a persuasion pass (two tries). Then, at
// 1440 × 900 and 390 × 844, light and dark:
//   1  z18 and z19: 10388 is ONE pin ("+ Basement suite" under it from z19);
//      10420 is one pin ("+ 2 suites"); the duplex is one pin; the low-rise
//      and mid-rise are squares "6" and "24" with "Building" under them;
//      13450A and 13450 are two pins. No tag covers a neighbour's mark.
//   2  Tap 10388: "Doors at this house", Main pressed, "Basement suite · Not
//      knocked"; the header reads "Ana Example / 10388 134 St".
//   3  No answer at Main → the one primary is "Next: Basement suite" → the
//      header reads "Basement suite · 10388 134 St", Ben Example. 3b: a
//      fresh phone (no walk list kept, nothing knocked on it) reads "Main ·
//      Try again" from the server and opens the house on the basement suite.
//   4  The walk list (a volunteer's phone): 10388 is one block with Main
//      (Try again) and Basement suite (Not knocked); the duplex reads Suite A
//      and Suite B; the mid-rise reads "Building · 24 units" with rows
//      "Unit 201"… and its address not repeated on each row.
//   5  Offline (the kept walk list, no signal): Refused at the basement suite
//      → it is Done, Main still Try again. Back online it syncs: the turf's
//      progress and Today's doors read 2 doors knocked at 10388, never 1, never 3.
//      5b: a fresh phone reads Main Try again, Basement suite Done ✓, and opens on Main.
//   6  The printed walking list: "10388 134 St" once, then "Main" and
//      "Basement suite"; "13600 104 Ave · Building · 24 units"; the CSV's
//      Number 13600 and Unit "Unit 201"; the PDF (Letter) says the same.
//   7  Ben Example's profile: "Basement suite · 10388 134 St" and "Also at
//      this house: Main (1 person)"; People search "13600 104" finds the
//      units written "#201-13600 104 Ave", "10388 134" finds Ben.
//   8  At most one yellow button, door switch buttons and walk sub-rows
//      ≥ 56 px, no sideways scroll at 390, aria-labels in words, and Enter on
//      the house's pin opens it.
//   9  (review 1) The volunteer, on the map's default "Mine", opens the
//      mid-rise: all 24 units, and Next unit moves on after a knock.
//  10  The house pin follows the filter: with Main Opposed and the basement
//      suite a Yes, "Yes (1–2)" draws the suite's pin alone (its colour, no
//      head count, no mark or tag for the hidden door), and "Opposed" Main's.
//
// BIG=1 (review 6): the same list on a server that treats it as a big one
// (BASE_MAP_ALL=20 BASE_MAP_VIEW=20 BASE_MAP_DOTS=200: this list has 41
// people, so a view of it draws lean dots and a link loads one door from the
// server): opened from a People search, Ben's card still has the door switch
// with Basement suite pressed; the busy view's dots carry h (2 at 10388, 3 at
// 10420, 2 at the duplex) and u (6, 24); a tap on 10388's dot opens the house
// on its first door; No answer at Main → "Next: Basement suite".
//
// RED=1 runs steps 1, 2, 4 and 6 against a tree without this work. Each of
// those steps also checks the old behaviour itself (review 22: two pins at
// 10388, no door switch, "10388 134 St Bsmt" on its own line, the suite
// printed as an address), so a red run proves the old screens, not a wrong
// selector. It exits 1 when the new checks fail and every old-behaviour
// check holds, and 2 when an old-behaviour check fails too (red not proven).
//
//   BASE_BRAND=imagine-surrey BASE_OPEN_SIGNUP=1 BASE_DATA=memory PORT=5524 node server/index.js &
//   BASE=http://127.0.0.1:5524 SHOTS=/tmp/units node e2e-units.mjs
//   BASE_BRAND=imagine-surrey BASE_OPEN_SIGNUP=1 BASE_DATA=memory BASE_MAP_ALL=20 BASE_MAP_VIEW=20 BASE_MAP_DOTS=200 PORT=5525 node server/index.js &
//   BASE=http://127.0.0.1:5525 BIG=1 SHOTS=/tmp/units-big node e2e-units.mjs
//   (RED: the same server on a checkout of main, under its older setting names: RED=1 BASE=… node e2e-units.mjs)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ORIGIN = process.env.BASE || 'http://127.0.0.1:5524';
const BIG = process.env.BIG === '1';
const RED = process.env.RED === '1';
const DESK = '/admin';
const SHOTS = process.env.SHOTS || '/tmp/base-win-units';
mkdirSync(SHOTS, { recursive: true });
const ONLY = new Set(String(process.env.ONLY || (RED ? '1,2,4,6' : '')).split(',').map((x) => x.trim()).filter(Boolean));
const want = (n) => !ONLY.size || ONLY.has(String(n));
const results = [];
const olds = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
// The old behaviour, asserted only on a red run (review 22).
const oldWay = (name, ok, extra = '') => {
  if (!RED) return;
  olds.push(!!ok);
  console.log(`${ok ? 'OLD ' : 'OLD?'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const tileSvg = (z, x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${((x * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
    lines.push(`<line x1="0" y1="${i}" x2="256" y2="${i}" stroke="#fff" stroke-width="${((y * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><desc>${z}/${x}/${y}</desc><rect width="256" height="256" fill="#e7e3d6"/>${lines.join('')}</svg>`;
};
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) => {
  const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg(+z, +x, +y) });
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  return {
    page,
    shot: (n, full = false) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full }),
    text: async (sel = 'body') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim(),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [`/api${path}`, body]),
    go: async (path, desk = !/vol/.test(who)) => { await page.goto(`${ORIGIN}${desk ? DESK : ''}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
  };
};

// ── The list (made up, on Surrey's grid) ──
const LAT = 49.18800;
const LNG = -122.84950;
const LOT = 0.000135; // about 15 m
const P = {
  h10388: { lat: LAT, lng: LNG, addr: '10388 134 St' },
  h10400: { lat: LAT + LOT, lng: LNG, addr: '10400 134 St' },
  h10420: { lat: LAT + 6 * LOT, lng: LNG, addr: '10420 134 St' },
  duplex: { lat: LAT + 10 * LOT, lng: LNG, addr: '10500 134 St' },
  h13450A: { lat: LAT - 4 * LOT, lng: LNG + 0.0006, addr: '13450A 104 Ave' },
  h13450: { lat: LAT - 4 * LOT, lng: LNG + 0.0009, addr: '13450 104 Ave' },
  low: { lat: LAT - 4 * LOT, lng: LNG + 0.0015, addr: '13520 104 Ave' },
  mid: { lat: LAT - 4 * LOT, lng: LNG + 0.0025, addr: '13600 104 Ave' },
};
const FIRST = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lea', 'Max', 'Nia', 'Oli', 'Pia', 'Raj', 'Sol', 'Tia', 'Uma', 'Vic', 'Wes', 'Xia', 'Yan'];
const MID_UNITS = [2, 3, 4].flatMap((f) => Array.from({ length: 8 }, (_, i) => `${f}0${i + 1}`));
const ROWS = [
  ['Ana', 'Example', '10388 134 St', '', P.h10388],
  ['Ben', 'Example', '10388 134 St Bsmt', '', P.h10388],
  ['Cy', 'Example', '10400 134 St', '', P.h10400],
  ['Dee', 'Example', '10400 134 St', 'Bsmt', P.h10400],
  ['Eli', 'Example', '10420 134 St', '', P.h10420],
  ['Fay', 'Example', '10420 134 St', 'Coach house', P.h10420],
  ['Gus', 'Example', '10420 134 St', 'Upper', P.h10420],
  ['Hana', 'Example', 'A-10500 134 St', '', P.duplex],
  ['Ivo', 'Example', 'B-10500 134 St', '', P.duplex],
  ['Jun', 'Example', '13450A 104 Ave', '', P.h13450A],
  ['Kai', 'Example', '13450 104 Ave', '', P.h13450],
  ...Array.from({ length: 6 }, (_, i) => [FIRST[i], 'Sample', `Ste 10${i + 1} 13520 104 Ave`, '', P.low]),
  ...MID_UNITS.map((u, i) => [FIRST[i], 'Placeholder', `#${u}-13600 104 Ave`, '', P.mid]),
];
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const CSV = [
  ['First Name', 'Last Name', 'Address', 'Unit', 'City', 'Latitude', 'Longitude'],
  ...ROWS.map(([f, l, a, u, at]) => [f, l, a, u, 'Surrey', at.lat.toFixed(6), at.lng.toFixed(6)]),
].map((r) => r.map(csvCell).join(',')).join('\n');
const csvPath = `${SHOTS}/units-list-${tag}.csv`;
writeFileSync(csvPath, `${CSV}\n`);

// What the map says about itself (Map.jsx data-* and its marks).
const mapState = (page) => page.evaluate(() => {
  const el = document.querySelector('.map-canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const marks = [...el.querySelectorAll('.leaflet-marker-icon')].map((m) => {
    const b = m.getBoundingClientRect();
    const t = m.querySelector('.map-tag');
    const tb = t?.getBoundingClientRect();
    return {
      title: m.getAttribute('title') || '', aria: m.querySelector('[aria-label]')?.getAttribute('aria-label') || '',
      bldg: Boolean(m.querySelector('.map-bldg')), house: Boolean(m.querySelector('.map-house__more')),
      n: m.querySelector('.map-bldg__n')?.innerText || '', tag: t?.innerText || '',
      box: [b.left, b.top, b.right, b.bottom], tagBox: tb ? [tb.left, tb.top, tb.right, tb.bottom] : null,
    };
  });
  return { zoom: Number(el.dataset.zoom), view: el.dataset.view || null, bounds: (el.dataset.bounds || '').split(',').map(Number), box: { x: r.x, y: r.y, w: r.width, h: r.height }, marks };
});
const until = async (page, fn, ms = 10000) => {
  const end = Date.now() + ms;
  let st = await mapState(page);
  while (!(st && fn(st)) && Date.now() < end) { await sleep(150); st = await mapState(page); }
  return st || { marks: [] };
};
const zoomTo = async (page, z) => {
  for (let i = 0; i < 8; i += 1) {
    const st = await mapState(page);
    if (!st || Math.round(st.zoom) === z) return st;
    await page.click(st.zoom < z ? '.leaflet-control-zoom-in' : '.leaflet-control-zoom-out');
    await until(page, (s) => s.zoom !== st.zoom, 4000);
    await sleep(400);
  }
  return mapState(page);
};
const merc = (lat) => Math.asinh(Math.tan((lat * Math.PI) / 180));
const pointOf = (st, d) => {
  const [s, w, n, e] = st.bounds;
  return [st.box.x + ((d.lng - w) / (e - w)) * st.box.w, st.box.y + ((merc(n) - merc(d.lat)) / (merc(n) - merc(s))) * st.box.h];
};
// Drag the map so a place sits in the middle of the canvas.
const centre = async (page, d) => {
  const st = await mapState(page);
  if (!st) return;
  const [x, y] = pointOf(st, d);
  const cx = st.box.x + st.box.w / 2;
  const cy = st.box.y + st.box.h / 2;
  const sx = cx - (cx - x) / 2;
  const sy = cy - (cy - y) / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (cx - x) / 2, sy + (cy - y) / 2, { steps: 6 });
  await page.mouse.move(sx + (cx - x), sy + (cy - y), { steps: 6 });
  await page.mouse.up();
  await sleep(600);
};
const inView = (st, d) => {
  const [x, y] = pointOf(st, d);
  return x > st.box.x + 10 && x < st.box.x + st.box.w - 10 && y > st.box.y + 10 && y < st.box.y + st.box.h - 10;
};
const marksAt = (st, addr) => st.marks.filter((m) => m.title === addr || m.title.startsWith(`${addr},`) || m.title.startsWith(`${addr} `) || m.title.startsWith(`${addr} ·`));
const meet = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
// Simplicity: yellow buttons, sideways scroll, the smallest tap target.
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (targets) for (const el of document.querySelectorAll(targets)) { if (visible(el)) minTap = Math.min(minTap ?? 999, el.getBoundingClientRect().height); }
  return { yellow, overflow, minTap };
}, sel);
const simple = async (page, name, sel = null, min = 0) => {
  const mm = await measure(page, sel);
  check(`8 ${name}: ≤ 1 yellow, no sideways scroll${min ? `, targets ≥ ${min} px` : ''}`, mm.yellow <= 1 && mm.overflow <= 0 && (!min || (mm.minTap != null && mm.minTap >= min - 0.5)), JSON.stringify(mm));
};
const dark = (scheme) => (scheme === 'dark' ? '-dark' : '');
const CARD = '.map-sheet:not(.bldg-sheet) .door-card';
const switchOf = (page) => page.$$eval('.door-switch__btn', (els) => els.map((e) => ({
  t: e.innerText.replace(/\s+/g, ' ').trim(), on: e.getAttribute('aria-pressed') === 'true', aria: e.getAttribute('aria-label') || '', h: e.getBoundingClientRect().height,
})));
const cardHead = (H) => H.text('.door-card .mapsheet-head');
const subLine = (page) => page.$eval('.bldg-sheet:not([hidden]) .door-head__place', (el) => el.innerText.trim()).catch(() => '');
const countLine = (page) => page.$eval('.bldg-sheet .bldg-count__line', (el) => el.innerText.trim()).catch(() => '');

// ── The desk: a manager signs up and imports the list through the import page ──
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver', acceptDownloads: true });
await tiles(dctx);
const D = helpers(await dctx.newPage(), 'manager');
await D.go('/signup', false);
await D.page.fill('#su-name', 'Riley Manager');
if (await D.page.locator('#su-org').count()) await D.page.fill('#su-org', 'Imagine Surrey');
await D.page.fill('#su-email', `riley+${tag}@units.example`);
await D.page.fill('#su-password', 'surrey-forward-2026');
await D.page.click('button[type="submit"]');
await D.page.waitForURL(/\/(admin|desk)\/?$/, { timeout: 15000 });
await D.go('/people/import');
await D.page.waitForSelector('#imp-file', { state: 'attached', timeout: 10000 });
await D.page.setInputFiles('#imp-file', csvPath);
await D.page.waitForSelector('.imp-map__select', { timeout: 10000 }).catch(() => {});
const mapped = await D.page.$$eval('.imp-map__select', (els) => els.map((e) => e.options[e.selectedIndex].text)).catch(() => []);
check('the import page reads the list: name, address, unit, city, latitude, longitude', mapped.length === 7 && mapped.some((t) => /latitude/i.test(t)) && mapped.some((t) => /unit/i.test(t)), mapped.join('|'));
await D.shot('00-import-mapped', true);
await D.page.getByRole('button', { name: /^Check \d+ rows$/ }).click();
await D.page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).waitFor({ timeout: 20000 }).catch(() => {});
await D.shot('00-import-checked', true);
await D.page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click();
let made = [];
for (let i = 0; i < 40 && made.length < ROWS.length; i += 1) {
  await sleep(500);
  made = (await D.api('/persons?limit=200')).json?.persons || [];
}
check(`the import saved ${ROWS.length} made-up people, each on its pin`, made.length === ROWS.length && made.every((p) => p.lat != null), `${made.length} saved`);
const person = (first, last = 'Example') => made.find((p) => p.name === `${first} ${last}`) || {};
const ana = person('Ana');
const ben = person('Ben');
const turf = (await D.api('/actions/turf.create', {
  name: 'Units block', polygon: [[LAT - 0.001, LNG - 0.001], [LAT + 0.002, LNG - 0.001], [LAT + 0.002, LNG + 0.0035], [LAT - 0.001, LNG + 0.0035]],
})).json?.turf;
const pass = (await D.api('/actions/pass.start', { name: 'Persuasion · units', kind: 'persuasion', who: 'all', tries: 2 })).json?.pass;
check('a turf over all of them, and a persuasion pass with two tries', Boolean(turf?.id && pass?.id));
// The door parts are worked out after the import commits (and by the
// sweeper): wait until the server's walk list carries them.
if (!RED) {
  let placed = false;
  for (let i = 0; i < 60 && !placed; i += 1) {
    const w = (await D.api(`/turfs/${turf.id}/walk`)).json;
    placed = (w?.doors || []).some((d) => d.place === 'building' && d.units === 24);
    if (!placed) await sleep(500);
  }
  check('the server has worked out every door (the mid-rise is a 24-unit building)', placed);
}

// A fresh context with the manager's sign-in.
const ctxFor = async (size, scheme = 'light', extra = {}) => {
  const ctx = await browser.newContext({
    ...(size === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }),
    colorScheme: scheme, timezoneId: 'America/Vancouver', ...extra,
  });
  await tiles(ctx);
  return ctx;
};
const asManager = async (size, scheme) => {
  const ctx = await ctxFor(size, scheme);
  await ctx.addCookies(await dctx.cookies());
  return { ctx, H: helpers(await ctx.newPage(), `manager-${size}${dark(scheme)}`) };
};
// The map around a place: open a lone door by link (13450), close its
// card, put the place in the middle, zoom.
const mapAt = async (H, place, z) => {
  await H.go(`/map?person=${person('Kai').id}`);
  await until(H.page, (s) => s.zoom >= 16, 10000);
  await H.page.keyboard.press('Escape');
  await sleep(500);
  await zoomTo(H.page, 18);
  await centre(H.page, place);
  if (z !== 18) await zoomTo(H.page, z);
  await sleep(800);
  return mapState(H.page);
};

// ── Step 1: the map ──
const step1 = async (size, scheme) => {
  const { ctx, H } = await asManager(size, scheme);
  const groups = size === 'desk'
    ? [{ at: { lat: LAT + 2 * LOT, lng: LNG + 0.0012 }, all: true }]
    : [{ at: { lat: LAT + 5 * LOT, lng: LNG }, all: false, street: '134' }, { at: { lat: LAT - 4 * LOT, lng: LNG + 0.0015 }, all: false, street: '104' }];
  for (const g of groups) {
    for (const z of [18, 19]) {
      const st = await mapAt(H, g.at, z);
      const name = `1 ${size}${dark(scheme)} z${z}${g.street ? ` (${g.street})` : ''}`;
      const seen = (k) => inView(st, P[k]);
      if (seen('h10388')) {
        const m = marksAt(st, P.h10388.addr);
        check(`${name}: 10388 is one pin, a house with Main and Basement suite`, m.length === 1 && m[0].house && /house with 2 doors: Main, Basement suite$/.test(m[0].title), JSON.stringify(m.map((x) => x.title)));
        // (Old: no house; "10388 134 St Bsmt" is a door of its own, stacked
        // on the main door's spot, the two fanned out from z19.)
        oldWay(`${name}: no house at 10388: "10388 134 St Bsmt" is a pin of its own${z === 19 ? ', beside the main door\'s' : ''}`,
          !m.some((x) => x.house) && m.some((x) => /^10388 134 St Bsmt\b/.test(x.title)) && (z !== 19 || m.length === 2), JSON.stringify(m.map((x) => x.title)));
        if (z === 19) check(`${name}: "+ Basement suite" under 10388`, m[0]?.tag === '+ Basement suite', JSON.stringify(m.map((x) => x.tag)));
      }
      if (seen('h10420')) {
        const m = marksAt(st, P.h10420.addr);
        check(`${name}: 10420 is one pin, Main, Upper suite and Coach house`, m.length === 1 && m[0].house && /house with 3 doors: Main, Upper suite, Coach house$/.test(m[0].title), JSON.stringify(m.map((x) => x.title)));
        if (z === 19) check(`${name}: "+ 2 suites" under 10420`, m[0]?.tag === '+ 2 suites', JSON.stringify(m.map((x) => x.tag)));
      }
      if (seen('duplex')) {
        const m = marksAt(st, P.duplex.addr);
        check(`${name}: the duplex A-/B- is one pin, a house with Suite A and Suite B`, m.length === 1 && m[0].house && /house with 2 doors: Suite A, Suite B$/.test(m[0].title), JSON.stringify(m.map((x) => x.title)));
        oldWay(`${name}: the duplex is two pins`, st.marks.filter((x) => /10500 134 St/.test(x.title)).length === 2, JSON.stringify(st.marks.filter((x) => /10500/.test(x.title)).map((x) => x.title)));
      }
      for (const [k, n] of [['low', '6'], ['mid', '24']]) {
        if (!seen(k)) continue;
        const sq = st.marks.filter((x) => x.bldg && x.title.startsWith(`${P[k].addr},`));
        check(`${name}: ${P[k].addr} is a square "${n}" with "Building" under it`, sq.length === 1 && sq[0].n === n && sq[0].tag === 'Building' && /, building, \d+ units$/.test(sq[0].title), JSON.stringify(sq.map((x) => [x.title, x.n, x.tag])));
        if (k === 'low') oldWay(`${name}: the low-rise written "Ste 101 13520…" is no square`, sq.length === 0, JSON.stringify(sq.map((x) => x.title)));
      }
      if (seen('h13450') && seen('h13450A') && z === 19) {
        const a = st.marks.filter((x) => /^13450 104 Ave/.test(x.title));
        const b = st.marks.filter((x) => /^13450A 104 Ave/.test(x.title));
        check(`${name}: 13450A and 13450 are two pins, neither a house`, a.length === 1 && b.length === 1 && !a[0].house && !b[0].house && !a[0].bldg, JSON.stringify([...a, ...b].map((x) => x.title)));
      }
      if (z === 19 && !RED) {
        const tagged = st.marks.filter((x) => x.tagBox);
        const bad = tagged.filter((x) => st.marks.some((y) => y !== x && (meet(x.tagBox, y.box) || (y.tagBox && meet(x.tagBox, y.tagBox)))));
        check(`${name}: no tag covers a neighbour (10400 is one lot from 10388)`, tagged.length > 0 && bad.length === 0, JSON.stringify(bad.map((x) => [x.title.slice(0, 14), x.tag])));
      }
      if (z === 18 && seen('h10388') && seen('h10400') && !RED) {
        const m = marksAt(st, P.h10400.addr);
        check(`${name}: 10400 (one lot north) is its own house pin`, m.length === 1 && m[0].house, JSON.stringify(m.map((x) => x.title)));
      }
      await H.shot(`01-map-${size}${dark(scheme)}-z${z}${g.street ? `-${g.street}` : ''}`);
    }
  }
  if (size === 'desk' && scheme === 'light' && !RED) {
    // Enter on the house's pin opens it (step 8).
    await mapAt(H, P.h10388, 18);
    const pin = H.page.locator(`.leaflet-marker-icon[title^="${P.h10388.addr},"]`).first();
    await pin.focus().catch(() => {});
    await H.page.keyboard.press('Enter');
    await H.page.waitForSelector('.door-switch__btn', { timeout: 6000 }).catch(() => {});
    check('8 desk: Enter on the house\'s pin opens it (the door switch)', (await switchOf(H.page)).length === 2, H.page.url());
  }
  await ctx.close();
};
if (want(1) && !BIG) {
  for (const scheme of ['light', 'dark']) {
    await step1('desk', scheme);
    await step1('phone', scheme);
  }
}

// ── Steps 2 and 3: the house's card ──
const openHouse = async (H, size) => {
  await mapAt(H, P.h10388, 18);
  await H.page.locator(`.leaflet-marker-icon[title^="${P.h10388.addr}"]`).first().click({ timeout: 5000 }).catch(() => {});
  await H.page.waitForSelector('.door-card .mapsheet-head', { timeout: 8000 }).catch(() => {});
  await sleep(600);
  return size;
};
const step2 = async (size, scheme) => {
  const { ctx, H } = await asManager(size, scheme);
  await openHouse(H, size);
  const head = await cardHead(H);
  const sw = await switchOf(H.page);
  const label = await H.text('.door-switch__label');
  check(`2 ${size}${dark(scheme)}: tap 10388 → "Doors at this house", Main pressed, "Basement suite · Not knocked"`,
    label === 'Doors at this house' && sw.length === 2 && sw[0].on && sw[0].t === 'Main Not knocked' && !sw[1].on && sw[1].t === 'Basement suite Not knocked', `${label} · ${JSON.stringify(sw)}`);
  check(`2 ${size}${dark(scheme)}: the header reads "Ana Example / 10388 134 St"`, /^Ana Example 10388 134 St\b/.test(head) && !/Basement suite/.test(head), head);
  const card = await H.text('.door-card');
  // (Old: a pin is one door: no switch, and Ana and Ben are never on one card.)
  oldWay(`2 ${size}${dark(scheme)}: a pin at 10388 opens one door only: no door switch, Ana and Ben never on one card`, sw.length === 0 && card.includes('Ana Example') !== card.includes('Ben Example'), card.slice(0, 120));
  if (!RED) {
    check(`8 ${size}${dark(scheme)}: the switch buttons read their words ("Basement suite, not knocked") and are ≥ 56 px`, sw.length === 2 && sw[1].aria === 'Basement suite, not knocked' && sw.every((b) => b.h >= 55.5), JSON.stringify(sw.map((b) => [b.aria, b.h])));
    await simple(H.page, `2 ${size}${dark(scheme)}: the house's card`, size === 'phone' ? '.door-switch__btn' : null, size === 'phone' ? 56 : 0);
  }
  await H.shot(`02-card-house-${size}${dark(scheme)}`);
  await ctx.close();
};
if (want(2) && !BIG) {
  for (const scheme of ['light', 'dark']) {
    await step2('desk', scheme);
    await step2('phone', scheme);
  }
}
// Step 3 (and BIG's B3): No answer at Main → Next: Basement suite.
const step3 = async (H, name) => {
  await H.page.locator(`${CARD} .fk-out`, { hasText: 'No answer' }).first().click({ timeout: 5000 }).catch(() => {});
  await H.page.waitForSelector(`${CARD} .bldg-next`, { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const yellow = await H.page.$$eval('.btn-primary', (els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.innerText.trim()));
  const sw = await switchOf(H.page);
  check(`${name}: No answer at Main → the one yellow is "Next: Basement suite", Main reads Try again`,
    yellow.length === 1 && yellow[0] === 'Next: Basement suite' && /^Main Try again/.test(sw[0]?.t || ''), `${JSON.stringify(yellow)} · ${JSON.stringify(sw.map((b) => b.t))}`);
  await H.shot(`03-card-after-knock-${name.split(' ')[1] || 'phone'}`);
  await H.page.locator('.btn-primary', { hasText: 'Next: Basement suite' }).click({ timeout: 5000 }).catch(() => {});
  await sleep(1000);
  const head = await cardHead(H);
  check(`${name}: → "Basement suite · 10388 134 St", Ben Example`, /^Ben Example Basement suite · 10388 134 St\b/.test(head) && H.page.url().includes(ben.id), `${head} · ${H.page.url()}`);
  const sw2 = await switchOf(H.page);
  check(`${name}: the switch now has Basement suite pressed`, sw2.length === 2 && sw2[1].on && !sw2[0].on, JSON.stringify(sw2.map((b) => [b.t, b.on])));
  await H.shot(`03-card-basement-${name.split(' ')[1] || 'phone'}`);
};
// A house opened on a phone that knocked none of its doors and keeps no walk
// list (a fresh context): the switch reads each door's state from the
// server, and the card opens on the first door still not knocked.
const fresh = async (name, want, opensOn) => {
  const { ctx, H } = await asManager('phone', 'light');
  await openHouse(H, 'phone');
  await sleep(600);
  const sw = await switchOf(H.page);
  const head = await cardHead(H);
  check(`${name}: a fresh phone reads ${want.map((t) => `"${t}"`).join(', ')} and opens on ${opensOn}`,
    sw.map((b) => b.t).join('|') === want.join('|') && sw[opensOn === 'Main' ? 0 : 1]?.on === true
      && (opensOn === 'Main' ? /^Ana Example\b/.test(head) : /^Ben Example Basement suite · 10388 134 St\b/.test(head)),
    `${JSON.stringify(sw.map((b) => [b.t, b.on]))} · ${head}`);
  await H.shot(`03-card-fresh-${name.replace(/\W+/g, '-')}`);
  await ctx.close();
};
if (want(3) && !BIG) {
  const { ctx, H } = await asManager('phone', 'light');
  await openHouse(H, 'phone');
  await step3(H, '3 phone');
  await simple(H.page, '3 phone: the basement suite\'s card', '.door-switch__btn', 56);
  await ctx.close();
  // Main was knocked (No answer) on another phone: never "Main · Not knocked" here.
  if (!RED) await fresh('3b', ['Main Try again', 'Basement suite Not knocked'], 'Basement suite');
}

// ── A volunteer with the turf, on a phone ──
const invite = async (email) => (await D.api('/actions/member.invite', { email, role: 'volunteer' })).json;
let V = null;
let vctx = null;
if (!BIG && (want(4) || want(5) || want(9))) {
  vctx = await ctxFor('phone', 'light', { serviceWorkers: 'allow' });
  V = helpers(await vctx.newPage(), 'vol');
  const inv = await invite(`amrit+${tag}@units.example`);
  await V.go('/login');
  const j = await V.api('/auth/join', { token: inv?.joinUrl?.split('/').pop(), name: 'Amrit Volunteer', password: 'knock-knock-2026' });
  const id = (await V.api('/auth/me')).json?.user?.id;
  check('a volunteer joins and walks the turf', j.status === 200 && (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: id })).status === 200);
}
// The walk list as blocks: a house or building header, then its rows.
const walkRead = (page) => page.$$eval('.walk-doors .walk-group, .walk-doors .walk-floor, .walk-doors li.walk-door', (lis) => lis.map((li) => {
  const sub = li.querySelector('.walk-door__addr--sub');
  let shown = '';
  if (sub) { const c = sub.cloneNode(true); c.querySelectorAll('.walk-sr').forEach((x) => x.remove()); shown = c.textContent.trim(); }
  return {
    group: li.classList.contains('walk-group'), place: (/walk-group--(\w+)/.exec(li.className) || [])[1] || '',
    floor: li.classList.contains('walk-floor'), sub: li.classList.contains('walk-door--sub'),
    addr: li.querySelector('.walk-group__addr')?.innerText.trim() || '', line: li.querySelector('.walk-group__line')?.innerText.trim() || '',
    words: li.querySelector('.walk-door__unit')?.innerText.trim() || '', shown,
    lone: li.querySelector('.walk-door__addr:not(.walk-door__addr--sub)')?.innerText.trim() || '',
    chips: li.querySelector('.walk-door__chips')?.innerText.replace(/\s+/g, ' ').trim() || '',
    names: li.querySelector('.walk-door__names')?.innerText.trim() || '',
    h: li.querySelector('.walk-door__head')?.getBoundingClientRect().height || 0,
  };
}));
const blocksOf = (rows) => {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (r.group) { cur = { addr: r.addr, place: r.place, line: r.line, doors: [] }; out.push(cur); } else if (r.floor) continue;
    else if (r.sub && cur) cur.doors.push(r);
    else { cur = null; out.push({ addr: r.lone, place: 'door', line: '', doors: [r] }); }
  }
  return out;
};
const subRow = (page, addr, words) => page.locator('.walk-doors li.walk-door--sub', { has: page.locator('.walk-door__unit', { hasText: new RegExp(`^${words}$`) }) })
  .filter({ has: page.locator('.walk-sr', { hasText: addr }) }).first();

if (want(4) && V) {
  const vp = V.page;
  await V.go(`/turfs/${turf.id}`);
  await vp.waitForSelector('.walk-door', { timeout: 10000 });
  await sleep(800);
  const rows = await walkRead(vp);
  const blocks = blocksOf(rows);
  const b10388 = blocks.find((b) => b.addr === P.h10388.addr && b.place === 'house');
  check('4: 10388 is one block, Main (Try again) then Basement suite (Not knocked)',
    b10388 && b10388.doors.length === 2 && b10388.doors[0].words === 'Main' && /Try again/.test(b10388.doors[0].chips) && b10388.doors[1].words === 'Basement suite' && /Not knocked/.test(b10388.doors[1].chips),
    JSON.stringify(b10388 || blocks.slice(0, 3)));
  oldWay('4: 10388 is two doors on their own lines ("10388 134 St" and "10388 134 St Bsmt"), no house block',
    !rows.some((r) => r.group) && rows.filter((r) => /^10388 134 St/.test(r.lone)).length === 2 && rows.some((r) => /^10388 134 St Bsmt/.test(r.lone)), JSON.stringify(rows.filter((r) => /10388/.test(r.lone)).map((r) => r.lone)));
  const duplex = blocks.find((b) => b.addr === P.duplex.addr);
  check('4: the duplex reads Suite A and Suite B under one address', duplex?.place === 'house' && duplex.doors.map((d) => d.words).join('|') === 'Suite A|Suite B', JSON.stringify(duplex));
  const mid = blocks.find((b) => b.addr === P.mid.addr);
  check('4: the mid-rise block reads "Building · 24 units" and its rows "Unit 201", "Unit 202"…',
    mid?.place === 'building' && /^Building · 24 units · 24 left$/.test(mid.line) && mid.doors.length === 24 && mid.doors.slice(0, 3).map((d) => d.words).join('|') === 'Unit 201|Unit 202|Unit 203',
    JSON.stringify(mid ? { line: mid.line, n: mid.doors.length, first: mid.doors.slice(0, 3).map((d) => d.words) } : blocks.map((b) => b.addr)));
  check('4: a unit row does not repeat the address', mid && mid.doors.every((d) => d.shown === d.words), JSON.stringify(mid?.doors.slice(0, 2)));
  const low = blocks.find((b) => b.addr === P.low.addr);
  check('4: the low-rise written "Ste 101 13520 104 Ave" is "Building · 6 units"', low?.place === 'building' && /^Building · 6 units/.test(low.line), JSON.stringify(low || null));
  // This list walks 104 Ave first: Next door is the mid-rise's first unit.
  const next = await V.text('.walk-next__btn');
  check('4: Next door · Unit 201 · 13600 104 Ave', next === 'Next door Unit 201 · 13600 104 Ave', next);
  // A building's floor heading stays over its own rows only: past the building it scrolls away (never over a house's rows).
  const covered = await vp.evaluate(() => {
    const row = [...document.querySelectorAll('.walk-door--sub')].find((li) => (li.querySelector('.walk-door__unit')?.innerText || '').trim() === 'Suite A');
    if (!row) return 'no Suite A row';
    row.scrollIntoView({ block: 'start' });
    const r = row.getBoundingClientRect();
    const over = [...document.querySelectorAll('.walk-floor')].filter((f) => { const b = f.getBoundingClientRect(); return b.height > 0 && b.bottom > Math.max(0, r.top - 1) && b.top < r.bottom; });
    const hit = [2, 8, 16].map((dy) => document.elementFromPoint(r.left + r.width / 2, Math.max(1, r.top) + dy)?.closest('.walk-floor')).find(Boolean);
    return over.length || hit ? `covered by ${(hit || over[0]).innerText.trim()}` : '';
  });
  check('4: past a building no floor heading sticks over a house\'s rows (Suite A at 10500 134 St is not covered)', covered === '', covered);
  await V.shot('04-walk-list-past-building-phone');
  await vp.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  const subs = rows.filter((r) => r.sub);
  check('8 phone: every walk sub-row is ≥ 56 px tall', subs.length > 0 && subs.every((r) => r.h >= 55.5), JSON.stringify(subs.map((r) => r.h).slice(0, 4)));
  await simple(vp, '4 phone: the walk list');
  await V.shot('04-walk-list-phone');
  await vp.locator('.walk-group', { hasText: P.mid.addr }).scrollIntoViewIfNeeded().catch(() => {});
  await V.shot('04-walk-list-building-phone');
  // At 10388's main door (Try again), the button goes on to the basement suite.
  await subRow(vp, P.h10388.addr, 'Main').locator('.walk-door__head').click({ timeout: 5000 }).catch(() => {});
  await sleep(500);
  const skip = await V.text('.walk-next__btn');
  check('4: at 10388\'s main door the next door is "Basement suite · 10388 134 St"', skip === 'Skip → Basement suite · 10388 134 St', skip);
  await V.shot('04-walk-list-house-open-phone');
  await subRow(vp, P.h10388.addr, 'Main').locator('.walk-door__head').click({ timeout: 5000 }).catch(() => {});
  await sleep(400);
}

// ── Step 5: the basement suite knocked with no signal ──
if (want(5) && V && !RED) {
  const vp = V.page;
  await V.go(`/turfs/${turf.id}`);
  await vp.waitForSelector('.walk-door', { timeout: 10000 });
  await sleep(1000);
  await vctx.setOffline(true);
  await vp.evaluate(() => window.dispatchEvent(new Event('offline')));
  await sleep(500);
  const row = subRow(vp, P.h10388.addr, 'Basement suite');
  await row.locator('.walk-door__head').click({ timeout: 5000 }).catch(() => {});
  await sleep(400);
  await row.locator('.fk-out', { hasText: 'Refused' }).first().click({ timeout: 5000 }).catch(() => {});
  await sleep(1200);
  const b = blocksOf(await walkRead(vp)).find((x) => x.addr === P.h10388.addr);
  check('5: offline, Refused at the basement suite: it is Done, Main still Try again',
    b && /Done/.test(b.doors[1]?.chips || '') && /Try again/.test(b.doors[0]?.chips || '') && !/Done/.test(b.doors[0]?.chips || ''), JSON.stringify(b?.doors.map((d) => [d.words, d.chips])));
  await V.shot('05-offline-knock-phone');
  await vctx.setOffline(false);
  await vp.evaluate(() => window.dispatchEvent(new Event('online')));
  let stats = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    stats = (await D.api(`/turfs/${turf.id}`)).json?.turf;
    if (stats && stats.doorsDone >= 1) break;
  }
  check('5: back online it syncs: the turf reads 2 doors knocked (1 done, 1 to try again) of 41',
    stats?.doorsDone === 1 && stats?.doorsAgain === 1 && stats?.doors === 41, JSON.stringify(stats && { doors: stats.doors, done: stats.doorsDone, again: stats.doorsAgain }));
  const brief = (await D.api('/brief')).json;
  check('5: Today\'s doors this week: 2 (Main and the basement suite, never 1 merged, never 3)', brief?.field?.doors === 2, JSON.stringify(brief?.field));
  // The basement suite was knocked from the volunteer's walk list: a fresh phone sees it Done.
  await fresh('5b', ['Main Try again', 'Basement suite Done ✓'], 'Main');
}

// ── Step 9 (review 1): the volunteer's map, on Mine, opens the mid-rise ──
if (want(9) && V && !RED) {
  const vp = V.page;
  await V.go('/map');
  await until(vp, (s) => s.zoom > 0, 8000);
  await sleep(600);
  const filter = await V.text('.map-filter-btn');
  await zoomTo(vp, 18);
  await centre(vp, P.mid);
  await sleep(600);
  await vp.locator(`.leaflet-marker-icon[title^="${P.mid.addr}, building"]`).first().click({ timeout: 5000 }).catch(() => {});
  await vp.waitForSelector('.bldg-sheet:not([hidden]) .bldg-count__line', { timeout: 8000 }).catch(() => {});
  const sub = await subLine(vp);
  const line = await countLine(vp);
  check('9: on the volunteer\'s own filter ("My turf") the mid-rise opens: "Building · 24 units", "24 left"', /My turf|Mine/.test(filter) && sub === 'Building · 24 units' && line === '24 left', `${filter} · ${sub} · ${line}`);
  await vp.click('.bldg-next').catch(() => {});
  await vp.waitForSelector('.bldg-back', { timeout: 8000 }).catch(() => {});
  const bar = await V.text('.bldg-back');
  check('9: Next unit opens Unit 201', bar === '‹ 13600 104 Ave · Floor 2 · Unit 201', bar);
  await vp.locator(`${CARD} .fk-out`, { hasText: 'No answer' }).first().click({ timeout: 5000 }).catch(() => {});
  await vp.waitForSelector(`${CARD} .bldg-next`, { timeout: 8000 }).catch(() => {});
  const n2 = await vp.$eval(`${CARD} .bldg-next`, (el) => el.innerText.trim()).catch(() => '');
  check('9: after a knock Next unit moves on: "Next unit · 202"', n2 === 'Next unit · 202', n2);
  await V.shot('09-volunteer-unit-phone');
}

// ── Step 6: the printed walking list, its CSV and its PDF ──
if (want(6) && !BIG) {
  await D.go(`/reports/walk?turf=${turf.id}&doors=all`);
  await D.page.waitForSelector('.ws-sheet', { timeout: 10000 }).catch(() => {});
  await sleep(600);
  const sheet = await D.text('.ws-sheet');
  const times = (s, w) => s.split(w).length - 1;
  check('6: "10388 134 St" once, then "Main" and "Basement suite"', times(sheet, '10388 134 St') === 1 && /10388 134 St Main(?![a-z])[\s\S]*?Basement suite/.test(sheet), (sheet.match(/.{0,40}10388 134 St.{0,60}/g) || []).join(' | '));
  check('6: "13600 104 Ave · Building · 24 units", then "Unit 201"', /13600 104 Ave · Building · 24 units/.test(sheet) && /Unit 201(?!\d)/.test(sheet), (/13600[^\n]{0,80}/.exec(sheet) || [''])[0]);
  oldWay('6: the old sheet prints the suite as an address of its own ("10388 134 St Bsmt"), no "Basement suite"', /10388 134 St Bsmt/.test(sheet) && !/Basement suite/.test(sheet), (/10388[^\n]{0,60}/.exec(sheet) || [''])[0]);
  await D.shot('06-print-walking-list-desk', true);
  const csv = await D.api(`/quick-reports/walk.csv?turf=${turf.id}&doors=all`);
  const lines = (csv.raw || '').replace(/^﻿/, '').split(/\r?\n/);
  const head = lines[0].split(',');
  const at = (n) => head.indexOf(n);
  const cells = lines.slice(1).map((l) => l.split(','));
  const u201 = cells.find((c) => c[at('Unit')] === 'Unit 201');
  check('6: the CSV keeps Street, Number, Unit; the mid-rise\'s 201 reads Number 13600, Unit "Unit 201"', at('Street') >= 0 && at('Number') >= 0 && at('Unit') >= 0 && u201 && u201[at('Number')] === '13600', `${lines[0]} · ${u201 ? u201.join(',') : lines.slice(1, 3).join(' / ')}`);
  const bsmt = cells.find((c) => c[at('Unit')] === 'Basement suite' && c[at('Number')] === '10388');
  check('6: the CSV\'s basement suite at 10388: Number 10388, Unit "Basement suite"', Boolean(bsmt), lines.filter((l) => /10388/.test(l)).join(' / '));
  oldWay('6: the old CSV has no "Unit 201" and no "Basement suite"', !u201 && !bsmt, lines.filter((l) => /13600|10388/.test(l)).slice(0, 2).join(' / '));
  await D.page.emulateMedia({ media: 'print' });
  const pdf = `${SHOTS}/06-walking-list.pdf`;
  await D.page.pdf({ path: pdf, format: 'Letter' });
  await D.page.emulateMedia({ media: 'screen' });
  const txt = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
  if (txt.status === 0) {
    const t = txt.stdout.replace(/[ \t]+/g, ' ');
    check('6: the PDF (Letter): "10388 134 St" once, "Main", "Basement suite", "13600 104 Ave · Building · 24 units"', times(t, '10388 134 St') === 1 && /\bMain\b/.test(t) && /Basement suite/.test(t) && /13600 104 Ave · Building · 24 units/.test(t), t.slice(0, 200));
  } else check('6: pdftotext reads the PDF (needed to check its words)', false, txt.error?.message || txt.stderr);
  // Short pages, so the mid-rise runs over several: a page it continues on names it (and its floor),
  // and a unit's line never ends a page without its people.
  const short = `${SHOTS}/06-walking-list-short.pdf`;
  await D.page.emulateMedia({ media: 'print' });
  await D.page.pdf({ path: short, width: '8.5in', height: '6in' });
  await D.page.emulateMedia({ media: 'screen' });
  const st = spawnSync('pdftotext', ['-layout', short, '-'], { encoding: 'utf8' });
  if (st.status === 0) {
    const pages = st.stdout.split('\f').map((pg) => pg.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)).filter((pg) => pg.length);
    const midPages = pages.filter((pg) => pg.some((l) => /^Unit [234]0\d\b/.test(l)));
    const unnamed = midPages.filter((pg) => !pg.some((l) => l.includes('13600 104 Ave')));
    const dangling = pages.filter((pg) => /^Unit \d+( Done| Try again)?$/.test(pg[pg.length - 1]) || /^Unit \d+( Done| Try again)?$/.test(pg[pg.length - 2] || '') && /^(Private|Page|\d+\/\d+)/.test(pg[pg.length - 1]));
    check(`6: the mid-rise over ${midPages.length} short pages: each names "13600 104 Ave", no unit's line ends a page without its people`,
      midPages.length >= 2 && unnamed.length === 0 && dangling.length === 0,
      JSON.stringify({ pages: pages.length, mid: midPages.length, unnamed: unnamed.map((pg) => pg.slice(0, 4)), dangling: dangling.map((pg) => pg.slice(-2)) }));
  } else check('6: pdftotext reads the short-page PDF', false, st.error?.message || st.stderr);
}

// ── Step 7: the profile and People search ──
if (want(7) && !BIG && !RED) {
  await D.go(`/people/${ben.id}`);
  await D.page.waitForSelector('main', { timeout: 8000 });
  await D.page.locator('button', { hasText: /^Details$/ }).first().click().catch(() => {});
  await sleep(800);
  const prof = await D.text('main');
  check('7: Ben\'s profile: "Basement suite · 10388 134 St" and "Also at this house: Main (1 person)"', /Basement suite · 10388 134 St/.test(prof) && /Also at this house: Main \(1 person\)/.test(prof), prof.slice(0, 300));
  await D.shot('07-profile-suite-desk');
  // One door, one wording (review 10): the duplex's Suite B reads "Suite B" in search as on its profile and walk list,
  // and Ana's main door "Main · 10388 134 St" as on her profile.
  const ivo = person('Ivo');
  await D.go(`/people/${ivo.id}`);
  await D.page.waitForSelector('main', { timeout: 8000 });
  await D.page.locator('button', { hasText: /^Details$/ }).first().click().catch(() => {});
  await sleep(800);
  const ivoProf = await D.text('main');
  check('7: Ivo\'s profile reads "Suite B · 10500 134 St"', /Suite B · 10500 134 St/.test(ivoProf) && !/Unit B/.test(ivoProf), ivoProf.slice(0, 300));
  const { ctx, H } = await asManager('phone', 'light');
  for (const [q, want7] of [
    ['13600 104', (t) => /Unit 201 · 13600 104 Ave/.test(t) && /Ana Placeholder/.test(t)],
    ['10388 134', (t) => /Ben Example/.test(t) && /Ana Example/.test(t) && /Basement suite · 10388 134 St/.test(t) && /Main · 10388 134 St/.test(t)],
    ['10500 134', (t) => /Suite B · 10500 134 St/.test(t) && /Suite A · 10500 134 St/.test(t) && !/Unit [AB] · 10500/.test(t)],
  ]) {
    await H.go(`/people?q=${encodeURIComponent(q)}`);
    await H.page.waitForSelector('.pp-row', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    const t = await H.text('main');
    check(`7: People search "${q}" finds the doors written with a unit or suite`, want7(t), t.slice(0, 240));
  }
  await H.shot('07-search-phone');
  await ctx.close();
}

// ── Step 10: the house pin follows the map's filter ──
if (want(10) && !BIG && !RED) {
  // Ana's main door Opposed, Ben's basement suite a Strong yes.
  const r1 = await D.api('/actions/contact.log', { person_id: ana.id, channel: 'phone', outcome: 'contacted', rating: '4' });
  const r2 = await D.api('/actions/contact.log', { person_id: ben.id, channel: 'phone', outcome: 'contacted', rating: '1' });
  const { ctx, H } = await asManager('desk', 'light');
  await mapAt(H, P.h10388, 19);
  const pinOf = () => H.page.evaluate((addr) => {
    const m = [...document.querySelectorAll('.leaflet-marker-icon')].find((x) => (x.getAttribute('title') || '').startsWith(addr));
    if (!m) return null;
    const pin = m.querySelector('.map-pin');
    const band = (/map-pin--(support|opposed|undecided|unrated)/.exec(pin?.className || '') || [])[1] || '';
    return { band, hh: m.querySelector('.map-pin__hh')?.innerText.trim() || '', more: Boolean(m.querySelector('.map-house__more')), tag: m.querySelector('.map-tag')?.innerText.trim() || '' };
  }, P.h10388.addr);
  const pick = async (label) => {
    await H.page.click('.map-filter-btn');
    await H.page.waitForSelector('.map-fsheet', { timeout: 5000 }).catch(() => {});
    await H.page.click(`.map-fsheet .map-fopt:has-text("${label}")`, { timeout: 5000 }).catch(() => {});
    await sleep(900);
  };
  const all = await pinOf();
  check('10: on All, 10388 is one pin in Main\'s colour (Opposed), 2 people, the door mark and "+ Basement suite"',
    r1.status === 200 && r2.status === 200 && all?.band === 'opposed' && all.hh === '2' && all.more && all.tag === '+ Basement suite', JSON.stringify(all));
  await pick('Yes (1–2)');
  const yes = await pinOf();
  check('10: on "Yes (1–2)" the pin is the basement suite\'s alone: Yes colour, no head count, no mark or tag for the hidden Main',
    yes?.band === 'support' && yes.hh === '' && !yes.more && yes.tag === '', JSON.stringify(yes));
  await H.shot('10-house-pin-filter-yes-desk');
  await pick('Opposed');
  const no = await pinOf();
  check('10: on "Opposed" the pin is Main\'s alone: Opposed colour, no mark or tag for the hidden suite',
    no?.band === 'opposed' && no.hh === '' && !no.more && no.tag === '', JSON.stringify(no));
  await ctx.close();
}

// ── BIG (review 6): the big-list paths ──
if (BIG) {
  const { ctx, H } = await asManager('phone', 'light');
  // B1: from a People search to the map: Ben's card has the door switch.
  await H.go(`/people?q=${encodeURIComponent('10388 134')}`);
  await H.page.waitForSelector('.pp-row', { timeout: 8000 }).catch(() => {});
  await H.page.locator('.pp-row', { hasText: 'Ben Example' }).first().click({ timeout: 5000 }).catch(() => {});
  await H.page.waitForSelector('a[href$="/map?person=' + ben.id + '"]', { timeout: 8000 }).catch(() => {});
  await H.page.locator(`a[href$="/map?person=${ben.id}"]`).first().click({ timeout: 5000 }).catch(() => {});
  await H.page.waitForSelector('.door-card .mapsheet-head', { timeout: 10000 }).catch(() => {});
  await sleep(800);
  const head = await cardHead(H);
  const sw = await switchOf(H.page);
  check('B1: from a People search, Ben\'s card (a big list: one door from the server) has the door switch, Basement suite pressed',
    /^Ben Example Basement suite · 10388 134 St\b/.test(head) && sw.length === 2 && sw[0].t.startsWith('Main') && sw[1].on && sw[1].t.startsWith('Basement suite'), `${head} · ${JSON.stringify(sw.map((b) => [b.t, b.on]))}`);
  await H.shot('B1-search-to-card-phone');
  // B2: the busy view's dots carry h and u.
  const dots = await H.api(`/map/doors?bbox=${[LAT - 0.002, LNG - 0.002, LAT + 0.003, LNG + 0.004].join(',')}&dots=1&rows=1`);
  const rowsOf = (j) => { const out = []; const walk = (x) => { if (Array.isArray(x)) { if (x.length >= 5 && x.every((v) => typeof v === 'number')) out.push(x); else x.forEach(walk); } else if (x && typeof x === 'object') Object.values(x).forEach(walk); }; walk(j); return out; };
  const dr = rowsOf(dots.json);
  const near = (d) => dr.filter((r) => Math.abs(r[0] - d.lat) < 1e-5 && Math.abs(r[1] - d.lng) < 1e-5);
  const dotH = (d) => near(d).map((r) => r[5]);
  const dotU = (d) => near(d).map((r) => r[4]);
  check('B2: the dots carry h: 2 at 10388, 3 at 10420, 2 at the duplex; u: 6 and 24 for the buildings, 1 at a house',
    dr.every((r) => r.length === 6) && dotH(P.h10388).join() === '2' && dotH(P.h10420).join() === '3' && dotH(P.duplex).join() === '2' && dotU(P.low).join() === '6' && dotU(P.mid).join() === '24' && dotU(P.h10388).join() === '1',
    JSON.stringify({ n: dr.length, h10388: near(P.h10388), h10420: near(P.h10420), duplex: near(P.duplex), low: near(P.low), mid: near(P.mid) }));
  // B2: the map draws dots; a tap on 10388's dot opens the house (first door not done).
  await H.page.keyboard.press('Escape');
  await sleep(500);
  await zoomTo(H.page, 17);
  await centre(H.page, P.h10388);
  const st = await until(H.page, (s) => s.view === 'dots', 10000);
  check('B2: the busy view draws lean dots', st.view === 'dots', JSON.stringify({ view: st.view, zoom: st.zoom }));
  await H.shot('B2-dots-phone');
  const [x, y] = pointOf(await mapState(H.page), P.h10388);
  await H.page.mouse.click(x, y);
  await H.page.waitForSelector('.door-switch__btn', { timeout: 8000 }).catch(() => {});
  await sleep(600);
  const sw2 = await switchOf(H.page);
  check('B2: a tap on 10388\'s dot opens the house on its first door (Main), with the switch', sw2.length === 2 && sw2[0].on && /^Main/.test(sw2[0].t), JSON.stringify(sw2.map((b) => [b.t, b.on])));
  await H.shot('B2-dot-to-card-phone');
  // B3: No answer at Main → Next: Basement suite.
  if (sw2.length === 2 && sw2[0].on) await step3(H, 'B3 phone');
  await ctx.close();
}

if (vctx) await vctx.close();
await dctx.close();
await browser.close();
if (!RED) check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (RED) {
  const oldFailed = olds.filter((r) => !r).length;
  console.log(`RED: ${failed} new checks failed; the old behaviour held in ${olds.length - oldFailed} of ${olds.length} checks`);
  if (oldFailed || !olds.length) { console.log('RED NOT PROVEN: an old-behaviour check failed'); process.exit(2); }
  process.exit(failed ? 1 : 0);
}
process.exit(failed ? 1 : 0);
