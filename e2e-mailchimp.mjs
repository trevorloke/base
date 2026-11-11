// Mailchimp — browser check. A fresh in-memory server with a stand-in for
// Mailchimp (server/test/fake-mailchimp.js) loaded into it; a manager on a
// laptop and on a 390×844 phone, every state looked at on both:
//   · Settings → Services → Mailchimp: not set up (its setting named, no
//     buttons); set up — Check says the one thing missing; Connect makes the
//     webhook and shows the signing secret once, with Copy; Check then says
//     unsubscribes come back here; the first pull asks first — the audience
//     and how many on file it would turn off — and "Not now" turns nobody
//     off; the first Pull now counts again ("Counting who unsubscribed in
//     Mailchimp…") and asks again, while someone who left there after the
//     first count, their webhook lost, is turned off all the same (on a
//     phone the question has the row's whole width); "Turn their email off
//     here" pulls and the row says what it found; with Mailchimp down the pull says it
//     stopped, in Mailchimp's words; an unsubscribe here that Mailchimp will
//     not take is counted as waiting, with why, and Pull now sends it again;
//     a yes whose pull counted more brings the question back, saying why;
//   · a list's page: "Send to Mailchimp" beside Download CSV only when
//     Mailchimp is on; the question before sending (how many go — the
//     newsletter's subscribers, or with one tick everyone who can be
//     emailed); "Syncing with Mailchimp · 3 to go"; "In Mailchimp · 4
//     addresses · tag …"; Sync again remembers the choice; an unsubscribe in
//     Mailchimp arrives by its webhook and the next sync takes the address
//     out of the tag; "too many" from Mailchimp reads "trying again soon"
//     and carries on by itself; a refused key reads "Stopped: … Try again";
//     a read that fails reads "Unavailable — Try again"; on a server whose
//     background work is off, both screens say "Waiting"; a sync the first
//     pull's question stopped says why, with Try again; a sync whose own
//     pull finds people who had left in Mailchimp says how many it turned
//     off here, and an address Mailchimp will not take is counted with
//     Mailchimp's words for why; the first send to another audience counts
//     first ("Counting who unsubscribed in Mailchimp…"), and with nobody on
//     file to turn off it goes by itself and opens nothing — then, once two
//     who left that audience long ago are on file (one address, two
//     people), the next send asks ("Not now" sends nothing), and the yes
//     sends.
// Every number on screen is checked against the API and against what the
// stand-in holds; the books verify.
//
//   npm run build  then  node e2e-mailchimp.mjs   (PORT, SHOTS optional; the
//   stand-in listens on PORT+1 and the test's controls on PORT+2)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 4970;
const FAKE = PORT + 1;
const CONTROL = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-mailchimp';
mkdirSync(SHOTS, { recursive: true });
const KEY = 'e2e-mailchimp-key-us19';
const SECRET = 'e2e-signing-secret-shown-once';
const TAG = 'base.win: Members';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in Mailchimp and the test's controls, loaded into the server
// (they only exist in this check) ──
const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const href = (p) => JSON.stringify(pathToFileURL(`${serverDir}${p}`).href);
const STUB = `${SHOTS}/mailchimp-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
const { startFakeMailchimp } = await import(${href('test/fake-mailchimp.js')});
const { _setSliceForTest } = await import(${href('ext/mailchimp/push.js')});
const { getDb } = await import(${href('db/client.js')});
const fake = await startFakeMailchimp({ port: ${FAKE}, apiKey: ${JSON.stringify(KEY)} });
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  if (req.url === '/set') {
    for (const [k, v] of Object.entries(j.env || {})) { if (v === null) delete process.env[k]; else process.env[k] = v; }
    if ('signing' in j) fake.signing(j.signing);
    if ('slow' in j) fake.slow(j.slow);
    if ('fail' in j) fake.fail(j.fail);
    if ('limit' in j) fake.limit(j.limit);
    if ('slice' in j) _setSliceForTest(j.slice);
    for (const a of j.audiences || []) fake.audience(a.id, a.name);
    for (const m of j.add || []) fake.add(m.email, m);
    for (const l of j.lock || []) fake.lock(l.email, l.words);
    for (const r of j.refuse || []) fake.refuse(r.email, r.words);
    if (j.dropHooks) fake.webhooks().length = 0; // someone deleted the webhook in Mailchimp
    return res.end('ok');
  }
  // A job waiting its turn to be tried again is tried now (the nightly pulls keep their night).
  if (req.url === '/hurry') {
    await (await getDb()).query("update jobs set run_at = now() where status = 'pending' and run_at > now() and key is null and kind like 'mailchimp.%'");
    return res.end('ok');
  }
  // Something happens in Mailchimp itself; its webhook says so (unless send: false).
  if (req.url === '/unsubscribe') { const r = await fake.unsubscribe(j.email, j); return res.end(JSON.stringify(r.map((x) => x.status))); }
  if (req.url === '/clean') { const r = await fake.clean(j.email, j); return res.end(JSON.stringify(r.map((x) => x.status))); }
  if (req.url === '/state') {
    return res.end(JSON.stringify({
      id: fake.id, members: fake.members(j.audienceId || fake.id).map((m) => [m.email_address, m.status, m.merge_fields]), tag: fake.tagged(j.tag, j.audienceId || fake.id),
      webhooks: fake.webhooks().map((w) => ({ url: w.url, events: w.events, sources: w.sources })),
      calls: fake.calls.map((x) => ({ method: x.method, path: x.path, query: x.query, body: x.body, key: x.key })),
    }));
  }
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);

const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS_EVERY_MS: '400' };
for (const k of ['MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE', 'MAILCHIMP_AUDIENCE_ID', 'MAILCHIMP_WEBHOOK_SECRET', 'STARBASE_PUBLIC_URL', 'STARBASE_JOBS',
  'MAIL_PROVIDER', 'RESEND_API_KEY', 'SENDGRID_API_KEY', 'MAIL_FROM']) delete env[k];
const server = spawn(process.execPath, ['--import', pathToFileURL(STUB).href, 'server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* gone */ } });
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) break;
  await sleep(250);
}
const post = (path, body) => fetch(`http://127.0.0.1:${CONTROL}${path}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.text());
const set = (o) => post('/set', o);
const mc = async (tag = TAG, audienceId = null) => JSON.parse(await post('/state', { tag, audienceId }));
const mailchimpOn = { MAILCHIMP_API_KEY: KEY, MAILCHIMP_API_BASE: `http://127.0.0.1:${FAKE}`, MAILCHIMP_AUDIENCE_ID: 'aud0001', STARBASE_PUBLIC_URL: BASE };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Sample Campaign');
await page.fill('#su-email', 'marco@mailchimp.example.org');
await page.fill('#su-password', 'sample-campaign-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await desk.storageState() });
const phone = await phoneCtx.newPage();
phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));

