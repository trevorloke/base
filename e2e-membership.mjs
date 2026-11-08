// Membership form E2E — the paper form, typed in at the desk.
//
// A desk signs up and finds People → More → "Enter a membership form". A
// made-up person's form is typed box for box (basic information, citizen,
// union local, campus, volunteer, a window sign, languages with one not on
// the list, interests, a 1-year membership, Superstar Club once, cheque,
// signed) and saved: the screen says what was done (youth membership, the
// two slates' gifts, the sign) and who entered it, and the server has the
// same — every profile field, the membership, the gifts, the sign, the
// volunteer request, the opt-in. Then a second form for the same person:
// the desk is offered the record already on file, picks it, and a 4-year
// renewal says it starts when the current term ends. Credit card shows the
// note and no card-number box anywhere. Nothing scrolls sideways on a phone.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4110 node server/index.js &
//   BASE=http://127.0.0.1:4110 SHOTS=/tmp/membership node e2e-membership.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-membership';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const yr = new Date().getFullYear();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(m.text()); });
const api = (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const text = async () => ((await page.innerText('main.page').catch(() => '')) || '').replace(/\s+/g, ' ');
const shot = (n, full = true) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });
const form = () => page.locator('form[aria-label="Membership form"]');
const tick = (label, scope = form()) => scope.locator('label.mf-check', { hasText: label }).first().locator('input').check();
const field = (label) => form().locator('label.field', { hasText: label }).first().locator('input');

// ── sign up; People → More → Enter a membership form ──
await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Rae Desk');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `desk.${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
await page.goto(`${BASE}/admin/people`, { waitUntil: 'domcontentloaded' });
await sleep(900);
await page.getByRole('button', { name: /More/ }).first().click();
const item = page.getByRole('menuitem', { name: 'Enter a membership form' }).or(page.getByRole('link', { name: 'Enter a membership form' }));
check('People → More offers "Enter a membership form"', await item.first().isVisible().catch(() => false));
await item.first().click();
await page.waitForURL(/\/people\/membership-form$/);
await form().waitFor();
await page.locator('text=Superstar Club').first().waitFor({ timeout: 8000 });
const t0 = await text();
check('the club amounts are this year’s limit (Superstar $2,859.40 · Star $1,429.70)', /Superstar Club \$2,859\.40/.test(t0) && /Star Club \$1,429\.70/.test(t0), t0.slice(0, 300));
check('the form’s sections, in its order', (await form().locator('legend').allInnerTexts()).join(' | ') === 'Basic information | Campus · Get involved | Languages · Interests | Membership contribution | Declaration');

