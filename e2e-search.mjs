// Person search E2E (PS, stage 2a) — one fresh in-memory campaign with about
// 1,000 made-up people: 40 "Sample"s (one Zoë), three Kevin Smiths on three
// streets and a Kevin Smith Jr, an Aaron Smith, two Josés, and filler. A
// manager at a desk (1440) opens a profile's Knows → "+ Someone they know":
// "sample" says "40 people", shows 25 in A–Z order and loads the rest by
// itself as the list scrolls; "smith kevin" gives four rows with four
// streets, the one already linked says "Already linked" and can't be
// picked; another is picked and linked as a Friend. "zoe" finds Zoë; "zzq"
// says no one and what to try. Arrow keys, Enter and Esc. No stale pick:
// Enter while "smith k" is still on its way waits for it. Fast typing sends
// one ask; a slow answer cancelled by new typing never draws. Someone added
// in a second tab is found the next time. No signal says so. People: A–Z by
// last name with the surname in bold, "Name (A–Z by last name)", "smith
// kevin" in its box, "Show more" past row 300 from the server, and "Showing
// more needs signal" with none. The command bar: "sample" → six people and
// "See all people matching “sample”" → People with "sample" in its box. A
// kept call list asks with today's parameters and opens again with no
// signal. Each screen at 1440×900 and 390×844: one yellow button at most,
// no sideways scroll, 48 px targets on a phone.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5440 node server/index.js &
//   BASE=http://127.0.0.1:5440 SHOTS=/tmp/search node e2e-search.mjs
// Under a client's path (BASE_PATH=/imaginesurrey on the server):
//   BASE=http://127.0.0.1:5441 BASE_PATH=/imaginesurrey SHOTS=/tmp/search-bp node e2e-search.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const ORIGIN = process.env.BASE || 'http://localhost:3200';
const P = process.env.BASE_PATH || '';
const FIELD = P ? `${ORIGIN}${P}/field` : ORIGIN;
const DESK = P ? `${ORIGIN}${P}/desk` : `${ORIGIN}/admin`;
const API = `${P}/api`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-search';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(m.text()); });
const api = (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [`${API}${path}`, body]);
const go = async (path) => { await page.goto(`${DESK}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(700); };
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const tc = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
// Every ask the page makes to the person search, with when it was answered.
const asks = [];
page.on('request', (r) => { if (r.url().includes('/api/search/people')) asks.push({ url: new URL(r.url()), at: Date.now(), done: null, failed: false }); });
page.on('requestfinished', (r) => { const a = asks.find((x) => x.url.href === r.url() && x.done == null); if (a) a.done = Date.now(); });
page.on('requestfailed', (r) => { const a = asks.find((x) => x.url.href === r.url() && x.done == null && !x.failed); if (a) a.failed = true; });

const measure = () => page.evaluate(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null; let who = '';
  for (const el of document.querySelectorAll('main.page input:not([type=checkbox]), main.page button, main.page a.btn, .ps-row, .cmd-opt')) {
    if (!visible(el)) continue;
    const h = el.getBoundingClientRect().height;
    if (minTap == null || h < minTap) { minTap = h; who = el.outerHTML.slice(0, 90); }
  }
  return { yellow, overflow, minTap, who, phone: innerWidth < 600 };
});
const simple = async (name) => {
  const m = await measure();
  const floor = m.phone ? 48 : 40;
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥${floor}px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= floor - 0.5),
    `yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap} ${m.minTap < floor - 0.5 ? m.who : ''}`);
};

// ── 1. A manager, and the people ──
await page.goto(`${FIELD}/signup`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#su-name', { timeout: 15000 });
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Search Example');
await page.fill('#su-email', `riley+${tag}@search.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/(admin|desk)\/?$/, { timeout: 15000 });

