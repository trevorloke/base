// Email that hears back — browser check. A fresh in-memory server with a
// stand-in for Resend (server/test/fake-mail.js) and a stand-in DNS lookup,
// loaded into the server; a manager on a laptop and on a 390×844 phone:
//   · Settings → Services → Email → Sending domain: not added yet (Add
//     domain, the one yellow button), the sender's DNS records each with
//     Copy and "Not found yet", Check again as records come in, everything
//     in (Verified, no yellow button), base.win's own DMARC line in each
//     state, a sending-only key said plainly, a sender that doesn't answer
//     ("Unavailable — … Try again");
//   · From addresses: the campaign's own first, the one-tap media@ offer
//     (saved as the press default), another domain refused in the server's
//     words, Make default for email; Outreach → Email's From line;
//   · Check on Email: every shortfall a sentence, then "✓ … · DMARC is in ·
//     bounces and complaints come back here";
//   · Outreach → Email: a newsletter goes out, the sender's signed events
//     come in at /hooks/mail/resend, and the send's row says "Delivered 9 of
//     12 · 2 bounced · 1 spam complaint" with the 0.1% warning; the
//     subscribers list marks who can't be emailed and the next send counts
//     three fewer.
// Every number on screen is checked against the API; the books verify.
//
//   npm run build  then  node e2e-mail.mjs   (PORT, SHOTS optional; the
//   stand-in sender listens on PORT+1 and the test's controls on PORT+2)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 4970;
const FAKE = PORT + 1;
const CONTROL = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-mail';
mkdirSync(SHOTS, { recursive: true });
const DOMAIN = 'campaign.example.org';
const HOOK = `${BASE}/hooks/mail/resend`;
const SECRET = `whsec_${Buffer.from('e2e-mail-secret').toString('base64')}`;
const EVENTS = ['email.delivered', 'email.bounced', 'email.complained', 'email.delivery_delayed', 'email.suppressed', 'email.failed'];

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in sender, the stand-in DNS lookup and the test's controls,
// loaded into the server (they only exist in this check) ──
const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const href = (p) => JSON.stringify(pathToFileURL(`${serverDir}${p}`).href);
const STUB = `${SHOTS}/mail-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
const { startFakeMail } = await import(${href('test/fake-mail.js')});
const dns = await import(${href('lib/mail/dns.js')});
const fake = await startFakeMail({ provider: 'resend', port: ${FAKE}, secret: ${JSON.stringify(SECRET)}, webhookUrl: ${JSON.stringify(HOOK)} });
let txt = {};
let dnsDown = false;
dns._setResolverForTest(async (name) => {
  if (dnsDown) throw Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' });
  if (!txt[name]) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
  return txt[name];
});
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  if (req.url === '/set') {
    for (const [k, v] of Object.entries(j.env || {})) { if (v === null) delete process.env[k]; else process.env[k] = v; }
    if (j.domains) fake.domains(j.domains);
    if (j.hooks) fake.hooks(j.hooks);
    if ('sendingOnly' in j) fake.sendingOnly(j.sendingOnly);
    if (j.txt) txt = j.txt;
    if ('dnsDown' in j) dnsDown = j.dnsDown;
    return res.end('ok');
  }
  // One delivery event about the email that went to an address, signed as Resend signs it.
  if (req.url === '/event') {
    const m = fake.sent.filter((x) => x.to === j.to).at(-1);
    const r = await fake.event(j.kind, { ref: m?.ref, to: j.to, detail: j.detail, ...(j.forge ? { signWith: 'whsec_c29tZW9uZS1lbHNl' } : {}) });
    return res.end(JSON.stringify({ status: r.status }));
  }
  if (req.url === '/sent') return res.end(JSON.stringify(fake.sent.map((x) => ({ to: x.to, subject: x.subject, ref: x.ref }))));
  if (req.url === '/calls') return res.end(JSON.stringify(fake.calls.map((x) => x.method + ' ' + x.path)));
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);

const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off' };
for (const k of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'RESEND_REGION', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE',
  'SENDGRID_WEBHOOK_PUBLIC_KEY', 'MAIL_FROM', 'STARBASE_PUBLIC_URL']) delete env[k];
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
const event = async (kind, to, more = {}) => JSON.parse(await post('/event', { kind, to, ...more })).status;
const resendOn = { RESEND_API_KEY: 're_e2e_mail', RESEND_API_BASE: `http://127.0.0.1:${FAKE}`, MAIL_FROM: `Sample Campaign <team@${DOMAIN}>` };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Sample Campaign');
await page.fill('#su-email', 'marco@mail.example.org');
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
const EMAIL = '.sv2-row:has(.sv2-name:text-matches("^Email"))';
const words = async (loc) => ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
// The Email row, loaded: its words, and how it measures.
const openServices = async (p) => {
  await p.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
  const row = p.locator(EMAIL);
  await row.waitFor({ timeout: 10000 });
  await p.locator(`${EMAIL} .sd`).waitFor({ timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 40 && /Loading…/.test(await row.innerText()); i += 1) await sleep(250);
  return row;
};
const measure = (row) => row.evaluate((el) => {
  const vis = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const btns = [...el.querySelectorAll('button')].filter(vis);
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    primary: [...document.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.innerText.trim()),
    minTap: btns.length ? Math.min(...btns.map((b) => Math.round(b.getBoundingClientRect().height))) : null,
    chips: [...el.querySelectorAll('.sd .chip')].map((c) => c.innerText.trim()),
  };
});
const shot = (loc, name) => loc.screenshot({ path: `${SHOTS}/${name}.png` });

