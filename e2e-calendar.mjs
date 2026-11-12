// Calendars — browser check (CAL). A fresh in-memory server with a stand-in
// email sender (server/test/fake-mail.js), started here:
//   · a shift's page, a manager at 1440x900 and a volunteer on a 390x844
//     phone: "Add to calendar" opens Google · Outlook · Apple & others; the
//     Google link's dates are the shift's (UTC); "Apple & others" has no
//     download attribute and its link, fetched with no cookie, is a calendar
//     file with the shift (and its instructions, for the person themselves);
//   · "Count me in" on the shift page → the button under "You’re on this
//     shift"; with no signal the choices say "Needs signal";
//   · Your profile with an iPhone, an Android phone, a Mac and a Windows
//     computer: the buttons each gets; "Email me the link" says where it
//     went and the stand-in sender gets the https link; Copy puts a
//     /cal/….ics link on the clipboard and it lists the volunteer's shift
//     (no instructions); Make a new link → the old link answers an empty
//     calendar;
//   · GOTV's voting days (two advance days and election day) and a
//     treasurer's filing countdown;
//   · the website: after a sign-up, Google · Outlook · Apple & others; the
//     Events list's "Get our events in your calendar" serves events.ics;
//   · words (no feed, iCal, ICS, token, webcal, subscribe), at most one
//     yellow button, no sideways scroll at 390, 48px targets on phones.
//
//   (cd web && npm run build)  then  PORT=5160 SHOTS=/tmp/cal node e2e-calendar.mjs
//   (the stand-in sender takes any free port)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeMail } from './server/test/fake-mail.js';

const PORT = Number(process.env.PORT || 5160);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-calendar';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