const api = async (path, body) => {
  const r = body === undefined ? await page.request.get(`${BASE}/api${path}`) : await page.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const act = (name, input) => api(`/actions/${name}`, input);
// What is written there now — '' when it isn't there (never a long wait for something only a reload would bring).
const words = async (loc) => ((await loc.innerText({ timeout: 2000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms = 12000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(200); }
  return false;
};
// A picture of what is there at rest: a tap's own flash has gone by then,
// and something short sits mid-screen, clear of the phone's bar of tabs.
const shot = async (loc, name) => {
  await sleep(350);
  await loc.evaluate((el) => { if (el.getBoundingClientRect().height < window.innerHeight - 140) el.scrollIntoView({ block: 'center' }); });
  await loc.screenshot({ path: `${SHOTS}/${name}.png` });
};
// Inside `loc`: the smallest thing to tap; on the whole screen: sideways scroll and the yellow buttons.
const measure = (loc) => loc.evaluate((el) => {
  const vis = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const taps = [...el.querySelectorAll('button, a.btn, input[type="checkbox"]')].filter(vis)
    .map((b) => Math.round((b.matches('input') ? b.closest('label') : b).getBoundingClientRect().height));
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    primary: [...document.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.innerText.trim()),
    minTap: taps.length ? Math.min(...taps) : null,
  };
});
// At 390: nothing sideways, nothing smaller than a thumb.
const fits = (m) => m.overflow <= 0 && (m.minTap === null || m.minTap >= 48);

// ── People, the newsletter and a list ──
const addr = (w) => `${w.toLowerCase()}@example.org`;
const everyone = ['Ana', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'];
for (const w of everyone) await act('person.create', { name: `${w} Example`, email: addr(w), phone: '604-555-0142', address: '123 Example Street', tags: ['member', 'vip-donor'] });
for (const w of everyone.slice(0, 6)) await act('subscription.add', { email: addr(w), name: `${w} Example` });
const list = (await act('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member' } })).json.list;
const LIST = `${ADMIN}/lists/${list.id}`;

const ROW = '.sv2-row:has(.sv2-name:text-is("Mailchimp"))';
const CHECK_SAID = `${ROW} > .sv2-row__main > .sv2-said`;
const openServices = async (p) => {
  await p.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
  const row = p.locator(ROW);
  await row.waitFor({ timeout: 10000 });
  await until(async () => !/Loading…/.test(await row.innerText()), 8000);
  return row;
};
const openList = async (p) => {
  await p.goto(LIST, { waitUntil: 'domcontentloaded' });
  await p.locator('.ls-tools').waitFor({ timeout: 10000 });
  await sleep(700);
  return p.locator('.ls-page');
};
// Check on the Mailchimp row: tapped, and what it then says.
const pressCheck = async (p, tap = false) => {
  const btn = p.locator(`${ROW} .sv2-check`);
  if (tap) await btn.tap(); else await btn.click();
  await p.locator(CHECK_SAID).waitFor({ timeout: 10000 }).catch(() => {});
  return words(p.locator(CHECK_SAID));
};

// ── 1. Mailchimp is not set up ──
let row = await openServices(page);
let w = await words(row);
check('not set up: the row names its setting, and has no Connect or Pull now', /^Mailchimp Not set up A list becomes a tag in your Mailchimp audience; unsubscribes and dead addresses come back/.test(w)
  && /Set in the hosting’s environment: MAILCHIMP_API_KEY/.test(w) && !/Connect|Pull now/.test(w), w);
await shot(row, '01-not-set-up-1440');
let prow = await openServices(phone);
let pm = await measure(phone.locator(ROW));
check('at 390: the same row — no sideways scroll, Check ≥ 48px', fits(pm) && /Set in the hosting’s environment: MAILCHIMP_API_KEY/.test(await words(prow)) && !/Connect|Pull now/.test(await words(prow)), JSON.stringify(pm));
await shot(prow, '01-not-set-up-390');
let lp = await openList(page);
check('…and a list’s page has no "Send to Mailchimp"', !/Mailchimp/.test(await words(lp)) && /Download CSV/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));

// ── 2. Set up: the row, and Check naming the one thing missing ──
// In Mailchimp from before base.win was connected to it: Fay left long ago, and Eli's address died there.
const longAgo = new Date(Date.now() - 300 * 86400e3).toISOString();
await set({ env: mailchimpOn, add: [{ email: 'older@example.org' }, { email: 'reader@example.org' },
  { email: addr('Fay'), status: 'unsubscribed', changed: longAgo }, { email: addr('Eli'), status: 'cleaned', changed: longAgo }] });
row = await openServices(page);
w = await words(row);
let m = await measure(page.locator(ROW));
check('set up: "Set up", the honest line, Connect and Pull now, "Not pulled yet"', /^Mailchimp Set up /.test(w) && /Press Check before relying on it: it tries your own Mailchimp account\./.test(w)
  && /Connect Pull now Connect tells Mailchimp to send unsubscribes here\. Pull now reads them at once\. Not pulled yet/.test(w), w);
check('…no yellow button on the screen, every button ≥ 48px', m.primary.length === 0 && m.minTap >= 48, JSON.stringify(m));
const NOT_CONNECTED = '✕ The key works · audience “Sample Campaign” · 2 subscribed — but Mailchimp isn’t sending unsubscribes here yet: tap Connect';
let said = await pressCheck(page);
check('Check: the key, the audience, how many are subscribed — and the one thing missing', said === NOT_CONNECTED, said);
await shot(row, '02-check-not-connected-1440');
prow = await openServices(phone);
said = await pressCheck(phone, true);
pm = await measure(phone.locator(ROW));
check('at 390: Check says the same; no sideways scroll, every button ≥ 48px, no yellow button', said === NOT_CONNECTED && fits(pm) && pm.primary.length === 0, `${said} · ${JSON.stringify(pm)}`);
await shot(prow, '02-check-not-connected-390');

