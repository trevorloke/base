// Mailchimp — browser check. A fresh in-memory server with a stand-in for
// Mailchimp (server/test/fake-mailchimp.js) loaded into it; a manager on a
// laptop and on a 390×844 phone:
//   · Settings → Services → Mailchimp: not set up (its setting named, no
//     buttons); set up — Check says the one thing missing; Connect makes the
//     webhook and shows the signing secret once, with Copy; Check then says
//     unsubscribes come back here; Pull now reads who left and whose address
//     died and says what it found;
//   · a list's page: "Send to Mailchimp" beside Download CSV only when
//     Mailchimp is on; the question before sending (how many go — the
//     newsletter's subscribers, or with one tick everyone who can be
//     emailed); "Syncing with Mailchimp · 6 to go"; "In Mailchimp · 4
//     addresses · tag …"; Sync again remembers the choice; an unsubscribe in
//     Mailchimp arrives by its webhook and the next sync takes the address
//     out of the tag; a refused key reads "Stopped: … Try again".
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
const fake = await startFakeMailchimp({ port: ${FAKE}, apiKey: ${JSON.stringify(KEY)} });
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  if (req.url === '/set') {
    for (const [k, v] of Object.entries(j.env || {})) { if (v === null) delete process.env[k]; else process.env[k] = v; }
    if ('signing' in j) fake.signing(j.signing);
    if ('slow' in j) fake.slow(j.slow);
    if ('slice' in j) _setSliceForTest(j.slice);
    for (const m of j.add || []) fake.add(m.email, m);
    return res.end('ok');
  }
  // Something happens in Mailchimp itself; its webhook says so (unless send: false).
  if (req.url === '/unsubscribe') { const r = await fake.unsubscribe(j.email, j); return res.end(JSON.stringify(r.map((x) => x.status))); }
  if (req.url === '/clean') { const r = await fake.clean(j.email, j); return res.end(JSON.stringify(r.map((x) => x.status))); }
  if (req.url === '/state') {
    return res.end(JSON.stringify({
      id: fake.id, members: fake.members().map((m) => [m.email_address, m.status, m.merge_fields]), tag: fake.tagged(j.tag),
      webhooks: fake.webhooks().map((w) => ({ url: w.url, events: w.events, sources: w.sources })),
      calls: fake.calls.map((x) => ({ method: x.method, path: x.path, body: x.body })),
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
const mc = async (tag = TAG) => JSON.parse(await post('/state', { tag }));
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
const words = async (loc) => ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms = 12000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(200); }
  return false;
};
const shot = (loc, name) => loc.screenshot({ path: `${SHOTS}/${name}.png` });
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

// ── People, the newsletter and a list ──
const addr = (w) => `${w.toLowerCase()}@example.org`;
const everyone = ['Ana', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'];
for (const w of everyone) await act('person.create', { name: `${w} Example`, email: addr(w), phone: '604-555-0142', address: '123 Example Street', tags: ['member', 'vip-donor'] });
for (const w of everyone.slice(0, 6)) await act('subscription.add', { email: addr(w), name: `${w} Example` });
const list = (await act('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member' } })).json.list;
const LIST = `${ADMIN}/lists/${list.id}`;

const ROW = '.sv2-row:has(.sv2-name:text-is("Mailchimp"))';
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

// ── 1. Mailchimp is not set up ──
let row = await openServices(page);
let w = await words(row);
check('not set up: the row names its setting, and has no Connect or Pull now', /^Mailchimp Not set up A list becomes a tag in your Mailchimp audience; unsubscribes and dead addresses come back/.test(w)
  && /Set in the hosting’s environment: MAILCHIMP_API_KEY/.test(w) && !/Connect|Pull now/.test(w), w);
await shot(row, '01-not-set-up-1440');
let lp = await openList(page);
check('…and a list’s page has no "Send to Mailchimp"', !/Mailchimp/.test(await words(lp)) && /Download CSV/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));

// ── 2. Set up: the row, and Check naming the one thing missing ──
await set({ env: mailchimpOn, add: [{ email: 'older@example.org' }, { email: 'reader@example.org' }] });
row = await openServices(page);
w = await words(row);
let m = await measure(page.locator(ROW));
check('set up: "Set up", the honest line, Connect and Pull now, "Not pulled yet"', /^Mailchimp Set up /.test(w) && /Built against Mailchimp’s published API: press Check on your own account before relying on it\./.test(w)
  && /Connect Pull now Connect tells Mailchimp to send unsubscribes here\. Pull now reads them at once\. Not pulled yet/.test(w), w);
