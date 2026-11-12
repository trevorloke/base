// Candidates — a fresh in-memory campaign (made-up people, example.org
// emails). The manager adds two candidates under Settings → Candidates
// (Mo, for Mayor, with no race; Cleo, Council on the City council race),
// invites both, and each joins in a browser of their own. On a 390x844
// phone, Cleo's Today is "Your day": one primary button, "Met someone →",
// her booked shift, "Your week", and Your race from Path to win; Mo's, with
// nothing booked and no race, shows only the button. A candidate has no
// Admin link; /admin tells them it's not theirs; /api/candidates and
// /api/pathtowin refuse them. The manager gives People to the Candidates
// column under Permissions; Cleo's areas say so, and the desk's ties
// (/api/relationships/key) still refuse her. Screens at 1440x900 and 390.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5170 node server/index.js &
//   BASE=http://127.0.0.1:5170 SHOTS=/tmp/candidates node e2e-candidates.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5170';
const SHOTS = process.env.SHOTS || '/tmp/starbase-candidates';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const WIDE = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

const dctx = await browser.newContext(WIDE);
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const apiOf = (ctx) => async (path, body) => {
  const r = body === undefined ? await ctx.request.get(`${BASE}/api${path}`) : await ctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const api = apiOf(dctx);
// What one screen holds: sideways scroll, primary buttons, the smallest tap target.
const measure = (p, sel) => p.evaluate((s) => {
  const root = document.querySelector(s) || document.body;
  const taps = [...root.querySelectorAll('a.btn, button, a.today-row, select, input:not([type=checkbox]):not([type=radio])')]
    .filter((el) => el.offsetParent !== null && !el.closest('.ot-sr'));
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    primaries: [...root.querySelectorAll('.btn-primary')].filter((el) => el.offsetParent !== null).length,
    minTap: Math.min(...taps.map((el) => el.getBoundingClientRect().height)),
    words: (root.innerText || '').split(/\s+/).filter(Boolean).length,
  };
}, sel);

// ── 1. The manager adds two candidates and invites them ──
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

await page.goto(`${BASE}/admin/settings/candidates`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=No candidates yet', { timeout: 10000 });
check('Settings → Candidates: a tab of its own, empty to start', await page.locator('.ws-tab:has-text("Candidates")').count() === 1);
const add = async (name, office, race, email, shot) => {
  await page.click('button:has-text("Add a candidate")');
  await page.waitForSelector('form.can-form');
  const f = page.locator('form.can-form');
  await f.locator('input').nth(0).fill(name);
  await f.locator('input').nth(1).fill(office);
  if (race) await f.locator('select').selectOption({ label: race });
  await f.locator('input[type="email"]').fill(email);
  if (shot) await page.screenshot({ path: `${SHOTS}/${shot}`, fullPage: true });
  await f.locator('button[type="submit"]').click();
  await page.waitForSelector(`.can-row:has-text("${name}")`, { timeout: 8000 });
};
await add('Mo Example', 'Mayor', null, `mo+${tag}@example.org`, '01-add-form-1440.png');
await add('Cleo Example', 'Council', 'City council', `cleo+${tag}@example.org`);
const rows = await page.locator('.can-row').allInnerTexts();
check('two rows: "Mayor" and "Council · City council", both Not invited',
  rows.length === 2 && /Mayor/.test(rows[0]) && /Council · City council/.test(rows[1]) && rows.every((r) => /Not invited/.test(r)), JSON.stringify(rows));

// Saving opens the new row in place: Cleo's is open; invite her.
if (await page.getAttribute('.can-row:has-text("Cleo Example")', 'aria-expanded') !== 'true') await page.click('.can-row:has-text("Cleo Example")');
await page.click('button:has-text("Invite to the app")');
await page.waitForSelector('[data-testid="candidate-joinlink"]', { timeout: 8000 });
const cleoLink = (await page.innerText('[data-testid="candidate-joinlink"]')).trim();
check('Invite to the app: the link to copy, and the row says Invited',
  /\/join\/[0-9a-f]{48}$/.test(cleoLink) && /Invited/.test(await page.innerText('.can-row:has-text("Cleo Example")')), cleoLink);
await page.screenshot({ path: `${SHOTS}/02-candidates-row-open-1440.png`, fullPage: true });
const m1 = await measure(page, 'main');
check('Settings → Candidates: one primary button at most', m1.primaries <= 1, JSON.stringify(m1));
const list = (await api('/candidates')).json.candidates;
const mo = list.find((c) => c.name === 'Mo Example');
const moLink = (await api('/actions/candidate.invite', { id: mo.id })).json.joinUrl;

// Cleo's booked shift (the shift's spot is her record, found by her email) and her race's numbers.
const cleoPerson = (await api('/actions/person.create', { name: 'Cleo Example', email: `cleo+${tag}@example.org` })).json.person;
const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
const shift = (await api('/actions/shift.create', { title: 'Newton farmers market', starts_at: soon(26), ends_at: soon(29), capacity: 4 })).json.shift;
await api('/actions/shift.assign', { shift_id: shift.id, person_id: cleoPerson.id });
await api('/actions/pathtowin.save', { election_day: '2030-10-19', races: { council: { how: 'direct', votes: 12000 } } });

const joinIn = async (link, name) => {
  const ctx = await browser.newContext(PHONE);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await p.goto(`${BASE}/join/${link.split('/join/')[1]}`);
  await p.fill('#join-name', name);
  await p.fill('#join-password', 'candidate-pass-2026');
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 }).catch(() => {});
  return { ctx, p, api: apiOf(ctx) };
};
const cleo = await joinIn(cleoLink, 'Cleo Example');
const meCleo = (await cleo.api('/auth/me')).json;
check('Cleo joined in her own browser: a volunteer with the Council seat',
  meCleo.role === 'volunteer' && meCleo.candidate?.office === 'Council' && meCleo.candidate?.race_label === 'City council', JSON.stringify(meCleo.candidate));

