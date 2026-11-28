// Buildings and suites, before and after (UNITS §10): the owner's pictures,
// drawn by the code itself. Run once on a checkout of main ("before") and
// once on this branch ("after"): each run starts that checkout's server on
// PORT with Imagine Surrey's look and an in-memory list, signs up a manager,
// imports the same made-up list through /api/data/import (the CSV of
// e2e-units.mjs, plus a 120-unit tower), makes a turf with a persuasion
// pass, and saves, at 390 × 844 (phone) and 1440 × 900 (computer):
//   map        the map with a tower, a low-rise, and houses with a basement suite
//   map-house  (phone) close in on 10388 134 St, the house with a basement suite
//   walk-list  the door list (the walk list) at the house, and at the mid-rise
//   card       the door card of 10388 134 St (after: the door switch)
//   knock      (phone) No answer at the main door: what the card offers next
//   building   the mid-rise's building sheet
//   print      the printed walking list (and its PDF's first page, Letter)
//   profile    (computer) Ben Example's profile, the basement suite's person
// Every name and address is made up. Nothing is looked up (the list has
// its own pins) and the street map is a drawn grid, not real streets.
//
//   (in each checkout) npm run build
//   ROOT=<checkout> WHEN=before|after PORT=5495 OUT=<dir> node scripts/units-before-after.mjs
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bothNames } from '../shared/old-names.js';

// Each setting under every name it has had (main reads only the older ones).
const underBoth = (o) => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => bothNames(k).map((n) => [n, v])));
const ROOT = process.env.ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const WHEN = process.env.WHEN === 'before' ? 'before' : 'after';
const PORT = Number(process.env.PORT) || 5495;
const OUT = process.env.OUT || '/tmp/units-before-after';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = `http://127.0.0.1:${PORT}`;
const DESK = `${BASE}/admin`;
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The list (made up, on Surrey's grid; the same as e2e-units.mjs) ──
const LAT = 49.18800;
const LNG = -122.84950;
const LOT = 0.000135; // about 15 m
const P = {
  h10388: { lat: LAT, lng: LNG },
  h10400: { lat: LAT + LOT, lng: LNG },
  h10420: { lat: LAT + 6 * LOT, lng: LNG },
  duplex: { lat: LAT + 10 * LOT, lng: LNG },
  h13450A: { lat: LAT - 4 * LOT, lng: LNG + 0.0006 },
  h13450: { lat: LAT - 4 * LOT, lng: LNG + 0.0009 },
  low: { lat: LAT - 4 * LOT, lng: LNG + 0.0015 },
  mid: { lat: LAT - 4 * LOT, lng: LNG + 0.0025 },
  tower: { lat: LAT + 5 * LOT, lng: LNG + 0.0018 },
};
const FIRST = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lea', 'Max', 'Nia', 'Oli', 'Pia', 'Raj', 'Sol', 'Tia', 'Uma', 'Vic', 'Wes', 'Xia', 'Yan'];
const MID_UNITS = [2, 3, 4].flatMap((f) => Array.from({ length: 8 }, (_, i) => `${f}0${i + 1}`));
// The tower: floors 2–13, ten units a floor; half its rows with a Unit
// column, half written "1203-13700 104 Ave".
const TOWER_UNITS = Array.from({ length: 12 }, (_, i) => i + 2).flatMap((f) => Array.from({ length: 10 }, (_, i) => `${f}${String(i + 1).padStart(2, '0')}`));
const row = (first, last, address, unit, at) => ({ first, last, address, unit, city: 'Surrey', lat: at.lat, lng: at.lng });
const ROWS = [
  row('Ana', 'Example', '10388 134 St', '', P.h10388),
  row('Ben', 'Example', '10388 134 St Bsmt', '', P.h10388),
  row('Cy', 'Example', '10400 134 St', '', P.h10400),
  row('Dee', 'Example', '10400 134 St', 'Bsmt', P.h10400),
  row('Eli', 'Example', '10420 134 St', '', P.h10420),
  row('Fay', 'Example', '10420 134 St', 'Coach house', P.h10420),
  row('Gus', 'Example', '10420 134 St', 'Upper', P.h10420),
  row('Hana', 'Example', 'A-10500 134 St', '', P.duplex),
  row('Ivo', 'Example', 'B-10500 134 St', '', P.duplex),
  row('Jun', 'Example', '13450A 104 Ave', '', P.h13450A),
  row('Kai', 'Example', '13450 104 Ave', '', P.h13450),
  ...Array.from({ length: 6 }, (_, i) => row(FIRST[i], 'Sample', `Ste 10${i + 1} 13520 104 Ave`, '', P.low)),
  ...MID_UNITS.map((u, i) => row(FIRST[i], 'Placeholder', `#${u}-13600 104 Ave`, '', P.mid)),
  ...TOWER_UNITS.map((u, i) => (i % 2
    ? row(FIRST[i % FIRST.length], `Demo${Math.floor(i / FIRST.length) || ''}`, `${u}-13700 104 Ave`, '', P.tower)
    : row(FIRST[i % FIRST.length], `Demo${Math.floor(i / FIRST.length) || ''}`, '13700 104 Ave', u, P.tower))),
];

// A drawn street grid (each tile its own, so the map never takes it for a
// provider's notice), with a few park patches.
const tileSvg = (z, x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${i % 128 === 0 ? 6 : 2}"/>`);
    lines.push(`<line x1="0" y1="${i}" x2="256" y2="${i}" stroke="#fff" stroke-width="${i % 128 === 0 ? 6 : 2}"/>`);
  }
  const park = (x * 7 + y * 13 + z) % 5 === 0 ? `<rect x="${(x * 37) % 4 * 64 + 4}" y="${(y * 53) % 4 * 64 + 4}" width="56" height="56" fill="#d5e5c8"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><desc>${z}/${x}/${y}</desc><rect width="256" height="256" fill="#ebe7dc"/>${park}${lines.join('')}</svg>`;
};
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) => {
  const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg(+z, +x, +y) });
});