const FIRSTS = ['Aisha', 'Ben', 'Carmen', 'Dev', 'Elena', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jon', 'Kiran', 'Lena', 'Mei', 'Nico', 'Omar', 'Pita', 'Quinn', 'Rosa', 'Sven', 'Tara',
  'Uma', 'Vik', 'Wen', 'Xena', 'Yusuf', 'Zara', 'Amir', 'Bea', 'Cole', 'Dana', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lior', 'Max'];
const rows = [];
FIRSTS.forEach((f) => rows.push({ name: `${f} Sample`, address: `${100 + rows.length} Example Street`, city: 'Surrey' }));
rows.push({ name: 'Zoë Sample', address: '199 Example Street', city: 'Surrey' });
['14520 72 Ave', '8810 King George Blvd', '6650 128 St'].forEach((a, i) => rows.push({ name: 'Kevin Smith', address: a, city: 'Surrey', phone: `604-555-015${i + 1}` }));
rows.push({ name: 'Kevin Smith Jr', address: '9 Example Lane', city: 'Surrey', phone: '604-555-0154' });
rows.push({ name: 'Aaron Smith', address: '10 Example Lane', city: 'Surrey' });
rows.push({ name: 'José Example', address: '11 Example Lane', city: 'Surrey' }, { name: 'Jose Example', address: '12 Example Lane', city: 'Surrey' });
rows.push({ name: 'Host Example', address: '1 Host Road', city: 'Surrey' });
const SURNAMES = 'Aexample Bexample Cexample Dexample Fexample Gexample Hexample Lexample Mexample Pexample Rexample Texample Wexample'.split(' ');
for (let i = 0; rows.length < 1000; i++) {
  rows.push({ name: `${FIRSTS[i % FIRSTS.length]} ${SURNAMES[i % SURNAMES.length]}`, address: `${1000 + i} Filler Road`, city: 'Surrey', tags: 'filler',
    ...(i < 40 ? { phone: `604-555-01${String(i).padStart(2, '0')}` } : {}) });
}
let made = 0;
for (let i = 0; i < rows.length; i += 500) made += (await api('/data/import', { rows: rows.slice(i, i + 500) })).json?.created || 0;
check('1,000 made-up people come in', made === 1000, made);
const find = async (q, extra = '') => (await api(`/search/people?q=${encodeURIComponent(q)}&limit=50${extra}`)).json;
const host = (await find('host example')).persons[0];
const kevins = (await find('kevin smith')).persons;
check('the server finds the four Kevin Smiths', kevins.length === 4, kevins.map((p) => p.name).join(', '));
const linked = kevins.find((p) => p.address === '8810 King George Blvd');
check('one Kevin Smith is already linked to Host', (await api('/actions/relationship.add', { from_id: host.id, person_id: linked.id, kind: 'work' })).status === 200);

// ── 2. The profile → "+ Someone they know" ──
const openAdd = async () => {
  await go(`/people/${host.id}`);
  await page.click('.pf-sec__btn:has-text("Knows")');
  await page.click('button:has-text("+ Someone they know")');
  await page.waitForSelector('.rel-add input[type="search"]');
};
const box = '.rel-add input[type="search"]';
const typeIn = async (q) => { await page.fill(box, ''); await page.fill(box, q); };
const freshRows = () => page.$$eval('.ps-list:not(.is-stale) .rel-pick', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
await openAdd();
check('the box: "Who do they know?", "Name, phone or email"', (await tc('.rel-add__q')) === 'Who do they know?' && (await page.getAttribute(box, 'placeholder')) === 'Name, phone or email');
await shot('01-add-empty-desk');
await simple('relationship editor, empty (desk)');
await typeIn('sample');
await until(async () => (await tc('.ps-count')) === '40 people' && (await freshRows()).length === 25);
check('"sample": "40 people", 25 rows', (await tc('.ps-count')) === '40 people' && (await freshRows()).length === 25, `${await tc('.ps-count')} · ${(await freshRows()).length}`);
const want = (await find('sample')).persons.map((p) => p.name);
const names = await page.$$eval('.ps-list .ps-row__name', (els) => els.map((e) => e.textContent));
check('…in A–Z order (as the server pages it)', JSON.stringify(names) === JSON.stringify(want.slice(0, 25)), names.slice(0, 4).join(', '));
check('…the surname in bold', (await page.$$eval('.ps-list .ps-row__name b', (els) => els.map((e) => e.textContent))).every((t) => t === 'Sample'));
check('…each row has a second line (street, city, phone)', (await page.$$eval('.ps-row__where', (els) => els.every((e) => /Example Street, Surrey/.test(e.textContent)))));
await shot('02-add-typing-desk');
await page.$eval('.ps-list', (el) => { el.scrollTop = el.scrollHeight; });
await until(async () => (await freshRows()).length === 40);
await page.$eval('.ps-list', (el) => { el.scrollTop = el.scrollHeight; });
const all40 = await page.$$eval('.ps-list .ps-row__name', (els) => els.map((e) => e.textContent));
check('scrolled to the end: the rest load by themselves, 40 rows, no "Show more"', all40.length === 40 && new Set(all40).size === 40 && (await page.locator('.ps-more').count()) === 0
  && JSON.stringify(all40) === JSON.stringify(want), `${all40.length}`);
await shot('03-add-scrolled-desk');
await simple('relationship editor, a long list (desk)');

await typeIn('smith kevin');
await until(async () => (await freshRows()).length === 4);
const kRows = await page.$$eval('.ps-list .ps-row', (els) => els.map((e) => ({ t: e.textContent, where: e.querySelector('.ps-row__where')?.textContent, off: e.disabled })));
check('"smith kevin": four rows, each its own street', kRows.length === 4 && new Set(kRows.map((r) => r.where)).size === 4, kRows.map((r) => r.where).join(' | '));
const linkedRow = kRows.find((r) => /8810 King George/.test(r.where));
check('…the one already linked says "Already linked" and can\'t be picked', linkedRow?.off === true && /Already linked/.test(linkedRow.t));
await shot('04-add-already-linked-desk');
await page.click('.ps-row:has-text("14520 72 Ave")');
check('picked: "Kevin Smith — how do they know each other?"', (await tc('.rel-add__q')) === 'Kevin Smith — how do they know each other?');
await page.click('.rel-kind:has-text("Friend")');
await until(async () => (await page.$$eval('.rel-knows li', (els) => els.length)) === 2);
check('Knows shows the new tie (Friend)', /Kevin Smith\s*Friend/.test((await page.$$eval('.rel-knows li', (els) => els.map((e) => e.innerText).join(' | ')))));

await page.click('button:has-text("+ Someone they know")');
await typeIn('zoe');
await until(async () => (await freshRows()).length === 1);
check('"zoe" finds Zoë Sample', (await freshRows())[0]?.startsWith('Zoë Sample'), (await freshRows()).join());
await typeIn('zzq');
await until(async () => /No one matches/.test(await tc('.ps-state')));
check('"zzq": "No one matches “zzq”." and what to try', (await tc('.ps-none')) === 'No one matches “zzq”.' && (await tc('.ps-help')) === 'Try a last name, a phone number or an email.');
await shot('05-add-no-match-desk');

// Keys: ↓ to the first row, ↓ again, Enter picks; Esc back to the box.
await typeIn('sample');
await until(async () => (await freshRows()).length === 25);
await page.focus(box);
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Escape');
check('Esc from a row goes back to the box', await page.evaluate((s) => document.activeElement === document.querySelector(s), box));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
check('↓ ↓ Enter picks the second row', (await tc('.rel-add__q')) === `${want[1]} — how do they know each other?`, await tc('.rel-add__q'));
await page.click('.rel-add button:has-text("Back")');

// No stale pick: "smith" on screen (Kevin Smith Jr first: the names
// trigger gives him the last name "Jr", a known follow-up); " a" typed and
// Enter at once must pick Aaron Smith, never the stale first row.
await typeIn('smith');
await until(async () => (await freshRows()).length === 5);
check('"smith": Kevin Smith Jr first, then Aaron Smith', /^Kevin Smith Jr/.test((await freshRows())[0] || '') && /^Aaron Smith/.test((await freshRows())[1] || ''), (await freshRows()).slice(0, 2).join(' | '));
await page.route(/search\/people\?q=smith(\+|%20)a/, async (route) => { await sleep(900); await route.continue(); });
await page.focus(box);
await page.keyboard.type(' a');
await page.keyboard.press('Enter');
const pressed = Date.now();
await sleep(400);
check('Enter before the "smith a" answer picks no one yet', (await page.locator(box).count()) === 1 && !/how do they know/.test(await tc('.rel-add__q')));
await until(async () => /how do they know/.test(await tc('.rel-add__q')), 6000);
const pickedQ = await tc('.rel-add__q');
const skAsk = asks.find((a) => a.url.searchParams.get('q') === 'smith a');
check('…then Aaron Smith is picked, after the "smith a" answer', /^Aaron Smith — /.test(pickedQ) && skAsk?.done && skAsk.done >= pressed, `${pickedQ} · answered ${skAsk?.done ? skAsk.done - pressed : '?'} ms after Enter`);
await page.unroute(/search\/people\?q=smith(\+|%20)a/);
await page.click('.rel-add button:has-text("Back")');

// Fast typing: one ask.
await page.fill(box, '');
await sleep(400);
const before = asks.length;
await page.focus(box);
await page.keyboard.type('sample', { delay: 30 });
await until(async () => (await freshRows()).length === 25);
const sent = asks.slice(before).map((a) => a.url.searchParams.get('q'));
check('typing "sample" 30 ms a key sends one ask', sent.length === 1 && sent[0] === 'sample', sent.join(','));
// A slow answer cancelled by new typing never draws.
await page.route(/search\/people\?q=zo&/, async (route) => { await sleep(1500); await route.continue().catch(() => {}); });
await typeIn('zo');
await sleep(450);
await typeIn('zzq');
await sleep(2200);
const zoAsk = asks.find((a) => a.url.searchParams.get('q') === 'zo');
check('the slow "zo" ask is cancelled and never draws', zoAsk?.failed === true && (await tc('.ps-none')) === 'No one matches “zzq”.' && (await freshRows()).length === 0, `failed=${zoAsk?.failed}`);
await page.unroute(/search\/people\?q=zo&/);

// Right away: added in a second tab, found the next time.
await typeIn('zz example');
await until(async () => /No one matches/.test(await tc('.ps-none')));
const tab2 = await ctx.newPage();
await tab2.goto(`${DESK}/people`, { waitUntil: 'domcontentloaded' });
const added = await tab2.evaluate(async (u) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Zz Example' }) })).status, `${API}/actions/person.create`);
await tab2.close();
await page.fill(box, '');
await sleep(300);
await page.fill(box, 'zz example');
await until(async () => (await freshRows()).length === 1);
check('someone added in another tab is found the next time', added === 200 && /^Zz Example/.test((await freshRows())[0] || ''), (await freshRows()).join());

// "More than 5,000" (the answer is made up here: the file has 1,000).
await page.route(/search\/people\?q=lots/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ persons: rows.slice(0, 25).map((r, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'person', name: r.name, last_name: r.name.split(' ').at(-1), address: r.address, city: 'Surrey' })), more: true, total: null, many: true, cap: 5000 }) }));
await typeIn('lots');
await until(async () => /More than/.test(await tc('.ps-count')));
check('past the cap: "More than 5,000 — type more of the name"', (await tc('.ps-count')) === 'More than 5,000 — type more of the name');
await shot('06-add-many-desk');
await page.unroute(/search\/people\?q=lots/);

