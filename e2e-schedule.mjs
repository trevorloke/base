// Scheduling without a keyboard E2E — a fresh in-memory campaign, a stand-in
// for the BC Address Geocoder and one for the texting provider (the real
// ones are never asked). A manager at a desk (1440×900) opens Shifts → Week
// on next week: the week says "Loading…" and "Unavailable — Try again"
// rather than drawing empty days; then seven day lists, a "+" on each.
// "+" opens the one add sheet and a week is made by tap alone — Burma Shave
// 6:30–8:30 am on the five weekdays at a corner picked on the map and named
// by the server, Mainstreet on two mornings, a morning and an afternoon
// canvass on a turf, a phone bank at another time, a repeating office shift
// — with not one key pressed and no text field ever focused. No shift is
// given a number nobody asked for: a card says who is on it, and "3 of 4"
// only once a target is tapped under More. A point nothing could name reads
// "Pinned place", with "Name it". A card's sheet moves a shift to another
// day, changes its hours, tells the people on it, puts it on the website,
// calls it off, and changes or ends "this and the following" of a repeating
// slot; a card dragged to another day moves, with Undo. A name tapped in
// the people strip stays in hand from card to card; someone who signed up on
// the website is there. "More" tells everyone on the week's shifts (the
// count first), turns the evening reminders on and off, and copies the week
// to the next; an empty week offers "Copy last week". At 1440×900 and at
// 1280×800 a card's kind reads on one line. A laptop on Toronto time shows
// the same hours — on the week, the List, a shift's page, both forms, the
// roster and the crew board. Then the same on a phone (390×844): one day
// with a day strip, the sheets from the bottom, "People" a sheet, 48px
// targets, no sideways scroll. Last, a volunteer on a phone: the list a day
// a heading, "Count me in" on the row, a warning that never refuses, the
// place's map, and a Mainstreet shift that opens Mainstreeting with its
// place filled in. Every claim on a screen is checked against the API, and
// the books verify.
//
//   (cd web && npm run build)
//   PORT=4900 SHOTS=/tmp/schedule node e2e-schedule.mjs
// It starts its own server on PORT, with its stand-ins on PORT+1 and PORT+2.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addDays, dayOf, instantOf, weekBounds, weekStart } from './shared/dayparts.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4900;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-schedule';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
};

// ── The stand-in address service: what the nearest corner or door is said
// to be is set by the test (geo.mode), so each naming rule can be met ──
const geo = { mode: 'corner', asked: [] };
const geocoder = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  geo.asked.push(u.pathname);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (geo.mode === 'down') return send(503, { error: 'down' });
  if (u.pathname === '/intersections/nearest.json' && geo.mode === 'corner') {
    return send(200, { type: 'Feature', properties: { intersectionName: 'King George Blvd and 88 Ave', degree: 4 } });
  }
  if (u.pathname === '/sites/nearest.json' && geo.mode === 'address') {
    return send(200, { type: 'Feature', properties: { civicNumber: 13450, streetName: '72', streetType: 'Ave', fullAddress: '13450 72 Ave, Surrey, BC' } });
  }
  return send(200, { type: 'FeatureCollection', features: [] });
});
await new Promise((r) => geocoder.listen(PORT + 1, '127.0.0.1', r));

// ── The stand-in texting provider: records every text, accepts each one ──
const texts = [];
const twilio = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    texts.push(Object.fromEntries(new URLSearchParams(body)));
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: `SMe2e${tag}${texts.length}`, status: 'queued' }));
  });
});
await new Promise((r) => twilio.listen(PORT + 2, '127.0.0.1', r));

// ── The server, fresh and in memory ──
const serverLog = [];
const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT),
  GEOCODER: 'bc', BC_GEOCODER_URL: `http://127.0.0.1:${PORT + 1}`,
  TWILIO_ACCOUNT_SID: 'ACe2eschedule', TWILIO_AUTH_TOKEN: `token-${tag}`, TWILIO_FROM: '+16045550100', TWILIO_API_BASE: `http://127.0.0.1:${PORT + 2}` };
for (const k of ['RESEND_API_KEY', 'MAIL_FROM', 'DATABASE_URL', 'STARBASE_JOBS', 'BC_GEOCODER_KEY']) delete env[k];
const server = spawn(process.execPath, ['server/index.js'], { cwd: HERE, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => serverLog.push(String(d)));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`server did not start: ${serverLog.join('')}`)), 30000);
  server.stdout.on('data', (d) => { if (/starbase on/.test(String(d))) { clearTimeout(t); resolve(); } });
  server.once('exit', (code) => { clearTimeout(t); reject(new Error(`server exited ${code}: ${serverLog.join('')}`)); });
});
// Whatever ends this run, the server goes with it.
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(1));
const stop = async () => {
  await new Promise((r) => { if (server.exitCode !== null) { r(); return; } server.removeAllListeners('exit'); server.once('exit', r); server.kill('SIGTERM'); });
  geocoder.close();
  twilio.close();
};

const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/><path d="M0 128h256M128 0v256" stroke="#fff" stroke-width="6"/></svg>';
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg }));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const wire = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, [path, body]),
    shot: (n, full = false) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full }),
    text: async (sel = 'body') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim(),
    go: async (path) => { await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); },
    // Count what a keyboard would do from here on: keys pressed, and any
    // text field taking the focus (on a phone that is the keyboard coming up).
    watchKeys: () => page.evaluate(() => {
      window.__keys = 0;
      window.__fields = [];
      if (window.__watching) return;
      window.__watching = true;
      document.addEventListener('keydown', () => { window.__keys += 1; }, true);
      document.addEventListener('focusin', (e) => {
        if (e.target?.matches?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable="true"]')) window.__fields.push(e.target.id || e.target.className);
      }, true);
    }),
    keys: () => page.evaluate(() => ({ keys: window.__keys, fields: window.__fields, now: document.activeElement?.tagName })),
  };
};
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).map((el) => el.innerText.trim());
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null; let minWho = '';
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const h = Math.min(r.height, 999);
      if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 80); }
    }
  }
  return { yellow, overflow, minTap, minWho };
}, sel);
const SHEET_TARGETS = '.sch-sheet .sch-tile, .sch-sheet .sch-chip, .sch-sheet .btn, .sch-sheet .disclose, .sch-sheet .ops-seg button';

// The campaign's days (B.C.'s clock, by the rule the app applies): next week.
const today = dayOf(new Date());
const MON = addDays(weekStart(today), 7);
const D7 = Array.from({ length: 7 }, (_, i) => addDays(MON, i));
const [mon, tue, wed, thu, fri, sat, sun] = D7;
const dayNum = (d) => String(Number(d.slice(8)));
const md = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const wd = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'short' });
const iso = (v) => new Date(v).toISOString();
const at = (day, clock) => iso(instantOf(day, clock));

