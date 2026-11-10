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
// answers someone picks. A phone bank is sent the same way; a number CallHub
// calls is crossed off there. A refusal stops the push with CallHub's words
// and Carry on finishes it. With CallHub off there is no button at all.
// Measured at 1440 and 390.
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
check('Connect: “CallHub now sends each call’s result here”', (await text(page, `${row} .svc-connect .sv2-said`)) === '✓ CallHub now sends each call’s result here', await text(page, `${row} .svc-connect .sv2-said`));
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
check('it asks first: “9 numbers to send · 3 left out”, and what goes', /^9 numbers to send · 3 left out Only names, numbers and cities go\./.test(ask), ask);
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
  /^Sent · 9 numbers · \d{1,2}:\d{2}/.test(done) && /Phonebook in CallHub: “Undecided in Newton — [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [ap]m” · 3 left out · sent by Marco Manager/.test(done)
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
await page.waitForFunction((s) => /2 results already in moved too/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-results [role="status"]`, { timeout: 10000 }).catch(() => {});
const ana = (await api(`/persons/${P.ana}`)).json;
check('“Yes, definitely” mapped to the scale’s first step: Ana and Alex are rated; “Not sure yet”, unmapped, rates nobody',
  ana.person.rating === '1' && (await api(`/persons/${P.alex}`)).json.person.rating === '1' && (await api(`/persons/${P.ben}`)).json.person.rating === null, ana.person.rating);
await page.screenshot({ path: `${SHOTS}/07-list-rating-1440.png`, fullPage: true });
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
check('a refusal: “Stopped: CallHub said “Invalid token.”” and Carry on',
  (await text(page, `${ch} .ch-status`)) === 'Stopped: CallHub said “Invalid token.”' && (await text(page, `${ch} .ch-push > .btn`)) === 'Carry on', await text(page, `${ch} .ch-push`));
await page.locator(ch).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/09-bank-stopped-1440.png` });
await phone.goto(`${ADMIN}/banks/${bankId}`, { waitUntil: 'domcontentloaded' });
await phone.waitForFunction((s) => /^Stopped/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 10000 }).catch(() => {});
await phone.locator(ch).scrollIntoViewIfNeeded();
await phone.screenshot({ path: `${SHOTS}/09-bank-stopped-390.png` });
m = await measure(phone, ch);
check('the bank’s page at 390: no sideways scroll, Carry on ≥ 48px', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
fake.refuse(false);
await phone.tap(`${ch} .ch-push > .btn`);
await phone.waitForFunction((s) => /^Sent/.test(document.querySelector(s)?.innerText || ''), `${ch} .ch-status`, { timeout: 30000 }).catch(() => {});
check('Carry on, from the phone: “Sent · 1 number”', /^Sent · 1 number ·/.test(await text(phone, `${ch} .ch-status`)), await text(phone, `${ch} .ch-status`));

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
