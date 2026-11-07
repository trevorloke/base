// Stewardship and mailouts — a fresh in-memory campaign with three gifts.
// Donations → Stewardship: one gift thanked by a call; "Write thank-you
// letters" makes a mailout to the rest; Get the list ready; the letters,
// envelopes and labels print (each its own page); Mark as mailed → the
// gifts are thanked by letter and the list is empty. Then Outreach → Mail →
// New mailout: a postcard to a list, a sample before it's ready, the
// postcards after.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4137 node server/index.js &
//   BASE=http://127.0.0.1:4137 SHOTS=/tmp/mail node e2e-mail.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-mail';
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
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const api = async (path, body) => {
  const r = body === undefined ? await dctx.request.get(`${BASE}/api${path}`) : await dctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@mail.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const yr = new Date().getFullYear();
const mk = async (first, last, extra) => (await api('/actions/person.create', { kind: 'person', first_name: first, last_name: last, city: 'Surrey', ...extra })).json.person;
const ana = await mk('Ana', 'Example', { address: '16068 83 Ave', unit: '204', postal: 'V4N 0N2', phone: '604-555-0101' });
const ben = await mk('Ben', 'Example', { address: '9 Oak Ave', postal: 'V3T 1V8' });
const cy = await mk('Cy', 'Example', { address: '12 Elm St', postal: 'V3W 1A1' });
for (const [p, cents] of [[ana, 25000], [ben, 5000], [cy, 10000]]) {
  await api('/actions/gift.log', { person_id: p.id, amount_cents: cents, date: `${yr}-03-0${cents === 5000 ? 2 : 1}`, method: 'cheque' });
}

// ── Donations → Stewardship ──
await page.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('a:has-text("Stewardship")', { timeout: 10000 });
await page.waitForSelector('a:has-text("to thank")', { timeout: 10000 }).catch(() => {});
check('Donations: "Stewardship · 3 to thank"', /Stewardship · 3 to thank/.test(await page.innerText('a:has-text("Stewardship")')));
await page.click('a:has-text("Stewardship")');
await page.waitForSelector('#sw-thank', { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/01-stewardship.png`, fullPage: true });
await page.click('.sw-row:has-text("Ben Example") button:has-text("Called")');
await page.waitForSelector('.ops-done', { timeout: 8000 }).catch(() => {});
check('Called: "✓ Ben Example — called", Ben off the list', /Ben Example — called/.test(await page.innerText('.ops-done').catch(() => '')) && !(await page.$('.sw-row:has-text("Ben Example") button:has-text("Called")')));
await page.click('button:has-text("Write thank-you letters")');
await page.waitForURL(/\/mailouts\/[0-9a-f-]{36}$/, { timeout: 8000 });
await page.waitForSelector('.ml-steps', { timeout: 8000 });
check('Write thank-you letters → a letter mailout, "Goes to 2"', /Goes to\s*2/.test(await page.innerText('.ml-step >> nth=0')), await page.innerText('.ml-step >> nth=0'));
const mailoutId = page.url().split('/').pop();

// A sample before the list is ready
const [sample] = await Promise.all([dctx.waitForEvent('page'), page.click('a:has-text("Letters — sample")')]);
await sample.waitForLoadState('domcontentloaded');
check('a sample letter before it’s ready (Sam Sample)', /Dear Sam/.test(await sample.innerText('body')));
await sample.close();

await page.click('button:has-text("Get the list ready")');
await page.waitForSelector('a.btn:has-text("Letters"):not(:has-text("sample"))', { timeout: 8000 });
check('ready: "✓ Ready: 2 to print"', /Ready: 2 to print/.test(await page.innerText('.ops-done').catch(() => '')));
const [letters] = await Promise.all([dctx.waitForEvent('page'), page.click('.ml-prints a:has-text("Letters")')]);
await letters.waitForLoadState('domcontentloaded');
const lt = await letters.innerText('body');
check('letters: Ana’s, with her gift and the Canada Post address', /Dear Ana,/.test(lt) && /\$250\.00/.test(lt) && /on March 1, \d{4}\./.test(lt) && !/Invalid Date/.test(lt) && /204-16068 83 AVE/.test(lt) && /SURREY BC\s+V4N 0N2/.test(lt), lt.slice(0, 300));
check('one page each (Ana, Cy)', (await letters.$$('section.sheet')).length === 2);
await letters.setViewportSize({ width: 1000, height: 1200 });
await letters.screenshot({ path: `${SHOTS}/02-letter.png` });
await letters.close();
const [labels] = await Promise.all([dctx.waitForEvent('page'), page.click('.ml-prints a:has-text("Address labels")')]);
await labels.waitForLoadState('domcontentloaded');
check('address labels: an Avery 5160 sheet with the two', (await labels.$$('.lab')).length === 2 && /Avery 5160/.test(await labels.innerText('.bar')));
await labels.setViewportSize({ width: 1000, height: 1200 });
await labels.screenshot({ path: `${SHOTS}/03-labels.png` });
await labels.close();
const [env] = await Promise.all([dctx.waitForEvent('page'), page.click('.ml-prints a:has-text("#10 envelopes")')]);
await env.waitForLoadState('domcontentloaded');
check('#10 envelopes: one each', (await env.$$('section.env')).length === 2);
await env.screenshot({ path: `${SHOTS}/04-envelope.png` });
await env.close();
await page.screenshot({ path: `${SHOTS}/05-mailout.png`, fullPage: true });

await page.click('button:has-text("Mark as mailed")');
await page.click('button:has-text("Yes, mailed")');
await page.waitForSelector('.ops-done:has-text("In the mail")', { timeout: 8000 }).catch(() => {});
check('mailed: "✓ In the mail · 2 gifts thanked"', /In the mail · 2 gifts thanked/.test(await page.innerText('.ops-done').catch(() => '')));
const s = (await api('/stewardship')).json;
check('stewardship: everyone thanked', s.to_thank.length === 0, JSON.stringify(s.counts));

// ── Outreach → Mail → a postcard to a list ──
const list = (await api('/actions/list.create', { name: 'Rally', kind: 'people', person_ids: [ana.id, ben.id] })).json.list;
await page.goto(`${ADMIN}/outreach/mail`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ot-tabs', { timeout: 8000 });
check('Outreach → Mail lists the thank-you letters, In the mail', /Thank-you letters/.test(await page.innerText('.ml-list')) && /In the mail/.test(await page.innerText('.ml-list')));
await page.click('button:has-text("New mailout")');
await page.fill('#ml-name', 'Rally postcard');
await page.selectOption('#ml-kind', 'postcard');
await page.selectOption('#ml-to', list.id);
await page.fill('#ml-body', 'Hi {{first_name}} — rally on Saturday at City Hall!');
await page.click('form[aria-label="New mailout"] button[type="submit"]');
await page.waitForURL(/\/mailouts\/[0-9a-f-]{36}$/, { timeout: 8000 });
await page.waitForSelector('button:has-text("Get the list ready")', { timeout: 8000 });
await page.click('button:has-text("Get the list ready")');
await page.waitForSelector('.ml-prints a:has-text("Postcards"):not(:has-text("sample"))', { timeout: 8000 });
const [cards] = await Promise.all([dctx.waitForEvent('page'), page.click('.ml-prints a:has-text("Postcards")')]);
await cards.waitForLoadState('domcontentloaded');
check('postcards: a message side and an address side each (Ana, Ben)', (await cards.$$('section.card')).length === 4 && /Hi Ana/.test(await cards.innerText('body')));
await cards.close();
check('no page errors', errors.length === 0, errors.join(' | '));
void mailoutId;

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
