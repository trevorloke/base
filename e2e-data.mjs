// Import & export — a fresh in-memory campaign. The desk opens Import &
// export (People → More), imports people from an Excel workbook (.xlsx —
// deflated, shared strings, a date-formatted Voted column, the way Excel
// saves one): the columns match themselves, the check says who's new, the
// import lands them on file and marks the voter. Then each export is a
// spreadsheet, and the People one carries what came in.
//
// A list with a Voter ID column fills each person's voter number, and the
// same number under another spelling is the same person (no second record);
// the profile shows it under More details.
//
// Gifts made in another tool come in from its file (Import & export →
// Import gifts, or Donations → More → Import a file): the columns of a file
// base.win has never seen match themselves; the check saves nothing and
// says the gifts, the donors found, the gifts to settle, what can't come in
// and who the file takes over the year's limit; the import puts them on the
// books without using a receipt number; Donations marks them Imported and
// lists "2 imported gifts need a donor" under Needs you; the pile settles
// one on a record it could be and one on a new person; the same file again
// adds nothing; the import is taken back whole. A file with no gift numbers
// and a way of paying base.win doesn't know ("Wire") adds nothing the second
// time either, whatever the word is said to mean. The financial agent's
// filing date is typed in and counted down on Donations and on Today.
// Donations says how it stands: Loading… while its reads are out,
// Unavailable — Try again when they failed.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4135 node server/index.js &
//   BASE=http://127.0.0.1:4135 SHOTS=/tmp/data node e2e-data.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-data';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);

