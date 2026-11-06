// Import & export — a fresh in-memory campaign. The desk opens Import &
// export (People → More), imports people from an Excel workbook (.xlsx —
// deflated, shared strings, a date-formatted Voted column, the way Excel
// saves one): the columns match themselves, the check says who's new, the
// import lands them on file and marks the voter. Then each export is a
// spreadsheet, and the People one carries what came in.
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
const L2 = [...L1]; L2[0] = 'Omar'; L2[1] = 'Listed'; L2[2] = '604-555-0177'; L2[3] = ''; L2[4] = ''; L2[8] = ''; L2[9] = '9001'; L2[16] = ''; L2[25] = '';
const L3 = [...L1]; L3[0] = 'Lee'; L3[1] = 'Listed'; L3[3] = '1.6045E+10'; L3[4] = `lee.${tag}@example.org`; L3[9] = '9002'; L3[25] = '';
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
const lee = await lp('Lee Listed');
check('Lee (1.6045E+10): no wrong number on file', lee && !lee.phone, JSON.stringify(lee));

// ── And out ──
for (const k of ['people', 'contacts', 'gifts', 'volunteers', 'signs', 'shifts', 'subscribers', 'lists']) {
  const r = await api(`/export/${k}.csv`);
  if (r.status !== 200) check(`export ${k}`, false, r.status);
}
const csv = (await api('/export/people.csv')).text;
check('every export is a spreadsheet; People has Priya, with the voted date', /Priya Example/.test(csv) && /,\d{4}-\d{2}-\d{2},/.test(csv));
await page.goto(`${ADMIN}/data`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('a:has-text("Download everything")', { timeout: 8000 });
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('a:has-text("Download everything")')]);
check('Download everything: a starbase-export JSON file', /^starbase-export.*\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
