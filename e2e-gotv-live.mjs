// Live GOTV E2E (GOTV stage 2) — one campaign on a file-backed database, the
// server started and restarted by this suite with the clock moved only by
// STARBASE_CLOCK_SHIFT_MS (STARBASE_E2E=1). Made-up people only.
//   0. seed through the voter guide’s own actions: an advance day (today) and
//      election day (both close 20:00), Place A and Place B, the checklist,
//      published "for GOTV mode too"; two turfs, a GOTV pass
//   1. the manager posts Sam at Place A; practice starts with Ana ticked;
//      Sam's Today has one primary, "Enter who voted", his turf quiet under
//      it; a sign-in code: two GETs leave it usable, the button signs in to
//      Who voted, and the code's session gets 403 on people
//   2. practice: Ana sees Practice, Ben (not ticked) no Voted ✓; Sam marks
//      Harjit; Ana's door leaves with "1 door left your list — they voted";
//      the manager ends practice: the door is back on the open phone and on
//      a phone that was offline and reopens from its copy
//   3. advance day 10:00: the desk's held line; Sam's two names wait on the
//      phone; staff's Enter a sheet is refused with the same words; the
//      manager releases the day; Sam matches both; Ana's list updates
//   4. the CEO's yes, As soon as entered: a mark reaches Ana live
//   5. offline name → matched with its written time; a look-up delayed 10 s
//      becomes a note after 4 s; Undo of a name written hours ago; Not sure?
//      Send to the office → To check → Find
//  5b. two quick marks while the first answer is slow: both listed, each
//      with Undo
//   6. Ben (turf B) never gets turf A's marks; his Calls has no A people
//   7. the stream cut: "Updated … ago", and polling catches up within 25 s
//  7b. Calls skips a person marked live; the card already open says
//      "Voted — skip"; two tabs: the one holding the stream goes hidden and
//      the visible one takes it over (Live, and the mark arrives)
//  10. 300 names at 180 ms a key (GOTV_NAMES): no 429, at most 3 look-ups
//      a name
//  11. Place A closed today from Website → Voter guide: Ana's /vote-info
//      strikes it live; Sam's mark is refused; election day it's open again;
//      Settings → Closing times reads the guide's 8 p.m.; a runner's look-up
//      refused at the closed place runs again at an open one
//  12. the day after election day, 01:58: a name written at 19:58 is on
//      Today ("You have 1 name not sent") and matched on Who voted; Undo
//      puts it back to match again, and matching it again marks them
//  12b. an off-duty runner the day after: 201 election-day names all to
//      match, today's to send; no place picker until a name is matched
//   9. staff see the switch read-only and no Sign-in code
//   8. Off: Ana's Voted ✓ goes and the stream closes
//   Screens looked at 1440×900 and 390×844 (SHOTS).
//
//   flock -o SP/batch6/locks/browser.lock node e2e-gotv-live.mjs        (5500)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 5500);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DESK = `${ORIGIN}/admin`;
const FIELD = ORIGIN;
const API = `${ORIGIN}/api`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-gotv-live';
const NAMES = Number(process.env.GOTV_NAMES || 300);
mkdirSync(SHOTS, { recursive: true });
const DATA = mkdtempSync(join(tmpdir(), 'gotv-e2e-'));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000, every = 400) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
};

// ── Days, by B.C.'s clock (UTC-7 all year) ──
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const bcDay = (ms) => new Date(ms - 7 * HOUR).toISOString().slice(0, 10);
const plus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const at = (day, hm) => Date.parse(`${day}T${hm}:00Z`) + 7 * HOUR;
const TODAY = bcDay(Date.now());
// The advance day is today (B.C.), so a phone's own clock and the server's
// agree on the day; the server's clock moves only the hour (10:00).
const A1 = TODAY; const G = plus(TODAY, 2);
let shift = 0;

let server = null;
const startServer = async (shift = 0) => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: DATA, STARBASE_E2E: '1', STARBASE_CLOCK_SHIFT_MS: String(Math.round(shift)) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 160; i += 1) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('server did not start');
};
const stopServer = async () => {
  if (!server) return;
  const s = server; server = null;
  s.kill('SIGTERM');
  await new Promise((r) => { s.once('exit', r); setTimeout(r, 5000); });
};
const moveTo = async (ms) => { await stopServer(); shift = ms - Date.now(); await startServer(shift); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const allPages = [];
const watch = (page, who) => {
  allPages.push([who, page]);
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (/hydrat|unique "key"/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return page;
};
const api = (page, path, body) => page.evaluate(async ([u, b]) => {
  const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: r.status, json, raw };
}, [`${API}${path}`, body]);
const act = (page, name, input) => api(page, `/actions/${name}`, input);
const text = async (page, sel = 'body') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ');
const measure = (page, targets = null) => page.evaluate((sel) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(vis).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (sel) for (const el of document.querySelectorAll(sel)) { if (!vis(el)) continue; const h = el.getBoundingClientRect().height; minTap = minTap == null ? h : Math.min(minTap, h); }
  return { yellow, overflow, minTap };
}, targets);
const simple = async (page, name, { phone = false, targets = null } = {}) => {
  const m = await measure(page, targets);
  check(`${name}: ≤ 1 primary, no sideways scroll${targets ? `, ≥ ${phone ? 48 : 40} px targets` : ''}`, m.yellow <= 1 && m.overflow <= 0 && (!targets || m.minTap === null || m.minTap >= (phone ? 47.5 : 39.5)), JSON.stringify(m));
};
const shot = (page, n, full = false) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });
const go = async (page, url) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); await sleep(900); };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const doorOf = (name) => `.walk-door:has(.walk-door__names:has-text("${name}"))`;
const hasDoor = async (page, name) => (await page.locator(doorOf(name)).count()) > 0;