try {
  // ── 1. A manager; turfs, volunteers, an election day six weeks on ──
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', locale: 'en-CA' });
  await tiles(desk);
  const page = await desk.newPage();
  const D = wire(page, 'desk');
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Priya Example');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
  await page.fill('#su-email', `priya+${tag}@example.org`);
  await page.fill('#su-password', 'surrey-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 20000 });

  const lat = 49.1327; const lng = -122.855;
  const square = (d) => [[lat + d + 0.001, lng - 0.001], [lat + d + 0.001, lng + 0.002], [lat + d - 0.001, lng + 0.002], [lat + d - 0.001, lng - 0.001]];
  for (const [name, d] of [['Newton block', 0.01], ['Fleetwood loop', 0.02]]) await D.api('/actions/turf.create', { name, polygon: square(d) });
  const P = {};
  for (const [key, name, role, phone] of [['asha', 'Asha Example', 'burmashave', '604-555-0101'], ['ben', 'Ben Example', 'burmashave', '604-555-0102'],
    ['cam', 'Cam Example', 'mainstreeting', '604-555-0103'], ['dee', 'Dee Example', 'doorknocking', '604-555-0104']]) {
    P[key] = (await D.api('/actions/person.create', { name, phone })).json.person;
    await D.api('/actions/volunteer.assign', { person_id: P[key].id, role });
  }
  const electionDay = addDays(MON, 6 * 7 + 5);
  check('set-up: an election day six weeks on', (await D.api('/actions/vote.settings', { on: false, election_day: electionDay })).status === 200);
  // A shift two months back, for the List's "Past shifts".
  const bbqDay = addDays(today, -60);
  check('set-up: a shift two months ago', (await D.api('/actions/shift.create', { title: 'Summer BBQ', starts_at: at(bbqDay, '16:00'), ends_at: at(bbqDay, '18:00') })).status === 200);
  // Texts may go at any hour, so the notices below don't depend on the time of day.
  check('set-up: texting hours open', (await D.api('/actions/texting.settings', { allow_from: 0, allow_until: 24, weekend_from: 0, weekend_until: 24 })).status === 200);

  const board = async (monday = MON) => {
    const b = weekBounds(monday);
    return (await D.api(`/shifts/board?from=${encodeURIComponent(b.from)}&to=${encodeURIComponent(b.to)}`)).json;
  };
  const cards = (day) => page.$$eval(`.sch-day[data-day="${day}"] .sch-card`, (els) => els.map((el) => ({
    id: el.dataset.shift, kind: el.dataset.kind,
    title: el.querySelector('.sch-card__title')?.innerText.trim(), place: el.querySelector('.sch-card__place')?.innerText.trim() || null,
    time: el.querySelector('.sch-card__time')?.innerText.trim(), count: el.querySelector('.sb-cap')?.innerText.trim() ?? null,
    part: (() => { let n = el.closest('.sch-list')?.previousElementSibling; return n?.innerText.trim() || null; })(),
    turfs: [...el.querySelectorAll('.st-chip')].map((c) => c.innerText.trim()), people: [...el.querySelectorAll('.sb-chip__name')].map((c) => c.innerText.trim()),
  })));
  const toast = async () => (await page.locator('.sb-toast').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const plus = (day) => page.locator(`.sch-day[data-day="${day}"] .sch-plus`);
  const tile = (label) => page.locator(`.sch-sheet .sch-tile:has-text("${label}")`);
  const chip = (label) => page.locator(`.sch-sheet .sch-chip:has-text("${label}")`);
  const dayChip = (day) => page.locator(`.sch-sheet .sch-daychip:has(b:text-is("${dayNum(day)}"))`);
  const pressed = (loc) => loc.first().getAttribute('aria-pressed').then((v) => v === 'true').catch(() => false);
  const go = page.locator('.sch-sheet .sch-go');
  const sheetGone = () => until(async () => (await page.locator('.sch-sheet').count()) === 0);
  // The kinds on cards that take more than one line (none should, at a desk).
  const wrappedKinds = (pg) => pg.$$eval('.sch-card__title', (els) => els
    .filter((el) => el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 1.5).map((el) => el.innerText.trim()));
  const longDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  // A day's heading on the list: next Monday is "Tomorrow" when this runs on a Sunday.
  const headOf = (d) => (d === addDays(today, 1) ? 'Tomorrow' : longDay(d));
  const openCard = async (id) => { await page.locator(`.sch-card[data-shift="${id}"] .sch-card__head`).click(); await page.waitForSelector('.sch-sheet', { timeout: 8000 }); };

  // ── 2. Honest states: a week that hasn't loaded, or can't, never shows as empty days ──
  let hold = null; let fail = false;
  await page.route(/\/api\/shifts\/board/, async (route) => {
    if (fail) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"database is busy"}' }); return; }
    if (hold) await hold;
    await route.continue();
  });
  let release; hold = new Promise((r) => { release = r; });
  await D.go(`/shifts?week=${MON}`);
  await page.waitForSelector('.sb-week', { timeout: 10000 });
  await sleep(400);
  let body = await D.text('main.page');
  check('while the week loads: "Loading…", and no day is drawn', /Loading…/.test(body) && (await page.locator('.sch-day').count()) === 0 && !/No shifts/.test(body), body.slice(0, 160));
  await D.shot('01-week-loading-1440');
  release(); hold = null;
  await page.waitForSelector('.sch-day', { timeout: 10000 });
  fail = true;
  await page.locator('.sb-nav[aria-label="Next week"]').click();
  await until(async () => /Unavailable/.test(await D.text('main.page')));
  body = await D.text('main.page');
  check('a week that can’t be read: "Unavailable" and "Try again", no empty days', /Unavailable/.test(body) && (await page.locator('.sch-day').count()) === 0
    && !/No shifts/.test(body) && (await page.locator('.sch-unavailable button:has-text("Try again")').count()) === 1, body.slice(0, 200));
  await D.shot('02-week-unavailable-1440');
  fail = false;
  await page.locator('.sch-unavailable button:has-text("Try again")').click();
  await page.waitForSelector('.sch-day', { timeout: 10000 });
  check('Try again loads it', (await page.locator('.sch-day').count()) === 7);
  await page.unroute(/\/api\/shifts\/board/);

  // "Plan one" on Today and the roster's "New shift" open the same sheet as the page's own "New shift" — never a form to type in.
  await D.go('/');
  const planOne = page.locator('a:has-text("Plan one")').first();
  await planOne.waitFor({ timeout: 15000 });
  await planOne.click();
  await page.waitForSelector('.sch-sheet .sch-tile', { timeout: 10000 });
  check('Today’s "Plan one" opens the add sheet on the week', (await D.text('.sch-sheet h2')) === 'Add shifts' && new URL(page.url()).pathname === '/admin/shifts'
    && new URL(page.url()).searchParams.get('add') === '1' && (await page.locator('form[aria-label="New shift"]').count()) === 0, page.url());
  await D.go('/shifts/volunteers?show=all');
  await page.waitForSelector('.vl-rows .ops-item', { timeout: 10000 });
  const ashaItem = page.locator('.vl-rows .ops-item:has-text("Asha Example")');
  await ashaItem.locator('.ops-row').click();
  await ashaItem.locator('button:has-text("Put on a shift")').click();
  await ashaItem.locator('a:has-text("New shift")').click();
  await page.waitForSelector('.sch-sheet .sch-tile', { timeout: 10000 });
  check('the roster’s "New shift" (no shifts ahead) opens it too', (await D.text('.sch-sheet h2')) === 'Add shifts' && new URL(page.url()).searchParams.get('add') === '1');

  // ── 3. Next week, empty: seven days, a "+" on each, nothing to copy yet ──
  await D.go(`/shifts?week=${MON}`);
  await page.waitForSelector('.sch-day', { timeout: 10000 });
  body = await D.text('main.page');
  const heads = await page.$$eval('.sch-day__name', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('seven days across, Monday first', heads.length === 7 && heads[0] === `${wd(mon)} ${dayNum(mon)}` && heads[6] === `${wd(sun)} ${dayNum(sun)}`, heads.join(' | '));
  check('a "+" on every day', (await page.locator('.sch-day .sch-plus').count()) === 7);
  check('an empty week says so — and offers no copy when last week had nothing', /No shifts this week yet\./.test(body) && !/Copy last week/.test(body), body.slice(0, 200));
  let mm = await measure(page);
  check('the week (1440): one main button, no sideways scroll', mm.yellow.join('|') === 'New shift' && mm.overflow <= 0, JSON.stringify(mm));
  await D.shot('03-week-empty-1440');

  // ── 4. "+" on Monday: the add sheet. Burma Shave on the five weekdays, at a corner picked on the map ──
  await D.watchKeys();
  await plus(mon).click();
  await page.waitForSelector('.sch-sheet', { timeout: 8000 });
  check('the sheet opens with the focus on its title, not in a text field', await page.evaluate(() => document.activeElement?.tagName === 'H2' && document.activeElement.innerText === 'Add shifts'));
  const tileWords = await page.$$eval('.sch-sheet .sch-tile', (els) => els.map((e) => e.innerText.trim()));
  check('What: a tile a kind', tileWords.join('|') === 'Canvass|Phone bank|Mainstreet|Burma Shave|Lit drop|Signs|Event|Office|Other', tileWords.join('|'));
  check('nothing else is asked before a kind is picked', (await page.locator('.sch-sheet .sch-sec').count()) === 1 && await go.isDisabled());
  mm = await measure(page);
  check('with the sheet open its button is the one main button', mm.yellow.join('|') === 'Add shifts', JSON.stringify(mm.yellow));
  await D.shot('04-add-what-1440');
  await tile('Burma Shave').click();
  await page.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  const secs = await page.$$eval('.sch-sheet .sch-label', (els) => els.map((e) => e.innerText.trim()));
  check('then: Where · Which days · When · Repeat', secs.join('|') === 'What|Where|Which days|When|Repeat', secs.join('|'));
  check('its usual hours are already chosen: 6:30–8:30 am (4–6 pm offered)', await pressed(chip('6:30–8:30 am')) && !(await pressed(chip('4–6 pm'))));
  check('the day whose "+" was tapped is chosen', await pressed(dayChip(mon)) && !(await pressed(dayChip(tue))));
  check('"Just this week" is chosen; the button says what it will make', await pressed(chip('Just this week')) && (await go.innerText()).trim() === 'Add 1 shift', await go.innerText());
  check('"Every week until election day" is offered, with its date', (await chip('Every week until election day').innerText().catch(() => '')).includes(md(electionDay)));

  // Where: no places yet — pick on the map; the server names the point.
  geo.mode = 'corner';
  await chip('Pick on the map').click();
  await page.waitForSelector('.sch-map__box.leaflet-container', { timeout: 15000 });
  await sleep(500);
  check('the map asks for a tap', /Tap where it is\./.test(await D.text('.sch-pick')));
  let box = await page.locator('.sch-map__box').boundingBox();
  await page.mouse.click(box.x + box.width / 2 + 30, box.y + box.height / 2 - 20);
  await until(async () => (await page.locator('.sch-named__name').count()) === 1);
  check('a tapped point is named by its corner: "King George Blvd & 88 Ave"', (await D.text('.sch-named__name')) === 'King George Blvd & 88 Ave', await D.text('.sch-named'));
  await D.shot('05-add-map-named-1440');
  await page.locator('.sch-pick button:has-text("Use this place")').click();
  await until(async () => pressed(chip('King George Blvd & 88 Ave')));
  check('one tap accepts: the place is chosen, the map is put away', await pressed(chip('King George Blvd & 88 Ave')) && (await page.locator('.sch-map__box').count()) === 0);
  const saved = (await D.api('/places?kind=burma_shave')).json.places;
  check('server: the place is saved with its pin', saved.length === 1 && saved[0].name === 'King George Blvd & 88 Ave' && saved[0].source === 'map'
    && Math.abs(saved[0].lat - 49.15) < 0.05 && Math.abs(saved[0].lng + 122.85) < 0.05, JSON.stringify(saved));

  await chip('Weekdays').click();
  check('"Weekdays": Monday to Friday, five shifts', (await go.innerText()).trim() === 'Add 5 shifts' && await pressed(dayChip(fri)) && !(await pressed(dayChip(sat))));
  check('the sheet says what it will add', (await D.text('.sch-summary')) === 'Burma Shave — King George Blvd & 88 Ave · Mon–Fri · 6:30–8:30 am', await D.text('.sch-summary'));
  await chip('Every week for 4 weeks').click();
  check('every week for 4 weeks: twenty', (await go.innerText()).trim() === 'Add 20 shifts');
  await chip('Every week until election day').click();
  check('until election day: every weekday on or before it', (await go.innerText()).trim() === 'Add 35 shifts', await go.innerText());
  await chip('Just this week').click();
  mm = await measure(page, SHEET_TARGETS);
  check('the add sheet (1440): one main button, no sideways scroll', mm.yellow.join('|') === 'Add 5 shifts' && mm.overflow <= 0, JSON.stringify(mm));
  await D.shot('06-add-burma-ready-1440');
  await go.click();
  await sheetGone();
  await until(async () => (await page.locator('.sch-card').count()) === 5);
  check('"Add 5 shifts": the sheet closes, the week says so', /^5 shifts added$/.test(await toast()), await toast());
  let k = await D.keys();
  check('five shifts made with no key pressed and no text field focused', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));
  check('…on the same screen, the same week', new URL(page.url()).pathname === '/admin/shifts' && new URL(page.url()).searchParams.get('week') === MON && !new URL(page.url()).searchParams.has('add'), page.url());
  let b = await board();
  const burma = b.shifts.filter((s) => s.kind === 'burma_shave');
  check('server: five Burma Shaves, 6:30–8:30 on the campaign’s clock, named by kind and place — and no number nobody asked for',
    burma.length === 5 && burma.every((s, i) => iso(s.starts_at) === at(D7[i], '06:30') && iso(s.ends_at) === at(D7[i], '08:30')
      && s.title === 'Burma Shave — King George Blvd & 88 Ave' && s.need === null && s.capacity === null && s.place_id === saved[0].id && s.series_id === null),
    JSON.stringify(burma.map((s) => [s.starts_at, s.title, s.need, s.capacity])));
  const monCards = await cards(mon);
  check('a card: the kind, the place, the hours, under "Early" — and no number on it: nobody is on it, nothing was asked for',
    monCards.length === 1 && monCards[0].title === 'Burma Shave' && monCards[0].place === 'King George Blvd & 88 Ave' && monCards[0].time === '6:30–8:30 am'
    && monCards[0].count === null && monCards[0].part === 'Early' && monCards[0].kind === 'burma_shave' && !/\d of \d/.test(await D.text('.sch-days')), JSON.stringify(monCards));

  // ── 5. Mainstreet on Tuesday and Thursday, at a point the address service can't name ──
  await plus(tue).click();
  await page.waitForSelector('.sch-sheet .sch-tile', { timeout: 8000 });
  await tile('Mainstreet').click();
  await page.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  check('Mainstreet’s usual hours: 7–9 am chosen (4:30–6:30 pm offered)', await pressed(chip('7–9 am')) && (await chip('4:30–6:30 pm').count()) === 1);
  check('a place used before is a chip', (await chip('King George Blvd & 88 Ave').count()) === 1 && !(await pressed(chip('King George Blvd & 88 Ave'))));
  geo.mode = 'down';
  await chip('Pick on the map').click();
  await page.waitForSelector('.sch-map__box.leaflet-container', { timeout: 15000 });
  await sleep(500);
  box = await page.locator('.sch-map__box').boundingBox();
  await page.mouse.click(box.x + box.width / 2 - 60, box.y + box.height / 2 + 40);
  await until(async () => (await page.locator('.sch-named__name').count()) === 1);
  const pinName = await D.text('.sch-named__name');
  const pinWhere = await D.text('.sch-named__where');
  check('with the address service down the point is "Pinned place" — its coordinates beneath, never its name — with "Name it"', pinName === 'Pinned place'
    && /^49\.\d{4}, −122\.\d{4} — /.test(pinWhere) && (await page.locator('.sch-pick button:has-text("Name it")').count()) === 1, `${pinName} | ${pinWhere}`);
  await D.shot('05b-add-map-pinned-1440');
  await page.locator('.sch-pick button:has-text("Use this place")').click();
  await until(async () => pressed(chip('Pinned place')));
  check('the chosen chip says "Pinned place"; where it is and "Name it" sit under it', await pressed(chip('Pinned place'))
    && /^Pinned place · 49\.\d{4}, −122\.\d{4}$/.test(await D.text('.sch-pinned .sch-note')) && (await page.locator('.sch-pinned button:has-text("Name it")').count()) === 1, await D.text('.sch-pinned'));
  await dayChip(thu).click();
  check('Tuesday and Thursday: two', (await go.innerText()).trim() === 'Add 2 shifts' && (await D.text('.sch-summary')).includes(`${wd(tue)}, ${wd(thu)}`), await D.text('.sch-summary'));
  await go.click();
  await sheetGone();
  await until(async () => (await page.locator('.sch-card').count()) === 7);
  const tueCards = await cards(tue);
  check('Tuesday: Burma Shave 6:30 then Mainstreet 7:00, both under "Early"; the Mainstreet is at "Pinned place", with no number', tueCards.map((c) => `${c.title} ${c.time} ${c.part}`).join(' | ')
    === 'Burma Shave 6:30–8:30 am Early | Mainstreet 7–9 am Early' && tueCards[1].count === null && tueCards[1].place === 'Pinned place', JSON.stringify(tueCards));
  const pinned = (await D.api(`/shifts/${tueCards[1].id}`)).json.shift;
  check('server: its name says "Pinned place"; the coordinates stay its words and its pin; no target', pinned.title === 'Mainstreet — Pinned place' && /^Pin at 49\.\d{4}, −122\.\d{4}$/.test(pinned.location)
    && Math.abs(pinned.place_lat - 49.15) < 0.05 && pinned.need === null, JSON.stringify([pinned.title, pinned.location, pinned.place_lat, pinned.need]));

  // ── 6. A morning and an afternoon canvass on Saturday: the turf is the place ──
  await plus(sat).click();
  await page.waitForSelector('.sch-sheet .sch-tile', { timeout: 8000 });
  await tile('Canvass').click();
  await page.waitForSelector('.sch-sheet [aria-label="Turfs"] .sch-chip', { timeout: 10000 });
  const turfChips = await page.$$eval('.sch-sheet [aria-label="Turfs"] .sch-chip', (els) => els.map((e) => e.innerText.trim()));
  check('Where, for a canvass: the campaign’s turfs first', turfChips.join('|') === 'Newton block|Fleetwood loop', turfChips.join('|'));
  await chip('Newton block').click();
  await chip('2–5 pm').click();
  check('10–1 and 2–5 on one day: two shifts, named for the turf', (await go.innerText()).trim() === 'Add 2 shifts'
    && (await D.text('.sch-summary')) === `Canvass — Newton block · ${wd(sat)}, ${md(sat)} · 10 am–1 pm and 2–5 pm`, await D.text('.sch-summary'));
  await D.shot('07-add-canvass-turf-1440');
  await go.click();
  await sheetGone();
  await until(async () => (await page.locator('.sch-card').count()) === 9);
  const satCards = await cards(sat);
  check('Saturday: a morning and an afternoon canvass, each with its turf chip',
    satCards.map((c) => `${c.title}/${c.place}/${c.time}/${c.part}/${c.turfs.join('+')}`).join(' | ')
    === 'Canvass/Newton block/10 am–1 pm/Morning/Newton block | Canvass/Newton block/2–5 pm/Afternoon/Newton block', JSON.stringify(satCards));
  const carried = (await D.api('/shiftturfs')).json.shifts;
  check('server: both carry the walk list', satCards.every((c) => (carried[c.id] || []).map((t) => t.name).join() === 'Newton block'));

  // ── 7. A phone bank on Wednesday at another time: 6:30 pm for an hour and a half ──
  await plus(wed).click();
  await page.waitForSelector('.sch-sheet .sch-tile', { timeout: 8000 });
  await tile('Phone bank').click();
  await page.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  await chip('6–8 pm').click();
  check('with no time chosen there is nothing to add', await go.isDisabled() && (await go.innerText()).trim() === 'Add shifts');
  await chip('Another time').click();
  await page.locator('.sch-sheet .sch-parts button:has-text("Evening")').click();
  const starts = await page.$$eval('.sch-sheet [aria-label="Starts at"] .sch-chip', (els) => els.map((e) => e.innerText.trim()));
  check('another time: a start every half hour of the evening', starts.join('|') === '5 pm|5:30 pm|6 pm|6:30 pm|7 pm|7:30 pm|8 pm|8:30 pm|9 pm|9:30 pm', starts.join('|'));
  await page.locator('.sch-sheet [aria-label="Starts at"] .sch-chip:text-is("6:30 pm")').click();
  await page.locator('.sch-sheet [aria-label="How long"] .sch-chip:text-is("1½ h")').click();
  check('…and a length: 6:30–8 pm', (await D.text('.sch-summary')) === `Phone bank · ${wd(wed)}, ${md(wed)} · 6:30–8 pm`, await D.text('.sch-summary'));
  await page.locator('.sch-sheet .sch-parts button:has-text("Early")').click();
  const early = await page.$$eval('.sch-sheet [aria-label="Starts at"] .sch-chip', (els) => els.map((e) => e.innerText.trim()));
  check('the early starts: 6:00 to 8:30 am', early.join('|') === '6 am|6:30 am|7 am|7:30 am|8 am|8:30 am', early.join('|'));
  await D.shot('08-add-another-time-1440');
  await go.click();
  await sheetGone();
  await until(async () => (await page.locator('.sch-card').count()) === 10);
  const wedCards = await cards(wed);
  check('Wednesday: the phone bank under "Evening", after the early Burma Shave', wedCards.map((c) => `${c.title} ${c.time} ${c.part}`).join(' | ')
    === 'Burma Shave 6:30–8:30 am Early | Phone bank 6:30–8 pm Evening' && wedCards[1].count === null && wedCards[1].place === null, JSON.stringify(wedCards));
  k = await D.keys();
  check('ten shifts on the week — still no key pressed, no text field focused', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));

  // Each day is its own list: both early cards at the top of their days, and Wednesday's evening straight under its early one.
  const tops = await page.evaluate(([m, t, w]) => {
    const box = (day, i) => document.querySelectorAll(`.sch-day[data-day="${day}"] .sch-card`)[i]?.getBoundingClientRect();
    const col = (day) => document.querySelector(`.sch-day[data-day="${day}"]`).getBoundingClientRect();
    return { mon: box(m, 0).top, tue: box(t, 0).top, wedEarlyEnd: box(w, 0).bottom, wedEve: box(w, 1).top, monCol: col(m).bottom, wedCol: col(w).bottom };
  }, [mon, tue, wed]);
  check('each day is a list from the top: no rows held open for other days; the columns end together', Math.abs(tops.mon - tops.tue) < 1.5
    && tops.wedEve - tops.wedEarlyEnd > 0 && tops.wedEve - tops.wedEarlyEnd < 48 && Math.abs(tops.monCol - tops.wedCol) < 1.5, JSON.stringify(tops));
  mm = await measure(page);
  check('the full week (1440): one main button, no sideways scroll', mm.yellow.join('|') === 'New shift' && mm.overflow <= 0, JSON.stringify(mm));
  const dayWide = await page.locator(`.sch-day[data-day="${mon}"]`).evaluate((el) => el.getBoundingClientRect().width);
  check('1440×900: the days have the width — every card’s kind ("Burma Shave", "Phone bank") reads on one line', (await wrappedKinds(page)).length === 0 && dayWide >= 150,
    `${Math.round(dayWide)}px · wrapped: ${(await wrappedKinds(page)).join(', ')}`);
  check('the people are a strip across the top, not a column beside the week', await page.evaluate(() => {
    const t = document.querySelector('.sb-tray').getBoundingClientRect(); const d = document.querySelector('.sch-days').getBoundingClientRect();
    return t.bottom <= d.top && Math.abs(t.width - d.width) < 2;
  }));
  await D.shot('09-week-ten-shifts-1440');

  // ── 8. "New shift" is the same sheet; a repeating office shift; "More" holds what is typed ──
  await page.locator('.ops-head button:has-text("New shift")').click();
  await page.waitForSelector('.sch-sheet .sch-tile', { timeout: 8000 });
  await tile('Office').click();
  await page.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  check('opened from "New shift" no day is chosen yet', (await page.locator('.sch-sheet .sch-daychip[aria-pressed="true"]').count()) === 0 && await go.isDisabled());
  await dayChip(mon).click();
  await chip('Every week for 4 weeks').click();
  check('Office 9–12 on Monday, every week for 4 weeks: four', (await go.innerText()).trim() === 'Add 4 shifts'
    && (await D.text('.sch-summary')) === `Office · ${wd(mon)}, ${md(mon)} · 9 am–12 pm · every week for 4 weeks`, await D.text('.sch-summary'));
  k = await D.keys();
  check('…and still nothing typed', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));
  await page.locator('.sch-sheet .sch-more').click();
  const moreWords = await D.text('.sch-more__body');
  check('"More" holds what is typed or rare', ['Name', 'Instructions', 'Link', 'We need', 'Limit sign-ups to', 'Show on the website', 'More options'].every((w) => moreWords.includes(w)), moreWords.slice(0, 200));
  check('"More options" is the long form', (await page.locator('.sch-more__body a:has-text("More options")').getAttribute('href')) === '/admin/shifts?new=1');
  check('nothing asks how many people; a limit is there to set, empty', (await page.inputValue('#sch-capacity')) === '' && (await page.getAttribute('#sch-capacity', 'placeholder')) === 'No limit'
    && !/How many/.test(await D.text('.sch-sheet')));
  check('"We need" is chips, "No target" pressed: a number is only ever tapped', await pressed(page.locator('.sch-sheet [aria-label="We need"] .sch-chip:text-is("No target")'))
    && (await page.locator('#sch-need').count()) === 0 && (await D.text('.sch-sheet .sch-chips[aria-label="We need"]')) === 'No target 1 2 3 4 5 6 8 10', await D.text('.sch-sheet .sch-chips[aria-label="We need"]'));
  await page.fill('#sch-name', 'Front desk');
  await page.locator('.sch-sheet [aria-label="We need"] .sch-chip:text-is("2")').click();
  await page.locator('.sch-more__body .ops-check input').check();
  await D.shot('10-add-more-1440', true);
  await go.click();
  await sheetGone();
  await until(async () => /added/.test(await toast()));
  check('four made, one of them this week', (await toast()) === '4 shifts added — 1 this week', await toast());
  b = await board();
  const office = b.shifts.find((s) => s.kind === 'office');
  check('server: the typed name is kept, with its target, on the website, a repeating slot',
    office?.title === 'Front desk' && office.need === 2 && office.public === true && Boolean(office.series_id) && iso(office.starts_at) === at(mon, '09:00'), JSON.stringify(office));
  const officeNext = (await board(addDays(MON, 7))).shifts.filter((s) => s.series_id === office.series_id);
  check('server: the same slot next week', officeNext.length === 1 && iso(officeNext[0].starts_at) === at(addDays(mon, 7), '09:00'));

  // ── 9. A card's sheet: move the phone bank to Thursday in three taps ──
  const phone = wedCards[1];
  await D.watchKeys();
  await openCard(phone.id);
  check('a card opens its sheet on the same screen', (await D.text('.sch-sheet h2')) === 'Phone bank' && new URL(page.url()).pathname === '/admin/shifts'
    && (await D.text('.sch-sheet__sub')) === `${wd(wed)}, ${md(wed)} · 6:30–8 pm`, await D.text('.sch-sheet__sub'));
  check('its day and its own time are the ones pressed', await pressed(dayChip(wed)) && await pressed(chip('Another time'))
    && await pressed(page.locator('.sch-sheet [aria-label="Starts at"] .sch-chip:text-is("6:30 pm")')) && await pressed(page.locator('.sch-sheet [aria-label="How long"] .sch-chip:text-is("1½ h")')));
  check('Save waits for a change', await go.isDisabled() && (await go.innerText()).trim() === 'Save');
  mm = await measure(page, SHEET_TARGETS);
  check('the card’s sheet (1440): one main button, no sideways scroll', mm.yellow.join('|') === 'Save' && mm.overflow <= 0, JSON.stringify(mm));
  await D.shot('11-card-sheet-1440');
  await dayChip(thu).click();
  await go.click();
  await sheetGone();
  await until(async () => (await cards(thu)).some((c) => c.id === phone.id));
  check('Thursday chip, Save: the card is under Thursday, the week stays put', (await cards(thu)).some((c) => c.id === phone.id && c.time === '6:30–8 pm')
    && !(await cards(wed)).some((c) => c.id === phone.id) && (await toast()) === 'Saved' && new URL(page.url()).searchParams.get('week') === MON, await toast());
  let ph = (await D.api(`/shifts/${phone.id}`)).json.shift;
  check('server: the same hours on Thursday', iso(ph.starts_at) === at(thu, '18:30') && iso(ph.ends_at) === at(thu, '20:00'), `${ph.starts_at} ${ph.ends_at}`);
  k = await D.keys();
  check('moved without a key', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));

  // ── 10. Or drag the card to another day; Undo puts it back ──
  const dragTo = async (id, day) => {
    const from = await page.locator(`.sch-card[data-shift="${id}"] .sch-card__head`).boundingBox();
    const to = await page.locator(`.sch-day[data-day="${day}"]`).boundingBox();
    await page.mouse.move(from.x + 30, from.y + 14);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 24, { steps: 3 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height - 20, { steps: 8 });
    await sleep(150);
  };
  await dragTo(phone.id, fri);
  check('a card in hand: the day under it lights up', (await page.locator(`.sch-day[data-day="${fri}"][data-hot]`).count()) === 1 && (await page.locator('.sb-ghost:not([hidden])').innerText()) === 'Phone bank');
  await D.shot('12-dragging-card-1440');
  await page.mouse.up();
  await until(async () => /moved to/.test(await toast()));
  check('dropped on Friday: moved, with Undo', (await toast()).startsWith(`Phone bank moved to ${wd(fri)}, ${md(fri)}`) && (await page.locator('.sb-toast button:has-text("Undo")').count()) === 1, await toast());
  await until(async () => (await cards(fri)).some((c) => c.id === phone.id));
  ph = (await D.api(`/shifts/${phone.id}`)).json.shift;
  check('server: Friday, the same hours', iso(ph.starts_at) === at(fri, '18:30') && iso(ph.ends_at) === at(fri, '20:00'));
  check('the drag did not open its sheet', (await page.locator('.sch-sheet').count()) === 0);
  await page.locator('.sb-toast button:has-text("Undo")').click();
  await until(async () => (await cards(thu)).some((c) => c.id === phone.id));
  ph = (await D.api(`/shifts/${phone.id}`)).json.shift;
  check('Undo: back on Thursday', iso(ph.starts_at) === at(thu, '18:30') && (await cards(thu)).some((c) => c.id === phone.id));

  // A shift's target, by tap: Tuesday's Mainstreet has none; what the kind usually wants is only the first number offered.
  await D.watchKeys();
  await openCard(tueCards[1].id);
  await page.locator('.sch-sheet .sch-more').click();
  check('"More" on a card: "We need" — "No target" pressed; Mainstreet’s usual 2 is the first number offered, marked so', await pressed(page.locator('.sch-sheet [aria-label="We need"] .sch-chip:text-is("No target")'))
    && (await D.text('.sch-sheet [aria-label="We need"].sch-chips')) === 'No target 2 · usual 1 3 4 5 6 8 10', await D.text('.sch-sheet [aria-label="We need"].sch-chips'));
  await D.shot('11b-card-we-need-1440');
  await page.locator('.sch-sheet [aria-label="We need"] .sch-chip:text-is("3")').click();
  await go.click();
  await sheetGone();
  await until(async () => (await cards(tue))[1].count === '0 of 3');
  k = await D.keys();
  check('"We need 3": the card says "0 of 3" — set by tap', (await cards(tue))[1].count === '0 of 3' && (await D.api(`/shifts/${tueCards[1].id}`)).json.shift.need === 3
    && (await toast()) === 'Saved' && k.keys === 0 && k.fields.length === 0, `${await toast()} ${JSON.stringify(k)}`);

  // "Name it": the one optional bit of typing — a name for the place nothing could name.
  await openCard(tueCards[1].id);
  check('a card at "Pinned place": the chip is pressed; its coordinates and "Name it" sit under it; no field is open', await pressed(chip('Pinned place'))
    && /^Pinned place · 49\.\d{4}, −122\.\d{4}$/.test(await D.text('.sch-pinned .sch-note')) && (await page.locator('.sch-sheet input').count()) === 0, await D.text('.sch-pinned'));
  await page.locator('.sch-pinned button:has-text("Name it")').click();
  check('"Name it" is one tap to the name', await page.evaluate(() => document.activeElement?.id === 'sch-pin-name'));
  await D.shot('11c-card-name-it-1440');
  await page.fill('#sch-pin-name', 'Newton Exchange');
  await page.locator('.sch-pinned button:has-text("Save name")').click();
  await until(async () => pressed(chip('Newton Exchange')));
  check('named: the chip says it, and Save has nothing to save', await pressed(chip('Newton Exchange')) && (await page.locator('.sch-pinned').count()) === 0 && await go.isDisabled());
  await page.locator('.sch-sheet .sch-x').click();
  await sheetGone();
  await until(async () => (await cards(tue))[1].place === 'Newton Exchange');
  const renamed = (await board()).shifts.filter((s) => s.kind === 'mainstreet');
  check('both Mainstreets there follow the name — card, words and made name; the pin stays', (await cards(thu)).some((c) => c.place === 'Newton Exchange')
    && renamed.length === 2 && renamed.every((s) => s.title === 'Mainstreet — Newton Exchange' && s.location === 'Newton Exchange' && s.place_id === pinned.place_id), JSON.stringify(renamed.map((s) => [s.title, s.location])));

  // ── 11. People go on by tap, and a name STAYS in hand from card to card; a shift with people moved says who has the old time, and "Tell them" ──
  await D.watchKeys();
  const ashaBtn = page.locator('.sb-person:has-text("Asha Example")');
  await ashaBtn.click();
  check('a name tapped is in hand: "Asha Example — tap each shift"', (await D.text('.sb-hand')).startsWith('Asha Example — tap each shift') && await pressed(ashaBtn), await D.text('.sb-hand'));
  await D.shot('12b-name-in-hand-1440');
  await page.locator(`.sch-card[data-shift="${monCards[0].id}"] .sch-card__head`).click();
  await until(async () => (await cards(mon))[0].people.length === 1);
  check('tap a card: Asha is on Monday’s Burma Shave — the card says "1 on"', (await cards(mon))[0].people.join() === 'Asha E.' && (await cards(mon))[0].count === '1 on', JSON.stringify(await cards(mon)));
  check('…and the name is still in hand', await pressed(ashaBtn) && (await page.locator('.sb-hand').count()) === 1 && (await page.locator('.sch-sheet').count()) === 0);
  await page.locator(`.sch-card[data-shift="${tueCards[0].id}"] .sch-card__head`).click();
  await until(async () => (await cards(tue))[0].people.length === 1);
  const ashaOn = (await board()).assignments.filter((a) => a.person_id === P.asha.id).map((a) => a.shift_id).sort();
  check('the next card takes her too: two bookings in three taps', ashaOn.join() === [monCards[0].id, tueCards[0].id].sort().join() && (await cards(tue))[0].people.join() === 'Asha E.', ashaOn.join());
  await page.locator(`.sch-card[data-shift="${tueCards[0].id}"] .sch-card__head`).click();
  await until(async () => /already on/.test(await toast()));
  check('a card she is already on says so — nothing is doubled, the name stays in hand', /^Asha is already on Burma Shave/.test(await toast()) && await pressed(ashaBtn)
    && (await board()).assignments.filter((a) => a.person_id === P.asha.id).length === 2, await toast());
  await page.locator('.sb-hand button:has-text("Done")').click();
  check('"Done" puts the name down', (await page.locator('.sb-hand').count()) === 0 && !(await pressed(ashaBtn)));
  k = await D.keys();
  check('people placed with no key pressed, no text field focused', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));
  await openCard(monCards[0].id);
  check('the sheet says who is on it', (await D.text('.sch-onit')) === 'On it: Asha Example');
  await chip('4–6 pm').click();
  await go.click();
  await sheetGone();
  check('moved to 4–6 pm: one person has the old time — "Tell them"', (await toast()).startsWith('Saved — 1 person has the old time or place')
    && (await page.locator('.sb-toast button:has-text("Tell them")').count()) === 1, await toast());
  await until(async () => (await cards(mon)).some((c) => c.id === monCards[0].id && c.time === '4–6 pm' && c.part === 'Afternoon'));
  check('the card is under "Afternoon" now', (await cards(mon)).some((c) => c.id === monCards[0].id && c.part === 'Afternoon'));
  await page.locator('.sb-toast button:has-text("Tell them")').click();
  await page.waitForSelector('.sch-sheet .sch-ask', { timeout: 8000 });
  check('"Tell them" asks first', /Email and text 1 person this shift as it is now\?/.test(await D.text('.sch-ask')), await D.text('.sch-ask'));
  await D.shot('13-card-tell-1440');
  const sentBefore = texts.length;
  await page.locator('.sch-ask button:has-text("Send")').click();
  await until(async () => (await page.locator('.sch-tools .ops-done').count()) === 1);
  const toldLine = await D.text('.sch-tools .ops-done');
  const asha = (await D.api(`/shifts/${monCards[0].id}`)).json.assignees.find((a) => a.name === 'Asha Example');
  check('sent: the text went, the email had no provider — said as it is', texts.length === sentBefore + 1 && /4:00 p\.m\./.test(texts.at(-1).Body) && asha.notify_text === 'sent' && asha.notify_email === 'skipped'
    && /Sent to 1 person/.test(toldLine), `${toldLine} · ${asha.notify_email}/${asha.notify_text}`);

  // On the website, by one tap.
  await page.locator('.sch-sheet .sch-toggle').click();
  await until(async () => pressed(page.locator('.sch-sheet .sch-toggle')));
  check('"On the website": one tap', (await D.api(`/shifts/${monCards[0].id}`)).json.shift.public === true);
  check('"Open shift" goes to its page, and remembers the week', (await page.locator('.sch-sheet a:has-text("Open shift")').getAttribute('href')) === `/admin/shifts/${monCards[0].id}`);
  await page.locator('.sch-sheet a:has-text("Open shift")').click();
  await page.waitForURL(/\/admin\/shifts\/[0-9a-f-]{36}$/, { timeout: 8000 });
  await page.locator('a.ops-back').click();
  await page.waitForSelector('.sch-day', { timeout: 10000 });
  check('"← Shifts" comes back to the week it was opened from', new URL(page.url()).searchParams.get('week') === MON && (await cards(mon)).length > 0, page.url());

  // ── 12. A repeating slot: "This and the following"; then it is ended ──
  await openCard(office.id);
  check('a repeating shift offers "This one · This and the following"', (await D.text('.sch-sheet .ops-seg')) === 'This one This and the following', await D.text('.sch-sheet .ops-seg'));
  await page.locator('.sch-sheet .ops-seg button:has-text("This and the following")').click();
  await chip('1–4 pm').click();
  check('the button says what it will change', (await go.innerText()).trim() === 'Save this and the following');
  await D.shot('14-card-series-1440');
  await go.click();
  await sheetGone();
  check('all four change together', (await toast()) === '4 shifts changed', await toast());
  const moved = (await board(addDays(MON, 7))).shifts.find((s) => s.series_id === office.series_id);
  check('server: next week’s is 1–4 pm too', iso(moved.starts_at) === at(addDays(mon, 7), '13:00') && iso(moved.ends_at) === at(addDays(mon, 7), '16:00'), `${moved.starts_at}`);
  await until(async () => (await cards(mon)).some((c) => c.id === office.id && c.time === '1–4 pm'));
  await openCard(office.id);
  await page.locator('.sch-sheet .ops-seg button:has-text("This and the following")').click();
  await page.locator('.sch-sheet .sch-tools button:has-text("Call off")').click();
  check('calling off the following asks first', /Call off this one and the following ones nobody is on\?/.test(await D.text('.sch-ask')), await D.text('.sch-ask'));
  await page.locator('.sch-ask button:has-text("Call it off")').click();
  await sheetGone();
  check('the slot is ended', (await toast()) === '4 shifts called off', await toast());
  check('server: none of it is left', !(await board()).shifts.some((s) => s.kind === 'office') && !(await board(addDays(MON, 7))).shifts.some((s) => s.kind === 'office'));

  // Call off one shift (Friday's Burma Shave): asked first, then gone.
  const friBurma = (await cards(fri)).find((c) => c.title === 'Burma Shave');
  await openCard(friBurma.id);
  await page.locator('.sch-sheet .sch-tools button:has-text("Call off")').click();
  check('"Call off" asks first', /Call off this shift\?/.test(await D.text('.sch-ask')));
  await page.locator('.sch-ask button:has-text("Call it off")').click();
  await sheetGone();
  await until(async () => !(await cards(fri)).some((c) => c.id === friBurma.id));
  check('called off: off the week, said so', /called off$/.test(await toast()) && (await D.api(`/shifts/${friBurma.id}`)).status === 404, await toast());

  // ── 13. "More": tell everyone on the week's shifts — the count first ──
  await D.api('/actions/shift.assign', { shift_id: tueCards[1].id, person_id: P.cam.id });
  await D.api('/actions/person.update', { id: P.cam.id, tags: ['do-not-text'] });
  // Someone signs up on the website's volunteer form (the site is set up by its first read).
  await D.api('/site');
  const signedUp = await page.evaluate(async (email) => (await fetch('/site/api/forms/volunteer', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Vera', last_name: 'Example', email, roles: ['Doorknocking'] }),
  })).status, `vera+${tag}@example.org`);
  await D.go(`/shifts?week=${MON}`);
  await page.waitForSelector('.sch-card', { timeout: 10000 });
  const veraBtn = page.locator('.sb-person:has-text("Vera Example")');
  check('someone who signed up on the website is in the people strip, marked "Asked"', signedUp === 200 && (await veraBtn.count()) === 1 && /Asked/.test(await veraBtn.innerText()),
    `${signedUp} · ${await veraBtn.innerText().catch(() => 'not there')}`);
  await page.locator('.sch-week__more').click();
  await page.waitForSelector('.sch-weekmore .sch-row', { timeout: 8000 });
  const state0 = (await D.api(`/schedule/week?week=${MON}`)).json;
  let moreText = await D.text('.sch-weekmore');
  check('the count is shown before anything is sent: 2 people · 3 shifts', state0.people === 2 && state0.shifts === 3 && /Tell everyone on this week’s shifts 2 people · 3 shifts/.test(moreText), moreText.slice(0, 160));
  check('reminders are off until a manager turns them on', state0.reminders.on === false && /Remind people the evening before Off/.test(moreText)
    && (await page.locator('.sch-switch').getAttribute('aria-checked')) === 'false');
  mm = await measure(page);
  check('"More" open (1440): still one main button, no sideways scroll', mm.yellow.join('|') === 'New shift' && mm.overflow <= 0, JSON.stringify(mm));
  await D.shot('15-week-more-1440');
  await page.locator('.sch-weekmore button:has-text("Tell them")').click();
  const askWords = await D.text('.sch-weekmore .sch-ask');
  check('it asks first, and says what isn’t connected', /Send 2 people their own shifts for the week, by email and text\?/.test(askWords) && /Email isn’t connected — no emails will be sent\./.test(askWords), askWords);
  const before = texts.length;
  await page.locator('.sch-weekmore .sch-ask button:has-text("Send")').click();
  await until(async () => /Reached 1 of 2/.test(await D.text('.sch-weekmore')), 20000);
  moreText = await D.text('.sch-weekmore');
  check('sent in the background: one text to Asha listing her two shifts; Cam is do-not-text', texts.length === before + 1
    && /Your shifts for the week of/.test(texts.at(-1).Body) && (texts.at(-1).Body.match(/Burma Shave/g) || []).length === 2 && /Reached 1 of 2/.test(moreText),
    `${texts.length - before} · ${texts.at(-1)?.Body?.slice(0, 120)} · ${moreText.slice(0, 120)}`);
  await page.locator('.sch-weekmore .sch-last button:has-text("Details")').click();
  await page.waitForSelector('.sch-weekmore .ops-results li', { timeout: 8000 });
  const rows = await page.$$eval('.sch-weekmore .ops-results li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('Details: a person a row, how each went', rows.join(' | ') === 'Asha Example No email on file Text sent | Cam Example No email on file Opted out of texts', rows.join(' | '));
  await D.shot('16-week-told-1440');
  check('once is enough: a second tap would be "Tell them again"', (await page.locator('.sch-weekmore button:has-text("Tell them again")').count()) === 1);

  // Reminders: one tap on, one tap off.
  await page.locator('.sch-switch').click();
  await until(async () => (await page.locator('.sch-switch').getAttribute('aria-checked')) === 'true');
  let wk = (await D.api(`/schedule/week?week=${MON}`)).json;
  check('one tap turns the evening reminders on, and says when the next go', wk.reminders.on === true && Boolean(wk.reminders.next_at) && /Remind people the evening before On — next /.test(await D.text('.sch-weekmore')), await D.text('.sch-weekmore'));
  await D.shot('17-reminders-on-1440');
  await page.locator('.sch-switch').click();
  await until(async () => (await page.locator('.sch-switch').getAttribute('aria-checked')) === 'false');
  wk = (await D.api(`/schedule/week?week=${MON}`)).json;
  check('…and one tap off', wk.reminders.on === false);

  // ── 14. Copy to next week, with the same people ──
  const count = (await board()).shifts.length;
  check('the week holds nine shifts now', count === 9, count);
  await page.locator('.sch-weekmore button:has-text("Copy")').click();
  const copyAsk = await D.text('.sch-weekmore .sch-ask');
  check('"Copy to next week" asks: with the same people?', copyAsk.includes(`Copy 9 shifts to ${md(addDays(MON, 7))} – ${md(addDays(MON, 13))}? With the same people?`), copyAsk);
  await D.shot('18-copy-ask-1440');
  await page.locator('.sch-weekmore .sch-ask button:has-text("With the people")').click();
  await until(async () => /copied/.test(await toast()));
  check('copied, with the people booked', (await toast()).startsWith(`9 shifts copied to ${md(addDays(MON, 7))} – ${md(addDays(MON, 13))} · 3 bookings`), await toast());
  const next = await board(addDays(MON, 7));
  check('server: the same nine a week on, at the same local times, three plain bookings',
    next.shifts.length === 9 && next.shifts.some((s) => s.kind === 'mainstreet' && iso(s.starts_at) === at(addDays(tue, 7), '07:00'))
    && next.assignments.length === 3 && next.assignments.every((a) => a.status === 'assigned'), `${next.shifts.length} · ${next.assignments.map((a) => a.status).join()}`);
  await page.locator('.sb-toast button:has-text("Go there")').click();
  await until(async () => (await page.locator('.sb-week__label').innerText()).startsWith(md(addDays(MON, 7))));
  await page.waitForSelector('.sch-card', { timeout: 10000 });
  check('"Go there": next week, with its nine cards', (await page.locator('.sch-card').count()) === 9 && new URL(page.url()).searchParams.get('week') === addDays(MON, 7));
  await D.shot('19-next-week-copied-1440');

  // ── 15. An empty week offers "Copy last week" ──
  await page.locator('.sb-nav[aria-label="Next week"]').click();
  await until(async () => /No shifts this week yet\./.test(await D.text('main.page')));
  await until(async () => (await page.locator('.sch-empty button:has-text("Copy last week")').count()) === 1);
  check('an empty week after a full one: "Copy last week"', (await page.locator('.sch-empty button:has-text("Copy last week")').count()) === 1);
  await D.shot('20-empty-week-offer-1440');
  await page.locator('.sch-empty button:has-text("Copy last week")').click();
  check('it asks: with the same people?', (await D.text('.sch-empty .sch-ask')).includes('Copy last week’s 9 shifts here? With the same people?'), await D.text('.sch-empty .sch-ask'));
  await page.locator('.sch-empty .sch-ask button:has-text("Just the shifts")').click();
  await until(async () => (await page.locator('.sch-card').count()) === 9);
  const third = await board(addDays(MON, 14));
  check('just the shifts: nine, nobody on them', third.shifts.length === 9 && third.assignments.length === 0 && (await page.locator('.sch-card').count()) === 9, `${third.shifts.length}/${third.assignments.length}`);

  // ── 16. This week: a day that is over has no "+" ──
  await D.go('/shifts');
  await page.waitForSelector('.sch-day', { timeout: 10000 });
  const thisWeek = Array.from({ length: 7 }, (_, i) => addDays(weekStart(today), i));
  check('this week: a "+" on today and after, none on a day that is over', (await page.locator('.sch-day .sch-plus').count()) === thisWeek.filter((d) => d >= today).length
    && (await page.locator('.sch-day[data-past] .sch-plus').count()) === 0);

  // ── 17. A laptop on Toronto time shows the campaign's hours ──
  const east = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Toronto', locale: 'en-CA', storageState: await desk.storageState() });
  const ep = await east.newPage();
  const E = wire(ep, 'toronto');
  await ep.goto(`${ADMIN}/shifts?week=${MON}`, { waitUntil: 'domcontentloaded' });
  await ep.waitForSelector('.sch-card', { timeout: 10000 });
  const eastTue = await ep.$$eval(`.sch-day[data-day="${tue}"] .sch-card__time`, (els) => els.map((e) => e.innerText.trim()));
  check('on Toronto time the week still reads 6:30–8:30 am and 7–9 am on Tuesday', eastTue.join('|') === '6:30–8:30 am|7–9 am', eastTue.join('|'));
  // …and so does every other screen that shows or takes a shift's time.
  await ep.locator('.sb-views button:has-text("List")').click();
  await ep.waitForSelector(`.sch-vrow[data-shift="${tueCards[0].id}"]`, { timeout: 10000 });
  const eastRow = await E.text(`.sch-vrow[data-shift="${tueCards[0].id}"] .sch-vrow__sub`);
  const eastHeads = await ep.$$eval('.sch-dayhead', (els) => els.map((e) => e.innerText.trim()));
  check('Toronto, the List: a day a heading on the campaign’s calendar, the row 6:30–8:30 am', eastRow.startsWith('6:30–8:30 am') && eastHeads[0] === headOf(mon) && eastHeads[1] === longDay(tue), `${eastRow} | ${eastHeads.slice(0, 2).join(' | ')}`);
  await E.shot('22-toronto-list-1440');
  await ep.locator('button.ops-more:has-text("Past shifts")').click();
  await until(async () => /Summer BBQ/.test(await E.text('#ops-past')));
  const pastWords = await E.text('#ops-past');
  check('the List is what is coming up: a past shift loads when "Past shifts" is opened (?past=1), at the campaign’s hours', /Summer BBQ/.test(pastWords) && /4–6 pm/.test(pastWords)
    && !(await E.api('/shifts')).json.shifts.some((x) => x.title === 'Summer BBQ') && (await E.api('/shifts?past=1')).json.shifts.some((x) => x.title === 'Summer BBQ'), pastWords.slice(0, 160));
  await ep.goto(`${ADMIN}/shifts/${tueCards[0].id}`, { waitUntil: 'domcontentloaded' });
  await ep.waitForSelector('.ops-lines .when', { timeout: 10000 });
  check('Toronto, a shift’s page: its day and hours are the campaign’s', (await E.text('.ops-lines .when')) === `${longDay(tue)} · 6:30–8:30 am`, await E.text('.ops-lines .when'));
  await ep.locator('.ops-shift-tools button:has-text("Edit")').click();
  await ep.waitForSelector('#edit-shift-starts', { timeout: 8000 });
  check('Toronto, Edit: the boxes hold the campaign’s clock', (await ep.inputValue('#edit-shift-starts')) === `${tue}T06:30` && (await ep.inputValue('#edit-shift-ends')) === `${tue}T08:30`,
    `${await ep.inputValue('#edit-shift-starts')} ${await ep.inputValue('#edit-shift-ends')}`);
  await ep.goto(`${ADMIN}/shifts?new=1`, { waitUntil: 'domcontentloaded' });
  await ep.waitForSelector('form[aria-label="New shift"]', { timeout: 10000 });
  check('the long form is "More options", and asks nothing about how many', (await E.text('form[aria-label="New shift"] h2')) === 'More options' && !/How many/.test(await E.text('form[aria-label="New shift"]'))
    && (await ep.locator('#shift-capacity').count()) === 0);
  await ep.fill('#shift-title', 'Sunrise wave');
  await ep.fill('#shift-starts', `${sun}T05:45`);
  await ep.locator('form[aria-label="New shift"] button:has-text("Create shift")').click();
  await ep.waitForURL(/\/admin\/shifts\/[0-9a-f-]{36}$/, { timeout: 10000 });
  await ep.waitForSelector('.ops-lines .when', { timeout: 10000 });
  const sunrise = (await E.api(`/shifts/${new URL(ep.url()).pathname.split('/').pop()}`)).json.shift;
  check('Toronto, the long form: 05:45 typed is 5:45 am on the campaign’s clock — stored so, shown so', iso(sunrise.starts_at) === at(sun, '05:45')
    && (await E.text('.ops-lines .when')) === `${longDay(sun)} · 5:45 am`, `${sunrise.starts_at} | ${await E.text('.ops-lines .when')}`);
  await ep.goto(`${ADMIN}/shifts/${tueCards[1].id}`, { waitUntil: 'domcontentloaded' });
  await ep.waitForSelector('.cb-tray', { timeout: 10000 });
  await until(async () => /Asha Example/.test(await E.text('.cb-tray')));
  check('Toronto, the crew board: "Busy then … 6:30 am"', /Busy then: Burma Shave — King George Blvd & 88 Ave, 6:30 am/.test(await E.text('.cb-tray')), (await E.text('.cb-tray')).slice(0, 200));
  await ep.goto(`${ADMIN}/shifts/volunteers?show=all`, { waitUntil: 'domcontentloaded' });
  await ep.waitForSelector('.vl-rows .ops-item', { timeout: 10000 });
  const ashaRow = ep.locator('.vl-rows .ops-item:has-text("Asha Example")');
  check('Toronto, the roster: "Next: … Mon" on the campaign’s calendar', (await ashaRow.innerText()).replace(/\s+/g, ' ').includes(`Next: Burma Shave — King George Blvd & 88 Ave · ${shortDay(mon)}`), (await ashaRow.innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await ashaRow.locator('.ops-row').click();
  await until(async () => /4 pm/.test(await ashaRow.innerText()));
  check('…and her shifts at the campaign’s hours: 4 pm, 6:30 am', /· 4 pm/.test(await ashaRow.innerText()) && /· 6:30 am/.test(await ashaRow.innerText()), (await ashaRow.innerText()).replace(/\s+/g, ' ').slice(0, 260));
  await east.close();

  // A smaller desk (1280×800): the days still have the room.
  const mid = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', locale: 'en-CA', storageState: await desk.storageState() });
  const midp = await mid.newPage();
  wire(midp, '1280');
  await midp.goto(`${ADMIN}/shifts?week=${MON}`, { waitUntil: 'domcontentloaded' });
  await midp.waitForSelector('.sch-card', { timeout: 10000 });
  await sleep(300);
  mm = await measure(midp);
  check('1280×800: every card’s kind reads on one line; one main button, no sideways scroll', (await wrappedKinds(midp)).length === 0 && mm.yellow.join('|') === 'New shift' && mm.overflow <= 0,
    `wrapped: ${(await wrappedKinds(midp)).join(', ')} ${JSON.stringify(mm)}`);
  await midp.screenshot({ path: `${SHOTS}/21-week-1280.png` });
  await mid.close();

  // ── 18. A phone (390×844): one day, the sheets from the bottom ──
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', locale: 'en-CA', storageState: await desk.storageState() });
  await tiles(mobile);
  const mp = await mobile.newPage();
  const M = wire(mp, 'phone');
  await mp.goto(`${ADMIN}/shifts?week=${addDays(MON, 21)}`, { waitUntil: 'domcontentloaded' });
  await mp.waitForSelector('.sch-day', { timeout: 10000 });
  const W4 = addDays(MON, 21);
  check('phone: one day at a time with a day strip', (await mp.locator('.sch-day').count()) === 1 && (await mp.locator('.sb-days .sb-day').count()) === 7
    && (await mp.locator('.sch-day').getAttribute('data-day')) === W4);
  mm = await measure(mp, '.sch-plus, .sb-week .btn, .sb-day, .sch-peoplebtn');
  check('phone, empty week: one main button, no sideways scroll, 48px targets', mm.yellow.join('|') === 'New shift' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await M.shot('30-week-empty-390');
  await M.watchKeys();
  await mp.locator('.sch-plus').tap();
  await mp.waitForSelector('.sch-sheet .sch-tile', { timeout: 8000 });
  await sleep(300);
  const sheetBox = await mp.locator('.sch-sheet').boundingBox();
  check('phone: the sheet comes up from the bottom, full width', Math.round(sheetBox.x) === 0 && Math.round(sheetBox.width) === 390 && Math.round(sheetBox.y + sheetBox.height) === 844 && sheetBox.y > 40, JSON.stringify(sheetBox));
  mm = await measure(mp, SHEET_TARGETS);
  check('phone, What: one main button, no sideways scroll, 48px tiles', mm.yellow.join('|') === 'Add shifts' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await M.shot('31-add-what-390');
  await mp.locator('.sch-sheet .sch-tile:has-text("Burma Shave")').tap();
  await mp.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  await mp.locator('.sch-sheet .sch-chip:has-text("King George Blvd & 88 Ave")').tap();
  await mp.locator('.sch-sheet .sch-chip:has-text("Weekdays")').tap();
  await mp.locator('.sch-sheet .sch-chip:has-text("4–6 pm")').tap();
  const mgo = mp.locator('.sch-sheet .sch-go');
  check('phone: a place used before is one tap; mornings and afternoons, weekdays: ten', (await mgo.innerText()).trim() === 'Add 10 shifts', await mgo.innerText());
  mm = await measure(mp, SHEET_TARGETS);
  check('phone, the whole sheet: one main button, no sideways scroll, 48px targets', mm.yellow.join('|') === 'Add 10 shifts' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  const fits = await mp.evaluate(() => { const r = document.querySelector('.sch-sheet .sch-go').getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top > 0; });
  check('phone: the main button stays in view under the sheet', fits);
  await M.shot('32-add-burma-390');
  await mgo.tap();
  await until(async () => (await mp.locator('.sch-sheet').count()) === 0);
  await until(async () => (await mp.locator('.sch-card').count()) === 2);
  k = await M.keys();
  check('phone: ten shifts by tap — no key, no text field focused (no keyboard came up)', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));
  const dayText = await M.text('.sch-day');
  check('phone: the day’s list — Early, then Afternoon; no numbers on the cards', /Early Burma Shave King George Blvd & 88 Ave 6:30–8:30 am Afternoon Burma Shave King George Blvd & 88 Ave 4–6 pm$/.test(dayText), dayText);
  check('phone: the strip marks the days that have shifts', (await mp.locator('.sb-day .sb-day__dot').count()) === 5);
  mm = await measure(mp, '.sch-plus, .sb-week .btn, .sb-day, .sch-card__head, .sch-peoplebtn');
  check('phone, a day with shifts: one main button, no sideways scroll, 48px targets', mm.yellow.join('|') === 'New shift' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await M.shot('33-week-day-390', true);

  // A card's sheet on the phone; pick on the map there too.
  await mp.locator('.sch-card__head').first().tap();
  await mp.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  await sleep(300);
  mm = await measure(mp, SHEET_TARGETS);
  check('phone, a card’s sheet: one main button, no sideways scroll, 48px targets', mm.yellow.join('|') === 'Save' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await M.shot('34-card-sheet-390');
  geo.mode = 'address';
  await mp.locator('.sch-sheet .sch-chip:has-text("Pick on the map")').tap();
  await mp.waitForSelector('.sch-map__box.leaflet-container', { timeout: 15000 });
  await sleep(600);
  await mp.locator('.sch-sheet button:has-text("Use the middle of the map")').tap();
  await until(async () => (await mp.locator('.sch-named__name').count()) === 1);
  check('phone: no corner near — named by the nearest address', (await M.text('.sch-named__name')) === 'near 13450 72 Ave', await M.text('.sch-named'));
  await M.shot('35-card-map-390');
  await mp.locator('.sch-pick button:has-text("Use this place")').tap();
  await until(async () => (await mp.locator('.sch-sheet .sch-chip[aria-pressed="true"]:has-text("near 13450 72 Ave")').count()) === 1);
  await mp.locator('.sch-sheet .sch-go').tap();
  await until(async () => (await mp.locator('.sch-sheet').count()) === 0);
  await until(async () => /near 13450 72 Ave/.test(await M.text('.sch-day')));
  const w4 = await board(W4);
  check('server: that one shift has the new place, and its name follows', w4.shifts.filter((s) => s.title === 'Burma Shave — near 13450 72 Ave').length === 1 && w4.shifts.length === 10, w4.shifts.map((s) => s.title).join(' | ').slice(0, 200));
  k = await M.keys();
  check('phone: changed by tap — still no key, no text field', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));

  // "More" on the phone.
  await mp.locator('.sch-week__more').tap();
  await mp.waitForSelector('.sch-weekmore .sch-row', { timeout: 8000 });
  mm = await measure(mp, '.sch-weekmore .btn, .sch-switch, .sb-week .btn');
  check('phone, "More": one main button, no sideways scroll, 48px targets', mm.yellow.join('|') === 'New shift' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  check('phone, "More": nobody is on these shifts, so nobody to tell', /Nobody is on a shift still to come/.test(await M.text('.sch-weekmore')) && await mp.locator('.sch-weekmore button:has-text("Tell them")').isDisabled());
  await M.shot('36-week-more-390', true);
  await mp.locator('.sch-week__more').tap();

  // People on a phone: a sheet with a name a row — not a strip to swipe sideways — and the name stays in hand.
  await M.watchKeys();
  check('phone: no strip of names over the week — one "People" button', (await mp.locator('.sb-tray').count()) === 0 && (await mp.locator('.sch-peoplebtn').innerText()).startsWith('People'));
  await mp.locator('.sch-peoplebtn').tap();
  await mp.waitForSelector('.sch-sheet .sb-person', { timeout: 8000 });
  await sleep(300);
  mm = await measure(mp, '.sch-sheet .sb-person, .sch-sheet .btn, .sch-sheet .input');
  const sideways = await mp.evaluate(() => { const ul = document.querySelector('.sch-sheet .sb-people'); const body = document.querySelector('.sch-sheet__body'); return [ul.scrollWidth - ul.clientWidth, body.scrollWidth - body.clientWidth]; });
  const rowsTop = await mp.$$eval('.sch-sheet .sb-person', (els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  check('phone: "People" is a sheet, a name a row — nothing to swipe sideways, 48px rows, no sideways scroll', (await M.text('.sch-sheet h2')) === 'People' && sideways.every((n) => n <= 0)
    && new Set(rowsTop).size === 1 && rowsTop.length >= 5 && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify({ sideways, rowsTop, mm }));
  check('phone: someone who asked to volunteer says so in words', /Vera Example\s*Asked to volunteer/.test(await M.text('.sch-sheet .sb-people')), (await M.text('.sch-sheet .sb-people')).slice(0, 200));
  await M.shot('37-people-sheet-390');
  await mp.locator('.sch-sheet .sb-person:has-text("Ben Example")').tap();
  await until(async () => (await mp.locator('.sch-sheet').count()) === 0);
  check('phone: tap a name — the sheet goes, the name is in hand over the week', (await M.text('.sb-hand')).startsWith('Ben Example — tap each shift'), await M.text('.sb-hand'));
  await mp.locator(`.sb-day[data-day="${W4}"]`).tap();
  await mp.locator('.sch-card__head').nth(1).tap();
  await until(async () => (await mp.locator('.sch-card .sb-chip').count()) === 1);
  await mp.locator(`.sb-day[data-day="${addDays(W4, 2)}"]`).tap();
  await until(async () => (await mp.locator('.sch-day').getAttribute('data-day')) === addDays(W4, 2));
  await mp.locator('.sch-card__head').first().tap();
  await until(async () => (await mp.locator('.sch-card .sb-chip').count()) === 1);
  const benOn = (await board(W4)).assignments.filter((a) => a.person_id === P.ben.id);
  check('phone: the name stays in hand across days — two shifts, three taps after the sheet', benOn.length === 2 && (await M.text('.sb-hand')).startsWith('Ben Example'), `${benOn.length} · ${await M.text('.sb-hand')}`);
  const chipSize = await mp.evaluate(() => { const b = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }; return { name: b('.sb-chip__name'), x: b('.sb-chip__x') }; });
  check('phone: a person’s chip and its × are at least 44px', chipSize.name[1] >= 44 && chipSize.x[0] >= 44 && chipSize.x[1] >= 44, JSON.stringify(chipSize));
  mm = await measure(mp, '.sb-chip__name, .sb-chip__x, .sb-hand .btn, .sch-card__head');
  check('phone, a name in hand: one main button, no sideways scroll, 48px targets', mm.yellow.join('|') === 'New shift' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await M.shot('38-name-in-hand-390', true);
  await mp.locator('.sb-hand button:has-text("Done")').tap();
  k = await M.keys();
  check('phone: "Done" puts the name down — and no key was pressed, no keyboard came up', (await mp.locator('.sb-hand').count()) === 0 && k.keys === 0 && k.fields.length === 0, JSON.stringify(k));
  await mobile.close();

  // A narrow window with a mouse: a card dragged onto another day's button in the strip moves there.
  const slim = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', locale: 'en-CA', storageState: await desk.storageState() });
  const sp = await slim.newPage();
  wire(sp, 'narrow');
  await sp.goto(`${ADMIN}/shifts?week=${W4}`, { waitUntil: 'domcontentloaded' });
  await sp.waitForSelector('.sch-card', { timeout: 10000 });
  const dragged = await sp.locator('.sch-card').first().getAttribute('data-shift');
  const fromBox = await sp.locator(`.sch-card[data-shift="${dragged}"] .sch-card__head`).boundingBox();
  const sunBtn = await sp.locator(`.sb-day[data-day="${addDays(W4, 6)}"]`).boundingBox();
  await sp.mouse.move(fromBox.x + 40, fromBox.y + 16);
  await sp.mouse.down();
  await sp.mouse.move(fromBox.x + 50, fromBox.y + 26, { steps: 3 });
  await sp.mouse.move(sunBtn.x + sunBtn.width / 2, sunBtn.y + sunBtn.height / 2, { steps: 8 });
  await sleep(150);
  const lit = await sp.locator(`.sb-day[data-day="${addDays(W4, 6)}"][data-hot]`).count();
  await sp.mouse.up();
  await until(async () => /moved to Sun/.test(await sp.locator('.sb-toast').innerText().catch(() => '')));
  const sunday = (await board(W4)).shifts.find((x) => x.id === dragged);
  check('narrow: a card dropped on Sunday in the day strip moves there, the same hours', lit === 1 && iso(sunday.starts_at) === at(addDays(W4, 6), '06:30')
    && iso(sunday.ends_at) === at(addDays(W4, 6), '08:30'), `${lit} ${sunday.starts_at}`);
  // A small phone (360 wide): the week and the add sheet still fit across.
  await sp.setViewportSize({ width: 360, height: 740 });
  await sleep(300);
  const small = await measure(sp);
  await sp.locator('.sch-plus').click();
  await sp.waitForSelector('.sch-sheet .sch-tile', { timeout: 8000 });
  await sp.locator('.sch-sheet .sch-tile:has-text("Mainstreet")').click();
  await sp.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  const smallSheet = await measure(sp, SHEET_TARGETS);
  const sheetW = await sp.locator('.sch-sheet').evaluate((el) => ({ w: el.getBoundingClientRect().width, inner: el.scrollWidth }));
  check('360 wide: no sideways scroll on the week or in the add sheet', small.overflow <= 0 && smallSheet.overflow <= 0 && sheetW.inner <= Math.ceil(sheetW.w),
    JSON.stringify({ small: small.overflow, sheet: smallSheet.overflow, sheetW }));
  await sp.screenshot({ path: `${SHOTS}/41-add-sheet-360.png` });
  await slim.close();

  // A weak signal: the map is its own download; one that doesn't arrive says so, and the sheet stays.
  // (No service worker in this window, so the download can be dropped on its way.)
  const weak = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', locale: 'en-CA',
    serviceWorkers: 'block', storageState: await desk.storageState() });
  await tiles(weak);
  const wp = await weak.newPage();
  const Wk = wire(wp, 'weak');
  let dropMap = true;
  await wp.route(/\/assets\/SchedulePlaceMap-[^/]*\.js/, (route) => (dropMap ? route.abort() : route.continue()));
  await wp.goto(`${ADMIN}/shifts?week=${W4}&add=${addDays(W4, 5)}`, { waitUntil: 'domcontentloaded' });
  await wp.waitForSelector('.sch-sheet .sch-tile', { timeout: 10000 });
  check('?add=<day> in the address opens the add sheet on that day', (await Wk.text('.sch-sheet h2')) === 'Add shifts');
  await wp.locator('.sch-sheet .sch-tile:has-text("Signs")').click();
  await wp.waitForSelector('.sch-sheet .sch-daychip', { timeout: 8000 });
  check('…with that day chosen', (await wp.locator('.sch-sheet .sch-daychip[aria-pressed="true"] b').innerText()) === dayNum(addDays(W4, 5)));
  await wp.locator('.sch-sheet .sch-chip:has-text("Pick on the map")').click();
  await until(async () => /The map didn’t load/.test(await Wk.text('.sch-pick')));
  check('a map that doesn’t load says so, with "Reload" — the sheet stays', /The map didn’t load/.test(await Wk.text('.sch-pick'))
    && (await wp.locator('.sch-pick button:has-text("Reload")').count()) === 1 && (await wp.locator('.sch-sheet .sch-go').innerText()).trim() === 'Add 1 shift', await Wk.text('.sch-pick'));
  await Wk.shot('40-map-unavailable-1440');
  dropMap = false;
  await wp.locator('.sch-pick button:has-text("Reload")').click();
  await wp.waitForSelector('.sch-sheet .sch-tile', { timeout: 15000 });
  await wp.locator('.sch-sheet .sch-tile:has-text("Signs")').click();
  await wp.locator('.sch-sheet .sch-chip:has-text("Pick on the map")').click();
  const mapBack = await wp.waitForSelector('.sch-map__box.leaflet-container', { timeout: 15000 }).then(() => true).catch(() => false);
  check('"Reload" comes back to the same week and day’s sheet, and the map loads', mapBack && new URL(wp.url()).searchParams.get('add') === addDays(W4, 5)
    && (await wp.locator('.sch-sheet .sch-daychip[aria-pressed="true"] b').innerText()) === dayNum(addDays(W4, 5)));
  await weak.close();

  // ── 19. A volunteer on a phone: a day a heading, "Count me in" on the row, a warning that never refuses, the map, Mainstreeting ──
  const invite = (await D.api('/actions/member.invite', { email: `wren+${tag}@example.org`, role: 'volunteer' })).json;
  const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', locale: 'en-CA' });
  await tiles(vctx);
  const vp = await vctx.newPage();
  const V = wire(vp, 'volunteer');
  await vp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Wren Example', password: 'knock-knock-2026' });
  check('set-up: a volunteer signs in', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
  await vp.goto(`${BASE}/shifts`, { waitUntil: 'domcontentloaded' });
  await vp.waitForSelector('.sch-vrow', { timeout: 10000 });
  await V.watchKeys();
  const vHeads = await vp.$$eval('.sch-dayhead', (els) => els.map((e) => e.innerText.trim()));
  check('the volunteer’s list: a day a heading, soonest first', vHeads[0] === headOf(mon) && vHeads[1] === longDay(tue) && new Set(vHeads).size === vHeads.length, vHeads.slice(0, 3).join(' | '));
  const vrow = (id) => vp.locator(`.sch-vrow[data-shift="${id}"]`);
  const burmaRow = (await vrow(tueCards[0].id).innerText()).replace(/\s+/g, ' ').trim();
  check('a row: the kind’s mark, what it is, the hours and where — and "Count me in" on the row itself', (await vrow(tueCards[0].id).getAttribute('data-kind')) === 'burma_shave'
    && (await vrow(tueCards[0].id).locator('.sch-vrow__kind svg').count()) === 1 && burmaRow === 'Burma Shave 6:30–8:30 am · King George Blvd & 88 Ave Count me in', burmaRow);
  mm = await measure(vp, '.sch-vrow__join, .sch-vrow .ops-row');
  check('the list (390): no sideways scroll, 48px targets, no number asked or shown as a maximum', mm.overflow <= 0 && mm.minTap >= 47.5 && !/Full|spots left/.test(await V.text('main.page')), JSON.stringify(mm));
  await V.shot('50-vol-list-390');
  await vrow(tueCards[0].id).locator('.sch-vrow__join').tap();
  await until(async () => /You’re on ✓/.test(await vrow(tueCards[0].id).innerText()));
  let mine = (await V.api('/shifts')).json.shifts.filter((s) => s.mine).map((s) => s.id);
  check('"Count me in" on the row: one tap — "You’re on ✓", and the server agrees', /You’re on ✓/.test(await vrow(tueCards[0].id).innerText()) && mine.join() === tueCards[0].id, mine.join());
  // Tuesday's Mainstreet (7–9) overlaps the Burma Shave (6:30–8:30): asked about first, never refused.
  await vrow(tueCards[1].id).locator('.sch-vrow__join').tap();
  await vp.waitForSelector('.sch-vrow__ask', { timeout: 8000 });
  const clashWords = await V.text('.sch-vrow__ask');
  mine = (await V.api('/shifts')).json.shifts.filter((s) => s.mine).map((s) => s.id);
  check('a shift that overlaps one of theirs is asked about first — and nothing is booked yet', /^You’re on Burma Shave — King George Blvd & 88 Ave then \(6:30–8:30 am\)\. Count me in anyway\? Yes No$/.test(clashWords) && mine.length === 1, clashWords);
  await V.shot('51-vol-overlap-390');
  await vp.locator('.sch-vrow__ask button:has-text("Yes")').tap();
  await until(async () => /You’re on ✓/.test(await vrow(tueCards[1].id).innerText()));
  mine = (await V.api('/shifts')).json.shifts.filter((s) => s.mine).map((s) => s.id).sort();
  check('"Yes": on both — a warning, not a refusal', mine.join() === [tueCards[0].id, tueCards[1].id].sort().join(), mine.join());
  k = await V.keys();
  check('the volunteer typed nothing', k.keys === 0 && k.fields.length === 0, JSON.stringify(k));
  // The Mainstreet shift's page: its place opens a map, and it starts Mainstreeting with the place filled in.
  await vrow(tueCards[1].id).locator('.ops-row').tap();
  await vp.waitForSelector('.ops-lines', { timeout: 10000 });
  const mapHref = await vp.locator('.sch-maplink').getAttribute('href').catch(() => null);
  check('a place with a pin opens a map', /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=49\.\d+,-122\.\d+$/.test(mapHref || '') && /Newton Exchange/.test(await V.text('.sch-maplink')), mapHref);
  check('the shift says what it is, and when on the campaign’s clock', /Mainstreet/.test(await V.text('.sch-kindchip')) && (await V.text('.ops-lines .when')) === `${longDay(tue)} · 7–9 am`, await V.text('.ops-lines'));
  mm = await measure(vp, '.ops-notify .btn, .sch-maplink');
  check('the shift (390): one main button — "Start mainstreeting" — no sideways scroll, 48px targets', mm.yellow.join('|') === 'Start mainstreeting' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await V.shot('52-vol-mainstreet-shift-390');
  await vp.locator('a:has-text("Start mainstreeting")').tap();
  await vp.waitForSelector('.ms-where', { timeout: 10000 });
  check('a Mainstreet shift opens Mainstreeting with its place filled in — "Where are you?" is not asked', new URL(vp.url()).pathname === '/mainstreet'
    && /^at Newton Exchange/i.test(await V.text('.ms-where')) && (await vp.locator('#ms-place').count()) === 0, `${vp.url()} ${await V.text('.ms-where')}`);
  await V.shot('53-vol-mainstreeting-390');
  await vctx.close();

  // ── 20. Today's "Needs you": a shift short of the target someone set — never one nobody gave a number ──
  const soonDay = addDays(today, 1);
  const short = await D.api('/actions/shift.createMany', { kind: 'phone_bank', location: 'Campaign office', days: [soonDay], start: '18:00', end: '20:00', need: 4 });
  const plain = await D.api('/actions/shift.createMany', { kind: 'office', location: 'Campaign office', days: [soonDay], start: '13:00', end: '16:00' });
  await D.go('/');
  const needs = page.locator('section[aria-labelledby="today-needs-h"]');
  await until(async () => /Phone bank — Campaign office/.test(await needs.innerText()), 15000);
  const needsWords = (await needs.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('Today’s "Needs you" lists tomorrow’s phone bank as "0 of 4 — 4 more", and not the office shift with no number', short.status === 200 && plain.status === 200
    && /Phone bank — Campaign office .*0 of 4 — 4 more/.test(needsWords) && !/Office — Campaign office/.test(needsWords), needsWords.slice(0, 260));

  // ── 21. The books still verify ──
  const v = (await D.api('/audit/verify')).json;
  check('hash chain verifies after the whole journey', v.ok === true && v.checked > 60, JSON.stringify(v));
  check('the address service was asked only for the three points picked', geo.asked.length >= 3 && geo.asked.length <= 6, geo.asked.join(' '));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check(`the journey ran to its end`, false, e.stack || e.message);
} finally {
  await browser.close();
  await stop();
}
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