// ── the server, with email connected to the stand-in ──
const fake = await startFakeMail({ provider: 'resend' });
const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT) };
for (const k of ['MAIL_PROVIDER', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE', 'STARBASE_PUBLIC_URL', 'SITE_HOSTS', 'BASE_PATH']) delete env[k];
Object.assign(env, { RESEND_API_KEY: 're_e2e_calendar', RESEND_API_BASE: fake.url, MAIL_FROM: 'Sample Campaign <team@example.org>' });
const server = spawn(process.execPath, ['server/index.js'], { cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) break;
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' };
const watch = (p, who) => { p.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`)); return p; };
const apiOf = (p) => (path, body) => p.evaluate(async ([pa, b]) => {
  const r = await fetch('/api' + pa, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false });
const words = async (loc) => ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
// At most one yellow button, no sideways scroll, the smallest target among `sel`.
const measure = (p, sel) => p.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  for (const el of document.querySelectorAll(targets)) {
    if (!visible(el)) continue;
    const h = el.getBoundingClientRect().height;
    minTap = minTap == null ? h : Math.min(minTap, h);
  }
  return { yellow, overflow, minTap };
}, sel);
const BANNED = /\b(feed|ical|ics|token|webcal|subscribe)\b/i;
// A calendar file fetched with no cookie at all.
const fetchIcs = async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  return { status: r.status, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', body: await r.text() };
};
const vevents = (body) => (body.match(/BEGIN:VEVENT/g) || []).length;
const parses = (body) => body.startsWith('BEGIN:VCALENDAR\r\n') && body.trimEnd().endsWith('END:VCALENDAR') && !/[^\r]\n/.test(body);
const ymd = (d) => d.toISOString().slice(0, 10);
const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

try {
  // ── 1. A manager, a shift (6:30–8:30 a.m. in Surrey, four days out), a public event ──
  const desk = await browser.newContext(DESK);
  const page = watch(await desk.newPage(), 'manager');
  const api = apiOf(page);
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Marco Example');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
  await page.fill('#su-email', `marco.${tag}@example.org`);
  await page.fill('#su-password', 'surrey-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

  const day = new Date(Date.now() + 4 * 864e5);
  const start = new Date(`${ymd(day)}T13:30:00Z`); // 6:30 a.m. in Surrey
  const end = new Date(`${ymd(day)}T15:30:00Z`);
  const shift = (await api('/actions/shift.create', {
    title: 'Morning wave at King George', kind: 'burma_shave', location: 'King George Blvd & 88 Ave',
    starts_at: start.toISOString(), ends_at: end.toISOString(), instructions: 'Door code 4321 at the office', capacity: 6,
  })).json?.shift;
  check('a shift made', !!shift?.id);
  const evStart = new Date(Date.now() + 6 * 864e5); evStart.setUTCHours(2, 0, 0, 0);
  const event = (await api('/actions/shift.create', {
    title: 'Town hall in Newton', kind: 'event', location: 'Newton Seniors Centre', starts_at: evStart.toISOString(), capacity: 40,
    instructions: 'Back door code 9876',
  })).json?.shift;
  check('an event made and shown on the website', event?.id && (await api('/actions/shift.public', { id: event.id, public: true })).status === 200);

  // ── 2. The desk's shift page: Add to calendar ──
  await page.goto(`${ADMIN}/shifts/${shift.id}`, { waitUntil: 'domcontentloaded' });
  const deskBtn = page.getByRole('button', { name: 'Add to calendar' });
  await deskBtn.waitFor({ timeout: 10000 });
  check('desk: "Add to calendar" is a quiet button, closed', await deskBtn.getAttribute('aria-expanded') === 'false'
    && !(await deskBtn.getAttribute('class')).includes('btn-primary'));
  await deskBtn.click();
  const apple = page.locator('.cal-choices a', { hasText: 'Apple & others' });
  await apple.waitFor({ timeout: 10000 });
  const google = await page.locator('.cal-choices a', { hasText: 'Google' }).getAttribute('href');
  const outlook = await page.locator('.cal-choices a', { hasText: 'Outlook' }).getAttribute('href');
  check('desk: the Google link’s dates are the shift’s, in UTC', google.includes(`dates=${stamp(start)}/${stamp(end)}`), google);
  check('desk: the Outlook link’s start is the shift’s', outlook.includes(`startdt=${encodeURIComponent(start.toISOString().replace('.000Z', 'Z'))}`), outlook);
  check('desk: Apple & others has no download attribute', await apple.getAttribute('download') === null);
  const appleUrl = await apple.getAttribute('href');
  check('desk: the file link is a one-time /cal/once/ link', /\/cal\/once\/[A-Za-z0-9_-]{22}\.ics$/.test(appleUrl), appleUrl);
  const deskFile = await fetchIcs(appleUrl);
  check('desk: the file opens with no cookie (inline, a calendar that parses)', deskFile.status === 200 && /text\/calendar/.test(deskFile.type)
    && /^inline/.test(deskFile.disp) && parses(deskFile.body) && vevents(deskFile.body) === 1, `${deskFile.status} ${deskFile.type}`);
  check('desk: the file has the shift, its time and its instructions', deskFile.body.includes(`DTSTART:${stamp(start)}`)
    && deskFile.body.includes('Morning wave at King George') && deskFile.body.includes('Door code 4321'));
  check('desk: words in place', (await words(page.locator('.cal-add'))).includes('Apple & others opens a file your calendar adds.'));
  let m = await measure(page, '.cal-choice');
  check('desk 1440: one yellow button at most, no sideways scroll, 48px choices', m.yellow <= 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
  await page.locator('.cal-add').scrollIntoViewIfNeeded();
  await shot(page, '01-desk-shift-choices-1440');
  await page.keyboard.press('Escape');
  check('desk: Esc closes the choices', await deskBtn.getAttribute('aria-expanded') === 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await deskBtn.click();
  await apple.waitFor({ timeout: 10000 });
  m = await measure(page, '.cal-choice');
  check('desk 390: no sideways scroll, choices stacked and 48px', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
  await page.locator('.cal-add').scrollIntoViewIfNeeded();
  await shot(page, '02-desk-shift-choices-390');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 3. A volunteer on a phone: the shift page, Count me in, no signal ──
  const invite = (await api('/actions/member.invite', { email: `ana.${tag}@example.org`, role: 'volunteer' })).json;
  const vctx = await browser.newContext({ ...PHONE, userAgent: UA.iphone, permissions: ['clipboard-read', 'clipboard-write'] });
  const vp = watch(await vctx.newPage(), 'volunteer');
  const vapi = apiOf(vp);
  await vp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const joined = await vapi('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Ana Example', password: 'knock-knock-2026' });
  check('volunteer joined', joined.status === 200, joined.status);
  await vp.goto(`${BASE}/shifts/${shift.id}`, { waitUntil: 'domcontentloaded' });
  const vBtn = vp.getByRole('button', { name: 'Add to calendar' });
  await vBtn.waitFor({ timeout: 10000 });
  check('volunteer, not on it: Add to calendar under the time and place', await vp.locator('.ops-lines + .cal-add').count() === 1);
  await vp.getByRole('button', { name: 'Count me in' }).tap();
  await vp.locator('.ops-onit').waitFor({ timeout: 10000 });
  await vp.locator('.ops-notify .cal-add').waitFor({ timeout: 10000 });
  check('after Count me in: the button sits under “You’re on this shift”', await vp.locator('.ops-lines + .cal-add').count() === 0
    && await vp.locator('.ops-notify .ops-onit + .cal-add').count() === 1);
  await vp.locator('.ops-notify').getByRole('button', { name: 'Add to calendar' }).tap();
  const vApple = vp.locator('.cal-choices a', { hasText: 'Apple & others' });
  await vApple.waitFor({ timeout: 10000 });
  const vFile = await fetchIcs(await vApple.getAttribute('href'));
  check('volunteer: the file is theirs and parses', vFile.status === 200 && parses(vFile.body) && vFile.body.includes('Door code 4321'));
  m = await measure(vp, '.cal-tap, .cal-choice');
  check('volunteer 390: one yellow button at most, no sideways scroll, 48px targets', m.yellow <= 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
  await vp.locator('.ops-notify').scrollIntoViewIfNeeded();
  await shot(vp, '03-volunteer-shift-choices-390');
  const vGoogle = await vp.locator('.cal-choices a', { hasText: 'Google' }).getAttribute('href');
  check('volunteer: Google link dates match', vGoogle.includes(`dates=${stamp(start)}/${stamp(end)}`));
  // No signal: closed and opened again, the choices are off.
  await vp.locator('.ops-notify').getByRole('button', { name: 'Add to calendar' }).tap();
  await vctx.setOffline(true);
  await sleep(300);
  await vp.locator('.ops-notify').getByRole('button', { name: 'Add to calendar' }).tap();
  await sleep(300);
  const offWords = await words(vp.locator('.ops-notify .cal-choices'));
  const offDisabled = await vp.locator('.ops-notify .cal-choices button:disabled').count();
  check('no signal: the choices say “Needs signal” and are off', offWords.includes('Needs signal') && offDisabled === 3
    && await vp.locator('.ops-notify .cal-choices a').count() === 0, `${offWords} · ${offDisabled}`);
  await shot(vp, '04-volunteer-no-signal-390');
  await vctx.setOffline(false);
  await sleep(500);

  // ── 4. Your profile, by device ──
  const state = await vctx.storageState();
  const profile = async (ua, phone) => {
    const ctx = await browser.newContext({ ...(phone ? PHONE : DESK), userAgent: ua, storageState: state, permissions: ['clipboard-read', 'clipboard-write'] });
    const p = watch(await ctx.newPage(), 'profile');
    await p.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
    await p.locator('#calendar').waitFor({ timeout: 10000 });
    for (let i = 0; i < 30 && /Loading…/.test(await words(p.locator('#calendar'))); i += 1) await sleep(200);
    return { ctx, p };
  };
  const buttonsOf = async (p) => (await p.locator('#calendar .ts-row').first().locator('a, button').allInnerTexts()).map((t) => t.trim());

  // iPhone: no link yet → Get my calendar link
  let { ctx: ic, p: ip } = await profile(UA.iphone, true);
  const first = await words(ip.locator('#calendar'));
  check('profile, no link: one line and “Get my calendar link”', first.includes('Your shifts appear in your calendar and stay up to date.')
    && await ip.getByRole('button', { name: 'Get my calendar link' }).count() === 1, first);
  m = await measure(ip, '#calendar .btn');
  check('profile, no link 390: one yellow button at most, 48px, no sideways scroll', m.yellow <= 1 && m.minTap >= 48 && m.overflow <= 0, JSON.stringify(m));
  await ip.locator('#calendar').scrollIntoViewIfNeeded();
  await shot(ip, '05-profile-nolink-iphone-390');
  await ip.getByRole('button', { name: 'Get my calendar link' }).tap();
  await ip.getByRole('button', { name: 'Copy link' }).waitFor({ timeout: 10000 });
  check('iPhone: Add to iPhone or Mac · Email me the link · Copy link', JSON.stringify(await buttonsOf(ip)) === JSON.stringify(['Add to iPhone or Mac', 'Email me the link', 'Copy link']), JSON.stringify(await buttonsOf(ip)));
  const webcal = await ip.getByRole('link', { name: 'Add to iPhone or Mac' }).getAttribute('href');
  check('iPhone: Add to iPhone or Mac is the webcal link', /^webcal:\/\/.+\/cal\/[A-Za-z0-9_-]{43}\.ics$/.test(webcal), webcal);
  await ip.getByRole('button', { name: 'Email me the link' }).tap();
  await ip.locator('.cal-said', { hasText: 'Sent to' }).waitFor({ timeout: 10000 });
  check('Email me the link: “Sent to <their email>”', (await words(ip.locator('.cal-said'))) === `Sent to ana.${tag}@example.org`);
  let mailed = null;
  for (let i = 0; i < 40 && !mailed; i += 1) { mailed = fake.sent.find((x) => x.subject === 'Your shifts in your calendar'); if (!mailed) await sleep(250); }
  const https = webcal.replace(/^webcal:/, 'http:');
  check('the stand-in sender got the email with the link and a key', mailed && mailed.to === `ana.${tag}@example.org` && String(mailed.body?.text || '').includes(https)
    && /^cal-email-/.test(mailed.key || ''), mailed && `${mailed.to} ${mailed.key}`);
  const card = await words(ip.locator('#calendar'));
  check('profile words: no feed, iCal, ICS, token, webcal or subscribe; the link never shown', !BANNED.test(card) && !card.includes('/cal/'), card);
  m = await measure(ip, '#calendar .btn');
  check('profile, with a link 390: 48px, no sideways scroll, one yellow button at most (two-step’s)', m.yellow <= 1 && m.minTap >= 48 && m.overflow <= 0, JSON.stringify(m));
  await ip.locator('#calendar').scrollIntoViewIfNeeded();
  await shot(ip, '06-profile-iphone-390');
  await ic.close();

  ({ ctx: ic, p: ip } = await profile(UA.android, true));
  check('Android: Email me the link · Copy link', JSON.stringify(await buttonsOf(ip)) === JSON.stringify(['Email me the link', 'Copy link']), JSON.stringify(await buttonsOf(ip)));
  check('Android: the helper line', (await words(ip.locator('#calendar'))).includes('Google adds calendar links on a computer — we’ll email it to you.'));
  await ip.locator('#calendar').scrollIntoViewIfNeeded();
  await shot(ip, '07-profile-android-390');
  await ic.close();

  ({ ctx: ic, p: ip } = await profile(UA.mac, false));
  check('Mac: Add to iPhone or Mac · Add to Google · Copy link', JSON.stringify(await buttonsOf(ip)) === JSON.stringify(['Add to iPhone or Mac', 'Add to Google', 'Copy link']), JSON.stringify(await buttonsOf(ip)));
  await ic.close();

  ({ ctx: ic, p: ip } = await profile(UA.windows, false));
  check('Windows: Add to Google · Copy link', JSON.stringify(await buttonsOf(ip)) === JSON.stringify(['Add to Google', 'Copy link']), JSON.stringify(await buttonsOf(ip)));
  const gl = await ip.getByRole('link', { name: 'Add to Google' }).getAttribute('href');
  check('Add to Google: the cid= link to the https address', gl === `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(https)}`, gl);
  await ip.getByRole('button', { name: 'Copy link' }).click();
  await ip.locator('.cal-said', { hasText: 'Link copied' }).waitFor({ timeout: 5000 });
  check('Copy: the toast names Outlook’s menu', (await words(ip.locator('.cal-said'))) === 'Link copied — paste it into Outlook: Add calendar → Subscribe from web');
  const copied = await ip.evaluate(() => navigator.clipboard.readText());
  check('Copy: a /cal/….ics link on the clipboard', copied === https, copied);
  const feed = await fetchIcs(copied);
  check('the calendar link lists the volunteer’s shift, never its instructions', feed.status === 200 && parses(feed.body)
    && feed.body.includes('Morning wave at King George') && feed.body.includes(`DTSTART:${stamp(start)}`) && !feed.body.includes('Door code'), feed.status);
  await ip.locator('#calendar').scrollIntoViewIfNeeded();
  await shot(ip, '08-profile-windows-1440');
  await ip.getByRole('button', { name: 'More' }).click();
  await ip.getByRole('button', { name: 'Make a new link' }).click();
  check('Make a new link asks first', (await words(ip.locator('.cal-confirm'))).includes('The old link stops working. Make a new one?'));
  await shot(ip, '09-profile-make-new-link-1440');
  await ip.locator('.cal-confirm').getByRole('button', { name: 'Yes' }).click();
  await ip.locator('.cal-said', { hasText: 'New link made' }).waitFor({ timeout: 10000 });
  const old = await fetchIcs(copied);
  check('the old link now answers an empty calendar', old.status === 200 && parses(old.body) && vevents(old.body) === 0, `${old.status} ${vevents(old.body)}`);
  const now = (await apiOf(ip)('/calendar/feed')).json?.feed?.url;
  check('and there is a new one', now && now !== copied);
  await ip.getByRole('button', { name: 'More' }).click();
  await ip.getByRole('button', { name: 'Stop this link' }).click();
  check('Stop this link asks first', (await words(ip.locator('.cal-confirm'))).includes('Your calendar stops getting shifts. Stop it?'));
  await shot(ip, '10-profile-stop-link-1440');
  await ip.locator('.cal-confirm').getByRole('button', { name: 'No' }).click();
  await ic.close();

  // ── 5. GOTV's voting days ──
  const adv1 = ymd(new Date(Date.now() + 5 * 864e5));
  const adv2 = ymd(new Date(Date.now() + 6 * 864e5));
  const eday = ymd(new Date(Date.now() + 10 * 864e5));
  check('voting days set', (await api('/actions/vote.settings', { on: false, election_day: eday, advance_days: [adv1, adv2], auto: true })).status === 200);
  await page.goto(`${ADMIN}/voted`, { waitUntil: 'domcontentloaded' });
  const gotv = page.getByRole('button', { name: 'Add to calendar' });
  await gotv.waitFor({ timeout: 10000 });
  await gotv.click();
  await page.locator('.cal-choices a', { hasText: 'Apple & others' }).waitFor({ timeout: 10000 });
  const vg = await page.locator('.cal-choices a', { hasText: 'Google' }).getAttribute('href');
  const next = (d) => ymd(new Date(new Date(`${d}T12:00:00Z`).getTime() + 864e5)).replace(/-/g, '');
  check('GOTV: Google adds the first voting day still to come, all day', vg.includes(`dates=${adv1.replace(/-/g, '')}/${next(adv1)}`) && vg.includes('text=Advance%20voting'), vg);
  const vfile = await fetchIcs(await page.locator('.cal-choices a', { hasText: 'Apple & others' }).getAttribute('href'));
  check('GOTV: the file has all three days, all day', vfile.status === 200 && vevents(vfile.body) === 3 && vfile.body.includes(`DTSTART;VALUE=DATE:${eday.replace(/-/g, '')}`));
  m = await measure(page, '.cal-choice');
  check('GOTV 1440: one yellow button at most, no sideways scroll', m.yellow <= 1 && m.overflow <= 0, JSON.stringify(m));
  await page.locator('.cal-add').scrollIntoViewIfNeeded();
  await shot(page, '11-gotv-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  m = await measure(page, '.cal-choice');
  check('GOTV 390: no sideways scroll', m.overflow <= 0, JSON.stringify(m));
  await page.locator('.cal-add').scrollIntoViewIfNeeded();
  await shot(page, '12-gotv-390');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 6. A treasurer's filing countdown ──
  const due = ymd(new Date(Date.now() + 40 * 864e5));
  check('filing dates set', (await api('/actions/filing.dates', { dates: [{ name: 'Disclosure statement due', due_on: due }, null] })).status === 200);
  const tinv = (await api('/actions/member.invite', { email: `tess.${tag}@example.org`, role: 'treasurer' })).json;
  const tctx = await browser.newContext(DESK);
  const tp = watch(await tctx.newPage(), 'treasurer');
  await tp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const tj = await apiOf(tp)('/auth/join', { token: tinv.joinUrl.split('/').pop(), name: 'Tess Example', password: 'ledger-lines-2026' });
  check('treasurer joined', tj.status === 200, tj.status);
  await tp.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
  const fl = tp.locator('.fl-count').getByRole('button', { name: 'Add to calendar' });
  await fl.waitFor({ timeout: 10000 });
  await fl.click();
  await tp.locator('.fl-count .cal-choices a', { hasText: 'Apple & others' }).waitFor({ timeout: 10000 });
  const fg = await tp.locator('.fl-count .cal-choices a', { hasText: 'Google' }).getAttribute('href');
  check('filing: Google adds the date, all day, by its name', fg.includes(`dates=${due.replace(/-/g, '')}/`) && fg.includes('Disclosure%20statement%20due'), fg);
  const ff = await fetchIcs(await tp.locator('.fl-count .cal-choices a', { hasText: 'Apple & others' }).getAttribute('href'));
  check('filing: the file has the date', ff.status === 200 && ff.body.includes(`DTSTART;VALUE=DATE:${due.replace(/-/g, '')}`));
  m = await measure(tp, '.cal-choice');
  check('filing 1440: one yellow button at most, no sideways scroll', m.yellow <= 1 && m.overflow <= 0, JSON.stringify(m));
  await tp.locator('.fl-count').scrollIntoViewIfNeeded();
  await shot(tp, '13-filing-1440');
  await tp.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  m = await measure(tp, '.cal-choice');
  check('filing 390: no sideways scroll', m.overflow <= 0, JSON.stringify(m));
  await tp.locator('.fl-count').scrollIntoViewIfNeeded();
  await shot(tp, '14-filing-390');
  await tctx.close();

  // ── 7. The website: sign up, then add it; the events calendar ──
  await api('/site'); // the first look makes the site
  const visitor = await browser.newContext(PHONE);
  const wp = watch(await visitor.newPage(), 'website');
  const res = await wp.goto(`${BASE}/site/events`, { waitUntil: 'domcontentloaded' });
  check('the website’s events page', res.status() === 200, res.status());
  const icsLink = wp.getByRole('link', { name: 'Get our events in your calendar' });
  check('the Events list links its calendar', await icsLink.count() >= 1);
  const evHref = await icsLink.first().getAttribute('href');
  const evFile = await fetchIcs(new URL(evHref, BASE).href);
  check('events.ics downloads with the event and no instructions', evFile.status === 200 && parses(evFile.body)
    && evFile.body.includes('Town hall in Newton') && !evFile.body.includes('9876') && !evFile.body.includes('Morning wave'), `${evHref} ${evFile.status}`);
  await wp.locator('.openings summary.rsvp-toggle').first().tap();
  const form = wp.locator('.openings form.rsvp-form').first();
  await form.locator('input[name="first_name"]').fill('Cy');
  await form.locator('input[name="email"]').fill(`cy.${tag}@example.org`);
  await form.getByRole('button', { name: 'I’ll be there' }).tap();
  await wp.locator('.rsvp-cal').first().waitFor({ timeout: 10000 });
  const line = await words(wp.locator('.rsvp-cal').first());
  check('after a sign-up: “Add it to your calendar: Google · Outlook · Apple & others”', line === 'Add it to your calendar: Google · Outlook · Apple & others', line);
  const siteApple = await wp.locator('.rsvp-cal a', { hasText: 'Apple & others' }).first().getAttribute('href');
  const one = await fetchIcs(new URL(siteApple, BASE).href);
  check('its Apple & others is that event’s own file', one.status === 200 && vevents(one.body) === 1 && one.body.includes('Town hall in Newton') && !one.body.includes('9876'), siteApple);
  const siteGoogle = await wp.locator('.rsvp-cal a', { hasText: 'Google' }).first().getAttribute('href');
  check('its Google link has the event’s time', siteGoogle.includes(`dates=${stamp(evStart)}/`), siteGoogle);
  m = await measure(wp, '.rsvp-cal a');
  check('website 390: no sideways scroll', m.overflow <= 0, JSON.stringify(m));
  await wp.locator('.rsvp-cal').first().scrollIntoViewIfNeeded();
  await shot(wp, '15-website-signed-up-390');
  await wp.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  await wp.locator('.rsvp-cal').first().scrollIntoViewIfNeeded();
  await shot(wp, '16-website-signed-up-1440');
  await visitor.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the suite ran to the end', false, e.stack || e.message);
  console.log(serverLog.slice(-2000));
} finally {
  await browser.close().catch(() => {});
  stop();
  await fake.close().catch(() => {});
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