// ── 2. Cleo's phone: Your day ──
await cleo.p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await cleo.p.waitForSelector('h1:has-text("Your day")', { timeout: 10000 });
await cleo.p.waitForSelector('.cand-race .today-num', { timeout: 10000 });
await cleo.p.waitForSelector('.today-row:has-text("Newton farmers market")', { timeout: 10000 });
const t = await cleo.p.innerText('main');
check('"Good …, Cleo" and "Your day"', /Good (morning|afternoon|evening), Cleo/.test(t) && /Your day/.test(t));
check('"Met someone →" is the one primary button, to Mainstreeting',
  (await cleo.p.getAttribute('.today-go a.btn-primary', 'href')) === '/mainstreet' && /Met someone/.test(await cleo.p.innerText('.today-go a.btn-primary')));
check('her booked shift, then "Your week · 1"', /Your next shift/.test(t) && /Your week · 1/.test(t));
const race = await cleo.p.innerText('.cand-race');
check('Your race · City council: Supporters, Needed, Days left', /City council/.test(race) && /Supporters/.test(race) && /Needed/.test(race) && /Days left/.test(race), race.replace(/\s+/g, ' '));
const m2 = await measure(cleo.p, 'main');
check('at 390: no sideways scroll, one primary, taps ≥ 48px', m2.overflow <= 0 && m2.primaries === 1 && m2.minTap >= 48, JSON.stringify(m2));
await cleo.p.screenshot({ path: `${SHOTS}/03-candidate-today-390.png`, fullPage: true });
await cleo.p.click('.today-morebox__toggle');
const more = await cleo.p.innerText('.today-morebox__body');
check('More: Start canvassing, Calls, Signs', /Start canvassing/.test(more) && /Calls/.test(more) && /Signs/.test(more));
await cleo.p.screenshot({ path: `${SHOTS}/04-candidate-today-more-390.png`, fullPage: true });

// Mo: nothing booked, no race — only the button.
const moB = await joinIn(moLink, 'Mo Example');
await moB.p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await moB.p.waitForSelector('h1:has-text("Your day")', { timeout: 10000 });
await sleep(800);
const tm = await moB.p.innerText('main');
check('Mo with nothing yet: no shift rows, no race, no made-up 0', !/Your week|Your next shift|Your race|Supporters/.test(tm) && /Met someone/.test(tm), tm.replace(/\s+/g, ' ').slice(0, 200));
await moB.p.screenshot({ path: `${SHOTS}/05-candidate-today-none-390.png`, fullPage: true });

// The candidate's Today wide.
const wide = await browser.newContext(WIDE);
await wide.addCookies(await cleo.ctx.cookies());
const wp = await wide.newPage();
wp.on('pageerror', (e) => errors.push(`cleo wide: ${e.message}`));
await wp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await wp.waitForSelector('.cand-race .today-num', { timeout: 10000 });
await wp.screenshot({ path: `${SHOTS}/06-candidate-today-1440.png`, fullPage: true });

