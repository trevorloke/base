// Letters to the editor and op-eds — browser check. A fresh in-memory server
// with a stand-in for Resend (server/test/fake-mail.js); a manager on a
// laptop (1440×900) and volunteers on a phone (390×844):
//   · the manager adds an outlet (Example Daily, 250 words, asks writers to
//     say if they work with a campaign) and puts a contact on Letters editors
//     and Show hosts; Copy emails; a release's "Only:";
//   · a volunteer sees "Letters to the editor" on Today, the disclosure
//     reminder with its switch, writes a letter that can't reach the server
//     (the route blocked), sees it in the outbox, reloads mid-draft and
//     finds the draft; meanwhile the manager removes Example Daily; back
//     online the letter lands as New with no paper, "Pick a paper again",
//     its text intact; the draft is cleared only after it lands;
//   · a refused letter: Copy text and Back to draft, which restores the text;
//   · staff see "N letters" in Needs you, suggest an edit with two changes
//     and a note (one email to the writer); the volunteer sees "Your letters
//     · 1 reply", takes one change, saves, and agrees → Ready (the confirm
//     shows the campaign's share); a second letter: Keep mine → Ready;
//   · Send it: the rules line and count, an editable subject, the mail
//     link's address, subject and body (no address line), the text on the
//     clipboard, I sent it → Sent; staff paste the link → Published; a
//     second paper while the first is still out is greyed "Still out at…";
//     a form paper's Copy my letter and Open the paper's form;
//   · a letter repeating the talking points says so to the writer; one
//     sharing a run with another writer's letter warns staff only;
//   · sign-out asks "1 letter not sent"; the next volunteer on the same
//     phone finds no draft and no one else's sign-off;
//   · a volunteer granted Media sees the "On" chips, no Letters tab, no
//     Copy emails, and the queue is refused.
// Every phone screen: at most one yellow button, no sideways scroll, every
// button at least 48 px.
//
//   (cd web && npm run build)  then  node e2e-letters.mjs   (PORT 5480 by
//   default, SHOTS optional; the stand-in sender listens on PORT+1 and the
//   test's controls on PORT+2)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 5480;
const FAKE = PORT + 1;
const CONTROL = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-letters';
mkdirSync(SHOTS, { recursive: true });
const DOMAIN = 'campaign.example.org';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const href = (p) => JSON.stringify(pathToFileURL(`${serverDir}${p}`).href);
const STUB = `${SHOTS}/letters-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
const { startFakeMail } = await import(${href('test/fake-mail.js')});
const fake = await startFakeMail({ provider: 'resend', port: ${FAKE} });
createServer(async (req, res) => {
  for await (const c of req) void c;
  if (req.url === '/sent') return res.end(JSON.stringify(fake.sent.map((x) => ({ to: x.to, subject: x.subject, text: x.body?.text || '', html: x.body?.html || '' }))));
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);

const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off' };
for (const k of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE', 'MAIL_FROM', 'STARBASE_PUBLIC_URL']) delete env[k];
Object.assign(env, { RESEND_API_KEY: 're_e2e_letters', RESEND_API_BASE: `http://127.0.0.1:${FAKE}`, MAIL_FROM: `Sample Campaign <team@${DOMAIN}>`, STARBASE_PUBLIC_URL: BASE });
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
const sentMail = async () => JSON.parse(await fetch(`http://127.0.0.1:${CONTROL}/sent`).then((r) => r.text()));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const CLIP = ['clipboard-read', 'clipboard-write'];
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', permissions: CLIP };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', permissions: CLIP };
const desk = await browser.newContext(DESK);
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Sample Campaign');
await page.fill('#su-email', 'marco@mail.example.org');
await page.fill('#su-password', 'sample-campaign-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const api = async (p, path, body) => {
  const r = body === undefined ? await p.request.get(`${BASE}/api${path}`) : await p.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const act = (name, input, p = page) => api(p, `/actions/${name}`, input);
const words = async (loc) => ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const settle = async (p) => { await p.waitForLoadState('networkidle').catch(() => {}); await sleep(300); };
const goDesk = async (p, path) => { await p.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await p.locator('.md-page, .today, main').first().waitFor({ timeout: 10000 }); await settle(p); };
const goField = async (p, path, sel = '.lt-page') => { await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }); await p.locator(sel).first().waitFor({ timeout: 10000 }); await settle(p); };
const measure = (p, root) => p.evaluate((sel) => {
  const vis = (x) => { const r = x.getBoundingClientRect(); const s = getComputedStyle(x); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
  const main = document.querySelector(sel) || document.body;
  const btns = [...main.querySelectorAll('button, a.btn')].filter(vis);
  const small = btns.filter((b) => Math.round(b.getBoundingClientRect().height) < 48).map((b) => `${b.innerText.trim().slice(0, 30)}:${Math.round(b.getBoundingClientRect().height)}`);
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    primary: [...document.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.innerText.trim()),
    small,
  };
}, root);
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// The same screen at the other size too (desk ↔ phone width).
const both = async (p, name) => {
  const was = p.viewportSize();
  await shot(p, `${name}-${was.width}`);
  const other = was.width > 600 ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  await p.setViewportSize(other); await sleep(350);
  await shot(p, `${name}-${other.width}`);
  await p.setViewportSize(was); await sleep(250);
};
const phoneOk = async (p, name, root = '.lt-page') => {
  const m = await measure(p, root);
  check(`${name} at 390: no sideways scroll, every button ≥ 48 px, at most one yellow button`, m.overflow <= 0 && m.small.length === 0 && m.primary.length <= 1, JSON.stringify(m));
};
const LONG = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i % 17}`).join(' ');

// ── 1. The manager adds an outlet, and a contact on two lists ──
await goDesk(page, '/media/outlets');
check('Outlets, empty: "Add the papers your volunteers write to." and one yellow button',
  /Add the papers your volunteers write to\./.test(await words(page.locator('.md-page'))) && (await measure(page, '.md-page')).primary.join('|') === 'Add an outlet');
await both(page, '01-outlets-empty');
await page.click('button:has-text("Add an outlet")');
await page.fill('#lt-o-name', 'Example Daily');
await page.fill('#lt-o-letters_email', 'letters@example.org');
await page.fill('#lt-o-letters_limit', '250');
await page.fill('#lt-o-rules', 'Name and city printed; phone for checking');
await page.click('.lt-outlet-sheet button.disclose');
await page.click('label:has-text("Asks writers to say if they work with a campaign")');
await page.click('.lt-outlet-sheet button[type="submit"]');
await settle(page);
let outlets = (await api(page, '/media/outlets')).json.outlets;
const daily1 = outlets.find((o) => o.name === 'Example Daily');
check('the outlet is added: 250 words, disclose on, asks phone, exclusive', daily1?.letters_limit === 250 && daily1.disclose && daily1.asks_phone && daily1.exclusive, JSON.stringify(daily1));
check('its row: "Letters ≤250" and "Rules not checked"', /Example Daily.*Letters ≤250.*Rules not checked/.test(await words(page.locator('.ot-list'))), await words(page.locator('.ot-list')));
await page.click('.ot-list button:has-text("Example Daily")');
await page.locator('.lt-outlet-sheet').waitFor();
await both(page, '02-outlet-sheet');
await page.click('.lt-outlet-sheet button:has-text("I checked these today")');
await settle(page);
check('"I checked these today" → "Rules checked"', /Rules checked/.test(await words(page.locator('.ot-list'))));
// The day as it is in Surrey (a date alone, never read as UTC midnight).
const TODAY = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/Vancouver' });
check(`…on today’s date in Surrey: "Rules checked ${TODAY}"`, (await words(page.locator('.ot-list'))).includes(`Rules checked ${TODAY}`), await words(page.locator('.ot-list')));
await both(page, '03-outlets-filled');

await act('media.contact.add', { name: 'Dana Example', kind: 'media', email: 'dana@example.org', outlet: 'Example Daily' });
await act('media.contact.add', { name: 'Lee Example', kind: 'media', email: 'lee@example.org', outlet: 'Example Radio' });
await goDesk(page, '/media/contacts');
await page.click('button.md-name:has-text("Dana Example")');
await page.click('.md-sheet button:has-text("Edit")');
await page.click('.md-form button:has-text("Letters editors")');
await page.click('.md-form button:has-text("Show hosts")');
await page.fill('#md-e-outlet', 'Example Dail');
await sleep(200);
check('the outlet field: "Not one of your outlets" for a name that isn’t one', /Not one of your outlets/.test(await words(page.locator('.md-form'))));
await page.fill('#md-e-outlet', 'Example Daily');
await both(page, '04-contact-edit-on');
await page.click('.md-form button[type="submit"]');
await settle(page);
let dana = (await api(page, '/media/contacts')).json.contacts.find((c) => c.person.name === 'Dana Example');
check('Dana is on Letters editors and Show hosts', JSON.stringify(dana?.lists) === '["letters","show"]', JSON.stringify(dana?.lists));
check('the desk table has an "On" column with her lists', /On/.test(await words(page.locator('.md-table thead'))) && /Letters editors, Show hosts/.test(await words(page.locator('.md-table tbody'))));
await page.click('.md-filter button:has-text("Letters editors")');
await settle(page);
const copyBtn = page.locator('button:has-text("Copy emails")');
check('a list picked: "Copy emails (1)"', (await words(copyBtn)) === 'Copy emails (1)', await words(copyBtn));
await copyBtn.click();
await sleep(300);
check('…which copies her address', (await page.evaluate(() => navigator.clipboard.readText())).includes('dana@example.org'));
await both(page, '05-contacts-on');
await goDesk(page, '/media?new=1');
await page.click('.ot-audience button.disclose');
await page.click('.ot-audience button:has-text("Show hosts")');
await sleep(300);
check('a release\'s "Only: Show hosts" counts only Dana', /Send to 1/.test(await words(page.locator('.md-page'))), (await measure(page, '.md-page')).primary.join('|'));
await both(page, '06-release-only');

// ── 2. A volunteer on a phone ──
const invite = async (email, name) => {
  const inv = (await act('member.invite', { email, role: 'volunteer' })).json;
  return { token: inv.joinUrl.split('/join/')[1], name };
};
const vee = await invite('vee@example.org', 'Vee Example');
const vctx = await browser.newContext(PHONE);
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push(`vol: ${e.message}`));
const veeJoin = await vp.request.post(`${BASE}/api/auth/join`, { data: { token: vee.token, name: vee.name, password: 'letters-pass-2026' } });
const veeId = (await veeJoin.json()).user.id;
await goField(vp, '/', '.today, main');
let t = await words(vp.locator('main'));
check('Today (volunteer): "Letters to the editor", no setting needed', /Letters to the editor/.test(t), t.slice(0, 300));
await shot(vp, '07-today-volunteer-390');
await goField(vp, '/letters');
check('Your letters, empty: "Write to the paper in your own words." and the one button', /Write to the paper in your own words\./.test(await words(vp.locator('.lt-page'))));
await phoneOk(vp, 'Your letters (empty)');
await both(vp, '08-letters-empty');

await vp.click('a:has-text("Write a letter")');
await vp.locator('#lt-body').waitFor();
await settle(vp);
await vp.click('.lt-chips button:has-text("Example Daily")');
t = await words(vp.locator('.lt-page'));
check('the paper\'s rules: "≤ 250 words · only to them" and its line', /≤ 250 words · only to them/.test(t) && /Name and city printed; phone for checking/.test(t), t.slice(0, 400));
check('the disclosure reminder with its switch, off for a volunteer', /This paper asks you to say if you work with a campaign\./.test(t)
  && /I volunteer with Sample Campaign/.test(t) && !(await vp.locator('.lt-remind input[type="checkbox"]').isChecked()));
// No signal for letters: the action's route is blocked.
await vp.route('**/api/actions/myletter.submit', (r) => r.abort('internetdisconnected'));
const BODY1 = `Our parks need more trees. ${LONG(60, 'leaf')} Plant them this year.`;
await vp.fill('#lt-body', BODY1);
await vp.fill('#lt-title', 'Parks for everyone');
await sleep(800);
await vp.reload({ waitUntil: 'domcontentloaded' });
await vp.locator('#lt-body').waitFor();
await settle(vp);
check('reloaded mid-draft: the draft is still here', (await vp.inputValue('#lt-body')) === BODY1 && (await vp.inputValue('#lt-title')) === 'Parks for everyone');
await vp.click('button:has-text("Send to the campaign")');
await sleep(800);
t = await words(vp.locator('.lt-page'));
check('sent with no way through: "Waiting to send" on the form', /Waiting to send|saved on this phone/i.test(t), t.slice(-200));
const draftKey = () => vp.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':letters:draft')).length);
check('…and the draft is still kept while it waits', (await draftKey()) === 1);
await vp.click('.offline-strip__chip');
await sleep(300);
check('the outbox lists it: "Letter: Our parks need more trees."', /Letter: Our parks need more trees\./.test(await words(vp.locator('.obx-sheet'))), await words(vp.locator('.obx-sheet')));
await vp.click('.obx-sheet button[aria-label="Close"]');
// Meanwhile the manager takes Example Daily off the list.
check('meanwhile the manager removes Example Daily', (await act('media.outlet.remove', { id: daily1.id })).status === 200);
await vp.unroute('**/api/actions/myletter.submit');
await vp.click('.offline-strip button:has-text("Send now")');
await vp.waitForURL(/\/letters\/[0-9a-f-]{36}$/, { timeout: 10000 }).catch(() => {});
await settle(vp);
const letter1 = vp.url().split('/letters/')[1];
t = await words(vp.locator('.lt-page'));
check('back online: the letter lands as New with no paper, "Pick a paper again", text intact',
  /New/.test(t) && /Pick a paper again/.test(t) && t.includes('Our parks need more trees.') && t.includes('Plant them this year'), t.slice(0, 300));
check('…and only now is the draft cleared', (await draftKey()) === 0);
await vp.reload({ waitUntil: 'domcontentloaded' });
await vp.locator('.lt-page h1').waitFor();
await settle(vp);
t = await words(vp.locator('.lt-page'));
check('reloaded: the dropped paper is still named, "Pick a paper again"', /Example Daily isn’t on the campaign’s list any more/.test(t) && /Pick a paper again/.test(t), t.slice(0, 300));

// The paper again, and a second one at another newsroom.
const daily = (await act('media.outlet.save', { name: 'Example Daily', kind: 'paper', letters_email: 'letters@example.org', letters_limit: 250, disclose: true, rules: 'Name and city printed; phone for checking', newsroom: 'Example Daily newsroom' })).json;
const weekly = (await act('media.outlet.save', { name: 'Example Weekly', kind: 'paper', letters_email: 'weekly@example.org', letters_limit: 300, newsroom: 'Weekly newsroom' })).json;
const online = (await act('media.outlet.save', { name: 'Example Online', kind: 'online', letters_form: 'https://example.org/letters-form', letters_limit: 400, exclusive: false })).json;
outlets = (await api(page, '/media/outlets')).json.outlets;
const oid = (n) => outlets.find((o) => o.name === n).id;
check('outlets added again (Example Daily, Example Weekly, Example Online)', [daily, weekly, online].every(Boolean) && outlets.length === 3);
await vp.click('button:has-text("Pick a paper again")');
await vp.click('.lt-remind button:has-text("Example Daily")');
await vp.click('.lt-remind button:has-text("Save")');
await settle(vp);
check('a paper picked again', /Example Daily/.test(await words(vp.locator('.lt-page'))) && !/Pick a paper again/.test(await words(vp.locator('.lt-page'))));

// ── 3. A refused letter: Copy text, Back to draft ──
const BODY2 = `Bike lanes keep everyone safer on our busy roads. ${LONG(40, 'lane')}`;
await goField(vp, '/letters/new');
await vp.route('**/api/actions/myletter.submit', (r) => r.abort('internetdisconnected'));
await vp.fill('#lt-body', BODY2);
await vp.click('.lt-chips button:has-text("Example Daily")');
await vp.click('.lt-chips button:has-text("Example Weekly")');
await vp.click('button:has-text("Send to the campaign")');
await sleep(600);
await vp.unroute('**/api/actions/myletter.submit');
await vp.route('**/api/actions/myletter.submit', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'that letter can’t be taken' }) }));
await vp.click('.offline-strip button:has-text("Send now")');
await sleep(800);
await vp.click('.offline-strip__chip');
await sleep(300);
t = await words(vp.locator('.obx-sheet'));
check('refused: the outbox shows the reason, "Copy text" and "Back to draft"', /That letter can’t be taken/.test(t) && /Copy text/.test(t) && /Back to draft/.test(t), t);
await shot(vp, '09-refused-390');
t = await words(vp.locator('.lt-form'));
check('…and the write screen no longer says it sends soon', /Not taken — open the outbox: Back to draft or Copy text\./.test(t) && !/sends soon/.test(t), t.slice(-200));
await vp.click('.obx-sheet button:has-text("Copy text")');
await sleep(300);
check('Copy text copies the letter', (await vp.evaluate(() => navigator.clipboard.readText())) === BODY2);
await vp.click('.obx-sheet button:has-text("Back to draft")');
await vp.waitForURL(/\/letters\/new$/, { timeout: 5000 }).catch(() => {});
await vp.locator('#lt-body').waitFor();
await settle(vp);
check('Back to draft restores the text (and the item is gone)', (await vp.inputValue('#lt-body')) === BODY2 && !(await vp.locator('.offline-strip__chip').count()));
await vp.unroute('**/api/actions/myletter.submit');
await vp.click('button:has-text("Send to the campaign")');
await vp.waitForURL(/\/letters\/[0-9a-f-]{36}$/, { timeout: 10000 }).catch(() => {});
const letter2 = vp.url().split('/letters/')[1];
check('the second letter lands, to Example Daily and Example Weekly', JSON.stringify((await api(vp, `/letters/mine/${letter2}`)).json?.letter?.outlets.map((o) => o.name)) === '["Example Daily","Example Weekly"]');

// ── 4. Staff suggest; the writer takes one change and agrees ──
await goDesk(page, '/');
t = await words(page.locator('main'));
check('desk Today: "2 letters" in Needs you', /Needs you.*2 letters/.test(t), t.slice(0, 400));
await shot(page, '10-today-desk-1440');
await goDesk(page, '/media/letters');
t = await words(page.locator('.md-page'));
check('Media → Letters: the tab\'s count and both letters in To do', /Letters\s*2/.test(await words(page.locator('.md-tabs'))) && /Parks for everyone/.test(t) && /Bike lanes keep everyone/.test(t), t.slice(0, 300));
check('the queue has no yellow button', (await measure(page, '.md-page')).primary.length === 0);
await both(page, '11-queue');
await page.click('.lt-title:has-text("Parks for everyone")');
await page.locator('.lt-desk').waitFor();
await settle(page);
const NEW_SENTENCE = 'Every neighbourhood deserves shade in summer, quiet benches for older neighbours, safe paths for children walking to school, and a place where families can meet without paying anything at all, which is what a good park gives a city that wants to grow kindly and well over the next twenty years of building and change across every block we share together today.';
const SUGG1 = BODY1.replace('Our parks', 'Surrey’s parks').replace('Plant them this year.', NEW_SENTENCE);
await page.click('button:has-text("Suggest an edit")');
await page.fill('#lt-sug', SUGG1);
await page.fill('#lt-sug-note', 'Two ideas — keep what you like.');
await both(page, '12-desk-suggest');
await page.click('button:has-text("Send the suggestion")');
await settle(page);
check('the suggestion is sent; the writer\'s text is unchanged', /Suggestion sent/.test(await words(page.locator('.md-page'))));
await both(page, '13-desk-letter');
let mail = [];
for (let i = 0; i < 20 && !mail.length; i += 1) {
  mail = (await sentMail()).filter((m) => JSON.stringify(m.to).includes('vee@example.org') && !/^Join /.test(m.subject));
  if (!mail.length) await sleep(250);
}
check('one email to the writer: "The campaign replied about your letter", the link, none of the letter', mail.length === 1
  && mail[0].subject === 'The campaign replied about your letter' && mail[0].text.includes(`/letters/${letter1}`) && !/parks|trees|Two ideas/i.test(mail[0].text), JSON.stringify(mail).slice(0, 300));
await goField(vp, '/', '.today, main');
t = await words(vp.locator('main'));
check('volunteer Today: "Your letters · 1 reply"', /Your letters · 1 reply/.test(t), t.slice(0, 300));
await shot(vp, '14-today-reply-390');
await goField(vp, '/letters');
check('Your letters: the "Reply" mark', /Reply/.test(await words(vp.locator('.lt-page'))));
await phoneOk(vp, 'Your letters (with letters)');
await both(vp, '15-letters-list');
await goField(vp, `/letters/${letter1}`);
check('the suggestion: two changes, each with Take and Leave (Leave chosen)', (await vp.locator('.lt-take').count()) === 2
  && (await vp.locator('.lt-take button[aria-checked="true"]:has-text("Leave")').count()) === 2, `${await vp.locator('.lt-take').count()} · ${await words(vp.locator('.lt-diff'))}`.slice(0, 600));
check('…and the note under it', /Two ideas — keep what you like\./.test(await words(vp.locator('.lt-sugg'))));
await phoneOk(vp, 'A letter with a suggestion');
await both(vp, '16-suggestion');
await vp.locator('.lt-take').nth(1).locator('button:has-text("Take")').click();
await vp.click('button:has-text("Save my letter")');
await vp.locator('#lt-edit').waitFor();
const merged = await vp.inputValue('#lt-edit');
check('Save my letter: the long change taken, the first word left', merged.includes('Every neighbourhood deserves shade') && merged.startsWith('Our parks'), merged.slice(0, 80));
await vp.click('form[aria-label="Your letter"] button[type="submit"]');
await vp.locator('button:has-text("This is my final text")').waitFor({ timeout: 8000 }).catch(() => {});
await vp.click('button:has-text("This is my final text")');
t = await words(vp.locator('.lt-page'));
check('the confirm: "Send this exact text, in your name, to the paper?" with the campaign\'s share', /Send this exact text, in your name, to the paper\?/.test(t) && /About \d+% of these words are the campaign’s — still yours to send\?/.test(t), t.slice(-400));
await phoneOk(vp, 'The final-text confirm');
await both(vp, '17-final-confirm');
await vp.click('.lt-confirm button:has-text("Yes")');
await settle(vp);
check('agreed → Ready to send', /Ready to send/.test(await words(vp.locator('.lt-head'))));

// A second letter: suggest → Keep mine → final → Ready.
const l2 = (await api(page, `/media/letters/${letter2}`)).json.letter;
await act('letter.suggest', { id: letter2, body: l2.drafts[0].body.replace('Bike lanes', 'Protected bike lanes') });
await goField(vp, `/letters/${letter2}`);
await vp.click('.lt-sugg button.disclose');
await vp.click('button:has-text("Keep mine")');
await vp.locator('button:has-text("This is my final text")').waitFor({ timeout: 8000 }).catch(() => {});
await vp.click('button:has-text("This is my final text")');
await vp.click('.lt-confirm button:has-text("Yes")');
await settle(vp);
const l2w = (await api(vp, `/letters/mine/${letter2}`)).json.letter;
check('Keep mine → This is my final text → Ready, on the writer\'s own words', l2w.status === 'ready' && l2w.drafts.find((d) => d.id === l2w.agreed_version)?.body === BODY2);

// ── 5. Send it ──
await goField(vp, `/letters/${letter1}`);
await vp.click('button:has-text("Send it")');
await vp.locator('.lt-sheet').waitFor();
t = await words(vp.locator('.lt-sheet'));
check('Send it: the rules line and the count against 250', /≤ 250 words/.test(t) && /\/ 250 words/.test(t), t.slice(0, 300));
await vp.fill('#lt-subject', 'Shade for every neighbourhood');
await vp.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a[href^="mailto:"]')) e.preventDefault(); }));
await vp.fill('#lt-so-city', 'Surrey');
await vp.click('a:has-text("Open my email")');
await sleep(200);
check('no phone yet: "Add your phone — the paper calls to check"', /Add your phone — the paper calls to check/.test(await words(vp.locator('.lt-sheet'))));
await vp.fill('#lt-so-city', 'Surrey');
await vp.fill('#lt-so-phone', '604-555-0123');
await phoneOk(vp, 'Send it (email paper)');
await both(vp, '18-send-email');
const mailto = decodeURIComponent(await vp.getAttribute('a:has-text("Open my email")', 'href'));
check('the mail link: the paper\'s address, the typed subject, the agreed text and the sign-off, no address line',
  mailto.startsWith('mailto:letters@example.org?subject=Shade for every neighbourhood&body=Our parks need more trees.')
  && mailto.includes('Every neighbourhood deserves shade') && mailto.includes('Vee Example\nSurrey\n604-555-0123') && !/Address/.test(mailto), mailto.slice(0, 160));
await vp.click('a:has-text("Open my email")');
await sleep(400);
const clip = await vp.evaluate(() => navigator.clipboard.readText());
check('the tap copied the text and sign-off first', clip.startsWith('Our parks need more trees.') && clip.endsWith('604-555-0123'), clip.slice(-60));
check('…and says so', /copied/i.test(await words(vp.locator('.lt-sheet'))));
await vp.click('button:has-text("I sent it")');
await settle(vp);
check('I sent it → Sent', /Sent/.test(await words(vp.locator('.lt-head'))) && /Sent to Example Daily/.test(await words(vp.locator('.lt-page'))));
await goDesk(page, `/media/letters/${letter1}`);
await page.click('button:has-text("Published: paste the link")');
await page.fill('#lt-purl', 'https://example.org/letters/shade');
await page.click('form.ot-confirm button[type="submit"]');
await settle(page);
const l1w = (await api(vp, `/letters/mine/${letter1}`)).json.letter;
check('staff paste the link → Published, and the writer sees it', l1w.status === 'published' && l1w.sends[0].url === 'https://example.org/letters/shade');

// A second paper while the first is still out.
await goField(vp, `/letters/${letter2}`);
await vp.click('button:has-text("Send it")');
await vp.locator('.lt-sheet').waitFor();
await vp.click('.lt-sheet [role="radiogroup"] button:has-text("Example Daily")');
await vp.fill('#lt-so-city', 'Surrey');
await vp.fill('#lt-so-phone', '604-555-0123');
await vp.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a[href^="mailto:"]')) e.preventDefault(); }));
await vp.click('a:has-text("Open my email")');
await vp.click('button:has-text("I sent it")');
await settle(vp);
await vp.click('button:has-text("Send to another paper")');
await vp.locator('.lt-sheet').waitFor();
t = await words(vp.locator('.lt-sheet'));
check('a second paper while the first is out: greyed, "Still out at Example Daily until …", no mail link', /Still out at Example Daily until \d+ \w+/.test(t)
  && !(await vp.locator('.lt-sheet a:has-text("Open my email")').count()) && (await vp.locator('.lt-chip.is-blocked:has-text("Example Weekly")').count()) === 1, t.slice(0, 300));
await both(vp, '19-send-blocked');

// A letter to one paper: once it's there, or turned down, Send it offers the campaign's others.
const BODY4 = `Our libraries should open on Sunday mornings for families. ${LONG(30, 'book')}`;
const letter4 = (await act('myletter.submit', { client_id: '00000000-0000-4000-8000-000000000401', kind: 'letter', body: BODY4, outlet_ids: [oid('Example Weekly')], sign: { city: 'Surrey', phone: '604-555-0123' } }, vp)).json.letter.id;
const l4 = (await api(vp, `/letters/mine/${letter4}`)).json.letter;
await act('myletter.agree', { id: letter4, version_id: l4.drafts[0].id }, vp);
await goField(vp, `/letters/${letter4}`);
await vp.click('button:has-text("Send it")');
await vp.locator('.lt-sheet').waitFor();
check('one paper: Send it picks it', (await words(vp.locator('.lt-sheet .lt-chip.is-on'))) === 'Example Weekly');
await vp.click('button:has-text("I sent it")');
await settle(vp);
await vp.click('button:has-text("Send to another paper")');
await vp.locator('.lt-sheet').waitFor();
t = await words(vp.locator('.lt-sheet'));
check('…"Send to another paper" offers the campaign’s others (greyed while Weekly has it), never "hasn’t added papers"',
  /Example Daily/.test(t) && /Example Online/.test(t) && !/hasn’t added papers/.test(t) && /Still out at Example Weekly/.test(t), t.slice(0, 300));
await both(vp, '19b-another-paper');
await vp.click('.lt-sheet button:has-text("Close")');
await vp.click('button:has-text("Not published")');
await settle(vp);
check('Not published → Ready, "Not printed at Example Weekly"', /Not printed at Example Weekly/.test(await words(vp.locator('.lt-head'))));
await vp.click('button:has-text("Send it")');
await vp.locator('.lt-sheet').waitFor();
await vp.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a[href^="mailto:"]')) e.preventDefault(); }));
const picked4 = await words(vp.locator('.lt-sheet .lt-chip.is-on'));
check('…Send it again: another paper picked, and the mail link goes to it', picked4 === 'Example Daily'
  && (await vp.getAttribute('a:has-text("Open my email")', 'href')).startsWith('mailto:letters@example.org'), picked4);
await phoneOk(vp, 'Send it (after Not published)');
await both(vp, '19c-after-not-printed');
// Sent at Daily while Weekly still had it: the desk's chip names Weekly.
await act('myletter.sent', { id: letter4, outlet_id: oid('Example Weekly'), how: 'email', client_id: '00000000-0000-4000-8000-000000000402' }, vp);
await act('myletter.sent', { id: letter4, outlet_id: oid('Example Daily'), how: 'email', client_id: '00000000-0000-4000-8000-000000000403' }, vp);
await page.setViewportSize({ width: 950, height: 900 });
await goDesk(page, '/media/letters');
await page.click('.md-filter button:has-text("Sent")');
await settle(page);
check('the desk queue at 950 px: a table, and "Sent while out at Example Weekly"', (await page.locator('table.lt-queue').count()) === 1
  && /Sent while out at Example Weekly/.test(await words(page.locator('.md-page'))), (await words(page.locator('.md-page'))).slice(0, 300));
await shot(page, 'g-queue-950');
check('…the Paper column names Example Daily first, where it went', /Example Daily, Example Weekly/.test(await words(page.locator('tr:has-text("Our libraries should open")'))),
  await words(page.locator('tr:has-text("Our libraries should open")')));
await page.setViewportSize({ width: 1440, height: 900 });
await goDesk(page, `/media/letters/${letter4}`);
check('the desk’s letter page: "Letter · … · Example Daily, Example Weekly"', /^Letter · .* · Example Daily, Example Weekly$/.test(await words(page.locator('.md-meta').first())), await words(page.locator('.md-meta').first()));
// Both turned down: Ready again, and the desk can note a paper the letter never named.
for (const s of (await api(vp, `/letters/mine/${letter4}`)).json.letter.sends.filter((x) => !x.outcome)) await act('letter.not_published', { id: letter4, send_id: s.id });
await goDesk(page, `/media/letters/${letter4}`);
await page.click('button:has-text("They told us they sent it")');
await page.locator('[aria-label="Paper"] button:has-text("Example Online")').waitFor({ timeout: 5000 }).catch(() => {});
check('…"They told us they sent it" offers the campaign’s other papers too', (await page.locator('[aria-label="Paper"] button:has-text("Example Online")').count()) === 1,
  await words(page.locator('[aria-label="Paper"]')));
await page.click('[aria-label="Paper"] button:has-text("Example Online")');
await shot(page, 'g-told-any-paper');
await page.click('[aria-label="They told us they sent it"] button:has-text("Save")');
await settle(page);
check('…and the letter is filed under it', /^Letter · .* · Example Online, Example Daily, Example Weekly$/.test(await words(page.locator('.md-meta').first())), await words(page.locator('.md-meta').first()));

// ── 6. Talking points, overlap, a form paper ──
await goDesk(page, '/media/letters');
await page.click('.md-page button.disclose:has-text("More")');
await page.fill('#lt-points', 'Surrey needs more frequent buses on every major road by next spring, says the plan.');
await page.click('form button:has-text("Save")');
await settle(page);
const SHARED = 'the old library on the corner deserves a careful restoration plan soon';
const BODY3 = `I ride the bus daily and we needs more frequent buses on every major road by next year. Also ${SHARED}. ${LONG(250, 'stop')}`;
await goField(vp, '/letters/new');
await vp.click('.lt-chips button:has-text("Example Daily")');
await vp.click('.lt-chips button:has-text("Example Online")');
await vp.fill('#lt-body', BODY3);
await vp.click('.lt-form button.disclose');
await sleep(700);
t = await words(vp.locator('.lt-page'));
check('the write screen: "These words are the campaign’s — say it your way" with the run', /These words are the campaign’s — say it your way: “.*more frequent buses on every major road by next/.test(t), t.slice(0, 600));
check('…the over-limit chip, never a block', /\d+ over/.test(t) && await vp.locator('button:has-text("Send to the campaign")').isEnabled());
check('…and the ideas from the campaign under More details', /Ideas from the campaign/.test(t) && /Say it your way — papers turn away copied words\./.test(t));
await phoneOk(vp, 'Write a letter');
await both(vp, '20-write');
await vp.click('button:has-text("Send to the campaign")');
await vp.waitForURL(/\/letters\/[0-9a-f-]{36}$/, { timeout: 10000 }).catch(() => {});
const letter3 = vp.url().split('/letters/')[1];
// Another writer — the manager — with the same run.
await act('myletter.submit', { client_id: '00000000-0000-4000-8000-000000000301', kind: 'letter', body: `As a longtime resident I think ${SHARED} and more.`, outlet_ids: [oid('Example Daily')] });
await goDesk(page, `/media/letters/${letter3}`);
t = await words(page.locator('.lt-desk'));
check('staff see "Repeats the talking points" and "Shares wording with Marco Example’s letter to Example Daily (same newsroom)"',
  /Repeats the talking points/.test(t) && /Shares wording with Marco Example’s letter to Example Daily \(same newsroom\)/.test(t), t.slice(0, 600));
await both(page, '21-desk-overlap');
await goField(vp, `/letters/${letter3}`);
t = await words(vp.locator('.lt-page'));
check('the writer sees the campaign\'s words, never another writer', /These words are the campaign’s/.test(t) && !/Shares wording|Marco/.test(t));
const l3 = (await api(vp, `/letters/mine/${letter3}`)).json.letter;
await act('myletter.agree', { id: letter3, version_id: l3.drafts[0].id }, vp);
await goField(vp, `/letters/${letter3}`);
await vp.click('button:has-text("Send it")');
await vp.click('.lt-sheet [role="radiogroup"] button:has-text("Example Online")');
await sleep(200);
check('a form paper: "Copy my letter" and "Open the paper’s form" (a new tab)', (await vp.locator('.lt-sheet button:has-text("Copy my letter")').count()) === 1
  && (await vp.getAttribute('.lt-sheet a:has-text("Open the paper’s form")', 'target')) === '_blank'
  && (await vp.getAttribute('.lt-sheet a:has-text("Open the paper’s form")', 'rel')) === 'noopener noreferrer');
await phoneOk(vp, 'Send it (form paper)');
await both(vp, '22-send-form');

// ── 7. Sign-out with a half-written letter; the next volunteer ──
await goField(vp, '/letters/new');
await vp.fill('#lt-body', 'Half a thought about the library');
await sleep(800);
await vp.click('.acct-btn');
await vp.click('.acct-panel button:has-text("Sign out")');
await sleep(800);
t = await words(vp.locator('.acct-confirm'));
check('sign-out asks: "1 letter not sent. Sign out anyway?"', /1 letter not sent\. Sign out anyway\?/.test(t), t);
await shot(vp, '23-signout-390');
await vp.click('.acct-confirm button:has-text("Sign out")');
await vp.waitForURL(`${BASE}/login`, { timeout: 8000 }).catch(() => {});
const wen = await invite('wen@example.org', 'Wen Example');
const wenJoin = await vp.request.post(`${BASE}/api/auth/join`, { data: { token: wen.token, name: wen.name, password: 'letters-pass-2026' } });
const wenId = (await wenJoin.json()).user.id;
await goField(vp, '/letters/new');
await vp.click('.lt-form button.disclose');
check('the next volunteer on this phone: no draft, and no one else\'s sign-off', (await vp.inputValue('#lt-body')) === '' && (await vp.inputValue('#lt-s-name')) === 'Wen Example'
  && !(await vp.evaluate((id) => Object.keys(localStorage).some((k) => k.includes(id)), veeId)));

// ── 8. A volunteer granted Media ──
await act('permission.member.set', { user_id: wenId, grant: ['media'], deny: [] });
check('…the queue is refused to them', (await api(vp, '/media/letters')).status === 403 && (await api(vp, `/media/letters/${letter1}`)).status === 403);
await vp.goto(`${ADMIN}/media/contacts`, { waitUntil: 'domcontentloaded' });
await vp.locator('.md-page').waitFor({ timeout: 10000 });
await settle(vp);
t = await words(vp.locator('.md-page'));
check('they see the "On" chips, and no Letters tab', /Letters editors \(1\)/.test(t) && /Show hosts \(1\)/.test(t) && !/Letters\s*\d*\s*$/.test(await words(vp.locator('.md-tabs'))) && !(await vp.locator('.md-tabs a:has-text("Letters")').count()), t.slice(0, 300));
await vp.click('.md-filter button:has-text("Letters editors")');
await sleep(300);
check('…a list picked: no Copy emails, no address', !(await vp.locator('button:has-text("Copy emails")').count()) && !/dana@example\.org/.test(await words(vp.locator('.md-page'))));
await phoneOk(vp, 'Contacts (volunteer granted Media)', '.md-page');
await shot(vp, '24-volunteer-media-390');

// ── Settings: the wait ──
await goDesk(page, '/settings/campaign');
check('Settings → Campaign: "Wait before another paper (days)" at 10', (await page.inputValue('#lt-wait')) === '10');
await shot(page, '25-settings-1440');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill('SIGTERM');
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? '' : ''}`);
if (failed) { console.log(serverLog.split('\n').filter((l) => /error/i.test(l)).slice(-15).join('\n')); process.exit(1); }
