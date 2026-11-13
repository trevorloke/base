// Email templates — browser check. A fresh in-memory server with a stand-in
// for Resend (server/test/fake-mail.js); a manager on a laptop (1440×900)
// and on a phone (390×844), staff, and a volunteer granted Media:
//   1. Write an email: a blank email, Subject focused, "Start from" reads
//      "A blank email", no line under the Message (the address is set);
//   2. Start from "Monthly newsletter": the one line names three parts then
//      "…"; a test says how many parts are left; Send is refused with
//      "Fill in the [ ] parts first: [Month]"; Link on "[link: Read more]"
//      gives "[Read more](https://)" with the address selected, and Send
//      says "Add the address for the link “Read more”"; "Link to…" on
//      another; + First name; "[sic]" asked about in the confirm; the mail
//      says "Hi Sam", "Hi friend", "Hi John", and a name typed as a link is
//      only words;
//   3. "No mailing address yet" until it is set; Preview ends with the
//      lines added at send;
//   4. Save as template, start from it ("Replace what you’ve written?"),
//      Update twice, a file kept through a pick;
//   5. Templates (from the row under Lists): edit and Save twice, a second
//      tab's stale Save with Reload, Make a copy, Remove → Undo, Hide → Show
//      (managers only), the ready-made order;
//   6. Use again on a past send; 7. the command bar; 8. Media as the
//      volunteer: Templates beside Write a release, Press release in Start
//      from, nothing to save or remove, a release sent; 9. no signal;
//   10. every screen: one yellow button at most; at 390 no sideways scroll
//      and every button at least 48 px.
//
//   npm run build  then  node e2e-templates.mjs   (PORT, SHOTS optional; the
//   stand-in sender listens on PORT+1 and the test's controls on PORT+2)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 5400;
const FAKE = PORT + 1;
const CONTROL = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-templates';
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
const STUB = `${SHOTS}/templates-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
const { startFakeMail } = await import(${href('test/fake-mail.js')});
const fake = await startFakeMail({ provider: 'resend', port: ${FAKE} });
createServer(async (req, res) => {
  for await (const c of req) { /* drain */ }
  if (req.url === '/sent') return res.end(JSON.stringify(fake.sent.map((x) => ({ to: x.to, subject: x.subject, html: x.body?.html || '', text: x.body?.text || '' }))));
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);

const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off' };
for (const k of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE', 'MAIL_FROM', 'STARBASE_PUBLIC_URL']) delete env[k];
Object.assign(env, { RESEND_API_KEY: 're_e2e_templates', RESEND_API_BASE: `http://127.0.0.1:${FAKE}`, MAIL_FROM: `Sample Campaign <team@${DOMAIN}>`, STARBASE_PUBLIC_URL: BASE });
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
const sentMail = async () => JSON.parse(await fetch(`http://127.0.0.1:${CONTROL}/sent`, { method: 'POST' }).then((r) => r.text()));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' };
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

