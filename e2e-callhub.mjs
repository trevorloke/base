// CallHub — a call list goes to the dialer and every call's result comes
// back on the person. A fresh in-memory server with CallHub "connected" to a
// stand-in (server/test/fake-callhub.js): nothing reaches the real CallHub.
//
// A manager opens Settings → Services: the Phone dialer row says what could
// not be confirmed, Check says CallHub isn't sending results here yet,
// Connect gives CallHub the address, Check passes. On a list's page, Send to
// CallHub asks first (how many numbers, how many left out), then the line
// says how far it is and ends "Sent"; do-not-call and do-not-contact never
// leave, and only phones, names and cities do. Results arrive: each is a
// call on the person's history, credited to the caller when their CallHub
// email is their sign-in; "What each result counts as" is filled in by
// pattern and correctable, and a rating comes only from the question and
// answers someone picks. A pick that would tag people do-not-call or rate
// them asks first, in place, naming the result; "No" (or Escape) changes
// nothing, and putting a row back — which asks too, even after one arrow
// key — takes the tag (and CallHub's entry) off again — on a list sent
// since that copied the row too — and names anyone it leaves tagged (by
// hand, or by another call). A phone bank is sent
// the same way; a number CallHub calls is crossed off there. A refusal stops
// the push with CallHub's words, Carry on finishes it, and "Send again" is
// only offered quietly beside it (not at all on a push left part-way). The
// do-not-call numbers CallHub won't take, and the ones it won't let go, are
// said with whose they are — every one of them a tap away. With CallHub off
// there is no button at all. Measured at 1440 and 390.
//
//   node e2e-callhub.mjs     (starts its own server on :4980 and the stand-in on :4981;
//                             PORT=… to move them; SHOTS=… for the screenshots)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { startFakeCallHub } from './server/test/fake-callhub.js';

const PORT = Number(process.env.PORT) || 4980;
const SHOTS = process.env.SHOTS || '/tmp/starbase-callhub';
mkdirSync(SHOTS, { recursive: true });
const KEY = 'e2e-callhub-key-not-a-real-one';
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;

const fake = await startFakeCallHub({ port: PORT + 1, apiKey: KEY });
const env = {
  ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT),
  CALLHUB_API_KEY: KEY, CALLHUB_API_BASE: fake.url, STARBASE_PUBLIC_URL: BASE, STARBASE_JOBS_EVERY_MS: '1000',
};
for (const k of ['STARBASE_JOBS', 'BASE_PATH', 'SITE_HOSTS']) delete env[k];
const server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { server.kill(); });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const text = async (p, sel = 'main') => ((await p.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
// What the page measures: sideways scroll, yellow buttons, the smallest thing to tap inside `sel`.
const measure = (p, sel) => p.locator(sel).first().evaluate((root) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const taps = [...root.querySelectorAll('button, select, a.btn')].filter(vis).map((el) => Math.round(el.getBoundingClientRect().height));
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, yellow: [...document.querySelectorAll('.btn-primary')].filter(vis).length, minTap: taps.length ? Math.min(...taps) : null };
});

// ── A manager at the desk (1440), and the same sign-in on a phone (390) ──
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const api = async (path, body) => {
  const r = body === undefined ? await dctx.request.get(`${BASE}/api${path}`) : await dctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@callhub.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await dctx.storageState() });
const phone = await pctx.newPage();
phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));

