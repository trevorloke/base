// Lit drops E2E — one fresh in-memory campaign: a manager seeds four doors
// (one with two people) in a turf and a volunteer walks it on a phone. The
// walk list's outcome row reads "No answer · Left lit · Refused · Moved · No
// access"; "Left lit" logs a drop for everyone at the door, closes it with
// the toast "Left lit", asks for no rating, and the door's More line reads
// "Left lit · <time>". With no signal the toast reads "Left lit · Saved
// offline" and the drop is sent once when the signal is back. The map's door
// card offers "Left lit" at the door and not once the channel is a phone
// call (the Call tap, or "Phone call"); the Calls card never offers it.
// Today's More says "You 1 · Team 1 door lit this week" (then "doors lit"),
// and the profile's History says "Left lit", never "Talked". Every claim on
// a screen is checked against the API; each screen is measured (yellow
// buttons, sideways scroll, 48px targets); the audit chain verifies.
//
//   BASE_OPEN_SIGNUP=1 BASE_DATA=memory PORT=4430 node server/index.js &
//   BASE=http://127.0.0.1:4430 SHOTS=/tmp/litdrop node e2e-litdrop.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/base-ground-litdrop';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const tileSvg = (z, x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    const major = ((x * 256 + i) / 32) % 4 === 0;
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
  }
  for (let j = 0; j <= 256; j += 32) {
    const major = ((y * 256 + j) / 32) % 4 === 0;
    lines.push(`<line x1="0" y1="${j}" x2="256" y2="${j}" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
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
const helpers = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    text: async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [path, body]),
    go: async (path) => { await page.goto(`${/vol/.test(who) ? BASE : ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
  };
};
// Simplicity: words on the screen (not the nav/tab bar), yellow buttons,
// sideways scroll, and the smallest tap target among `sel`.
const measure = (page, sel = null) => page.evaluate((targets) => {
  const main = document.querySelector('main.page') || document.body;
  const words = (main.innerText || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      minTap = minTap == null ? h : Math.min(minTap, h);
    }
  }
  return { words, yellow, overflow, minTap };
}, sel);
const simple = async (pg, name, sel = null) => {
  const mm = await measure(pg, sel);
  check(`${name}: ≤ 1 yellow, no sideways scroll${sel ? ', targets ≥ 48px' : ''}`, mm.yellow <= 1 && mm.overflow <= 0 && (mm.minTap == null || mm.minTap >= 47.5), JSON.stringify(mm));
  return mm;
};

// ── 1. A manager, four doors in a turf (one door with two people), 555-01xx phones ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `riley+${tag}@litdrop.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const P = {};
const mk = async (key, data) => { P[key] = (await D.api('/actions/person.create', data)).json.person; };
await mk('ana', { name: 'Ana Example', phone: '604-555-0151', address: '12390 72 Ave', city: 'Surrey', lat: 49.13310, lng: -122.84950 });
await mk('ben', { name: 'Ben Example', phone: '604-555-0152', address: '12390 72 Ave', city: 'Surrey', lat: 49.13310, lng: -122.84950 });
await mk('cy', { name: 'Cy Example', phone: '604-555-0153', address: '7120 124 St', city: 'Surrey', lat: 49.13100, lng: -122.85200 });
await mk('dee', { name: 'Dee Example', phone: '604-555-0154', address: '12345 72 Ave', city: 'Surrey', lat: 49.13300, lng: -122.85100 });
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton East', polygon: [[49.125, -122.860], [49.140, -122.860], [49.140, -122.838], [49.125, -122.838]],
})).json.turf;
check('seeded four people at three doors in a turf', Object.values(P).every((p) => p?.id) && turf?.id);