// ── The server ──
let server;
let serverLog = '';
const stop = () => { try { server?.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });
async function startServer() {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), GEOCODE_ON_SAVE: 'off', ...underBoth({ BASE_OPEN_SIGNUP: '1', BASE_DATA: 'memory', BASE_BRAND: 'imagine-surrey' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${BASE}/signup`)).ok) return; } catch { /* not up yet */ }
    if (i > 120) throw new Error(`the server didn't start on ${PORT}\n${serverLog.slice(-2000)}`);
    await sleep(500);
  }
}

// ── The map, read from the page ──
const mapState = (page) => page.evaluate(() => {
  const el = document.querySelector('.map-canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { zoom: Number(el.dataset.zoom), bounds: (el.dataset.bounds || '').split(',').map(Number), box: { x: r.x, y: r.y, w: r.width, h: r.height } };
});
const zoomTo = async (page, z) => {
  for (let i = 0; i < 8; i += 1) {
    const st = await mapState(page);
    if (!st || Math.round(st.zoom) === z) return;
    await page.click(st.zoom < z ? '.leaflet-control-zoom-in' : '.leaflet-control-zoom-out');
    await sleep(900);
  }
};
const merc = (lat) => Math.asinh(Math.tan((lat * Math.PI) / 180));
const pointOf = (st, d) => {
  const [s, w, n, e] = st.bounds;
  return [st.box.x + ((d.lng - w) / (e - w)) * st.box.w, st.box.y + ((merc(n) - merc(d.lat)) / (merc(n) - merc(s))) * st.box.h];
};
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
  await sleep(700);
};

const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desk: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
const index = [];
let failed = false;
let browser;
let cookies;
let ids;
let turfId;
let buildingId;