// ── a full form ──
const birth = `${yr - 25}-03-04`;
await field('First name').fill('Lena');
await field('Last name').fill('Example');
await field('Gender').fill('Woman');
await field('Birth date').fill(birth);
await field('Email').fill(`lena.${tag}@example.org`);
await field('Mobile phone').fill('604-555-0142');
await field('Residential address').fill('10250 140 St');
await field('Postal code').fill('v3t 4b2');
await tick('Canadian citizen');
await tick('Union member');
await form().getByLabel('Union local').fill('BCGEU 703');
await tick('Kwantlen');
await tick('I’d like to volunteer');
await tick('A sign');
await form().getByLabel('Which sign').selectOption('window');
await tick('Punjabi');
await tick('Filipino');
await form().getByLabel('Other language').fill('Tamil');
await tick('Safer streets');
await tick('Better schools / school board issues');
await tick('1 year');
const hint = await form().locator('.mf-hint', { hasText: 'At least' }).innerText();
check('youth rate shown from the birth date (at least $5)', /At least \$5 .*aged 14 to 30/.test(hint), hint);
await form().locator('[aria-label="Give once"] label.mf-check', { hasText: 'Superstar Club' }).locator('input').check();
await tick('Credit card');
const cardNote = await text();
check('Credit card: the note says card numbers are never typed', /black out the card number/.test(cardNote));
const cardBoxes = await page.locator('input[autocomplete^="cc-"], input[aria-label*="card number" i], input[name*="card" i]').count();
check('no box for a card number, expiry or CVV', cardBoxes === 0, cardBoxes);
await tick('Cheque');
check('unsigned: it says the declaration is needed', /needs the declaration signed/.test(await text()));
await tick('Signed');
await shot('1-form-desk');
await page.getByRole('button', { name: 'Save the form' }).click();
await page.locator('.mf-done').waitFor({ timeout: 15000 });
const done = await text();
await shot('2-saved');
check('saved: their name, a youth membership for a year', /✓ Saved — Lena Example/.test(done) && /Member \(aged 14 to 30\) from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} — 1 year/.test(done), done.slice(0, 300));
check('Superstar once: $1,429.70 to each slate', /\$1,429\.70 once to the council slate/.test(done) && /\$1,429\.70 once to the school board slate/.test(done), done.slice(0, 400));
check('the window sign to put up', /A window sign to put up/.test(done));
check('office use: who entered it, and when', /Office use: entered in base\.win by Rae Desk on \d{4}-\d{2}-\d{2}/.test(done));
const lenaId = (await page.locator('.mf-done h2 a').getAttribute('href')).split('/').pop();
const fv = Object.fromEntries((await api(`/persons/${lenaId}/fields`)).json.fields.map((x) => [x.name, x.value]));
check('server: gender, birth date, citizenship, union, campus', fv.Gender === 'Woman' && fv['Birth date'] === birth && fv.Citizenship === 'Canadian citizen' && fv['Union member'] === true && fv['Union local'] === 'BCGEU 703' && fv.Campus === 'Kwantlen', JSON.stringify(fv).slice(0, 300));
check('server: languages, with Tamil kept as Other language', JSON.stringify(fv.Language) === '["Punjabi","Filipino","Other"]' && fv['Other language'] === 'Tamil', JSON.stringify([fv.Language, fv['Other language']]));
check('server: interests, and opted in', JSON.stringify(fv.Interests) === '["Safer streets","Better schools / school board issues"]' && fv['Email opt-in'] === true && fv['SMS opt-in'] === true);
const mem = (await api(`/persons/${lenaId}/membership`)).json;
check('server: a member, youth, paper', mem.member === true && mem.memberships?.[0]?.youth === true && mem.memberships?.[0]?.source === 'paper', JSON.stringify(mem).slice(0, 300));

// ── the same person again: picked from the file; a 4-year renewal ──
await page.getByRole('button', { name: 'Enter another form' }).click();
await form().waitFor();
await field('Email').fill(`LENA.${tag}@example.org`);
const offer = form().locator('.mf-match', { hasText: 'Already on file?' });
await offer.waitFor({ timeout: 8000 });
check('already on file: offered by email', /Lena Example/.test(await offer.innerText()));
await offer.getByRole('button', { name: 'That’s them' }).click();
check('picked: "Updating Lena Example’s record"', /Updating Lena Example’s record/.test(await text()));
await tick('4 years');
await form().locator('[aria-label="Give once"]').getByLabel('Give once: other amount').fill('20');
await tick('Cash');
await tick('Signed');
await page.getByRole('button', { name: 'Save the form' }).click();
await page.locator('.mf-done').waitFor({ timeout: 15000 });
const again = await text();
await shot('3-renewal');
check('same person, 4 years, starts when the current term ends', /✓ Saved — Lena Example/.test(again) && /— 4 years/.test(again) && /renewal/i.test(again), again.slice(0, 400));
check('$20 once to the council slate', /\$20 once to the council slate/.test(again));
check('renewal keeps the youth rate from the birth date on file', /Member \(aged 14 to 30\)/.test(again) && /on file: Canadian citizen/.test(again), again.slice(0, 400));
const mem2 = (await api(`/persons/${lenaId}/membership`)).json;
check('server: two terms for the one person', mem2.memberships?.length === 2, JSON.stringify(mem2).slice(0, 200));

// ── a phone ──
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole('button', { name: 'Enter another form' }).click();
await form().waitFor();
await sleep(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('on a phone: no sideways scroll', overflow <= 0, overflow);
await shot('4-phone');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