// ── 3. Connect: the webhook is made; the signing secret is shown once ──
await set({ signing: SECRET });
await page.locator(`${ROW} button:has-text("Connect")`).click();
await page.locator(`${ROW} .mcp .sv2-said`).waitFor({ timeout: 10000 }).catch(() => {});
w = await words(row);
check('Connect: "✓ Mailchimp now sends unsubscribes and dead addresses here", announced', (await words(page.locator(`${ROW} .mcp .sv2-said[role="status"]`))) === '✓ Mailchimp now sends unsubscribes and dead addresses here', w.slice(0, 300));
const SHOWN_ONCE = `Copy this signing secret now — it won’t be shown again. ${SECRET} Set MAILCHIMP_WEBHOOK_SECRET to it in the hosting’s environment.`;
check('…the signing secret shown once, with where it goes', w.includes(SHOWN_ONCE), w.slice(200, 600));
check('…and what Check said before is gone (it is no longer true)', (await page.locator(CHECK_SAID).count()) === 0);
await page.locator(`${ROW} .sv2-fresh button:has-text("Copy")`).click();
const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard: ${e.message}`);
check('Copy puts the secret on the clipboard', copied === SECRET, copied);
// Connect also counts what the first pull would do here — and asks before doing it, saying when it counted
// ("Counted 3:42 p.m.", or "Counted Nov 10, 11:59 p.m." once midnight has passed since).
const COUNTED = String.raw`Counted (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d\d [ap]\.m\.`;
const FIRST_Q = new RegExp(`^Audience ‘Sample Campaign’ · 1 person here unsubscribed there · 1 dead address Only they can turn their email back on\\. ${COUNTED} Turn their email off here Not now$`);
const askedOnConnect = await until(async () => FIRST_Q.test(await words(page.locator(`${ROW} .fp`))), 15000);
check('Connect counts what the first pull would turn off here, and asks: "Audience ‘Sample Campaign’ · 1 person here unsubscribed there · 1 dead address"', askedOnConnect
  && (await page.locator(`${ROW} .fp [role="status"]`).count()) === 1, await words(page.locator(`${ROW} .mcp`)));
await shot(row, '03-connected-secret-1440');
let st = await mc();
check('Mailchimp was told: unsubscribe, cleaned and address changes — never base.win’s own changes', st.webhooks.length === 1 && st.webhooks[0].url.startsWith(`${BASE}/hooks/mailchimp/`)
  && JSON.stringify(st.webhooks[0].events) === JSON.stringify({ subscribe: false, unsubscribe: true, profile: false, cleaned: true, upemail: true, campaign: false })
  && JSON.stringify(st.webhooks[0].sources) === JSON.stringify({ user: true, admin: true, api: false }), JSON.stringify(st.webhooks));
check('the webhook’s address is nowhere on the page', !(await page.content()).includes(st.webhooks[0].url.split('/').pop()));
await page.locator(`${ROW} .sv2-fresh button:has-text("Done")`).click();
check('Done: the secret is gone from the page', !(await page.content()).includes(SECRET));
// Someone deletes the webhook in Mailchimp (the way to a new secret): Connect, on the phone, makes it again.
await set({ dropHooks: true });
prow = await openServices(phone);
await phone.locator(`${ROW} button:has-text("Connect")`).tap();
await phone.locator(`${ROW} .sv2-fresh`).waitFor({ timeout: 10000 }).catch(() => {});
pm = await measure(phone.locator(ROW));
st = await mc();
check('at 390: Connect again after the webhook was deleted there — made again, its secret shown once more; Copy and Done ≥ 48px, no sideways scroll', (await words(prow)).includes(SHOWN_ONCE)
  && st.webhooks.length === 1 && fits(pm) && pm.primary.length === 0, JSON.stringify(pm));
await shot(prow, '03-connected-secret-390');
await phone.locator(`${ROW} .sv2-fresh button:has-text("Done")`).tap();
await set({ env: { MAILCHIMP_WEBHOOK_SECRET: SECRET } });
const CONNECTED = '✓ The key works · audience “Sample Campaign” · 2 subscribed · unsubscribes come back here';
said = await pressCheck(page);
check('Check now: "✓ … · unsubscribes come back here"', said === CONNECTED, said);
await shot(row, '03-check-connected-1440');
said = await pressCheck(phone, true);
pm = await measure(phone.locator(ROW));
check('at 390: the row — Check says the same; no sideways scroll, every button ≥ 48px, no yellow button', said === CONNECTED && fits(pm) && pm.primary.length === 0, `${said} · ${JSON.stringify(pm)}`);
await shot(prow, '03-check-connected-390');
// The whole screen, to look at the row among the others.
await phone.screenshot({ path: `${SHOTS}/03-services-page-390.png`, fullPage: true });
await page.screenshot({ path: `${SHOTS}/03-services-page-1440.png`, fullPage: true });

// ── 4. The first pull asks first: Not now turns nobody off; the first Pull now asks again; the yes pulls ──
row = await openServices(page);
m = await measure(page.locator(ROW));
check('the question stays on the row until someone answers it — no yellow button, every button ≥ 48px', FIRST_Q.test(await words(page.locator(`${ROW} .fp`)))
  && m.primary.length === 0 && m.minTap >= 48, JSON.stringify(m));
await shot(row, '04-first-ask-1440');
// Not now, by keyboard.
await page.locator(`${ROW} .fp button:has-text("Not now")`).focus();
await page.keyboard.press('Enter');
let subs = (await api('/subscriptions')).json;
check('Not now: the question is put away, nobody is turned off, the line still "Not pulled yet"', (await page.locator(`${ROW} .fp`).count()) === 0
  && subs.subscriptions.find((x) => x.email === addr('Fay'))?.status === 'subscribed' && subs.emailable === 6
  && (await words(page.locator(`${ROW} .mcp-pull`))) === 'Not pulled yet', `${subs.emailable} · ${await words(page.locator(`${ROW} .mcp-pull`))}`);
// Kai (on file, on no list, not on the newsletter) unsubscribes in Mailchimp after it was first counted, and
// the webhook never arrives: that no is new, and the next pull takes it in — yes or no.
const kai = (await act('person.create', { name: 'Kai Example', email: addr('Kai') })).json.person.id;
await set({ add: [{ email: addr('Kai') }] });
await post('/unsubscribe', { email: addr('Kai'), send: false });
// The first Pull now (on the phone): counted again — in the words a list's Send uses — and the same
// question; of what it asks about, nothing is done yet.
prow = await openServices(phone);
await set({ slow: 1500 }); // the count, held long enough to be seen
await phone.locator(`${ROW} button:has-text("Pull now")`).tap();
const COUNTING = 'Counting who unsubscribed in Mailchimp…';
const sawRowCounting = await until(async () => (await words(phone.locator(`${ROW} .mcp-pull[role="status"]`))) === COUNTING, 10000);
const countingButton = await words(phone.locator(`${ROW} .mcp-acts button`).nth(1));
await set({ slow: 0 });
check(`the first Pull now (on the phone) counts first: "${COUNTING}", announced — as a list's Send says it — and the button reads "Counting…"`, sawRowCounting
  && countingButton === 'Counting…', `${await words(phone.locator(`${ROW} .mcp`))} · ${countingButton}`);
const askedOnPull = await until(async () => FIRST_Q.test(await words(phone.locator(`${ROW} .fp`))), 15000);
pm = await measure(phone.locator(ROW));
subs = (await api('/subscriptions')).json;
check('the first Pull now (on the phone): the same question — no sideways scroll, every button ≥ 48px, no yellow button; still nobody turned off', askedOnPull
  && fits(pm) && pm.primary.length === 0 && subs.emailable === 6, `${await words(phone.locator(`${ROW} .mcp`))} · ${JSON.stringify(pm)}`);
const kaiOff = JSON.stringify((await api(`/persons/${kai}`)).json?.person?.tags || []).includes('do-not-email');
const kaiLine = await words(phone.locator(`${ROW} .mcp-pull`));
check('…but Kai’s no is new: it was taken in all the same — "Last pulled … · 1 unsubscribed" under the question, and Kai is do-not-email', kaiOff
  && /^Last pulled \d{1,2}:\d\d [ap]\.?m\.? · 1 unsubscribed$/.test(kaiLine), `${kaiLine} · ${kaiOff}`);
// At 390 the question has the row's whole width; Check stays beside the name.
const lay = await phone.locator(ROW).evaluate((row) => {
  const at = (q) => row.querySelector(q)?.getBoundingClientRect();
  const r = row.getBoundingClientRect(); const fp = at('.fp'); const check = at('.sv2-check'); const name = at('.sv2-name');
  return { row: Math.round(r.width), fp: Math.round(fp?.width ?? 0), checkBesideName: check.left >= name.right && check.top < fp.top };
});
check('at 390 the question takes the row’s whole width, and Check stays beside the name', lay.fp >= lay.row - 1 && lay.checkBesideName, JSON.stringify(lay));
await shot(prow, '04-first-ask-390');
row = await openServices(page);
check('at 1440 the same: the question, and under it "Last pulled … · 1 unsubscribed"', FIRST_Q.test(await words(page.locator(`${ROW} .fp`)))
  && (await words(page.locator(`${ROW} .mcp-pull`))) === kaiLine, await words(page.locator(`${ROW} .mcp`)));
