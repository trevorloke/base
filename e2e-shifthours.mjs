// A person's own hours on a shift E2E — one fresh in-memory campaign. A
// volunteer, Priya, on a phone (390×844): "Count me in" on a 2–8 pm canvass,
// then "Change my hours" → From 4:30 → Until 6 → "Save my hours" (four taps):
// the line reads "4:30–6 pm" and her list row "You’re on ✓ · 4:30–6 pm".
// With no signal her change waits on the phone ("Not sent yet") and goes
// when the signal is back. With no signal, "Count me in" on another shift,
// then her hours on it, then "Take back": once the signal is back nothing is
// left unsent and the server has no booking. A drop-in shift reads
// "Drop in · 4–8 pm" on the list and "Tell us when you’ll come" on its page.
// The desk (1440×900) sees her hours on the roster, sets another person's
// from the person sheet ("Save hours"), and the check-in board shows both.
// The website's openings card says "Drop in". Every screen is measured (one
// main button, no sideways scroll, 48px targets on the phone) and every
// claim checked against the API.
//
//   (cd web && npm run build)
//   PORT=5153 SHOTS=/tmp/shifthours node e2e-shifthours.mjs
// It starts its own server on PORT.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addDays, dayOf, instantOf } from './shared/dayparts.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5153;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-shifthours';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const until = async (fn, ms = 12000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(150);
  }
};

// ── The server, fresh and in memory ──
const serverLog = [];
const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT) };
for (const k of ['RESEND_API_KEY', 'MAIL_FROM', 'DATABASE_URL', 'STARBASE_JOBS', 'TWILIO_ACCOUNT_SID']) delete env[k];
const server = spawn(process.execPath, ['server/index.js'], { cwd: HERE, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => serverLog.push(String(d)));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`server did not start: ${serverLog.join('')}`)), 30000);
  server.stdout.on('data', (d) => { if (/starbase on/.test(String(d))) { clearTimeout(t); resolve(); } });
  server.once('exit', (code) => { clearTimeout(t); reject(new Error(`server exited ${code}: ${serverLog.join('')}`)); });
});
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(1));

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
  };
};
// One main button, sideways scroll, and the smallest tap target among `sel`.
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).map((el) => el.innerText.trim());
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null; let minWho = '';
  for (const el of targets ? document.querySelectorAll(targets) : []) {
    if (!visible(el)) continue;
    const h = el.getBoundingClientRect().height;
    if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 80); }
  }
  return { yellow, overflow, minTap, minWho };
}, sel);
const iso = (v) => (v ? new Date(v).toISOString() : null);
const today = dayOf(new Date());
const D3 = addDays(today, 3);
const D4 = addDays(today, 4);
const at = (day, clock) => iso(instantOf(day, clock));

