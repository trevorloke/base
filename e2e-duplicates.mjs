// Duplicates — a fresh in-memory campaign. Two records for Ana (same email),
// one with a phone and a talk, the other with an address. People → More →
// Duplicates shows them side by side; "Keep this one" asks once, Merge makes
// one record with both histories; the old record's link says where it went;
// "Not the same" keeps a pair away. Measured at 1360 and 390.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4133 node server/index.js &
//   BASE=http://127.0.0.1:4133 SHOTS=/tmp/dupes node e2e-duplicates.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-dupes';
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
await page.fill('#su-email', `marco+${tag}@dupes.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const a1 = (await api('/actions/person.create', { name: 'Ana Example', email: 'ana@example.org', phone: '604-555-0101' })).json.person;
const a2 = (await api('/actions/person.create', { name: 'Ana Example', email: 'ANA@example.org', address: '1 Main St', city: 'Surrey' })).json.person;
await api('/actions/person.create', { name: 'Ben Example', phone: '604-555-0102' });
await api('/actions/person.create', { name: 'Ben Example', phone: '6045550102' });
await api('/actions/contact.log', { person_id: a1.id, channel: 'phone', outcome: 'contacted' });

// ── People → More → Duplicates ──
await page.goto(`${ADMIN}/people`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pp-head', { timeout: 10000 });
await page.click('.pp-head .head-actions button[aria-haspopup], .pp-head .head-actions button:has-text("More")').catch(() => {});
await page.click('a:has-text("Duplicates")', { timeout: 4000 }).catch(() => page.goto(`${ADMIN}/people/duplicates`));
await page.waitForSelector('.dup-pair', { timeout: 10000 }).catch(() => {});
check('People → Duplicates: two pairs, each said why', await page.locator('.dup-pair').count() === 2
  && /Same email/i.test(await page.innerText('.dup-list')) && /Same phone and name/i.test(await page.innerText('.dup-list')),
  await page.innerText('.dup-list').catch(() => ''));
await page.screenshot({ path: `${SHOTS}/01-duplicates.png` });

// Keep the one with the phone and the talk.
const anaPair = page.locator('.dup-pair:has-text("Same email")');
await anaPair.locator('.dup-side:has-text("604-555-0101") button:has-text("Keep this one")').click();
const ask = await anaPair.locator('.ops-confirm').innerText();
check('Keep this one asks once: "Make them one: keep Ana Example …?"', /Make them one: keep Ana Example/.test(ask), ask);
await anaPair.locator('button:has-text("Merge")').click();
await page.waitForSelector('.ops-done', { timeout: 8000 }).catch(() => {});
check('"✓ Ana Example: one record"; one pair left', /Ana Example: one record/.test(await page.innerText('.ops-done').catch(() => ''))
  && await page.locator('.dup-pair').count() === 1);
const kept = (await api(`/persons/${a1.id}`)).json;
check('the kept record: its phone, the other’s address, the talk', kept.person.phone === '604-555-0101' && kept.person.address === '1 Main St' && kept.contacts.length === 1,
  JSON.stringify([kept.person.phone, kept.person.address, kept.contacts.length]));

// The old record's link.
await page.goto(`${ADMIN}/people/${a2.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('a:has-text("Merged — open their record")', { timeout: 8000 }).catch(() => {});
await page.click('a:has-text("Merged — open their record")').catch(() => {});
await page.waitForURL(new RegExp(`/people/${a1.id}$`), { timeout: 8000 }).catch(() => {});
check('the old link: "Merged — open their record" opens Ana', page.url().endsWith(`/people/${a1.id}`), page.url());

// Not the same.
await page.goto(`${ADMIN}/people/duplicates`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dup-pair', { timeout: 8000 });
await page.click('.dup-pair button:has-text("Not the same")');
await page.waitForSelector('.ops-empty', { timeout: 8000 }).catch(() => {});
check('Not the same: "No duplicates found."', /No duplicates found/.test(await page.innerText('body')));

// At 390.
await page.setViewportSize({ width: 390, height: 844 });
await api('/actions/person.create', { name: 'Cy Example', address: '9 Oak Ave' });
await api('/actions/person.create', { name: 'Cy Example', address: '9 oak ave' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dup-pair', { timeout: 8000 }).catch(() => {});
const m = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  minTap: Math.min(...[...document.querySelectorAll('.dup-pair button')].map((b) => b.getBoundingClientRect().height)),
}));
check('at 390: no sideways scroll, buttons ≥ 44px', m.overflow <= 0 && m.minTap >= 44, JSON.stringify(m));
await page.screenshot({ path: `${SHOTS}/02-duplicates-390.png` });
check('the books verify', (await api('/audit/verify')).json?.ok === true);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
