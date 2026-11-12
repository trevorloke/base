// Media — browser check. A fresh in-memory server with a stand-in for Resend
// (server/test/fake-mail.js); a manager on a laptop (1440×900) and on a phone
// (390×844), and a volunteer granted Media but not Outreach:
//   · Releases, empty: "No releases yet." and the one yellow button;
//   · Contacts: Add a contact (Media, then an influencer with a handle on the
//     phone), "Already in People" for a known email, the "Won’t get
//     releases" chip, the desk table and the phone rows, a contact's sheet;
//   · Write a release: To chips with their counts, From defaulting to the
//     press address (Change for the manager), Send me a test, Send → the
//     confirm names the From → the result; the email went from media@;
//   · a release's page: one open (the pixel fetched), figures, Copy links;
//     a release that failed, then Try again;
//   · the volunteer: contacts with no email or phone and no Add a contact,
//     From with no Change, a picture in the message, a release sent;
//   · an A/B release in its wait: the rest "Wait for the winner", no Try again.
// Every screen: at most one yellow button; at 390 no sideways scroll and
// every button at least 48 px.
//
//   npm run build  then  node e2e-media.mjs   (PORT, SHOTS optional; the
//   stand-in sender listens on PORT+1 and the test's controls on PORT+2)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 4980;
const FAKE = PORT + 1;
const CONTROL = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-media';
mkdirSync(SHOTS, { recursive: true });
const DOMAIN = 'campaign.example.org';
const VIDEO = 'https://www.youtube.com/watch?v=example123';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const href = (p) => JSON.stringify(pathToFileURL(`${serverDir}${p}`).href);
const STUB = `${SHOTS}/media-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
const { startFakeMail } = await import(${href('test/fake-mail.js')});
const fake = await startFakeMail({ provider: 'resend', port: ${FAKE} });
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  if (req.url === '/fail') { fake.fail(j.code || false); return res.end('ok'); }
  if (req.url === '/sent') return res.end(JSON.stringify(fake.sent.map((x) => ({ to: x.to, from: x.from, subject: x.subject, html: x.body?.html || '' }))));
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);

const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off' };
for (const k of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE', 'MAIL_FROM', 'STARBASE_PUBLIC_URL']) delete env[k];
Object.assign(env, { RESEND_API_KEY: 're_e2e_media', RESEND_API_BASE: `http://127.0.0.1:${FAKE}`, MAIL_FROM: `Sample Campaign <team@${DOMAIN}>`, STARBASE_PUBLIC_URL: BASE });
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
const control = (path, body) => fetch(`http://127.0.0.1:${CONTROL}${path}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.text());
const sentMail = async () => JSON.parse(await control('/sent'));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', permissions: ['clipboard-read', 'clipboard-write'] };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' };
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
const phoneCtx = await browser.newContext({ ...PHONE, storageState: await desk.storageState() });
const phone = await phoneCtx.newPage();
phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));

const api = async (p, path, body) => {
  const r = body === undefined ? await p.request.get(`${BASE}/api${path}`) : await p.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const act = (name, input, p = page) => api(p, `/actions/${name}`, input);
const words = async (loc) => ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const settle = async (p) => { await p.waitForLoadState('networkidle').catch(() => {}); await sleep(300); };
const go = async (p, path) => { await p.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await p.locator('.md-page').waitFor({ timeout: 10000 }); await settle(p); };
const measure = (p) => p.evaluate(() => {
  const vis = (x) => { const r = x.getBoundingClientRect(); const s = getComputedStyle(x); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
  const main = document.querySelector('.md-page');
  const btns = [...main.querySelectorAll('button, a.btn')].filter(vis);
  const small = btns.filter((b) => Math.round(b.getBoundingClientRect().height) < 48).map((b) => `${b.innerText.trim().slice(0, 30)}:${Math.round(b.getBoundingClientRect().height)}`);
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    primary: [...document.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.innerText.trim()),
    small,
  };
});
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const phoneOk = async (name) => {
  const m = await measure(phone);
  check(`${name} at 390: no sideways scroll, every button ≥ 48 px, at most one yellow button`, m.overflow <= 0 && m.small.length === 0 && m.primary.length <= 1, JSON.stringify(m));
};

// ── The From addresses: media@ for press, and a second one so there is a choice ──
const media = (await act('sender.save', { name: 'Sample Campaign Media', email: `media@${DOMAIN}` })).json.sender;
const pat = (await act('sender.save', { name: 'Pat Example', email: `pat@${DOMAIN}` })).json.sender;
await act('sender.default', { use: 'press', id: media.id });
check('two From addresses, media@ the press default', !!media?.id && !!pat?.id);

// ── 1. Releases, empty ──
await go(page, '/media');
let m = await measure(page);
let w = await words(page.locator('.md-page'));
check('Media → Releases, empty: "No releases yet." and the one yellow button "Write a release"', /No releases yet\./.test(w) && m.primary.join('|') === 'Write a release', `${JSON.stringify(m.primary)} · ${w.slice(0, 160)}`);
check('…the nav has Media after Outreach', /Outreach\s*Media/.test(await words(page.locator('nav').first())), await words(page.locator('nav').first()));
await shot(page, '01-releases-empty-1440');
await go(phone, '/media');
await phoneOk('Releases, empty');
await shot(phone, '01-releases-empty-390');

// ── 2. Contacts: add a reporter on the desk, an influencer on the phone ──
await go(page, '/media/contacts');
check('Contacts, empty: "No media contacts yet." and "Add a contact"', /No media contacts yet\./.test(await words(page.locator('.md-page'))) && (await measure(page)).primary.join('|') === 'Add a contact');
await page.getByRole('button', { name: 'Add a contact' }).click();
await page.fill('#md-a-name', 'Dana Example');
await page.fill('#md-a-email', 'dana@example.org');
await page.fill('#md-a-outlet', 'Example Daily');
await page.locator('form[aria-label="Add a contact"] .ot-more').click();
await page.fill('#md-a-phone', '604-555-0161');
await page.fill('#md-a-beat', 'City hall');
await shot(page, '02-add-contact-1440');
await page.locator('form[aria-label="Add a contact"] button[type="submit"]').click();
await page.locator('.toast').waitFor({ timeout: 8000 }).catch(() => {});
check('Add a contact: said ("Added Dana Example")', /Added Dana Example/.test(await words(page.locator('.toast'))), await words(page.locator('.toast')));
await go(phone, '/media/contacts');
await phone.getByRole('button', { name: 'Add a contact' }).tap();
await phone.fill('#md-a-name', 'Sam Example');
await phone.locator('form[aria-label="Add a contact"] [role="radio"]:has-text("Influencer")').tap();
await phone.fill('#md-a-email', 'sam@example.org');
await phone.locator('form[aria-label="Add a contact"] .ot-more').tap();
await phone.selectOption('form[aria-label="Add a contact"] select >> nth=0', 'instagram');
await phone.fill('#md-a-handle-0', '@samexample');
await phone.getByRole('button', { name: 'Add another' }).tap();
await phone.selectOption('form[aria-label="Add a contact"] select >> nth=1', 'tiktok');
await phone.fill('#md-a-handle-1', 'samtoks');
await phoneOk('Add a contact');
await shot(phone, '02-add-contact-390');
await phone.locator('form[aria-label="Add a contact"] button[type="submit"]').tap();
await phone.locator('.toast').waitFor({ timeout: 8000 }).catch(() => {});
// Someone already in People: added to the list, said so.
await act('person.create', { name: 'Lee Example', email: 'lee@example.org' });
await page.getByRole('button', { name: 'Add a contact' }).click();
await page.fill('#md-a-name', 'Lee Example');
await page.fill('#md-a-email', 'lee@example.org');
await page.fill('#md-a-outlet', 'Example Radio');
await page.locator('form[aria-label="Add a contact"] button[type="submit"]').click();
await page.locator('.toast:has-text("Already")').waitFor({ timeout: 8000 }).catch(() => {});
check('an email already in People: "Already in People — added to the media list"', /Already in People — added to the media list/.test(await words(page.locator('.toast'))), await words(page.locator('.toast')));
// One who asked not to be emailed.
await act('person.create', { name: 'Dee Example', email: 'dee@example.org', tags: ['media', 'do-not-email'] });
await go(page, '/media/contacts');
w = await words(page.locator('.md-table'));
const heads = await words(page.locator('.md-table thead'));
check('the desk table: Name, Outlet, Beat, Email, Phone, Socials, Last release', heads === 'Name Outlet Beat Email Phone Socials Last release', heads);
check('…Dana with her outlet, beat, email and phone; Sam’s handle; Dee “Won’t get releases: asked not to be emailed”',
  /Dana Example Example Daily City hall dana@example\.org 604-555-0161/.test(w) && /@samexample/.test(w) && /Dee Example\s*Won’t get releases: asked not to be emailed/.test(w), w.slice(0, 400));
const igHref = await page.locator('.md-table a:has-text("@samexample")').getAttribute('href');
const igRel = await page.locator('.md-table a:has-text("@samexample")').getAttribute('rel');
check('a handle opens the profile in a new tab', igHref === 'https://www.instagram.com/samexample' && /noopener/.test(igRel || ''), `${igHref} ${igRel}`);
const ttHref = await page.locator('.md-table a:has-text("@samtoks")').getAttribute('href').catch(() => null);
check('…two networks added at once: the TikTok one too', ttHref === 'https://www.tiktok.com/@samtoks', ttHref);
await shot(page, '03-contacts-table-1440');
await page.getByRole('button', { name: 'Dana Example' }).click();
await page.locator('.md-sheet').waitFor({ timeout: 5000 });
w = await words(page.locator('.md-sheet'));
check('a contact’s sheet: outlet, beat, email, phone, Edit, Open profile, Take off', /Outlet Example Daily/.test(w) && /Beat City hall/.test(w) && /dana@example\.org/.test(w)
  && /Edit/.test(w) && /Open profile/.test(w) && /Take off the media list/.test(w), w);
await shot(page, '04-contact-sheet-1440');
await go(phone, '/media/contacts');
w = await words(phone.locator('.md-rows'));
check('on a phone: rows, name first, then outlet and beat', /Dana Example Example Daily · City hall/.test(w) && !(await phone.locator('.md-table').count()), w.slice(0, 200));
await phoneOk('Contacts');
await shot(phone, '03-contacts-rows-390');
await phone.locator('.md-row:has-text("Sam Example")').tap();
await phone.locator('.md-sheet').waitFor({ timeout: 5000 });
await phoneOk('a contact’s sheet');
await shot(phone, '04-contact-sheet-390');

// ── 3. Write a release (manager, desk) ──
await go(page, '/media?new=1');
await page.locator('[data-testid="sender-pick"]').waitFor({ timeout: 8000 });
await settle(page);
const chips = await words(page.locator('.md-chips[aria-labelledby="md-to"]'));
check('To: "Media (2) Influencers (1) Both (3)" — Dee left out; Media chosen', chips === 'Media (2) Influencers (1) Both (3)'
  && (await page.locator('[role="radio"][aria-checked="true"]:has-text("Media (")').count()) === 1, chips);
const fromLine = await words(page.locator('[data-testid="sender-pick"]'));
check('From: the press address, with Change for the manager', fromLine === `From: Sample Campaign Media <media@${DOMAIN}> · Change`, fromLine);
await page.locator('.sp-change').click();
check('Change: the addresses as chips, the campaign’s own first', (await words(page.locator('.sp-chips'))) === `Sample Campaign <team@${DOMAIN}> Sample Campaign Media <media@${DOMAIN}> Pat Example <pat@${DOMAIN}>`, await words(page.locator('.sp-chips')));
await page.locator('.sp-chip:has-text("Sample Campaign Media")').click();
await page.fill('#press-subject', 'Campaign unveils transit plan');
await page.fill('#press-body', `FOR IMMEDIATE RELEASE\n\nThe plan, on video: ${VIDEO}`);
check('the files line says video is a link', /Video: paste a link \(YouTube, Vimeo, Drive\)\./.test(await words(page.locator('.ot-attach__hint'))));
m = await measure(page);
check('one yellow button: "Send to 2"', m.primary.join('|') === 'Send to 2', JSON.stringify(m.primary));
await shot(page, '05-write-release-1440');
await page.getByRole('button', { name: 'Send me a test' }).click();
await page.locator('.ot-test-note').waitFor({ timeout: 8000 }).catch(() => {});
const testMail = (await sentMail()).find((x) => /^\[Test\]/.test(x.subject));
check('Send me a test: sent to the writer, from media@', /Test sent to marco@mail\.example\.org/.test(await words(page.locator('.ot-test-note'))) && testMail?.from?.includes(`media@${DOMAIN}`), `${await words(page.locator('.ot-test-note'))} · ${testMail?.from}`);
await page.getByRole('button', { name: 'Send to 2' }).click();
const ask = await words(page.locator('.ot-confirm'));
check('the confirm: "Send to 2 media contacts from media@…?"', ask.startsWith(`Send to 2 media contacts from media@${DOMAIN}?`), ask);
await page.getByRole('button', { name: 'Yes, send' }).click();
await page.locator('.ot-result').waitFor({ timeout: 10000 });
check('the result: "Sent to 2 media contacts."', /Sent to 2 media contacts\./.test(await words(page.locator('.ot-result'))), await words(page.locator('.ot-result')));
const out = (await sentMail()).filter((x) => x.subject === 'Campaign unveils transit plan');
check('two emails, from media@, to Dana and Lee (never Dee, never Sam)', out.length === 2 && out.every((x) => x.from.includes(`media@${DOMAIN}`))
  && out.map((x) => x.to).sort().join(',') === 'dana@example.org,lee@example.org', JSON.stringify(out.map((x) => [x.to, x.from])));
await shot(page, '06-sent-1440');

// ── 4. The release's page: an open, the figures, Copy links ──
const pixel = /\/o\/([A-Za-z0-9_-]+)\.gif/.exec(out.find((x) => x.to === 'dana@example.org').html)?.[1];
check('the email carries an open pixel', !!pixel);
await fetch(`${BASE}/o/${pixel}.gif`);
const rel = (await api(page, '/media/releases')).json.releases[0];
await go(page, '/media');
w = await words(page.locator('.md-last'));
check('Releases: the last release, "1 of 2 opened"', /Campaign unveils transit plan/.test(w) && /1 of 2 opened/.test(w), w);
await shot(page, '07-releases-1440');
await go(phone, '/media');
await phoneOk('Releases');
await shot(phone, '07-releases-390');
await page.locator('.md-last').click();
await page.locator('.md-figs').waitFor({ timeout: 8000 });
await settle(page);
w = await words(page.locator('.md-page'));
check('the release’s page: subject, from media@, Sent 2 · Opened 1 · Clicked 0 · Bounced 0', /Campaign unveils transit plan/.test(w) && new RegExp(`from media@${DOMAIN}`).test(w)
  && (await words(page.locator('.md-figs'))) === 'Sent 2 Opened 1 Clicked 0 Bounced 0', `${await words(page.locator('.md-figs'))} · ${w.slice(0, 200)}`);
check('…Dana "Opened", Lee "Not opened"', /Dana Example Example Daily Opened/.test(w) && /Lee Example Example Radio Not opened/.test(w), w.slice(200, 500));
check('…no Try again (nothing failed), so no yellow button', (await measure(page)).primary.length === 0);
await page.getByRole('button', { name: 'Copy links' }).click();
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard: ${e.message}`);
check('Copy links: the video link, ready to paste in a message', clip === VIDEO, clip);
await shot(page, '08-release-page-1440');
await go(phone, `/media/releases/${rel.id}`);
await phoneOk('a release’s page');
await shot(phone, '08-release-page-390');