try {
  // ── 1. A manager, a 2–8 pm canvass, a drop-in phone bank, a morning canvass; Sam on the canvass ──
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', locale: 'en-CA' });
  const page = await desk.newPage();
  const D = wire(page, 'desk');
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Morgan Example');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
  await page.fill('#su-email', `morgan+${tag}@example.org`);
  await page.fill('#su-password', 'surrey-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 20000 });
  const one = async (input) => (await D.api('/actions/shift.createMany', input)).json.shifts[0];
  const cv = await one({ kind: 'canvass', location: 'Newton Rec Centre', days: [D3], start: '14:00', end: '20:00' });
  const di = await one({ kind: 'office', location: 'Campaign office', days: [D3], start: '16:00', end: '20:00', drop_in: true, public: true });
  const am = await one({ kind: 'canvass', location: 'Fleetwood Park', days: [D4], start: '10:00', end: '14:00' });
  check('set-up: three shifts; the office one is drop-in', !!cv?.id && !!am?.id && (await D.api(`/shifts/${di.id}`)).json.shift.drop_in === true);
  const sam = (await D.api('/actions/person.create', { name: 'Sam Example', phone: '604-555-0111' })).json.person;
  check('set-up: Sam is on the canvass', (await D.api('/actions/shift.assign', { shift_id: cv.id, person_id: sam.id })).status === 200);

  // ── 2. Priya, a volunteer on a phone ──
  const invite = (await D.api('/actions/member.invite', { email: `priya+${tag}@example.org`, role: 'volunteer' })).json;
  const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', locale: 'en-CA' });
  const vp = await vctx.newPage();
  const V = wire(vp, 'volunteer');
  await vp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Priya Example', password: 'knock-knock-2026' });
  check('set-up: Priya signs in as a volunteer', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
  await vp.goto(`${BASE}/shifts`, { waitUntil: 'domcontentloaded' });
  await vp.waitForSelector('.sch-vrow', { timeout: 10000 });
  const vrow = (id) => vp.locator(`.sch-vrow[data-shift="${id}"]`);
  const rowText = async (id) => (await vrow(id).innerText()).replace(/\s+/g, ' ').trim();
  check('a drop-in shift’s row: "Drop in · 4–8 pm"', /Drop in · 4–8 pm/.test(await rowText(di.id)), await rowText(di.id));
  check('a shift that isn’t drop-in: just its hours', /2–8 pm/.test(await rowText(cv.id)) && !/Drop in/.test(await rowText(cv.id)), await rowText(cv.id));

  // "Count me in" on the canvass's own page, then four taps to her hours.
  await vrow(cv.id).locator('.ops-row').tap();
  await vp.waitForSelector('.ops-notify[aria-label="Your spot"]', { timeout: 10000 });
  await vp.locator('.ops-notify button:has-text("Count me in")').tap();
  await vp.waitForSelector('.ops-onit', { timeout: 10000 });
  const line = () => V.text('.shh-hours');
  check('on the shift: "The whole time · Change my hours" under "You’re on this shift"', (await line()) === 'The whole time · Change my hours', await line());
  let taps = 0;
  const tap = async (loc) => { taps += 1; await loc.tap(); };
  await tap(vp.locator('.shh-line button:has-text("Change my hours")'));
  await vp.waitForSelector('.shh-pick', { timeout: 5000 });
  const groupChips = (label) => vp.$$eval(`.shh-pick [aria-labelledby^="shh-${label}"] .sch-chip`, (els) => els.map((e) => e.innerText.trim()));
  const froms = await groupChips('from');
  check('From: the start, then every half hour, to half an hour before the end', froms.join('|') === '2 pm|2:30 pm|3 pm|3:30 pm|4 pm|4:30 pm|5 pm|5:30 pm|6 pm|6:30 pm|7 pm|7:30 pm', froms.join('|'));
  check('"The whole time" is chosen to begin with', (await vp.locator('.shh-pick .sch-chip:text-is("The whole time")').getAttribute('aria-pressed')) === 'true');
  const chipIn = (label, words) => vp.locator(`.shh-pick [aria-labelledby^="shh-${label}"] .sch-chip:text-is("${words}")`);
  await tap(chipIn('from', '4:30 pm'));
  const untils = await groupChips('until');
  check('Until: half an hour after From, to the end', untils.join('|') === '5 pm|5:30 pm|6 pm|6:30 pm|7 pm|7:30 pm|8 pm', untils.join('|'));
  await tap(chipIn('until', '6 pm'));
  let mm = await measure(vp, '.shh-pick .sch-chip, .shh-pick__foot .btn');
  check('the picker (390): one main button, "Save my hours"; no sideways scroll; 48px targets', mm.yellow.join('|') === 'Save my hours' && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await V.shot('01-vol-hours-picker-390', true);
  await tap(vp.locator('.shh-pick__foot button:has-text("Save my hours")'));
  await until(async () => (await line()).startsWith('4:30–6 pm'));
  check(`Change my hours → From 4:30 → Until 6 → Save: ${taps} taps (4 at most); the line reads "4:30–6 pm"`, taps <= 4 && (await line()) === '4:30–6 pm · Change my hours', await line());
  const priyaOn = async (shiftId) => (await D.api(`/shifts/${shiftId}`)).json.assignees.find((a) => a.name === 'Priya Example' && ['assigned', 'confirmed', 'completed'].includes(a.status));
  let mine = await priyaOn(cv.id);
  check('server: her booking is 4:30–6 pm', iso(mine?.arrive_at) === at(D3, '16:30') && iso(mine?.leave_at) === at(D3, '18:00'), JSON.stringify(mine));
  mm = await measure(vp, '.shh-line .btn, .ops-notify .btn');
  check('her shift page (390): no main button left over, no sideways scroll, 48px targets', mm.yellow.length === 0 && mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await V.shot('02-vol-shift-hours-390');

  // ── 3. With no signal her change waits on the phone, then goes ──
  await vctx.setOffline(true);
  await vp.locator('.shh-line button:has-text("Change my hours")').tap();
  await chipIn('from', '5 pm').tap();
  await chipIn('until', '7 pm').tap();
  await vp.locator('.shh-pick__foot button:has-text("Save my hours")').tap();
  await until(async () => /Not sent yet/.test(await line()));
  check('offline: "5–7 pm" with "Not sent yet"', /^5–7 pm Not sent yet · Change my hours$/.test(await line()), await line());
  mine = await priyaOn(cv.id);
  check('…and the server still has 4:30–6', iso(mine?.arrive_at) === at(D3, '16:30'), JSON.stringify(mine));
  await V.shot('03-vol-hours-offline-390');
  await vctx.setOffline(false);
  await until(async () => iso((await priyaOn(cv.id))?.arrive_at) === at(D3, '17:00'), 20000);
  mine = await priyaOn(cv.id);
  check('signal back: sent — the server has 5–7 pm', iso(mine?.arrive_at) === at(D3, '17:00') && iso(mine?.leave_at) === at(D3, '19:00'), JSON.stringify(mine));
  await until(async () => !/Not sent yet/.test(await line()));
  check('…and the line drops "Not sent yet"', (await line()) === '5–7 pm · Change my hours', await line());

  // Her list row says her own hours.
  await vp.locator('.ops-back').first().tap();
  await vp.waitForSelector(`.sch-vrow[data-shift="${cv.id}"]`, { timeout: 10000 });
  await until(async () => /You’re on ✓ · 5–7 pm/.test(await rowText(cv.id)));
  check('her list row: "You’re on ✓ · 5–7 pm"', /You’re on ✓ · 5–7 pm/.test(await rowText(cv.id)), await rowText(cv.id));

  // ── 4. A drop-in shift: one tap on the row, then "Tell us when you’ll come" ──
  await vrow(di.id).locator('.sch-vrow__join').tap();
  // It overlaps her canvass — asked about first, with her own hours there.
  await vp.waitForSelector('.sch-vrow__ask', { timeout: 8000 });
  const ask = await V.text('.sch-vrow__ask');
  check('the overlap warning says her own hours on the canvass (5–7 pm)', /^You’re on Canvass — Newton Rec Centre then \(5–7 pm\)\. Count me in anyway\?/.test(ask), ask);
  await vp.locator('.sch-vrow__ask button:has-text("Yes")').tap();
  await until(async () => /You’re on ✓/.test(await rowText(di.id)));
  mm = await measure(vp, '.sch-vrow__join, .sch-vrow .ops-row');
  check('the list (390): no sideways scroll, 48px targets', mm.overflow <= 0 && mm.minTap >= 47.5, JSON.stringify(mm));
  await V.shot('04-vol-list-partial-and-drop-in-390', true);
  await vrow(di.id).locator('.ops-row').tap();
  await vp.waitForSelector('.shh-hours', { timeout: 10000 });
  check('the drop-in shift’s page: "Any time 4–8 pm · Tell us when you’ll come"', (await line()) === 'Any time 4–8 pm · Tell us when you’ll come', await line());
  await V.shot('05-vol-drop-in-390');
  await vp.locator('.ops-back').first().tap();
  await vp.waitForSelector(`.sch-vrow[data-shift="${am.id}"]`, { timeout: 10000 });

  // ── 5. Offline: Count me in, hours, Take back — nothing left once the signal is back ──
  await vrow(am.id).locator('.ops-row').tap();
  await vp.waitForSelector('.ops-notify[aria-label="Your spot"]', { timeout: 10000 });
  await vctx.setOffline(true);
  await vp.locator('.ops-notify button:has-text("Count me in")').tap();
  await until(async () => /Count me in Not sent yet/.test(await V.text('.ops-notify')));
  check('offline: "Count me in · Not sent yet", and her hours can be set already', /Count me in Not sent yet/.test(await V.text('.ops-notify')) && (await line()) === 'The whole time · Change my hours', await V.text('.ops-notify'));
  await vp.locator('.shh-line button:has-text("Change my hours")').tap();
  await chipIn('from', '11 am').tap();
  await vp.locator('.shh-pick__foot button:has-text("Save my hours")').tap();
  await until(async () => /^11 am–2 pm Not sent yet/.test(await line()));
  check('…her hours wait too: "11 am–2 pm · Not sent yet"', /^11 am–2 pm Not sent yet/.test(await line()), await line());
  await vp.locator('.ops-notify button:has-text("Take back")').tap();
  await sleep(300);
  await vctx.setOffline(false);
  await sleep(4000);
  const left = await vp.evaluate(() => Object.keys(localStorage).filter((k) => k.endsWith('outbox:v2')).flatMap((k) => JSON.parse(localStorage.getItem(k) || '[]')));
  check('signal back: nothing left on the phone, nothing "Not sent"', left.length === 0 && !/Not sent/.test(await V.text('main')), JSON.stringify(left));
  check('server: no booking on that shift', !(await priyaOn(am.id)), JSON.stringify(await priyaOn(am.id)));

  // ── 6. The desk: her hours on the roster; Sam's set from his sheet; the check-in board ──
  await page.goto(`${ADMIN}/shifts/${cv.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cb-card__name', { timeout: 10000 });
  const toggle = page.locator('.st-roster-toggle');
  if (await toggle.count()) await toggle.click();
  await page.waitForSelector('#shift-roster', { timeout: 5000 });
  const roster = (name) => page.locator(`#shift-roster .ops-item:has(.ops-row__name:text-is("${name}"))`);
  check('the roster: Priya’s row says "5–7 pm"', (await roster('Priya Example').locator('.shh-own').innerText()) === '5–7 pm');
  check('…Sam’s, on for the whole shift, says no hours', (await roster('Sam Example').locator('.shh-own').count()) === 0);
  await roster('Sam Example').locator('.ops-row').click();
  await page.waitForSelector('#shift-roster section[aria-label="Hours"]', { timeout: 5000 });
  const deskChip = (label, words) => roster('Sam Example').locator(`[aria-labelledby^="shh-${label}"] .sch-chip:text-is("${words}")`);
  await deskChip('from', '6 pm').click();
  check('the person sheet: Hours, From and Until, a quiet "Save hours"', (await roster('Sam Example').locator('button:has-text("Save hours")').getAttribute('class')).includes('btn-quiet')
    && await deskChip('until', '8 pm').getAttribute('aria-pressed') === 'true');
  mm = await measure(page);
  check('the desk’s shift page (1440): one main button, no sideways scroll', mm.yellow.length <= 1 && mm.overflow <= 0, JSON.stringify(mm));
  await D.shot('06-desk-roster-hours-1440', true);
  await roster('Sam Example').locator('button:has-text("Save hours")').click();
  await until(async () => (await roster('Sam Example').locator('.shh-own').innerText().catch(() => '')) === '6–8 pm');
  const samRow = (await D.api(`/shifts/${cv.id}`)).json.assignees.find((a) => a.name === 'Sam Example');
  check('"Save hours": Sam is 6–8 pm, on the server and his row', iso(samRow.arrive_at) === at(D3, '18:00') && iso(samRow.leave_at) === at(D3, '20:00')
    && (await roster('Sam Example').locator('.shh-own').innerText()) === '6–8 pm', JSON.stringify(samRow));
  await until(async () => /Sam Example · 6–8 pm/.test(await D.text('.cb')));
  const board = await page.$$eval('.cb-card__name', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('the check-in board: "Priya Example · 5–7 pm", "Sam Example · 6–8 pm"', board.includes('Priya Example · 5–7 pm') && board.includes('Sam Example · 6–8 pm'), board.join(' | '));
  await page.locator('.cb').scrollIntoViewIfNeeded();
  await D.shot('07-desk-crew-board-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  mm = await measure(page);
  check('the desk’s shift page at 390: no sideways scroll', mm.overflow <= 0, JSON.stringify(mm));
  await page.locator('#shift-roster section[aria-label="Hours"]').scrollIntoViewIfNeeded().catch(() => {});
  await D.shot('08-desk-roster-hours-390');
  await page.locator('.cb').scrollIntoViewIfNeeded();
  await D.shot('09-desk-crew-board-390');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 7. The website: the drop-in shift's card says so ──
  await D.api('/site');
  const site = await desk.newPage();
  await site.goto(`${BASE}/site/volunteer`, { waitUntil: 'domcontentloaded' });
  const card = await site.locator('text=Drop in').first().innerText().catch(() => '');
  check('the website’s openings: the drop-in shift says "Drop in"', /Drop in 4:00\D{1,3}8:00\sp\.m\./.test(card), card);
  await site.locator('text=Drop in').first().scrollIntoViewIfNeeded().catch(() => {});
  await site.screenshot({ path: `${SHOTS}/10-site-drop-in-1440.png` });
  await site.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the journey ran to its end', false, e.stack || e.message);
} finally {
  await browser.close();
  await new Promise((r) => { if (server.exitCode !== null) { r(); return; } server.removeAllListeners('exit'); server.once('exit', r); server.kill('SIGTERM'); });
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
