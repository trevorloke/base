// Unsubscribes both ways with the campaign's own website — browser check.
// A fresh in-memory server with a stand-in for the website
// (server/test/fake-website.js) loaded into it; a manager on a laptop and on
// a 390×844 phone, every state of the row looked at on both:
//   · Settings → Services → "The website — unsubscribes": not set (both
//     settings named, no buttons); the manager makes a website key and the
//     two settings are set — "Set up", where it sends, Check says the
//     website answers and takes the key; with another key on the website,
//     Check says which setting it must equal;
//   · what was already off before the settings were set is counted, not
//     sent; one tap sends it, once;
//   · the website's backlog — three unsubscribes it made while base.win
//     had no way in, with their old times — arrives and is applied, and
//     nothing comes back to the website;
//   · a click on a newsletter's unsubscribe link and a signed text STOP
//     each reach the website once, and the website sends nothing back;
//   · the website down: the row says "1 waiting", with why and since when;
//     up again, Send again delivers it once, with the same key;
//   · a body the website refuses is counted apart, with the website's words.
// Every number on screen is checked against what the stand-in holds; the
// books verify.
// Then the same both ways three more times, each on a fresh server, with the
// settings under each spelling: both sides on the older names, both on the
// new names, and base.win on the new names with the website on the older
// ones. The older names come from the two tables (shared/old-names.js for
// base.win, apps/web/src/lib/old-names.ts for the website), never typed out;
// the stand-in reads its own settings the website's way (new name first, a
// blank one counts as not set). Each run checks that every person ends
// unsubscribed on both sides, with one row each.
//
//   npm run build  then  node e2e-consent.mjs   (PORT, SHOTS optional; the
//   stand-in listens on PORT+1 and the test's controls on PORT+2)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OLD_SETTINGS, bothNames } from './shared/old-names.js';

// The website's own table of its older setting names (the website copy in apps/web).
const { OLD_ENV } = await import('./apps/web/src/lib/old-names.ts');