// No signal.
await typeIn('sample');
await ctx.setOffline(true);
await until(async () => /needs signal/.test(await tc('.rel-add')));
check('no signal: "Adding someone they know needs signal"', /Adding someone they know needs signal/.test(await tc('.rel-add')), await tc('.rel-add'));
await shot('07-add-offline-desk');
await ctx.setOffline(false);
await page.click('.rel-add button:has-text("Cancel")');

// ── 3. People ──
await go('/people');
await page.waitForSelector('.pp-table__name a');
const head = await tc('.pp-table thead th');
check('People\'s header: "Name (A–Z by last name)"', head === 'Name (A–Z by last name)', head);
const top = await page.$$eval('.pp-table__name a', (els) => els.slice(0, 25).map((e) => e.textContent));
const apiTop = (await api('/persons?q=&limit=25')).json.persons.map((p) => p.name);
check('People: the first rows are the server\'s A–Z by last name', JSON.stringify(top) === JSON.stringify(apiTop) && /Aexample$/.test(top[0]), top.slice(0, 3).join(', '));
check('…with the surname in bold', (await page.$$eval('.pp-table__name a b', (els) => els.length)) >= 20);
await shot('08-people-top-desk');
await simple('People (desk)');
const peopleAsks = [];
const onReq = (r) => { if (/\/api\/persons\?/.test(r.url())) peopleAsks.push(new URL(r.url())); };
page.on('request', onReq);
for (let i = 0; i < 12; i++) { await page.click('.pp-more button'); await sleep(60); }
await until(async () => (await page.$$eval('.pp-table__name a', (els) => els.length)) >= 325);
const nRows = await page.$$eval('.pp-table__name a', (els) => els.length);
const after = peopleAsks.find((u) => u.searchParams.get('after'));
check('"Show more" reaches row 301 and beyond, from the server (?after=)', nRows >= 325 && after && after.searchParams.get('limit') === '300', `${nRows} rows · ${after?.search}`);
await page.$eval('.pp-table tbody tr:nth-child(301)', (e) => e.scrollIntoView({ block: 'center' }));
await shot('09-people-past-300-desk');
page.off('request', onReq);
await page.fill('.pp-search input', 'smith kevin');
await until(async () => (await page.$$eval('.pp-table__name a', (els) => els.filter((e) => /Kevin Smith/.test(e.textContent)).length)) === 4);
check('People\'s box: "smith kevin" finds the Kevin Smiths', (await page.$$eval('.pp-table__name a', (els) => els.filter((e) => /Kevin Smith/.test(e.textContent)).length)) === 4);
// No signal: the kept 300 answer; more needs signal.
await go('/people');
await page.waitForSelector('.pp-table__name a');
await ctx.setOffline(true);
for (let i = 0; i < 11; i++) { await page.click('.pp-more button'); await sleep(40); }
await until(async () => /needs signal/.test(await tc('.pp-more')));
check('no signal: "Showing more needs signal", off', (await tc('.pp-more button')) === 'Showing more needs signal' && await page.isDisabled('.pp-more button'), await tc('.pp-more'));
await ctx.setOffline(false);