// ── 1. Email connected; the sender doesn't hold the domain yet ──
await set({ env: resendOn, domains: [], txt: {} });
let row = await openServices(page);
let w = await words(row);
let m = await measure(row);
check('Email (Resend) is set up; the row says where its delivery events go', /^Email \(Resend\) Set up/.test(w) && w.includes(`Webhook address — in Resend: Webhooks → Add webhook: ${HOOK}`)
  && /Events to send \(6\)/.test(w) && /Then set RESEND_WEBHOOK_SECRET to the webhook’s signing secret\./.test(w), w.slice(0, 200));
check('Sending domain: the domain, "Not added yet", and one yellow button — Add domain', /Sending domain campaign\.example\.org Not added yet Resend doesn’t have this domain yet\./.test(w)
  && m.primary.join('|') === 'Add domain', `${JSON.stringify(m.primary)} · ${w.slice(120, 330)}`);
check('…with the DMARC record to add, looked up by base.win itself', /DMARC · TXT Not found yet Name _dmarc Value v=DMARC1; p=none/.test(w) && /Gmail, Yahoo and Outlook ask bulk senders for this one\./.test(w), w.slice(200, 420));
await shot(row, '01-not-added-1440');

// ── 2. Add domain: the sender's records, each "Not found yet"; Copy copies the value ──
await page.locator(`${EMAIL} button:has-text("Add domain")`).click();
await page.locator(`${EMAIL} .sd-count:has-text("Added")`).waitFor({ timeout: 8000 }).catch(() => {});
w = await words(row);
m = await measure(row);
check('Add domain: said, and announced ("Added. Now add these records…"), the three records and DMARC listed, each "Not found yet"',
  (await words(page.locator(`${EMAIL} .sd-count[role="status"]`))) === 'Added. Now add these records at your domain’s DNS host.' && m.chips.join('|') === 'Not verified yet|Not found yet|Not found yet|Not found yet|Not found yet'
  && /SPF · MX · priority 10/.test(w) && /DKIM · TXT/.test(w) && /resend\._domainkey/.test(w), `${m.chips.join('|')} · ${w.slice(150, 330)}`);