// ── 5. A release that failed, then Try again ──
await control('/fail', { code: 500 });
const failed = await act('media.send', { subject: 'Debate night', body: 'Join us.', to: { kinds: ['media', 'influencer'] } });
await control('/fail', { code: false });
check('a release while the sender refuses: kept, three failed', failed.status === 200 && failed.json.counts?.failed === 3, JSON.stringify(failed.json?.counts));
await go(page, `/media/releases/${failed.json.blast.id}`);
w = await words(page.locator('.md-page'));
check('its page: "Didn’t go" rows and the one yellow button "Try again · 3"', /Didn’t go/.test(w) && (await measure(page)).primary.join('|') === 'Try again · 3', JSON.stringify((await measure(page)).primary));
await page.getByRole('button', { name: 'Try again · 3' }).click();
await page.locator('.md-retry .ot-confirm button:has-text("Yes, send")').click();
await page.locator('.md-said').waitFor({ timeout: 10000 }).catch(() => {});
await settle(page);
check('Try again: "Tried again: 3 sent.", the rows sent, no Try again left', /Tried again: 3 sent\./.test(await words(page.locator('.md-said')))
  && !(await page.locator('.md-retry').count()) && (await words(page.locator('.md-figs'))).startsWith('Sent 3'), await words(page.locator('.md-page')));

