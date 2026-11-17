// Hi-rises E2E (HR-1) — one fresh in-memory campaign: a manager seeds a
// 210-unit tower (floors 2–22, ten units a floor, about 1.5 people a unit;
// half its rows with a Unit column and half written "1203-13450 104 Ave",
// unit 1203 both ways), a 200-unit tower 60 m away, a 60-unit townhouse
// complex (units 1–60), a house with a suite, a 4-unit conversion, and a
// turf around the first tower with a persuasion pass (one try). Made-up
// "Example" people only. Then, at 1440 × 900 and 390 × 844:
//   1  z17, z18, z19: each tower is ONE square ("210" / "200"), none of its
//      units drawn on its own; the house with a suite keeps two small pins;
//      the 4-unit conversion is a square.
//   2  (BUSY server, lean dots) z15 and z17: the tower is a square dot, a
//      tap on it opens the sheet; a tap on a plain spot still opens a door.
//   3  Tap the square: "210 units · 210 left", floors from Floor 2, only
//      Floor 2 open, unit 1203 one row, ?building=<id> and no address in the
//      URL; a reload opens it again.
//   4  Next unit · 201 → the card with "‹ 13450 104 Ave · Floor 2 · Unit 201";
//      No answer → "Next unit · 202" the one primary → 202; ‹ → "209 left".
//   5  The townhouse complex: one list, no floors, units 1–60 in order.
//   6  GOTV filter "Yes, not voted": the square's number is the units shown,
//      the sheet says "Showing: Yes, not voted · N of 210"; "All" → 210.
//   7  The walk list: the tower's units 201, 202, … floor by floor; a GOTV
//      pass with 3 supporters marked voted: still "210 units", those 3 "Not
//      on this round", "left" down by 3.
//   8  Offline (volunteer's phone, walk list kept): "Offline — from your walk
//      list" with counts; No answer at 201 → Next unit 202, "left" down one;
//      back online the knock syncs and the sheet agrees.
//   9  A volunteer without the turf (doors: turfs only): no square, 404 from
//      /buildings/of; the anchor merged away on the desk → reloading
//      ?building= says "This building isn’t here any more" and closes.
//   10 At most one yellow button per screen, targets ≥ 48 px at 390, no
//      sideways scroll, unit rows read out with unit and state.
// ONLY=1,3,4 runs just those (the BASE_PATH run); RED=1 runs 1, 3 and 7
// against a tree without buildings and expects them to fail.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5520 node server/index.js &
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory STARBASE_MAP_ALL=100 STARBASE_MAP_VIEW=100 PORT=5523 node server/index.js &
//   BASE=http://127.0.0.1:5520 BUSY=http://127.0.0.1:5523 SHOTS=/tmp/hr node e2e-highrise.mjs
//   (BASE_PATH=/imaginesurrey on 5521: BASE=http://127.0.0.1:5521 BP=/imaginesurrey ONLY=1,3,4 …)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const ORIGIN = process.env.BASE || 'http://127.0.0.1:5520';
const BUSY = process.env.BUSY || '';
const BP = process.env.BP || '';
const FIELD = BP ? `${BP}/field` : '';
const DESK = BP ? `${BP}/desk` : '/admin';
const SHOTS = process.env.SHOTS || '/tmp/starbase-highrise';
const RED = process.env.RED === '1';
mkdirSync(SHOTS, { recursive: true });
const ONLY = new Set(String(process.env.ONLY || (RED ? '1,3,7' : '')).split(',').map((x) => x.trim()).filter(Boolean));
const want = (n) => !ONLY.size || ONLY.has(String(n));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const tileSvg = (z, x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${((x * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
    lines.push(`<line x1="0" y1="${i}" x2="256" y2="${i}" stroke="#fff" stroke-width="${((y * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/>${lines.join('')}</svg>`;
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
const helpers = (page, who, origin = ORIGIN) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  return {
    page,
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    text: async (sel = 'body') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim(),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [`${BP}/api${path}`, body]),
    go: async (path, desk = !/vol/.test(who)) => { await page.goto(`${origin}${desk ? DESK : FIELD}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
  };
};

// ── The places (made up, in Surrey's grid) ──
const A = { lat: 49.18900, lng: -122.84800, addr: '13450 104 Ave' };
const B = { lat: 49.18900, lng: -122.84718, addr: '13480 104 Ave' }; // 60 m east
const TH = { lat: 49.19150, lng: -122.84800, addr: '10150 King George Blvd' };
const HS = { lat: 49.18800, lng: -122.84950, addr: '10388 134 St' };
const CV = { lat: 49.18700, lng: -122.84700, addr: '10295 135 St' };
const FIRST = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lea', 'Max', 'Nia', 'Oli', 'Pia', 'Raj', 'Sol', 'Tia', 'Uma'];
const towerUnits = (floors) => floors.flatMap((f) => Array.from({ length: 10 }, (_, i) => `${f}${String(i + 1).padStart(2, '0')}`));
const people = () => {
  const out = [];
  let k = 0;
  const who = () => `${FIRST[k % FIRST.length]} Example${Math.floor(k++ / FIRST.length) || ''}`;
  const unitsA = towerUnits(Array.from({ length: 21 }, (_, i) => i + 2)); // 201 … 2210
  unitsA.forEach((u, i) => {
    const hyphen = i % 2 === 1;
    const row = hyphen ? { address: `${u}-${A.addr}` } : { address: A.addr, unit: u };
    for (let n = 0; n < (i % 2 === 0 ? 2 : 1); n += 1) out.push({ tower: 'A', u, name: who(), city: 'Surrey', lat: A.lat, lng: A.lng, ...row });
    // 1203 written both ways.
    if (u === '1203') out.push({ tower: 'A', u, name: who(), city: 'Surrey', lat: A.lat, lng: A.lng, ...(hyphen ? { address: A.addr, unit: u } : { address: `${u}-${A.addr}` }) });
  });
  towerUnits(Array.from({ length: 20 }, (_, i) => i + 2)).forEach((u, i) => {
    for (let n = 0; n < (i % 2 === 0 ? 2 : 1); n += 1) out.push({ tower: 'B', u, name: who(), city: 'Surrey', lat: B.lat, lng: B.lng, address: B.addr, unit: u });
  });
  for (let u = 1; u <= 60; u += 1) out.push({ tower: 'TH', u: String(u), name: who(), city: 'Surrey', lat: TH.lat, lng: TH.lng, address: TH.addr, unit: String(u) });
  out.push({ tower: 'HS', u: '', name: who(), city: 'Surrey', lat: HS.lat, lng: HS.lng, address: HS.addr });
  out.push({ tower: 'HS', u: 'B', name: who(), city: 'Surrey', lat: HS.lat, lng: HS.lng, address: HS.addr, unit: 'B' });
  for (let u = 1; u <= 4; u += 1) out.push({ tower: 'CV', u: String(u), name: who(), city: 'Surrey', lat: CV.lat, lng: CV.lng, address: CV.addr, unit: String(u) });
  return out;
};

// A manager signs up and seeds everything; the supporters (floor 3 of the
// first tower) are rated before the pass, so the pass starts with every unit open.
const seed = async (D, label) => {
  await D.go('/signup', false);
  await D.page.fill('#su-name', 'Riley Manager');
  if (await D.page.locator('#su-org').count()) await D.page.fill('#su-org', 'Imagine Surrey');
  await D.page.fill('#su-email', `riley+${label}${tag}@highrise.example`);
  await D.page.fill('#su-password', 'surrey-forward-2026');
  await D.page.click('button[type="submit"]');
  await D.page.waitForURL(/\/(admin|desk)\/?$/, { timeout: 15000 });
  const list = people();
  const made = await D.page.evaluate(async ([rows, bp]) => {
    const out = [];
    for (let i = 0; i < rows.length; i += 25) {
      const part = await Promise.all(rows.slice(i, i + 25).map(async ({ tower, u, ...row }) => {
        const r = await fetch(`${bp}/api/actions/person.create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) });
        const j = await r.json().catch(() => ({}));
        return { id: j.person?.id, tower, u, name: row.name, address: row.address, unit: row.unit || '' };
      }));
      out.push(...part);
    }
    return out;
  }, [list, BP]);
  const supporters = made.filter((p) => p.tower === 'A' && /^3\d\d$/.test(p.u));
  const firstOf = new Map();
  for (const p of supporters) if (!firstOf.has(p.u)) firstOf.set(p.u, p);
  for (const p of firstOf.values()) await D.api('/actions/contact.log', { person_id: p.id, channel: 'phone', outcome: 'contacted', rating: '1' });
  const turf = (await D.api('/actions/turf.create', {
    name: 'The tower', polygon: [[A.lat - 0.0003, A.lng - 0.0003], [A.lat + 0.0003, A.lng - 0.0003], [A.lat + 0.0003, A.lng + 0.0003], [A.lat - 0.0003, A.lng + 0.0003]],
  })).json?.turf;
  const pass = (await D.api('/actions/pass.start', { name: 'Persuasion · towers', kind: 'persuasion', who: 'all', tries: 1 })).json?.pass;
  check(`${label}: seeded ${made.length} made-up people, a turf and a pass`, made.every((p) => p.id) && turf?.id && pass?.id, `${made.filter((p) => !p.id).length} failed`);
  return { made, turf, pass, supporters: [...firstOf.values()] };
};