await shot(row, '04-first-ask-new-no-1440');
// The yes, by tap.
await phone.locator(`${ROW} .fp button:has-text("Turn their email off here")`).tap();
const pulled = await until(async () => / · 1 unsubscribed · 1 dead address$/.test(await words(phone.locator(`${ROW} .mcp-pull`))));
let pw = await words(phone.locator(`${ROW} .mcp-pull`));
check('Turn their email off here (on the phone): "Last pulled … · 1 unsubscribed · 1 dead address", and the question is gone', pulled
  && /^Last pulled \d{1,2}:\d\d [ap]\.?m\.? · 1 unsubscribed · 1 dead address$/.test(pw) && (await phone.locator(`${ROW} .fp`).count()) === 0, pw);
const yes = ((await api('/events?since=0&limit=1000')).json?.events || []).filter((e) => e.entity_type === 'mailchimp' && e.payload?.first_pull);
const said1 = yes[0]?.payload || {};
check('…the yes is on the log: who gave it, for which audience, and what they were shown', yes.length === 1 && Boolean(yes[0].actor_id)
  && [said1.first_pull, said1.audience, said1.name, said1.unsubscribed, said1.cleaned].join('|') === 'yes|aud0001|Sample Campaign|1|1', JSON.stringify(yes.map((e) => e.payload)));
subs = (await api('/subscriptions')).json;
check('…Fay is off the newsletter here, Eli’s address can’t be emailed — as the API has it', subs.subscriptions.find((s) => s.email === addr('Fay'))?.status === 'unsubscribed'
  && subs.subscriptions.find((s) => s.email === addr('Eli'))?.can_email === false && subs.emailable === 4, `${subs.subscribed}/${subs.emailable}`);
await shot(prow, '04-pulled-390');
row = await openServices(page);
await shot(row, '04-pulled-1440');
// Mailchimp is down: the pull says it stopped, in Mailchimp's words — never "nothing new".
await set({ fail: 500 });
await page.locator(`${ROW} button:has-text("Pull now")`).click();
const PULL_STOPPED = 'The last pull stopped: Mailchimp said: An unexpected internal error has occurred.';
const stoppedPull = await until(async () => (await words(page.locator(`${ROW} .mcp-pull`))) === PULL_STOPPED, 15000);
check('Mailchimp down: "The last pull stopped: Mailchimp said: …", said as a problem', stoppedPull && (await page.locator(`${ROW} .mcp-pull.is-stopped`).count()) === 1, await words(page.locator(`${ROW} .mcp-pull`)));
await shot(row, '04-pull-stopped-1440');
prow = await openServices(phone);
pm = await measure(phone.locator(ROW));
check('at 390: the same line, wrapped — no sideways scroll', (await words(phone.locator(`${ROW} .mcp-pull`))) === PULL_STOPPED && fits(pm), JSON.stringify(pm));
await shot(prow, '04-pull-stopped-390');
// Mailchimp is back: the job runner's next try (brought forward here) puts the line right.
await set({ fail: false });
await post('/hurry');
const pulledAgain = await until(async () => { row = await openServices(page); return /^Last pulled .* · Nothing new$/.test(await words(page.locator(`${ROW} .mcp-pull`))); }, 15000);
check('…and once Mailchimp answers, the next try by itself: "Last pulled … · Nothing new"', pulledAgain, await words(page.locator(`${ROW} .mcp-pull`)));

// ── 5. A list's page: Send to Mailchimp ──
lp = await openList(page);
let tools = await words(page.locator('.ls-tools'));
m = await measure(page.locator('.ls-tools'));
check('the list’s page: "Send to Mailchimp" beside Download CSV; the page’s one yellow button is still Email this list', /^Download CSV Send to Mailchimp Edit the filter Delete$/.test(tools)
  && m.primary.join('|') === 'Email this list', `${tools} · ${JSON.stringify(m.primary)}`);
await shot(lp, '05-list-before-1440');
let plp = await openList(phone);
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the button is there too — no sideways scroll, every button ≥ 48px, one yellow button', /Send to Mailchimp/.test(await words(phone.locator('.ls-tools'))) && fits(pm) && pm.primary.join('|') === 'Email this list', JSON.stringify(pm));
await shot(plp, '05-list-before-390');
// By keyboard: Enter opens the question.
await page.locator('.ls-tools button:has-text("Send to Mailchimp")').focus();
await page.keyboard.press('Enter');
await page.locator('.mc-ask .ops-check').waitFor({ timeout: 10000 }).catch(() => {});
let ask = await words(page.locator('.mc-ask'));
const QUESTION = '4 addresses to send · newsletter subscribers only Everyone on this list who can be emailed (6); they agreed to hear from us by email Only email, first and last name go. Nobody already in your audience is changed. Anyone who unsubscribed in Mailchimp is turned off here too — only they can rejoin. Send to Mailchimp Cancel';
check('the question: "4 addresses to send · newsletter subscribers only", the tick with how many it would be, what goes — and what the sync does here', ask.startsWith(QUESTION), ask);
const counts = (await api(`/lists/${list.id}/mailchimp?counts=1`)).json.counts;
check('…the numbers the API counted', counts.subscribed === 4 && counts.everyone === 6, JSON.stringify(counts));
await shot(lp, '05-list-ask-1440');
await phone.locator('.ls-tools button:has-text("Send to Mailchimp")').tap();
await phone.locator('.mc-ask .ops-check').waitFor({ timeout: 10000 }).catch(() => {});
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the same question — the tick a 48px row, Send to Mailchimp and Cancel ≥ 48px, no sideways scroll', (await words(phone.locator('.mc-ask'))).startsWith(QUESTION) && fits(pm), JSON.stringify(pm));
await shot(plp, '05-list-ask-390');
await phone.locator('.mc-ask button:has-text("Cancel")').tap();
check('Cancel (on the phone): the question is away, nothing was sent', (await phone.locator('.mc-ask').count()) === 0 && (await mc()).tag === null);
// The tick, by keyboard (Space), then back.
await page.locator('.mc-ask input[type="checkbox"]').focus();
await page.keyboard.press('Space');
check('the tick widens it: "6 addresses to send", announced', (await words(page.locator('.mc-ask .mc-line[role="status"]'))) === '6 addresses to send', await words(page.locator('.mc-ask .mc-line')));
await page.keyboard.press('Space');
// Send: watched while it works (the stand-in is slowed, one address to a call).
await set({ slow: 350, slice: { ms: 0, chunk: 1 } });
await page.locator('.mc-ask button:has-text("Send")').click();
const syncing = await until(async () => /Syncing with Mailchimp · \d+ to go/.test(await words(page.locator('.mc-status'))), 20000);
check('Send: "Syncing with Mailchimp · … to go", announced; the button is away while it works', syncing && (await page.locator('.mc-status [role="status"][aria-live="polite"]').count()) === 1
  && !/Sync again|Send to Mailchimp/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));
