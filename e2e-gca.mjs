// Your shifts in Google Calendar, and People you know, end to end, against a
// stand-in Google (server/test/fake-google.js, with its Calendar) — never
// the real one: the suite fails if the browser asks anything of an address
// other than 127.0.0.1.
//
// It starts its own servers and stops them: base.win on PORT (default
// 5330) and the fake Google on PORT+1. Build the web app first
// (cd web && npm run build).
//
//   SHOTS=/tmp/gca [PORT=5330] node e2e-gca.mjs
//
// A manager, a staffer and a volunteer, at 1440x900 and 390x844.
// Calendar: no card while off, for anyone (Services says so); Services →
// Google → "Shifts in Google Calendar" On; the volunteer connects from the
// phone and comes back to "Connected — your shifts are on their way", the
// card above the calendar link card; "Stop your calendar link too" → Stop;
// a booking lands in the fake and the card reads "1 shift · Updated …";
// unassigned at the desk → gone; another shift called off → gone; the
// calendar deleted in Google → "Make it again"; GSI's Google card has no
// Calendar row; Google revokes → "Needs reconnecting" → Stop → OK (still
// one Reconnect) → the Google card’s one Reconnect; Stop → confirm in place
// → gone; the manager turns it off → confirm → gone.
// Contacts: My people → Find people I know → the fixture → "3 on our list",
// none of the others; tick two → "Add 2 to My people" → both in My people;
// Data → Import shows the hint; a volunteer never gets the screen. One
// primary per screen, no sideways scroll at 390, 48 px targets on the phone.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeGoogle } from './server/test/fake-google.js';

const SHOTS = process.env.SHOTS || '/tmp/starbase-gca';
mkdirSync(SHOTS, { recursive: true });
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 5330;
const G_PORT = PORT + 1;
const BASE = `http://${HOST}:${PORT}`;
const G = `http://${HOST}:${G_PORT}`;
const CLIENT_ID = 'e2e-client.apps.example';
const SECRET = 'e2e-client-secret';
const PASSWORD = 'surrey-forward-2026';
const FIXTURE = fileURLToPath(new URL('./samples/contacts-google.csv', import.meta.url));
const tag = Date.now().toString(36);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${String(extra).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(250);
  }
};

const VAL = { sub: '200000000000000000021', email: 'val.example@gmail.com', name: 'Val Example' };
const fake = await startFakeGoogle({
  port: G_PORT, clientId: CLIENT_ID, secret: SECRET, accounts: [VAL],
  redirectUris: [`${BASE}/api/auth/google/back`],
});
const cals = () => fake.cal.calendars(VAL.sub);
const events = () => cals().flatMap((c) => c.events);