check('…and the one yellow button is now Check again', m.primary.join('|') === 'Check again', JSON.stringify(m.primary));
await page.locator(`${EMAIL} .sd-rec:has-text("DKIM") .sd-copy`).click();
const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard: ${e.message}`);
check('Copy puts the record’s value on the clipboard', copied === 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQfake', copied);
const log = await api('/events?since=0&limit=1000');
const added = (log.json?.events || []).filter((e) => e.action === 'mail.domain.add');
check('on the log: who added the domain, once', added.length === 1 && added[0].payload.domain === DOMAIN && !!added[0].actor_id, JSON.stringify(added.map((e) => e.payload)));
await shot(row, '02-added-1440');
// The phone finds it there already: the same records, nothing added twice.
let prow = await openServices(phone);
let pm = await measure(prow);
check('at 390: the same panel — no sideways scroll, every button ≥ 48px, one yellow button', pm.overflow <= 0 && pm.minTap >= 48 && pm.primary.join('|') === 'Check again', JSON.stringify(pm));
await shot(prow, '02-added-390');

// ── 3. Some records in: Check again says how many ──
await set({ domains: [{ id: 'd-e2e', name: DOMAIN, status: 'pending', spf: 'verified' }] });
await phone.locator(`${EMAIL} button:has-text("Check again")`).tap();
await phone.locator(`${EMAIL} .sd-count:has-text("Checked")`).waitFor({ timeout: 8000 }).catch(() => {});
let pw = await words(prow);
pm = await measure(prow);
check('Check again (on the phone): "Checked: 2 of 4 in…", the chips follow', /Checked: 2 of 4 in\. A new record can take an hour to show\./.test(pw)
  && pm.chips.join('|') === 'Not verified yet|In|In|Not found yet|Not found yet', `${pm.chips.join('|')} · ${pw.slice(-260)}`);
await shot(prow, '03-partly-in-390');

// ── 4. The sender's records are in; DMARC is still missing; Check says each shortfall ──
await set({ domains: [{ id: 'd-e2e', name: DOMAIN, status: 'verified' }], hooks: [] });
row = await openServices(page);
w = await words(row);
m = await measure(row);
check('verified at the sender, DMARC missing: "Add this record…", 3 of 4 in, Check again still yellow', /campaign\.example\.org Verified Add this record at your domain’s DNS host, then tap Check again\./.test(w)
  && /3 of 4 in/.test(w) && m.primary.join('|') === 'Check again', `${JSON.stringify(m.primary)} · ${w.slice(120, 260)}`);
await page.locator(`${EMAIL} .sv2-check`).click();
await page.locator(`${EMAIL} .sv2-said`).waitFor({ timeout: 10000 }).catch(() => {});
let said = await words(page.locator(`${EMAIL} .sv2-said`));
check('Check on Email: each thing missing is one sentence', said === `✕ The key works and ${DOMAIN} is verified. There’s no DMARC record yet: add the one under Sending domain. Resend isn’t sending bounces and complaints here yet: add a webhook to ${HOOK}.`, said);
await shot(row, '04-check-shortfalls-1440');

// ── 5. Everything in ──
await set({
  txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none']] }, env: { RESEND_WEBHOOK_SECRET: SECRET },
  hooks: [{ id: 'wh_e2e', endpoint: HOOK, status: 'enabled', events: EVENTS }],
});
row = await openServices(page);
await page.locator(`${EMAIL} .sv2-check`).click();
await page.locator(`${EMAIL} .sv2-said`).waitFor({ timeout: 10000 }).catch(() => {});
w = await words(row);
m = await measure(row);
said = await words(page.locator(`${EMAIL} .sv2-said`));
check('everything in: Verified, every record "In", 4 of 4 — and no yellow button left on the screen', m.chips.join('|') === 'Verified|In|In|In|In' && /4 of 4 in/.test(w) && m.primary.length === 0
  && w.includes(`Name _dmarc.${DOMAIN} Value v=DMARC1; p=none`), `${m.chips.join('|')} ${JSON.stringify(m.primary)}`);
check('Check on Email: "✓ … verified · DMARC is in · bounces and complaints come back here"', said === `✓ The key works and ${DOMAIN} is verified · DMARC is in · bounces and complaints come back here`, said);
check('…and the secret is set, so the row no longer asks for it', !/RESEND_WEBHOOK_SECRET/.test(w), w.slice(-200));
await shot(row, '05-all-in-1440');
prow = await openServices(phone);
await shot(prow, '05-all-in-390');
const calls = JSON.parse(await post('/calls'));
const writes = calls.filter((c) => !c.startsWith('GET')).join(' | ');
check('the panel and Check only read at the sender — two writes in all: the domain added, one "check again"', writes === 'POST /domains | POST /domains/d-e2e/verify', writes);

// ── 5b. From addresses: media@ offered for press, another domain refused, defaults ──
const FROMS = `${EMAIL} section[aria-label="From addresses"]`;
row = await openServices(page);
await page.locator(`${FROMS} [data-testid="sender-row"]`).first().waitFor({ timeout: 8000 });
w = await words(page.locator(FROMS));
check('From addresses: the campaign’s own address first, "Always available", and the one-tap media@ offer', /Sample Campaign team@campaign\.example\.org Always available/.test(w)
  && w.includes(`Add media@${DOMAIN} for press`), w.slice(0, 260));
await page.locator(`${FROMS} button:has-text("Add media@")`).click();
check('…the offer fills in media@ and says which domain', (await page.inputValue('#sa-email')) === `media@${DOMAIN}` && (await words(page.locator(FROMS))).includes(`Addresses at ${DOMAIN} only.`));
await page.locator(`${FROMS} button:has-text("Save")`).click();
await page.locator(`${FROMS} .sa-said`).waitFor({ timeout: 8000 }).catch(() => {});
w = await words(page.locator(FROMS));
check('saved: media@ is the default for press, the offer gone', w.includes(`Added media@${DOMAIN} — the default for press`) && /media@campaign\.example\.org Default for press/.test(w) && !/for press Add media@/.test(w), w.slice(0, 400));
await page.locator(`${FROMS} button:has-text("Add an address")`).click();
await page.fill('#sa-name', 'Elsewhere');
await page.fill('#sa-email', 'someone@elsewhere.example.org');
await page.locator(`${FROMS} button:has-text("Save")`).click();
await page.locator(`${FROMS} .sa-said.is-bad`).waitFor({ timeout: 8000 }).catch(() => {});
check('another domain: the server’s own sentence, in place', (await words(page.locator(`${FROMS} .sa-said`))) === `Use an address at ${DOMAIN}`, await words(page.locator(`${FROMS} .sa-said`)));
await page.fill('#sa-name', 'Pat Example');
await page.fill('#sa-email', `pat@${DOMAIN}`);
await page.locator(`${FROMS} button:has-text("Save")`).click();
await page.locator(`${FROMS} [data-testid="sender-row"]:has-text("pat@")`).waitFor({ timeout: 8000 });
await page.locator(`${FROMS} [data-testid="sender-row"]:has-text("pat@") .disclose`).click();
await page.locator(`${FROMS} [data-testid="sender-row"]:has-text("pat@") button:has-text("Make default for email")`).click();
await page.locator(`${FROMS} [data-testid="sender-row"]:has-text("pat@") .chip:has-text("Default for email")`).waitFor({ timeout: 8000 }).catch(() => {});
const senders = (await api('/senders')).json;
check('Make default for email: Pat’s row says so, and the API agrees', (await words(page.locator(`${FROMS} [data-testid="sender-row"]:has-text("pat@")`))).includes('Default for email')
  && senders.defaults.email === senders.senders.find((s) => s.email === `pat@${DOMAIN}`)?.id && senders.defaults.press === senders.senders.find((s) => s.email === `media@${DOMAIN}`)?.id, JSON.stringify(senders.defaults));
check('the defaults are on the log', ((await api('/events?since=0&limit=1000')).json?.events || []).filter((e) => e.action?.startsWith('sender.')).length === 4, 'media@ saved and made the press default, Pat saved and made the email default');
await shot(page.locator(FROMS), '05b-from-addresses-1440');
prow = await openServices(phone);
await phone.locator(`${FROMS} [data-testid="sender-row"]`).first().waitFor({ timeout: 8000 });
pm = await phone.locator(FROMS).evaluate((el) => {
  const btns = [...el.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height > 0);
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, minTap: Math.min(...btns.map((b) => Math.round(b.getBoundingClientRect().height))) };
});
check('From addresses at 390: no sideways scroll, every button ≥ 48px', pm.overflow <= 0 && pm.minTap >= 48, JSON.stringify(pm));
await shot(phone.locator(FROMS), '05b-from-addresses-390');
// Outreach → Email's compose: the From line, Pat by default, Change to media@.
await page.goto(`${ADMIN}/outreach/email?new=1`, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="sender-pick"] .sp-addr').waitFor({ timeout: 10000 });
const fromLine = await words(page.locator('[data-testid="sender-pick"]'));
check('Outreach → Email: "From: Pat Example <pat@…> · Change"', fromLine === `From: Pat Example <pat@${DOMAIN}> · Change`, fromLine);
await page.locator('.sp-change').click();
check('…Change offers the campaign’s own address and both added', (await words(page.locator('.sp-chips'))) === `Sample Campaign <team@${DOMAIN}> Sample Campaign Media <media@${DOMAIN}> Pat Example <pat@${DOMAIN}>`, await words(page.locator('.sp-chips')));
await shot(page.locator('.ot-compose'), '05b-email-from-1440');
await phone.goto(`${ADMIN}/outreach/email?new=1`, { waitUntil: 'domcontentloaded' });
await phone.locator('[data-testid="sender-pick"] .sp-addr').waitFor({ timeout: 10000 });
await shot(phone.locator('.ot-compose'), '05b-email-from-390');
// Back to the campaign's own address for the sends below (their checks count on it).
for (const s of senders.senders) await act('sender.remove', { id: s.id });

// ── 6. A sending-only key, a DMARC lookup that fails, a sender that doesn't answer ──
await set({ sendingOnly: true, txt: {} });
prow = await openServices(phone);
pw = await words(prow);
pm = await measure(prow);
check('a sending-only key: said plainly, no Add domain; the DMARC line is still base.win’s own', /A sending-only key can’t show the records: use a full-access key, or Resend’s own screen\./.test(pw)
  && !/Add domain/.test(pw) && /DMARC · TXT Not found yet/.test(pw) && pm.overflow <= 0 && pm.minTap >= 48, pw.slice(120, 400));
await shot(prow, '06-sending-only-390');
await set({ sendingOnly: false, dnsDown: true });
row = await openServices(page);
m = await measure(row);
check('the DMARC lookup itself failed: "Couldn’t look it up", never "Not found yet"', m.chips.join('|') === 'Verified|In|In|In|Couldn’t look it up', m.chips.join('|'));
await set({ dnsDown: false, txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none']] }, env: { RESEND_API_BASE: 'http://127.0.0.1:9' } });
row = await openServices(page);
w = await words(row);
check('the sender doesn’t answer: "Unavailable — Resend didn’t answer… Try again", never an empty panel', /Sending domain Unavailable — Resend didn’t answer[^.]*\. Try again/.test(w), w.slice(100, 260));
await shot(row, '07-unavailable-1440');
await set({ env: { RESEND_API_BASE: `http://127.0.0.1:${FAKE}` } });
await page.locator(`${EMAIL} .sd button:has-text("Try again")`).click();
await page.locator(`${EMAIL} .sd-recs`).waitFor({ timeout: 8000 }).catch(() => {});
check('Try again brings the panel back', /4 of 4 in/.test(await words(row)), (await words(row)).slice(100, 220));