await shot(lp, '06-list-syncing-1440');
await set({ slow: 2500 }); // held there while the phone looks
plp = await openList(phone);
const psyncing = await until(async () => /Syncing with Mailchimp · \d+ to go/.test(await words(phone.locator('.mc-status'))), 15000);
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the same line while it works, and no button to send it twice — no sideways scroll', psyncing && !/Sync again|Send to Mailchimp/.test(await words(phone.locator('.ls-tools'))) && fits(pm), `${await words(phone.locator('.ls-tools'))} · ${JSON.stringify(pm)}`);
await shot(plp, '06-list-syncing-390');
await set({ slow: 0, slice: null });
const done = await until(async () => /In Mailchimp/.test(await words(page.locator('.mc-status'))), 40000);
let status = await words(page.locator('.mc-status'));
check('done: "In Mailchimp · 4 addresses · tag “base.win: Members”", and the detail line', done && /^In Mailchimp · 4 addresses · tag “base\.win: Members” Synced \d{1,2}:\d\d [ap]\.?m\.? · newsletter subscribers only · 4 new to your audience · sent by Marco Example$/.test(status), status);
check('…the button now reads "Sync again"', /^Download CSV Sync again In Mailchimp/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));
st = await mc();
const sync = (await api(`/lists/${list.id}/mailchimp`)).json.sync;
check('…what Mailchimp holds: the four subscribed, by first and last name, in the tag', JSON.stringify(st.tag) === JSON.stringify(['Ana', 'Ben', 'Cal', 'Dee'].map(addr))
  && st.members.some(([e, s, f]) => e === addr('Ana') && s === 'subscribed' && f.FNAME === 'Ana' && f.LNAME === 'Example') && sync.total === 4 && sync.added === 4 && sync.tagged === 4, JSON.stringify([st.tag, sync]));
// Only what was said to Mailchimp (each call's body and query), and whole values: a call's key and a
// member's address in a path are random-looking hex, where three digits in a row mean nothing.
const saidToMailchimp = JSON.stringify(st.calls.map((c) => [c.query, c.body]));
check('…and nothing else left base.win: no phone, no street, no tag', st.calls.length > 5 && !/555-0142|5550142|Example Street|vip-donor|"member"/.test(saidToMailchimp));
await shot(lp, '07-list-synced-1440');

// ── 6. The phone: the same line; Sync again remembers the choice ──
plp = await openList(phone);
await phone.locator('.mc-status').waitFor({ timeout: 10000 }).catch(() => {});
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the line is there — no sideways scroll, every button ≥ 48px, one yellow button', /^In Mailchimp · 4 addresses/.test(await words(phone.locator('.mc-status'))) && fits(pm) && pm.primary.join('|') === 'Email this list', JSON.stringify(pm));
await shot(plp, '07-list-synced-390');
await phone.locator('.ls-tools button:has-text("Sync again")').tap();
await phone.locator('.mc-ask .ops-check').waitFor({ timeout: 10000 }).catch(() => {});
await phone.locator('.mc-ask .ops-check').tap();
pm = await measure(phone.locator('.ls-tools'));
check('Sync again (on the phone): the question, the tick a 48px row; ticked: "6 addresses to send"', (await words(phone.locator('.mc-ask .mc-line[role="status"]'))) === '6 addresses to send' && fits(pm), JSON.stringify(pm));
await shot(plp, '08-list-ask-ticked-390');
await phone.locator('.mc-ask button:has-text("Send")').tap();
await until(async () => /In Mailchimp · 6 addresses/.test(await words(phone.locator('.mc-status'))), 20000);
status = await words(phone.locator('.mc-status'));
check('everyone who can be emailed: "In Mailchimp · 6 addresses … everyone who can be emailed · 2 new to your audience"', /^In Mailchimp · 6 addresses · tag “base\.win: Members” Synced [^·]+ · everyone who can be emailed · 2 new to your audience · sent by Marco Example$/.test(status), status);
await phone.locator('.ls-tools button:has-text("Sync again")').tap();
await phone.locator('.mc-ask .ops-check').waitFor({ timeout: 10000 }).catch(() => {});
check('…and the next Sync again opens with that choice kept (6, ticked)', (await phone.locator('.mc-ask input[type="checkbox"]').isChecked()) && (await words(phone.locator('.mc-ask .mc-line[role="status"]'))) === '6 addresses to send');
await phone.locator('.mc-ask button:has-text("Cancel")').tap();

// ── 7. Someone unsubscribes in Mailchimp: its webhook says so, base.win reads the record itself ──
const hooks = JSON.parse(await post('/unsubscribe', { email: addr('Ana') }));
check('Mailchimp’s signed webhook is taken (200)', hooks.join(',') === '200', hooks.join(','));
const off = await until(async () => (await api('/subscriptions')).json.subscriptions.find((s) => s.email === addr('Ana'))?.status === 'unsubscribed');
check('Ana is off the newsletter here within moments', off);
lp = await openList(page);
await page.locator('.ls-tools button:has-text("Sync again")').click();
await page.locator('.mc-ask .ops-check').waitFor({ timeout: 10000 }).catch(() => {});
check('the next question counts one fewer', (await words(page.locator('.mc-ask .mc-line[role="status"]'))) === '5 addresses to send', await words(page.locator('.mc-ask .mc-line')));
await page.locator('.mc-ask button:has-text("Send")').click();
await until(async () => /In Mailchimp · 5 addresses/.test(await words(page.locator('.mc-status'))), 20000);
status = await words(page.locator('.mc-status'));
st = await mc();
check('…and the sync takes her out of the tag; she stays unsubscribed in Mailchimp', /1 taken out of the tag/.test(status) && !st.tag.includes(addr('Ana'))
  && st.members.find(([e]) => e === addr('Ana'))?.[1] === 'unsubscribed', `${status} · ${JSON.stringify(st.tag)}`);
await shot(lp, '09-list-after-unsubscribe-1440');

// ── 8. Mailchimp says "too many": it waits and carries on by itself ──
await act('person.create', { name: 'Ida Example', email: addr('Ida'), tags: ['member'] });
await set({ limit: { after: 0, times: 1 } });
lp = await openList(page);
await page.locator('.ls-tools button:has-text("Sync again")').click();
await until(async () => (await words(page.locator('.mc-ask .mc-line[role="status"]'))) === '6 addresses to send', 8000);
await page.locator('.mc-ask button:has-text("Send")').click();
const TRYING = 'Syncing with Mailchimp · trying again soon (Mailchimp said: You have exceeded the limit of 10 simultaneous connections.)';
const trying = await until(async () => (await words(page.locator('.mc-status'))) === TRYING, 15000);
check('"too many": "Syncing with Mailchimp · trying again soon (Mailchimp said: …)" — nothing to tap, it carries on by itself', trying
  && !/Sync again|Try again|Send to Mailchimp/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));
await shot(lp, '10-list-trying-again-1440');
plp = await openList(phone);
await phone.locator('.mc-status').waitFor({ timeout: 10000 }).catch(() => {});
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the same line, wrapped — no sideways scroll', (await words(phone.locator('.mc-status'))) === TRYING && fits(pm), `${await words(phone.locator('.mc-status'))} · ${JSON.stringify(pm)}`);
await shot(plp, '10-list-trying-again-390');
await post('/hurry'); // the job runner's next try, a minute on, brought forward
const carried = await until(async () => /^In Mailchimp · 6 addresses/.test(await words(page.locator('.mc-status'))), 20000);
status = await words(page.locator('.mc-status'));
check('…and it does: "In Mailchimp · 6 addresses … 1 new to your audience"', carried && /· 1 new to your audience ·/.test(status), status);

