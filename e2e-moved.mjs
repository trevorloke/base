// Moved E2E — "where did they go?" after a Moved tap (ext/moves). A fresh
// in-memory campaign (no outside address service: GEOCODER=off), a manager
// at the desk and a volunteer on a phone walking one turf.
//   Walk list, one-person door: Moved → the same door stays open with the
//   panel → New address → a door on file ("Pinned on the map") → Save →
//   "… — off this door"; who lives there; one of them Moved out → Address
//   unknown → the row folds, one yellow button, no second set of lists →
//   Done → the next door opens; after the reload the old door is gone.
//   Two-person door: Address unknown → "Did anyone else move from …?" →
//   Moved too → Done → on to the next door. Later: on to the next door.
//   Door card (the map): Address unknown; they stay on the card until Done.
//   No signal: a typed address, the outbox line after the knock, "Moving —
//   sends soon"; back online it sends once; GET /api/moves/door shows
//   Loading… and Unavailable — Try again.
//   Desk profile: Marked moved — where to? → New address, Someone on file
//   lives here (one already there reads "Already lives here"), the Moved
//   here line and its Undo; Address unknown with Add new address.
//   People: Needs an address and Address unknown, with their counts.
//   Import: the list still has a mover's old address — the line and Show.
//   A volunteer's profile of someone outside their turf: no panel, "Moved ·
//   the office will ask where".
// Every claim is checked against the API; each screen is measured (≤ 1
// yellow button, no sideways scroll, 48 px panel targets at 390).
//
//   PORT=5430 SHOTS=/tmp/moved node e2e-moved.mjs              (starts its own server)
//   BASE_PATH=/imaginesurrey PORT=5431 SHOTS=/tmp/moved-bp node e2e-moved.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 5430;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '/tmp/starbase-moved';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off',
    GEOCODER: 'off', GEOCODE_ON_SAVE: 'off', BASE_PATH },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});
process.on('exit', () => { server.kill(); });
process.on('unhandledRejection', (e) => { console.log(`FAIL  stopped: ${e?.stack || e}`); process.exit(1); });
// Under a client's path the field app is <path>/field and the desk <path>/desk.
const BASE = BASE_PATH ? `http://127.0.0.1:${PORT}${BASE_PATH}/field` : `http://127.0.0.1:${PORT}`;
const ADMIN = BASE_PATH ? `http://127.0.0.1:${PORT}${BASE_PATH}/desk` : `${BASE}/admin`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    text: async (sel = 'body') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch(`${p}`, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [`${BASE_PATH}/api${path}`, body]),
    go: async (path) => { await page.goto(`${who === 'vol' ? BASE : ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
  };
};
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  let small = '';
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      if (minTap == null || h < minTap) { minTap = h; small = el.outerHTML.slice(0, 80); }
    }
  }
  return { yellow, overflow, minTap, small };
}, sel);
const simple = async (pg, name, sel = null) => {
  const mm = await measure(pg, sel);
  check(`${name}: ≤ 1 yellow, no sideways scroll${sel ? ', targets ≥ 48px' : ''}`, mm.yellow <= 1 && mm.overflow <= 0 && (mm.minTap == null || mm.minTap >= 47.5), JSON.stringify(mm));
  return mm;
};
const PANEL_TARGETS = '.mv-panel button, .mv-panel input, .mv-panel .af-opt';

// ── 1. The desk: people, doors and a turf (made-up, 555-01xx phones) ──
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Moved Example Campaign');
await page.fill('#su-email', `riley+${tag}@moved.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/(admin|desk)\/?$/, { timeout: 15000 });
const P = {};
const mk = async (key, name, address, lat, lng, extra = {}) => {
  P[key] = (await D.api('/actions/person.create', { name, address, city: 'Surrey', ...(lat != null ? { lat, lng } : {}), ...extra })).json.person;
};
await mk('ana', 'Ana Example', '12390 72 Ave', 49.1331, -122.8495, { phone: '604-555-0151' });
await mk('ben', 'Ben Example', '7120 124 St', 49.1310, -122.8520);
await mk('bea', 'Bea Example', '7120 124 St', 49.1310, -122.8520);
await mk('cy', 'Cy Example', '12345 72 Ave', 49.1330, -122.8510, { phone: '604-555-0153' });
await mk('dee', 'Dee Example', '12345 72 Ave', 49.1330, -122.8510);
await mk('eve', 'Eve Example', '7150 124 St', 49.1300, -122.8530);
await mk('fay', 'Fay Example', '7180 124 St', 49.1290, -122.8540);
await mk('gil', 'Gil Example', '7180 124 St', 49.1290, -122.8540);
await mk('gus', 'Gus Example', '7190 124 St', 49.1280, -122.8550);
await mk('hal', 'Hal Example', '13450 104 Ave', 49.1906, -122.8466);
await mk('ida', 'Ida Example', '9800 King George Blvd', 49.1800, -122.8450);
await mk('jo', 'Jo Example', '10200 132 St', 49.1850, -122.8460);
await mk('kim', 'Kim Example', '13500 104 Ave', 49.1907, -122.8400);
await mk('lou', 'Lou Example', '15000 88 Ave', 49.1700, -122.7800);
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton East', polygon: [[49.125, -122.860], [49.140, -122.860], [49.140, -122.838], [49.125, -122.838]],
})).json.turf;
check('seeded fourteen people and a turf', Object.values(P).every((p) => p?.id) && turf?.id);