// ── 7. A send, and what the sender says about it ──
const people = ['Ana', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ida', 'Jo', 'Kai', 'Lee'];
const addr = (p) => `${p.toLowerCase()}@example.org`;
for (const p of people) await act('subscription.add', { email: addr(p), name: `${p} Example` });
const sent = await act('blast.send', { kind: 'newsletter', subject: 'October update', body: 'Hello — here is what we did this month.' });
check('a newsletter to twelve: every email carries its recipient’s row as the ref', sent.status === 200 && sent.json.counts.sent === 12
  && JSON.parse(await post('/sent')).filter((x) => /^[0-9a-f-]{36}$/.test(x.ref || '')).length === 12, JSON.stringify(sent.json?.counts));
const openPast = async (p) => {
  await p.goto(`${ADMIN}/outreach/email`, { waitUntil: 'domcontentloaded' });
  await p.locator('.ot-more').first().waitFor({ timeout: 10000 });
  await p.locator('.ot-more').first().click();
  await p.locator('section[aria-label="Past sends"] .ot-item').first().waitFor({ timeout: 10000 });
  await sleep(600);
  return p.locator('section[aria-label="Past sends"]');
};
let past = await openPast(page);
check('before the sender says anything the send says "sent", as it always did — no delivery line', /October update/.test(await words(past)) && !(await page.$('[data-testid="delivery-stats"]')), (await words(past)).slice(0, 200));
check('a forged delivery event is refused', (await event('bounced', addr('Ana'), { forge: true })) === 400);
const statuses = [];
for (const p of people.slice(0, 8)) statuses.push(await event('delivered', addr(p)));
statuses.push(await event('bounced', addr('Ida'), { detail: 'No such mailbox' }), await event('bounced', addr('Jo'), { detail: 'No such mailbox' }));
statuses.push(await event('delivered', addr('Kai')), await event('complained', addr('Kai')));
check('the sender’s signed events are taken (200 each)', statuses.every((s) => s === 200), statuses.join(','));
past = await openPast(page);
await page.locator('[data-testid="delivery-stats"]').first().waitFor({ timeout: 10000 }).catch(() => {});
const line = await words(page.locator('[data-testid="delivery-stats"]').first());
check('the send’s row: "Delivered 9 of 12 · 2 bounced · 1 spam complaint", who is left off, and Gmail’s line', line === 'Delivered 9 of 12 2 bounced 1 spam complaint Those addresses are left off from now on. 8.3% marked it as spam. Gmail’s limit is 0.1%.', line);
const stat = (await api('/blasts/stats')).json.stats.find((s) => s.id === sent.json.blast.id);
check('…the numbers the API counted', [stat.delivered, stat.confirmed, stat.bounced, stat.complained].join(',') === '10,9,2,1', JSON.stringify([stat.delivered, stat.confirmed, stat.bounced, stat.complained]));
await shot(past, '08-past-sends-1440');
const subsHead = await words(page.locator('section[aria-label="Subscribers"] .ot-sec-h'));
const subs = (await api('/subscriptions')).json;
check('Subscribers: two can’t be emailed (they bounced), one unsubscribed (the complaint) — marked on their rows', /11 · 2 can’t be emailed · 1 unsubscribed/i.test(subsHead)
  && subs.subscribed === 11 && subs.emailable === 9 && (await page.locator('section[aria-label="Subscribers"] .chip:has-text("can’t be emailed")').count()) === 2, `${subsHead} · ${subs.subscribed}/${subs.emailable}`);
past = await openPast(phone);
await phone.locator('[data-testid="delivery-stats"]').first().waitFor({ timeout: 10000 }).catch(() => {});
const pOver = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('at 390: the same line on the send’s row, no sideways scroll', (await words(phone.locator('[data-testid="delivery-stats"]').first())).startsWith('Delivered 9 of 12 2 bounced 1 spam complaint') && pOver <= 0, `overflow ${pOver}`);
await shot(past, '08-past-sends-390');
// The next send leaves the three out, and says how many it reaches before it goes.
await page.goto(`${ADMIN}/outreach/email?new=1`, { waitUntil: 'domcontentloaded' });
await page.locator('#em-to').waitFor({ timeout: 10000 });
await sleep(600);
const toLine = await words(page.locator('#em-to option[value="newsletter"]'));
check('Write an email → To: "Newsletter subscribers — 9": who it would reach', toLine === 'Newsletter subscribers — 9', toLine);
const next = await act('blast.send', { kind: 'newsletter', subject: 'November update', body: 'Hello again.' });
const to = JSON.parse(await post('/sent')).filter((x) => x.subject === 'November update').map((x) => x.to).sort();
check('the next newsletter goes to nine: never the two that bounced, never the one who complained', next.json?.counts?.total === 9 && to.length === 9
  && !to.includes(addr('Ida')) && !to.includes(addr('Jo')) && !to.includes(addr('Kai')), `${next.json?.counts?.total} · ${to.join(' ')}`);
check('the books verify', (await api('/audit/verify')).json?.ok === true);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill('SIGTERM');
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
if (fails) console.log(serverLog.split('\n').slice(-15).join('\n'));
process.exit(fails ? 1 : 0);