const PORT = Number(process.env.PORT) || 4990;
const FAKE = PORT + 1;
const CONTROL = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${FAKE}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/base-win-consent';
mkdirSync(SHOTS, { recursive: true });
const SECRET = 'e2e-website-inbound-secret-0123456789';
const TWILIO_TOKEN = 'e2e-twilio-token';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in website and the test's controls, loaded into the server
// (they only exist in this check) ──
const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const href = (p) => JSON.stringify(pathToFileURL(`${serverDir}${p}`).href);
const STUB = `${SHOTS}/website-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
const { startFakeWebsite } = await import(${href('test/fake-website.js')});
const { _resetPaceForTest } = await import(${href('ext/intake/outbound.js')});
const { twilioSignature } = await import(${href('ext/texting/twilio.js')});
const { enqueueJob } = await import(${href('lib/jobs.js')});
const { getDb } = await import(${href('db/client.js')});
// The website's own settings, read as the website reads them (apps/web/src/lib/env.ts):
// the new name, else the older one; a blank one counts as not set.
const OLDER = ${JSON.stringify(OLD_ENV)};
let siteEnv = JSON.parse(process.env.E2E_SITE || '{}');
const siteSetting = (name) => siteEnv[name]?.trim() || siteEnv[OLDER[name]]?.trim() || undefined;
const site = await startFakeWebsite({ port: ${FAKE}, key: siteSetting('BASE_WIN_INBOUND_KEY') ?? null });
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  if (req.url === '/set') {
    for (const [k, v] of Object.entries(j.env || {})) { if (v === null) delete process.env[k]; else process.env[k] = v; }
    if ('site' in j) {
      siteEnv = { ...siteEnv, ...j.site };
      for (const [k, v] of Object.entries(j.site)) if (v === null) delete siteEnv[k];
      site.setKey(siteSetting('BASE_WIN_INBOUND_KEY') ?? null);
    }
    if ('key' in j) site.setKey(j.key);
    if ('down' in j) site.down(j.down);
    if ('fail' in j) site.fail(j.fail);
    return res.end('ok');
  }
  // A no made on the website itself waits in its outbox; Send now tries them all, as the website does.
  if (req.url === '/withdraw') { site.withdraw({ ...j, at: j.at ? new Date(j.at) : undefined }); return res.end('ok'); }
  // The website sends to the address and with the key its own settings hold.
  if (req.url === '/sendnow') return res.end(JSON.stringify(await site.sendNow({ url: siteSetting('BASE_WIN_URL'), key: siteSetting('BASE_WIN_KEY') })));
  // A job waiting its turn is tried now.
  if (req.url === '/hurry') {
    _resetPaceForTest();
    await (await getDb()).query("update jobs set run_at = now() where status = 'pending' and run_at > now() and kind like 'website.%'");
    return res.end('ok');
  }
  // A text from someone's phone, signed as Twilio signs it.
  if (req.url === '/text') {
    const fields = { From: j.from, To: '+16045550100', Body: j.body, MessageSid: 'SMe2e' + Date.now(), AccountSid: 'ACe2e' };
    const path = '/api/public/twilio/sms';
    const r = await fetch(${JSON.stringify(BASE)} + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(${JSON.stringify(TWILIO_TOKEN)}, ${JSON.stringify(BASE)} + path, new URLSearchParams(fields)) },
      body: new URLSearchParams(fields).toString(),
    });
    return res.end(String(r.status));
  }
  // Something the website will not take as it is (a reason it does not know).
  if (req.url === '/odd') {
    const db = await getDb();
    const ws = (await db.query('select id from workspaces limit 1')).rows[0].id;
    await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: [{ id: crypto.randomUUID(), channel: 'email', email: j.email, reason: 'because', at: new Date().toISOString() }], tries: 0 } });
    return res.end('ok');
  }
  if (req.url === '/state') {
    const db = await getDb();
    return res.end(JSON.stringify({
      calls: site.calls.map((x) => ({ auth: x.auth, key: x.key, raw: x.raw })), ledger: site.ledger, outbox: site.outbox,
      said: (await db.query("select payload from events where entity_type = 'website_consent' order by seq")).rows.map((r) => r.payload),
      jobs: (await db.query("select status, attempts, payload from jobs where kind = 'website.consent' order by created_at")).rows,
    }));
  }
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);

const env = { ...process.env, BASE_OPEN_SIGNUP: '1', BASE_DATA: 'memory', PORT: String(PORT), BASE_JOBS_EVERY_MS: '400', TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
  E2E_SITE: JSON.stringify({ BASE_WIN_INBOUND_KEY: SECRET }) };
for (const k of ['BASE_WEBSITE_URL', 'BASE_WEBSITE_KEY', 'BASE_PUBLIC_URL', 'BASE_OWN_URL', 'RENDER_EXTERNAL_URL', 'BASE_ENV', 'BASE_JOBS',
  'MAILCHIMP_API_KEY', 'MAIL_PROVIDER', 'RESEND_API_KEY', 'SENDGRID_API_KEY', 'MAIL_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_FROM'].flatMap(bothNames)) delete env[k];
let server = null;
let serverLog = '';
process.on('exit', () => { try { server?.kill('SIGTERM'); } catch { /* gone */ } });
// base.win with the stand-in website loaded into it; → once it answers.
const startDesk = async (e) => {
  serverLog = '';
  server = spawn(process.execPath, ['--import', pathToFileURL(STUB).href, 'server/index.js'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), env: e, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 80; i += 1) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
};
const stopDesk = () => new Promise((resolve) => {
  if (!server || server.exitCode !== null) { resolve(); return; }
  server.once('exit', () => resolve());
  server.kill('SIGTERM');
});
await startDesk(env);
const post = (path, body) => fetch(`http://127.0.0.1:${CONTROL}${path}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.text());
const set = (o) => post('/set', o);
const state = async () => JSON.parse(await post('/state'));
const hurry = () => post('/hurry');
const websiteOn = { BASE_WEBSITE_URL: SITE, BASE_WEBSITE_KEY: SECRET, BASE_PUBLIC_URL: BASE };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Sample Campaign');
await page.fill('#su-email', 'marco@consent.example.org');
await page.fill('#su-password', 'sample-campaign-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await desk.storageState() });
const phone = await phoneCtx.newPage();
phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
const SIZES = [['1440', page], ['390', phone]];

const api = async (path, body) => {
  const r = body === undefined ? await page.request.get(`${BASE}/api${path}`) : await page.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const act = (name, input) => api(`/actions/${name}`, input);
const words = async (loc) => ((await loc.innerText({ timeout: 2000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms = 12000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(200); }
  return false;
};
const shot = async (loc, name) => {
  await sleep(350);
  await loc.evaluate((el) => { if (el.getBoundingClientRect().height < window.innerHeight - 140) el.scrollIntoView({ block: 'center' }); });
  await loc.screenshot({ path: `${SHOTS}/${name}.png` });
};
// Inside `loc`: the smallest thing to tap; on the whole screen: sideways scroll and the yellow buttons.
const measure = (loc) => loc.evaluate((el) => {
  const vis = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const taps = [...el.querySelectorAll('button, a.btn')].filter(vis).map((b) => Math.round(b.getBoundingClientRect().height));
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    primary: [...el.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.innerText.trim()),
    minTap: taps.length ? Math.min(...taps) : null,
    floor: matchMedia('(min-width: 900px) and (pointer: fine)').matches ? 40 : 48,
  };
});
// Nothing sideways, nothing smaller than the look's control (a thumb on a phone), nothing yellow.
const fits = (m) => m.overflow <= 0 && (m.minTap === null || m.minTap >= m.floor) && m.primary.length === 0;

const ROW = '.sv2-row:has(.sv2-name:text-is("The website — unsubscribes"))';
const CHECK_SAID = `${ROW} > .sv2-row__main > .sv2-said`;
const openServices = async (p) => {
  await p.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
  const row = p.locator(ROW);
  await row.waitFor({ timeout: 10000 });
  await until(async () => !/Loading…/.test(await row.innerText()), 8000);
  return row;
};
const pressCheck = async (p, tap) => {
  const btn = p.locator(`${ROW} .sv2-check`);
  if (tap) await btn.tap(); else await btn.click();
  await p.locator(CHECK_SAID).waitFor({ timeout: 10000 }).catch(() => {});
  return words(p.locator(CHECK_SAID));
};
const press = async (p, tap, label) => {
  const btn = p.locator(`${ROW} .mcp button:has-text("${label}")`);
  if (tap) await btn.tap(); else await btn.click();
};

// ── People: some on the newsletter, and three who were already off before the website was connected ──
const addr = (w) => `${w.toLowerCase()}@example.org`;
const everyone = ['Ana', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'];
const people = {};
for (const [i, w] of everyone.entries()) {
  people[w] = (await act('person.create', { name: `${w} Example`, email: addr(w), phone: `604-555-01${40 + i}`, tags: ['member'] })).json.person;
  await act('subscription.add', { email: addr(w), name: `${w} Example` });
}
const subId = async (w) => (await api('/subscriptions')).json.subscriptions.find((s) => s.email === addr(w))?.id;
await act('subscription.remove', { id: await subId('Gus') });
await act('person.update', { id: people.Hal.id, tags: ['member', 'do-not-email'] });
await act('person.update', { id: people.Fay.id, tags: ['member', 'do-not-text'] });

// ── Not set ──
for (const [size, p] of SIZES) {
  const r = await openServices(p);
  const t = await words(r);
  const m = await measure(r);
  check(`not set (${size}): "Not set up", both settings named, why it matters, no buttons of its own`,
    /Not set up/.test(t) && /BASE_WEBSITE_URL · BASE_WEBSITE_KEY/.test(t) && /Not set: an unsubscribe here stays here\. The website’s own still come in with a website key\./.test(t)
      && (await r.locator('.mcp').count()) === 0 && fits(m), `${t} · ${JSON.stringify(m)}`);
  await shot(r, `01-not-set-${size}`);
}
check('Coming in names the address the website sends its unsubscribes to', (await words(page.locator('.sv2-in'))).includes(`${BASE}/in/v1/consent`));

// ── A manager makes a website key, on this screen ──
await page.fill('#sv2-key-name', 'Website');
await page.click('.sv2-make button[type="submit"]');
await page.locator('.sv2-fresh code').waitFor({ timeout: 8000 });
const KEY = (await page.locator('.sv2-fresh code').innerText()).trim();
check('a website key is made and shown once', /^sbk_[A-Za-z0-9]{40}$/.test(KEY));
// The website is given base.win's address and this key, under its new names.
await set({ site: { BASE_WIN_URL: BASE, BASE_WIN_KEY: KEY } });

// ── The two settings are set ──
await set({ env: websiteOn });
for (const [size, p] of SIZES) {
  const r = await openServices(p);
  await until(async () => /already off here/.test(await words(r)), 8000);
  const t = await words(r);
  const m = await measure(r);
  check(`set up (${size}): "Set up", where it sends, nothing waiting, and the three already off are counted — not sent`,
    /Set up/.test(t) && !/not working|waiting:/.test(t) && t.includes(`Sends each unsubscribe and text STOP to 127.0.0.1:${FAKE}`) && /Nothing is waiting\./.test(t)
      && /Send the 3 already off here/.test(t) && fits(m), `${t} · ${JSON.stringify(m)}`);
  await shot(r, `02-set-up-${size}`);
  const said = await pressCheck(p, size === '390');
  check(`Check (${size}): the website answers and takes this key`, said === '✓ The website answers and takes this key', said);
  await shot(r, `03-check-ok-${size}`);
}
let st = await state();
check('Check sent an empty body with the key and no Idempotency-Key, and nothing else was sent', st.calls.length === 2
  && st.calls.every((c) => c.raw === '{}' && c.key === null && c.auth === `Bearer ${SECRET}`) && st.ledger.length === 0, JSON.stringify(st.calls));
await set({ key: 'another-secret-on-the-website' });
for (const [size, p] of SIZES) {
  const r = await openServices(p);
  const said = await pressCheck(p, size === '390');
  const t = await words(r);
  check(`Check with another key on the website (${size}): says which setting it must equal; the badge says "not working"`,
    said === '✕ The website refused the key: it must equal the website’s inbound key setting (the one that equals this server’s website key)' && /Set up · not working/.test(t) && !t.includes(SECRET), `${said} · ${t}`);
  await shot(r, `04-check-wrong-key-${size}`);
}
await set({ key: SECRET });

// ── What was already off before the settings were set: one tap, once ──
{
  const r = await openServices(page);
  await until(async () => /Send the 3 already off here/.test(await words(r)), 8000);
  check('counted, not sent', (await state()).ledger.length === 0);
  await press(page, false, 'Send the 3 already off here');
  await until(async () => (await state()).ledger.length >= 3, 15000);
  await until(async () => /was sent/.test(await words(r)), 10000);
  const t = await words(r);
  st = await state();
  check('one tap (1440): Gus, Hal and Fay’s number go to the website, and the row says it was sent',
    JSON.stringify(st.ledger.map((x) => [x.channel, x.email || x.phone, x.reason]).sort()) === JSON.stringify([['email', addr('Gus'), 'unsubscribe'], ['email', addr('Hal'), 'unsubscribe'], ['sms', '+16045550145', 'stop']].sort())
      && /What was already off here was sent [A-Z][a-z]{2}\.? \d+, \d+:\d\d [ap]m \(3\)\./.test(t) && !/Send the 3/.test(t), `${t} · ${JSON.stringify(st.ledger)}`);
  await shot(r, '07-already-off-sent-1440');
  const r2 = await openServices(phone);
  await until(async () => /was sent/.test(await words(r2)), 8000);
  const m = await measure(r2);
  check('the same on a phone (390): sent, no button to send it twice', /What was already off here was sent/.test(await words(r2)) && (await r2.locator('.mcp button').count()) === 1 && fits(m), JSON.stringify(m));
  await shot(r2, '07-already-off-sent-390');
  check('a second ask adds nothing', (await act('intake.website.backfill', {})).json?.queued === false && (await state()).ledger.length === 3);
}

// ── (a) The website's backlog arrives: three unsubscribes it made while base.win had no way in ──
const before = (await state()).calls.length;
await post('/withdraw', { email: addr('Ana'), channel: 'email', reason: 'unsubscribe', at: '2026-09-01T17:00:00.000Z' });
await post('/withdraw', { email: 'nobody-yet@example.org', channel: 'email', reason: 'preference', at: '2026-09-14T03:20:00.000Z' });
await post('/withdraw', { phone: '+16045550141', channel: 'sms', reason: 'stop', at: '2026-10-02T21:45:00.000Z' });
const answers = JSON.parse(await post('/sendnow'));
check('the backlog: all three are taken (the website reads each answer as ok)', answers.length === 3 && answers.every((a) => a.kind === 'ok' && a.replayed === false), JSON.stringify(answers));
const subs = (await api('/subscriptions')).json.subscriptions;
const ben = (await api(`/persons/${people.Ben.id}`)).json.person;
check('applied here: Ana is off the newsletter, the unknown address is held, Ben’s number is stopped',
  subs.find((s) => s.email === addr('Ana'))?.status === 'unsubscribed' && subs.find((s) => s.email === 'nobody-yet@example.org')?.status === 'unsubscribed'
    && ben.tags.includes('do-not-text'), JSON.stringify([subs.map((s) => [s.email, s.status]), ben.tags]));
check('the desk’s Add cannot put the held address back', (await act('subscription.add', { email: 'nobody-yet@example.org' })).status === 409);
await hurry(); await sleep(1500);
st = await state();
check('nothing comes back to the website for what it said itself', st.calls.length === before && st.ledger.length === 3 && st.jobs.every((j) => j.status === 'done'),
  JSON.stringify([st.calls.length - before, st.ledger, st.jobs.length]));
check('each is on the log, with what happened — and no address', st.said.length === 3 && st.said.map((x) => x.outcome).join() === 'applied,tombstone,applied'
  && !JSON.stringify(st.said).includes('example.org'), JSON.stringify(st.said));
const again = JSON.parse(await post('/sendnow'));
check('sent rows are not sent again', again.length === 0 && (await state()).outbox.every((r) => r.status === 'sent'));

// ── (b) A click on a newsletter's unsubscribe link, and a text STOP ──
const link = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const reader = await link.newPage();
await reader.goto(`${BASE}/u/${await subId('Cal')}`);
await reader.locator('button:has-text("Unsubscribe")').tap();
await reader.locator('h1:has-text("Unsubscribed.")').waitFor({ timeout: 8000 });
await link.close();
check('a signed text STOP is taken', (await post('/text', { from: '+16045550143', body: 'STOP' })) === '200'); // Dee's number
await until(async () => (await state()).ledger.length >= 5, 10000);
st = await state();
check('the click and the STOP each reach the website once: the address or the number, the channel, the reason, the time — nothing else',
  st.ledger.length === 5 && JSON.stringify(st.ledger.slice(3).map((x) => [x.channel, x.email, x.phone, x.reason]).sort())
    === JSON.stringify([['email', addr('Cal'), null, 'unsubscribe'], ['sms', null, '+16045550143', 'stop']].sort())
    && st.calls.slice(before).every((c) => Object.keys(JSON.parse(c.raw)).every((k) => ['action', 'at', 'channel', 'email', 'phone', 'reason'].includes(k)) && !/Example|member/.test(c.raw)),
  JSON.stringify(st.ledger));
check('and the website sends nothing back for them', st.outbox.length === 3 && st.said.length === 3, JSON.stringify([st.outbox.length, st.said.length]));

// ── (c) The website is down ──
await set({ down: true });
const callsBefore = (await state()).calls.length;
await act('subscription.remove', { id: await subId('Eli') });
await until(async () => (await state()).jobs.some((j) => j.status === 'pending' && j.payload.tries >= 1), 10000);
for (const [size, p] of SIZES) {
  const r = await openServices(p);
  await until(async () => /1 waiting/.test(await words(r)), 8000);
  const t = await words(r);
  const m = await measure(r);
  check(`the website down (${size}): "1 waiting", why, and since when; the badge says so`,
    /Set up · some are waiting/.test(t) && /1 waiting: The website can’t be reached \(since [A-Z][a-z]{2}\.? \d+, \d+:\d\d [ap]m\)/.test(t) && !/Nothing is waiting/.test(t) && fits(m), `${t} · ${JSON.stringify(m)}`);
  await shot(r, `05-waiting-${size}`);
}
await set({ down: false });
{
  const r = await openServices(phone);
  await press(phone, true, 'Send again');
  await until(async () => (await state()).ledger.length >= 6, 10000);
  await until(async () => /Nothing is waiting\./.test(await words(r)), 8000);
  const t = await words(r);
  check('up again, Send again (390): it is delivered, and the row says nothing is waiting', /Sending 1 again now\./.test(t) && /Nothing is waiting\./.test(t) && !/some are waiting/.test(t), t);
  await shot(r, '06-sent-again-390');
}
st = await state();
const eli = st.calls.slice(callsBefore).filter((c) => c.raw.includes(addr('Eli')));
check('delivered once, with the same key and the same bytes as the try that failed', eli.length >= 2 && new Set(eli.map((c) => c.key)).size === 1 && new Set(eli.map((c) => c.raw)).size === 1
  && st.ledger.filter((x) => x.email === addr('Eli')).length === 1, JSON.stringify(eli));

// ── A body the website will not take ──
await post('/odd', { email: 'odd@example.org' });
await until(async () => (await state()).jobs.some((j) => (j.payload.items || []).some((x) => x.said)), 10000);
for (const [size, p] of SIZES) {
  const r = await openServices(p);
  await until(async () => /the website refused:/.test(await words(r)), 8000);
  const t = await words(r);
  const m = await measure(r);
  check(`refused (${size}): counted apart, with the website’s words`, /1 the website refused: reason: Invalid option/.test(t) && /Set up · the website refused some/.test(t) && fits(m), `${t} · ${JSON.stringify(m)}`);
  await shot(r, `08-refused-${size}`);
}

// ── Taken away ──
await set({ env: { BASE_WEBSITE_KEY: null } });
{
  const r = await openServices(page);
  const t = await words(r);
  check('one setting taken away: "Not set up", which one is missing, no buttons', /Not set up/.test(t) && /Only one of the two is set: BASE_WEBSITE_KEY is missing/.test(t) && (await r.locator('.mcp').count()) === 0, t);
  await shot(r, '09-half-set-1440');
}
const led = (await state()).ledger.length;
await act('subscription.remove', { id: await subId('Ben') });
await sleep(1200);
check('and nothing is queued or sent', (await state()).ledger.length === led && (await state()).jobs.every((j) => j.status !== 'pending' || (j.payload.items || []).every((x) => x.email !== addr('Ben'))));

check('the key is in no answer the screens read', !JSON.stringify([(await api('/connections')).json, (await api('/intake/website')).json, (await api('/events?since=0&limit=1000')).json]).includes(SECRET));
check('the books verify', (await api('/audit/verify')).json?.ok === true);

// ── The same both ways under each spelling of the settings ──
// Each setting under its new name, or its older one (from the tables, never typed).
const deskNamed = (o, older) => Object.fromEntries(Object.entries(o).map(([k, v]) => [older ? OLD_SETTINGS[k] : k, v]));
const siteNamed = (o, older) => Object.fromEntries(Object.entries(o).map(([k, v]) => [older ? OLD_ENV[k] : k, v]));
const RUN_SETTINGS = { BASE_OPEN_SIGNUP: '1', BASE_DATA: 'memory', BASE_JOBS_EVERY_MS: '400', BASE_WEBSITE_URL: SITE, BASE_WEBSITE_KEY: SECRET, BASE_PUBLIC_URL: BASE };
const RUNS = [
  ['both sides on the older names', true, true],
  ['both sides on the new names', false, false],
  ['base.win on the new names, the website on the older ones', false, true],
];
for (const [n, [label, deskOld, siteOld]] of RUNS.entries()) {
  await stopDesk();
  const runEnv = { ...env };
  for (const k of [...Object.keys(RUN_SETTINGS), 'BASE_JOBS'].flatMap(bothNames)) delete runEnv[k];
  Object.assign(runEnv, deskNamed(RUN_SETTINGS, deskOld), { E2E_SITE: JSON.stringify(siteNamed({ BASE_WIN_INBOUND_KEY: SECRET }, siteOld)) });
  check(`${label}: base.win starts`, await startDesk(runEnv), serverLog.slice(-300));
  const older = Object.keys(RUN_SETTINGS).map((k) => `the setting ${OLD_SETTINGS[k]} still works; rename it to ${k} in Render.`);
  check(`${label}: the start-up log ${deskOld ? 'names each older setting and its new name' : 'names no older setting'}, and never a value`,
    older.every((line) => serverLog.includes(line) === deskOld) && !serverLog.includes(SECRET), serverLog.slice(0, 600));

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver' });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await pg.goto(`${BASE}/signup`);
  await pg.fill('#su-name', 'Rosa Example');
  if (await pg.locator('#su-org').count()) await pg.fill('#su-org', 'Sample Campaign');
  await pg.fill('#su-email', `rosa.${n}@consent.example.org`);
  await pg.fill('#su-password', 'sample-campaign-2026');
  await pg.click('button[type="submit"]');
  await pg.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  const runApi = async (path, body) => {
    const r = body === undefined ? await pg.request.get(`${BASE}/api${path}`) : await pg.request.post(`${BASE}/api${path}`, { data: body });
    return { status: r.status(), json: await r.json().catch(() => null) };
  };
  const runAct = (name, input) => runApi(`/actions/${name}`, input);
  const made = (await runAct('intake.key.create', { name: 'Website' })).json;
  await set({ site: siteNamed({ BASE_WIN_URL: BASE, BASE_WIN_KEY: made?.key }, siteOld) });

  // Four people on the newsletter; Ana and Ben say no in base.win, Cal and Dee on the website.
  const who = {};
  for (const [i, w] of ['Ana', 'Ben', 'Cal', 'Dee'].entries()) {
    const email = `${w.toLowerCase()}.${n}@example.org`;
    const digits = `604555${String(200 + n * 10 + i).padStart(4, '0')}`;
    const person = (await runAct('person.create', { name: `${w} Example`, email, phone: digits, tags: ['member'] })).json?.person;
    await runAct('subscription.add', { email, name: `${w} Example` });
    who[w] = { id: person?.id, email, phone: `+1${digits}` };
  }
  const subsNow = async () => (await runApi('/subscriptions')).json?.subscriptions || [];
  const subOf = async (w) => (await subsNow()).find((s) => s.email === who[w].email);
  const startCalls = (await state()).calls.length;

  // base.win → the website: Ana unsubscribes here, Ben texts STOP.
  await runAct('subscription.remove', { id: (await subOf('Ana'))?.id });
  const stop = await post('/text', { from: who.Ben.phone, body: 'STOP' });
  await until(async () => { await hurry(); return (await state()).ledger.length >= 2; }, 15000);

  // The website → base.win: Cal and Dee say no on the website, and it sends them.
  await post('/withdraw', { email: who.Cal.email, channel: 'email', reason: 'unsubscribe' });
  await post('/withdraw', { phone: who.Dee.phone, channel: 'sms', reason: 'stop' });
  const sent = JSON.parse(await post('/sendnow'));
  await hurry(); await sleep(1500);

  const s = await state();
  const rowsFor = (w) => s.ledger.filter((r) => (r.email && r.email === who[w].email) || (r.phone && r.phone === who[w].phone));
  const subs = await subsNow();
  const tagsOf = async (w) => (await runApi(`/persons/${who[w].id}`)).json?.person?.tags || [];
  const offHere = subs.find((x) => x.email === who.Ana.email)?.status === 'unsubscribed' && subs.find((x) => x.email === who.Cal.email)?.status === 'unsubscribed'
    && (await tagsOf('Ben')).includes('do-not-text') && (await tagsOf('Dee')).includes('do-not-text');
  const offThere = rowsFor('Ana').length === 1 && rowsFor('Ben').length === 1
    && s.outbox.length === 2 && s.outbox.every((r) => r.status === 'sent');
  const consentCalls = s.calls.slice(startCalls).filter((c) => c.raw !== '{}');
  check(`${label}: base.win → website: Ana's email and Ben's STOP each reach the website once, with the website's key`,
    stop === '200' && rowsFor('Ana').length === 1 && rowsFor('Ben').length === 1 && consentCalls.length >= 2 && consentCalls.every((c) => c.auth === `Bearer ${SECRET}`),
    JSON.stringify([stop, s.ledger, consentCalls.map((c) => c.auth === `Bearer ${SECRET}`)]));
  check(`${label}: website → base.win: Cal's email and Dee's number are taken with the website key it holds`,
    /^sbk_/.test(made?.key || '') && sent.length === 2 && sent.every((a) => a.kind === 'ok' && a.replayed === false), JSON.stringify(sent));
  check(`${label}: every person ends unsubscribed on both sides`, offHere && offThere,
    JSON.stringify([subs.map((x) => [x.email, x.status]), s.ledger.map((r) => r.email || r.phone), s.outbox.map((r) => r.status)]));
  check(`${label}: one row each, and nothing is sent back`,
    s.ledger.length === 2 && rowsFor('Cal').length === 0 && rowsFor('Dee').length === 0 && s.said.length === 2,
    JSON.stringify([s.ledger.length, s.said.length]));
  await ctx.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await stopDesk();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
if (fails) console.log(serverLog.split('\n').slice(-15).join('\n'));
process.exit(fails ? 1 : 0);