// ── A small .xlsx, written the way Excel writes one (deflated parts) ──
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const zip = (files) => {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text, 'utf8'); const data = deflateRawSync(raw); const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm); offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};
const strings = ['First Name', 'Last Name', 'Email Address', 'Phone Number', 'Address', 'City', 'Voted', 'Tags', 'Priya', 'Example', `priya.${tag}@example.org`, '13450 104 Ave', 'Surrey', 'xlsx-import', 'Omar', 'Sample', 'Whalley'];
const S = (s) => strings.indexOf(s);
const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
const c = (ref, v, t) => (t === 's' ? `<c r="${ref}" t="s"><v>${S(v)}</v></c>` : t === 'd' ? `<c r="${ref}" s="1"><v>${v}</v></c>` : `<c r="${ref}"><v>${v}</v></c>`);
const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${['First Name', 'Last Name', 'Email Address', 'Phone Number', 'Address', 'City', 'Voted', 'Tags'].map((h, i) => c(`${'ABCDEFGH'[i]}1`, h, 's')).join('')}</row>
<row r="2">${c('A2', 'Priya', 's')}${c('B2', 'Example', 's')}${c('C2', `priya.${tag}@example.org`, 's')}${c('D2', '6045550161')}${c('E2', '13450 104 Ave', 's')}${c('F2', 'Surrey', 's')}${c('G2', '46325', 'd')}${c('H2', 'xlsx-import', 's')}</row>
<row r="3">${c('A3', 'Omar', 's')}${c('B3', 'Sample', 's')}${c('D3', '6045550162')}${c('F3', 'Whalley', 's')}${c('H3', 'xlsx-import', 's')}</row>
</sheetData></worksheet>`;
const xlsx = zip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Supporters" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/worksheets/sheet1.xml', sheet],
  ['xl/sharedStrings.xml', sst],
  ['xl/styles.xml', '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'],
]);
const xlsxPath = join(tmpdir(), `supporters-${tag}.xlsx`);
writeFileSync(xlsxPath, xlsx);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver', acceptDownloads: true });
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const api = async (path) => { const r = await dctx.request.get(`${BASE}/api${path}`); return { status: r.status(), json: await r.json().catch(() => null), text: await r.text().catch(() => '') }; };
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@data.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

// ── People → More → Import & export ──
await page.goto(`${ADMIN}/people`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pp-head', { timeout: 10000 });
await page.click('.pp-head .head-actions button[aria-haspopup], .pp-head .head-actions button:has-text("More")').catch(() => {});
await page.click('a:has-text("Import & export")', { timeout: 4000 }).catch(() => page.goto(`${ADMIN}/data`));
await page.waitForSelector('.dt-page h1', { timeout: 8000 });
const t = (await page.innerText('.dt-page')).replace(/\s+/g, ' ');
check('Import & export: Import people (CSV or Excel), a voted file, the website; every export; everything in one file',
  /Excel workbook \(\.xlsx\)/.test(t) && /A voted file/.test(t) && /From the website/.test(t) && /Volunteers and their roles/.test(t) && /Download everything/.test(t), t.slice(0, 200));
await page.screenshot({ path: `${SHOTS}/01-import-export.png`, fullPage: true });

// ── An Excel workbook in ──
await page.click('a:has-text("Import people")');
await page.waitForSelector('#imp-file', { state: 'attached', timeout: 8000 });
await page.setInputFiles('#imp-file', xlsxPath);
await page.waitForSelector('.imp-source', { timeout: 10000 }).catch(() => {});
const src = (await page.innerText('.imp-source').catch(() => '')).replace(/\s+/g, ' ');
check('the workbook opens: its name, the sheet, 2 rows', /supporters-.*\.xlsx · Supporters/.test(src) && /2 rows/.test(src), src);
const sel = await page.$$eval('.imp-map__select', (els) => els.map((e) => e.options[e.selectedIndex].text));
check('its columns match themselves: first, last, email, phone, address, city, voted, tags',
  sel.join('|') === 'First name|Last name|Email|Phone|Street address|City|Voted (1/0 or a date)|Tags', sel.join('|'));
await page.screenshot({ path: `${SHOTS}/02-xlsx-matched.png`, fullPage: true });
await page.click('button:has-text("Check 2 rows")');
await sleep(1500);
await page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click();
await sleep(2000);
const priya = (await api(`/persons?q=Priya%20Example`)).json.persons[0];
const omar = (await api(`/persons?q=Omar%20Sample`)).json.persons[0];
check('Priya is on file: email, phone, address, the tag, voted (the date cell)', priya && priya.email === `priya.${tag}@example.org` && /604.?555.?0161/.test(priya.phone || '')
  && priya.address === '13450 104 Ave' && priya.tags.includes('xlsx-import') && !!priya.voted_at, JSON.stringify(priya));
check('Omar too, not voted', omar && omar.city === 'Whalley' && !omar.voted_at, JSON.stringify(omar));

// ── The campaign's own list layout (made-up people): every column lands ──
const LHEAD = ['First Name', 'Surname', 'Home Phone', 'Mobile Phone', 'Email Address', 'Volunteer', 'Lists', 'Donor', 'House Unit', 'House Number', 'Street Name', 'City', 'Province', 'Postal', 'Latitude', 'Longitude', 'House Notes', 'Building Notes', 'Access Type', 'Dwelling Type', 'Interaction Status', 'Interaction Date', 'Organizer', 'Email Opt-In', 'SMS Opt-In', 'Tags', 'Sign', 'Support', 'Voted'];
const L1 = ['Riya', 'Sample', '', '16045550188', `riya.${tag}@example.org`, '1', '', '1', '204', '16068', '83 Ave', 'Surrey', 'BC', 'V4N 0N2', '49.1535325', '-122.7767407', 'On the old supporter list; volunteer status unconfirmed', '', '', '', '', '', '', 't', 'f', 'Team: North; Vol: Door Knocker; Vol: GOTV; Zone 1', '', '5', 'FALSE'];
L1[20] = 'Not Home'; L1[21] = '10/04/2026'; L1[26] = 'Yes';
const L2 = [...L1]; L2[0] = 'Omar'; L2[1] = 'Listed'; L2[2] = '604-555-0177'; L2[3] = ''; L2[4] = ''; L2[8] = ''; L2[9] = '9001'; L2[16] = ''; L2[25] = '';
L2[20] = 'Spoke - supporter';
const L3 = [...L1]; L3[0] = 'Lee Ann'; L3[1] = 'Listed'; L3[3] = '1.6045E+10'; L3[4] = `lee.${tag}@example.org`; L3[9] = '9002'; L3[25] = ''; L3[20] = ''; L3[21] = ''; L3[26] = '';
await page.goto(`${ADMIN}/people/import`, { waitUntil: 'domcontentloaded' });
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', [LHEAD, L1, L2, L3].map((r) => r.join('\t')).join('\n'));
await page.click('button:has-text("Use this text")');
await page.waitForSelector('.imp-map__row', { timeout: 8000 });
const lmap = Object.fromEntries(await page.$$eval('.imp-map__row', (rows) => rows.map((r) => [r.querySelector('.imp-map__head').innerText.trim(), (() => { const x = r.querySelector('select'); return x ? x.options[x.selectedIndex].text : ''; })()])));
const want = { 'First Name': 'First name', Surname: 'Last name', 'Home Phone': 'Home phone', 'Mobile Phone': 'Phone', 'Email Address': 'Email', 'House Unit': 'Unit / apt', 'House Number': 'House number', 'Street Name': 'Street address', Postal: 'Postal code', 'House Notes': 'House notes', Tags: 'Tags', Support: 'Support', Voted: 'Voted (1/0 or a date)' };
const wrong = Object.entries(want).filter(([h, f]) => lmap[h] !== f);
check('the list’s columns map themselves (House Unit → Unit / apt; Home Phone → its field; Support → its 1–5 field)', wrong.length === 0, JSON.stringify(wrong));
const notes = (await page.$$eval('.imp-map__note', (els) => els.map((e) => e.innerText))).join(' | ');
check('a phone Excel cut short is named, and won’t be imported', /lost its last digits in Excel/.test(notes), notes);
const roleRows = Object.fromEntries(await page.$$eval('section[aria-labelledby="imp-roles-h"] .imp-rmap__row', (rows) => rows.map((r) => [r.querySelector('.imp-rmap__word').innerText.trim(), (() => { const x = r.querySelector('select'); return x.options[x.selectedIndex].text; })()])));
check('Volunteer roles: Vol: Door Knocker → Doorknocking; Vol: GOTV a tag only', roleRows['Vol: Door Knocker'] === 'Doorknocking' && roleRows['Vol: GOTV'] === 'A tag only', JSON.stringify(roleRows));
await page.selectOption('select[aria-label="The role “Vol: GOTV” is"]', 'driver');
const split = await page.innerText('.imp-split').catch(() => '');
check('the import offers “Lee Ann” → Lee · Ann, ticked', /1 first name has a second word/.test(split) && /Lee Ann.*Lee · Ann/s.test(split) && await page.isChecked('.imp-split input'), split);
const readRows = (sec) => page.$$eval(`section[aria-labelledby="${sec}"] .imp-rmap__row`, (rows) => Object.fromEntries(rows.map((r) => [r.querySelector('.imp-rmap__word').innerText.trim(), (() => { const x = r.querySelector('select'); return x.options[x.selectedIndex].text; })()])));
const hist = await readRows('imp-hist-h');
check('Past conversations: Not Home → Not home; Spoke - supporter → Talked', hist['Not Home'] === 'Not home' && hist['Spoke - supporter'] === 'Talked', JSON.stringify(hist));
const signs0 = await readRows('imp-sign-h');
check('Signs: Yes is a profile field only until you say', signs0.Yes === 'A profile field only', JSON.stringify(signs0));
await page.selectOption('select[aria-label="What a sign “Yes” means"]', 'requested');
await page.screenshot({ path: `${SHOTS}/03-list-format.png`, fullPage: true });
await page.click('button:has-text("Check 3 rows")');
await sleep(1500);
await page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click();
await sleep(2000);
const lp = async (q) => (await api(`/persons?q=${encodeURIComponent(q)}`)).json.persons[0];
const riya = await lp('Riya Sample');
check('Riya: unit 204 at 16068 83 Ave, her mobile, the pin, tags split, volunteer and donor',
  riya?.unit === '204' && riya.address === '16068 83 Ave' && riya.phone === '16045550188' && riya.lat != null
  && ['Team: North', 'Vol: Door Knocker', 'Zone 1', 'volunteer', 'donor'].every((x) => riya.tags.includes(x)) && !riya.voted_at, JSON.stringify(riya));
const rf = (await api(`/persons/${riya.id}/fields`)).json.fields;
const fv = (n) => rf.find((f) => f.name === n)?.value;
check('Riya’s profile fields: Province BC, House notes, Email opt-in yes, SMS opt-in no, Support 5',
  fv('Province') === 'BC' && /old supporter list/.test(fv('House notes') || '') && fv('Email opt-in') === true && fv('SMS opt-in') === false && fv('Support') === 5, JSON.stringify(rf.filter((f) => f.value != null).map((f) => [f.name, f.value])));
const riyaRoles = (await api(`/persons/${riya.id}`)).json.roles.map((r) => r.role).sort().join(',');
check('Riya’s volunteer roles: Doorknocking and Driver (the GOTV tag, as chosen)', riyaRoles === 'doorknocking,driver', riyaRoles);
const riyaFull = (await api(`/persons/${riya.id}`)).json;
check('Riya’s history: not home at the door on Oct 4, from an imported list; a lawn sign to put up',
  riyaFull.contacts.some((x) => x.channel === 'door' && x.outcome === 'no_answer' && /imported list/.test(x.note || '') && /^2026-10-0[45]/.test(new Date(x.created_at).toISOString()))
  && riyaFull.signs.some((x) => x.kind === 'lawn' && x.status === 'requested'), JSON.stringify({ c: riyaFull.contacts, s: riyaFull.signs }));
check('first and last kept apart, as the file has them (First Name · Surname)', riya.first_name === 'Riya' && riya.last_name === 'Sample', `${riya.first_name} · ${riya.last_name}`);
await page.goto(`${ADMIN}/people/${riya.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pf-edit', { timeout: 8000 }).catch(() => {});
await page.click('.pf-edit');
await page.waitForSelector('#ed-first', { timeout: 8000 }).catch(() => {});
check('her profile’s Edit: First name Riya, Last name Sample', (await page.inputValue('#ed-first').catch(() => '')) === 'Riya' && (await page.inputValue('#ed-last').catch(() => '')) === 'Sample');
await page.fill('#ed-last', 'Example');
await page.click('form[aria-label="Edit details"] button[type="submit"]');
await sleep(1200);
const re = (await api(`/persons/${riya.id}`)).json.person;
check('a new last name: the whole name follows (Riya Example)', re.name === 'Riya Example' && re.last_name === 'Example', `${re.name} · ${re.first_name} · ${re.last_name}`);
await page.screenshot({ path: `${SHOTS}/04-names.png` });
const omar2 = await lp('Omar Listed');
check('Omar (no mobile): his home phone is the number to call', omar2?.phone === '604-555-0177', JSON.stringify(omar2));
const lee = await lp('Lee Ann Listed');
check('Lee Ann: first Lee, middle Ann (the import’s suggestion, on by default)', lee?.first_name === 'Lee' && lee?.middle_name === 'Ann' && lee?.last_name === 'Listed', JSON.stringify(lee && [lee.first_name, lee.middle_name, lee.last_name]));
check('Lee (1.6045E+10): no wrong number on file', lee && !lee.phone, JSON.stringify(lee));

// ── Add a person: a first name with a second word goes to Middle name ──
await page.goto(`${ADMIN}/people?new=1`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#np-first', { timeout: 8000 }).catch(async () => { await page.goto(`${ADMIN}/people`); await page.click('button:has-text("Add person")'); await page.waitForSelector('#np-first'); });
await page.fill('#np-first', 'Mary Anne');
await page.press('#np-first', 'Tab');
check('Add a person: “Mary Anne” → First Mary, Middle Anne, with Undo', (await page.inputValue('#np-first')) === 'Mary' && (await page.inputValue('#np-middle')) === 'Anne' && /Moved “Anne” to Middle name/.test(await page.innerText('.name-note')));
await page.click('.name-note button');
check('Undo: Mary Anne is one first name again', (await page.inputValue('#np-first')) === 'Mary Anne' && (await page.inputValue('#np-middle')) === '');
await page.fill('#np-first', 'Mary-Anne');
await page.press('#np-first', 'Tab');
check('hyphenated: stays whole', (await page.inputValue('#np-first')) === 'Mary-Anne' && (await page.inputValue('#np-middle')) === '');
await page.fill('#np-first', 'Jo B.');
await page.press('#np-first', 'Tab');
await page.fill('#np-last', 'Middleton');
await page.click('form.pp-add button[type="submit"]');
await page.waitForURL(/\/people\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
const jo = (await lp('Jo B. Middleton'));
check('saved: Jo · B. · Middleton', jo?.first_name === 'Jo' && jo?.middle_name === 'B.' && jo?.last_name === 'Middleton', JSON.stringify(jo && [jo.name, jo.first_name, jo.middle_name, jo.last_name]));

// ── A list from a past election: tags with the year, not today's marks ──
await page.goto(`${ADMIN}/people/import`, { waitUntil: 'domcontentloaded' });
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', ['First Name\tSurname\tPhone\tRating\tSign\tVoted', 'Pat\tPastyear\t604-555-0199\t1\tYes\tyes'].join('\n'));
await page.click('button:has-text("Use this text")');
await page.waitForSelector('.imp-map__row', { timeout: 8000 });
await page.selectOption('select[aria-label="What a sign “Yes” means"]', 'installed');
await page.check('.imp-past__toggle input');
await page.fill('.imp-past__year', '2022');
const pastNote = await page.innerText('.imp-past');
check('From a past election: says ratings, signs and voted become tags with the year', /Strong support 2022/.test(pastNote) && /Voted 2022/.test(pastNote), pastNote);
const pastFields = await page.innerText('.imp-past__fields').catch(() => '');
check('its profile fields: Sign ticked, as “Sign 2022”', /Sign\s+→ Sign 2022/.test(pastFields) && await page.isChecked('.imp-past__list input'), pastFields);
await page.screenshot({ path: `${SHOTS}/05-past-election.png`, fullPage: true });
await page.click('button:has-text("Check 1 row")');
await sleep(1500);
await page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click();
await sleep(2000);
const pat = await lp('Pat Pastyear');
check('Pat: Strong support 2022, Lawn sign 2022, Voted 2022 — no rating, not voted, no sign',
  pat && !pat.rating && !pat.voted_at && ['Strong support 2022', 'Lawn sign 2022', 'Voted 2022', 'Sign 2022'].every((t) => pat.tags.includes(t))
  && !(await api(`/persons/${pat.id}/fields`)).json.fields.some((f) => f.name === 'Sign' && f.value != null)
  && (await api(`/persons/${pat.id}`)).json.signs.length === 0, JSON.stringify(pat && [pat.rating, pat.voted_at, pat.tags]));

// ── A voter number: a column of the list, then the key that finds them again ──
await page.goto(`${ADMIN}/people/import`, { waitUntil: 'domcontentloaded' });
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', ['First Name\tSurname\tVoter ID\tStreet Address', 'Vera\tElector\tA12-3456\t7 Elm St'].join('\n'));
await page.click('button:has-text("Use this text")');
await page.waitForSelector('.imp-map__row', { timeout: 8000 });
const vmap = await page.$$eval('.imp-map__select', (els) => els.map((e) => e.options[e.selectedIndex].text));
check('a Voter ID column matches itself to Voter number', vmap.join('|') === 'First name|Last name|Voter number|Street address', vmap.join('|'));
await page.click('button:has-text("Check 1 row")');
await sleep(1500);
await page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click();
await sleep(1800);
// The same voter, written another way, with a phone: found by the number.
await page.goto(`${ADMIN}/people/import`, { waitUntil: 'domcontentloaded' });
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', ['Name\tVoter Number\tPhone\tVoter ID Verified', 'ELECTOR Vera\ta123456\t604-555-0143\tyes'].join('\n'));
await page.click('button:has-text("Use this text")');
await page.waitForSelector('.imp-map__row', { timeout: 8000 });
const vmap2 = await page.$$eval('.imp-map__select', (els) => els.map((e) => e.options[e.selectedIndex].text));
check('a yes/no column that only mentions the voter ID is not taken for the number', vmap2.join('|') === 'Full name|Voter number|Phone|Don’t import', vmap2.join('|'));
await page.click('button:has-text("Check 1 row")');
await sleep(1500);
const vcheck = (await page.innerText('.imp-result').catch(() => '')).replace(/\s+/g, ' ');
check('the check finds her by the number: 0 new, 1 to update', /New 0/i.test(vcheck) && /Update 1/i.test(vcheck), vcheck.slice(0, 120));
await page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click();
await sleep(1800);
const veras = (await api('/persons?q=Elector')).json.persons;
const vnum = veras[0] ? (await api(`/persons/${veras[0].id}/voter-number`)).json : null;
check('one Vera Elector, with the number (letters and digits) and the phone filled in', veras.length === 1 && vnum?.voter_number === 'A123456' && veras[0].phone === '604-555-0143',
  JSON.stringify([veras.map((v) => [v.name, v.phone]), vnum]));
await page.goto(`${ADMIN}/people/${veras[0]?.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pf-sec__btn:has-text("More details")', { timeout: 8000 }).catch(() => {});
await page.click('.pf-sec__btn:has-text("More details")').catch(() => {});
await page.waitForSelector('form[aria-label="Voter number"] input', { timeout: 8000 }).catch(() => {});
check('her profile: the voter number under More details', (await page.inputValue('form[aria-label="Voter number"] input').catch(() => '')) === 'A123456');

// ── Gifts made in another tool, from its file ──
const act = (name, body) => page.evaluate(async ([n, b]) => {
  const r = await fetch(`/api/actions/${n}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [name, body]);
const measure = (pg) => pg.evaluate(() => {
  const main = document.querySelector('main.page') || document.body;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const taps = [...main.querySelectorAll('input:not([type=checkbox]):not([type=file]), select, textarea, button, a.btn')].filter(visible).map((el) => el.getBoundingClientRect().height);
  return { yellow: [...document.querySelectorAll('.btn-primary')].filter(visible).length, overflow: document.documentElement.scrollWidth - window.innerWidth, minTap: taps.length ? Math.min(...taps) : null };
});
const simple = async (pg, name) => {
  const m = await measure(pg);
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥48px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= 47.5), JSON.stringify(m));
};
const yr = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric' }).format(new Date()));
const mk = async (b) => (await act('person.create', { kind: 'person', ...b })).json.person;
const ana = await mk({ first_name: 'Ana', last_name: 'Example', email: `ana.${tag}@example.org`, phone: '604-555-0101', address: '13450 104 Ave', city: 'Surrey', postal: 'V3T 1V8' });
const ben = await mk({ first_name: 'Ben', last_name: 'Example', phone: '(604) 555-0102', address: '9 Oak Ave', postal: 'V3T 2C3' });
await mk({ first_name: 'Dee', last_name: 'Twin', postal: 'V3S 1A1', address: '1 Main St' });
const dee2 = await mk({ first_name: 'Dee', last_name: 'Twin', postal: 'V3S 1A1', address: '2 Main St' });
// One gift typed at the desk: it takes this year's first receipt number.
const deskGift = (await act('gift.log', { person_id: ben.id, amount_cents: 2000, date: `${yr}-02-01`, method: 'cash' })).json.gift;
const firstReceipt = (await api(`/receipts/gift/${deskGift.id}`)).json.receipt?.number;
const giftFile = [
  'Transaction ID,Donor,Donor Email,Phone,Billing Address,Postal Code,Amount,Date Received,Payment Method,Receipt #',
  `GL-1002,Ana Example,ana.${tag}@example.org,604-555-0101,13450 104 Ave,V3T 1V8,$900.00,${yr}-04-02,Visa,R-0002`,
  `GL-1001,Ana Example,ana.${tag}@example.org,604-555-0101,13450 104 Ave,V3T 1V8,$600.00,${yr}-03-01,Visa,R-0001`,
  `GL-1003,"Example, Ben",,6045550102,9 Oak Ave,V3T 2C3,50,${yr}-04-15,Cheque,R-0003`,
  `GL-1004,Nobody Known,nobody.${tag}@example.org,604-555-0177,,,75.00,${yr}-05-01,Interac e-Transfer,R-0004`,
  `GL-1005,Dee Twin,,,,V3S 1A1,20.00,${yr}-05-03,Cash,`,
  `GL-1006,No Amount,noamount.${tag}@example.org,,,,,${yr}-05-04,Cash,`,
].join('\n');
await page.goto(`${ADMIN}/data`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dt-page h1', { timeout: 8000 });
await page.click('a:has-text("Import gifts")');
await page.waitForURL(`${ADMIN}/money/import`, { timeout: 8000 }).catch(() => {});
await page.waitForSelector('#gi-file', { state: 'attached', timeout: 8000 });
await simple(page, 'Import gifts, choose a file (1360)');
await page.click('button:has-text("Paste text")');
await page.fill('#gi-paste', giftFile);
await page.click('button:has-text("Use this text")');
await page.waitForSelector('.imp-map__row', { timeout: 8000 });
const gmap = await page.$$eval('.imp-map__select', (els) => els.map((e) => e.options[e.selectedIndex].text));
check('a gift file’s columns match themselves, by what their headings mean',
  gmap.join('|') === 'Their number for the gift|Donor’s full name|Email|Phone|Street address|Postal code|Amount|Date of the gift|Paid by|Their receipt number', gmap.join('|'));
await simple(page, 'Import gifts, match columns (1360)');
await page.screenshot({ path: `${SHOTS}/06-gifts-match-columns.png`, fullPage: true });
await page.click('button:has-text("Check 6 rows")');
await page.waitForSelector('.imp-result', { timeout: 15000 }).catch(() => {});
await sleep(500);
const gcheck = (await page.innerText('.imp-result').catch(() => '')).replace(/\s+/g, ' ');
check('the check: 5 gifts ($1,645.00), 2 donors found, 2 to settle, 0 already here, 1 can’t import',
  /Gifts 5 \$1,645\.00/i.test(gcheck) && /Donors found 2/i.test(gcheck) && /To settle 2/i.test(gcheck) && /Already here 0/i.test(gcheck) && /Can’t import 1/i.test(gcheck), gcheck.slice(0, 200));
check('…who it takes over the year’s limit: Ana Example, $1,500.00', /1 donor would be over the year’s limit/.test(gcheck) && /Ana Example · \d{4}.*\$1,500\.00 of \$/.test(gcheck), gcheck.slice(200, 420));
check('…and what can’t come in, by its row: "No amount."', /Row 7 No amount\./.test(gcheck), gcheck.slice(-200));
const before = (await api('/records/gift?limit=50')).json.records;
check('…and nothing is saved by a check', before.length === 1 && (await api('/gifts/imports')).json.imports.length === 0, before.length);
await page.screenshot({ path: `${SHOTS}/07-gifts-check.png`, fullPage: true });
await page.getByRole('button', { name: 'Import 5 gifts' }).click();
await page.waitForSelector('.imp-done', { timeout: 15000 }).catch(() => {});
await sleep(800);
const gdone = (await page.innerText('.imp-running').catch(() => '')).replace(/\s+/g, ' ');
check('imported: "✓ 3 gifts on the books · $1,550.00", 2 need a donor, 1 over the limit, no receipts made',
  /✓ 3 gifts on the books · \$1,550\.00/.test(gdone) && /2 gifts need a donor · \$95\.00/.test(gdone) && /1 gift is over the year’s limit/.test(gdone) && /No receipts were made or emailed/.test(gdone), gdone.slice(0, 260));
await page.screenshot({ path: `${SHOTS}/08-gifts-done.png`, fullPage: true });
const ledger = (await api('/records/gift?limit=50')).json.records;
const anaGifts = ledger.filter((g) => g.person_id === ana.id).sort((a, b) => String(a.date).localeCompare(String(b.date)));
check('on the books for Ana: March then April, each marked as brought in, with the other tool’s receipt number — and April’s is the one over the limit',
  anaGifts.length === 2 && anaGifts.every((g) => g.attrs?.source === 'import') && anaGifts[0].attrs.import_receipt === 'R-0001' && anaGifts[0].flagged === false && anaGifts[1].flagged === true,
  JSON.stringify(anaGifts.map((g) => [String(g.date).slice(0, 10), g.flagged, g.attrs?.import_receipt])));
const benGift = ledger.find((g) => g.person_id === ben.id && g.attrs?.source === 'import');
check('“Example, Ben” found Ben Example by his name and phone', !!benGift && Number(benGift.amount_cents) === 5000, JSON.stringify(benGift && [benGift.amount_cents, benGift.method]));
const receiptsNow = (await api('/receipts')).json.receipts;
const nextGift = (await act('gift.log', { person_id: ben.id, amount_cents: 1000, date: `${yr}-06-01`, method: 'cash' })).json.gift;
const nextReceipt = (await api(`/receipts/gift/${nextGift.id}`)).json.receipt?.number;
check('no receipt number was used: still one receipt, and the next gift typed at the desk takes the very next number',
  receiptsNow.length === 1 && firstReceipt === `${yr}-0001` && nextReceipt === `${yr}-0002`, `${receiptsNow.length} ${firstReceipt} ${nextReceipt}`);

// Donations: Imported in the ledger; the pile and the over-limit gift under Needs you.
await page.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ops-needs .ops-row', { timeout: 10000 }).catch(() => {});
await sleep(600);
const needsText = (await page.innerText('.ops-needs').catch(() => '')).replace(/\s+/g, ' ');
check('Donations → Needs you: Ana’s gift over the limit, and "2 imported gifts need a donor" ($95.00)',
  /Needs you · 2/i.test(needsText) && /Ana Example/.test(needsText) && /over limit/i.test(needsText) && /2 imported gifts need a donor/.test(needsText) && /\$95\.00/.test(needsText), needsText);
check('the big number says what it is: "Raised this year"', /Raised this year/i.test(await page.innerText('.ops-hero')) && /\$1,580/.test(await page.innerText('.ops-hero .n')), await page.innerText('.ops-hero'));
await page.click('button:has-text("All gifts")').catch(() => {});
await sleep(300);
const benRow = page.locator('#gift-list .ops-item', { hasText: '$50.00' });
check('the ledger marks a gift from a file "Imported"', /Imported/.test(await benRow.innerText().catch(() => '')));
await benRow.locator('.ops-row').click();
await sleep(500);
const benBody = (await benRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
check('…opened: "Imported — no receipt from base.win · their receipt R-0003"', /Imported — no receipt from base\.win · their receipt R-0003/.test(benBody), benBody);
await simple(page, 'Donations after an import (1360)');
await page.screenshot({ path: `${SHOTS}/09-donations-imported.png`, fullPage: true });

// The pile: one of the records it could be; then a new person.
await page.click('.ops-needs a:has-text("imported gifts need a donor")');
await page.waitForURL(`${ADMIN}/money/import/waiting`, { timeout: 8000 }).catch(() => {});
await page.waitForSelector('.ops-rows .ops-row', { timeout: 8000 }).catch(() => {});
await page.click('.ops-row:has-text("Dee Twin")');
await sleep(400);
const cands = await page.$$eval('.gw-cand', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('Dee Twin’s gift could be two records: each with its address and why', cands.length === 2 && cands.every((c) => /Dee Twin/.test(c) && /same name and postal code/.test(c)) && /1 Main St/.test(cands.join()) && /2 Main St/.test(cands.join()), cands.join(' | '));
await simple(page, 'Gifts that need a donor (1360)');
await page.screenshot({ path: `${SHOTS}/10-gifts-pile.png`, fullPage: true });
await page.click('.gw-cand:has-text("2 Main St")');
const putOn = (await page.innerText('.ops-confirm').catch(() => '')).replace(/\s+/g, ' ');
check('picking one asks first, and says which Dee Twin: "Put this gift on Dee Twin (2 Main St · V3S 1A1)?"', /Put this gift on Dee Twin \(2 Main St · V3S 1A1\)\?/.test(putOn), putOn);
await page.click('.ops-confirm button:has-text("Yes")');
await page.waitForSelector('.ops-done', { timeout: 8000 }).catch(() => {});
const deeGifts = (await api(`/persons/${dee2.id}`)).json.gifts;
check('"✓ 1 gift on Dee Twin" — and it is on the record that was picked', /✓ 1 gift on Dee Twin/.test(await page.innerText('.ops-done').catch(() => '')) && deeGifts.length === 1 && deeGifts[0].source === 'import', JSON.stringify(deeGifts));
await page.click('.ops-row:has-text("Nobody Known")');
await sleep(300);
await page.click('button:has-text("Add as a new person")');
await page.click('.ops-confirm button:has-text("Yes")');
await page.waitForSelector('.ops-empty', { timeout: 8000 }).catch(() => {});
const nobody = (await api(`/persons?q=${encodeURIComponent(`nobody.${tag}@example.org`)}`)).json.persons;
const nobodyGifts = nobody[0] ? (await api(`/persons/${nobody[0].id}`)).json.gifts : [];
check('a new person from what the file says, the gift theirs — and the pile is empty',
  nobody.length === 1 && nobody[0].name === 'Nobody Known' && nobodyGifts.length === 1 && Number(nobodyGifts[0].amount_cents) === 7500
  && /Nothing waiting/.test(await page.innerText('.ops-empty').catch(() => '')) && (await api('/brief')).json.giftsWaiting.gifts === 0, JSON.stringify([nobody.map((n) => n.name), nobodyGifts.length]));
check('…settled as quietly as they came in: still two receipts in all', (await api('/receipts')).json.receipts.length === 2);

// The same file again adds nothing, and says so.
await page.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'More', exact: true }).click();
await page.getByRole('link', { name: 'Import a file' }).click();
await page.waitForSelector('#gi-file', { state: 'attached', timeout: 8000 });
await page.click('button:has-text("Paste text")');
await page.fill('#gi-paste', giftFile);
await page.click('button:has-text("Use this text")');
await page.waitForSelector('.imp-map__row', { timeout: 8000 });
await page.click('button:has-text("Check 6 rows")');
await page.waitForSelector('.imp-result', { timeout: 15000 }).catch(() => {});
await sleep(500);
const again = (await page.innerText('.imp-result').catch(() => '')).replace(/\s+/g, ' ');
check('the same file again: 0 gifts, 5 already here, "Nothing new" — and no Import button',
  /Gifts 0/i.test(again) && /Already here 5/i.test(again) && /Nothing new — every gift in this file is already here\./.test(again) && (await page.getByRole('button', { name: /^Import \d+ gifts?$/ }).count()) === 0, again.slice(0, 200));

// A phone: the import and Donations fit.
const gphone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await gphone.addCookies(await dctx.cookies());
const gp = await gphone.newPage();
gp.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await gp.goto(`${ADMIN}/money/import`, { waitUntil: 'domcontentloaded' });
await gp.waitForSelector('#gi-file', { state: 'attached', timeout: 8000 });
await gp.click('button:has-text("Paste text")');
await gp.fill('#gi-paste', ['First Name,Last Name,E-mail,Gift Amount,Donation Date,Paid By', `Ana,Example,ana.${tag}@example.org,10.00,03/04/${yr},Cheque`].join('\n'));
await gp.click('button:has-text("Use this text")');
await gp.waitForSelector('.imp-map__row', { timeout: 8000 });
const ask = (await gp.innerText('.gi-ask').catch(() => '')).replace(/\s+/g, ' ');
check('a date that could be read two ways is asked about, with both readings', new RegExp(`03/04/${yr} in this file is`).test(ask) && /Mar 4/.test(ask) && /Apr 3/.test(ask), ask);
await simple(gp, 'Import gifts, match columns (390)');
await gp.screenshot({ path: `${SHOTS}/11-gifts-match-phone.png`, fullPage: true });
await gp.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
await gp.waitForSelector('.ops-hero .n', { timeout: 10000 }).catch(() => {});
await sleep(500);
await simple(gp, 'Donations (390)');
await gphone.close();

// Taken back, whole — within a day.
await page.goto(`${ADMIN}/money/import`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gi-file', { timeout: 8000 }).catch(() => {});
const fileRow = (await page.innerText('.gi-file').catch(() => '')).replace(/\s+/g, ' ');
check('Brought in before: the file, who and when, 5 gifts · $1,645.00, Take back', /Pasted text/.test(fileRow) && /Marco Manager/.test(fileRow) && /5 gifts · \$1,645\.00/.test(fileRow) && /Take back/.test(fileRow), fileRow);
await page.click('.gi-file button:has-text("Take back")');
check('Take back asks first', /Take back Pasted text\? Its gifts leave the books\./.test(await page.innerText('.gi-file .ops-confirm').catch(() => '')));
await page.click('.gi-file .ops-confirm button:has-text("Yes")');
await page.waitForSelector('.gi-file__said', { timeout: 10000 }).catch(() => {});
const live = (await api('/records/gift?limit=50')).json.records.filter((g) => g.attrs?.source === 'import');
check('"✓ Taken back — 5 gifts off the books": none of them is on the books, and nothing waits',
  /✓ Taken back — 5 gifts off the books/.test(await page.innerText('.gi-file__said').catch(() => '')) && live.length === 0 && (await api('/brief')).json.flagged.length === 0, `${live.length}`);
await page.screenshot({ path: `${SHOTS}/12-gifts-taken-back.png`, fullPage: true });

// A file with no gift numbers and a way of paying base.win doesn't know
// ("Wire"): the screen asks what it means on every import — and whatever
// is said this time, the same row is the same gift.
const wireFile = ['Donor,Email,Amount,Date,Paid By', `Ana Example,ana.${tag}@example.org,15.00,${yr}-01-20,Wire`].join('\n');
const pasteGifts = async (text) => {
  await page.goto(`${ADMIN}/money/import`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gi-file', { state: 'attached', timeout: 8000 });
  await page.click('button:has-text("Paste text")');
  await page.fill('#gi-paste', text);
  await page.click('button:has-text("Use this text")');
  await page.waitForSelector('.imp-map__row', { timeout: 8000 });
};
await pasteGifts(wireFile);
const wireAsk = (await page.innerText('.imp-rmap').catch(() => '')).replace(/\s+/g, ' ');
check('a way of paying it doesn’t know is asked about: "Wire", left as Not recorded',
  /Wire 1 row/.test(wireAsk) && (await page.$eval('.imp-rmap__select', (e) => e.options[e.selectedIndex].text).catch(() => '')) === 'Not recorded', wireAsk);
await page.click('button:has-text("Check 1 row")');
await page.waitForSelector('.imp-result', { timeout: 15000 }).catch(() => {});
await page.getByRole('button', { name: 'Import 1 gift' }).click();
await page.waitForSelector('.imp-done', { timeout: 15000 }).catch(() => {});
await pasteGifts(wireFile);
await page.selectOption('.imp-rmap__select', 'etransfer');
await page.click('button:has-text("Check 1 row")');
await page.waitForSelector('.imp-result', { timeout: 15000 }).catch(() => {});
await sleep(400);
const wireAgain = (await page.innerText('.imp-result').catch(() => '')).replace(/\s+/g, ' ');
const wireGifts = (await api('/records/gift?limit=50')).json.records.filter((g) => Number(g.amount_cents) === 1500);
check('the same file again, “Wire” now called an e-transfer: still the same gift — 0 gifts, 1 already here',
  /Gifts 0/i.test(wireAgain) && /Already here 1/i.test(wireAgain) && wireGifts.length === 1 && wireGifts[0].method === null, `${wireAgain.slice(0, 120)} | ${wireGifts.length}`);

// ── The financial agent's filing date: typed in, counted down ──
const due = (() => { const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 12)).toISOString().slice(0, 10); })();
await page.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ops-hero .n', { timeout: 10000 }).catch(() => {});
check('no filing date comes with the product', (await page.locator('.fl-count').count()) === 0 && (await api('/money/filing-dates')).json.dates.length === 0);
await page.getByRole('button', { name: 'More', exact: true }).click();
await page.getByRole('button', { name: 'Filing dates' }).click();
await page.fill('#fl-name-0', 'Disclosure statement due');
await page.fill('#fl-day-0', due);
await simple(page, 'Donations → More → Filing dates (1360)');
await page.click('form[aria-label="Filing dates"] button[type="submit"]');
await page.waitForSelector('.fl-count__item', { timeout: 8000 }).catch(() => {});
const count = (await page.innerText('.fl-count').catch(() => '')).replace(/\s+/g, ' ');
check('Donations counts down to it: "12 days left · Disclosure statement due"', /12 days left Disclosure statement due/.test(count), count);
await page.screenshot({ path: `${SHOTS}/13-filing-countdown.png`, fullPage: true });
await page.goto(`${ADMIN}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#today-next-h', { timeout: 10000 }).catch(() => {});
await sleep(800);
const coming = (await page.innerText('section[aria-labelledby="today-next-h"]').catch(() => '')).replace(/\s+/g, ' ');
check('Today → Coming up: the date within 30 days, "in 12 days"', /Disclosure statement due/.test(coming) && /in 12 days/.test(coming), coming);

// ── Donations says how it stands: never a dash, a zero or a block that isn't there ──
// A fresh tab (nothing kept from an earlier load): its reads slow, then failing.
const hctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await hctx.addCookies(await dctx.cookies());
const hp = await hctx.newPage();
hp.on('pageerror', (e) => errors.push(`states: ${e.message}`));
const READS = ['**/api/brief', '**/api/receipts/needs', '**/api/payments', '**/api/records/gift*'];
for (const r of READS) await hp.route(r, (route) => { setTimeout(() => route.continue().catch(() => {}), 4000); });
await hp.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
await hp.waitForSelector('.ops-hero', { timeout: 10000 }).catch(() => {});
await sleep(1200);
const heroSlow = (await hp.innerText('.ops-hero').catch(() => '')).replace(/\s+/g, ' ');
const pageSlow = (await hp.innerText('main.page').catch(() => '')).replace(/\s+/g, ' ');
check('reads still out: the big number, Needs you and the gift list each say Loading… — no dash, no $0',
  /Raised this year Loading…/i.test(heroSlow) && /Needs you Loading…/i.test(pageSlow) && /Gifts Loading…/i.test(pageSlow) && !/—|\$0\b/.test(heroSlow), pageSlow.slice(0, 220));
await hp.screenshot({ path: `${SHOTS}/14-donations-loading.png` });
await hp.waitForSelector('.ops-hero .n', { timeout: 15000 }).catch(() => {});
check('…then the number: "Raised this year" with its amount', /Raised this year \$\d/i.test((await hp.innerText('.ops-hero').catch(() => '')).replace(/\s+/g, ' ')));
await hctx.close();
// Another fresh tab, so no copy is kept to fall back on: every read answers 500.
const fctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await fctx.addCookies(await dctx.cookies());
const fp = await fctx.newPage();
fp.on('pageerror', (e) => errors.push(`states: ${e.message}`));
for (const r of READS) await fp.route(r, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down for a moment"}' }));
await fp.goto(`${ADMIN}/money`, { waitUntil: 'domcontentloaded' });
await fp.waitForSelector('.ops-hero .gi-down', { timeout: 15000 }).catch(() => {});
await fp.waitForSelector('.ops-needs .gi-down', { timeout: 15000 }).catch(() => {});
await sleep(1500);
const downs = await fp.$$eval('main.page .gi-down', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('reads failed: the big number, Needs you and the gift list each say "Unavailable — Try again" — nothing just missing, no number made up',
  downs.length === 3 && downs.every((d) => d === 'Unavailable — Try again') && (await fp.locator('.ops-hero .gi-down').count()) === 1 && (await fp.locator('.ops-needs .gi-down').count()) === 1
  && (await fp.locator('.ops-hero .n').count()) === 0 && !/\$\d/.test(await fp.innerText('.ops-hero').catch(() => '$0')), JSON.stringify(downs));
await simple(fp, 'Donations, its reads failed (1360)');
await fp.screenshot({ path: `${SHOTS}/15-donations-unavailable.png` });
for (const r of READS) await fp.unroute(r);
await fp.click('.ops-hero .gi-down button:has-text("Try again")', { timeout: 5000 }).catch(() => {});
await fp.waitForSelector('.ops-hero .n', { timeout: 10000 }).catch(() => {});
check('Try again brings the number back', /\$\d/.test(await fp.innerText('.ops-hero .n').catch(() => '')));
await fctx.close();

// ── And out ──
for (const k of ['people', 'contacts', 'gifts', 'volunteers', 'signs', 'shifts', 'subscribers', 'lists']) {
  const r = await api(`/export/${k}.csv`);
  if (r.status !== 200) check(`export ${k}`, false, r.status);
}
const csv = (await api('/export/people.csv')).text;
check('every export is a spreadsheet; People has Priya, with the voted date', /Priya Example/.test(csv) && /,\d{4}-\d{2}-\d{2},/.test(csv));
check('…and Vera’s voter number, in its own column', /voter_number/.test(csv.split('\n')[0]) && /Vera Elector,.*,A123456,/.test(csv), csv.split('\n')[0].slice(0, 200));
await page.goto(`${ADMIN}/data`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('a:has-text("Download everything")', { timeout: 8000 });
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('a:has-text("Download everything")')]);
check('Download everything: a starbase-export JSON file', /^starbase-export.*\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