let exitCode = 1;
try {
  await startServer(0);
  // ── 0. Seed ──
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
  const mpage = watch(await mctx.newPage(), 'manager');
  await go(mpage, `${DESK}/login`);
  const su = await api(mpage, '/auth/signup', { name: 'Mona Example', email: 'mona@example.org', password: 'gotv-live-2027', workspaceName: 'Example Campaign', jurisdiction: 'bc-municipal' });
  check('0. a manager signed up', su.status === 200 || su.status === 201, su.status);
  await act(mpage, 'site.settings.save', { org: { name: 'Example Campaign', agentName: 'Pat Example', agentContact: 'agent@example.org' } });
  const days = [{ day: A1, kind: 'advance', opens: '08:00', closes: '20:00' }, { day: G, kind: 'general', opens: '08:00', closes: '20:00' }];
  check('0. the guide’s days', (await act(mpage, 'site.guide.days', { days })).status === 200);
  const pa = (await act(mpage, 'site.guide.place.save', { name: 'Place A Example Hall', address: '100 Example Ave', city: 'Surrey', lat: 49.12, lng: -122.85, days: [{ day: A1 }, { day: G }] })).json;
  const pb = (await act(mpage, 'site.guide.place.save', { name: 'Place B Example School', address: '200 Example Ave', city: 'Surrey', lat: 49.15, lng: -122.83, days: [{ day: A1 }, { day: G }] })).json;
  const placeA = pa?.place?.id || pa?.id; const placeB = pb?.place?.id || pb?.id;
  check('0. two voting places', Boolean(placeA && placeB), JSON.stringify(pa).slice(0, 120));
  await act(mpage, 'site.guide.save', { vote_anywhere: true, official_url: 'https://elections.example/vote' });
  for (const section of ['days', 'places']) await act(mpage, 'site.guide.check', { section, checked: true });
  // People: turf A along 72 Ave, turf B along 80 Ave; 555-01xx phones.
  const P = {};
  const mk = async (key, name, rating, house, street, lat, lng) => {
    P[key] = (await act(mpage, 'person.create', { name, phone: `604-555-01${String(Object.keys(P).length + 10).slice(-2)}`, address: `${house} ${street}`, city: 'Surrey', lat, lng })).json.person;
    if (rating) await act(mpage, 'contact.log', { person_id: P[key].id, channel: 'door', outcome: 'contacted', rating });
  };
  const la = 49.1327; const lo = -122.855;
  await mk('harjit', 'Harjit Singh', '1', 14010, '72 Ave', la, lo);
  await mk('maya', 'Maya Example', '2', 14020, '72 Ave', la, lo + 0.0003);
  await mk('jo', 'Jovan Example', '1', 14030, '72 Ave', la, lo + 0.0006);
  await mk('lee', 'Leela Example', '1', 14040, '72 Ave', la, lo + 0.0009);
  await mk('kim', 'Kimiko Example', '1', 14050, '72 Ave', la - 0.0002, lo);
  await mk('ola', 'Olamide Example', '1', 14060, '72 Ave', la - 0.0002, lo + 0.0003);
  await mk('uma', 'Umaima Example', '1', 14070, '72 Ave', la - 0.0002, lo + 0.0006);
  await mk('pia', 'Piauna Example', '1', 14080, '72 Ave', la - 0.0002, lo + 0.0009);
  await mk('rae', 'Raeleen Example', '1', 14090, '72 Ave', la - 0.0004, lo);
  await mk('bea', 'Beatrix Example', '1', 15010, '80 Ave', 49.15, -122.83);
  // Off any turf: for two quick marks (5b) and a late match (12).
  for (const name of ['Alpha Example', 'Bravo Example', 'Quinn Example']) {
    P[name.split(' ')[0].toLowerCase()] = (await act(mpage, 'person.create', { name, phone: '604-555-0198' })).json.person;
  }
  for (let i = 0; i < NAMES; i += 1) {
    await act(mpage, 'person.create', { name: `Nina Zed${String(i).padStart(2, '0')}`, phone: '604-555-0199' });
  }
  const sq = (lat, lng) => [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]];
  const turfA = (await act(mpage, 'turf.create', { name: 'Turf A 72 Ave', polygon: sq(la, lo) })).json.turf;
  const turfB = (await act(mpage, 'turf.create', { name: 'Turf B 80 Ave', polygon: sq(49.15, -122.83) })).json.turf;
  check('0. people and two turfs', Object.values(P).every((p) => p?.id) && turfA?.id && turfB?.id);
  const pass = await act(mpage, 'pass.start', { name: 'Get out the vote', kind: 'gotv' });
  check('0. a GOTV pass is open', pass.status === 200, pass.raw);
  const join = async (role, name, email, opts) => {
    const inv = (await act(mpage, 'member.invite', { email, role })).json;
    const ctx = await browser.newContext({ deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...opts });
    const page = watch(await ctx.newPage(), name);
    await go(page, `${role === 'volunteer' ? FIELD : DESK}/login`);
    const r = await api(page, '/auth/join', { token: inv.joinUrl.split('/').pop(), name, password: 'knock-knock-2026' });
    return { ctx, page, ok: r.status === 200, id: (await api(page, '/auth/me')).json?.user?.id, name };
  };
  const sam = await join('volunteer', 'Sam Scrutineer', 'sam@example.org', PHONE);
  const ana = await join('volunteer', 'Ana Canvasser', 'ana@example.org', PHONE);
  const ben = await join('volunteer', 'Ben Canvasser', 'ben@example.org', PHONE);
  const sol = await join('staff', 'Sol Staff', 'sol@example.org', { viewport: { width: 1440, height: 900 } });
  check('0. a scrutineer, two canvassers and staff joined', sam.ok && ana.ok && ben.ok && sol.ok);
  for (const [t, u] of [[turfA, sam], [turfA, ana], [turfB, ben]]) await act(mpage, 'turf.assign', { turf_id: t.id, user_id: u.id });

  // ── 1. The post; practice; Sam's Today; a sign-in code ──
  const post = await act(mpage, 'gotv.post.set', { user_id: sam.id, role: 'scrutineer', place_id: placeA, days: [], appointed: true });
  check('1. the manager posts Sam at Place A', post.status === 200, post.raw);
  await go(mpage, `${DESK}/voted`);
  await mpage.waitForSelector('.gv-switch', { timeout: 10000 });
  await shot(mpage, '01-desk-off-1440');
  check('1. Off, no days yet: "Add your voting days in Settings." and a Ready chip', /Add your voting days in Settings\./.test(await text(mpage)) && /Ready \d of 9/.test(await text(mpage)));
  await simple(mpage, '1. Get out the vote (Off) at 1440', { targets: '.gv-switch button, .gv-tabs button' });
  await mpage.click('.gv-switch [role=radio]:has-text("Practice")');
  await mpage.waitForSelector('#gv-practice-h', { timeout: 5000 });
  await mpage.fill('#gv-practice-find', 'Ana');
  await mpage.check('.gv-pick-list label:has-text("Ana Canvasser") input');
  await shot(mpage, '02-desk-whos-practising-1440');
  await mpage.click('.gv-sheet button:has-text("Start practice")');
  await until(async () => (await api(mpage, '/voted/status')).json.practice === true);
  await sleep(800);
  check('1. Practice: the chip and its line', /Practice · 2 people/.test(await text(mpage)) && /only the 2 people practising see this/.test(await text(mpage)), (await text(mpage, 'header')).slice(0, 200));
  await shot(mpage, '03-desk-practice-1440');
  await go(sam.page, `${FIELD}/`);
  await sam.page.waitForSelector('section.today-go', { timeout: 10000 });
  const samPrimary = await sam.page.$$eval('.btn-primary', (b) => b.filter((x) => x.getBoundingClientRect().height > 0).map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  const samRow = await text(sam.page, '.today');
  check('1. Sam’s Today: one primary, "Enter who voted", his turf as a quiet row', samPrimary.length === 1 && /^Enter who voted/.test(samPrimary[0]) && /Your turf: Turf A 72 Ave/.test(samRow), JSON.stringify(samPrimary));
  await shot(sam.page, '04-scrutineer-today-390');
  await go(mpage, `${DESK}/voted?tab=scrutineers`);
  await mpage.click('.gv-table button:has-text("More")');
  await mpage.click('.gv-table button:has-text("Sign-in code")');
  await mpage.waitForSelector('.gv-url', { timeout: 5000 });
  const url = (await mpage.innerText('.gv-url')).trim();
  check('1. the code: a QR and the link, "Works once, for 15 minutes."', /\/go\/[0-9a-f]{64}$/.test(url) && !!(await mpage.$('.gv-qr svg')) && /Works once, for 15 minutes\./.test(await text(mpage)), url);
  await shot(mpage, '05-desk-signin-code-1440');
  const cctx = await browser.newContext({ deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...PHONE });
  const cpage = watch(await cctx.newPage(), 'code');
  const path = new URL(url).pathname;
  await go(cpage, `${ORIGIN}${path}`);
  await go(cpage, `${ORIGIN}${path}`);
  check('1. two GETs of the link leave it usable: "Sign in as Sam"', /Sign in as Sam/.test(await text(cpage)));
  await shot(cpage, '06-signin-page-390');
  await cpage.click('button:has-text("Sign in as Sam")');
  await cpage.waitForURL(/\/gotv$/, { timeout: 10000 });
  await cpage.waitForSelector('h1', { timeout: 8000 });
  check('1. the code signs in to "Who voted"', (await cpage.innerText('h1')) === 'Who voted');
  check('1. the code’s session gets 403 on people', (await api(cpage, '/persons')).status === 403);
  await go(cpage, `${FIELD}/people`);
  check('1. …and /people opens Who voted', (await cpage.innerText('h1').catch(() => '')) === 'Who voted');
  await cctx.close();

  // ── 2. Practice ──
  await go(ana.page, `${FIELD}/`);
  check('2. Ana (ticked) sees Practice', !!(await ana.page.$('.today-gotv .gv-practice')));
  await go(ben.page, `${FIELD}/turfs/${turfB.id}`);
  await ben.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  await ben.page.click(`${doorOf('Beatrix Example')} .walk-door__head`).catch(() => {});
  await sleep(500);
  check('2. Ben (not ticked) sees no Voted ✓ and no Practice', !(await ben.page.$('.vt-btn')) && !(await ben.page.$('.gv-practice')));
  // A second phone of Ana's that keeps her list, then goes offline.
  const a2ctx = await browser.newContext({ deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...PHONE });
  await a2ctx.addCookies(await ana.ctx.cookies());
  const a2 = watch(await a2ctx.newPage(), 'ana-2');
  await go(a2, `${FIELD}/turfs/${turfA.id}`);
  await a2.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  await go(ana.page, `${FIELD}/turfs/${turfA.id}`);
  await ana.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  check('2. Ana’s GOTV pass has Harjit’s door', await hasDoor(ana.page, 'Harjit Singh'));
  await a2ctx.setOffline(true);
  await go(sam.page, `${FIELD}/gotv`);
  await sam.page.waitForSelector('#gv-q', { timeout: 10000 });
  check('2. Who voted: the first line, the Practice chip', /Phones away inside the voting place\. Enter names outside\./.test(await text(sam.page)) && !!(await sam.page.$('.gv-practice')));
  await sam.page.type('#gv-q', 'harj', { delay: 120 });
  await sam.page.waitForSelector('.gv-row:has-text("Harjit Singh")', { timeout: 8000 });
  await shot(sam.page, '07-who-voted-results-390');
  const t0 = Date.now();
  await sam.page.click('.gv-row:has-text("Harjit Singh")');
  await sam.page.waitForSelector('.gv-toast__in', { timeout: 5000 }).catch(() => {});
  // One line: the name and "· Undo" sit side by side, nothing hangs on its own line.
  const toastLines = await sam.page.$eval('.gv-toast__in', (e) => {
    const r = document.createRange(); r.selectNodeContents(e);
    const mids = [...r.getClientRects()].filter((x) => x.width > 2).map((x) => x.top + x.height / 2).sort((x, y) => x - y);
    return mids.filter((m, i) => i === 0 || m - mids[i - 1] > 8).length;
  }).catch(() => 0);
  check('2. the toast is one line at 390', toastLines === 1, toastLines);
  check('2. one tap marks: "Marked Harjit Singh · Undo", the box cleared', /Marked Harjit Singh · Undo/.test(await text(sam.page, '.gv-toast')) && (await sam.page.inputValue('#gv-q')) === '');
  await shot(sam.page, '08-who-voted-toast-390');
  const left = await until(async () => !(await hasDoor(ana.page, 'Harjit Singh')) && /1 door left your list — they voted/.test(await text(ana.page, '.gv-left')), 15_000, 250);
  check(`2. Ana’s door for Harjit leaves, "1 door left your list — they voted" (${Math.round((Date.now() - t0) / 100) / 10} s; 5 s of it is the fade)`, left);
  await shot(ana.page, '09-walk-left-your-list-390');
  check('2. the record is untouched: Harjit isn’t voted', !(await api(mpage, `/voted/persons/${P.harjit.id}`)).json.voted_at);
  await go(mpage, `${DESK}/voted`);
  await mpage.click('.gv-switch [role=radio]:has-text("Off")');
  check('2. "End practice and wipe practice marks on every phone?"', /End practice and wipe practice marks on every phone\?/.test(await text(mpage, '.gv-ask')));
  await mpage.click('.gv-ask button:has-text("Yes")');
  const back = await until(async () => hasDoor(ana.page, 'Harjit Singh'), 60_000, 500);
  check('2. practice over: Harjit’s door is back on the phone that stayed open', back);
  await a2ctx.setOffline(false);
  await go(a2, `${FIELD}/turfs/${turfA.id}`);
  await a2.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  check('2. …and on the phone that was offline, reopened', await hasDoor(a2, 'Harjit Singh'));
  await a2ctx.close();

  // ── 3. Advance day (today), 10:00: published for GOTV mode too; names held until close ──
  const pub = await act(mpage, 'site.guide.publish', { gotv_days: true });
  const st0 = (await api(mpage, '/voted/status')).json;
  check('0. published "for GOTV mode too": GOTV has the guide’s days', pub.status === 200 && st0.election_day === G && st0.advance_days?.join() === A1, JSON.stringify({ pub: pub.status, st0 }));
  await moveTo(at(A1, '10:00'));
  await go(mpage, `${DESK}/voted`);
  await mpage.waitForSelector('.gv-switch', { timeout: 10000 });
  check('3. On by itself; the held line', /On by itself today/.test(await text(mpage)) && /Scrutineers’ names are held until polls close — Chief Election Officer not asked yet\./.test(await text(mpage)));
  await mpage.click('.gv-switch [role=radio]:has-text("On")').catch(() => {});
  await shot(mpage, '10-desk-on-held-1440');
  await go(sam.page, `${FIELD}/gotv`);
  await sam.page.waitForSelector('#gv-q', { timeout: 10000 });
  check('3. Sam: "Names are sent after this voting place closes at 8:00 p.m."', /Names are sent after this voting place closes at 8:00 p\.m\./.test(await text(sam.page)), (await text(sam.page)).slice(0, 300));
  for (const n of ['maya ex', 'jovan']) {
    await sam.page.fill('#gv-q', n);
    await sam.page.click('button:has-text("Save name")');
    await sleep(200);
  }
  check('3. "2 names to send" on the phone', /2 names to send/.test(await text(sam.page)));
  await shot(sam.page, '11-who-voted-after-close-390');
  await go(ana.page, `${FIELD}/turfs/${turfA.id}`);
  await ana.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  await sleep(2500);
  check('3. Ana’s list hasn’t changed', await hasDoor(ana.page, 'Maya Example') && await hasDoor(ana.page, 'Jovan Example'));
  // The desk's own Voted control on a person's page, while names are held.
  await go(mpage, `${DESK}/people/${P.harjit.id}`);
  await mpage.waitForSelector('.vt-row', { timeout: 10000 }).catch(() => {});
  check('3. a person’s page: Voted, and "From a scrutineer’s or runner’s sheet? Use Enter a sheet: those wait until polls close."',
    !!(await mpage.$('.vt-row')) && /From a scrutineer’s or runner’s sheet\? Use Enter a sheet: those wait until polls close\./.test(await text(mpage)), (await text(mpage, '.pf-rate')).slice(0, 300));
  await shot(mpage, '10b-desk-person-held-line-1440');
  await go(sol.page, `${DESK}/gotv?place=${placeA}`);
  await sol.page.waitForSelector('#gv-q', { timeout: 10000 });
  // Staff's own page, before close, writes notes; the server says why if asked.
  const solFind = await api(sol.page, `/gotv/find?q=harj&place_id=${placeA}`);
  const solMark = await act(sol.page, 'vote.mark', { person_id: P.harjit.id, voted: true, source: 'scrutineer', place_id: placeA });
  check('3. staff’s Enter a sheet is refused with the same words', solFind.status === 409 && solMark.status === 409 && /Names go to the office after polls close\./.test(solFind.json?.error), JSON.stringify([solFind.json, solMark.json]));
  await go(mpage, `${DESK}/voted?tab=settings`);
  await mpage.click('button:has-text("Polls are closed — send names now")');
  await until(async () => (await api(sam.page, '/voted/status')).json.send_open === true);
  await go(sam.page, `${FIELD}/gotv`);
  await sam.page.waitForSelector('.gv-notes', { timeout: 10000 });
  check('3. "Polls closed — match your 2 names"', /Polls closed — match your 2 names/.test(await text(sam.page)));
  await shot(sam.page, '12-who-voted-names-to-match-390');
  for (const who of ['Maya Example', 'Jovan Example']) {
    await sam.page.click('.gv-note__match >> nth=0');
    await sam.page.waitForSelector(`.gv-row:has-text("${who}")`, { timeout: 8000 }).catch(() => {});
    await sam.page.click(`.gv-row:has-text("${who}")`).catch(() => {});
    await sleep(600);
  }
  const both = await until(async () => !(await hasDoor(ana.page, 'Maya Example')) && !(await hasDoor(ana.page, 'Jovan Example')), 15_000, 300);
  check('3. Sam matches both; Ana’s list loses both doors', both);

  // ── 4. Live: the CEO's yes ──
  await go(mpage, `${DESK}/voted?tab=settings`);
  await mpage.click('#gv-ready button:has-text("Record their answer")');
  await mpage.click('input[name=gv-ceo] >> nth=0');
  await mpage.fill('#gv-ceo-note', 'Asked by email; yes for advance and general voting');
  await mpage.click('button:has-text("Save the answer")');
  await sleep(800);
  await mpage.click('input[name=gv-send] >> nth=1');
  await until(async () => (await api(mpage, '/voted/status')).json.send === 'live');
  check('4. As soon as entered (after the CEO’s yes)', (await api(mpage, '/voted/status')).json.send === 'live');
  await shot(mpage, '13-desk-settings-1440', true);
  await sam.page.fill('#gv-q', '');
  await sam.page.type('#gv-q', 'leela', { delay: 60 });
  await sam.page.click('.gv-row:has-text("Leela Example")', { timeout: 8000 });
  const t4 = Date.now();
  const leela = await until(async () => !(await hasDoor(ana.page, 'Leela Example')), 15_000, 250);
  check(`4. a live mark reaches Ana (${Math.round((Date.now() - t4) / 100) / 10} s incl. the 5 s fade)`, leela);

  // ── 5. Offline, weak signal, Undo, To check ──
  await sam.ctx.setOffline(true);
  await sleep(500);
  check('5. no signal: "No signal — write the name, we’ll match it later"', (await sam.page.getAttribute('#gv-q', 'placeholder')) === 'No signal — write the name, we’ll match it later');
  await shot(sam.page, '14-who-voted-no-signal-390');
  const writtenAt = Date.now();
  await sam.page.fill('#gv-q', 'kimiko');
  await sam.page.click('button:has-text("Save name")');
  await sam.ctx.setOffline(false);
  await sam.page.waitForSelector('.gv-note__match', { timeout: 10000 });
  await sam.page.click('.gv-note__match:has-text("kimiko")');
  await sam.page.click('.gv-row:has-text("Kimiko Example")', { timeout: 8000 });
  await until(async () => Boolean((await api(mpage, `/voted/persons/${P.kim.id}`)).json.voted_at));
  const km = (await api(mpage, `/voted/persons/${P.kim.id}`)).json;
  // When it was written (never later than the server's now: its clock is moved).
  check('5. matched later: the mark’s time is when it was written', km.marks?.[0] && Math.abs(Date.parse(km.marks[0].created_at) - Math.min(writtenAt, Date.now() + shift)) < 90_000, JSON.stringify(km.marks?.[0]));
  await sam.page.route('**/api/gotv/find**', async (route) => { await sleep(10_000); await route.continue().catch(() => {}); });
  await sam.page.fill('#gv-q', '');
  const tw = Date.now();
  await sam.page.type('#gv-q', 'umaima', { delay: 40 });
  const noted = await until(async () => /Saved — we’ll match it when signal is back/.test(await text(sam.page)), 9000, 200);
  check(`5. a look-up with no answer becomes a note after 4 s, no retyping (${Math.round((Date.now() - tw) / 100) / 10} s)`, noted && (Date.now() - tw) < 7000 && /umaima/.test(await text(sam.page, '.gv-notes')));
  check('5. in note mode the names wait: "… to send", none to match yet', /names? to send/.test(await text(sam.page, '.gv-notes')) && (await sam.page.locator('button.gv-note__match').count()) === 0, await text(sam.page, '.gv-notes'));
  await shot(sam.page, '15-who-voted-weak-signal-390');
  await sam.page.unroute('**/api/gotv/find**');
  // A name written hours ago, matched now, and taken back.
  const hoursAgo = new Date(at(A1, '10:00') - 3 * HOUR).toISOString();
  await sam.page.evaluate(([ws, uid, w]) => {
    const k = `starbase:gotv-notes:${ws}:${uid}`;
    const list = JSON.parse(localStorage.getItem(k) || '[]');
    list.push({ id: 'note-olamide', typed: 'olamide', written_at: w, place_id: null });
    localStorage.setItem(k, JSON.stringify(list));
  }, [(await api(sam.page, '/auth/me')).json.workspace.id, sam.id, hoursAgo]);
  await go(sam.page, `${FIELD}/gotv`);
  await sam.page.click('.gv-note__match:has-text("olamide")', { timeout: 8000 });
  await sam.page.click('.gv-row:has-text("Olamide Example")', { timeout: 8000 });
  await until(async () => Boolean((await api(mpage, `/voted/persons/${P.ola.id}`)).json.voted_at));
  await sam.page.click('.gv-disclose');
  await sam.page.click('.gv-entered li:has-text("Olamide Example") button:has-text("Undo")');
  const undone = await until(async () => !(await api(mpage, `/voted/persons/${P.ola.id}`)).json.voted_at, 10_000);
  check('5. Undo from Entered today, for a name written 3 hours ago', undone);
  await shot(sam.page, '16-who-voted-entered-today-390');
  await go(sam.page, `${FIELD}/gotv`);
  await sam.page.type('#gv-q', 'umaxx zzq', { delay: 40 });
  await sam.page.waitForSelector('text=No one by that name.', { timeout: 8000 }).catch(() => {});
  check('5. no match: "No one by that name." and "Not sure? Send to the office"', /No one by that name\./.test(await text(sam.page)) && !!(await sam.page.$('.gv-office')));
  await shot(sam.page, '17-who-voted-no-results-390');
  await sam.page.click('.gv-office');
  await until(async () => (await api(mpage, '/gotv/checks?open=1')).json.checks?.length > 0);
  await go(mpage, `${DESK}/voted?tab=check`);
  await mpage.waitForSelector('.gv-table', { timeout: 8000 });
  await shot(mpage, '18-desk-to-check-1440');
  await mpage.click('.gv-table button:has-text("Find")');
  await mpage.fill('.gv-sheet input', 'Umaima');
  await mpage.click('text=Umaima Example', { timeout: 8000 });
  const resolved = await until(async () => Boolean((await api(mpage, `/voted/persons/${P.uma.id}`)).json.voted_at));
  check('5. "Sent to the office" lands in To check, and Find resolves it', resolved);
  await go(mpage, `${DESK}/voted?tab=check`);
  check('5. To check: "Nothing to check."', /Nothing to check\./.test(await text(mpage)));

  // ── 5b. Two quick marks while the first answer is slow: both kept ──
  await sam.page.route('**/api/actions/vote.mark', async (route) => { await sleep(4000); await route.continue().catch(() => {}); });
  await go(sam.page, `${FIELD}/gotv`);
  await sam.page.type('#gv-q', 'alpha exa', { delay: 40 });
  await sam.page.click('.gv-row:has-text("Alpha Example")', { timeout: 8000 });
  await sam.page.type('#gv-q', 'bravo exa', { delay: 40 });
  await sam.page.click('.gv-row:has-text("Bravo Example")', { timeout: 8000 });
  await until(async () => Boolean((await api(mpage, `/voted/persons/${P.alpha.id}`)).json.voted_at) && Boolean((await api(mpage, `/voted/persons/${P.bravo.id}`)).json.voted_at), 20_000, 500);
  await sleep(1500);
  await sam.page.unroute('**/api/actions/vote.mark');
  await sam.page.click('.gv-disclose');
  const listed = await sam.page.$$eval('.gv-entered li', (li) => li.map((x) => x.textContent));
  const undoable = (n) => listed.some((t) => t.includes(n) && /Undo/.test(t));
  check('5b. two quick picks while the first answer is slow: both in Entered today, each with Undo', undoable('Alpha Example') && undoable('Bravo Example'), listed.join(' | '));
  check('5b. …and the count has both', /\b\d+ names entered today/.test(await text(sam.page, '.gv-count')) && Number((await text(sam.page, '.gv-count')).match(/\d+/)?.[0]) >= 2, await text(sam.page, '.gv-count'));

  // ── 6. Scope ──
  const benChanges = (await api(ben.page, '/voted/changes?since=1')).json;
  const aIds = [P.harjit, P.maya, P.jo, P.lee, P.kim, P.ola, P.uma, P.pia, P.rae].map((p) => p.id);
  check('6. Ben gets none of turf A’s marks', !JSON.stringify(benChanges).match(new RegExp(aIds.join('|'))), JSON.stringify(benChanges).slice(0, 200));
  const benCalls = (await api(ben.page, '/persons?rating=1,2')).json;
  check('6. Ben’s Calls has no turf A people', Array.isArray(benCalls?.persons) && !benCalls.persons.some((p) => aIds.includes(p.id)), JSON.stringify(benCalls).slice(0, 200));

  // ── 7. The stream cut ──
  await ana.page.route('**/api/voted/live', (route) => route.abort());
  await go(ana.page, `${FIELD}/turfs/${turfA.id}`);
  await ana.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  const polling = await until(async () => /Updated/.test(await text(ana.page, '.gv-live')), 15_000);
  check('7. the stream cut: the chip says "Updated … ago"', polling, await text(ana.page, '.gv-live'));
  await shot(ana.page, '19-walk-updated-chip-390');
  await sam.page.fill('#gv-q', '');
  await sam.page.type('#gv-q', 'piauna', { delay: 40 });
  await sam.page.click('.gv-row:has-text("Piauna Example")', { timeout: 8000 });
  const t7 = Date.now();
  const caught = await until(async () => !(await hasDoor(ana.page, 'Piauna Example')), 32_000, 500);
  check(`7. polling catches up (${Math.round((Date.now() - t7) / 1000)} s incl. the 5 s fade)`, caught);
  await ana.page.unroute('**/api/voted/live');
  await go(ana.page, `${FIELD}/turfs/${turfA.id}`);
  check('7. back on the stream: "Live"', await until(async () => /Live/.test(await text(ana.page, '.gv-live')), 15_000));
  await shot(ana.page, '20-walk-live-chip-390');

  // ── 7b. Calls skips who voted; two tabs ──
  const mark = (p) => act(mpage, 'vote.mark', { person_id: p.id, voted: true, source: 'desk' });
  const left3 = [P.harjit, P.ola, P.rae];
  await go(ana.page, `${FIELD}/calls?rating=1,2&voted=no`);
  await ana.page.waitForSelector('.cl-card', { timeout: 10000 }).catch(() => {});
  const cname = (await ana.page.innerText('.cl-name').catch(() => '')).trim();
  const cur = left3.find((p) => p.name === cname);
  const other = left3.find((p) => p !== cur);
  check('7b. Calls: three supporters not marked yet', Boolean(cur) && /3 to call/.test(await text(ana.page, '.cl-progress')), `${cname} | ${await text(ana.page, '.cl-progress')}`);
  await mark(other);
  const skipped = await until(async () => /2 to call/.test(await text(ana.page, '.cl-progress')), 10_000, 250);
  check(`7b. Calls skips ${other?.name} once marked elsewhere`, skipped, await text(ana.page, '.cl-progress'));
  await mark(cur);
  const chipOn = await until(async () => /Voted — skip/.test(await text(ana.page, '.cl-card')) && (await ana.page.innerText('.cl-name')).trim() === cname, 10_000, 250);
  check('7b. the card already open stays, with "Voted — skip"', chipOn);
  await shot(ana.page, '20b-calls-voted-skip-390');
  // Two tabs: the first (holding the stream) goes hidden; the second takes over.
  const last1 = left3.find((p) => p !== cur && p !== other);
  await go(ana.page, `${FIELD}/turfs/${turfA.id}`);
  await ana.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  await until(async () => /Live/.test(await text(ana.page, '.gv-live')), 10_000);
  const tab2 = watch(await ana.ctx.newPage(), 'ana-tab-2');
  await go(tab2, `${FIELD}/turfs/${turfA.id}`);
  await tab2.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  const setHidden = (pg, hidden) => pg.evaluate((h) => {
    if (h) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    else delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(ana.page, true);
  await sleep(1500);
  await mark(last1);
  const t7b = Date.now();
  const tookOver = await until(async () => !(await hasDoor(tab2, last1.name)), 15_000, 250);
  check(`7b. the first tab hidden: the second gets ${last1?.name}’s mark (${Math.round((Date.now() - t7b) / 100) / 10} s incl. the 5 s fade)`, tookOver);
  check('7b. …and says "Live"', /Live/.test(await text(tab2, '.gv-live')), await text(tab2, '.gv-live'));
  await tab2.close();
  await setHidden(ana.page, false);

  // ── 10. Many names at a runner's typing speed ──
  const before = ((await api(mpage, '/gotv/posts')).json.posts.find((p) => p.user_id === sam.id) || {}).lookups || 0;
  let refused = 0;
  let missed = 0;
  sam.page.on('response', (r) => { if (r.url().includes('/api/gotv/find') && r.status() === 429) refused += 1; });
  await go(sam.page, `${FIELD}/gotv`);
  const tn = Date.now();
  for (let i = 0; i < NAMES; i += 1) {
    const nm = `Nina Zed${String(i).padStart(2, '0')}`;
    await sam.page.fill('#gv-q', '');
    await sam.page.type('#gv-q', `zed${String(i).padStart(2, '0')}`, { delay: 180 });
    const ok = await sam.page.click(`.gv-row:has-text("${nm}")`, { timeout: 8000 }).then(() => true, () => false);
    if (!ok) {
      missed += 1;
      if (missed <= 3) console.log(`   10. no row for ${nm}: ${(await text(sam.page, 'main').catch(() => '')).slice(0, 300)}`);
    }
  }
  const after = ((await api(mpage, '/gotv/posts')).json.posts.find((p) => p.user_id === sam.id) || {}).lookups || 0;
  check(`10. ${NAMES} names at 180 ms a key in ${Math.round((Date.now() - tn) / 1000)} s: no 429, ≤ 3 look-ups a name (${after - before} look-ups, ${refused} refused, ${missed} without a row)`, refused === 0 && missed === 0 && after - before <= 3 * NAMES && after - before >= NAMES);

  // ── 11. The guide's live correction ──
  await go(ana.page, `${FIELD}/vote-info`);
  await ana.page.waitForSelector('.vi-places', { timeout: 8000 }).catch(() => {});
  await go(mpage, `${DESK}/website/guide`);
  await mpage.waitForSelector('#wg-places .wg-table', { timeout: 10000 }).catch(() => {});
  await mpage.click('#wg-places .wg-table button:has-text("Place A Example Hall")');
  await mpage.click('#wg-places [role=switch]:has-text("Closed today")');
  await mpage.click('#wg-places .wg-place button:text-is("Save")');
  const t11 = Date.now();
  const struck = await until(async () => (await ana.page.locator('.vi-place[data-closed] .vi-place__name:has-text("Place A Example Hall")').count()) === 1, 8000, 250);
  check(`11. Ana’s Where to vote strikes Place A without a reload (${Math.round((Date.now() - t11) / 100) / 10} s)`, struck && Date.now() - t11 < 5500);
  await shot(ana.page, '21-vote-info-closed-390');
  const closed = await act(sam.page, 'vote.mark', { person_id: P.bea.id, voted: true, source: 'scrutineer', place_id: placeA, client_id: '11111111-1111-4111-8111-111111111111' });
  check('11. Sam at a closed place: "That voting place is closed today"', closed.status === 409 && /That voting place is closed today/.test(closed.json?.error), closed.raw);
  await go(mpage, `${DESK}/voted?tab=places`);
  check('11. Voting places lists both places from the guide', /Place A Example Hall/.test(await text(mpage)) && /Place B Example School/.test(await text(mpage)));
  await shot(mpage, '22-desk-voting-places-1440');
  await go(mpage, `${DESK}/voted?tab=scrutineers`);
  await mpage.click('button:has-text("Add a scrutineer")');
  await mpage.waitForFunction(() => document.querySelectorAll('#gv-place option').length > 2, null, { timeout: 8000 }).catch(() => {});
  const opts = await mpage.$$eval('#gv-place option', (o) => o.map((x) => x.textContent));
  check('11. Add a scrutineer offers the guide’s places', opts.includes('Place A Example Hall') && opts.includes('Place B Example School'), opts.join('|'));
  await shot(mpage, '23-desk-add-scrutineer-1440');
  // A runner's look-up at the closed place is refused; at an open one it runs.
  await go(sol.page, `${DESK}/gotv?place=${placeA}`);
  await sol.page.waitForSelector('#gv-q', { timeout: 10000 });
  await sol.page.type('#gv-q', 'beatrix', { delay: 60 });
  const refusedA = await until(async () => /That voting place is closed today/.test(await text(sol.page)), 8000, 250);
  await sol.page.selectOption('.gv-pick__sel', placeB);
  const ranB = await until(async () => (await sol.page.locator('.gv-row:has-text("Beatrix Example")').count()) === 1, 8000, 250);
  check('11. a look-up refused at the closed place runs again at an open one', refusedA && ranB && !(await sol.page.$('button:has-text("Save name")')), (await text(sol.page)).slice(0, 300));
  await shot(sol.page, '23b-who-voted-other-place-1440');

  // ── 9. Staff ──
  await go(sol.page, `${DESK}/voted`);
  await sol.page.waitForSelector('.gv-switch', { timeout: 10000 });
  const disabled = await sol.page.$$eval('.gv-switch button', (b) => b.every((x) => x.disabled));
  await go(sol.page, `${DESK}/voted?tab=scrutineers`);
  check('9. staff: the switch is read-only, no Sign-in code', disabled && !(await sol.page.$('button:has-text("Sign-in code")')) && !(await sol.page.$('.gv-table button:has-text("More")')));
  await shot(sol.page, '24-desk-staff-scrutineers-1440');

  // ── Phone looks of the desk, and the screens at 390 ──
  const mp = await browser.newContext({ deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...PHONE });
  await mp.addCookies(await mctx.cookies());
  const mph = watch(await mp.newPage(), 'manager-phone');
  for (const t of ['turnout', 'places', 'scrutineers', 'check', 'settings']) {
    await go(mph, `${DESK}/voted?tab=${t}`);
    await mph.waitForSelector('.gv-switch', { timeout: 10000 }).catch(() => {});
    await simple(mph, `desk ${t} at 390`, { phone: true, targets: '.gv-switch button, .gv-tabs button, .gv-table .btn' });
    await shot(mph, `25-desk-${t}-390`, true);
  }
  await mp.close();
  await go(sam.page, `${FIELD}/gotv`);
  await simple(sam.page, 'Who voted at 390', { phone: true, targets: '#gv-q, .gv-row, .gv-note__match, .gv-disclose' });
  const inH = await sam.page.$eval('#gv-q', (e) => e.getBoundingClientRect().height);
  check('Who voted: the input is 56 px', inH >= 55.5, inH);

  // ── 11b. Election day: Place A open again; the guide's 8 p.m. ──
  await moveTo(at(G, '10:00'));
  const openAgain = await act(sam.page, 'vote.mark', { person_id: P.bea.id, voted: true, source: 'scrutineer', place_id: placeA, client_id: '22222222-2222-4222-8222-222222222222' });
  check('11. election day: Place A is open again and Sam’s mark is accepted', openAgain.status === 200, openAgain.raw);
  await go(mpage, `${DESK}/voted?tab=settings`);
  check('11. Settings → Closing times: "From the voter guide: 8 p.m."', /From the voter guide: 8 p\.m\./.test(await text(mpage)));

  // ── 12. After midnight: a name written at 19:58 is still matched ──
  ok12: {
    check('12. back to After polls close', (await act(mpage, 'vote.settings', { send: 'after_close' })).status === 200);
    await moveTo(at(plus(G, 1), '01:58'));
    const wq = new Date(at(G, '19:58')).toISOString();
    const me = (await api(sam.page, '/auth/me')).json;
    await sam.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`starbase:gotv-notes:${me.workspace.id}:${me.user.id}`, JSON.stringify([{ id: 'note-quinn', typed: 'quinn exa', written_at: wq, place_id: placeA }])]);
    await go(sam.page, `${FIELD}/`);
    check('12. Today, the day after: "You have 1 name not sent"', await until(async () => /You have 1 name not sent/.test(await text(sam.page)), 8000), (await text(sam.page)).slice(0, 300));
    await go(sam.page, `${FIELD}/gotv`);
    const listedQ = await until(async () => /Polls closed — match your 1 name/.test(await text(sam.page)), 10_000, 300);
    check('12. Who voted at 01:58: "Polls closed — match your 1 name"', listedQ, (await text(sam.page)).slice(0, 300));
    await shot(sam.page, '27-who-voted-after-midnight-390');
    if (!listedQ) break ok12;
    await sam.page.click('.gv-note__match:has-text("quinn")');
    await sam.page.click('.gv-row:has-text("Quinn Example")', { timeout: 8000 });
    await until(async () => Boolean((await api(mpage, `/voted/persons/${P.quinn.id}`)).json.voted_at), 10_000);
    const qm = (await api(mpage, `/voted/persons/${P.quinn.id}`)).json;
    check('12. matched after midnight with its own time, 19:58', qm.marks?.[0] && Date.parse(qm.marks[0].created_at) === Date.parse(wq), JSON.stringify(qm.marks?.[0]));
    check('12. the note is gone from the phone', await until(async () => !/not sent|to send|match your/.test(await text(sam.page)), 5000), (await text(sam.page)).slice(0, 300));
    // A wrong pick, taken back: off duty there is no box to type it again, so the name comes back.
    if (!(await sam.page.$('.gv-toast__act'))) await sam.page.click('.gv-disclose', { timeout: 5000 }).catch(() => {});
    await sam.page.click('.gv-toast__act, .gv-entered button:has-text("Undo")', { timeout: 5000 }).catch(() => {});
    await until(async () => !(await api(mpage, `/voted/persons/${P.quinn.id}`)).json.voted_at, 10_000);
    check('12. Undo after midnight: the name is back under "Polls closed — match your 1 name"',
      await until(async () => /Polls closed — match your 1 name/.test(await text(sam.page)) && (await sam.page.locator('.gv-note__match:has-text("quinn exa")').count()) === 1, 5000),
      (await text(sam.page)).slice(0, 300));
    await shot(sam.page, '27b-who-voted-undo-after-midnight-390');
    // Matched again to the same person: the Undo is not a later tap, so it marks them.
    await sam.page.click('.gv-note__match:has-text("quinn")');
    await sam.page.click('.gv-row:has-text("Quinn Example")', { timeout: 8000 });
    const again = await until(async () => Boolean((await api(mpage, `/voted/persons/${P.quinn.id}`)).json.voted_at), 10_000);
    const qa = (await api(mpage, `/voted/persons/${P.quinn.id}`)).json;
    check('12. matched again after Undo: voted, at 19:58', again && Date.parse(qa.voted_at) === Date.parse(wq), JSON.stringify({ voted_at: qa.voted_at }));
    check('12. matched again: the note is gone', await until(async () => !/not sent|to send|match your/.test(await text(sam.page)), 5000), (await text(sam.page)).slice(0, 300));
  }
  // ── 12b. An off-duty runner the day after: 201 names from election day, one from today ──
  ok12b: {
    check('12b. Ben is a runner', (await act(mpage, 'gotv.post.set', { user_id: ben.id, role: 'runner', days: [], appointed: true })).status === 200);
    const me = (await api(ben.page, '/auth/me')).json;
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `note-b${i}`, typed: `name ${i}`, written_at: new Date(at(G, '16:00') + i * 1000).toISOString(), place_id: placeA }));
    many.push({ id: 'note-today', typed: 'today exa', written_at: new Date(at(plus(G, 1), '01:00')).toISOString(), place_id: placeB });
    await ben.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`starbase:gotv-notes:${me.workspace.id}:${me.user.id}`, JSON.stringify(many)]);
    await go(ben.page, `${FIELD}/gotv`);
    const all = await until(async () => /Polls closed — match your 201 names/.test(await text(ben.page)), 12_000, 400);
    const t12 = await text(ben.page);
    check('12b. all 201 election-day names may be matched; only today’s is "to send"', all && /1 name to send/.test(t12), t12.slice(0, 300));
    check('12b. off duty, nothing to enter: no place picker and no "Pick the voting place"', !/Pick the voting place/.test(t12) && !(await ben.page.$('.gv-pick__sel')) && !(await ben.page.$('#gv-q')), t12.slice(0, 300));
    await shot(ben.page, '27c-who-voted-runner-off-duty-390');
    await ben.page.setViewportSize({ width: 1440, height: 900 });
    await shot(ben.page, '27d-who-voted-runner-off-duty-1440');
    await ben.page.setViewportSize({ width: 390, height: 844 });
    if (!all) break ok12b;
    // Matching one shows the place it was written at; the others stay listed when it is done.
    await ben.page.click('.gv-note__match:has-text("name 7")');
    check('12b. matching: the box and the note’s place show', await until(async () => Boolean(await ben.page.$('#gv-q')) && (await ben.page.$eval('.gv-pick__sel', (s) => s.value).catch(() => '')) === placeA, 5000));
    await ben.page.click('.gv-x[aria-label="Delete name 7"]');
    await ben.page.click('.gv-confirm button:has-text("Yes")');
    const back = await until(async () => /Polls closed — match your 200 names/.test(await text(ben.page)) && /1 name to send/.test(await text(ben.page)) && !(await ben.page.$('#gv-q')), 5000);
    check('12b. done matching: both lists, every place, no box', back, (await text(ben.page)).slice(0, 300));
    await ben.page.evaluate(([k]) => localStorage.removeItem(k), [`starbase:gotv-notes:${me.workspace.id}:${me.user.id}`]);
  }
  await moveTo(at(G, '10:00'));

  // ── 8. Off ──
  await go(ana.page, `${FIELD}/turfs/${turfA.id}`);
  await ana.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  await go(mpage, `${DESK}/voted`);
  await mpage.click('.gv-switch [role=radio]:has-text("Off")');
  await mpage.click('.gv-ask button:has-text("Yes")');
  await until(async () => (await api(mpage, '/voted/status')).json.on === false);
  const gone = await until(async () => {
    const d = ana.page.locator('.walk-door').first();
    if (!(await ana.page.$('.walk-door.is-open'))) await d.locator('.walk-door__head').click().catch(() => {});
    return !(await ana.page.$('.vt-btn')) && (await ana.page.locator('.gv-live').count()) === 0;
  }, 60_000, 1000);
  check('8. Off: within 60 s Ana’s Voted ✓ and the Live chip are gone', gone);
  await shot(mpage, '26-desk-off-after-1440');

  const v = (await api(mpage, '/audit/verify')).json;
  check('the books verify after every kind of GOTV write', v?.ok === true, JSON.stringify(v));
  check('no page errors', errors.length === 0, errors.join(' | '));
  exitCode = results.every(Boolean) ? 0 : 1;
} catch (e) {
  console.error(e);
  for (const [who, pg] of allPages) {
    await pg.screenshot({ path: `${SHOTS}/zz-fail-${who.replace(/\W+/g, '-')}.png` }).catch(() => {});
    console.error(`[${who}] ${pg.url()} :: ${(await text(pg).catch(() => '')).slice(0, 400)}`);
  }
  check('the suite ran to the end', false, e.message);
} finally {
  await browser.close().catch(() => {});
  await stopServer();
  rmSync(DATA, { recursive: true, force: true });
  const fails = results.filter((r) => !r).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : exitCode);
}
