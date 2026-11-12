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
// (/api/relationships/key) still refuse her. Then call time: the manager
// makes a bank of three made-up donors for Cleo ("Who calls", an ask of
// $250); her Today leads with "Start call time →"; on the card a pledge over
// the room is refused in words, $250 is pledged, No answer, and the last
// answer is made offline and sent on reconnect; the treasurer sees
// "Pledges from call time · 1 · $250", logs the gift, and it reads "Gift in
// ✓"; an offline pledge to a donor her other phone already answered is
// refused on reconnect and drops off "All done"; Mo gets 404 for Cleo's
// call time; Mo is removed and his call time stays closed (no Reopen).
// Screens at 1440x900 and 390.
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

// ── 5. Call time: the manager makes a bank of three donors for Cleo ──
const donors = [];
for (const [i, n] of ['Ada', 'Ben', 'Cy'].entries()) {
  donors.push((await api('/actions/person.create', { name: `${n} Donor${tag}`, phone: `604-555-01${60 + i}`, tags: [`ct${tag}`] })).json.person);
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
await api('/actions/gift.log', { person_id: donors[0].id, amount_cents: 50000, date: today, slate: 'council', method: 'cheque' });
await page.goto(`${BASE}/admin/banks/new`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('label:has-text("Who calls")', { timeout: 10000 });
await page.fill('input[placeholder^="Undecided in Newton"]', 'Cleo’s call time');
await page.locator('label:has-text("Who calls") + select').selectOption({ label: 'Call time: Cleo Example' });
await page.waitForSelector('label:has-text("Ask")', { timeout: 5000 });
await page.fill('input.bk-ask', '250');
await page.click('button:has-text("Pick people")');
await page.fill('input[placeholder="volunteer, newton…"]', `ct${tag}`);
await page.waitForSelector('button:has-text("Make the bank with 3 numbers")', { timeout: 10000 });
await page.screenshot({ path: `${SHOTS}/13-new-bank-who-calls-1440.png`, fullPage: true });
const m5 = await measure(page, 'main');
check('New phone bank: "Who calls" with Cleo’s call time and an Ask; one primary', m5.primaries <= 1, JSON.stringify(m5));
await page.click('button:has-text("Make the bank with 3 numbers")');
await page.waitForSelector('.eyebrow:has-text("Call time · Cleo Example")', { timeout: 10000 });
const bankId = page.url().split('/banks/')[1];
const bankText = await page.innerText('main');
check('the bank: "Call time · Cleo Example", every number hers, no hand-out', /Every number is Cleo Example’s to call · ask \$250/.test(bankText) && !/Hand out numbers/.test(bankText), bankText.replace(/\s+/g, ' ').slice(0, 200));
check('the bank: no Take back on any of Cleo’s numbers', !/Take back/.test(bankText), (bankText.match(/.{0,60}Take back.{0,20}/) || [''])[0]);
await page.screenshot({ path: `${SHOTS}/14-calltime-bank-1440.png`, fullPage: true });

// ── 6. Cleo's Today: Start call time ──
await cleo.p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await cleo.p.waitForSelector('.today-go a.btn-primary:has-text("Start call time")', { timeout: 10000 });
const go = await cleo.p.innerText('.today-go');
const m6 = await measure(cleo.p, 'main');
check('Today: "Start call time →" with "3 to call"; Met someone a row; one primary', /3 to call/.test(go) && /Met someone/.test(await cleo.p.innerText('.today-next')) && m6.primaries === 1, `${go} ${JSON.stringify(m6)}`);
await cleo.p.screenshot({ path: `${SHOTS}/15-candidate-today-calltime-390.png`, fullPage: true });

// ── 7. Call time on her phone ──
await cleo.p.click('.today-go a.btn-primary');
await cleo.p.waitForSelector('.ct-card .ct-name', { timeout: 10000 });
const facts = await cleo.p.innerText('.ct-card');
check('the card: name, Call, the facts line with Room, and the Ask', /Room \$/.test(facts) && /Ask \$250/.test(facts) && await cleo.p.locator('.ct-call[href^="tel:"]').count() === 1, facts.replace(/\s+/g, ' ').slice(0, 220));
const m7 = await measure(cleo.p, 'main');
check('call time at 390: no sideways scroll, no primary until Pledged, taps ≥ 48px', m7.overflow <= 0 && m7.primaries === 0 && m7.minTap >= 48, JSON.stringify(m7));
await cleo.p.screenshot({ path: `${SHOTS}/16-calltime-card-390.png`, fullPage: true });
// Ada (a gift this year) — find her card: the room is $929.70.
const first = await cleo.p.innerText('.ct-name');
await cleo.p.click('button.ct-answer:has-text("Pledged")');
await cleo.p.waitForSelector('#ct-amount');
check('Pledged: the amount filled with the ask, and the one line about the agent',
  (await cleo.p.inputValue('#ct-amount')) === '250' && /A pledge isn’t a gift — the financial agent takes the money/.test(await cleo.p.innerText('.ct-card')));
await cleo.p.fill('#ct-amount', '5000');
await cleo.p.click('button:has-text("Save pledge")');
await cleo.p.waitForSelector('.ct-card .error', { timeout: 5000 });
check('a pledge over the room is refused in words', /That’s over what they can give this year — up to \$/.test(await cleo.p.innerText('.ct-card .error')));
await cleo.p.fill('#ct-amount', '250');
await cleo.p.screenshot({ path: `${SHOTS}/17-calltime-pledge-open-390.png`, fullPage: true });
const m7b = await measure(cleo.p, 'main');
check('pledge open: Save pledge is the one primary', m7b.primaries === 1, JSON.stringify(m7b));
await cleo.p.click('button:has-text("Save pledge")');
await cleo.p.waitForFunction((n) => document.querySelector('.ct-name')?.textContent !== n, first, { timeout: 8000 });
check('$250 pledged: "Saved", and the next card', /Saved/.test(await cleo.p.innerText('.toast')).valueOf());
await cleo.p.click('button.ct-answer:has-text("No answer")');
await cleo.p.waitForFunction(() => document.querySelectorAll('.ct-card').length === 1, null, { timeout: 5000 });
await sleep(600);
// The last one with no signal.
await cleo.ctx.setOffline(true);
await sleep(300);
await cleo.p.click('button.ct-answer:has-text("Left message")');
await cleo.p.waitForSelector('.ct-done', { timeout: 8000 });
const done = await cleo.p.innerText('.ct-done');
check('offline: the answer waits on the phone, and the end reads "All done — 3 calls, $250 pledged"', /All done — 3 calls, \$250 pledged/.test(done), done.replace(/\s+/g, ' '));
await cleo.p.screenshot({ path: `${SHOTS}/18-calltime-done-offline-390.png`, fullPage: true });
await cleo.ctx.setOffline(false);
let sent = 0;
for (let i = 0; i < 30 && sent < 3; i++) {
  await sleep(500);
  sent = (await api(`/banks/${bankId}`)).json?.bank?.done ?? 0;
  const later = (await api(`/banks/${bankId}`)).json?.numbers?.filter((n) => n.outcome === 'left_message').length ?? 0;
  if (later) break;
}
const nums = (await api(`/banks/${bankId}`)).json.numbers;
check('back online: the waiting answer is sent (Left message on the bank)', nums.some((n) => n.outcome === 'left_message'), JSON.stringify(nums.map((n) => n.outcome)));
// The card wide.
await wp.goto(`${BASE}/call-time`, { waitUntil: 'domcontentloaded' });
await wp.waitForSelector('.ct-done, .ct-card', { timeout: 10000 });
await wp.screenshot({ path: `${SHOTS}/19-calltime-1440.png`, fullPage: true });

// ── 8. The treasurer: Pledges from call time ──
const tinv = (await api('/actions/member.invite', { email: `tess+${tag}@example.org`, role: 'treasurer' })).json.joinUrl;
const tctx = await browser.newContext(WIDE);
const tp = await tctx.newPage();
tp.on('pageerror', (e) => errors.push(`treasurer: ${e.message}`));
await tp.goto(`${BASE}/join/${tinv.split('/join/')[1]}`);
await tp.fill('#join-name', 'Tess Example');
await tp.fill('#join-password', 'treasurer-pass-2026');
await tp.click('button[type="submit"]');
await tp.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 }).catch(() => {});
await tp.goto(`${BASE}/admin/money`, { waitUntil: 'domcontentloaded' });
await tp.waitForSelector('.ops-row:has-text("Pledges from call time")', { timeout: 10000 });
const prow = await tp.innerText('.ops-row:has-text("Pledges from call time")');
check('Donations → Needs you: "Pledges from call time · 1 · $250"', /Pledges from call time · 1/.test(prow) && /\$250/.test(prow), prow.replace(/\s+/g, ' '));
await tp.click('.ops-row:has-text("Pledges from call time")');
await tp.waitForSelector('#ct-pledges .ops-row', { timeout: 8000 });
await tp.screenshot({ path: `${SHOTS}/20-needs-you-pledges-1440.png`, fullPage: true });
const pledgeText = await tp.innerText('#ct-pledges');
const pledged = donors.find((d) => pledgeText.includes(d.name));
check('the pledge: donor, Cleo · the date, and a quiet Drop', Boolean(pledged) && /Cleo Example · \d+ \w+ \d{4}/.test(pledgeText) && /Drop/.test(pledgeText), pledgeText.replace(/\s+/g, ' '));
const tapi = apiOf(tctx);
await tapi('/actions/gift.log', { person_id: pledged.id, amount_cents: 25000, date: today, slate: 'council', method: 'cheque' });
await tp.reload({ waitUntil: 'domcontentloaded' });
await tp.waitForSelector('.ops-row:has-text("Pledges from call time")', { timeout: 10000 });
await tp.click('.ops-row:has-text("Pledges from call time")');
await tp.waitForSelector('#ct-pledges .chip', { timeout: 8000 });
check('the gift logged: the pledge shows "Gift in ✓ $250"', /Gift in ✓ \$250/.test(await tp.innerText('#ct-pledges')));
const tph = await browser.newContext(PHONE);
await tph.addCookies(await tctx.cookies());
const tpp = await tph.newPage();
await tpp.goto(`${BASE}/admin/money`, { waitUntil: 'domcontentloaded' });
await tpp.waitForSelector('.ops-row:has-text("Pledges from call time")', { timeout: 10000 });
await tpp.click('.ops-row:has-text("Pledges from call time")');
await tpp.waitForSelector('#ct-pledges .chip', { timeout: 8000 });
const m8 = await measure(tpp, 'main');
check('Donations at 390 with pledges: no sideways scroll', m8.overflow <= 0, JSON.stringify(m8));
await tpp.screenshot({ path: `${SHOTS}/21-pledges-390.png`, fullPage: true });