// ── 2. A volunteer on a phone, walking the turf ──
const invite = (await D.api('/actions/member.invite', { email: `amrit+${tag}@moved.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Amrit Volunteer', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const volId = (await V.api('/auth/me')).json.user.id;
check('volunteer walks the turf', (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId })).status === 200);

const profile = async (id) => (await D.api(`/persons/${id}`)).json;
const openDoor = async (addr) => {
  const head = vpage.locator('.walk-door', { hasText: addr }).locator('.walk-door__head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await vpage.waitForSelector('.walk-door.is-open .walk-panel', { timeout: 5000 });
};
const openAddr = () => vpage.$eval('.walk-door.is-open .walk-door__addr', (el) => el.innerText.trim()).catch(() => '');
const toastText = () => vpage.$eval('.walk-toast span', (el) => el.innerText.trim()).catch(() => '');
const moveTap = async () => {
  await vpage.tap('.walk-door.is-open .walk-panel .fk-out:has-text("Moved")');
  await vpage.waitForSelector('.walk-door.is-open .mv-panel', { timeout: 5000 }).catch(() => {});
  await sleep(300);
};

// ── 3. Walk list, one-person door: the panel, a door on file, who lives there ──
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await openDoor('12390 72 Ave');
const row = await vpage.$$eval('.walk-door.is-open .walk-panel .fk-outcomes .fk-out', (els) => els.map((e) => e.innerText.trim()));
check('the outcome row is unchanged', row.join(' · ') === 'No answer · Left lit · Refused · Moved · No access', row.join(' · '));
await moveTap();
const opens = await vpage.$$eval('.walk-door.is-open', (els) => els.length);
check('Moved: the same door stays open, with "Where did Ana go?"', opens === 1 && /12390 72 Ave/.test(await openAddr())
  && /Where did Ana go\?/.test(await V.text('.walk-door.is-open .mv-panel')), `${opens} · ${await openAddr()}`);
check('the Moved tap was logged at once', (await profile(P.ana.id)).contacts.some((c) => c.outcome === 'moved'));
await simple(vpage, 'panel first look at 390', PANEL_TARGETS);
await V.shot('01-walk-panel-390');
await vpage.tap('.mv-panel .mv-choice:has-text("New address")');
await vpage.fill('.mv-panel input[role="combobox"]', '12345 72');
await vpage.waitForSelector('.af-list .af-opt', { timeout: 5000 }).catch(() => {});
await sleep(300);
await simple(vpage, 'New address with suggestions at 390', PANEL_TARGETS);
await V.shot('02-new-address-suggestions-390');
await vpage.tap('.af-list .af-opt:has-text("12345 72 Ave")');
await sleep(300);
check('a door on file: "Pinned on the map"', /Pinned on the map/.test(await V.text('.mv-panel')), await V.text('.mv-panel .af-note'));
await vpage.tap('.mv-panel button[type="submit"]:has-text("Save")');
await vpage.waitForSelector('.mv-list', { timeout: 6000 }).catch(() => {});
await sleep(400);
const t1 = await toastText();
check('toast: "Moved · 12345 72 Ave — off this door"', t1 === 'Moved · 12345 72 Ave — off this door', t1);
let anaNow = (await profile(P.ana.id));
check('server: Ana at 12345 72 Ave with the door’s pin, one move', anaNow.person.address === '12345 72 Ave' && Number(anaNow.person.lat) === 49.133
  && anaNow.latest_move?.result === 'new', JSON.stringify({ a: anaNow.person.address, lat: anaNow.person.lat, m: anaNow.latest_move?.result }));
const thereText = await V.text('.mv-list');
check('"Who lives at 12345 72 Ave now?" lists Cy and Dee, A–Z', /Who lives at 12345 72 Ave now\?/.test(thereText) && thereText.indexOf('Cy Example') < thereText.indexOf('Dee Example') && thereText.indexOf('Cy Example') >= 0, thereText);
check('the door still holds open while the lists show', /12390 72 Ave/.test(await openAddr()));
await V.shot('03-who-lives-there-390');
await vpage.tap('.mv-person:has-text("Dee Example") .mv-segbtn:has-text("Moved out")');
await vpage.waitForSelector('.mv-sub', { timeout: 3000 });
check('Moved out: a small panel, and Done is hidden (one yellow)', (await measure(vpage)).yellow === 1 && !(await vpage.$('.mv-panel > .mv-acts .btn-primary')), JSON.stringify(await measure(vpage)));
await vpage.tap('.mv-sub .mv-choice:has-text("Address unknown")');
await vpage.tap('.mv-sub button[type="submit"]');
await vpage.waitForSelector('.mv-person:has-text("Dee · moved · Address unknown")', { timeout: 5000 }).catch(() => {});
const folded = await V.text('.mv-panel');
const listsNow = await vpage.$$eval('.mv-h', (els) => els.filter((e) => /^Who lives at/.test(e.innerText)).length);
check('the row folds: "Dee · moved · Address unknown"; one yellow; no second set of lists',
  /Dee · moved · Address unknown/.test(folded) && (await measure(vpage)).yellow === 1 && listsNow === 1 && !(await vpage.$('.mv-sub')), `${listsNow} · ${folded.slice(0, 200)}`);
check('server: Dee is Address unknown', (await profile(P.dee.id)).person.address_status === 'unknown');
await simple(vpage, 'folded row at 390', PANEL_TARGETS);
await V.shot('04-moved-out-folded-390');
await vpage.setViewportSize({ width: 1440, height: 900 });
await sleep(300);
await simple(vpage, 'who lives there at 1440');
await V.shot('04b-who-lives-there-1440');
await vpage.setViewportSize({ width: 390, height: 844 });
await vpage.tap('.mv-panel .btn-primary:has-text("Done")');
await sleep(1500);
const after = await openAddr();
check('Done: the next door opens', after && !/12390 72 Ave/.test(after), after);
const list12390 = await vpage.$$eval('.walk-door__addr', (els) => els.map((e) => e.innerText.trim()).filter((t) => /12390 72 Ave/.test(t)).length);
check('after the reload the old door has gone from the list', list12390 === 0, list12390);

// ── 4. Two-person door: Address unknown, "Did anyone else move?" → Moved too ──
await openDoor('7120 124 St');
await vpage.tap('.walk-door.is-open .fk-tab:has-text("Ben Example")');
await sleep(200);
await moveTap();
await vpage.tap('.mv-panel .mv-choice:has-text("Address unknown")');
check('Address unknown: the hint', /Ben comes off this door and the walk list\. The office keeps the old address\./.test(await V.text('.mv-panel')));
await vpage.tap('.mv-panel button[type="submit"]:has-text("Save")');
await vpage.waitForSelector('.mv-list', { timeout: 6000 }).catch(() => {});
await sleep(300);
const t2 = await toastText();
check('toast: "Address unknown — off this door"', t2 === 'Address unknown — off this door', t2);
const leftText = await V.text('.mv-list');
check('"Did anyone else move from 7120 124 St?" lists Bea', /Did anyone else move from 7120 124 St\?/.test(leftText) && /Bea Example/.test(leftText), leftText);
await V.shot('05-did-anyone-else-move-390');
await vpage.tap('.mv-person:has-text("Bea Example") .mv-segbtn:has-text("Moved too")');
await vpage.waitForSelector('.mv-person:has-text("Bea · moved · Address unknown")', { timeout: 5000 }).catch(() => {});
check('Moved too: "Bea · moved · Address unknown", and on the server', /Bea · moved · Address unknown/.test(await V.text('.mv-panel'))
  && (await profile(P.bea.id)).person.address_status === 'unknown');
await vpage.tap('.mv-panel .btn-primary:has-text("Done")');
await sleep(1500);
check('Done: both off the door, on to the next one', !/7120 124 St/.test(await openAddr()), await openAddr());

// ── 5. Later ──
await openDoor('7150 124 St');
await moveTap();
await vpage.tap('.mv-panel button:has-text("Later")');
await sleep(1200);
check('Later: the next door opens; Eve waits in Needs an address', !/7150 124 St/.test(await openAddr()) && (await profile(P.eve.id)).move_open === true, await openAddr());

// ── 6. Door card on the map: they stay on the card until Done ──
await V.go(`/map?person=${P.fay.id}`);
await vpage.waitForSelector('.door-card', { timeout: 10000 });
const faTab = vpage.locator('.door-card .fk-tab:has-text("Fay")');
if (await faTab.count()) await faTab.first().tap();
await vpage.tap('.door-card .fk-out:has-text("Moved")');
await vpage.waitForSelector('.door-card .mv-panel', { timeout: 5000 }).catch(() => {});
await vpage.tap('.door-card .mv-choice:has-text("Address unknown")');
await vpage.tap('.door-card .mv-panel button[type="submit"]');
await vpage.waitForSelector('.door-card .mv-list', { timeout: 6000 }).catch(() => {});
await sleep(800);
check('door card: Fay stays on the card with "Did anyone else move?"', /Fay Example/.test(await V.text('.door-card')) && /Did anyone else move from 7180 124 St\?/.test(await V.text('.door-card')),
  (await V.text('.door-card')).slice(0, 200));
await simple(vpage, 'door card panel at 390', '.door-card .mv-panel button');
await V.shot('06-door-card-390');
await vpage.tap('.door-card .mv-panel .btn-primary:has-text("Done")');
await sleep(1200);
check('server: Fay Address unknown, Gil still there', (await profile(P.fay.id)).person.address_status === 'unknown' && (await profile(P.gil.id)).person.address === '7180 124 St');

// ── 7. No signal: typed, queued after the knock, the chip; sent once; the door lists ──
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await openDoor('7190 124 St');
await vctx.setOffline(true);
await vpage.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(300);
await moveTap();
await vpage.tap('.mv-panel .mv-choice:has-text("New address")');
await vpage.fill('.mv-panel input[role="combobox"]', '4410 Fraser Hwy');
check('offline hint: "Saved on this phone — placed on the map once it sends"', /Saved on this phone — placed on the map once it sends/.test(await V.text('.mv-panel')), await V.text('.mv-panel .af-note'));
await vpage.tap('.mv-panel button[type="submit"]:has-text("Save")');
await sleep(600);
const box = await vpage.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => /outbox:v2$/.test(x));
  return JSON.parse(localStorage.getItem(k) || '[]').map((i) => i.name);
});
check('the outbox: the knock, then the move', box.join(',') === 'contact.log,person.move', box.join(','));
await vpage.tap('.offline-strip__chip').catch(() => {});
await sleep(400);
const sheet = await vpage.$$eval('.obx-what', (els) => els.map((e) => e.innerText.trim())).catch(() => []);
check('the outbox sheet: "Moved · new address · Gus Example · <time>" after the knock', sheet.length === 2 && /^Knock · Gus Example/.test(sheet[0]) && /^Moved · new address · Gus Example · \d{1,2}:\d{2} (am|pm)$/.test(sheet[1]), sheet.join(' | '));
await V.shot('07-offline-outbox-390');
await vpage.tap('.offline-strip__chip').catch(() => {}); // closes the sheet
await sleep(300);
check('"Shown when you have signal" for the new address', /Shown when you have signal/.test(await V.text('.mv-panel')));
check('the chip "Moving — sends soon" on the door', /Moving — sends soon/.test(await V.text('.walk-door:has-text("7190 124 St") .walk-door__chips')));
await V.shot('08-offline-chip-390');
// Back online: the door's lists answer slowly, then fail once, then come.
let fail = true;
await vpage.route(/\/api\/moves\/door/, async (route) => {
  await sleep(1500);
  if (fail) route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' });
  else route.continue();
});
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
await vpage.waitForFunction(() => /Loading…/.test(document.querySelector('.mv-panel')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
check('once sent: "Loading…"', /Loading…/.test(await V.text('.mv-panel')), await V.text('.mv-panel'));
await vpage.waitForFunction(() => /Unavailable — Try again/.test(document.querySelector('.mv-panel')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
check('a failed read: "Unavailable — Try again"', /Unavailable — Try again/.test(await V.text('.mv-panel')), await V.text('.mv-panel'));
fail = false;
await vpage.tap('.mv-panel button:has-text("Try again")');
await vpage.waitForFunction(() => /office will check|No one else on file/.test(document.querySelector('.mv-panel')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
check('Try again: the lists come (outside the turf: the office checks)', /The office will check who else lives there\.|No one else on file at this address\./.test(await V.text('.mv-panel')), await V.text('.mv-panel'));
await vpage.unroute(/\/api\/moves\/door/);
const gus = await profile(P.gus.id);
const gusMoves = (await D.api('/events?since=0&limit=5000')).json.events.filter((e) => e.action === 'person.move' && e.entity_id === gus.latest_move?.id);
check('server: one move for Gus, to 4410 Fraser Hwy', gus.person.address === '4410 Fraser Hwy' && gusMoves.length === 1, `${gus.person.address} · ${gusMoves.length}`);
await vpage.tap('.mv-panel .btn-primary:has-text("Done")');
await sleep(800);

// ── 8. A volunteer's profile of someone outside their turf: the office asks ──
await V.go(`/people/${P.lou.id}`);
await vpage.waitForSelector('.pf-rate', { timeout: 8000 });
await vpage.tap('.pf-rate .fk-out:has-text("Moved")');
await sleep(1200);
check('outside the turf: no panel, "Moved · the office will ask where"', !(await vpage.$('.mv-panel')) && /Moved · the office will ask where/.test(await V.text('.pf-rate')), await V.text('.pf-status'));
await V.shot('09-profile-office-390');

// ── 9. Desk profile: Needs an address → Where to? → Someone on file → Moved here → Undo ──
await V.api('/actions/contact.log', { person_id: P.hal.id, channel: 'door', outcome: 'moved' });
await D.go(`/people/${P.hal.id}`);
await page.waitForSelector('.mv-pline', { timeout: 8000 }).catch(() => {});
const line = await D.text('.mv-profile');
check('"Marked moved <day> by Amrit — where to?"', /Marked moved \d{1,2} [A-Z][a-z]{2} by Amrit — where to\?/.test(line), line);
await simple(page, 'profile Needs an address at 1440');
await D.shot('10-profile-needs-address-1440');
await page.click('.mv-pline button:has-text("Where to?")');
await page.click('.mv-panel .mv-choice:has-text("New address")');
await page.fill('.mv-panel input[role="combobox"]', '9800 King George Blvd');
await sleep(400);
await page.keyboard.press('Escape');
await page.click('.mv-panel button[type="submit"]:has-text("Save")');
await page.waitForSelector('.mv-list', { timeout: 6000 }).catch(() => {});
check('Where to? → "Who lives at 9800 King George Blvd now?" with Ida', /Who lives at 9800 King George Blvd now\?/.test(await D.text('.mv-panel')) && /Ida Example/.test(await D.text('.mv-panel')));
await page.click('.mv-panel button:has-text("Someone on file lives here")');
await page.fill('.mv-onfile input[type="search"]', 'Example');
await page.waitForSelector('.mv-onfile button[data-row]', { timeout: 8000 }).catch(() => {});
await sleep(600);
const idaRow = await page.$eval('.mv-onfile button[data-row]:has-text("Ida")', (el) => ({ off: el.disabled, t: el.innerText })).catch(() => null);
check('Ida, already there, reads "Already lives here" and can’t be picked', idaRow?.off && /Already lives here/.test(idaRow.t), JSON.stringify(idaRow));
await simple(page, 'Someone on file at 1440');
await D.shot('11-someone-on-file-1440');
await page.click('.mv-onfile button[data-row]:has-text("Jo"):not([disabled])');
await page.waitForSelector('.mv-person:has-text("Jo Example · moved here")', { timeout: 6000 }).catch(() => {});
check('Jo joins the list as "moved here", and on the server', /Jo Example · moved here/.test(await D.text('.mv-panel')) && (await profile(P.jo.id)).person.address === '9800 King George Blvd');
await page.click('.mv-panel .btn-primary:has-text("Done")');
await page.waitForSelector('.mv-pline:has-text("Moved here")', { timeout: 6000 }).catch(() => {});
const here = await D.text('.mv-profile');
check('"Moved here <day> · from 13450 104 Ave" with Undo', /Moved here \d{1,2} [A-Z][a-z]{2} · from 13450 104 Ave/.test(here) && /Undo/.test(here), here);
await D.shot('12-profile-moved-here-1440');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await simple(page, 'profile Moved here at 390', '.mv-profile button');
await D.shot('12b-profile-moved-here-390');
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('.mv-pline button:has-text("Undo")');
check('Undo asks: "Put Hal back at 13450 104 Ave? Yes · No"', /Put Hal back at 13450 104 Ave\?/.test(await D.text('.mv-profile')));
await page.click('.mv-pline button:has-text("Yes")');
await sleep(1200);
check('"Undone — back at 13450 104 Ave", and on the server', /Undone — back at 13450 104 Ave/.test(await D.text('.mv-profile')) && (await profile(P.hal.id)).person.address === '13450 104 Ave', await D.text('.mv-profile'));

// Address unknown on the desk's profile.
await D.api('/actions/person.move', { person_id: P.kim.id, unknown: true });
await D.go(`/people/${P.kim.id}`);
await page.waitForSelector('.mv-pline', { timeout: 8000 });
const kimAddr = await D.text('.mv-profile');
check('"Address unknown · since <day> · was 13500 104 Ave" with Add new address', /Address unknown · since \d{1,2} [A-Z][a-z]{2} · was 13500 104 Ave/.test(kimAddr)
  && !!(await page.$('.mv-pline button:has-text("Add new address")')), kimAddr);
await D.shot('13-profile-address-unknown-1440');
await page.click('.mv-pline button:has-text("Add new address")');
check('Add new address: New address already chosen, no "Address unknown" choice', !!(await page.$('.mv-panel input[role="combobox"]')) && !(await page.$('.mv-panel .mv-choice')));
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await simple(page, 'Add new address at 390', PANEL_TARGETS);
await D.shot('13b-add-new-address-390');
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('.mv-panel button:has-text("Later")');

// ── 10. People: Needs an address and Address unknown, with counts ──
const counts = (await D.api('/moves/counts')).json;
await D.go('/people');
await page.click('.pp-filterbtn');
await page.waitForSelector('.pp-sheet', { timeout: 5000 });
const chips = await page.$$eval('.pp-sheet .pp-pick', (els) => els.map((e) => e.innerText.trim()).filter((t) => /^(Needs an address|Address unknown)/.test(t)));
check(`the Moved chips carry the counts (${counts.open} · ${counts.unknown})`, chips.join(' | ') === `Needs an address · ${counts.open} | Address unknown · ${counts.unknown}`, chips.join(' | '));
await page.click('.pp-sheet .pp-pick:has-text("Needs an address")');
await sleep(400);
await D.shot('14-people-moved-chips-1440');
await page.click('.pp-sheet__head button:has-text("Done")');
await sleep(800);
const openNames = await page.$$eval('.pp-row__name, .pp-table__name a', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const apiOpen = (await D.api('/persons?moved=open&limit=50')).json.persons.map((p) => p.name);
check('Needs an address lists the right people (Eve, Hal …)', openNames.length === apiOpen.length && openNames.some((n) => /Eve/.test(n)) && openNames.some((n) => /Hal/.test(n)),
  `${openNames.join(', ')} | ${apiOpen.join(', ')}`);
await D.go('/people?moved=unknown');
await sleep(600);
const unkNames = await page.$$eval('.pp-row__name, .pp-table__name a', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('Address unknown lists Ben, Bea, Dee, Fay, Kim', unkNames.length === counts.unknown && ['Ben', 'Bea', 'Dee', 'Fay', 'Kim'].every((n) => unkNames.some((x) => x.includes(n))), unkNames.join(', '));
await simple(page, 'People Address unknown at 1440');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await simple(page, 'People Address unknown at 390');
await D.shot('14b-people-address-unknown-390');
await page.setViewportSize({ width: 1440, height: 900 });

// ── 11. Import: the list still has a mover's old address ──
await D.go('/people/import');
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', ['First Name\tSurname\tAddress\tCity', 'Ana\tExample\t12390 72 Ave\tSurrey', 'Zed\tExample\t7000 120 St\tSurrey'].join('\n'));
await page.click('button:has-text("Use this text")');
await page.waitForSelector('.imp-map__row', { timeout: 8000 });
await page.click('button:has-text("Check 2 rows")');
await page.waitForSelector('.vn-other__head', { timeout: 10000 }).catch(() => {});
const kept = await D.text('.vn-other');
check('"1 person on file has moved — the list still has their old address. We kept what your team found."', /1 person on file has moved — the list still has their old address\. We kept what your team found\./.test(kept), kept);
await page.click('.vn-other button:has-text("Show")');
await sleep(300);
const keptRow = await D.text('.vn-other');
check('Show: "Ana Example · list: 12390 72 Ave · on file: 12345 72 Ave"', /Ana Example · list: 12390 72 Ave · on file: 12345 72 Ave/.test(keptRow) && !!(await page.$(`.vn-other a[href$="/people/${P.ana.id}"]`)), keptRow);
await simple(page, 'import check at 1440');
await D.shot('15-import-moved-line-1440');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await simple(page, 'import check at 390');
await D.shot('15b-import-moved-line-390');

// ── The end ──
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed${BASE_PATH ? ` (under ${BASE_PATH})` : ''}`);
server.kill();
process.exit(failed ? 1 : 0);