// ── 3. Not the desk ──
await cleo.p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await cleo.p.waitForSelector('h1:has-text("Your day")', { timeout: 10000 });
const acct = cleo.p.locator('.acct-btn').first();
if (await acct.count()) await acct.click();
check('no Admin link for a candidate', await cleo.p.locator('a.acct-item:has-text("Admin")').count() === 0);
await cleo.p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await cleo.p.waitForSelector('text=Open the field app', { timeout: 10000 }).catch(() => {});
check('/admin: "Not for your role", the way back to the field app (candidate)',
  /Not for your role/.test(await cleo.p.innerText('body')) && /\(candidate\)/.test(await cleo.p.innerText('body')));
const r1 = await cleo.api('/candidates');
const r2 = await cleo.api('/pathtowin');
check('/api/candidates and /api/pathtowin refuse her', [403, 404].includes(r1.status) && [403, 404].includes(r2.status), `${r1.status} ${r2.status}`);

// ── 4. People for the Candidates column ──
await page.goto(`${BASE}/admin/settings/permissions`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[aria-label="People for Candidate"]', { timeout: 10000 });
check('Permissions: a Candidates column, with its line', /Candidate/.test(await page.innerText('.adm-grid thead'))
  && /Who-knows-who stays with the desk/.test(await page.innerText('main')));
// A controlled box: it shows ticked once the server has said yes.
await page.click('input[aria-label="People for Candidate"]');
await page.waitForFunction(() => document.querySelector('input[aria-label="People for Candidate"]')?.checked, null, { timeout: 8000 }).catch(() => {});
check('People ticked for candidates, not for volunteers', await page.isChecked('input[aria-label="People for Candidate"]')
  && !(await page.isChecked('input[aria-label="People for Volunteer"]')));
await page.screenshot({ path: `${SHOTS}/07-permissions-1440.png`, fullPage: true });
const areas = (await cleo.api('/auth/me')).json.areas;
const ties = await cleo.api('/relationships/key');
const knows = await cleo.api(`/persons/${cleoPerson.id}/knows`);
// /relationships/key is R's (the next batch): until it lands the address is
// the app's page, no data; once it does, it must refuse her.
check('Cleo now has People, and still none of the desk’s ties', areas.includes('people') && (ties.status === 403 || ties.json === null) && knows.status === 403, `${areas} ${ties.status} ${knows.status}`);

// Settings → Candidates and Permissions on a phone.
const mctx = await browser.newContext(PHONE);
await mctx.addCookies(await dctx.cookies());
const mp = await mctx.newPage();
mp.on('pageerror', (e) => errors.push(`desk phone: ${e.message}`));
await mp.goto(`${BASE}/admin/settings/candidates`, { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('.can-row', { timeout: 10000 });
const rows2 = await mp.locator('.can-row').allInnerTexts();
check('both rows now Signed in', rows2.length === 2 && rows2.every((r) => /Signed in/.test(r)), JSON.stringify(rows2));
const m3 = await measure(mp, 'main');
check('Candidates at 390: no sideways scroll, one primary', m3.overflow <= 0 && m3.primaries <= 1, JSON.stringify(m3));
await mp.screenshot({ path: `${SHOTS}/08-candidates-390.png`, fullPage: true });
await mp.click('.can-row:has-text("Mo Example")');
await mp.click('.can-more');
await mp.screenshot({ path: `${SHOTS}/09-candidates-row-open-390.png`, fullPage: true });
await mp.click('button:has-text("Add a candidate")').catch(() => {});
await mp.waitForSelector('form.can-form', { timeout: 5000 }).catch(() => {});
await mp.screenshot({ path: `${SHOTS}/10-add-form-390.png`, fullPage: true });
await mp.goto(`${BASE}/admin/settings/permissions`, { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('.adm-grid', { timeout: 10000 });
await mp.screenshot({ path: `${SHOTS}/11-permissions-390.png`, fullPage: true });
await mp.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('.tm-candidate', { timeout: 10000 }).catch(() => {});
check('Members: "Candidate · Council" in place of the role picker', /Candidate · Council/.test(await mp.innerText('main')));
await mp.screenshot({ path: `${SHOTS}/12-members-390.png`, fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