check('…no yellow button on the screen, every button ≥ 48px', m.primary.length === 0 && m.minTap >= 48, JSON.stringify(m));
await page.locator(`${ROW} .sv2-check`).click();
await page.locator(`${ROW} > .sv2-row__main > .sv2-said`).waitFor({ timeout: 10000 }).catch(() => {});
let said = await words(page.locator(`${ROW} > .sv2-row__main > .sv2-said`));
check('Check: the key, the audience, how many are subscribed — and the one thing missing', said === '✕ The key works · audience “Sample Campaign” · 2 subscribed — but Mailchimp isn’t sending unsubscribes here yet: tap Connect', said);
await shot(row, '02-check-not-connected-1440');

// ── 3. Connect: the webhook is made; the signing secret is shown once ──
await set({ signing: SECRET });
await page.locator(`${ROW} button:has-text("Connect")`).click();
await page.locator(`${ROW} .mcp .sv2-said`).waitFor({ timeout: 10000 }).catch(() => {});
w = await words(row);
check('Connect: "✓ Mailchimp now sends unsubscribes and dead addresses here", announced', (await words(page.locator(`${ROW} .mcp .sv2-said[role="status"]`))) === '✓ Mailchimp now sends unsubscribes and dead addresses here', w.slice(0, 300));
check('…the signing secret shown once, with where it goes', w.includes(`Copy this signing secret now — it won’t be shown again. ${SECRET} Set MAILCHIMP_WEBHOOK_SECRET to it in the hosting’s environment.`), w.slice(200, 600));
check('…and what Check said before is gone (it is no longer true)', (await page.locator(`${ROW} > .sv2-row__main > .sv2-said`).count()) === 0);
await page.locator(`${ROW} .sv2-fresh button:has-text("Copy")`).click();
const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard: ${e.message}`);
check('Copy puts the secret on the clipboard', copied === SECRET, copied);
await shot(row, '03-connected-secret-1440');
let st = await mc();
check('Mailchimp was told: unsubscribe, cleaned and address changes — never base.win’s own changes', st.webhooks.length === 1 && st.webhooks[0].url.startsWith(`${BASE}/hooks/mailchimp/`)
  && JSON.stringify(st.webhooks[0].events) === JSON.stringify({ subscribe: false, unsubscribe: true, profile: false, cleaned: true, upemail: true, campaign: false })
  && JSON.stringify(st.webhooks[0].sources) === JSON.stringify({ user: true, admin: true, api: false }), JSON.stringify(st.webhooks));
check('the webhook’s address is nowhere on the page', !(await page.content()).includes(st.webhooks[0].url.split('/').pop()));
await page.locator(`${ROW} .sv2-fresh button:has-text("Done")`).click();
check('Done: the secret is gone from the page', !(await page.content()).includes(SECRET));
await set({ env: { MAILCHIMP_WEBHOOK_SECRET: SECRET } });
await page.locator(`${ROW} .sv2-check`).click();
await page.locator(`${ROW} > .sv2-row__main > .sv2-said`).waitFor({ timeout: 10000 }).catch(() => {});
said = await words(page.locator(`${ROW} > .sv2-row__main > .sv2-said`));
check('Check now: "✓ … · unsubscribes come back here"', said === '✓ The key works · audience “Sample Campaign” · 2 subscribed · unsubscribes come back here', said);
let prow = await openServices(phone);
let pm = await measure(phone.locator(ROW));
check('at 390: the row — no sideways scroll, every button ≥ 48px, no yellow button', pm.overflow <= 0 && pm.minTap >= 48 && pm.primary.length === 0, JSON.stringify(pm));
await shot(prow, '03-set-up-390');

// ── 4. Pull now: who left in Mailchimp, whose address died ──
await post('/unsubscribe', { email: addr('Fay'), send: false });
await post('/clean', { email: addr('Eli'), send: false });
await phone.locator(`${ROW} button:has-text("Pull now")`).tap();
const pulled = await until(async () => /Last pulled/.test(await words(phone.locator(`${ROW} .mcp-pull`))));
let pw = await words(phone.locator(`${ROW} .mcp-pull`));
check('Pull now (on the phone): "Last pulled … · 1 unsubscribed · 1 dead address"', pulled && /^Last pulled \d{1,2}:\d\d [ap]\.?m\.? · 1 unsubscribed · 1 dead address$/.test(pw), pw);
const subs = (await api('/subscriptions')).json;
check('…Fay is off the newsletter here, Eli’s address can’t be emailed — as the API has it', subs.subscriptions.find((s) => s.email === addr('Fay'))?.status === 'unsubscribed'
  && subs.subscriptions.find((s) => s.email === addr('Eli'))?.can_email === false && subs.emailable === 4, `${subs.subscribed}/${subs.emailable}`);
await shot(prow, '04-pulled-390');
row = await openServices(page);
await shot(row, '04-pulled-1440');

// ── 5. A list's page: Send to Mailchimp ──
lp = await openList(page);
let tools = await words(page.locator('.ls-tools'));
m = await measure(page.locator('.ls-tools'));
check('the list’s page: "Send to Mailchimp" beside Download CSV; the page’s one yellow button is still Email this list', /^Download CSV Send to Mailchimp Edit the filter Delete$/.test(tools)
  && m.primary.join('|') === 'Email this list', `${tools} · ${JSON.stringify(m.primary)}`);
await shot(lp, '05-list-before-1440');
// By keyboard: Enter opens the question.
await page.locator('.ls-tools button:has-text("Send to Mailchimp")').focus();
await page.keyboard.press('Enter');
await page.locator('.mc-ask .ops-check').waitFor({ timeout: 10000 }).catch(() => {});
let ask = await words(page.locator('.mc-ask'));
check('the question: "4 addresses to send · newsletter subscribers only", the tick with how many it would be, what goes', ask.startsWith('4 addresses to send · newsletter subscribers only Everyone on this list who can be emailed (6); they agreed to hear from us by email Only email, first and last name go. Nobody already in your audience is changed. Send Cancel'), ask);
const counts = (await api(`/lists/${list.id}/mailchimp?counts=1`)).json.counts;
check('…the numbers the API counted', counts.subscribed === 4 && counts.everyone === 6, JSON.stringify(counts));
await shot(lp, '05-list-ask-1440');
// The tick, by keyboard (Space), then back.
await page.locator('.mc-ask input[type="checkbox"]').focus();
await page.keyboard.press('Space');
check('the tick widens it: "6 addresses to send", announced', (await words(page.locator('.mc-ask .mc-line[role="status"]'))) === '6 addresses to send', await words(page.locator('.mc-ask .mc-line')));
await page.keyboard.press('Space');
// Send: watched while it works (the stand-in is slowed, two addresses to a call).
await set({ slow: 350, slice: { ms: 0, chunk: 2 } });
await page.locator('.mc-ask button:has-text("Send")').click();
const syncing = await until(async () => /Syncing with Mailchimp · \d+ to go/.test(await words(page.locator('.mc-status'))), 20000);
check('Send: "Syncing with Mailchimp · … to go", announced; the button is away while it works', syncing && (await page.locator('.mc-status [role="status"][aria-live="polite"]').count()) === 1
  && !/Sync again|Send to Mailchimp/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));
await shot(lp, '06-list-syncing-1440');
await set({ slow: 0, slice: null });
const done = await until(async () => /In Mailchimp/.test(await words(page.locator('.mc-status'))), 30000);
let status = await words(page.locator('.mc-status'));
check('done: "In Mailchimp · 4 addresses · tag “base.win: Members”", and the detail line', done && /^In Mailchimp · 4 addresses · tag “base\.win: Members” Synced \d{1,2}:\d\d [ap]\.?m\.? · newsletter subscribers only · 4 new to your audience · sent by Marco Example$/.test(status), status);
check('…the button now reads "Sync again"', /^Download CSV Sync again In Mailchimp/.test(await words(page.locator('.ls-tools'))), await words(page.locator('.ls-tools')));
st = await mc();
const sync = (await api(`/lists/${list.id}/mailchimp`)).json.sync;
check('…what Mailchimp holds: the four subscribed, by first and last name, in the tag', JSON.stringify(st.tag) === JSON.stringify(['Ana', 'Ben', 'Cal', 'Dee'].map(addr))
  && st.members.some(([e, s, f]) => e === addr('Ana') && s === 'subscribed' && f.FNAME === 'Ana' && f.LNAME === 'Example') && sync.total === 4 && sync.added === 4 && sync.tagged === 4, JSON.stringify([st.tag, sync]));
const traffic = JSON.stringify(st.calls);
check('…and nothing else left base.win: no phone, no street, no tag', !/555|Example Street|vip-donor|"member"/.test(traffic));
await shot(lp, '07-list-synced-1440');

// ── 6. The phone: the same line; Sync again remembers the choice ──
let plp = await openList(phone);
await phone.locator('.mc-status').waitFor({ timeout: 10000 }).catch(() => {});
pm = await measure(phone.locator('.ls-tools'));
check('at 390: the line is there — no sideways scroll, every button ≥ 48px, one yellow button', /^In Mailchimp · 4 addresses/.test(await words(phone.locator('.mc-status'))) && pm.overflow <= 0 && pm.minTap >= 48 && pm.primary.join('|') === 'Email this list', JSON.stringify(pm));
await shot(plp, '08-list-synced-390');
await phone.locator('.ls-tools button:has-text("Sync again")').tap();
await phone.locator('.mc-ask .ops-check').waitFor({ timeout: 10000 }).catch(() => {});
await phone.locator('.mc-ask .ops-check').tap();
pm = await measure(phone.locator('.ls-tools'));
check('Sync again (on the phone): the question, the tick a 48px row; ticked: "6 addresses to send"', (await words(phone.locator('.mc-ask .mc-line[role="status"]'))) === '6 addresses to send' && pm.overflow <= 0 && pm.minTap >= 48, JSON.stringify(pm));
await shot(plp, '08-list-ask-390');
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

// ── 8. Mailchimp refuses the key: "Stopped", in its words, with Try again ──
await set({ env: { MAILCHIMP_API_KEY: `wrong-${KEY}` } });
plp = await openList(phone);
await phone.locator('.ls-tools button:has-text("Sync again")').tap();
await phone.locator('.mc-ask button:has-text("Send")').waitFor({ timeout: 10000 }).catch(() => {});
await until(async () => !(await phone.locator('.mc-ask button:has-text("Send")').isDisabled()), 8000);
await phone.locator('.mc-ask button:has-text("Send")').tap();
const stoppedOk = await until(async () => /^Stopped: /.test(await words(phone.locator('.mc-status'))), 20000);
status = await words(phone.locator('.mc-status'));
pm = await measure(phone.locator('.ls-tools'));
check('a refused key: "Stopped: Mailchimp refused the key — …" and Try again; never the key itself', stoppedOk && status === 'Stopped: Mailchimp refused the key — copy the whole key, with its ending (like -us19) Try again'
  && !(await phone.content()).includes(KEY) && pm.overflow <= 0 && pm.minTap >= 48, `${status} · ${JSON.stringify(pm)}`);
await shot(plp, '10-list-stopped-390');
await set({ env: { MAILCHIMP_API_KEY: KEY } });
await phone.locator('.mc-status button:has-text("Try again")').tap();
const back = await until(async () => /^In Mailchimp · 5 addresses/.test(await words(phone.locator('.mc-status'))), 20000);
check('Try again, the key put right: "In Mailchimp · 5 addresses" again', back, await words(phone.locator('.mc-status')));

// ── 9. An unsubscribe here reaches Mailchimp ──
const ben = (await api('/subscriptions')).json.subscriptions.find((s) => s.email === addr('Ben'));
await act('subscription.remove', { id: ben.id });
const told = await until(async () => (await mc()).members.find(([e]) => e === addr('Ben'))?.[1] === 'unsubscribed');
st = await mc();
check('the desk takes Ben off the newsletter: Mailchimp has him unsubscribed within moments', told);
check('nothing base.win sent ever said "subscribed" about someone already there', st.calls.filter((c) => c.method === 'PATCH').every((c) => c.body.status === 'unsubscribed')
  && st.calls.filter((c) => c.method === 'POST' && c.path === '/lists/aud0001').every((c) => c.body.update_existing === false));

check('the books verify', (await api('/audit/verify')).json?.ok === true);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill('SIGTERM');
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
if (fails) console.log(serverLog.split('\n').slice(-15).join('\n'));
process.exit(fails ? 1 : 0);