// ── 4. The command bar ──
await go('/');
await page.keyboard.press('Control+k');
await page.waitForSelector('.cmd-input');
await page.fill('.cmd-input', 'sample');
await until(async () => (await page.locator('.cmd-opt--all').count()) === 1);
const nPeople = await page.locator('.cmd-opt--person').count();
const all = await tc('.cmd-opt--all .cmd-opt__label');
check('command bar: six people and "See all people matching “sample”"', nPeople === 6 && all === 'See all people matching “sample”', `${nPeople} · ${all}`);
await shot('10-command-bar-desk');
await page.click('.cmd-opt--all');
await page.waitForURL(/\/people\?q=sample/);
await page.waitForSelector('.pp-table__name a');
check('…which opens People with "sample" in its box', (await page.inputValue('.pp-search input')) === 'sample');

// ── 5. A kept call list asks as it always did, and opens with no signal ──
const callAsks = [];
const onCall = (r) => { if (/\/api\/persons\?/.test(r.url())) callAsks.push(new URL(r.url()).search); };
page.on('request', onCall);
await page.goto(`${DESK}/calls?tag=filler`, { waitUntil: 'domcontentloaded' });
await sleep(2500);
page.off('request', onCall);
check('Calls asks with today\'s parameters', callAsks[0] === '?q=&limit=300&has=phone&reach=call&tag=filler', callAsks.join(' '));
const cardBefore = await tc('main.page');
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(2500);
const cardAfter = await tc('main.page');
const firstUp = (cardBefore.match(/to call\s*(\S+ \S+?example)/i) || [])[1];
check('…and opens again with no signal', firstUp && cardAfter.includes(firstUp) && /40 to call/.test(cardAfter), `${firstUp} · `+`${cardBefore.slice(0, 80)} || ${cardAfter.slice(0, 120)}`);
await ctx.setOffline(false);

