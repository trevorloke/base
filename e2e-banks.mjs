// Phone banks and call backs — a fresh in-memory campaign. The desk makes a
// bank (New phone bank: who to call, "No answer: call again after 2 hours,
// up to 2 calls") and hands it to a volunteer. On a phone the volunteer works
// it on Calls: a No answer says "back on your list <time>" and the number
// leaves the list for now; the bank line counts it ("1 to call back");
// "Call back…" → This evening does the same at 6; the desk's bank page shows
// both as "call back …". Measured at 390. Call this list: a list's Call
// opens New phone bank from it ("3 of 4 on it can be called"), the bank
// says who left the list and takes in who joined since; Calls on a list of
// 305 says "305 to call" and goes on past its first 300.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4132 node server/index.js &
//   BASE=http://127.0.0.1:4132 SHOTS=/tmp/banks node e2e-banks.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-banks';
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

const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const api = async (path, body) => {
  const r = body === undefined ? await dctx.request.get(`${BASE}/api${path}`) : await dctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@banks.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
for (const [n, ph] of [['Ana', '41'], ['Ben', '42'], ['Cy', '43']]) {
  await api('/actions/person.create', { name: `${n} Example`, phone: `604-555-01${ph}`, tags: ['bank-test'] });
}

// ── The desk makes the bank ──
await page.goto(`${ADMIN}/banks/new`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.bk-form', { timeout: 10000 });
await page.fill('.bk-form input[placeholder^="Undecided"]', 'Call backs test');
await page.fill('.bk-form input[placeholder^="volunteer"]', 'bank-test');
await sleep(1200);
await page.selectOption('.bk-retry select >> nth=0', '2');
await page.selectOption('.bk-retry select >> nth=1', '2');
await page.click('.bk-form button[type="submit"]');
await page.waitForURL(/\/banks\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
const bankId = page.url().split('/').pop();
const bank = (await api(`/banks/${bankId}`)).json?.bank;
check('New phone bank: three numbers, "after 2 hours, up to 2 calls"', bank?.total === 3 && bank.retry_hours === 2 && bank.max_tries === 2, JSON.stringify(bank && { total: bank.total, r: bank.retry_hours, t: bank.max_tries }));

// ── A volunteer works it on a phone ──
const invite = (await api('/actions/member.invite', { email: `jas+${tag}@banks.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await vp.goto(`${BASE}/login`);
const joined = await vp.evaluate(async (t) => (await fetch('/api/auth/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t, name: 'Jas Volunteer', password: 'knock-knock-2026' }) })).json(), invite.joinUrl.split('/').pop());
check('handed to the volunteer', (await api('/actions/bank.assign', { id: bankId, user_id: joined.user.id })).status === 200);
await vp.goto(`${BASE}/calls?bank=${bankId}`, { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('section.cl-card', { timeout: 10000 });
await sleep(600);
const cardName = async () => (await vp.innerText('section.cl-card .cl-name').catch(() => '')).trim();
const first = await cardName();
await vp.tap('section.cl-card .cl-out:has-text("No answer")');
await sleep(1200);
const toast = async () => ((await vp.innerText('.cl-toast, .walk-toast, [role="status"].toast').catch(() => '')) || (await vp.innerText('body')).match(/[A-Z][a-z]+ · No answer[^\n]*/)?.[0] || '').replace(/\s+/g, ' ').trim();
const t1 = await toast();
check(`No answer on ${first.split(' ')[0]}: "back on your list <time>"`, /No answer — back on your list \d{1,2}:\d{2}/.test(t1), t1);
const line = async () => (await vp.innerText('.cl-bank__line').catch(() => '')).replace(/\s+/g, ' ').trim();
check('the bank line: "1 to call back (next …)"', /1 to call back \(next /.test(await line()), await line());
check('the next card is someone else', (await cardName()) && (await cardName()) !== first, await cardName());
let mine = (await vp.evaluate(async (b) => (await fetch(`/api/banks/${b}/mine`)).json(), bankId));
check('the server: off the list for now, counted as later', !mine.persons.some((p) => p.name === first) && mine.bank.later === 1, JSON.stringify(mine.bank));
const m = await vp.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const taps = [...document.querySelectorAll('section.cl-card .cl-out')].filter(vis).map((el) => el.getBoundingClientRect().height);
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, minTap: Math.min(...taps) };
});
check('Calls at 390: no sideways scroll, outcome buttons ≥ 48px (with "Call back…")', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
const second = await cardName();
await vp.tap('section.cl-card .cl-out:has-text("Call back")');
await vp.waitForSelector('.cl-callback', { timeout: 3000 }).catch(() => {});
await vp.screenshot({ path: `${SHOTS}/01-callback.png` });
await vp.tap('.cl-callback button:has-text("This evening")');
await sleep(1200);
const t2 = await toast();
check(`Call back… → This evening: "${second.split(' ')[0]} · back on your list … 6:00 p.m."`, /back on your list .*6:00/.test(t2), t2);
mine = (await vp.evaluate(async (b) => (await fetch(`/api/banks/${b}/mine`)).json(), bankId));
check('two to call back, one left to call now', mine.bank.later === 2 && mine.persons.length === 1, JSON.stringify(mine.bank));
// The third: Left message — the call left word; the number is done, never called back.
const third = await cardName();
await vp.tap('section.cl-card .cl-out:has-text("Left message")');
await sleep(1200);
const t3 = await toast();
check(`Left message on ${third.split(' ')[0]}: "Left message", no call back`, /Left message/.test(t3) && !/back on your list/.test(t3), t3);
mine = (await vp.evaluate(async (b) => (await fetch(`/api/banks/${b}/mine`)).json(), bankId));
check('the server: done, nobody left to call now', mine.bank.done === 1 && mine.persons.length === 0, JSON.stringify(mine.bank));

// ── The desk's bank page ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.bk-table', { timeout: 8000 });
const statuses = await page.$$eval('.bk-table tbody tr td:nth-of-type(4)', (els) => els.map((e) => e.innerText.trim()));
check('the desk sees "call back …" on both, with the try counted on the No answer', statuses.filter((x) => /^call back /.test(x)).length === 2 && statuses.some((x) => /1 try/.test(x)), statuses.join(' | '));
check('the No answer setting reads back', (await page.inputValue('section[aria-label="No answer"] select >> nth=0')) === '2');

// ── Call this list: a List feeds a phone bank ──
// Four on the list; Gus asked not to be called, so three can be.
for (const [n, ph, tags] of [['Dee', '44', ['call-list']], ['Eve', '45', ['call-list']], ['Fay', '46', ['call-list']], ['Gus', '47', ['call-list', 'do-not-contact']]]) {
  await api('/actions/person.create', { name: `${n} Example`, phone: `604-555-01${ph}`, tags });
}
const callList = (await api('/actions/list.create', { name: 'Call these people', kind: 'filter', filter: { tag: 'call-list' } })).json.list;
await page.goto(`${ADMIN}/lists`, { waitUntil: 'domcontentloaded' });
const row = page.locator('.ops-item', { has: page.locator('.au-row__name', { hasText: 'Call these people' }) });
await row.locator('.au-go a:has-text("Call")').waitFor({ timeout: 8000 });
await page.waitForFunction(() => /4 people · 3 can be reached/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
const rowText = (await row.innerText()).replace(/\s+/g, ' ');
check('Lists: the row says "4 people · 3 can be reached" and Call says 3', /4 people · 3 can be reached/.test(rowText) && /Call\s*3\b/.test(rowText), rowText);
await row.locator('.au-go a:has-text("Call")').click();
await page.waitForURL(/\/banks\/new\?list=/, { timeout: 8000 });
await page.waitForFunction(() => /3 of 4 on it can be called/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
let t = (await page.innerText('main')).replace(/\s+/g, ' ');
check('Call → New phone bank, from the list: "3 of 4 on it can be called", named after it',
  /3 of 4 on it can be called/.test(t) && (await page.inputValue('.bk-form select')) === callList.id
  && (await page.inputValue('.bk-form input[placeholder^="Undecided"]')) === 'Call these people'
  && (await page.getAttribute('.au-from button:has-text("From a list")', 'aria-pressed')) === 'true', t.slice(0, 240));
const mNew = await page.evaluate(() => ({ yellow: [...document.querySelectorAll('.btn-primary')].filter((el) => el.getBoundingClientRect().width > 0).length, overflow: document.documentElement.scrollWidth - window.innerWidth }));
check('…one yellow, no sideways scroll', mNew.yellow === 1 && mNew.overflow <= 0, JSON.stringify(mNew));
await page.screenshot({ path: `${SHOTS}/02-call-this-list.png` });
await page.click('.bk-form button[type="submit"]:has-text("Make the bank with 3 numbers")');
await page.waitForURL(/\/banks\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
const listBankId = page.url().split('/').pop();
let lb = (await api(`/banks/${listBankId}`)).json?.bank;
check('the bank: three numbers, made from the list', lb?.total === 3 && lb.list_id === callList.id && lb.list_name === 'Call these people', JSON.stringify(lb && { total: lb.total, list: lb.list_name }));
// Dee leaves the list (her tag is taken off): she leaves the calls not made yet.
const dee = (await api('/persons?q=Dee%20Example&limit=1')).json.persons[0];
await api('/actions/person.update', { id: dee.id, tags: [] });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.au-banklist', { timeout: 8000 });
t = (await page.innerText('main')).replace(/\s+/g, ' ');
const deeRow = (await page.innerText(`.bk-table tbody tr:has-text("Dee Example")`).catch(() => '')).replace(/\s+/g, ' ');
lb = (await api(`/banks/${listBankId}`)).json?.bank;
check('Dee leaves the list: "From the list Call these people · 1 left the list…", her row says so, two still to hand out',
  /From the list Call these people · 1 left the list or can’t be called now/.test(t) && /left the list or can’t be called now/.test(deeRow) && lb.gone === 1 && lb.open === 2, `${t.slice(0, 200)} · ${deeRow}`);
// Hal joins it: Add who joined since brings him in.
await api('/actions/person.create', { name: 'Hal Example', phone: '604-555-0148', tags: ['call-list'] });
await page.click('.au-banklist button:has-text("Add who joined since")');
await page.waitForSelector('.au-banklist .ops-done', { timeout: 8000 }).catch(() => {});
const topped = await page.innerText('.au-banklist .ops-done').catch(() => '');
lb = (await api(`/banks/${listBankId}`)).json?.bank;
check('Hal joins: "Add who joined since" → "✓ 1 more to call — on the list since"; four numbers', /1 more to call/.test(topped) && lb.total === 4 && lb.open === 3, `${topped} · ${lb.total}/${lb.open}`);
await page.screenshot({ path: `${SHOTS}/03-bank-from-list.png`, fullPage: true });

// ── Calls with ?list=: past the first 300 ──
const many = Array.from({ length: 305 }, (_, i) => ({ name: `Many ${String(i + 1).padStart(3, '0')} Example`, phone: `604-555-01${String(i % 100).padStart(2, '0')}` }));
check('305 people on one list come in', (await api('/data/import', { rows: many, tag: 'many' })).json?.created === 305);
const manyList = (await api('/actions/list.create', { name: 'Many to call', kind: 'filter', filter: { tag: 'many' } })).json.list;
await page.goto(`${ADMIN}/calls?list=${manyList.id}&channel=phone`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.cl-progress', { timeout: 10000 });
await page.waitForFunction(() => /305 to call/.test(document.querySelector('.cl-progress')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
check('Calls with the list: "305 to call" — the true number, not the first 300', /305 to call/.test(await page.innerText('.cl-progress')), await page.innerText('.cl-progress'));
// The first 290 by name called already in this sitting: the next part comes in by itself.
const first300 = (await api(`/persons?list=${manyList.id}&has=phone&reach=call&limit=300`)).json.persons;
await page.evaluate((ids) => sessionStorage.setItem('starbase.calls.done', JSON.stringify(Object.fromEntries(ids.map((id) => [id, { outcome: 'no_answer' }])))), first300.slice(0, 290).map((p) => p.id));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.cl-progress', { timeout: 10000 });
await page.waitForFunction(() => /\b15 to call/.test(document.querySelector('.cl-progress')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
await page.click('.cl-next__btn').catch(() => {});
const upNext = [(await page.innerText('.cl-card .cl-name').catch(() => '')).trim(),
  ...await page.$$eval('.cl-next__list li span:first-child', (els) => els.map((e) => e.innerText.trim())).catch(() => [])];
check('290 done: "15 to call", and the list goes on past 300 (Many 301–305 are on it)',
  /\b15 to call/.test(await page.innerText('.cl-progress')) && [301, 302, 303, 304, 305].every((n) => upNext.includes(`Many ${n} Example`)) && !/Start over/.test(await page.innerText('main')),
  `${await page.innerText('.cl-progress')} · ${upNext.join(', ')}`);
await page.screenshot({ path: `${SHOTS}/04-calls-past-300.png` });
await page.evaluate(() => sessionStorage.removeItem('starbase.calls.done'));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