// ── 9. Mailchimp refuses the key: "Stopped", in its words, with Try again ──
await set({ env: { MAILCHIMP_API_KEY: `wrong-${KEY}` } });
plp = await openList(phone);
await phone.locator('.ls-tools button:has-text("Sync again")').tap();
await phone.locator('.mc-ask button:has-text("Send")').waitFor({ timeout: 10000 }).catch(() => {});
await until(async () => !(await phone.locator('.mc-ask button:has-text("Send")').isDisabled()), 8000);
await phone.locator('.mc-ask button:has-text("Send")').tap();
const STOPPED = 'Stopped: Mailchimp refused the key — copy the whole key, with its ending (like -us19) Try again';
// The whole line: the sync stops within moments of the tap, while the tap's own button may still read "Starting…".
const stoppedOk = await until(async () => (await words(phone.locator('.mc-status'))) === STOPPED, 20000);
status = await words(phone.locator('.mc-status'));
pm = await measure(phone.locator('.ls-tools'));
check('a refused key: "Stopped: Mailchimp refused the key — …" and Try again; never the key itself', stoppedOk && status === STOPPED
  && !(await phone.content()).includes(KEY) && fits(pm), `${status} · ${JSON.stringify(pm)}`);
await shot(plp, '11-list-stopped-390');
lp = await openList(page);
await page.locator('.mc-status button:has-text("Try again")').waitFor({ timeout: 10000 }).catch(() => {});
m = await measure(page.locator('.ls-tools'));
check('at 1440: the same — Sync again stays, Try again beside the words; the one yellow button is still Email this list', (await words(page.locator('.mc-status'))) === STOPPED
  && /^Download CSV Sync again Stopped: /.test(await words(page.locator('.ls-tools'))) && m.primary.join('|') === 'Email this list', await words(page.locator('.ls-tools')));
await shot(lp, '11-list-stopped-1440');
await set({ env: { MAILCHIMP_API_KEY: KEY } });
await phone.locator('.mc-status button:has-text("Try again")').tap();
const back = await until(async () => /^In Mailchimp · 6 addresses/.test(await words(phone.locator('.mc-status'))), 20000);
check('Try again, the key put right: "In Mailchimp · 6 addresses" again', back, await words(phone.locator('.mc-status')));

// ── 10. The list's own read fails: "Unavailable — Try again", never a missing block ──
const READ = '**/api/lists/*/mailchimp*';
const broken = (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"not now"}' });
await page.route(READ, broken);
lp = await openList(page);
const unavailable = await until(async () => (await words(page.locator('.mc'))) === 'Mailchimp: Unavailable — Try again', 10000);
m = await measure(page.locator('.ls-tools'));
check('the read fails: "Mailchimp: Unavailable — Try again" — said, and no button that could not work', unavailable && !/Sync again|Send to Mailchimp/.test(await words(page.locator('.ls-tools'))) && m.minTap >= 48, `${await words(page.locator('.ls-tools'))} · ${JSON.stringify(m)}`);
await shot(lp, '12-list-unavailable-1440');
await phone.route(READ, broken);
plp = await openList(phone);
await until(async () => (await words(phone.locator('.mc'))) === 'Mailchimp: Unavailable — Try again', 10000);
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the same — Try again ≥ 48px, no sideways scroll', (await words(phone.locator('.mc'))) === 'Mailchimp: Unavailable — Try again' && fits(pm), JSON.stringify(pm));
await shot(plp, '12-list-unavailable-390');
await phone.unroute(READ);
await page.unroute(READ);
await page.locator('.mc .mc-retry').focus();
await page.keyboard.press('Enter');
const again = await until(async () => /^In Mailchimp · 6 addresses/.test(await words(page.locator('.mc-status'))), 10000);
check('Try again (by keyboard): the line is back, and Sync again with it', again && /^Download CSV Sync again In Mailchimp/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));