// ── 2. A volunteer on a phone, on the turf ──
const invite = (await D.api('/actions/member.invite', { email: `amrit+${tag}@litdrop.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Amrit Volunteer', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const volId = (await V.api('/auth/me')).json.user.id;
check('volunteer walks the turf', (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId })).status === 200);

const contactsOf = async (id) => (await D.api(`/persons/${id}`)).json.contacts || [];
const lits = async (id) => (await contactsOf(id)).filter((c) => c.outcome === 'left_lit');
const openDoor = async (addr) => {
  const head = vpage.locator('.walk-door', { hasText: addr }).locator('.walk-door__head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await vpage.waitForSelector('.walk-door.is-open .walk-panel', { timeout: 5000 });
};
const outcomeRow = () => vpage.$$eval('.walk-door.is-open .walk-panel .fk-outcomes .fk-out', (els) => els.map((e) => e.innerText.trim())).catch(() => []);
const toastText = (sel) => vpage.$eval(sel, (el) => el.querySelector('span')?.innerText.trim() || '').catch(() => '');

// ── 3. The walk list: "Left lit" in the outcome row ──
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await openDoor('12390 72 Ave');
const row = await outcomeRow();
check('walk list outcome row: "No answer · Left lit · Refused · Moved · No access"', row.join(' · ') === 'No answer · Left lit · Refused · Moved · No access', row.join(' · '));
await simple(vpage, 'walk list door at 390', '.walk-door.is-open .walk-panel .fk-out');
await V.shot('01-walk-outcome-row');

// One tap: a drop for Ana and Ben, the door closes, toast "Left lit", no rating asked.
await vpage.tap('.walk-door.is-open .walk-panel .fk-out:has-text("Left lit")');
await vpage.waitForSelector('.walk-toast', { timeout: 5000 }).catch(() => {});
await sleep(600);
const toast1 = await toastText('.walk-toast');
check('tap: toast "Left lit"', toast1 === 'Left lit', toast1);
const doorState = await vpage.$eval('.walk-door:has-text("12390 72 Ave")', (el) => ({ open: el.classList.contains('is-open'), done: el.classList.contains('is-done') })).catch(() => null);
check('the door closes, done, and the next door opens', doorState && !doorState.open && doorState.done && !!(await vpage.$('.walk-door.is-open:not(:has-text("12390 72 Ave"))')), JSON.stringify(doorState));
const [aLit, bLit] = [await lits(P.ana.id), await lits(P.ben.id)];
check('server: one door left_lit each for Ana and Ben, by the volunteer', aLit.length === 1 && bLit.length === 1 && aLit[0].channel === 'door' && bLit[0].channel === 'door',
  JSON.stringify([aLit, bLit].map((l) => l.map((c) => `${c.channel}:${c.outcome}`))));
const rated = (await D.api(`/persons/${P.ana.id}`)).json.person?.rating ?? null;
check('no rating asked or set', rated === null && !(await vpage.$('.walk-door:has-text("12390 72 Ave") .rb-chip')), rated);
await V.shot('02-walk-left-lit');
// Reopen: the More line says "Left lit · <time>", never Talked.
await openDoor('12390 72 Ave');
const more = vpage.locator('.walk-door.is-open .walk-panel .fk-more__btn');
if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
await vpage.waitForSelector('.walk-door.is-open .walk-last', { timeout: 3000 }).catch(() => {});
const lastLine = (await vpage.$eval('.walk-door.is-open .walk-last', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''));
check('the door\'s More line: "Left lit · <time>"', /(^|· )Left lit · \d{1,2}:\d{2}/.test(lastLine) && !/Talked|left_lit/.test(lastLine), lastLine);
await vpage.locator('.walk-door.is-open .walk-door__head').click();

// ── 4. Today: "You 1 · Team 1 door lit this week" ──
const todayLit = async () => {
  await V.go('/');
  await vpage.waitForSelector('.today-morebox__toggle', { timeout: 8000 });
  await vpage.click('.today-morebox__toggle');
  await sleep(300);
  return vpage.$$eval('.today-mine', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()).find((t) => / lit this week$/.test(t)) || '').catch(() => '');
};
let lit = await todayLit();
let brief = (await V.api('/brief')).json.field;
check('Today More: "You 1 · Team 1 door lit this week" (API says the same)', lit === 'You 1 · Team 1 door lit this week' && brief.lit === 1 && brief.mine.lit === 1, `${lit} · ${JSON.stringify({ lit: brief.lit, mine: brief.mine })}`);
await simple(vpage, 'Today at 390');
await V.shot('03-today-lit');

// ── 5. No signal: "Left lit · Saved offline", sent once when the signal is back ──
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await vctx.setOffline(true);
await vpage.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(300);
await openDoor('7120 124 St');
await vpage.tap('.walk-door.is-open .walk-panel .fk-out:has-text("Left lit")');
await vpage.waitForSelector('.walk-toast', { timeout: 5000 }).catch(() => {});
await sleep(500);
const toast2 = await toastText('.walk-toast');
check('offline tap: toast "Left lit · Saved offline"', toast2 === 'Left lit · Saved offline', toast2);
const box = await vpage.evaluate(() => JSON.parse(localStorage.getItem('base:outbox:v2') || '[]'));
check('the outbox holds one drop for Cy', box.filter((i) => i.name === 'contact.log' && i.input?.outcome === 'left_lit' && i.input.person_id === P.cy.id).length === 1, JSON.stringify(box.map((i) => `${i.name}:${i.input?.outcome}`)));
const chip = await vpage.$eval('.offline-strip__chip', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
check('the strip: 1 saved on this phone', /^1 saved on this phone$/i.test(chip), chip);
await vpage.tap('.offline-strip__chip').catch(() => {});
await vpage.waitForSelector('.obx-sheet .obx-row', { timeout: 3000 }).catch(() => {});
const sheetRow = await vpage.$eval('.obx-sheet .obx-row', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
check('the phone sheet names it: "Left lit · Cy Example · …"', /^Left lit · Cy Example · /.test(sheetRow), sheetRow);
await V.shot('04-offline-left-lit');
await vpage.keyboard.press('Escape').catch(() => {});
check('…and the server has none yet', (await lits(P.cy.id)).length === 0);
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
for (let i = 0; i < 20; i += 1) {
  const left = await vpage.evaluate(() => JSON.parse(localStorage.getItem('base:outbox:v2') || '[]').filter((x) => x.state !== 'done').length);
  if (left === 0) break;
  await sleep(500);
}
await sleep(1500);
const cyLit = await lits(P.cy.id);
check('back online: the drop is sent once', cyLit.length === 1 && cyLit[0].channel === 'door', JSON.stringify(cyLit.map((c) => `${c.channel}:${c.outcome}`)));
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
await sleep(1500);
check('…and still once after another online nudge', (await lits(P.cy.id)).length === 1);

// ── 6. The map's door card: "Left lit" at the door, not on a phone call ──
await V.go(`/map?person=${P.dee.id}`);
await vpage.waitForSelector('aside.door-card', { timeout: 10000 });
await vpage.waitForSelector('aside.door-card .fk-outcomes', { timeout: 5000 }).catch(() => {});
const cardRow = () => vpage.$$eval('aside.door-card .fk-outcomes .fk-out', (els) => els.map((e) => e.innerText.trim())).catch(() => []);
let cr = await cardRow();
check('door card at the door: "No answer · Refused · Moved · No access · Left lit"', cr.join(' · ') === 'No answer · Refused · Moved · No access · Left lit', cr.join(' · '));
await simple(vpage, 'door card at 390', 'aside.door-card .fk-out');
await V.shot('05-door-card-door');
// The Call tap (the phone's own dialler; the card stays) — the channel is now a call.
await vpage.click('aside.door-card .fk-more__btn');
await vpage.waitForSelector('aside.door-card .fk-more__body', { timeout: 3000 }).catch(() => {});
const callLink = await vpage.$('aside.door-card a.door-act[href^="tel:"]');
if (callLink) {
  await callLink.evaluate((a) => a.addEventListener('click', (e) => e.preventDefault()));
  await callLink.click();
  await sleep(300);
  cr = await cardRow();
  check('after tapping Call: no "Left lit" (a call is not a drop)', cr.length > 0 && !cr.includes('Left lit') && /By phone/.test(await V.text()), cr.join(' · '));
  await vpage.click('aside.door-card button:has-text("At the door instead")').catch(() => {});
  await sleep(300);
}
if (!(await vpage.$('aside.door-card .fk-more__body'))) await vpage.click('aside.door-card .fk-more__btn');
await vpage.click('aside.door-card .door-channel__btn:has-text("Phone call")');
await sleep(300);
cr = await cardRow();
check('"How you reached them: Phone call": no "Left lit"', cr.join(' · ') === 'No answer · Refused · Moved · No access', cr.join(' · '));
await V.shot('06-door-card-phone');
await vpage.click('aside.door-card .door-channel__btn:has-text("At the door")');
await sleep(300);
cr = await cardRow();
check('back at the door: "Left lit" again', cr.includes('Left lit'), cr.join(' · '));
await vpage.tap('aside.door-card .fk-out:has-text("Left lit")');
await vpage.waitForSelector('.map-toast', { timeout: 5000 }).catch(() => {});
await sleep(500);
const mapToast = await vpage.$eval('.map-toast', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const deeLit = await lits(P.dee.id);
check('door card tap: toast "Left lit", one door drop for Dee', /^Left lit\b/.test(mapToast) && deeLit.length === 1 && deeLit[0].channel === 'door', `${mapToast} · ${deeLit.length}`);

// ── 7. Calls never offers it; Today counts the doors; the profile says "Left lit" ──
await V.go('/calls');
await vpage.waitForSelector('section.cl-card', { timeout: 8000 }).catch(() => {});
const callBtns = await vpage.$$eval('section.cl-card button', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
check('Calls card: a card to call, and no "Left lit" on it', callBtns.length > 0 && !callBtns.some((b) => /Left lit/.test(b)) && !/Left lit/.test(await V.text()), callBtns.join(' · '));

lit = await todayLit();
brief = (await V.api('/brief')).json.field;
check('Today More: "You 3 · Team 3 doors lit this week"', lit === 'You 3 · Team 3 doors lit this week' && brief.lit === 3 && brief.mine.lit === 3, `${lit} · ${JSON.stringify({ lit: brief.lit, mine: brief.mine })}`);

await D.go(`/people/${P.ana.id}`);
await page.waitForSelector('.pf-sec__btn:has-text("History")', { timeout: 8000 }).catch(() => {});
const hb = await page.$('.pf-sec__btn:has-text("History")');
if (hb && (await hb.getAttribute('aria-expanded')) !== 'true') { await hb.click(); await sleep(300); }
const hist = await page.$$eval('.pf-sec:has(.pf-sec__btn:has-text("History")) .timeline li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
check('profile History: "Left lit", by Amrit — never "Talked" or the code', hist.length === 1 && /Door/.test(hist[0]) && /Left lit/.test(hist[0]) && /Amrit Volunteer/.test(hist[0]) && !/Talked|left_lit/.test(hist[0]), hist.join(' | '));
const profileOut = await page.$$eval('.fk-out', (els) => els.map((e) => e.innerText.trim())).catch(() => []);
check('the profile never offers "Left lit"', !profileOut.includes('Left lit') && !/Left lit/.test(await page.$$eval('button', (els) => els.map((e) => e.innerText).join('|'))), profileOut.join(' · '));
await D.shot('07-profile-history');

// ── 8. Reports, and the books ──
const csv = await page.evaluate(async () => (await fetch('/api/reports/contacts.csv')).text());
const lines = csv.replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(','));
const head = lines[0] || [];
const sum = (col) => lines.slice(1).reduce((a, r) => a + Number(r[head.indexOf(col)] || 0), 0);
check('Contacts by week: a Lit column, 4 drops; Reached counts none of them', head.join('|') === 'Week of|Doors|Calls|Texts|Reached|No answer|Refused|Lit' && sum('Lit') === 4 && sum('Reached') === 0, `${head.join('|')} · lit ${sum('Lit')} · reached ${sum('Reached')}`);
const dash = await D.api('/dashboard?period=7d');
check('the dashboard answers, its rows count the drops', dash.status === 200 && dash.json.series.reduce((a, r) => a + (r.left_lit || 0), 0) === 4, dash.status);
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true && v.checked > 5, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