let server;
let log = '';
const startServer = async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_PUBLIC_URL: BASE,
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: SECRET, GOOGLE_ACCOUNTS_BASE: G, GOOGLE_OAUTH_BASE: G,
      GOOGLE_CALENDAR_API_BASE: `${G}/calendar/v3`, GOOGLE_TOKEN_KEY: `e2e-gca-token-key-${tag}-0123456789abcdef`,
      STARBASE_JOBS_EVERY_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i += 1) {
    if (server.exitCode !== null) break;
    try { if ((await fetch(`${BASE}/api/health`)).status < 500) return; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error(`base.win didn't start: ${log.slice(-800)}`);
};

let browser;
const errors = [];
const offHost = [];
const contexts = [];
try {
  await startServer();
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const newPage = async (viewport, label) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}) });
    contexts.push(ctx);
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== HOST && u.protocol !== 'data:' && u.protocol !== 'blob:') { offHost.push(u.href); return route.abort(); }
      return route.continue();
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    return { ctx, page };
  };
  const shot = (p, name, full = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
  const text = async (p, sel = 'body') => ((await p.locator(sel).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const noSideways = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const primaries = (p) => p.locator('.btn-primary:visible').count();
  const api = (p, path, body) => p.evaluate(async ([u, b]) => {
    const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, body]);
  const pickGoogle = async (p, who) => {
    await p.waitForURL((u) => u.port === String(G_PORT), { timeout: 10000 });
    await p.click(`a.acct[data-sub="${who.sub}"]`);
    await p.waitForURL((u) => u.port !== String(G_PORT), { timeout: 10000 });
    await p.waitForLoadState('domcontentloaded');
  };
  const passwordIn = async (p, path, email) => {
    await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await p.fill('#login-email', email);
    await p.fill('#login-password', PASSWORD);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  const smallTargets = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent)
    .map((e) => ({ t: e.textContent.trim().slice(0, 30) || e.getAttribute('aria-label'), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 48), sel);
  const cardSays = (p, re, ms = 20000) => until(async () => re.test(await text(p, '#gcal')), ms);

  // ── A manager signs up; a staffer and a volunteer join ──
  const { page: m } = await newPage(DESKTOP, 'manager');
  await m.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await m.fill('#su-name', 'Rae Example');
  if (await m.locator('#su-org').count()) await m.fill('#su-org', 'Example Campaign');
  await m.fill('#su-email', `rae.${tag}@example.org`);
  await m.fill('#su-password', PASSWORD);
  await m.click('button[type="submit"]');
  await m.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  const joinByApi = async (email, role, name) => {
    const inv = (await api(m, '/api/actions/member.invite', { email, role })).json;
    const r = await fetch(`${BASE}/api/auth/join`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ token: inv.joinUrl.split('/join/')[1], name, password: PASSWORD }) });
    return r.status;
  };
  const staff = `sam.${tag}@example.org`;
  const vol = `val.${tag}@example.org`;
  check('a staffer and a volunteer join', (await joinByApi(staff, 'staff', 'Sam Example')) === 200 && (await joinByApi(vol, 'volunteer', 'Val Example')) === 200);

  // ── Off: no card for anyone (Services → Google is where the manager turns it on) ──
  await m.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await m.locator('#calendar').waitFor({ timeout: 10000 });
  await sleep(800);
  check('off: the manager sees no Google Calendar card', await m.locator('#gcal').count() === 0, await text(m, '.me-page'));
  await shot(m, '01-profile-off-manager-desktop');

  const { page: v } = await newPage(PHONE, 'volunteer phone');
  await passwordIn(v, '/login', vol);
  await v.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 15000 });
  await v.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  await v.locator('#calendar').waitFor({ timeout: 10000 });
  await sleep(800);
  check('off: the volunteer sees no Google Calendar card', await v.locator('#gcal').count() === 0);

  // ── Services → Google → Shifts in Google Calendar: On ──
  await m.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
  const row = m.locator('.sv2-row', { has: m.locator('.sv2-name', { hasText: 'Google (sign-in and connections)' }) });
  await row.locator('.gg-panel').waitFor({ timeout: 8000 });
  const sw = row.getByRole('switch', { name: /Shifts in Google Calendar/ });
  await sw.waitFor({ timeout: 8000 });
  check('Services → Google: the switch starts Off, with its helper line', await sw.getAttribute('aria-checked') === 'false'
    && /Add the Calendar permission in Google Cloud first/.test(await text(m, '.gc-switch')));
  await sw.click();
  await until(async () => (await sw.getAttribute('aria-checked')) === 'true', 8000);
  check('…turned On; "0 people connected"', await sw.getAttribute('aria-checked') === 'true' && /0 people connected/.test(await text(m, '.gc-switch')), await text(m, '.gc-switch'));
  await m.locator('.gc-switch').scrollIntoViewIfNeeded();
  await shot(m, '02-services-gcal-on-desktop', false);

  // ── The volunteer, on the phone: a calendar link first, then Connect ──
  check('the volunteer makes a calendar link', (await api(v, '/api/actions/calendar.feed.make', {})).status === 200);
  await v.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  await v.locator('#gcal').waitFor({ timeout: 10000 });
  check('on: the card is drawn, above the calendar link card', await v.evaluate(() => {
    const a = document.getElementById('gcal'); const b = document.getElementById('calendar');
    return Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
  }));
  await v.getByText('Connect Google Calendar').waitFor({ timeout: 8000 });
  check('not connected: what it does, and Connect Google Calendar (not a primary)', /Updated within a minute of any change\. Only base\.win’s own calendar\./.test(await text(v, '#gcal'))
    && await v.locator('#gcal .btn-primary').count() === 0);
  check('phone: the card adds no primary (Profile keeps at most one), no sideways scroll', await primaries(v) <= 1 && await noSideways(v) <= 0);
  check('phone: the card’s targets are 48 px', (await smallTargets(v, '#gcal .btn, #gcal a.btn')).length === 0, JSON.stringify(await smallTargets(v, '#gcal .btn')));
  await shot(v, '03-profile-connect-phone');
  await v.getByText('Connect Google Calendar').click();
  await pickGoogle(v, VAL);
  await v.locator('#gcal').waitFor({ timeout: 10000 });
  check('back on Profile: "Connected — your shifts are on their way"', Boolean(await until(async () => /Connected — your shifts are on their way/.test(await text(v, 'body')), 10000)));
  check('…and in place: "Stop your calendar link too, so shifts don’t show twice?"', Boolean(await until(async () => /Stop your calendar link too, so shifts don’t show twice\?/.test(await text(v, '#gcal')), 8000)));
  check('the calendar is made in the fake, named for the campaign', Boolean(await until(() => cals().length === 1)) && /— my shifts \(base\.win\)$/.test(cals()[0]?.body.summary || ''), JSON.stringify(cals()[0]?.body));
  check('…with no toast over the offer', (await v.locator('.gc-toast').count()) === 0);
  await shot(v, '04-profile-connected-offer-phone', false);
  check('…its button says what it stops: "Stop the link", not a second "Stop"', await v.locator('.gc-offer').getByRole('button', { name: 'Stop the link' }).count() === 1);
  await v.locator('.gc-offer').getByRole('button', { name: 'Stop the link' }).click();
  check('Stop → the calendar link card shows no link', Boolean(await until(async () => /Get my calendar link/.test(await text(v, '#calendar')), 8000)));

  // ── A booking lands; unassigned at the desk, it goes ──
  const at = (days, h) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
  const mkShift = async (title, days) => (await api(m, '/api/actions/shift.create', {
    title, kind: 'canvass', location: 'Newton Library', starts_at: at(days, 17), ends_at: at(days, 19), capacity: 6,
  })).json?.shift;
  const s1 = await mkShift('Doors in Newton', 2);
  const j1 = (await api(v, '/api/actions/shift.join', { shift_id: s1.id })).json?.assignment;
  check('a booking lands in the fake within a job pass', Boolean(await until(() => events().some((e) => e.summary?.includes('Doors in Newton')))), JSON.stringify(events().map((e) => e.summary)));
  await v.reload({ waitUntil: 'domcontentloaded' });
  check('the card reads "1 shift · Updated …"', Boolean(await cardSays(v, /1 shift · Updated/)), await text(v, '#gcal'));
  check('…"In Google Calendar as" the Google account', /In Google Calendar as val\.example@gmail\.com/.test(await text(v, '#gcal')));
  await shot(v, '05-profile-ok-phone');
  const { page: vd } = await newPage(DESKTOP, 'volunteer desktop');
  await passwordIn(vd, '/login', vol);
  await vd.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 15000 });
  await vd.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  await cardSays(vd, /1 shift/);
  await shot(vd, '05-profile-ok-desktop');

  check('unassigned at the desk', (await api(m, '/api/actions/shift.unassign', { id: j1.id })).status === 200);
  check('…gone from the fake', Boolean(await until(() => !events().some((e) => e.summary?.includes('Doors in Newton')))));
  const s2 = await mkShift('Phones at the office', 3);
  await api(v, '/api/actions/shift.join', { shift_id: s2.id });
  await until(() => events().some((e) => e.summary?.includes('Phones at the office')));
  check('another shift called off', (await api(m, '/api/actions/shift.delete', { id: s2.id })).status === 200);
  check('…gone from the fake', Boolean(await until(() => !events().some((e) => e.summary?.includes('Phones at the office')))));

  // ── The calendar deleted in Google → Make it again ──
  const s3 = await mkShift('Lit drop in Fleetwood', 4);
  const oldCal = cals()[0].id;
  fake.cal.dropCalendar(oldCal);
  await api(v, '/api/actions/shift.join', { shift_id: s3.id });
  await v.reload({ waitUntil: 'domcontentloaded' });
  check('deleted in Google: "You deleted the base.win calendar in Google."', Boolean(await cardSays(v, /You deleted the base\.win calendar in Google\./)), await text(v, '#gcal'));
  await shot(v, '06-profile-gone-phone');
  await v.locator('#gcal').getByRole('button', { name: 'Make it again' }).click();
  check('Make it again → a new calendar with the shift', Boolean(await until(() => cals().length === 1 && cals()[0].id !== oldCal && events().some((e) => e.summary?.includes('Lit drop')))));

  // ── GSI's Google card draws no Calendar row ──
  await v.reload({ waitUntil: 'domcontentloaded' });
  await v.locator('.gg-card').waitFor({ timeout: 10000 });
  await until(async () => /Connected as/.test(await text(v, '.gg-card')), 8000);
  check('GSI’s Google card has no Calendar row (Profile has one Calendar stop)', !/Your shifts in Google Calendar/.test(await text(v, '.gg-card'))
    && /Connected as val\.example@gmail\.com/.test(await text(v, '.gg-card')), await text(v, '.gg-card'));

  // ── Google revokes → Needs reconnecting → Reconnect ──
  fake.revokeAll(VAL.sub);
  const s4 = await mkShift('Sign build', 5);
  await api(v, '/api/actions/shift.join', { shift_id: s4.id });
  await v.reload({ waitUntil: 'domcontentloaded' });
  check('revoked in Google: "Needs reconnecting"', Boolean(await cardSays(v, /Needs reconnecting/)), await text(v, '#gcal'));
  await shot(v, '07-profile-reconnect-phone');
  check('…one Reconnect on the page: the Google card’s, which the calendar card points to',
    (await v.getByText('Reconnect', { exact: true }).count()) === 1 && /Reconnect under Google, below\./.test(await text(v, '#gcal')));
  // ── Stop while reconnecting → base.win can't delete it → OK: no link, still one Reconnect ──
  await v.locator('#gcal').getByRole('button', { name: /^Stop/ }).click();
  await v.locator('#gcal .gg-confirm').getByRole('button', { name: 'Stop' }).click();
  check('Stop while reconnecting: the card says base.win stopped and to delete it there', Boolean(await cardSays(v, /stopped updating your Google calendar/)), await text(v, '#gcal'));
  await v.locator('#gcal').getByRole('button', { name: 'OK', exact: true }).click();
  check('…OK: no link here, and still one Reconnect on the page, the Google card’s', Boolean(await cardSays(v, /Reconnect under Google, below\./))
    && (await v.getByText('Reconnect', { exact: true }).count()) === 1, await text(v, '#gcal'));
  await shot(v, '07b-profile-reconnect-nolink-phone');
  for (const c of cals()) fake.cal.dropCalendar(c.id); // they deleted it in Google, as the card said
  await v.locator('.gg-card').getByText('Reconnect', { exact: true }).click();
  await pickGoogle(v, VAL);
  check('…Reconnect → the new shift lands', Boolean(await until(() => events().some((e) => e.summary?.includes('Sign build')))));
  await v.reload({ waitUntil: 'domcontentloaded' });
  check('…and the card is back to its count', Boolean(await cardSays(v, /2 shifts · Updated/)), await text(v, '#gcal'));

  // ── Stop → confirm in place → gone ──
  await v.locator('#gcal').getByRole('button', { name: /^Stop/ }).click();
  check('Stop confirms in place', /Stop\? base\.win’s calendar is removed from your Google Calendar\./.test(await text(v, '#gcal')));
  await shot(v, '08-profile-stop-confirm-phone', false);
  await v.locator('#gcal .gg-confirm').getByRole('button', { name: 'Stop' }).click();
  const revokes = fake.counts.revoke;
  check('…gone from the fake', Boolean(await until(() => cals().length === 0)));
  // Nothing else used the account: Google is told to forget base.win (after the delete).
  check('…then the account is revoked at Google', Boolean(await until(() => fake.counts.revoke > revokes, 10000)));
  check('…and the card offers Connect again', Boolean(await cardSays(v, /Connect Google Calendar/)), await text(v, '#gcal'));

  // ── The manager turns it off → everyone's calendar goes ──
  await v.locator('#gcal').getByText('Connect Google Calendar').click();
  await pickGoogle(v, VAL);
  check('connected again: a calendar in the fake', Boolean(await until(() => cals().length === 1 && events().length > 0)));
  await m.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
  await row.locator('.gc-switch').waitFor({ timeout: 8000 });
  check('Services: "1 person connected"', Boolean(await until(async () => /1 person connected/.test(await text(m, '.gc-switch')), 5000)), await text(m, '.gc-switch'));
  check('…and the row’s lines say it is on', /Shifts in Google Calendar: on · 1 person/.test(await text(m, '.gg-lines')), await text(m, '.gg-lines'));
  await row.getByRole('switch', { name: /Shifts in Google Calendar/ }).click();
  check('turning off confirms in place', /Turn off\? Everyone’s base\.win calendar is removed from their Google Calendar\./.test(await text(m, '.gc-switch')));
  await m.locator('.gc-switch').scrollIntoViewIfNeeded();
  await shot(m, '09-services-gcal-off-confirm-desktop', false);
  await m.locator('.gc-switch .gg-confirm').getByRole('button', { name: 'Turn off' }).click();
  check('…the volunteer’s calendar is gone from the fake', Boolean(await until(() => cals().length === 0)));
  await v.reload({ waitUntil: 'domcontentloaded' });
  await sleep(800);
  check('…and the volunteer’s card is gone', await v.locator('#gcal').count() === 0, await text(v, '#gcal'));
  {
    const { page: mp } = await newPage(PHONE, 'manager phone');
    await passwordIn(mp, '/admin/login', `rae.${tag}@example.org`);
    await mp.waitForURL(/\/admin\/?$/, { timeout: 15000 });
    await mp.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
    await mp.locator('.gc-switch').waitFor({ timeout: 8000 });
    await mp.locator('.gc-switch').scrollIntoViewIfNeeded();
    check('Services on a phone: no sideways scroll; the switch’s targets are 48 px', await noSideways(mp) <= 0
      && (await smallTargets(mp, '.gc-switch .gg-switch')).length === 0, JSON.stringify(await smallTargets(mp, '.gc-switch .gg-switch')));
    await shot(mp, '10-services-gcal-phone', false);
    await mp.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
    await mp.locator('#gcal').waitFor({ timeout: 10000 });
    await shot(mp, '01-profile-off-manager-phone');
  }

  // ── Contacts: three on the list, the rest never shown ──
  const person = (body) => api(m, '/api/actions/person.create', body);
  await person({ name: 'Ann Example', email: 'ann.example@example.org', address: '12 Example St' });
  await person({ name: 'Cy Example', phone: '604-555-0103', address: '40 Sample Ave' });
  await person({ name: 'Dee Example', email: 'dee.example@example.org' });
  await person({ name: 'Zed Example', email: 'zed.example@example.org' });
  for (const [vp, size] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { page: s } = await newPage(vp, `staff ${size}`);
    await passwordIn(s, '/admin/login', staff);
    await s.waitForURL(/\/admin\/?$/, { timeout: 15000 });
    await s.goto(`${BASE}/admin/my-people`, { waitUntil: 'domcontentloaded' });
    const find = s.getByRole('link', { name: 'Find people I know' });
    await find.waitFor({ timeout: 10000 });
    check(`${size}: My people has a quiet "Find people I know" beside the one primary`, await primaries(s) === 1
      && !(await find.getAttribute('class')).includes('btn-primary'));
    await shot(s, `11-my-people-desk-${size}`, false);
    await find.click();
    await s.waitForURL(/\/admin\/my-people\/contacts$/, { timeout: 8000 });
    await s.getByRole('heading', { name: 'People you know' }).waitFor({ timeout: 8000 });
    check(`${size}: before a file — the three steps, the promise, one primary "Choose file"`, /On a computer, open contacts\.google\.com/.test(await text(s))
      && /We only show people already on our list\. The rest never leave this screen\./.test(await text(s))
      && await primaries(s) === 1 && /Choose file/.test(await text(s, '.btn-primary')));
    if (size === 'phone') check('phone: no sideways scroll; 48 px targets', await noSideways(s) <= 0 && (await smallTargets(s, '.ab-page .btn')).length === 0, JSON.stringify(await smallTargets(s, '.ab-page .btn')));
    await shot(s, `12-contacts-start-${size}`);
    // Slow the check a little, to see "Checking …".
    await s.route('**/api/addressbook/check', async (r) => { await sleep(1200); await r.continue(); });
    await s.setInputFiles('input.ab-file', FIXTURE);
    if (await until(async () => /Checking \d+ of \d+ contacts…/.test(await text(s)), 4000)) await shot(s, `13-contacts-checking-${size}`, false);
    await s.locator('.ab-count').waitFor({ timeout: 15000 });
    const body = await text(s);
    check(`${size}: "3 on our list", "of 8 contacts · the rest aren’t kept"`, /3 on our list/.test(body) && /of 8 contacts · the rest aren’t kept/.test(body), body.slice(0, 300));
    check(`${size}: no row for anyone not on the list`, ['Bo Sample', 'Ed Example', 'Fay Example', 'Gil Example', 'Example Hardware', 'Zed Example'].every((n) => !body.includes(n))
      && ['Ann Example', 'Cy Example', 'Dee Example'].every((n) => body.includes(n)));
    check(`${size}: one primary, "Add 0 to My people", disabled`, await primaries(s) === 1 && await s.locator('.btn-primary').isDisabled() && /Add 0 to My people/.test(await text(s, '.btn-primary')));
    if (size === 'phone') check('phone: results — no sideways scroll; tick boxes and buttons 48 px', await noSideways(s) <= 0 && (await smallTargets(s, '.ab-box, .ab-page .btn')).length === 0, JSON.stringify(await smallTargets(s, '.ab-box, .ab-page .btn')));
    await shot(s, `14-contacts-results-${size}`);
    if (size === 'desktop') {
      await s.getByRole('checkbox', { name: 'Add Ann Example to My people' }).check();
      await s.getByRole('checkbox', { name: 'Add Cy Example to My people' }).check();
      await s.getByRole('button', { name: 'Add 2 to My people' }).click();
      check('Add 2 → the toast "Added 2"', Boolean(await until(async () => /Added 2/.test(await text(s, '.ab-toast')), 8000)), await text(s, '.ab-toast'));
      check('…the added rows leave the list', !/Ann Example|Cy Example/.test(await text(s, '.ab-rows')));
      await shot(s, '15-contacts-done-desktop', false);
      await s.goto(`${BASE}/admin/my-people`, { waitUntil: 'domcontentloaded' });
      check('…both are in My people', Boolean(await until(async () => /Ann Example/.test(await text(s)) && /Cy Example/.test(await text(s)), 8000)));
      // Data → Import: the hint.
      await s.goto(`${BASE}/admin/people/import`, { waitUntil: 'domcontentloaded' });
      await s.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: 10000 });
      await s.setInputFiles('input[type="file"]', FIXTURE);
      check('Data → Import: the contacts hint, with its link', Boolean(await until(async () => /This looks like a contacts file\. To find people you know, use My people → Find people I know\./.test(await text(s)), 8000))
        && await s.getByRole('link', { name: 'My people → Find people I know' }).count() === 1);
      await s.locator('.imp-contacts').scrollIntoViewIfNeeded();
      await shot(s, '16-import-hint-desktop', false);
    }
  }

  // ── The volunteer never gets the contacts screen ──
  await v.goto(`${BASE}/my-people`, { waitUntil: 'domcontentloaded' });
  await v.getByRole('heading', { name: 'My people' }).waitFor({ timeout: 10000 });
  check('volunteer: no "Find people I know"', await v.getByText('Find people I know').count() === 0);
  await v.goto(`${BASE}/my-people/contacts`, { waitUntil: 'domcontentloaded' });
  check('volunteer: /my-people/contacts sends them to My people', Boolean(await until(() => new URL(v.url()).pathname === '/my-people', 8000)), v.url());
  const chk = await api(v, '/api/addressbook/check', { rows: [{ ref: 0, name: 'Ann Example', email: 'ann.example@example.org' }] });
  check('volunteer: the check answers 403', chk.status === 403);

  const google = offHost.filter((u) => /google|gstatic|googleapis/i.test(new URL(u).hostname));
  check(`nothing reached Google; ${offHost.length} other off-machine requests stopped before they left`, google.length === 0, google.slice(0, 5).join(' '));
  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('the suite ran to the end', false, e.stack || e.message);
  console.log(log.slice(-1500));
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  server?.kill('SIGTERM');
  await sleep(300);
  if (server && server.exitCode === null) server.kill('SIGKILL');
  await fake.close();
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