// Sam is staff, and a caller in CallHub under the same email.
const samEmail = `sam+${tag}@callhub.example`;
const inv = (await api('/actions/member.invite', { email: samEmail, role: 'staff' })).json;
const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const sp = await sctx.newPage();
await sp.goto(`${BASE}/login`);
await sp.evaluate(async (t) => fetch('/api/auth/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t, name: 'Sam Caller', password: 'callhub-pass-2026' }) }), inv.joinUrl.split('/join/')[1]);

const P = {};
const people = [
  ['ana', 'Ana Example', '604-555-0101', []], ['ben', 'Ben Example', '(604) 555-0102', []], ['cy', 'Cy Example', '604 555 0103', []],
  ['dev', 'Dev Example', '604-555-0104', []], ['eli', 'Eli Example', '604-555-0105', []], ['fay', 'Fay Example', '604-555-0106', []],
  ['gus', 'Gus Example', '604-555-0107', []], ['hana', 'Hana Example', '604-555-0108', []],
  ['alex', 'Alex Example', '604-555-0110', []], ['zoe', 'Zoe Example', '(604) 555-0110', []],
  ['noel', 'Noel Example', '604-555-0121', ['do-not-call']], ['dee', 'Dee Example', '604-555-0120', ['do-not-contact']],
  ['none', 'No Phone Example', null, []],
];
for (const [key, name, ph, tags] of people) {
  P[key] = (await api('/actions/person.create', { name, city: 'Surrey', ...(ph ? { phone: ph } : {}), tags: ['newton', ...tags] })).json.person.id;
}
const listId = (await api('/actions/list.create', { name: 'Undecided in Newton', kind: 'people', person_ids: Object.values(P) })).json.list.id;
const bankId = (await api('/actions/bank.create', { name: 'Newton evening', person_ids: [P.ana, P.ben, P.cy, P.gus, P.hana] })).json.bank.id;

// ── Settings → Services ──
const row = '.sv2-row:has(.sv2-name:text-is("Phone dialer (CallHub)"))';
await page.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(row, { timeout: 10000 });
let rowText = await text(page, row);
check('Services: “Phone dialer (CallHub)” is set up and says what could not be confirmed',
  /Set up/.test(rowText) && rowText.includes('Built from CallHub’s published documentation. Before your first calling night: press Check, then make one test call and see its result arrive on the person.'), rowText);
await page.click(`${row} .sv2-check`);
await page.waitForSelector(`${row} .sv2-row__main > .sv2-said`, { timeout: 10000 });
check('Check, before connecting: “The key works, but CallHub isn’t sending results here yet — tap Connect”',
  (await text(page, `${row} .sv2-row__main > .sv2-said`)) === '✕ The key works, but CallHub isn’t sending results here yet — tap Connect', await text(page, `${row} .sv2-row__main > .sv2-said`));
check('…and Check wrote nothing at CallHub', fake.webhooks.length === 0 && fake.calls.every((c) => c.method === 'GET'), fake.calls.map((c) => `${c.method} ${c.path}`).join(' | '));
await page.click(`${row} .svc-connect button`);
await page.waitForSelector(`${row} .svc-connect .sv2-said`, { timeout: 10000 });
check('Connect: “CallHub now sends each call’s result here”, and the earlier Check’s line is gone',
  (await text(page, `${row} .svc-connect .sv2-said`)) === '✓ CallHub now sends each call’s result here' && !(await page.$(`${row} .sv2-row__main > .sv2-said`)), await text(page, row));
const hook = fake.webhooks[0]?.target || '';
check('CallHub was given one cc.notes address on this server, ending in a key', fake.webhooks.length === 1 && fake.webhooks[0].event === 'cc.notes' && new RegExp(`^${BASE}/hooks/callhub/[0-9a-f]{32}$`).test(hook), hook.replace(/[0-9a-f]{32}$/, '<key>'));
await page.click(`${row} .sv2-check`);
await page.locator(`${row} .sv2-row__main > .sv2-said`).filter({ hasText: 'results come back here' }).waitFor({ timeout: 10000 }).catch(() => {});
check('Check, after: “✓ The key works · results come back here”', (await text(page, `${row} .sv2-row__main > .sv2-said`)) === '✓ The key works · results come back here', await text(page, `${row} .sv2-row__main > .sv2-said`));
const whole = await text(page);
check('the page never shows the key or the address’s last part', !whole.includes(KEY) && !whole.includes(hook.split('/').pop()) && whole.includes(`${BASE}/hooks/callhub/…`), '');
await page.locator(row).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/01-services-1440.png` });
await phone.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector(row, { timeout: 10000 });
await phone.tap(`${row} .sv2-check`);
await phone.waitForSelector(`${row} .sv2-row__main > .sv2-said`, { timeout: 10000 });
await phone.locator(row).scrollIntoViewIfNeeded();
await phone.screenshot({ path: `${SHOTS}/01-services-390.png` });
let m = await measure(phone, row);
check('Services at 390: no sideways scroll, Check and Connect ≥ 48px', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));

// ── A list goes to CallHub ──
const ch = 'section.ch';
await page.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(ch, { timeout: 10000 });
await page.waitForFunction((s) => /Sends this list/.test(document.querySelector(s)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
check('a list’s page offers “Send to CallHub”, with one line on what it does',
  (await text(page, `${ch} .ch-head .btn`)) === 'Send to CallHub' && /Sends this list to CallHub’s dialer\. Each call’s result comes back onto the person\./.test(await text(page, ch)), await text(page, ch));
await page.screenshot({ path: `${SHOTS}/02-list-before-1440.png` });
await page.click(`${ch} .ch-head .btn`);
await page.waitForSelector(`${ch} .ch-ask strong`, { timeout: 10000 });
const ask = await text(page, `${ch} .ch-ask`);
check('it asks first: “9 numbers to send for 10 people · 3 left out (no number, or do not call)”, and what goes', /^9 numbers to send for 10 people · 3 left out \(no number, or do not call\) Only names, numbers and cities go\./.test(ask), ask);
await page.screenshot({ path: `${SHOTS}/03-list-ask-1440.png` });
const before = fake.calls.length;
await page.click(`${ch} .ch-ask button:has-text("Send")`);
await page.waitForSelector(`${ch} .ch-push`, { timeout: 10000 });
// Part-way: the line says how far, on the desk and on a phone.
await phone.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction((s) => /Sending · [2-7] of 9/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 30000 }).catch(() => {});
const mid = await text(page, `${ch} .ch-status`);
check('while it goes: “Sending · N of 9”, and nothing else to send', /^Sending · \d of 9$/.test(mid) && !(await page.$(`${ch} .ch-head .btn`)), mid);
await page.screenshot({ path: `${SHOTS}/04-list-sending-1440.png` });
await phone.waitForSelector(`${ch} .ch-status`, { timeout: 10000 }).catch(() => {});
await phone.screenshot({ path: `${SHOTS}/04-list-sending-390.png` });
check('…the same on a phone', /^(Sending · \d of 9|Sent · 9 numbers)/.test(await text(phone, `${ch} .ch-status`)), await text(phone, `${ch} .ch-status`));
await page.waitForFunction((s) => /^Sent/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 60000 }).catch(() => {});
const done = await text(page, `${ch} .ch-push`);
check('then: “Sent · 9 numbers”, the phonebook’s name, who was left out, who sent it, and what to do next',
  /^Sent · 9 numbers · \d{1,2}:\d{2} [ap]m /.test(done) && /Phonebook in CallHub: “Undecided in Newton — [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [ap]m” · 3 left out · sent by Marco Manager/.test(done)
  && /Next: start the calling campaign on this phonebook in CallHub\./.test(done), done);
const sent = fake.upserts().filter((c) => c.status < 300).map((c) => c.params);
const left = JSON.stringify(sent);
check('CallHub got nine contacts: one per number, phones, names and cities only',
  sent.length === 9 && sent.every((c) => Object.keys(c).every((k) => ['contact', 'first_name', 'last_name', 'city', 'country_code'].includes(k)))
  && sent.filter((c) => c.contact === '+16045550110').length === 1 && sent.find((c) => c.contact === '+16045550110').first_name === 'Alex', left.slice(0, 200));
check('do-not-call, do-not-contact and the tag never left', !/5550121|5550120|Noel|Dee|newton|do-not/.test(left), '');
check('…and their numbers went to CallHub’s do-not-call list instead',
  fake.dncLists.length === 1 && fake.dncLists[0].name === 'base.win' && JSON.stringify(fake.dnc.map((d) => [d.phone_number, d.category]).sort()) === JSON.stringify([['+16045550120', 3], ['+16045550121', 1]]), JSON.stringify(fake.dnc));
check('every call to CallHub carried the key', fake.calls.slice(before).every((c) => c.auth === `Token ${KEY}`), '');
await page.screenshot({ path: `${SHOTS}/05-list-sent-1440.png` });

// ── Results come back ──
const survey = (answer) => [{ question: 'Can we count on your support?', answer }, { question: 'Top issue', answer: 'Transit' }];
const jo = { id: 9, username: 'jo', email: 'jo@elsewhere.example' };
const notes = [
  { contact: '+16045550101', disposition: 'Answered', notes: 'Wants a lawn sign. Call after six.', surveys: survey('Yes, definitely'), agent: { id: 3, username: 'sam.c', email: samEmail } },
  { contact: '+16045550102', disposition: 'Answered', notes: 'Asked about the candidate’s plan for transit.', surveys: survey('Not sure yet'), agent: jo },
  { contact: '+16045550103', disposition: 'No Answer', agent: jo },
  { contact: '+16045550104', disposition: 'No Answer', agent: jo },
  { contact: '+16045550105', disposition: 'Left voicemail', agent: jo },
  { contact: '+16045550106', disposition: 'Call back later', notes: 'Putting the kids to bed.', agent: jo },
  { contact: '+16045550107', disposition: 'Do not call', notes: 'Asked to be taken off the list.', agent: jo },
  { contact: '+16045550108', disposition: 'Wrong number', agent: jo },
  { contact: '+16045550110', disposition: 'Answered', notes: 'Shared line: spoke with Alex.', surveys: survey('Yes, definitely'), agent: jo },
  { contact: '+16045550199', disposition: 'Answered', notes: 'A number base.win never sent.', agent: jo },
];
const answers = [];
for (const n of notes) answers.push(await fake.note({ campaign: 'Fall voter ID', ...n }, { envelope: notes.indexOf(n) % 2 ? 'flat' : 'data', as: notes.indexOf(n) % 3 ? 'json' : 'form' }));
check('ten results delivered — JSON and forms, inside “data” and not: nine filed, the stranger’s kept unfiled',
  answers.every((a) => a.status === 200) && answers.filter((a) => a.body.filed).length === 9 && answers[9].body.filed === false, JSON.stringify(answers.map((a) => a.body)));
const again = await fake.note({ campaign: 'Fall voter ID', ...notes[2] });
check('the same result sent twice is one call', again.body.duplicate === true, JSON.stringify(again.body));

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction((s) => /results back/.test(document.querySelector(s)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
check('the list’s page: “9 results back”', /9 results back/.test(await text(page, `${ch} .ch-push`)), await text(page, `${ch} .ch-push`));
await page.click(`${ch} .ch-push .disclose`);
await page.waitForSelector(`${ch} .ch-map__row`, { timeout: 10000 });
const table = await page.$$eval(`${ch} .ch-results > .ch-map .ch-map__row`, (rows) => rows.map((r) => `${r.querySelector('label').innerText.replace(/\s+/g, ' ').trim()} → ${r.querySelector('select').selectedOptions[0].innerText}`));
check('“What each result counts as”, filled in by pattern',
  JSON.stringify(table) === JSON.stringify(['Answered 3 → Talked', 'No Answer 2 → No answer', 'Call back later 1 → Talked', 'Do not call 1 → Do not call', 'Left voicemail 1 → Left message', 'Wrong number 1 → Wrong number']), table.join(' | '));
const benBefore = (await api(`/persons/${P.ben}`)).json.person.rating;
await page.screenshot({ path: `${SHOTS}/06-list-outcomes-1440.png`, fullPage: true });
// A correction: "Call back later" is a No answer here — what is already in follows.
await page.selectOption(`${ch} .ch-map__row:has(label:has-text("Call back later")) select`, 'no_answer');
await page.waitForFunction((s) => /Saved/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-results [role="status"]`, { timeout: 10000 }).catch(() => {});
check('a correction says “Saved · 1 result already in moved too”', (await text(page, `${ch} .ch-results [role="status"]`)) === 'Saved · 1 result already in moved too', await text(page, `${ch} .ch-results [role="status"]`));
const fay = (await api(`/persons/${P.fay}`)).json.contacts[0];
check('…and Fay’s call is a No answer now', fay.channel === 'phone' && fay.outcome === 'no_answer', JSON.stringify(fay && { o: fay.outcome }));
// The support question: nobody is rated until someone says which answer means what.
check('before a question is picked nobody’s rating has moved', benBefore === null && (await api(`/persons/${P.ana}`)).json.person.rating === null, String(benBefore));
await page.selectOption(`${ch} .ch-rate .field select`, 'Can we count on your support?');
await page.waitForSelector(`${ch} .ch-rate .ch-map__row`, { timeout: 10000 });
await page.selectOption(`${ch} .ch-rate .ch-map__row:has(label:has-text("Yes, definitely")) select`, '1');
await page.waitForSelector(`${ch} .ch-confirm`, { timeout: 10000 });
const rateAsk = await text(page, `${ch} .ch-confirm`);
check('an answer picked to rate people asks first, in place — nobody is rated until Yes',
  /^Rate everyone who answered “Yes, definitely” as .+\? Yes No$/.test(rateAsk) && (await api(`/persons/${P.ana}`)).json.person.rating === null
  && (await page.evaluate(() => document.activeElement?.textContent)) === 'No', rateAsk);
await page.screenshot({ path: `${SHOTS}/07-list-rating-ask-1440.png`, fullPage: true });
await page.click(`${ch} .ch-confirm button:has-text("Yes")`);
await page.waitForFunction((s) => /2 results already in moved too/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-results [role="status"]`, { timeout: 10000 }).catch(() => {});
check('…then: “Saved · 2 results already in moved too · 2 people rated”', (await text(page, `${ch} .ch-results [role="status"]`)) === 'Saved · 2 results already in moved too · 2 people rated', await text(page, `${ch} .ch-results [role="status"]`));
const ana = (await api(`/persons/${P.ana}`)).json;
check('“Yes, definitely” mapped to the scale’s first step: Ana and Alex are rated; “Not sure yet”, unmapped, rates nobody',
  ana.person.rating === '1' && (await api(`/persons/${P.alex}`)).json.person.rating === '1' && (await api(`/persons/${P.ben}`)).json.person.rating === null, ana.person.rating);
await page.screenshot({ path: `${SHOTS}/07-list-rating-1440.png`, fullPage: true });

// A slip on a result's row: one key on "Answered" would make every supporter reached do-not-call.
const tagged = async (id) => (await api(`/persons/${id}`)).json.person.tags.includes('do-not-call');
const answered = `${ch} .ch-results > .ch-map .ch-map__row:has(label:has-text("Answered"))`;
await page.focus(`${answered} select`);
await page.keyboard.press('d');
await page.waitForSelector(`${answered} .ch-confirm`, { timeout: 10000 });
const dncAsk = await text(page, `${answered} .ch-confirm`);
check('“Do not call” on a row asks first, naming the result: “Tag the 3 people with “Answered” do-not-call? They leave every call list.” — and nothing is tagged',
  dncAsk === 'Tag the 3 people with “Answered” do-not-call? They leave every call list. Yes No' && !(await tagged(P.ana)) && !(await tagged(P.ben))
  && (await page.$eval(`${answered} select`, (el) => el.selectedOptions[0].innerText)) === 'Talked', dncAsk);
await page.locator(answered).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/10-do-not-call-ask-1440.png` });
await phone.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
await phone.waitForFunction((s) => /results back/.test(document.querySelector(s)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
await phone.tap(`${ch} .ch-push .disclose`);
await phone.waitForSelector(`${answered} select`, { timeout: 10000 });
await phone.selectOption(`${answered} select`, 'do_not_call');
await phone.waitForSelector(`${answered} .ch-confirm`, { timeout: 10000 });
await phone.locator(`${answered} .ch-confirm`).scrollIntoViewIfNeeded();
await phone.screenshot({ path: `${SHOTS}/10-do-not-call-ask-390.png` });
m = await measure(phone, ch);
check('the ask at 390: no sideways scroll, Yes and No ≥ 48px', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await page.keyboard.press('Enter'); // focus is on No
await page.waitForSelector(`${answered} .ch-confirm`, { state: 'detached', timeout: 10000 }).catch(() => {});
check('“No” (where the keyboard lands): the row is as it was, and nobody is tagged', !(await page.$(`${ch} .ch-confirm`)) && !(await tagged(P.ana))
  && (await api(`/persons/${P.ana}`)).json.contacts[0].outcome === 'contacted', '');
// The keyboard is back on the select: the same slip again, and Escape is No too.
await page.keyboard.press('d');
await page.waitForSelector(`${answered} .ch-confirm`, { timeout: 10000 }).catch(() => {});
const askedAgain = Boolean(await page.$(`${answered} .ch-confirm`));
await page.keyboard.press('Escape');
await page.waitForSelector(`${answered} .ch-confirm`, { state: 'detached', timeout: 10000 }).catch(() => {});
check('Escape closes the question like No: nothing changes, and the keyboard is on the row’s select again',
  askedAgain && !(await page.$(`${ch} .ch-confirm`)) && !(await tagged(P.ana)) && (await page.$eval(`${answered} select`, (el) => el.selectedOptions[0].innerText)) === 'Talked'
  && (await page.locator(`${answered} select`).evaluate((el) => document.activeElement === el)), '');
// Meant, on another row — and then put back: the tag comes off again, at CallHub too.
const voicemail = `${ch} .ch-results > .ch-map .ch-map__row:has(label:has-text("Left voicemail"))`;
await page.selectOption(`${voicemail} select`, 'do_not_call');
await page.click(`${voicemail} .ch-confirm button:has-text("Yes")`);
await page.waitForFunction((s) => /tagged do-not-call/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-results [role="status"]`, { timeout: 10000 }).catch(() => {});
check('Yes: “Saved · 1 result already in moved too · 1 person tagged do-not-call”',
  (await text(page, `${ch} .ch-results [role="status"]`)) === 'Saved · 1 result already in moved too · 1 person tagged do-not-call' && await tagged(P.eli), await text(page, `${ch} .ch-results [role="status"]`));
for (let i = 0; i < 20 && !fake.dnc.some((d) => d.phone_number === '+16045550105'); i += 1) await sleep(500);
check('…and CallHub is told', fake.dnc.some((d) => d.phone_number === '+16045550105' && d.category === 1), JSON.stringify(fake.dnc.map((d) => d.phone_number)));
// Away from it lets people be called again (on the lists sent since that copied it, too): a slip —
// one arrow key on the focused select — asks first as well, and No leaves everyone as they were.
const rowSays = (row) => page.$eval(`${row} select`, (el) => el.selectedOptions[0].innerText);
// The question on a phone first (left unanswered there).
await phone.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
await phone.waitForFunction((s) => /results back/.test(document.querySelector(s)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
await phone.tap(`${ch} .ch-push .disclose`);
await phone.waitForSelector(`${voicemail} select`, { timeout: 10000 });
await phone.selectOption(`${voicemail} select`, 'left_message');
await phone.waitForSelector(`${voicemail} .ch-confirm`, { timeout: 5000 }).catch(() => {});
await phone.locator(`${voicemail} .ch-confirm`).scrollIntoViewIfNeeded().catch(() => {});
await phone.screenshot({ path: `${SHOTS}/11-put-back-ask-390.png` });
m = await measure(phone, ch);
check('the put-back question at 390: no sideways scroll, Yes and No ≥ 48px', Boolean(await phone.$(`${voicemail} .ch-confirm`)) && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await page.focus(`${voicemail} select`);
await page.keyboard.press('ArrowUp');
await page.waitForSelector(`${voicemail} .ch-confirm`, { timeout: 5000 }).catch(() => {});
const slipAsk = await text(page, `${voicemail} .ch-confirm`);
await page.keyboard.press('Enter'); // focus is on No
await page.waitForSelector(`${voicemail} .ch-confirm`, { state: 'detached', timeout: 10000 }).catch(() => {});
check('one arrow key away from “Do not call” asks first: “Stop counting “Left voicemail” as do not call? Whoever it tagged can be called again.” — No leaves Eli tagged',
  slipAsk === 'Stop counting “Left voicemail” as do not call? Whoever it tagged can be called again. Yes No' && await tagged(P.eli) && (await rowSays(voicemail)) === 'Do not call', slipAsk || await rowSays(voicemail));
if ((await rowSays(voicemail)) !== 'Do not call') { // (before the question existed the slip saved at once: undone, so the run goes on)
  await api('/actions/callhub.map', { id: (await api(`/callhub/pushes?list=${listId}`)).json.pushes[0].id, outcomes: { 'Left voicemail': 'do_not_call' } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((s) => /results back/.test(document.querySelector(s)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
  await page.click(`${ch} .ch-push .disclose`);
  await page.waitForSelector(`${voicemail} select`, { timeout: 10000 });
}
await page.selectOption(`${voicemail} select`, 'left_message');
await page.waitForSelector(`${voicemail} .ch-confirm`, { timeout: 5000 }).catch(() => {});
check('put back by a pick: the same question, and nothing changes before Yes', (await text(page, `${voicemail} .ch-confirm`)).startsWith('Stop counting “Left voicemail” as do not call?') && await tagged(P.eli), '');
await page.locator(voicemail).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/11-put-back-ask-1440.png` });
if (await page.$(`${voicemail} .ch-confirm`)) await page.click(`${voicemail} .ch-confirm button:has-text("Yes")`);
await page.waitForFunction((s) => /no longer do-not-call/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-results [role="status"]`, { timeout: 10000 }).catch(() => {});
check('put back: “Saved · 1 result already in moved too · 1 person is no longer do-not-call”',
  (await text(page, `${ch} .ch-results [role="status"]`)) === 'Saved · 1 result already in moved too · 1 person is no longer do-not-call' && !(await tagged(P.eli)), await text(page, `${ch} .ch-results [role="status"]`));
for (let i = 0; i < 20 && fake.dnc.some((d) => d.phone_number === '+16045550105'); i += 1) await sleep(500);
check('…and the number comes off CallHub’s do-not-call list again', !fake.dnc.some((d) => d.phone_number === '+16045550105'), JSON.stringify(fake.dnc.map((d) => d.phone_number)));
await page.screenshot({ path: `${SHOTS}/11-put-back-1440.png`, fullPage: true });
m = await measure(page, ch);
check('the list’s page at 1440: one yellow button at most, nothing to tap under 48px in the CallHub block', m.yellow <= 1 && m.minTap >= 48, JSON.stringify(m));

await phone.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
await phone.waitForFunction((s) => /results back/.test(document.querySelector(s)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
await phone.tap(`${ch} .ch-push .disclose`);
await phone.waitForSelector(`${ch} .ch-rate .ch-map__row`, { timeout: 10000 });
await phone.locator(ch).scrollIntoViewIfNeeded();
await phone.screenshot({ path: `${SHOTS}/07-list-rating-390.png`, fullPage: true });
m = await measure(phone, ch);
check('the same at 390: no sideways scroll, one yellow button at most, every select and button ≥ 48px', m.overflow <= 0 && m.yellow <= 1 && m.minTap >= 48, JSON.stringify(m));

// ── A person's history ──
await page.goto(`${ADMIN}/people/${P.ana}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.timeline li', { timeout: 10000 });
const hist = await text(page, '.timeline li >> nth=0');
check('Ana’s history: a phone call from CallHub, credited to Sam, with the result, the notes and the answers',
  /Phone/.test(hist) && /Sam Caller/.test(hist) && /CallHub: Fall voter ID\. Result: Answered\. Notes: Wants a lawn sign\. Call after six\. Can we count on your support\? Yes, definitely\. Top issue: Transit\./.test(hist) && !/Caller:/.test(hist), hist);
await page.locator('.timeline').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/08-person-1440.png` });
await phone.goto(`${ADMIN}/people/${P.ana}`, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.timeline li', { timeout: 10000 });
await phone.locator('.timeline').scrollIntoViewIfNeeded();
await phone.screenshot({ path: `${SHOTS}/08-person-390.png` });
m = await measure(phone, '.timeline');
check('the history at 390: no sideways scroll', m.overflow <= 0, JSON.stringify(m));
const ben = (await api(`/persons/${P.ben}`)).json.contacts[0];
check('a caller who is not on the campaign is named in the note instead', ben.by_name === null && /Caller: jo\./.test(ben.note), ben.note);
const gus = (await api(`/persons/${P.gus}`)).json;
check('“Do not call” is a refusal, and Gus is tagged do-not-call', gus.contacts[0].outcome === 'refused' && gus.person.tags.includes('do-not-call'), JSON.stringify(gus.person.tags));
await phone.goto(`${ADMIN}/people/${P.gus}`, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.pf-meta', { timeout: 10000 });
check('…his profile says “Do not call” by his name, and offers no Call to tap', /Do not call/.test(await text(phone, '.pf-meta')) && !(await phone.$('.pf-acts .pf-act:has-text("Call")')) && !(await phone.$('a[href^="tel:"]')), await text(phone, '.pf-meta'));
await phone.screenshot({ path: `${SHOTS}/08-person-do-not-call-390.png` });
// The same wherever the desk would otherwise dial with one tap: his follow-up, his request, the People list.
await api('/actions/request.ask', { person_id: P.gus, kind: 'volunteer', note: 'Wants to help on weekends' });
await api('/actions/request.ask', { person_id: P.hana, kind: 'volunteer', note: 'Wants to help' });
const dials = (p, sel) => p.$$eval(sel, (els) => els.map((el) => `${(el.querySelector('a[href*="/people/"]')?.innerText || '?').trim()}: ${el.querySelector('a[href^="tel:"]') ? 'Call' : 'no Call'}${/Do not call/.test(el.innerText) ? ' · Do not call' : ''}`).sort());
for (const [p, n] of [[page, '1440'], [phone, '390']]) {
  await p.goto(`${ADMIN}/follow-ups`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.lad-fu', { timeout: 15000 }).catch(() => {});
  await sleep(500);
  await p.screenshot({ path: `${SHOTS}/08-follow-ups-do-not-call-${n}.png` });
}
const fuRows = await dials(phone, '.lad-fu');
check('the desk’s Follow-ups: Gus’s card says “Do not call” and has no Call; Hana’s still has one',
  JSON.stringify(fuRows) === JSON.stringify(['Gus Example: no Call · Do not call', 'Hana Example: Call']) && JSON.stringify(await dials(page, '.lad-fu')) === JSON.stringify(fuRows), fuRows.join(' | '));
m = await measure(phone, '.lad-fu');
check('…at 390: no sideways scroll, nothing to tap under 48px', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await page.goto(`${ADMIN}/requests`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.rq-row', { timeout: 15000 }).catch(() => {});
const rqRows = await dials(page, '.rq-row');
check('Requests from the doors: the same', JSON.stringify(rqRows) === JSON.stringify(['Gus Example: no Call · Do not call', 'Hana Example: Call']), rqRows.join(' | '));
await page.screenshot({ path: `${SHOTS}/08-requests-do-not-call-1440.png` });
await page.goto(`${ADMIN}/people`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pp-table__name', { timeout: 15000 }).catch(() => {});
const listed = await page.$$eval('.pp-table tbody tr', (rows) => Object.fromEntries(rows.map((r) => [r.querySelector('.pp-table__name a')?.innerText.trim(), Boolean(r.querySelector('a[href^="tel:"]'))])));
check('the People list at the desk: Gus’s and Noel’s numbers are shown, not links to dial; Hana’s is one',
  listed['Gus Example'] === false && listed['Noel Example'] === false && listed['Hana Example'] === true, JSON.stringify(listed).slice(0, 240));
// A door's card and a walk list: there the canvasser's own phone would dial.
await pctx.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8eef2"/></svg>' }));
const doorQuiet = (await api('/actions/person.create', { name: 'Door Quiet Example', phone: '604-555-0133', address: '12390 72 Ave', city: 'Surrey', lat: 49.1331, lng: -122.8495, tags: ['do-not-call'] })).json.person.id;
const doorOpen = (await api('/actions/person.create', { name: 'Door Open Example', phone: '604-555-0134', address: '7120 124 St', city: 'Surrey', lat: 49.131, lng: -122.852 })).json.person.id;
const onDoor = async (id) => {
  await phone.goto(`${ADMIN}/map?person=${id}`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('aside.door-card', { timeout: 15000 }).catch(() => {});
  await phone.click('aside.door-card .fk-more__btn').catch(() => {});
  await phone.waitForSelector('aside.door-card .door-more__row', { timeout: 10000 }).catch(() => {});
  const card = phone.locator('aside.door-card');
  return { call: await card.getByRole('link', { name: 'Call', exact: true }).count(), tel: await card.locator('a[href^="tel:"]').count(), text: await card.getByRole('link', { name: 'Text', exact: true }).count(), says: /Do not call/.test(await text(phone, 'aside.door-card')) };
};
const quietDoor = await onDoor(doorQuiet);
await phone.screenshot({ path: `${SHOTS}/08-door-do-not-call-390.png` });
const openDoorCard = await onDoor(doorOpen);
check('a door’s card: “Do not call” where Call would be (Text stays); a neighbour’s card still has Call',
  quietDoor.call === 0 && quietDoor.tel === 0 && quietDoor.text === 1 && quietDoor.says && openDoorCard.call === 1 && !openDoorCard.says, JSON.stringify([quietDoor, openDoorCard]));
const turf = (await api('/actions/turf.create', { name: 'Newton East', polygon: [[49.125, -122.860], [49.140, -122.860], [49.140, -122.838], [49.125, -122.838]] })).json.turf;
await phone.goto(`${BASE}/turfs/${turf.id}`, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.walk-door', { timeout: 15000 }).catch(() => {});
const onWalk = async (addr) => {
  const head = phone.locator('.walk-door', { hasText: addr }).locator('.walk-door__head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await phone.waitForSelector('.walk-door.is-open .walk-panel', { timeout: 10000 });
  const more = phone.locator('.walk-door.is-open .walk-panel .fk-more__btn');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await phone.waitForSelector('.walk-door.is-open .walk-panel .fk-more__body', { timeout: 10000 });
  return phone.locator('.walk-door.is-open .walk-panel a[href^="tel:"]').count();
};
const walkQuiet = await onWalk('12390 72 Ave').catch((e) => String(e.message).slice(0, 120));
await phone.screenshot({ path: `${SHOTS}/08-walk-do-not-call-390.png` });
const walkOpen = await onWalk('7120 124 St').catch((e) => String(e.message).slice(0, 120));
check('a walk list: no Call for her door; the neighbour’s has one', walkQuiet === 0 && walkOpen === 1, JSON.stringify([walkQuiet, walkOpen]));
await sleep(2500);
check('…and his number went to CallHub’s do-not-call list by itself', fake.dnc.some((d) => d.phone_number === '+16045550107' && d.category === 1), JSON.stringify(fake.dnc.map((d) => d.phone_number)));
const zoe = (await api(`/persons/${P.zoe}`)).json.contacts;
check('the shared number’s call is on Alex (first by name), not on Zoe', zoe.length === 0 && (await api(`/persons/${P.alex}`)).json.contacts.length === 1, String(zoe.length));

// ── The phone bank: crossed off by the dialer's calls, and sent the same way ──
let bank = (await api(`/banks/${bankId}`)).json;
const byName = Object.fromEntries(bank.numbers.map((n) => [n.name, n]));
check('the bank’s numbers CallHub reached are crossed off; a No answer comes back by the bank’s own rule',
  byName['Ana Example'].done_at && byName['Ben Example'].done_at && byName['Gus Example'].done_at && byName['Hana Example'].done_at && !byName['Cy Example'].done_at && byName['Cy Example'].tries === 1, JSON.stringify(bank.numbers.map((n) => [n.name, !!n.done_at, n.tries])));
await page.goto(`${ADMIN}/banks/${bankId}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(ch, { timeout: 10000 });
await page.waitForFunction((s) => /Sends this phone bank/.test(document.querySelector(s)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
check('a phone bank’s page offers it too', (await text(page, `${ch} .ch-head .btn`)) === 'Send to CallHub' && /Sends this phone bank to CallHub’s dialer/.test(await text(page, ch)), await text(page, ch));
// CallHub refuses the key part-way: the push stops with its words.
fake.refuse(401);
await page.click(`${ch} .ch-head .btn`);
await page.waitForSelector(`${ch} .ch-ask strong`, { timeout: 10000 });
check('it asks: the one number still to call', /^1 number to send/.test(await text(page, `${ch} .ch-ask`)), await text(page, `${ch} .ch-ask`));
await page.click(`${ch} .ch-ask button:has-text("Send")`);
await page.waitForFunction((s) => /^Stopped/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 30000 }).catch(() => {});
check('a refusal: “Stopped: CallHub said “Invalid token.” · 0 of 1 sent”, Carry on first, and “Send again” only quietly beside it',
  (await text(page, `${ch} .ch-status`)) === 'Stopped: CallHub said “Invalid token.” · 0 of 1 sent' && (await text(page, `${ch} .ch-stopped`)) === 'Carry on Send again instead'
  && !(await page.$(`${ch} .ch-head .btn`)) && (await page.$eval(`${ch} .ch-stopped .btn:last-child`, (el) => el.classList.contains('btn-quiet'))), await text(page, `${ch} .ch-push`));
await page.locator(ch).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/09-bank-stopped-1440.png` });
await phone.goto(`${ADMIN}/banks/${bankId}`, { waitUntil: 'domcontentloaded' });
await phone.waitForFunction((s) => /^Stopped/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 10000 }).catch(() => {});
await phone.locator(ch).scrollIntoViewIfNeeded();
await phone.screenshot({ path: `${SHOTS}/09-bank-stopped-390.png` });
m = await measure(phone, ch);
check('the bank’s page at 390: no sideways scroll, Carry on ≥ 48px', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
// "Send again instead" asks first — and while it asks, its Send · Cancel are the only pair of buttons.
await page.click(`${ch} .ch-stopped .btn:last-child`);
await page.waitForSelector(`${ch} .ch-ask strong`, { timeout: 10000 }).catch(() => {});
const whileAsking = [Boolean(await page.$(`${ch} .ch-ask`)), Boolean(await page.$(`${ch} .ch-stopped`))];
await page.click(`${ch} .ch-ask button:has-text("Cancel")`);
await page.waitForSelector(`${ch} .ch-stopped`, { timeout: 10000 }).catch(() => {});
check('“Send again instead” asks first, with one pair of buttons on screen; Cancel brings Carry on back',
  whileAsking[0] && !whileAsking[1] && (await text(page, `${ch} .ch-stopped`)) === 'Carry on Send again instead' && !(await page.$(`${ch} .ch-ask`)), JSON.stringify(whileAsking));
// A push left part-way with no job behind it (the server says "stalled"): only Carry on can work, so only Carry on is offered.
const stalledPage = await dctx.newPage();
await stalledPage.route('**/api/callhub/pushes*', async (route) => {
  const res = await route.fetch();
  const json = await res.json();
  if (json.pushes?.[0]) json.pushes[0] = { ...json.pushes[0], status: 'sending', stalled: true, note: null };
  await route.fulfill({ response: res, json });
});
await stalledPage.goto(`${ADMIN}/banks/${bankId}`, { waitUntil: 'domcontentloaded' });
await stalledPage.waitForFunction((s) => /^Stopped/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 10000 }).catch(() => {});
check('a push left part-way: “Stopped: it stopped part-way · 0 of 1 sent”, and Carry on alone',
  (await text(stalledPage, `${ch} .ch-status`)) === 'Stopped: it stopped part-way · 0 of 1 sent' && (await text(stalledPage, `${ch} .ch-stopped`)) === 'Carry on' && !(await stalledPage.$(`${ch} .ch-head .btn`)), await text(stalledPage, `${ch} .ch-push`));
await stalledPage.locator(ch).scrollIntoViewIfNeeded();
await stalledPage.screenshot({ path: `${SHOTS}/09-bank-stalled-1440.png` });
await stalledPage.close();
fake.refuse(false);
await phone.tap(`${ch} .ch-stopped .btn:first-child`);
await phone.waitForFunction((s) => /^Sent/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 30000 }).catch(() => {});
check('Carry on, from the phone: “Sent · 1 number”, in the same phonebook', /^Sent · 1 number ·/.test(await text(phone, `${ch} .ch-status`)) && [...fake.phonebooks.values()].filter((b) => /^Newton evening/.test(b.name)).length === 1, await text(phone, `${ch} .ch-status`));

// ── A row put back is put back on the list sent since that copied it ──
const rang = { campaign: 'Fall voter ID', disposition: 'Rang out', agent: jo };
const ida = (await api('/actions/person.create', { name: 'Ida Example', city: 'Surrey', phone: '604-555-0131' })).json.person.id;
const jay = (await api('/actions/person.create', { name: 'Jay Example', city: 'Surrey', phone: '604-555-0132' })).json.person.id;
const firstList = (await api('/actions/list.create', { name: 'Fleetwood first', kind: 'people', person_ids: [ida] })).json.list.id;
const laterList = (await api('/actions/list.create', { name: 'Fleetwood later', kind: 'people', person_ids: [jay] })).json.list.id;
const sentOf = async (q) => { for (let i = 0; i < 80; i += 1) { const p = (await api(`/callhub/pushes?${q}`)).json.pushes[0]; if (p && (p.status === 'sent' || p.status === 'failed')) return p; await sleep(500); } return null; };
const firstPush = (await api('/actions/callhub.push', { list_id: firstList })).json.push;
await sentOf(`list=${firstList}`);
await fake.note({ ...rang, contact: '+16045550131', notes: 'Rang and rang.' });
// "Rang out" slips to Do not call on the first list (asked, Yes); a second list is sent before anyone notices.
await api('/actions/callhub.map', { id: firstPush.id, outcomes: { 'Rang out': 'do_not_call' } });
await api('/actions/callhub.push', { list_id: laterList });
await sentOf(`list=${laterList}`);
await fake.note({ ...rang, contact: '+16045550132', notes: 'No pick-up.' });
check('a list sent after a slip starts as a copy of that table: its “Rang out” result tags Jay at once', (await tagged(ida)) && (await tagged(jay)), '');
const rangOut = `${ch} .ch-results > .ch-map .ch-map__row:has(label:has-text("Rang out"))`;
await page.goto(`${ADMIN}/lists/${firstList}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction((sel) => /result back/.test(document.querySelector(sel)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
await page.click(`${ch} .ch-push .disclose`);
await page.waitForSelector(`${rangOut} select`, { timeout: 10000 });
await page.selectOption(`${rangOut} select`, 'contacted');
await page.waitForSelector(`${rangOut} .ch-confirm`, { timeout: 5000 }).catch(() => {});
if (await page.$(`${rangOut} .ch-confirm`)) await page.click(`${rangOut} .ch-confirm button:has-text("Yes")`);
await page.waitForFunction((sel) => /no longer do-not-call/.test(document.querySelector(sel)?.innerText || ''), `${ch} .ch-results [role="status"]`, { timeout: 10000 }).catch(() => {});
const followed = await text(page, `${ch} .ch-results [role="status"]`);
check('put back on the first list: “Saved · 1 result already in moved too · 1 person is no longer do-not-call · 1 list sent since follows too”',
  followed === 'Saved · 1 result already in moved too · 1 person is no longer do-not-call · 1 list sent since follows too', followed);
await page.locator(`${ch} .ch-results [role="status"]`).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/12-later-list-follows-1440.png` });
// The same line at a phone's width (it is this page's own, so the window is narrowed).
await page.setViewportSize({ width: 390, height: 844 });
await sleep(400);
await page.locator(`${ch} .ch-results [role="status"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${SHOTS}/12-later-list-follows-390.png` });
m = await measure(page, ch);
check('…the line at 390 wide: no sideways scroll', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await page.setViewportSize({ width: 1440, height: 900 });
for (let i = 0; i < 30 && await tagged(jay); i += 1) await sleep(500);
const laterRow = (await api(`/callhub/pushes?list=${laterList}`)).json.pushes[0].dispositions.find((d) => d.disposition === 'Rang out');
check('…and the later list follows by itself: its row reads Talked again, and Jay is no longer do-not-call', laterRow.outcome === 'contacted' && !(await tagged(jay)) && !(await tagged(ida)), JSON.stringify(laterRow));
// A pick that tags is about the one list it was asked on: nothing follows on the later one.
const only = (await api('/actions/callhub.map', { id: firstPush.id, outcomes: { 'Rang out': 'do_not_call' } })).json;
check('a pick that tags stays on its own list', only.tagged === 1 && only.later === 0 && (await tagged(ida)) && !(await tagged(jay)), JSON.stringify({ tagged: only.tagged, later: only.later }));
await api('/actions/callhub.map', { id: firstPush.id, outcomes: { 'Rang out': null } });
// A row put back that leaves someone tagged — here by hand, before the slip — says so, by name, so the desk can look.
await api('/actions/person.update', { id: ida, tags: ['do-not-call'] });
await api('/actions/callhub.map', { id: firstPush.id, outcomes: { 'Rang out': 'do_not_call' } });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction((sel) => /result back/.test(document.querySelector(sel)?.innerText || ''), ch, { timeout: 10000 }).catch(() => {});
await page.click(`${ch} .ch-push .disclose`);
await page.waitForSelector(`${rangOut} select`, { timeout: 10000 });
await page.selectOption(`${rangOut} select`, 'contacted');
await page.waitForSelector(`${rangOut} .ch-confirm`, { timeout: 5000 }).catch(() => {});
if (await page.$(`${rangOut} .ch-confirm`)) await page.click(`${rangOut} .ch-confirm button:has-text("Yes")`);
await page.waitForFunction((sel) => /stays do-not-call/.test(document.querySelector(sel)?.innerText || ''), `${ch} .ch-results [role="status"]`, { timeout: 10000 }).catch(() => {});
const stayLine = await text(page, `${ch} .ch-results [role="status"]`);
check('a row put back that leaves someone tagged by hand names her: “Saved · 1 result already in moved too · 1 person stays do-not-call, tagged by hand — Ida Example”',
  stayLine === 'Saved · 1 result already in moved too · 1 person stays do-not-call, tagged by hand — Ida Example' && (await tagged(ida))
  && (await page.$$eval(`${ch} .ch-results [role="status"] a[href$="/people/${ida}"]`, (els) => els.length)) === 1, stayLine);
await page.locator(`${ch} .ch-results [role="status"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${SHOTS}/12-put-back-stays-1440.png` });
await page.setViewportSize({ width: 390, height: 844 });
await sleep(400);
await page.locator(`${ch} .ch-results [role="status"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${SHOTS}/12-put-back-stays-390.png` });
m = await measure(page, ch);
check('…at 390 wide: no sideways scroll', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await page.setViewportSize({ width: 1440, height: 900 });
await api('/actions/person.update', { id: ida, tags: [] });
for (let i = 0; i < 30 && fake.dnc.some((d) => d.phone_number === '+16045550131'); i += 1) await sleep(500);

// ── Do-not-call numbers CallHub won't take, and ones it won't let go: said, with whose they are ──
fake.rejectDnc('all');
const quiet = [];
for (let i = 0; i < 8; i += 1) quiet.push((await api('/actions/person.create', { name: `Quiet${i} Example`, city: 'Surrey', phone: `604-555-014${i}`, tags: ['do-not-call'] })).json.person.id);
for (let i = 0; i < 60 && ((await api(`/callhub/pushes?list=${listId}`)).json.not_taken?.n || 0) < 8; i += 1) await sleep(500);
const nottaken = `${ch} .ch-nottaken:not(.ch-held)`;
for (const [p, n] of [[page, '1440'], [phone, '390']]) {
  await p.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(nottaken, { timeout: 15000 }).catch(() => {});
  await p.locator(nottaken).evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await p.screenshot({ path: `${SHOTS}/13-not-taken-${n}.png` });
}
const fewNames = await text(page, nottaken);
check('eight do-not-call numbers CallHub won’t take: its words, five names “and 3 more”, and “Show all 8” to tap',
  /^CallHub wouldn’t take 8 do-not-call numbers: “phone_number: Enter a valid phone number\.” — Quiet0 Example, Quiet1 Example, Quiet2 Example, Quiet3 Example, Quiet4 Example and 3 more Show all 8$/.test(fewNames), fewNames);
await phone.tap(`${nottaken} .ch-all`);
await phone.waitForFunction((sel) => /Quiet7 Example/.test(document.querySelector(sel)?.innerText || ''), nottaken, { timeout: 10000 }).catch(() => {});
const allNames = await text(phone, nottaken);
check('“Show all 8”, on a phone: all eight by name, each a way to the person', /Quiet5 Example, Quiet6 Example, Quiet7 Example Show fewer$/.test(allNames)
  && (await phone.$$eval(`${nottaken} a[href*="/people/"]`, (els) => els.length)) === 8, allNames);
await phone.locator(nottaken).evaluate((el) => el.scrollIntoView({ block: 'center' }));
await phone.screenshot({ path: `${SHOTS}/13-not-taken-all-390.png` });
m = await measure(phone, ch);
check('…at 390: no sideways scroll, “Show fewer” ≥ 48px like every button', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
// CallHub takes them after all (the tags are touched: the job asks again once it does).
fake.rejectDnc(false);
await api('/actions/callhub.push', { list_id: laterList });
await sentOf(`list=${laterList}`);
for (let i = 0; i < 40 && fake.dnc.filter((d) => /^\+1604555014/.test(d.phone_number)).length < 8; i += 1) await sleep(500);
check('once CallHub takes them (the next push asks again) the line is gone', fake.dnc.filter((d) => /^\+1604555014/.test(d.phone_number)).length === 8 && (await api(`/callhub/pushes?list=${listId}`)).json.not_taken === null, String(fake.dnc.length));
// Two of them may be called again — and CallHub won't let their numbers go.
fake.keepDnc(true);
await api('/actions/person.update', { id: quiet[0], tags: [] });
await api('/actions/person.update', { id: quiet[1], tags: [] });
for (let i = 0; i < 40 && ((await api(`/callhub/pushes?list=${listId}`)).json.held?.n || 0) < 2; i += 1) await sleep(500);
const heldLine = `${ch} .ch-held`;
for (const [p, n] of [[page, '1440'], [phone, '390']]) {
  await p.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(heldLine, { timeout: 15000 }).catch(() => {});
  await p.locator(heldLine).evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await p.screenshot({ path: `${SHOTS}/14-held-${n}.png` });
}
check('numbers CallHub still holds that nobody here blocks: how many, what to do, and whose they are',
  (await text(page, heldLine)) === 'CallHub’s do-not-call list still has 2 numbers nobody here blocks now. Take them off in CallHub — Quiet0 Example, Quiet1 Example', await text(page, heldLine));
await page.goto(`${ADMIN}/settings/services`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(row, { timeout: 10000 });
await page.click(`${row} .sv2-check`);
await page.locator(`${row} .sv2-row__main > .sv2-said`).filter({ hasText: 'nobody here blocks' }).waitFor({ timeout: 10000 }).catch(() => {});
const checkSaid = await text(page, `${row} .sv2-row__main > .sv2-said`);
check('Check says the same, naming them: “… take them off in CallHub: Quiet0 Example, Quiet1 Example”',
  / · CallHub’s do-not-call list still has 2 numbers nobody here blocks now — take them off in CallHub: Quiet0 Example, Quiet1 Example$/.test(checkSaid), checkSaid);
await page.locator(row).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/14-held-check-1440.png` });
fake.keepDnc(false);

// ── Off: no button at all ──
const off = await dctx.newPage();
await off.route('**/api/integrations', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ callhub: false }) }));
await off.goto(`${ADMIN}/lists/${listId}`, { waitUntil: 'domcontentloaded' });
await off.waitForSelector('.ops-head h1', { timeout: 10000 });
await sleep(800);
check('with CallHub off, a list’s page has no CallHub block', !(await off.$(ch)) && !/CallHub/.test(await text(off)), '');
await off.close();
// A volunteer is told nothing about it.
check('staff may send; the server keeps the Services row to managers', (await sctx.request.get(`${BASE}/api/integrations`)).status() === 200 && (await sctx.request.get(`${BASE}/api/connections`)).status() === 403);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await fake.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
