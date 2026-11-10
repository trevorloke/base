// Settings → Services — a fresh in-memory server with no outside service
// set up. A manager opens Settings → Services: every service is listed with
// what it's for and which settings it's missing, the lead says what's
// needed to launch, Check on the database answers, Check on email says the
// key isn't set (no call goes out without one), Online payments (Stripe)
// names its two keys and the webhook address and events to give Stripe,
// and Twilio's address is listed under "Coming in"; at 390 nothing scrolls
// sideways and the Check
// buttons are 48px. A website key: made, shown once, used to send a person
// in (a volunteer lands under Requests), listed with when it was last used,
// revoked. Staff are kept out, on screen and on the server.
//
//   node e2e-services.mjs                        (starts its own server on :4121)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4121;
const SHOTS = process.env.SHOTS || '/tmp/starbase-services';
mkdirSync(SHOTS, { recursive: true });
let server = null;
let BASE = process.env.BASE;
const ADMIN = { toString() { return `${BASE}/admin`; } };
if (!BASE) {
  const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off' };
  for (const k of ['RESEND_API_KEY', 'MAIL_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'STARBASE_PUBLIC_URL', 'GOOGLE_MAPS_TILES', 'GEOCODER', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CALLHUB_API_KEY', 'CALLHUB_API_BASE']) delete env[k];
  server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30000);
    server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  BASE = `http://127.0.0.1:${PORT}`;
}
process.on('exit', () => { server?.kill(); });

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const text = async (p, sel = 'main') => ((await p.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ');

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@services.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

await page.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sv2-row', { timeout: 10000 }).catch(() => {});
const names = await page.$$eval('.sv2-list:not(.sv2-in) .sv2-name', (els) => els.map((e) => e.innerText.trim()));
check('every service listed', names.join(' | ') === 'Database | Public address | Email (Resend) | Texting and calls (Twilio) | Address lookup (BC Address Geocoder) | Map background (OpenStreetMap) | Background work | Online payments (Stripe) | Phone dialer (CallHub) | Two-step sign-in key', names.join(' | '));
// Online payments (ext/payments): not set up, its two keys, and the webhook to give Stripe.
const stripeRow = (await text(page, '.sv2-row:has(.sv2-name:text-is("Online payments (Stripe)"))')) || '';
check('Stripe: not set up, both keys named, the webhook address and its events', /Not set up/.test(stripeRow) && /STRIPE_SECRET_KEY · STRIPE_WEBHOOK_SECRET/.test(stripeRow)
  && stripeRow.includes(`${BASE}/stripe/webhook`) && /Events to send \(10\)/.test(stripeRow), stripeRow.slice(0, 300));
const lead = (await page.innerText('.sv2-lead')).trim();
check('the lead names what launch still needs (this test server runs no background jobs)', /^3 to set up before launch: Public address, Email, Background work\./.test(lead), lead);
const emailRow = '.sv2-row:has(.sv2-name:text-is("Email (Resend)"))';
check('Email: "Not set up · needed to launch", the settings it’s missing',
  /Not set up · needed to launch/.test(await text(page, emailRow)) && /RESEND_API_KEY · MAIL_FROM/.test(await text(page, emailRow)), await text(page, emailRow));
await page.tap(`${emailRow} .sv2-check`);
await page.waitForSelector(`${emailRow} .sv2-said`, { timeout: 8000 }).catch(() => {});
check('Check on Email: "✕ RESEND_API_KEY isn’t set"', (await text(page, `${emailRow} .sv2-said`)).trim() === '✕ RESEND_API_KEY isn’t set', await text(page, `${emailRow} .sv2-said`));
const dbRow = '.sv2-row:has(.sv2-name:text-is("Database"))';
await page.tap(`${dbRow} .sv2-check`);
await page.waitForSelector(`${dbRow} .sv2-said`, { timeout: 8000 }).catch(() => {});
check('Check on the database: "✓ Answering · N people on file"', /^✓ Answering · \d+ people on file$/.test((await text(page, `${dbRow} .sv2-said`)).trim()), await text(page, `${dbRow} .sv2-said`));
check('Coming in: the address to give Twilio', (await text(page, '.sv2-in')).includes(`${BASE}/api/public/twilio/sms`), await text(page, '.sv2-in'));
const m = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const taps = [...document.querySelectorAll('.sv2-check')].filter(vis).map((el) => el.getBoundingClientRect().height);
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, yellow: [...document.querySelectorAll('.btn-primary')].filter(vis).length, minTap: Math.min(...taps) };
});
check('at 390: no sideways scroll, no yellow button, Check ≥ 48px', m.overflow <= 0 && m.yellow === 0 && m.minTap >= 48, JSON.stringify(m));
await page.screenshot({ path: `${SHOTS}/01-services.png`, fullPage: true });