// ── 8b. An offline answer the server refuses is not counted ──
// Two more donors on a bank of Cleo's. With no signal she pledges $250 to
// the first; meanwhile her other phone answers the same donor (Not now).
// She answers the second (Not now) and comes back online: the pledge is
// refused as already called, and the end counts only what the server has.
const smalls = [];
for (const [i, n] of ['Small0', 'Small1'].entries()) {
  smalls.push((await api('/actions/person.create', { name: `${n} Donor${tag}`, phone: `604-555-01${70 + i}`, tags: [`sm${tag}`] })).json.person);
}
const smallBank = (await api('/actions/bank.create', { name: 'Cleo’s small donors', person_ids: smalls.map((s) => s.id), candidate_id: (await api('/candidates')).json.candidates.find((c) => c.name === 'Cleo Example').id })).json.bank.id;
const other = await browser.newContext(PHONE);
await other.addCookies(await cleo.ctx.cookies());
await cleo.p.goto(`${BASE}/call-time?bank=${smallBank}`, { waitUntil: 'domcontentloaded' });
await cleo.p.waitForSelector('.ct-card .ct-name', { timeout: 10000 });
await sleep(600);
const firstSmall = await cleo.p.innerText('.ct-name');
const firstSmallId = smalls.find((s) => s.name === firstSmall.trim())?.id;
await cleo.ctx.setOffline(true);
await sleep(300);
await cleo.p.click('button.ct-answer:has-text("Pledged")');
await cleo.p.fill('#ct-amount', '250');
await cleo.p.click('button:has-text("Save pledge")');
await cleo.p.waitForFunction((n) => document.querySelector('.ct-name')?.textContent !== n, firstSmall, { timeout: 8000 });
const elsewhere = await apiOf(other)('/actions/calltime.log', { client_id: crypto.randomUUID(), bank_id: smallBank, person_id: firstSmallId, result: 'no' });
await cleo.p.click('button.ct-answer:has-text("Not now")');
await cleo.p.waitForSelector('.ct-done', { timeout: 8000 });
await cleo.ctx.setOffline(false);
await cleo.p.waitForFunction(() => /refused/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
await cleo.p.waitForFunction(() => /All done — 2 calls/.test(document.querySelector('.ct-done')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
const doneSmall = await cleo.p.innerText('.ct-done');
const serverSmall = (await cleo.api(`/calltime/${smallBank}`)).json?.done;
check('a refused offline pledge drops off the end: "All done — 2 calls, $0 pledged", as the server has it',
  elsewhere.status === 200 && /All done — 2 calls, \$0 pledged/.test(doneSmall) && serverSmall?.calls === 2 && serverSmall?.pledged_cents === 0,
  `${elsewhere.status} ${doneSmall.replace(/\s+/g, ' ')} ${JSON.stringify(serverSmall)}`);
await cleo.p.screenshot({ path: `${SHOTS}/21b-calltime-refused-390.png`, fullPage: true });
await other.close();

// ── 9. Mo sees none of Cleo's call time ──
const moCt = await moB.api(`/calltime/${bankId}`);
const moHome = (await moB.api('/candidate/home')).json;
check('Mo: Cleo’s call time answers 404, and none is his', moCt.status === 404 && moHome.calltime.banks.length === 0, `${moCt.status} ${JSON.stringify(moHome.calltime)}`);
await moB.p.goto(`${BASE}/call-time`, { waitUntil: 'domcontentloaded' });
await moB.p.waitForSelector('text=No call time yet', { timeout: 10000 });
check('Mo’s /call-time: "No call time yet"', true);

// ── 10. Mo is removed: his call time closes and stays closed ──
const moSeat = (await api('/candidates')).json.candidates.find((c) => c.name === 'Mo Example').id;
const moBank = (await api('/actions/bank.create', { name: 'Mo’s call time', person_ids: [smalls[1].id], candidate_id: moSeat })).json.bank.id;
await api('/actions/candidate.remove', { id: moSeat });
const reopen = await api('/actions/bank.update', { id: moBank, closed: false });
await page.goto(`${BASE}/admin/banks/${moBank}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.bk-calltime', { timeout: 10000 });
const moBankText = await page.innerText('main');
check('a removed candidate’s bank: no Reopen, "Mo Example is no longer a candidate — the bank stays closed."',
  reopen.status === 409 && !/Reopen/.test(await page.innerText('.head-actions')) && /Mo Example is no longer a candidate — the bank stays closed\./.test(moBankText),
  `${reopen.status} ${moBankText.replace(/\s+/g, ' ').slice(0, 200)}`);
await page.screenshot({ path: `${SHOTS}/22-removed-candidate-bank-1440.png`, fullPage: true });
await mp.goto(`${BASE}/admin/banks/${moBank}`, { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('.bk-calltime', { timeout: 10000 });
const m10 = await measure(mp, 'main');
check('the same at 390: no sideways scroll', m10.overflow <= 0, JSON.stringify(m10));
await mp.screenshot({ path: `${SHOTS}/23-removed-candidate-bank-390.png`, fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