// ── 6. A volunteer granted Media, not Outreach ──
const inv = (await act('member.invite', { email: 'vic@example.org', role: 'volunteer' })).json;
const volDesk = await browser.newContext(DESK);
const vol = await volDesk.newPage();
vol.on('pageerror', (e) => errors.push(`vol: ${e.message}`));
const joined = await vol.request.post(`${BASE}/api/auth/join`, { data: { token: inv.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'media-pass-2026' } });
const vicId = (await joined.json()).user.id;
await act('permission.member.set', { user_id: vicId, grant: ['media'], deny: [] });
check('the volunteer can’t read Outreach’s sends', (await api(vol, '/blasts')).status === 403);
await go(vol, '/media/contacts');
w = await words(vol.locator('.md-page'));
const vHeads = await words(vol.locator('.md-table thead'));
check('the volunteer’s contacts: no Email or Phone columns, no address or number anywhere, no Add a contact', vHeads === 'Name Outlet Beat Socials Last release'
  && !/dana@example\.org|604-555-0161/.test(w) && !(await vol.getByRole('button', { name: 'Add a contact' }).count()), `${vHeads} · ${w.slice(0, 200)}`);
await shot(vol, '09-volunteer-contacts-1440');
const volPhoneCtx = await browser.newContext({ ...PHONE, storageState: await volDesk.storageState() });
const volPhone = await volPhoneCtx.newPage();
volPhone.on('pageerror', (e) => errors.push(`vol phone: ${e.message}`));
await go(volPhone, '/media/contacts');
await volPhone.locator('.md-row:has-text("Dana Example")').tap();
await volPhone.locator('.md-sheet').waitFor({ timeout: 5000 });
w = await words(volPhone.locator('.md-sheet'));
check('the volunteer’s sheet: outlet and beat, no email, no phone, no Edit or Take off', /Example Daily/.test(w) && !/Email|Phone|dana@|604-555/.test(w) && !/Edit|Take off/.test(w), w);
await shot(volPhone, '09-volunteer-sheet-390');
await go(volPhone, '/media?new=1');
await volPhone.locator('[data-testid="sender-pick"]').waitFor({ timeout: 8000 });
await settle(volPhone);
const vFrom = await words(volPhone.locator('[data-testid="sender-pick"]'));
check('the volunteer’s From: the press default, no Change', vFrom === `From: Sample Campaign Media <media@${DOMAIN}>`, vFrom);
await volPhone.fill('#press-subject', 'Photo from the doors');
await volPhone.fill('#press-body', 'A picture from today:');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await volPhone.locator('.ot-compose input[type="file"][accept^="image"]').setInputFiles({ name: 'doors.png', mimeType: 'image/png', buffer: png });
await volPhone.waitForFunction(() => /!\[[^\]]*\]\(\/media\//.test(document.querySelector('#press-body')?.value || ''), null, { timeout: 10000 }).catch(() => {});
check('a picture in the message (media.picture, no Outreach needed)', /!\[[^\]]*\]\(\/media\//.test(await volPhone.inputValue('#press-body')), await volPhone.inputValue('#press-body'));
const vm = await measure(volPhone);
check('Write a release at 390 (volunteer): no sideways scroll, ≥ 48 px, one yellow button', vm.overflow <= 0 && vm.small.length === 0 && vm.primary.join('|') === 'Send to 2', JSON.stringify(vm));
await shot(volPhone, '10-volunteer-write-390');
await volPhone.getByRole('button', { name: 'Send to 2' }).tap();
await volPhone.getByRole('button', { name: 'Yes, send' }).tap();
await volPhone.locator('.ot-result').waitFor({ timeout: 10000 });
check('the volunteer sends it: "Sent to 2 media contacts."', /Sent to 2 media contacts\./.test(await words(volPhone.locator('.ot-result'))), await words(volPhone.locator('.ot-result')));
const vOut = (await sentMail()).filter((x) => x.subject === 'Photo from the doors');
check('…from the press default', vOut.length === 2 && vOut.every((x) => x.from.includes(`media@${DOMAIN}`)), JSON.stringify(vOut.map((x) => x.from)));
await shot(volPhone, '11-volunteer-sent-390');

// ── 7. An A/B release in its wait: the rest wait for the winner, nothing to try again ──
for (let i = 0; i < 50; i += 1) await act('person.create', { name: `Rep ${i} Example`, email: `rep${i}@example.org`, tags: ['media'] });
const ab = await act('media.send', { subject: 'Plain', body: 'News', ab: { subject_b: 'Better', pct: 10, wait_hours: 1, metric: 'opens' } });
check('an A/B release goes out to its test groups', ab.status === 200, JSON.stringify(ab.json).slice(0, 200));
await go(page, `/media/releases/${ab.json.blast.id}`);
w = await words(page.locator('.md-page'));
m = await measure(page);
check('its page in the wait: "Testing two subject lines", rows "Waits for the winner", no "Didn’t go", no Try again',
  /Testing two subject lines · first sent/.test(w) && /Waits for the winner/.test(w) && !/Didn’t go|not sent/.test(w) && m.primary.length === 0 && !(await page.locator('.md-retry').count()),
  `${JSON.stringify(m.primary)} · ${w.slice(0, 300)}`);
await shot(page, '12-ab-release-1440');
await go(phone, `/media/releases/${ab.json.blast.id}`);
await phoneOk('an A/B release’s page');
await shot(phone, '12-ab-release-390');

check('the books verify', (await api(page, '/audit/verify')).json?.ok === true);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill('SIGTERM');
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
if (fails) console.log(serverLog.split('\n').slice(-15).join('\n'));
process.exit(fails ? 1 : 0);