// ── 11. A server whose background work is off (STARBASE_JOBS=off): "Waiting" — never "Syncing…" or "Pulling…" for ever ──
// (This server's is on: what it would answer then is put in its place.)
const json = (o) => (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const WAITING_OFF = 'Waiting · background work is turned off — ask whoever set up base.win to turn it on';
const offList = json({ on: true, running: false, sync: { id: list.id, list_id: list.id, status: 'queued', consent: 'subscribed', tag: TAG, total: 0, added: 0, tagged: 0, removed: 0, skipped: 0, todo: 0, note: null, synced_at: null, created_at: new Date().toISOString(), by: 'Marco Example', stalled: false } });
const PANEL = '**/api/mailchimp';
// (An earlier pull had stopped, too: the line is still about the waiting, and not in the colour of a problem.)
const offPanel = json({ on: true, running: false, pulling: true, pulled_at: null, pull_ok: false, pull_note: 'Mailchimp said: it was down', waiting: 0, waiting_note: null });
for (const [p, size] of [[page, '1440'], [phone, '390']]) {
  await p.route(READ, offList);
  const l = await openList(p);
  await p.locator('.mc-status').waitFor({ timeout: 10000 }).catch(() => {});
  const pmOff = await measure(p.locator('.ls-tools'));
  check(`background work off, a list sent (${size}): "${WAITING_OFF}" — and no button to send it twice`, (await words(p.locator('.mc-status'))) === WAITING_OFF
    && !/Sync again|Send to Mailchimp/.test(await words(p.locator('.ls-tools'))) && fits(pmOff), `${await words(p.locator('.ls-tools'))} · ${JSON.stringify(pmOff)}`);
  await shot(l, `13-jobs-off-list-${size}`);
  await p.unroute(READ);
  await p.route(PANEL, offPanel);
  const r = await openServices(p);
  const pull = p.locator(`${ROW} .mcp-acts button`).nth(1);
  check(`…and a pull asked for (${size}): the same words; the button still reads "Pull now", and waits`, (await words(p.locator(`${ROW} .mcp-pull`))) === WAITING_OFF
    && (await words(pull)) === 'Pull now' && (await pull.isDisabled()) && (await p.locator(`${ROW} .mcp-pull.is-stopped`).count()) === 0, await words(p.locator(`${ROW} .mcp`)));
  await shot(r, `13-jobs-off-services-${size}`);
  await p.unroute(PANEL);
}
// A sync the first pull's question stopped before anything went (someone came in on file after a count
// that found nobody, so the list went by itself and nobody saw a count): it says so in its own words,
// with Try again. (Put in place of this server's answer.)
const DOOR_NOTE = '3 people here unsubscribed in Mailchimp, so nothing was sent — tap Try again';
const doorList = json({ on: true, running: true, first: { audience: 'aud0001', name: 'Sample Campaign', unsubscribed: 3, cleaned: 0, counted_at: new Date().toISOString(), counting: false },
  sync: { id: list.id, list_id: list.id, status: 'failed', consent: 'all', tag: TAG, total: 0, added: 0, tagged: 0, removed: 0, skipped: 0, todo: 0, note: DOOR_NOTE, synced_at: null, created_at: new Date().toISOString(), by: 'Marco Example', stalled: false, pulled_unsubscribed: 0, pulled_cleaned: 0 } });
for (const [p, size] of [[page, '1440'], [phone, '390']]) {
  await p.route(READ, doorList);
  const l = await openList(p);
  await p.locator('.mc-status').waitFor({ timeout: 10000 }).catch(() => {});
  const pmDoor = await measure(p.locator('.ls-tools'));
  check(`a sync the first pull's question stopped (${size}): "Stopped: ${DOOR_NOTE}", Try again beside it — no sideways scroll, every button ≥ 48px`, (await words(p.locator('.mc-status'))) === `Stopped: ${DOOR_NOTE} Try again`
    && (await p.locator('.mc-line[data-status="stopped"]').count()) === 1 && fits(pmDoor) && pmDoor.minTap >= 48, `${await words(p.locator('.mc-status'))} · ${JSON.stringify(pmDoor)}`);
  await shot(l, `13-door-stopped-${size}`);
  await p.unroute(READ);
}

// ── 12. An unsubscribe here reaches Mailchimp — and one it will not take is said, and sent again ──
subs = (await api('/subscriptions')).json;
await set({ lock: [{ email: addr('Cal'), words: 'This contact is being reviewed.' }] });
await act('subscription.remove', { id: subs.subscriptions.find((s) => s.email === addr('Cal')).id });
const WAITING = '1 unsubscribe here still to tell Mailchimp (Mailchimp said: This contact is being reviewed.) — Pull now sends it again.';
const waiting = await until(async () => { row = await openServices(page); return (await words(page.locator(`${ROW} .mcp-waiting`))) === WAITING; }, 15000);
check('Mailchimp will not take Cal’s unsubscribe: Settings → Services says one is waiting, and why', waiting, await words(page.locator(`${ROW} .mcp`)));
await shot(row, '14-waiting-1440');
prow = await openServices(phone);
pm = await measure(phone.locator(ROW));
check('at 390: the same line, wrapped — no sideways scroll, every button ≥ 48px', (await words(phone.locator(`${ROW} .mcp-waiting`))) === WAITING && fits(pm), JSON.stringify(pm));
await shot(prow, '14-waiting-390');
await set({ lock: [{ email: addr('Cal'), words: false }] });
await phone.locator(`${ROW} button:has-text("Pull now")`).tap();
const toldCal = await until(async () => (await mc()).members.find(([e]) => e === addr('Cal'))?.[1] === 'unsubscribed', 15000);
row = await openServices(page);
check('Pull now sends it again: Mailchimp has Cal unsubscribed, and nothing is waiting', toldCal && (await page.locator(`${ROW} .mcp-waiting`).count()) === 0, await words(page.locator(`${ROW} .mcp`)));
const ben = subs.subscriptions.find((s) => s.email === addr('Ben'));
await act('subscription.remove', { id: ben.id });
const told = await until(async () => (await mc()).members.find(([e]) => e === addr('Ben'))?.[1] === 'unsubscribed');
st = await mc();
check('the desk takes Ben off the newsletter: Mailchimp has him unsubscribed within moments', told);
check('nothing base.win sent ever said "subscribed" about someone already there', st.calls.filter((c) => c.method === 'PATCH').every((c) => c.body.status === 'unsubscribed')
  && st.calls.filter((c) => c.method === 'POST' && c.path === '/lists/aud0001').every((c) => c.body.update_existing === false));
const writes = st.calls.filter((c) => c.method !== 'GET');
check('every write to Mailchimp carried its own key', writes.length > 10 && writes.every((c) => /^base-mc-[a-z]+-[0-9a-f]{32}$/.test(c.key || '')), `${writes.length} writes`);

// ── 13. A sync finds people who had left in Mailchimp, and an address Mailchimp will not take ──
// Gus unsubscribed in Mailchimp and Hal's address died there, and neither webhook arrived. Jon is new
// on the list; Mailchimp refuses his address. The question can only count who can be emailed here now.
await act('person.create', { name: 'Jon Example', email: addr('Jon'), tags: ['member'] });
await set({ refuse: [{ email: addr('Jon') }] });
await post('/unsubscribe', { email: addr('Gus'), send: false });
await post('/clean', { email: addr('Hal'), send: false });
lp = await openList(page);
await page.locator('.ls-tools button:has-text("Sync again")').click();
await until(async () => /to send$/.test(await words(page.locator('.mc-ask .mc-line[role="status"]'))), 8000);
const askedFor = await words(page.locator('.mc-ask .mc-line[role="status"]'));
await page.locator('.mc-ask button:has-text("Send")').click();
const TURNED_OFF = 'Email turned off here too: 1 who unsubscribed in Mailchimp, 1 dead address.';
const NOT_TAKEN = '1 Mailchimp wouldn’t take (Mailchimp said: jon@example.org looks fake or invalid, please enter a real email address.)';
// The finished line: what the sync's own pull turned off shows as soon as that pull is done, while it still syncs.
const finished = (w, off) => w.startsWith('In Mailchimp · ') && w.includes(off);
await until(async () => finished(await words(page.locator('.mc-status')), TURNED_OFF), 20000);
status = await words(page.locator('.mc-status'));
check('the question counted 5; the line says 2 went, and why: who the sync turned off here, and who Mailchimp would not take — in its words', askedFor === '5 addresses to send'
  && status.startsWith('In Mailchimp · 2 addresses · tag “base.win: Members” Synced ') && status.includes(` · 4 taken out of the tag · ${NOT_TAKEN} · sent by Marco Example ${TURNED_OFF}`), `${askedFor} → ${status}`);
const last = (await api(`/lists/${list.id}/mailchimp`)).json.sync;
subs = (await api('/subscriptions')).json;
st = await mc();
check('…as the API has it, and as Mailchimp holds it: Gus and Hal are off here, Jon is not in the audience', last.total === 3 && last.skipped === 1 && last.pulled_unsubscribed === 1 && last.pulled_cleaned === 1
  && JSON.stringify(st.tag) === JSON.stringify(['Dee', 'Ida'].map(addr)) && !st.members.some(([e]) => e === addr('Jon'))
  && (await api(`/lists/${list.id}/mailchimp?counts=1`)).json.counts.everyone === 3, JSON.stringify([last, st.tag]));
await shot(lp, '15-list-turned-off-1440');
plp = await openList(phone);
await phone.locator('.mc-status').waitFor({ timeout: 10000 }).catch(() => {});
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the same lines, wrapped — no sideways scroll, every button ≥ 48px', (await words(phone.locator('.mc-status'))) === status && fits(pm), `${await words(phone.locator('.mc-status'))} · ${JSON.stringify(pm)}`);
await shot(plp, '15-list-turned-off-390');

// ── 14. Another audience: a count of nobody asks nothing and opens nothing; the first count that finds someone asks ──
// The campaign moves to another audience, where a household left long ago (Kim and Lou Example share one
// address) — and nobody here has them on file yet. Mailchimp takes Jon now.
const HOME = 'home@example.org';
const doorSaid = async () => ((await api('/events?since=0&limit=2000')).json?.events || []).filter((e) => e.entity_type === 'mailchimp' && e.payload?.first_pull && e.payload.audience === 'aud0002');
await set({ audiences: [{ id: 'aud0002', name: 'Sample supporters' }], refuse: [{ email: addr('Jon'), words: false }], env: { MAILCHIMP_AUDIENCE_ID: 'aud0002' },
  add: [{ email: HOME, status: 'unsubscribed', changed: longAgo, audienceId: 'aud0002' }] });
lp = await openList(page);
await page.locator('.ls-tools button:has-text("Sync again")').click();
await until(async () => /to send$/.test(await words(page.locator('.mc-ask .mc-line[role="status"]'))), 8000);
await set({ slow: 1500 }); // the count, held long enough to be seen
await page.locator('.mc-ask button:has-text("Send")').click();
const sawCounting = await until(async () => (await words(page.locator('.mc-first'))) === 'Counting who unsubscribed in Mailchimp… Not now', 10000);
check('Send to an audience nobody has said yes to: counted first — "Counting who unsubscribed in Mailchimp…", announced', sawCounting
  && (await page.locator('.mc-first [role="status"]').count()) === 1, await words(page.locator('.mc')));
await shot(lp, '16-list-counting-1440');
await set({ slow: 0 });
const wentOn = await until(async () => /^In Mailchimp · 3 addresses/.test(await words(page.locator('.mc-status'))), 20000);
let firstNow = (await api('/mailchimp')).json.first;
check('…nobody on file to turn off: no question, and it goes by itself — but nothing opens: nobody has said yes', wentOn && (await page.locator('.mc-first').count()) === 0
  && JSON.stringify((await mc(TAG, 'aud0002')).tag) === JSON.stringify(['Dee', 'Ida', 'Jon'].map(addr)) && (await doorSaid()).length === 0
  && firstNow?.audience === 'aud0002' && firstNow.unsubscribed === 0 && firstNow.cleaned === 0, `${await words(page.locator('.mc'))} · ${JSON.stringify(firstNow)}`);
// The household comes in on file afterwards: the next send asks.
const household = [];
for (const w of ['Kim', 'Lou']) household.push((await act('person.create', { name: `${w} Example`, email: HOME, tags: ['member'] })).json.person.id);
const householdOff = async () => (await Promise.all(household.map(async (id) => JSON.stringify((await api(`/persons/${id}`)).json?.person?.tags || []).includes('do-not-email')))).filter(Boolean).length;
await page.locator('.ls-tools button:has-text("Sync again")').click();
await until(async () => /to send$/.test(await words(page.locator('.mc-ask .mc-line[role="status"]'))), 8000);
await page.locator('.mc-ask button:has-text("Send")').click();
const SECOND_Q = new RegExp(`^Audience ‘Sample supporters’ · 2 people here unsubscribed there Only they can turn their email back on\\. ${COUNTED} Turn their email off here Not now$`);
const askedOnSend = await until(async () => SECOND_Q.test(await words(page.locator('.mc-first'))), 20000);
m = await measure(page.locator('.ls-tools'));
check('the first count that finds someone asks: nothing goes — the audience, how many people here it would turn off (two on one address are two), when it counted; the one yellow button is still Email this list', askedOnSend
  && m.primary.join('|') === 'Email this list' && m.minTap >= 48 && JSON.stringify((await mc(TAG, 'aud0002')).tag) === JSON.stringify(['Dee', 'Ida', 'Jon'].map(addr)), `${await words(page.locator('.mc'))} · ${JSON.stringify(m)}`);
await shot(lp, '16-list-first-ask-1440');
await page.locator('.mc-first button:has-text("Not now")').click();
st = await mc(TAG, 'aud0002');
check('Not now: nothing sent, nobody turned off; the line is the last sync’s, as it was', (await page.locator('.mc-ask').count()) === 0 && JSON.stringify(st.tag) === JSON.stringify(['Dee', 'Ida', 'Jon'].map(addr))
  && (await householdOff()) === 0 && (await doorSaid()).length === 0 && /^In Mailchimp · 3 addresses/.test(await words(page.locator('.mc-status'))), await words(page.locator('.mc')));
// On the phone: Sync again → Send → counted again → the same question → the yes, by tap.
plp = await openList(phone);
await phone.locator('.ls-tools button:has-text("Sync again")').tap();
await until(async () => /to send$/.test(await words(phone.locator('.mc-ask .mc-line[role="status"]'))), 8000);
await phone.locator('.mc-ask button:has-text("Send")').tap();
await until(async () => SECOND_Q.test(await words(phone.locator('.mc-first'))), 15000);
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the same question — no sideways scroll, every button ≥ 48px, one yellow button', SECOND_Q.test(await words(phone.locator('.mc-first'))) && fits(pm)
  && pm.primary.join('|') === 'Email this list', JSON.stringify(pm));