// ── 6. A phone (390×844) ──
await page.setViewportSize({ width: 390, height: 844 });
await openAdd();
await shot('11-add-empty-phone');
await typeIn('sample');
await until(async () => (await freshRows()).length === 25);
await shot('12-add-typing-phone');
await simple('relationship editor (phone)');
await typeIn('smith kevin');
await until(async () => (await freshRows()).length === 4);
await shot('13-add-already-linked-phone');
await simple('relationship editor, already linked (phone)');
await typeIn('zzq');
await until(async () => /No one matches/.test(await tc('.ps-none')));
await shot('14-add-no-match-phone');
await page.route(/search\/people\?q=lots/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ persons: rows.slice(0, 25).map((r, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'person', name: r.name, last_name: r.name.split(' ').at(-1), address: r.address, city: 'Surrey' })), more: true, total: null, many: true, cap: 5000 }) }));
await typeIn('lots');
await until(async () => /More than/.test(await tc('.ps-count')));
await page.$eval('.ps-list', (el) => { el.scrollTop = 600; });
await shot('15-add-many-phone');
await page.unroute(/search\/people\?q=lots/);
await ctx.setOffline(true);
await until(async () => /needs signal/.test(await tc('.rel-add')));
await shot('16-add-offline-phone');
await ctx.setOffline(false);
await go('/people');
await page.waitForSelector('.pp-row__name');
check('People on a phone: the surname in bold, no header', (await page.$$eval('.pp-row__name b', (els) => els.length)) >= 20 && (await page.locator('th:has-text("A–Z")').count()) === 0);
await shot('17-people-top-phone');
await simple('People (phone)');
for (let i = 0; i < 12; i++) { await page.click('.pp-more button'); await sleep(60); }
await until(async () => (await page.$$eval('.pp-row__name', (els) => els.length)) >= 325);
await page.$eval('.pp-list li:nth-child(301)', (e) => e.scrollIntoView({ block: 'center' }));
check('People on a phone goes past row 300', (await page.$$eval('.pp-row__name', (els) => els.length)) >= 325);
await shot('18-people-past-300-phone');
await go('/');
await page.evaluate(() => document.querySelector('.cmd-btn')?.click());
await page.waitForSelector('.cmd-input');
await page.fill('.cmd-input', 'sample');
await until(async () => (await page.locator('.cmd-opt--all').count()) === 1);
await shot('19-command-bar-phone');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