// What the map says about itself (Map.jsx data-* and the markers).
const mapState = (page) => page.evaluate(() => {
  const el = document.querySelector('.map-canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const marks = [...el.querySelectorAll('.leaflet-marker-icon')].map((m) => ({ title: m.getAttribute('title') || '', bldg: Boolean(m.querySelector('.map-bldg')), n: m.querySelector('.map-bldg__n')?.innerText || '' }));
  return {
    zoom: Number(el.dataset.zoom), view: el.dataset.view || null, bounds: (el.dataset.bounds || '').split(',').map(Number),
    box: { x: r.x, y: r.y, w: r.width, h: r.height }, marks,
  };
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
const squares = (st, addr) => st.marks.filter((m) => m.bldg && m.title.startsWith(`${addr},`));
const pinsOf = (st, addr) => st.marks.filter((m) => !m.bldg && m.title.includes(addr));
// Simplicity: yellow buttons, sideways scroll, the smallest tap target.
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (targets) for (const el of document.querySelectorAll(targets)) { if (visible(el)) minTap = Math.min(minTap ?? 999, el.getBoundingClientRect().height); }
  return { yellow, overflow, minTap };
}, sel);
const simple = async (page, name, sel = null, phone = false) => {
  const mm = await measure(page, sel);
  check(`${name}: ≤ 1 yellow, no sideways scroll${sel && phone ? ', targets ≥ 48px' : ''}`, mm.yellow <= 1 && mm.overflow <= 0 && (!phone || mm.minTap == null || mm.minTap >= 47.5), JSON.stringify(mm));
};
const SHEET_TAPS = '.bldg-unit, .bldg-floor__head, .bldg-next, .bldg-back, .bldg-sheet .mapsheet-close';
const sheetText = (page) => page.$eval('.bldg-sheet:not([hidden])', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const countLine = (page) => page.$eval('.bldg-sheet .bldg-count__line', (el) => el.innerText.trim()).catch(() => '');
const leftOf = (line) => Number((/([\d,]+) left/.exec(line) || [])[1]?.replace(/,/g, '') ?? NaN);
const openFloor = async (page, label) => {
  const head = page.locator('.bldg-floor__head', { hasText: label }).first();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
};
const unitNos = (page) => page.$$eval('.bldg-sheet:not([hidden]) .bldg-unit__no', (els) => els.map((e) => e.innerText.trim()));
const tapSquare = async (page, addr) => {
  await page.locator(`.leaflet-marker-icon[title^="${addr}, building"]`).first().click();
  await page.waitForSelector('.bldg-sheet:not([hidden]) .bldg-count__line, .bldg-sheet:not([hidden]) .bldg-line', { timeout: 8000 }).catch(() => {});
  await sleep(400);
};
const dark = (scheme) => (scheme === 'dark' ? '-dark' : '');

// ── The desk: seed, then the map at 1440 × 900 ──
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const D = helpers(await dctx.newPage(), 'manager');
const S = await seed(D, 'main');
const anchorOf = (tower, u) => S.made.find((p) => p.tower === tower && p.u === u);
const aPerson = anchorOf('A', '1001');

// Step 1 at both sizes, light and dark.
const step1 = async (ctxOpts, size, scheme) => {
  const ctx = await browser.newContext({ ...ctxOpts, colorScheme: scheme, timezoneId: 'America/Vancouver' });
  await tiles(ctx);
  await ctx.addCookies(await dctx.cookies());
  const page = await ctx.newPage();
  const H = helpers(page, 'manager');
  await H.go(`/map?person=${aPerson.id}`);
  await until(page, (s) => s.zoom >= 16, 10000);
  await page.keyboard.press('Escape');
  await sleep(500);
  for (const z of [17, 18, 19]) {
    const st = await zoomTo(page, z);
    await sleep(700);
    const now = await mapState(page);
    const a = squares(now, A.addr);
    const ownA = pinsOf(now, A.addr).length;
    check(`1 ${size}${dark(scheme)} z${z}: tower 13450 is one square "210", none of its units drawn on its own`, a.length === 1 && a[0].n === '210' && ownA === 0,
      JSON.stringify({ zoom: st?.zoom, squares: a.map((m) => m.n), ownA, marks: now.marks.length }));
    const b = squares(now, B.addr);
    const [bx] = pointOf(now, B);
    if (bx > now.box.x && bx < now.box.x + now.box.w) {
      check(`1 ${size}${dark(scheme)} z${z}: the tower 60 m away is its own square "200"`, b.length === 1 && b[0].n === '200' && pinsOf(now, B.addr).length === 0, JSON.stringify(b));
    }
    if (z === 19) await H.shot(`01-tower-z19-${size}${dark(scheme)}`);
    if (z === 18) await H.shot(`01-two-towers-z18-${size}${dark(scheme)}`);
  }
  if (size === 'desk' && scheme === 'light') {
    await H.go(`/map?person=${anchorOf('HS', '').id}`);
    await until(page, (s) => s.zoom >= 16, 10000);
    await page.keyboard.press('Escape');
    const st = await zoomTo(page, 19);
    await sleep(600);
    const now = await mapState(page);
    check('1: the house with a suite keeps its two small pins', pinsOf(now, HS.addr).length === 2, JSON.stringify(pinsOf(now, HS.addr).map((m) => m.title)));
    const cv = squares(now, CV.addr);
    check('1: the 4-unit conversion is a square "4"', cv.length === 1 && cv[0].n === '4', JSON.stringify({ zoom: st?.zoom, cv }));
  }
  await ctx.close();
};
if (want(1)) {
  for (const scheme of ['light', 'dark']) {
    await step1({ viewport: { width: 1440, height: 900 } }, 'desk', scheme);
    await step1({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, 'phone', scheme);
  }
}

// Steps 3 and 4 on a phone (and 3 on the desk).
const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(pctx);
await pctx.addCookies(await dctx.cookies());
const MP = helpers(await pctx.newPage(), 'manager');
const mp = MP.page;
const openTowerOnMap = async (H, z = 18) => {
  await H.go(`/map?person=${aPerson.id}`);
  await until(H.page, (s) => s.zoom >= 16, 10000);
  await H.page.keyboard.press('Escape');
  await zoomTo(H.page, z);
  await sleep(600);
};
let anchorId = null;
if (want(3)) {
  for (const [H, size] of [[D, 'desk'], [MP, 'phone']]) {
    await openTowerOnMap(H);
    await tapSquare(H.page, A.addr);
    const line = await countLine(H.page);
    check(`3 ${size}: tap the square → "210 units · 210 left"`, line === '210 units · 210 left', line || await sheetText(H.page));
    const heads = await H.page.$$eval('.bldg-floor__head', (els) => els.map((e) => ({ t: e.innerText.replace(/\s+/g, ' ').trim(), open: e.getAttribute('aria-expanded') === 'true' })));
    check(`3 ${size}: floors from Floor 2, only Floor 2 open`, heads.length === 21 && /^Floor 2 · /.test(heads[0]?.t) && heads.filter((h) => h.open).length === 1 && heads[0].open, JSON.stringify(heads.slice(0, 3)));
    const url = new URL(H.page.url());
    anchorId = url.searchParams.get('building');
    check(`3 ${size}: the URL has ?building=<person id> and no address`, /^[0-9a-f-]{36}$/.test(anchorId || '') && !/104|Ave/i.test(decodeURIComponent(url.search)), url.search);
    await H.shot(`03-sheet-${size}`);
    await simple(H.page, `3 ${size}: the sheet`, SHEET_TAPS, size === 'phone');
    const labels = await H.page.$$eval('.bldg-sheet .bldg-unit', (els) => els.slice(0, 3).map((e) => e.getAttribute('aria-label')));
    check(`10 ${size}: unit rows read out with unit and state`, labels.length > 0 && labels.every((l) => /^Unit \d+, .+, (Open|Try again|Done|Not on this round)$/.test(l || '')), JSON.stringify(labels));
    await openFloor(H.page, 'Floor 12');
    const nos = await unitNos(H.page);
    check(`3 ${size}: unit 1203 (written two ways) is one row`, nos.filter((n) => n === '1203').length === 1, nos.filter((n) => /^12/.test(n)).join(','));
    await H.page.reload({ waitUntil: 'domcontentloaded' });
    await H.page.waitForSelector('.bldg-sheet .bldg-count__line', { timeout: 10000 }).catch(() => {});
    check(`3 ${size}: a reload opens the sheet again`, /^13450 104 Ave/.test(await H.text('.bldg-sheet .mapsheet-title')) && (await countLine(H.page)) === '210 units · 210 left', await countLine(H.page));
  }
}
if (want(4)) {
  if (!new URL(mp.url()).searchParams.get('building')) { await openTowerOnMap(MP); await tapSquare(mp, A.addr); }
  const next = await mp.$eval('.bldg-next', (el) => el.innerText.trim()).catch(() => '');
  check('4: the one primary reads "Next unit · 201"', next === 'Next unit · 201', next);
  await mp.click('.bldg-next');
  await mp.waitForSelector('.bldg-back', { timeout: 8000 }).catch(() => {});
  const bar = await MP.text('.bldg-back');
  check('4: the card for 201 with "‹ 13450 104 Ave · Floor 2 · Unit 201"', bar === '‹ 13450 104 Ave · Floor 2 · Unit 201', bar);
  check('4: before a knock nothing competes with the rating buttons (no Next unit)', !(await mp.$('.door-card .bldg-next')));
  await MP.shot('04-card-before-knock-phone');
  await mp.locator('.door-card .fk-out', { hasText: 'No answer' }).first().click();
  await mp.waitForSelector('.door-card .bldg-next', { timeout: 8000 }).catch(() => {});
  const n2 = await mp.$eval('.door-card .bldg-next', (el) => el.innerText.trim()).catch(() => '');
  check('4: No answer → "Next unit · 202" appears', n2 === 'Next unit · 202', n2);
  await simple(mp, '4 phone: the card after a knock (Next unit the one primary)', '.bldg-next, .bldg-back', true);
  await MP.shot('04-card-next-unit-phone');
  await mp.click('.door-card .bldg-next');
  await sleep(700);
  const bar2 = await MP.text('.bldg-back');
  check('4: Next unit → the card for 202', /Unit 202$/.test(bar2), bar2);
  await mp.click('.bldg-back');
  await mp.waitForSelector('.bldg-sheet:not([hidden])', { timeout: 5000 }).catch(() => {});
  await sleep(1200);
  const line = await countLine(mp);
  check('4: ‹ back to the sheet, now "209 left"', line === '210 units · 209 left', line);
  await MP.shot('04-sheet-after-phone');
  // Dark, desk: the card with its bar.
  const kctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'America/Vancouver' });
  await tiles(kctx);
  await kctx.addCookies(await dctx.cookies());
  const K = helpers(await kctx.newPage(), 'manager');
  const two02 = anchorOf('A', '202');
  await K.go(`/map?building=${new URL(mp.url()).searchParams.get('building')}`);
  await K.page.waitForSelector('.bldg-sheet .bldg-count__line', { timeout: 10000 }).catch(() => {});
  await K.shot('04-sheet-desk-dark');
  await K.page.locator('.bldg-unit', { hasText: '202' }).first().click();
  await K.page.waitForSelector('.bldg-back', { timeout: 8000 }).catch(() => {});
  await K.shot('04-card-bar-desk-dark');
  check('4 desk dark: a unit row opens its card with the bar', /Unit 202$/.test(await K.text('.bldg-back')) && Boolean(two02));
  await kctx.close();
}

// Step 5: the townhouse complex.
if (want(5)) {
  await D.go(`/map?building=${anchorOf('TH', '1').id}`);
  await D.page.waitForSelector('.bldg-sheet .bldg-count__line', { timeout: 10000 }).catch(() => {});
  const nos = await unitNos(D.page);
  check('5: the townhouse complex is one list, no floors, units 1–60 in order', !(await D.page.$('.bldg-floor')) && nos.join(',') === Array.from({ length: 60 }, (_, i) => String(i + 1)).join(','), nos.slice(0, 8).join(','));
  await D.shot('05-townhouses-desk');
}

// Step 6: the map's GOTV filter.
if (want(6)) {
  await D.api('/actions/vote.settings', { on: true });
  await openTowerOnMap(D);
  const st = await until(D.page, (s) => squares(s, A.addr).length === 1, 8000);
  const sq = squares(st, A.addr)[0];
  check('6: "Yes, not voted": the square counts the units shown (10 supporters)', sq?.n === '10', JSON.stringify(sq));
  await tapSquare(D.page, A.addr);
  const f = await D.text('.bldg-filter');
  check('6: the sheet says "Showing: Yes, not voted · 10 of 210" and lists only those', f === 'Showing: Yes, not voted · 10 of 210' && (await D.page.$$('.bldg-unit')).length <= 10, f);
  await D.shot('06-filter-line-desk');
  await D.page.click('.map-filter-btn');
  await D.page.click('.map-fopt[data-band="all"]');
  await sleep(600);
  await D.page.keyboard.press('Escape').catch(() => {});
  await sleep(400);
  const back = squares(await mapState(D.page), A.addr)[0];
  check('6: with "All" again the square says 210 and the line goes', back?.n === '210' && !(await D.page.$('.bldg-filter')), JSON.stringify(back));
  await D.api('/actions/vote.settings', { on: false });
}

// Step 8: offline, a volunteer with the turf, on a phone.
const invite = async (email) => (await D.api('/actions/member.invite', { email, role: 'volunteer' })).json;
const joinAs = async (H, inv, name) => {
  await H.go('/login');
  const j = await H.api('/auth/join', { token: inv.joinUrl.split('/').pop(), name, password: 'knock-knock-2026' });
  return { ok: j.status === 200, id: (await H.api('/auth/me')).json?.user?.id };
};
if (want(8) || want(7) || want(9)) await D.api('/actions/permission.doors.set', { scope: 'turfs' });
let V = null;
let vctx = null;
if (want(8) || want(7)) {
  vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', serviceWorkers: 'allow' });
  await tiles(vctx);
  V = helpers(await vctx.newPage(), 'vol');
  const j = await joinAs(V, await invite(`amrit+${tag}@highrise.example`), 'Amrit Volunteer');
  check('a volunteer joins and walks the tower’s turf', j.ok && (await D.api('/actions/turf.assign', { turf_id: S.turf.id, user_id: j.id })).status === 200);
}
if (want(8)) {
  // A fresh pass: every unit open again.
  await D.api('/actions/pass.start', { name: 'Persuasion · again', kind: 'persuasion', who: 'all', tries: 1 });
  const vp = V.page;
  await V.go(`/turfs/${S.turf.id}`);
  await vp.waitForSelector('.walk-door', { timeout: 10000 });
  await sleep(800);
  await V.go('/map');
  await until(vp, (s) => s.zoom > 0, 8000);
  await vctx.setOffline(true);
  await vp.evaluate(() => window.dispatchEvent(new Event('offline')));
  await sleep(400);
  await zoomTo(vp, 18);
  await sleep(600);
  await tapSquare(vp, A.addr);
  const chip = await V.text('.bldg-offline');
  const line = await countLine(vp);
  check('8: offline, the sheet comes from the walk list kept on the phone, with counts', chip === 'Offline — from your walk list' && line === '210 units · 210 left', `${chip} · ${line}`);
  await V.shot('08-offline-sheet-phone');
  await vp.click('.bldg-next');
  await vp.waitForSelector('.bldg-back', { timeout: 8000 }).catch(() => {});
  check('8: Next unit opens 201 with no signal', /Unit 201$/.test(await V.text('.bldg-back')), await V.text('.bldg-back'));
  await vp.locator('.door-card .fk-out', { hasText: 'No answer' }).first().click();
  await vp.waitForSelector('.door-card .bldg-next', { timeout: 8000 }).catch(() => {});
  const n2 = await vp.$eval('.door-card .bldg-next', (el) => el.innerText.trim()).catch(() => '');
  check('8: offline knock → Next unit goes to 202', n2 === 'Next unit · 202', n2);
  await vp.click('.bldg-back');
  await sleep(500);
  const line2 = await countLine(vp);
  check('8: …and "left" drops by one', line2 === '210 units · 209 left', line2);
  await V.shot('08-offline-after-knock-phone');
  await vctx.setOffline(false);
  await vp.evaluate(() => window.dispatchEvent(new Event('online')));
  let synced = false;
  for (let i = 0; i < 30 && !synced; i += 1) {
    await sleep(500);
    const r = await D.api(`/buildings/of/${anchorOf('A', '201').id}`);
    synced = r.json?.building?.open === 209;
  }
  check('8: back online the knock syncs (the server says 209 open)', synced);
  await sleep(1500);
  const line3 = await countLine(vp);
  check('8: …and the sheet agrees', line3 === '210 units · 209 left' && !(await vp.$('.bldg-offline')), line3);
}

// Step 7: the walk list, then a GOTV pass.
if (want(7)) {
  const vp = V.page;
  await V.go(`/turfs/${S.turf.id}`);
  await vp.waitForSelector('.walk-door', { timeout: 10000 });
  const heads = await vp.$$eval('.walk-door__addr', (els) => els.map((e) => e.innerText.trim()));
  const units = heads.map((h) => (/^(\d+)/.exec(h) || [])[1]).filter(Boolean);
  const expect = towerUnits([2, 3]).flatMap((u) => [u]);
  const firstTwenty = [...new Set(units)].slice(0, 20);
  check('7: the walk list takes the tower floor by floor: 201, 202, … 310', firstTwenty.join(',') === expect.join(','), firstTwenty.join(','));
  await V.shot('07-walk-list-phone');
  const nextBtn = await V.text('.walk-next__addr');
  check('7: Next door walks them in that order', /^20[12]\b/.test(nextBtn), nextBtn);
  if (!RED) {
    await D.api('/actions/pass.start', { name: 'GOTV · towers', kind: 'gotv', who: 'support', tries: 2 });
    const before = (await D.api(`/buildings/of/${anchorOf('A', '201').id}`)).json?.building;
    const three = S.supporters.slice(0, 3);
    for (const p of three) await D.api('/actions/vote.mark', { person_id: p.id, voted: true, source: 'desk' });
    await D.go(`/map?building=${anchorOf('A', '201').id}`);
    await D.page.waitForSelector('.bldg-sheet .bldg-count__line', { timeout: 10000 }).catch(() => {});
    await openFloor(D.page, 'Floor 3');
    const line = await countLine(D.page);
    const off = await D.page.$$eval('.bldg-sheet .bldg-unit', (els) => els.map((e) => e.getAttribute('aria-label')).filter((l) => /^Unit 3\d\d,.*Not on this round$/.test(l || '')));
    const offSupporters = three.filter((p) => off.some((l) => l.startsWith(`Unit ${p.u},`)));
    check('7: GOTV pass, 3 supporters voted: still "210 units", those 3 "Not on this round", left down by 3',
      /^210 units · /.test(line) && offSupporters.length === 3 && leftOf(line) === before.open - 3, `${line} · before open ${before?.open} · ${offSupporters.length}`);
    await D.shot('07-gotv-sheet-desk');
    await D.api('/actions/pass.start', { name: 'Persuasion · last', kind: 'persuasion', who: 'all', tries: 1 });
  }
}

// Step 9: a volunteer without the turf; the anchor merged away.
if (want(9)) {
  const wctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
  await tiles(wctx);
  const W = helpers(await wctx.newPage(), 'vol2');
  const j = await joinAs(W, await invite(`bo+${tag}@highrise.example`), 'Bo Volunteer');
  await W.go(`/map?person=${aPerson.id}`);
  await sleep(1500);
  const st = await mapState(W.page);
  const of = await W.api(`/buildings/of/${aPerson.id}`);
  check('9: a volunteer without the turf: no square for the tower, /buildings/of answers 404', j.ok && squares(st || { marks: [] }, A.addr).length === 0 && of.status === 404, `${of.status} ${of.raw?.slice(0, 80)}`);
  await wctx.close();
  const anchor = anchorOf('A', '201');
  const merged = await D.api('/actions/person.merge', { keep: anchorOf('HS', '').id, drop: anchor.id });
  await D.go(`/map?building=${anchor.id}`);
  await D.page.waitForSelector('.map-toast', { timeout: 8000 }).catch(() => {});
  const toast = await D.text('.map-toast');
  await sleep(500);
  check('9: the anchor merged away → "This building isn’t here any more", and the sheet closes',
    merged.status === 200 && /This building isn’t here any more/.test(toast) && !(await D.page.$('.bldg-sheet')) && !new URL(D.page.url()).searchParams.get('building'), `${merged.status} · ${toast}`);
}

// Step 2: the busy view (lean dots), on its own server.
if (want(2) && BUSY) {
  const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver' });
  await tiles(bctx);
  const Bz = helpers(await bctx.newPage(), 'manager', BUSY);
  const SB = await seed(Bz, 'busy');
  const bp = Bz.page;
  const tower = SB.made.find((p) => p.tower === 'A' && p.u === '1001');
  const house = SB.made.find((p) => p.tower === 'HS');
  for (const z of [17, 15]) {
    await Bz.go(`/map?person=${tower.id}`);
    await until(bp, (s) => s.zoom >= 16, 10000);
    await bp.keyboard.press('Escape');
    await sleep(500);
    await zoomTo(bp, z);
    const st = await until(bp, (s) => s.view === 'dots', 10000);
    check(`2 z${z}: a busy view draws lean dots`, st.view === 'dots', JSON.stringify({ view: st.view, zoom: st.zoom }));
    await sleep(800);
    await Bz.shot(`02-busy-square-dot-z${z}`);
    const [x, y] = pointOf(await mapState(bp), A);
    const asked = bp.waitForResponse((r) => /\/api\/buildings\/at\?/.test(r.url()), { timeout: 8000 }).catch(() => null);
    await bp.mouse.click(x, y);
    const res = await asked;
    await bp.waitForSelector('.bldg-sheet .bldg-count__line', { timeout: 8000 }).catch(() => {});
    check(`2 z${z}: a tap on the square dot opens the building's sheet`, Boolean(res) && /^210 units/.test(await countLine(bp)), await countLine(bp));
    await bp.keyboard.press('Escape');
    await sleep(400);
    if (z === 17) {
      const [hx, hy] = pointOf(await mapState(bp), HS);
      await bp.mouse.click(hx, hy);
      await bp.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
      check('2: a tap on a plain spot still opens its door (openSpot)', /10388 134 St/.test(await Bz.text('aside.door-card')) && !(await bp.$('.bldg-sheet')), (await Bz.text('aside.door-card')).slice(0, 60));
      await bp.keyboard.press('Escape');
    }
  }
  check('2: seeded the busy server too', Boolean(house));
  await bctx.close();
}

if (vctx) await vctx.close();
await pctx.close();
await dctx.close();
await browser.close();
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed${RED ? ' (RED: these are expected to fail on a tree without buildings)' : ''}`);
process.exit(failed ? 1 : 0);