await shot(plp, '16-list-first-ask-390');
await phone.locator('.mc-first button:has-text("Turn their email off here")').tap();
const SECOND_OFF = 'Email turned off here too: 2 who unsubscribed in Mailchimp.';
await until(async () => finished(await words(phone.locator('.mc-status')), SECOND_OFF), 20000);
status = await words(phone.locator('.mc-status'));
st = await mc(TAG, 'aud0002');
const said2 = (await doorSaid()).map((e) => [e.payload.first_pull, e.payload.unsubscribed, Boolean(e.actor_id)].join('|'));
check('Turn their email off here: it sends — "In Mailchimp · 3 addresses", and the two it turned off here; the yes on the log is a person’s, to 2', /^In Mailchimp · 3 addresses · tag “base\.win: Members” Synced /.test(status)
  && status.endsWith(SECOND_OFF) && JSON.stringify(st.tag) === JSON.stringify(['Dee', 'Ida', 'Jon'].map(addr)) && (await householdOff()) === 2 && said2.join(',') === 'yes|2|true', `${status} · ${JSON.stringify(st.tag)} · ${said2}`);
// …and the page's own numbers follow: the household's address can't be emailed here now.
const recounted = await until(async () => / 3 by email · /.test(await words(phone.locator('.ls-page'))), 10000);
check('…the list’s own line reads again: "3 by email"', recounted, (await words(phone.locator('.ls-page'))).slice(0, 120));
await shot(plp, '16-list-first-sent-390');

// ── 15. Settings → Services: a yes whose pull counted more brings the question back, and says why ──
// (Put in place of this server's answers: the count is 2 when the manager says yes, and 3 once the pull
// after the yes has counted again — someone came in on file meanwhile.)
const AGAIN = 'The count has changed since you said yes — look again.';
for (const [p, size] of [[page, '1440'], [phone, '390']]) {
  let saidYes = false;
  const question = (n) => ({ audience: 'aud0002', name: 'Sample supporters', unsubscribed: n, cleaned: 0, counted_at: new Date().toISOString(), counting: false });
  await p.route(PANEL, (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ on: true, running: true, pulling: false, pulled_at: null, pull_ok: null, pull_note: null, waiting: 0, waiting_note: null, first: question(saidYes ? 3 : 2) }) }));
  await p.route('**/api/actions/mailchimp.pull', (r) => { saidYes = true; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"queued":true}' }); });
  const r = await openServices(p);
  const yesBtn = p.locator(`${ROW} .fp button:has-text("Turn their email off here")`);
  if (size === '390') await yesBtn.tap(); else await yesBtn.click();
  const back = await until(async () => / 3 people here unsubscribed there /.test(` ${await words(p.locator(`${ROW} .fp`))} `), 10000);
  const pmAgain = await measure(p.locator(ROW));
  check(`a yes whose pull counted more (${size}): the question is back with the new number, saying why — "${AGAIN}"`, back
    && (await words(p.locator(`${ROW} .mcp-again[role="status"]`))) === AGAIN && fits(pmAgain) && pmAgain.primary.length === 0, `${await words(p.locator(`${ROW} .mcp`))} · ${JSON.stringify(pmAgain)}`);
  await shot(r, `17-services-asked-again-${size}`);
  await p.unroute(PANEL);
  await p.unroute('**/api/actions/mailchimp.pull');
}

check('the books verify', (await api('/audit/verify')).json?.ok === true);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill('SIGTERM');
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
if (fails) console.log(serverLog.split('\n').slice(-15).join('\n'));
process.exit(fails ? 1 : 0);