// Website keys: make one (shown once), the website sends a person in with it,
// "last used", Revoke stops it.
await page.fill('#sv2-key-name', 'Website');
await page.tap('.sv2-make button[type="submit"]');
await page.waitForSelector('.sv2-fresh .sv2-key', { timeout: 8000 }).catch(() => {});
const shown = ((await page.innerText('.sv2-fresh .sv2-key').catch(() => '')) || '').trim();
check('Make a key: the key, once, "copy this key now — it won’t be shown again"', /^sbk_[A-Za-z0-9]{40}$/.test(shown) && /won’t be shown again/.test(await text(page, '.sv2-fresh')), shown);
const send = await page.request.post(`${BASE}/in/v1/people`, {
  headers: { authorization: `Bearer ${shown}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-1' },
  data: { first_name: 'Asha', last_name: 'Example', email: `asha+${tag}@example.org`, newsletter: true, volunteer: true, note: 'Weekends', source: 'volunteer-form' },
});
const sent = await send.json();
check('the website sends a person in with it: the answer is only their id', send.status() === 200 && sent.ok === true && /^[0-9a-f-]{36}$/.test(sent.person_id) && Object.keys(sent).length === 2, JSON.stringify(sent));
await page.tap('.sv2-fresh button:has-text("Done")');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sv2-keys .sv2-row', { timeout: 8000 }).catch(() => {});
const row = await text(page, '.sv2-keys .sv2-row');
check('the key is listed by its first characters and "last used"', row.includes(`${shown.slice(0, 10)}…`) && /last used/.test(row) && !row.includes(shown), row);
await page.goto(`${ADMIN}/requests`, { waitUntil: 'domcontentloaded' });
await sleep(1500);
check('the volunteer is waiting under Requests, with what they wrote', /Asha Example/.test(await text(page)) && /From the website \(volunteer-form\): Weekends/.test(await text(page)), (await text(page)).slice(0, 300));
await page.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sv2-keys .sv2-row', { timeout: 8000 });
await page.tap('.sv2-keys .sv2-row button:has-text("Revoke")');
await sleep(800);
const after = await page.request.get(`${BASE}/in/v1/ping`, { headers: { authorization: `Bearer ${shown}` } });
check('Revoke: the key stops at once', after.status() === 401 && !(await page.$('.sv2-keys .sv2-row')), after.status());

// Staff: not theirs.
const inv = await ctx.request.post(`${BASE}/api/actions/member.invite`, { data: { email: `sam+${tag}@services.example`, role: 'staff' } });
const token = (await inv.json()).joinUrl.split('/join/')[1];
const sctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const sp = await sctx.newPage();
sp.on('pageerror', (e) => errors.push(`staff: ${e.message}`));
await sp.goto(`${BASE}/login`);
await sp.evaluate(async (t) => fetch('/api/auth/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t, name: 'Sam Example', password: 'services-pass-1' }) }), token);
await sp.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('staff typing Settings → Services land elsewhere', !(await sp.$('.sv2-row')) && !/\/settings\/services/.test(sp.url()), sp.url());
check('…and the server refuses them', (await sctx.request.get(`${BASE}/api/connections`)).status() === 403);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