const api = async (p, path, body) => {
  const r = body === undefined ? await p.request.get(`${BASE}/api${path}`) : await p.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const act = (name, input, p = page) => api(p, `/actions/${name}`, input);
const words = async (loc) => ((await loc.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const settle = async (p) => { await p.waitForLoadState('networkidle').catch(() => {}); await sleep(300); };
const go = async (p, path, wait = '.ot-page') => { await p.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await p.locator(wait).first().waitFor({ timeout: 10000 }); await settle(p); };
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const measure = (p) => p.evaluate(() => {
  const vis = (x) => { const r = x.getBoundingClientRect(); const s = getComputedStyle(x); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
  const main = document.querySelector('.ot-page') || document.body;
  const btns = [...main.querySelectorAll('button, a.btn, select')].filter(vis);
  const small = btns.filter((b) => Math.round(b.getBoundingClientRect().height) < 48).map((b) => `${(b.innerText || b.id).trim().slice(0, 30)}:${Math.round(b.getBoundingClientRect().height)}`);
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    primary: [...document.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.innerText.trim()),
    small,
  };
});
const oneYellow = async (p, name) => {
  const m = await measure(p);
  check(`${name}: at most one yellow button`, m.primary.length <= 1, JSON.stringify(m.primary));
};
const phoneOk = async (p, name) => {
  const m = await measure(p);
  check(`${name} at 390: no sideways scroll, every control ≥ 48 px, at most one yellow button`, m.overflow <= 0 && m.small.length === 0 && m.primary.length <= 1, JSON.stringify(m));
};

// ── Setup: the website's organization lines, subscribers ──
await api(page, '/site');
const ORG = { name: 'Sample Campaign', address: '1 Example St, Surrey BC', email: 'hello@example.org', agentName: 'Robin Example', agentContact: '604-555-0100' };
const setOrg = (org) => act('site.settings.save', { org });
check('the mailing address and agent are set', (await setOrg(ORG)).status === 200);
for (const [email, name] of [['sam@example.org', 'Sam Example'], ['nameless@example.org', ''], ['john@example.org', 'JOHN EXAMPLE'], ['odd@example.org', '[x](https://evil.example)']]) {
  await act('subscription.add', { email, ...(name ? { name } : {}) });
}

// ── 1. A blank email ──
await go(page, '/outreach/email?new=1', '#newsletter-subject');
await page.locator('#newsletter-start:not([disabled])').waitFor({ timeout: 10000 });
const focused = await page.evaluate(() => document.activeElement?.id);
const startWords = await page.locator('#newsletter-start option:checked').innerText();
check('1. the form opens blank with Subject focused and "Start from" on "A blank email"', focused === 'newsletter-subject' && startWords === 'A blank email', `${focused} · ${startWords}`);
check('1. no line under the Message once the address is set', (await page.locator('.tp-warn').count()) === 0);
await oneYellow(page, 'the compose');
await shot(page, '01-compose-blank-1440');

// ── 2. Start from Monthly newsletter ──
const options = await page.$$eval('#newsletter-start optgroup[label="Ready-made"] option', (els) => els.map((e) => e.textContent));
check('2. the ready-made list: four newsletters first, the voting days last', options.slice(0, 4).join('|') === 'Monthly newsletter|Short update|Issue spotlight|Looking back, looking ahead'
  && options.slice(-2).join('|') === 'Advance voting is open|Election day (go vote only)', options.join('|'));
await page.selectOption('#newsletter-start', 'starter:monthly');
await page.waitForFunction(() => document.querySelector('#newsletter-subject')?.value.includes('[Month]'), null, { timeout: 8000 });
let warn = await words(page.locator('.tp-warn'));
check('2. the one line names three parts then "…"', /^\d+ parts still to fill in: \[Month\], [^,]+, [^,]+ …$/.test(warn), warn);
await shot(page, '02-compose-started-1440');
await page.getByRole('button', { name: 'Send me a test' }).click();
await page.locator('.ot-test-note').waitFor({ timeout: 8000 }).catch(() => {});
const testLine = await words(page.locator('.ot-test-note'));
check('2. a test goes, and says how many parts are left', /^Test sent to .+ · \d+ parts still to fill in$/.test(testLine), testLine);
// Send → Yes → the refusal (a new one: the line before it is cleared by the tap).
const sendAndRead = async (p, yes = 'Yes, send') => {
  await p.locator('.ot-compose button[type="submit"]').click();
  await p.locator(`.ot-confirm button:has-text("${yes}")`).click();
  await p.locator('.ot-confirm').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  await p.locator('.ot-compose > p.error').waitFor({ timeout: 8000 }).catch(() => {});
  return words(p.locator('.ot-compose > p.error'));
};
let refusal = await sendAndRead(page);
check('2. Send is refused: "Fill in the [ ] parts first: [Month]"', refusal === 'Fill in the [ ] parts first: [Month]', refusal);
// Link on "[link: Read more]".
const select = (p, id, text) => p.evaluate(([i, t]) => {
  const el = document.getElementById(i);
  const at = el.value.indexOf(t);
  el.focus();
  el.setSelectionRange(at, at + t.length);
  return at;
}, [id, text]);
await select(page, 'newsletter-body', '[link: Read more]');
await page.locator('.ot-compose .ws-md__tool--link').click();
await sleep(200);
const linked = await page.evaluate(() => { const el = document.getElementById('newsletter-body'); return { v: el.value, sel: el.value.slice(el.selectionStart, el.selectionEnd) }; });
check('2. Link on "[link: Read more]" gives "[Read more](https://)" with the address selected', linked.v.includes('[Read more](https://)') && !linked.v.includes('[[link') && linked.sel === 'https://', JSON.stringify(linked.sel));
refusal = await sendAndRead(page);
check('2. Send: "Add the address for the link “Read more”"', refusal === 'Add the address for the link “Read more”', refusal);
// "Link to…" on another one.
await page.fill('#newsletter-body', `${await page.inputValue('#newsletter-body')}\n\n[link: Our home page]`);
await select(page, 'newsletter-body', '[link: Our home page]');
await page.selectOption('.ot-compose .ws-md__links', { label: 'Home' });
await sleep(200);
const toPage = await page.inputValue('#newsletter-body');
check('2. "Link to…" on a placeholder links it to the page', /\[Our home page\]\(http:\/\/127\.0\.0\.1:\d+\/site\/\)/.test(toPage), toPage.slice(-80));
// Fill it all in, keep "[sic]", use + First name.
await page.fill('#newsletter-subject', 'November update from [campaign]');
await page.fill('#newsletter-body', 'Hi ,\n\nThe council said “we heard you [sic]”. [Read more](https://example.org/news)\n\n[Our home page](https://example.org/)');
await page.evaluate(() => { const el = document.getElementById('newsletter-body'); el.focus(); el.setSelectionRange(3, 3); });
await page.locator('.ot-compose .ws-md__fill:has-text("+ First name")').click();
await sleep(150);
check('2. + First name puts "[first name]" at the cursor', (await page.inputValue('#newsletter-body')).startsWith('Hi [first name],'));
check('2. nothing left to fill: no line', (await page.locator('.tp-warn').count()) === 0, await words(page.locator('.tp-warn')));
await page.locator('.ot-compose button[type="submit"]').click();
const ask = await words(page.locator('.ot-confirm .tp-own'));
check('2. the confirm asks: "Still has [sic] — send as written?"', ask === 'Still has [sic] — send as written?', ask);
await shot(page, '03-confirm-sic-1440');
await page.locator('.ot-confirm button:has-text("Yes, send")').click();
await page.locator('.ot-compose').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
await settle(page);
const mail = (await sentMail()).filter((m) => m.subject === 'November update from Sample Campaign');
const textTo = (to) => mail.find((m) => m.to === to)?.text || '';
check('2. the email went to all four, the subject filled', mail.length === 4, mail.map((m) => `${m.to}:${m.subject}`).join(' · '));
check('2. "Hi Sam", "Hi friend", "Hi John"', /^Hi Sam,/.test(textTo('sam@example.org')) && /^Hi friend,/.test(textTo('nameless@example.org')) && /^Hi John,/.test(textTo('john@example.org')),
  [textTo('sam@example.org'), textTo('nameless@example.org'), textTo('john@example.org')].map((t) => t.slice(0, 12)).join(' | '));
const odd = mail.find((m) => m.to === 'odd@example.org');
check('2. a name typed as a link is only words', odd && !/<a[^>]+evil\.example/.test(odd.html) && odd.html.includes('[x](https://evil.example)'), odd?.html.slice(0, 200));
check('2. the address and "Authorized by" at the bottom', /1 Example St, Surrey BC\./.test(textTo('sam@example.org')) && /Authorized by Robin Example/.test(textTo('sam@example.org')));

// ── 3. No mailing address yet ──
await setOrg({ ...ORG, address: '' });
await go(page, '/outreach/email?new=1', '#newsletter-subject');
await page.locator('.tp-warn').waitFor({ timeout: 8000 }).catch(() => {});
warn = await words(page.locator('.tp-warn'));
check('3. "No mailing address yet" with Add it', /^No mailing address yet — the law asks for one at the bottom of every email\. Add it$/.test(warn)
  && (await page.locator('.tp-warn a[href$="/website/settings#org"]').count()) === 1, warn);
await shot(page, '04-compose-no-address-1440');
await setOrg(ORG);
await go(page, '/outreach/email?new=1', '#newsletter-subject');
await page.locator('#newsletter-start:not([disabled])').waitFor({ timeout: 10000 });
check('3. with the address set the line goes', (await page.locator('.tp-warn').count()) === 0);
await page.fill('#newsletter-subject', 'A quick note');
await page.fill('#newsletter-body', 'Hi [first name],\n\nSee you Saturday.');
await page.locator('.ot-compose .ws-md__preview').click();
const foot = await words(page.locator('.tp-foot'));
check('3. Preview ends with the lines added at send', foot === 'Sent by Sample Campaign. 1 Example St, Surrey BC. hello@example.org. Authorized by Robin Example, 604-555-0100. Unsubscribe', foot);
await shot(page, '05-preview-footer-1440');
await page.locator('.ot-compose .ws-md__preview').click();

// ── 4. Save as template, start from it, Update twice, a file kept ──
await page.getByRole('button', { name: 'Save as template' }).click();
check('4. Save as template opens with the subject as its name', (await page.inputValue('#newsletter-tp-name')) === 'A quick note');
await shot(page, '06-save-as-template-1440');
await page.fill('#newsletter-tp-name', 'My update');
await page.locator('.tp-keep button:has-text("Save")').first().click();
await page.locator('.tp-said:has-text("Saved as")').waitFor({ timeout: 8000 }).catch(() => {});
check('4. "Saved as “My update”"', (await words(page.locator('.tp-said'))) === 'Saved as “My update”', await words(page.locator('.tp-keep')));
await go(page, '/outreach/email?new=1', '#newsletter-subject');
await page.locator('#newsletter-start:not([disabled])').waitFor({ timeout: 10000 });
await page.locator('.ot-attach input[type="file"]').setInputFiles({ name: 'flyer.txt', mimeType: 'text/plain', buffer: Buffer.from('Saturday') });
await page.locator('.ot-file:has-text("flyer.txt")').waitFor({ timeout: 8000 });
await page.fill('#newsletter-subject', 'Something else');
const mine = await page.$$eval('#newsletter-start optgroup[label="Your templates"] option', (els) => els.map((e) => [e.value, e.textContent]));
const myId = mine.find(([, n]) => n === 'My update')?.[0];
await page.selectOption('#newsletter-start', myId);
const replace = await words(page.locator('.tp-ask'));
check('4. picking over what’s written asks "Replace what you’ve written? Yes No"', replace === 'Replace what you’ve written? Yes No', replace);
await page.locator('.tp-ask button:has-text("Yes")').click();
await page.waitForFunction(() => document.querySelector('#newsletter-subject')?.value === 'A quick note', null, { timeout: 8000 }).catch(() => {});
check('4. the template’s words are in, and the file is still there', (await page.inputValue('#newsletter-subject')) === 'A quick note'
  && (await page.inputValue('#newsletter-body')).startsWith('Hi [first name],') && (await page.locator('.ot-file:has-text("flyer.txt")').count()) === 1);
await page.fill('#newsletter-body', 'Hi [first name],\n\nSee you Sunday.');
const upd = page.getByRole('button', { name: 'Update “My update”' });
await upd.click();
await page.locator('.tp-said:has-text("Updated")').waitFor({ timeout: 8000 }).catch(() => {});
const u1 = await words(page.locator('.tp-said'));
await page.fill('#newsletter-body', 'Hi [first name],\n\nSee you Monday.');
await upd.click();
await sleep(800);
const u2 = await words(page.locator('.tp-keep'));
check('4. Update twice in a row: both save', u1 === 'Updated “My update”' && /Updated “My update”/.test(u2) && !/changed this template/.test(u2), `${u1} · ${u2}`);
const saved = (await api(page, `/templates/${myId}`)).json;
check('4. the template holds the last words, in codes', saved?.body === 'Hi {{first_name}},\n\nSee you Monday.' && saved.version === 3, JSON.stringify(saved).slice(0, 160));

// ── 5. The Templates screen ──
await go(page, '/outreach/email');
await page.locator('.ot-list .ot-row:has-text("Templates")').waitFor({ timeout: 8000 });
const row = await words(page.locator('.ot-list .ot-row:has-text("Templates")'));
check('5. the row under Lists: "Templates 12 ready-made · 1 of your own — start an email from one"', row === 'Templates 12 ready-made · 1 of your own — start an email from one', row);
await shot(page, '07-email-tab-templates-row-1440');
await page.locator('.ot-list .ot-row:has-text("Templates")').click();
await page.waitForURL(/\/outreach\/templates$/, { timeout: 8000 });
await page.locator('h1:has-text("Email templates")').waitFor({ timeout: 8000 });
await settle(page);
const ready = await page.$$eval('section[aria-label="Ready-made"] .ot-row__name', (els) => els.map((e) => e.textContent));
check('5. the ready-made list: four newsletters first, the voting days last', ready.length === 12 && ready[0] === 'Monthly newsletter' && ready[3] === 'Looking back, looking ahead'
  && ready[11] === 'Election day (go vote only)', ready.join('|'));
await oneYellow(page, 'Email templates');
await shot(page, '08-templates-list-1440');
await page.locator('section[aria-label="Your templates"] .ot-row:has-text("My update")').click();
const subjId = await page.locator('.tp-edit input[id$="-subject"]').getAttribute('id');
await page.fill(`#${subjId}`, 'A quick note, again');
const saveBtn = page.locator('.tp-edit .btn-primary:has-text("Save")');
await saveBtn.click();
await page.locator('.tp-edit .tp-said:has-text("Saved")').waitFor({ timeout: 8000 }).catch(() => {});
const s1 = await words(page.locator('.tp-edit .tp-said'));
await page.fill(`#${subjId}`, 'A quick note, once more');
await saveBtn.click();
await sleep(800);
const s2 = await words(page.locator('.tp-edit p[role="status"]'));
check('5. edit, Save, Save again: both save', s1 === 'Saved “My update”' && s2 === 'Saved “My update”', `${s1} · ${s2}`);
await oneYellow(page, 'a template open');
await shot(page, '09-template-open-1440');
// A second tab, opened before; this tab saves; the second's Save is stale.
const page2 = await desk.newPage();
page2.on('pageerror', (e) => errors.push(`tab 2: ${e.message}`));
await go(page2, '/outreach/templates', 'h1');
await page2.locator('section[aria-label="Your templates"] .ot-row:has-text("My update")').click();
await page2.locator('.tp-edit').waitFor({ timeout: 8000 });
await page.fill(`#${subjId}`, 'From the first tab');
await saveBtn.click();
await sleep(800);
await page2.fill(`#${subjId}`, 'From the second tab');
await page2.locator('.tp-edit .btn-primary:has-text("Save")').click();
await page2.locator('.tp-edit p.error').waitFor({ timeout: 8000 }).catch(() => {});
const stale = await words(page2.locator('.tp-edit p.error'));
check('5. the second tab: "Marco Example changed this template at … — reload to see it" with Reload', /^Marco Example changed this template at \d{1,2}:\d\d [ap]m — reload to see it Reload$/.test(stale), stale);
await page2.locator('.tp-edit button:has-text("Reload")').click();
await sleep(600);
check('5. Reload brings the first tab’s words', (await page2.inputValue(`#${subjId}`)) === 'From the first tab');
await page2.close();
// Make a copy; remove it; Undo.
await page.locator('.tp-edit button:has-text("Make a copy")').click();
await page.locator('.tp-live .ot-toast').waitFor({ timeout: 8000 });
check('5. Make a copy: "Copied as “My update (copy)”"', (await words(page.locator('.tp-live .ot-toast span'))) === 'Copied as “My update (copy)”');
await settle(page);
await page.locator('section[aria-label="Your templates"] .ot-row:has-text("My update (copy)")').click();
await page.locator('.tp-edit .ot-more').click();
await page.locator('.tp-edit button:has-text("Remove")').click();
check('5. Remove asks in place', /^Remove “My update \(copy\)”\? Yes No$/.test(await words(page.locator('.tp-ask'))), await words(page.locator('.tp-ask')));
await page.locator('.tp-ask button:has-text("Yes")').click();
await page.locator('.tp-live .ot-toast:has-text("Removed")').waitFor({ timeout: 8000 });
await settle(page);
const gone = (await page.locator('section[aria-label="Your templates"] .ot-row__name:text-is("My update (copy)")').count()) === 0;
await page.locator('.tp-live button:has-text("Undo")').click();
await page.locator('.tp-live .ot-toast:has-text("is back")').waitFor({ timeout: 8000 }).catch(() => {});
await settle(page);
check('5. Removed, then Undo brings it back', gone && (await page.locator('section[aria-label="Your templates"] .ot-row__name:text-is("My update (copy)")').count()) === 1);
// Hide a ready-made one and Show it again (managers).
await page.locator('section[aria-label="Ready-made"] .ot-row:has-text("Welcome")').click();
await page.locator('.tp-view .btn-primary:has-text("Write an email from this")').waitFor({ timeout: 8000 });
check('5. a ready-made one: a preview, its subject and "Words in [brackets] are yours to fill in."', /Words in \[brackets\] are yours to fill in\./.test(await words(page.locator('.tp-view'))));
await oneYellow(page, 'a ready-made one open');
await shot(page, '10-ready-made-open-1440');
await page.locator('.tp-view button:has-text("Hide")').click();
await page.locator('.tp-live .ot-toast:has-text("Hidden — find it under More")').waitFor({ timeout: 8000 });
await settle(page);
const hiddenNow = (await page.locator('section[aria-label="Ready-made"] .ot-row__name:text-is("Welcome")').count()) === 0;
await page.locator('.tp-page > .ot-more-wrap .ot-more').click();
await page.locator('section[aria-label="Hidden ready-made templates"] button:has-text("Show")').click();
await settle(page);
check('5. Hide, then Show under More', hiddenNow && (await page.locator('section[aria-label="Ready-made"] .ot-row__name:text-is("Welcome")').count()) === 1);
// Write an email from a ready-made one.
await page.locator('section[aria-label="Ready-made"] .ot-row:has-text("Thank you")').click();
await page.locator('.tp-view .btn-primary:has-text("Write an email from this")').click();
await page.waitForFunction(() => document.querySelector('#newsletter-subject')?.value === 'Thank you, [first name]', null, { timeout: 8000 }).catch(() => {});
check('5. "Write an email from this" opens the compose with its words, and the address is clean', (await page.inputValue('#newsletter-subject')) === 'Thank you, [first name]' && !/template=/.test(page.url()), page.url());

// Staff: no Hide.
const inviteStaff = (await act('member.invite', { email: 'sky@example.org', role: 'staff' })).json;
const staffCtx = await browser.newContext(DESK);
const staff = await staffCtx.newPage();
staff.on('pageerror', (e) => errors.push(`staff: ${e.message}`));
await staff.request.post(`${BASE}/api/auth/join`, { data: { token: inviteStaff.joinUrl.split('/join/')[1], name: 'Sky Example', password: 'staff-pass-2026' } });
await go(staff, '/outreach/templates', 'h1');
await staff.locator('section[aria-label="Ready-made"] .ot-row:has-text("Welcome")').click();
await staff.locator('.tp-view').waitFor({ timeout: 8000 });
check('5. staff see no Hide', (await staff.locator('.tp-view button:has-text("Hide")').count()) === 0 && (await staff.locator('.tp-view button:has-text("Make a copy")').count()) === 1);

// ── 6. Use again ──
await go(page, '/outreach/email');
await page.locator('.ot-more:has-text("More")').first().click();
await page.locator('.ot-item:has-text("November update from [campaign]") a:has-text("Use again")').first().click();
await page.waitForFunction(() => document.querySelector('#newsletter-subject')?.value === 'November update from [campaign]', null, { timeout: 8000 }).catch(() => {});
check('6. Use again fills the compose with the past email’s words', (await page.inputValue('#newsletter-subject')) === 'November update from [campaign]'
  && (await page.inputValue('#newsletter-body')).startsWith('Hi [first name],'));
check('6. no line to fix', (await page.locator('.tp-warn').count()) === 0);
await page.locator('.ot-compose button[type="submit"]').click();
await page.locator('.ot-confirm button:has-text("Yes, send")').click();
await page.locator('.ot-compose').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
check('6. it sends with no placeholder to fix', (await page.locator('.ot-compose').count()) === 0, await words(page.locator('.ot-compose')));

// ── 7. The command bar ──
await go(page, '/outreach/texting');
await page.keyboard.press('Control+k');
await page.locator('.cmd [role="combobox"]').fill('newsletter');
await sleep(200);
await page.keyboard.press('Enter');
await page.waitForURL(/new=1/, { timeout: 8000 }).catch(() => {});
check('7. "newsletter" + Enter writes an email', /\/outreach\/email\?new=1/.test(page.url()), page.url());
await page.keyboard.press('Control+k');
await page.locator('.cmd [role="combobox"]').fill('templates');
await sleep(200);
await page.keyboard.press('Enter');
await page.waitForURL(/\/outreach\/templates/, { timeout: 8000 }).catch(() => {});
check('7. "templates" + Enter opens Templates', /\/outreach\/templates$/.test(page.url()), page.url());

// ── 8. Media, as a volunteer granted Media ──
await act('media.contact.add', { name: 'Dana Example', kind: 'media', email: 'dana@example.org', outlet: 'Example Daily' });
const inv = (await act('member.invite', { email: 'vic@example.org', role: 'volunteer' })).json;
const volCtx = await browser.newContext(PHONE);
const vol = await volCtx.newPage();
vol.on('pageerror', (e) => errors.push(`vol: ${e.message}`));
const joined = await vol.request.post(`${BASE}/api/auth/join`, { data: { token: inv.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'media-pass-2026' } });
await act('permission.member.set', { user_id: (await joined.json()).user.id, grant: ['media'], deny: [] });
await go(vol, '/media', '.md-page');
check('8. Templates beside Write a release', (await vol.locator('.ot-top a:has-text("Templates")').count()) === 1 && (await vol.locator('.ot-top .btn-primary:has-text("Write a release")').count()) === 1);
await phoneOk(vol, 'Media releases');
await shot(vol, '11-media-header-390');
await go(vol, '/media/templates', 'h1');
check('8. Release templates: no New template', (await words(vol.locator('h1'))) === 'Release templates' && (await vol.getByRole('button', { name: 'New template' }).count()) === 0);
await vol.locator('section[aria-label="Ready-made"] .ot-row:has-text("Press release")').tap();
await vol.locator('.tp-view').waitFor({ timeout: 8000 });
check('8. a ready-made release: Write a release from this, no Copy, no Hide', (await vol.locator('.tp-view .btn-primary:has-text("Write a release from this")').count()) === 1
  && (await vol.locator('.tp-view button:has-text("Make a copy"), .tp-view button:has-text("Hide")').count()) === 0);
await phoneOk(vol, 'Release templates');
await shot(vol, '12-release-templates-390');
await vol.locator('.tp-view .btn-primary').tap();
await vol.waitForFunction(() => document.querySelector('#press-subject')?.value === '[Headline in sentence case]', null, { timeout: 8000 }).catch(() => {});
check('8. Start from: Press release, and no Save as template', (await vol.locator('#press-start option:checked').innerText()) === 'Press release'
  && (await vol.getByRole('button', { name: 'Save as template' }).count()) === 0);
await vol.fill('#press-subject', 'Campaign opens its office');
await vol.fill('#press-body', 'FOR IMMEDIATE RELEASE\n\n“We heard you [sic],” said a volunteer.');
await vol.locator('.ot-compose button[type="submit"]').tap();
const vAsk = await words(vol.locator('.ot-confirm .tp-own'));
check('8. a release with "[sic]" asks, then sends', vAsk === 'Still has [sic] — send as written?', vAsk);
await vol.locator('.ot-confirm .btn-primary').tap();
await vol.locator('.ot-compose').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
check('8. the release went', (await sentMail()).some((m) => m.to === 'dana@example.org' && m.subject === 'Campaign opens its office'));

// ── 9. No signal ──
await go(page, '/outreach/templates', 'h1');
await page.locator('section[aria-label="Your templates"] .ot-row:has-text("My update")').first().click();
await page.locator('.tp-edit').waitFor({ timeout: 8000 });
await go(page, '/outreach/email?new=1', '#newsletter-subject');
await page.locator('#newsletter-start:not([disabled])').waitFor({ timeout: 10000 });
await page.fill('#newsletter-subject', 'Offline words');
await page.fill('#newsletter-body', 'Hello.');
await desk.setOffline(true);
await sleep(300);
check('9. no signal: Save as template is off, with Needs signal', await page.getByRole('button', { name: 'Save as template' }).isDisabled()
  && /Needs signal/.test(await words(page.locator('.tp-keep'))));
await desk.setOffline(false);
await go(page, '/outreach/templates', 'h1');
await page.locator('section[aria-label="Your templates"] .ot-row:has-text("My update")').first().click();
await page.locator('.tp-edit').waitFor({ timeout: 8000 });
await desk.setOffline(true);
await sleep(300);
check('9. no signal: the Templates Save is off, with Needs signal', await page.locator('.tp-edit .btn-primary:has-text("Save")').isDisabled()
  && /Needs signal/.test(await words(page.locator('.tp-edit .tp-acts'))));
await desk.setOffline(false);

// ── 10. The phone ──
const phoneCtx = await browser.newContext({ ...PHONE, storageState: await desk.storageState() });
const phone = await phoneCtx.newPage();
phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await setOrg({ ...ORG, address: '' });
await go(phone, '/outreach/email?new=1', '#newsletter-subject');
await phone.locator('#newsletter-start:not([disabled])').waitFor({ timeout: 10000 });
await phone.selectOption('#newsletter-start', 'starter:monthly');
await phone.waitForFunction(() => document.querySelector('#newsletter-subject')?.value.includes('[Month]'), null, { timeout: 8000 });
await phone.fill('#newsletter-subject', 'November update');
await phone.fill('#newsletter-body', 'Hi [first name], a quote [sic]. [Headline one]');
await phone.locator('.ot-compose button[type="submit"]').tap();
await phone.locator('.ot-confirm').waitFor({ timeout: 5000 });
await phoneOk(phone, 'the compose with the line, Save as template and the confirm');
check('10. on the phone: the warning line, Save as template and "Still has [sic]" all show', (await phone.locator('.tp-warn').count()) === 1
  && (await phone.getByRole('button', { name: 'Save as template' }).count()) === 1 && /Still has \[sic\]/.test(await words(phone.locator('.ot-confirm'))));
await shot(phone, '13-compose-everything-390');
await phone.locator('.ot-confirm button:has-text("No")').tap();
await phone.locator('.ot-compose .ws-md__preview').tap();
await shot(phone, '14-preview-footer-390');
await setOrg(ORG);
await go(phone, '/outreach/email?new=1', '#newsletter-subject');
await phone.locator('#newsletter-start:not([disabled])').waitFor({ timeout: 10000 });
await phoneOk(phone, 'the blank compose');
await shot(phone, '15-compose-blank-390');
await phone.fill('#newsletter-subject', 'Words');
await phone.fill('#newsletter-body', 'More words');
await phone.getByRole('button', { name: 'Save as template' }).tap();
await phoneOk(phone, 'Save as template, open');
await shot(phone, '16-save-as-template-390');
await go(phone, '/outreach/templates', 'h1');
await phoneOk(phone, 'Email templates');
await shot(phone, '17-templates-list-390');
await phone.locator('section[aria-label="Your templates"] .ot-row:has-text("My update")').first().tap();
await phone.locator('.tp-edit').waitFor({ timeout: 8000 });
await phoneOk(phone, 'a template open');
await shot(phone, '18-template-open-390');
await phone.locator('section[aria-label="Your templates"] .ot-row:has-text("My update")').first().tap();
await phone.locator('section[aria-label="Ready-made"] .ot-row:has-text("Monthly newsletter")').tap();
await phone.locator('.tp-view').waitFor({ timeout: 8000 });
await phoneOk(phone, 'a ready-made one open');
await shot(phone, '19-ready-made-open-390');
await go(phone, '/outreach/email');
await phone.locator('.ot-more:has-text("More")').first().tap();
await phone.locator('a:has-text("Use again")').first().waitFor({ timeout: 8000 });
await phoneOk(phone, 'past sends with Use again');
await shot(phone, '20-use-again-390');
await go(page, '/outreach/email');
await page.locator('.ot-more:has-text("More")').first().click();
await shot(page, '21-use-again-1440');
await go(phone, '/outreach/email');
await phoneOk(phone, 'Email with the Templates row');
await shot(phone, '22-email-tab-390');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill('SIGTERM');
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Shots in ${SHOTS}`);
if (failed) { console.log(serverLog.slice(-2000)); process.exit(1); }