async function seed() {
  const ctx = await browser.newContext({ ...SIZES.desk, timezoneId: 'America/Vancouver' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Riley Manager');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
  await page.fill('#su-email', `riley.${Date.now()}@units.example`);
  await page.fill('#su-password', 'surrey-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 30000 });
  const call = (path, body) => page.evaluate(async ([p, b]) => {
    const r = await fetch(`/api${p}`, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, body]);
  const imp = await call('/data/import', { rows: ROWS });
  if (imp.status !== 200) throw new Error(`import: ${imp.status} ${JSON.stringify(imp.json).slice(0, 300)}`);
  const people = (await call('/persons?limit=500')).json?.persons || [];
  if (people.length !== ROWS.length) throw new Error(`import saved ${people.length} of ${ROWS.length}`);
  ids = Object.fromEntries(people.map((p) => [p.name, p.id]));
  const turf = (await call('/actions/turf.create', {
    name: 'Example block', polygon: [[LAT - 0.001, LNG - 0.001], [LAT + 0.002, LNG - 0.001], [LAT + 0.002, LNG + 0.0035], [LAT - 0.001, LNG + 0.0035]],
  })).json?.turf;
  await call('/actions/pass.start', { name: 'Persuasion · November', kind: 'persuasion', who: 'all', tries: 2 });
  turfId = turf.id;
  buildingId = ids['Ana Placeholder'];
  // Give the server a moment to work out the doors (this branch does it in
  // the background after the import; main has nothing to wait for).
  for (let i = 0; i < 40; i += 1) {
    const w = (await call(`/turfs/${turfId}/walk`)).json;
    if (WHEN === 'before' || (w?.doors || []).some((d) => d.place === 'building')) break;
    await sleep(500);
  }
  cookies = await ctx.cookies();
  await ctx.close();
  log(`seeded ${people.length} made-up people`);
}

async function open(size, scheme = 'light') {
  const ctx = await browser.newContext({ ...SIZES[size], colorScheme: scheme, timezoneId: 'America/Vancouver', reducedMotion: 'reduce' });
  await tiles(ctx);
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { failed = true; log(`FAIL  page error (${size}): ${e.message}`); });
  return { ctx, page };
}
async function shot(page, n, name, size, caption, opts = {}) {
  const file = `${n}-${name}-${size}-${WHEN}.png`;
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (over > 0) log(`note  ${file} scrolls sideways by ${over}px`);
  await sleep(300);
  await page.screenshot({ path: join(OUT, file), fullPage: Boolean(opts.full) });
  index.push({ n, name, size, file, caption });
  log(`saved ${file}`);
}
// The map at a place: open a lone door by link, close its card, centre, zoom.
async function mapAt(page, place, z) {
  await page.goto(`${DESK}/map?person=${ids['Kai Example']}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.map-canvas', { timeout: 15000 });
  await sleep(1500);
  await page.keyboard.press('Escape');
  await sleep(500);
  await zoomTo(page, Math.min(z, 18));
  await centre(page, place);
  await zoomTo(page, z);
  if (z > 18) await centre(page, place);
  await sleep(1200);
}
// Scroll so the first of `sel` that holds `words` sits `gap` px under the
// top of the screen.
async function toTop(page, sel, words, gap) {
  await page.evaluate(([s, w, g]) => {
    const el = [...document.querySelectorAll(s)].find((x) => x.innerText.includes(w));
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - g);
  }, [sel, words, gap]);
  await sleep(600);
}
async function openHouse(page) {
  await mapAt(page, P.h10388, 18);
  // The main door's pin (before), or the house's one pin (after).
  const pin = page.locator('.leaflet-marker-icon[title^="10388 134 St"]').filter({ hasNotText: 'Bsmt' });
  const exact = page.locator('.leaflet-marker-icon[title^="10388 134 St,"], .leaflet-marker-icon[title^="10388 134 St —"]').first();
  await ((await exact.count()) ? exact : pin.first()).click({ timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.door-card .mapsheet-head', { timeout: 8000 }).catch(() => {});
  await sleep(900);
}

async function shoot() {
  // 1–2: the map.
  {
    const { ctx, page } = await open('desk');
    await mapAt(page, { lat: LAT + 2 * LOT, lng: LNG + 0.0013 }, 17);
    await shot(page, '01', 'map', 'desk', 'The map, 1440 wide, zoom 17: the tower (13700 104 Ave), the mid-rise (13600), the low-rise (13520), and the houses on 134 St with their suites.');
    await zoomTo(page, 18);
    await centre(page, { lat: LAT + 3 * LOT, lng: LNG + 0.0009 });
    await shot(page, '02', 'map-close', 'desk', 'The map, 1440 wide, zoom 18.');
    await ctx.close();
  }
  {
    const { ctx, page } = await open('phone');
    await mapAt(page, { lat: LAT + 2 * LOT, lng: LNG + 0.0012 }, 17);
    await shot(page, '01', 'map', 'phone', 'The map on a phone, zoom 17: the tower, the mid-rise, the low-rise and the houses.');
    await mapAt(page, { lat: LAT + 0.5 * LOT, lng: LNG }, 19);
    await shot(page, '03', 'map-house', 'phone', 'Close in on 10388 134 St (a main door and a basement suite) and 10400 134 St next door (the same).');
    await ctx.close();
  }
  // 4: the walk list (the door list).
  for (const size of ['phone', 'desk']) {
    const { ctx, page } = await open(size);
    await page.goto(`${DESK}/turfs/${turfId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.walk-door', { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    await toTop(page, '.walk-doors > li', '10388 134 St', 160);
    await shot(page, '04', 'walk-list-house', size, 'The walk list at 10388 134 St.');
    await toTop(page, '.walk-doors > li', '13600 104 Ave', 160);
    await shot(page, '05', 'walk-list-building', size, 'The walk list at the mid-rise, 13600 104 Ave.');
    await ctx.close();
  }
  // 6: the door card.
  for (const [size, scheme] of [['phone', 'light'], ['desk', 'light'], ['phone', 'dark']]) {
    const { ctx, page } = await open(size, scheme);
    await openHouse(page);
    await shot(page, '06', `card-house${scheme === 'dark' ? '-dark' : ''}`, size, `The door card of 10388 134 St${scheme === 'dark' ? ', dark' : ''}.`);
    await ctx.close();
  }
  // 7: the building sheet.
  for (const size of ['phone', 'desk']) {
    const { ctx, page } = await open(size);
    await page.goto(`${DESK}/map?building=${buildingId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bldg-sheet .bldg-count__line, .bldg-sheet .bldg-line', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    await shot(page, '07', 'building', size, 'The mid-rise’s building sheet (13600 104 Ave).');
    await ctx.close();
  }
  // 8: the printed walking list.
  for (const size of ['phone', 'desk']) {
    const { ctx, page } = await open(size);
    await page.goto(`${DESK}/reports/walk?turf=${turfId}&doors=all`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ws-sheet', { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    await toTop(page, '.ws-sheet tbody', '10388 134 St', 260);
    await shot(page, '08', 'print', size, 'The printed walking list, as the screen shows it, at 10388 134 St.');
    if (size === 'desk') {
      await page.emulateMedia({ media: 'print' });
      const pdf = join(OUT, `08-print-letter-${WHEN}.pdf`);
      await page.pdf({ path: pdf, format: 'Letter' });
      await page.emulateMedia({ media: 'screen' });
      // Each page of the PDF as a picture (Letter, 100 dpi): the page with
      // 10388 134 St on it.
      mkdirSync(join(OUT, 'pdf-pages'), { recursive: true });
      const prefix = join(OUT, 'pdf-pages', `08-print-letter-${WHEN}-p`);
      const r = spawnSync('pdftoppm', ['-png', '-r', '100', pdf, prefix], { encoding: 'utf8' });
      if (r.status !== 0) { failed = true; log(`FAIL  pdftoppm: ${r.stderr || r.error?.message}`); } else {
        const t = spawnSync('pdftotext', [pdf, '-'], { encoding: 'utf8' }).stdout || '';
        const pages = t.split('\f');
        const at = Math.max(0, pages.findIndex((pg) => pg.includes('10388 134 St')));
        const n = String(at + 1).padStart(String(pages.length - 1).length, '0');
        const found = `${prefix}-${n}.png`;
        const file = `08-print-pdf-desk-${WHEN}.png`;
        spawnSync('cp', [found, join(OUT, file)]);
        index.push({ n: '08', name: 'print-pdf', size: 'desk', file, caption: `The printed walking list’s PDF (Letter), page ${at + 1}: the page with 10388 134 St.` });
        log(`saved ${file} (page ${at + 1})`);
        const first = `08-print-pdf-page1-desk-${WHEN}.png`;
        spawnSync('cp', [`${prefix}-${'1'.padStart(String(pages.length - 1).length, '0')}.png`, join(OUT, first)]);
        index.push({ n: '08', name: 'print-pdf-page1', size: 'desk', file: first, caption: 'The printed walking list’s PDF (Letter), page 1.' });
        log(`saved ${first}`);
      }
    }
    await ctx.close();
  }
  // 9: the profile of the basement suite's person.
  {
    const { ctx, page } = await open('desk');
    await page.goto(`${DESK}/people/${ids['Ben Example']}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main', { timeout: 15000 });
    await sleep(1200);
    await page.locator('button', { hasText: /^Details$/ }).first().click().catch(() => {});
    await sleep(800);
    await shot(page, '09', 'profile', 'desk', 'Ben Example’s profile (the basement suite at 10388 134 St).');
    await ctx.close();
  }
  // 10: a knock at the main door (last: it changes the list).
  {
    const { ctx, page } = await open('phone');
    await openHouse(page);
    await page.locator('.door-card .fk-out', { hasText: 'No answer' }).first().click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
    await shot(page, '10', 'card-after-knock', 'phone', 'No answer at 10388’s main door: what the card offers next.');
    await ctx.close();
  }
}

try {
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  await startServer();
  await seed();
  await shoot();
  const lines = [
    `# ${WHEN === 'before' ? 'Before (main)' : 'After (this branch)'}`,
    '',
    '| # | Picture | Size | File |',
    '|---|---|---|---|',
    ...index.map((r) => `| ${r.n} | ${r.caption} | ${r.size === 'phone' ? '390×844' : '1440×900'} | ${r.file} |`),
    '',
  ];
  writeFileSync(join(OUT, `index-${WHEN}.md`), lines.join('\n'));
  log(`${index.length} screenshots and index-${WHEN}.md in ${OUT}`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  stop();
}
process.exit(failed ? 1 : 0);
