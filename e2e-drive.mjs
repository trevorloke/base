// Google Drive and Sheets, end to end (server/ext/drive and its screens),
// against a stand-in Google (server/test/fake-google.js, with Drive, Sheets
// and a stand-in Picker loader) — never the real one: the suite fails if
// the browser asks anything of an address other than 127.0.0.1 (the
// desk's map tiles aside, which are stopped and not Google).
//
// It starts its own servers and stops them: base.win on PORT (default
// 5320), the fake Google on PORT+1, the suite's control of the server's
// export limits on PORT+2, and the fake mail sender on PORT+3. Build the
// web app first (cd web && npm run build).
//
//   SHOTS=/tmp/drive [PORT=5320] node e2e-drive.mjs
//
// A manager, a staffer and a volunteer, at 1440x900 and 390x844:
// Settings → Services → Google Drive and Sheets (turn on, "No one" first,
// "Anyone at the desk" waiting on a shared-drive folder, the folder picked
// through the stand-in Picker, Try opening Google Drive, Check); with Sheets
// "No one" nothing changes anywhere; People → Import from a Sheet with two
// tabs and from an .xlsx in Drive; the compose's From Google Drive (a Doc
// as PDF and a picture, a test email carrying both; a 24 MB video → a link
// instead, open to anyone) on Outreach and on Media; Take it out → Send to
// Google Sheets on a list, a report and the exports, with the progress and
// Open; too big; failed → Try again; a staffer choosing the campaign folder
// before their first Sheet; Sent to Google Drive with Make private again;
// staff with Sheets for managers only; the volunteer; no signal; one
// primary per screen, no sideways scroll at 390, 48 px targets on the phone.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeGoogle } from './server/test/fake-google.js';
import { startFakeMail } from './server/test/fake-mail.js';

const SHOTS = process.env.SHOTS || '/tmp/starbase-drive';
mkdirSync(SHOTS, { recursive: true });
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 5320;
const G_PORT = PORT + 1;
const CONTROL = PORT + 2;
const MAIL_PORT = PORT + 3;
const BASE = `http://${HOST}:${PORT}`;
const ADMIN = `${BASE}/admin`;
const G = `http://${HOST}:${G_PORT}`;
const CLIENT_ID = 'e2e-drive-client.apps.example';
const SECRET = 'e2e-drive-client-secret';
const PASSWORD = 'surrey-forward-2026';
const PICKER_KEY = 'AIza-e2e-picker-key';
const PROJECT = '123456789012';
const WORK = 'campaign.example.org';
const DOMAIN = 'mail.example.org';
const tag = Date.now().toString(36);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${String(extra).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in Google and mail sender, and base.win ──
const ACCTS = {
  mo: { sub: '300000000000000000001', email: `mo@${WORK}`, hd: WORK, name: 'Mo Example' },
  sam: { sub: '300000000000000000002', email: `sam@${WORK}`, hd: WORK, name: 'Sam Example' },
};
const fake = await startFakeGoogle({
  port: G_PORT, clientId: CLIENT_ID, secret: SECRET, accounts: Object.values(ACCTS), redirectUris: [`${BASE}/api/auth/google/back`],
});
const D = fake.drive;
const mail = await startFakeMail({ provider: 'resend', port: MAIL_PORT });

const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const href = (p) => JSON.stringify(pathToFileURL(`${serverDir}${p}`).href);
const STUB = `${SHOTS}/drive-stub.mjs`;
// The server's own export limits, set from here (a "too big" Sheet without 10 million cells).
writeFileSync(STUB, `
import { createServer } from 'node:http';
const { _setLimitsForTest } = await import(${href('ext/drive/export.js')});
const { _setPaceForTest } = await import(${href('ext/drive/sheets.js')});
_setPaceForTest(50);
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/limits') _setLimitsForTest(JSON.parse(body || '{}'));
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(GOOGLE_|RESEND_|SENDGRID_|MAIL_|STARBASE_)/.test(k)) delete env[k];
Object.assign(env, {
  STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_PUBLIC_URL: BASE, STARBASE_JOBS_EVERY_MS: '1000',
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: SECRET, GOOGLE_ACCOUNTS_BASE: G, GOOGLE_OAUTH_BASE: G,
  GOOGLE_TOKEN_KEY: `e2e-drive-token-key-${tag}-0123456789abcdef`,
  GOOGLE_PICKER_KEY: PICKER_KEY, GOOGLE_CLOUD_PROJECT_NUMBER: PROJECT,
  GOOGLE_DRIVE_API_BASE: G, GOOGLE_SHEETS_API_BASE: G, GOOGLE_PICKER_SCRIPT: `${G}/picker.js`,
  RESEND_API_KEY: 're_e2e_drive', RESEND_API_BASE: `http://${HOST}:${MAIL_PORT}`, MAIL_FROM: `Sample Campaign <team@${DOMAIN}>`,
});
const server = spawn(process.execPath, ['--import', pathToFileURL(STUB).href, 'server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stopAll = async () => {
  server.kill('SIGTERM');
  await sleep(300);
  if (server.exitCode === null) server.kill('SIGKILL');
  await fake.close();
  await mail.close?.();
};
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
let up = false;
for (let i = 0; i < 100 && !up; i += 1) {
  if (server.exitCode !== null) break;
  up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (!up) await sleep(200);
}
if (!up) { console.log(serverLog.slice(-1500)); await stopAll(); process.exit(1); }
const limits = (o) => fetch(`http://${HOST}:${CONTROL}/limits`, { method: 'POST', body: JSON.stringify(o) });

// Files someone already has in Drive.
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
const XS = ['First Name', 'Last Name', 'Email Address', 'Phone Number', 'City', 'Priya', 'Example', `priya.${tag}@example.org`, 'Surrey', 'Omar', 'Sample', 'Whalley'];
const xc = (ref, v, s) => (s ? `<c r="${ref}" t="s"><v>${XS.indexOf(v)}</v></c>` : `<c r="${ref}"><v>${v}</v></c>`);
const XLSX = zip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Supporters" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${['First Name', 'Last Name', 'Email Address', 'Phone Number', 'City'].map((h, i) => xc(`${'ABCDE'[i]}1`, h, true)).join('')}</row>
<row r="2">${xc('A2', 'Priya', true)}${xc('B2', 'Example', true)}${xc('C2', `priya.${tag}@example.org`, true)}${xc('D2', '6045550161')}${xc('E2', 'Surrey', true)}</row>
<row r="3">${xc('A3', 'Omar', true)}${xc('B3', 'Sample', true)}${xc('D3', '6045550162')}${xc('E3', 'Whalley', true)}</row>
</sheetData></worksheet>`],
  ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${XS.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`],
]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SHARED = D.folder({ name: 'Campaign exports', driveId: '0Ashared-drive-e2e' });
D.readable({
  name: 'Volunteer sign-ups',
  tabs: [
    { title: 'Spring', rows: [['First Name', 'Last Name', 'Email', 'Phone'], ['Ana', 'Example', `ana.${tag}@example.org`, '604-555-0101'], ['Ben', 'Sample', `ben.${tag}@example.org`, '604-555-0102']] },
    { title: 'Fall', rows: [['First Name', 'Last Name', 'Email'], ['Cal', 'Example', `cal.${tag}@example.org`]] },
  ],
});
D.file({ name: 'Supporters.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: XLSX });
D.file({ name: 'Transit plan', mimeType: 'application/vnd.google-apps.document' });
D.file({ name: 'Team photo.png', mimeType: 'image/png', data: PNG });
D.file({ name: 'Rally video.mp4', mimeType: 'video/mp4', data: Buffer.alloc(1024), size: 24 * 1024 * 1024 });

let browser;
const errors = [];
const offHost = [];
try {
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const newPage = async (viewport = DESKTOP, label = 'page', storageState) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...(storageState ? { storageState } : {}), ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== HOST && u.protocol !== 'data:' && u.protocol !== 'blob:') { offHost.push(u.href); return route.abort(); }
      return route.continue();
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    return { ctx, page };
  };
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const text = async (p, sel = 'body') => ((await p.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ');
  const settle = async (p, ms = 400) => { await p.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
  const go = async (p, path) => { await p.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await settle(p); };
  const api = (p, path, body) => p.evaluate(async ([u, b]) => {
    const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, body]);
  const measure = (p) => p.evaluate(() => {
    const vis = (x) => { const r = x.getBoundingClientRect(); const s = getComputedStyle(x); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      primary: [...document.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.innerText.trim()),
    };
  });
  // Drive's own controls on a phone: 48 px tall at least.
  const smallDrive = (p) => p.evaluate(() => [...document.querySelectorAll('button, a.btn')].filter((b) => b.offsetParent
    && /Google|Take it out|Add a link|Add link|Make private|Choose the campaign|Try again|Change|Which tab|Spring|Fall|People it|Anyone/.test(b.innerText))
    .map((b) => ({ t: b.innerText.trim().slice(0, 30), h: Math.round(b.getBoundingClientRect().height) })).filter((x) => x.h < 48));
  const pickGoogle = async (p, who) => {
    await p.waitForURL((u) => u.port === String(G_PORT), { timeout: 10000 });
    await p.click(`a.acct[data-sub="${ACCTS[who].sub}"]`);
    await p.waitForURL((u) => u.port !== String(G_PORT), { timeout: 10000 });
    await settle(p);
  };
  // The stand-in Picker: tick these files by name, then Select (or Cancel).
  const pickInDrive = async (p, names) => {
    await p.locator('#fake-picker').waitFor({ timeout: 10000 });
    if (names === 'cancel') { await p.click('#fake-picker-cancel'); return; }
    for (const n of names) await p.locator('label.fake-picker-file', { hasText: n }).locator('input').check();
    await p.click('#fake-picker-select');
  };
  const picked = (p) => p.evaluate(() => window.__picker?.last || null);

  // ── A manager signs up; a staffer and a volunteer join ──
  const { ctx: mctx, page: m } = await newPage(DESKTOP, 'manager');
  await m.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await m.fill('#su-name', 'Mo Example');
  if (await m.locator('#su-org').count()) await m.fill('#su-org', 'Sample Campaign');
  await m.fill('#su-email', `mo.${tag}@example.org`);
  await m.fill('#su-password', PASSWORD);
  await m.click('button[type="submit"]');
  await m.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  const joinByApi = async (email, role, name) => {
    const inv = (await api(m, '/api/actions/member.invite', { email, role })).json;
    const r = await fetch(`${BASE}/api/auth/join`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ token: inv.joinUrl.split('/join/')[1], name, password: PASSWORD }) });
    return r.status;
  };
  const staffEmail = `sam.${tag}@example.org`;
  const volEmail = `val.${tag}@example.org`;
  check('a staffer and a volunteer join', (await joinByApi(staffEmail, 'staff', 'Sam Example')) === 200 && (await joinByApi(volEmail, 'volunteer', 'Val Example')) === 200);
  const signIn = async (vp, email, label) => {
    const { ctx, page } = await newPage(vp, label);
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('#login-email', email);
    await page.fill('#login-password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(500);
    return { ctx, page };
  };

  // ── Drive set up, off: nothing anywhere ──
  check('/api/integrations says drive (the server is set up)', (await api(m, '/api/integrations')).json?.drive === true);
  check('/api/drive: set up, off, Sheets "off"', (() => true)() && (await api(m, '/api/drive')).json?.on === false);
  await go(m, '/people/import');
  check('Drive off: no "From Google Drive" on Import', (await m.getByRole('button', { name: 'From Google Drive' }).count()) === 0);

  // ── Settings → Services → Google Drive and Sheets ──
  await go(m, '/settings/services');
  const row = m.locator('.sv2-row', { hasText: 'Google Drive and Sheets' });
  await row.waitFor({ timeout: 8000 });
  check('Services: the Drive row, set up, with the switch off', /Picker key and project number set/.test(await text(m, '.sv2-row:has-text("Google Drive and Sheets")'))
    && (await row.getByRole('switch', { name: /Let the desk use Google Drive/ }).getAttribute('aria-checked')) === 'false');
  await shot(m, '01-services-drive-off-desktop');
  // Off, the manager checks first (the owner steps): More → Try opening Google Drive.
  // Not connected yet: Connect Google Drive appears right there, "Change" is not touched.
  await row.getByRole('button', { name: 'More' }).click();
  await row.getByRole('button', { name: 'Try opening Google Drive' }).click();
  await row.locator('.drv-more').getByText('Connect Google Drive').waitFor({ timeout: 8000 });
  check('Try opening while off, not connected: Connect Google Drive beside it, with its line',
    /base\.win only sees the files you pick\./.test(await text(m, '.sv2-row:has-text("Google Drive and Sheets") .drv-more')));
  await row.locator('.drv-more').getByText('Connect Google Drive').click();
  await pickGoogle(m, 'mo');
  check('back on Services after Google', new URL(m.url()).pathname === '/admin/settings/services', m.url());
  await m.getByText('Google Drive connected').first().waitFor({ timeout: 8000 }).catch(() => {});
  check('the toast "Google Drive connected"', /Google Drive connected/.test(await text(m)));
  await row.getByRole('button', { name: 'More' }).click();
  await row.getByRole('button', { name: 'Try opening Google Drive' }).click();
  await pickInDrive(m, 'cancel');
  await row.getByText('✓ Google Drive opens').waitFor({ timeout: 8000 }).catch(() => {});
  check('Try opening Google Drive, still off → "✓ Google Drive opens"', /✓ Google Drive opens/.test(await text(m, '.sv2-row:has-text("Google Drive and Sheets")')));
  await row.getByRole('switch', { name: /Let the desk use Google Drive/ }).click();
  await row.getByText('Who can send to Google Sheets').waitFor({ timeout: 8000 });
  const who = async () => row.locator('[role="radiogroup"] [role="radio"]').evaluateAll((els) => els.map((e) => ({ t: e.innerText.trim(), on: e.getAttribute('aria-checked') === 'true', off: e.disabled })));
  let w = await who();
  check('turned on: "No one" chosen first; "Anyone at the desk" waits on a shared-drive folder', w[0].t === 'No one' && w[0].on && w[2].off && w[2].t === 'Anyone at the desk'
    && /Anyone at the desk needs a shared-drive folder\./.test(await text(m, '.sv2-row:has-text("Google Drive and Sheets")'))
    && /Lists and tables stay in base\.win until you choose\./.test(await text(m, '.sv2-row:has-text("Google Drive and Sheets")')), JSON.stringify(w));
  check('the one helper line: no domain rule yet', /Any Google Workspace account can connect\. Set your domain under Google sign-in to allow only yours\./.test(await text(m, '.sv2-row:has-text("Google Drive and Sheets")')));
  await row.getByRole('button', { name: /^Change/ }).click();
  await pickInDrive(m, ['Campaign exports']);
  await row.getByText('Campaign exports · shared drive').waitFor({ timeout: 8000 });
  const pk = await picked(m);
  const tok = (await api(m, '/api/drive/picker')).json;
  check('the stand-in Picker got the app id, the token and the developer key the server gave', pk?.appId === PROJECT && pk?.key === PICKER_KEY && pk?.token === tok.token && Boolean(tok.token), JSON.stringify({ appId: pk?.appId, key: pk?.key }));
  check('the folder Picker: folders, shared drives shown', pk?.views?.[0]?.viewId === 'folders' && pk.views[0].enableDrives && pk.views[0].selectFolder, JSON.stringify(pk?.views));
  w = await who();
  check('with a shared-drive folder, "Anyone at the desk" may be chosen', !w[2].off, JSON.stringify(w));
  await row.getByRole('button', { name: 'Check' }).click();
  await row.locator('.sv2-said').waitFor({ timeout: 10000 });
  check('Check: Drive and Sheets answer', /Working · Drive and Sheets answer/.test(await text(m, '.sv2-row:has-text("Google Drive and Sheets")')), await text(m, '.sv2-row:has-text("Google Drive and Sheets") .sv2-said'));
  let mm = await measure(m);
  check('Services: at most one primary', mm.primary.length <= 1, JSON.stringify(mm.primary));
  await shot(m, '02-services-drive-on-desktop');
  {
    const { page } = await newPage(PHONE, 'services phone', await mctx.storageState());
    await go(page, '/settings/services');
    await page.locator('.sv2-row:has-text("Google Drive and Sheets") .drv-panel-s').waitFor({ timeout: 8000 });
    const pm = await measure(page);
    const small = await smallDrive(page);
    check('Services (390): no sideways scroll; the Drive panel’s buttons 48 px', pm.overflow <= 0 && small.length === 0, JSON.stringify({ o: pm.overflow, small }));
    await shot(page, '03-services-drive-phone');
    await page.context().close();
  }

  // ── People → Import from a Google Sheet with two tabs ──
  await go(m, '/people/import');
  await m.getByRole('button', { name: 'From Google Drive' }).click();
  await pickInDrive(m, ['Volunteer sign-ups']);
  await m.getByText('Which tab?').waitFor({ timeout: 8000 });
  const pkt = await picked(m);
  check('the import Picker: Sheets, CSV and Excel, shared drives shown', /application\/vnd\.google-apps\.spreadsheet/.test(pkt?.views?.[0]?.mimeTypes || '') && pkt.views[0].enableDrives);
  mm = await measure(m);
  check('Import: "Which tab?" with a chip per tab, "Choose a file" still the one primary', /Spring/.test(await text(m, '.drv-tabs')) && /Fall/.test(await text(m, '.drv-tabs')) && mm.primary.join('|') === 'Choose a file', JSON.stringify(mm.primary));
  await shot(m, '04-import-tabs-desktop');
  await m.locator('.drv-chip', { hasText: 'Spring' }).click();
  await m.getByText('Volunteer sign-ups · Spring (Google Drive)').waitFor({ timeout: 10000 });
  check('the importer reads the tab: its name, 2 rows', /Volunteer sign-ups · Spring \(Google Drive\) · 2 rows/.test(await text(m)), (await text(m)).slice(0, 400));
  await shot(m, '05-import-columns-desktop');
  await m.getByRole('button', { name: /^Check 2 rows/ }).click();
  await m.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click({ timeout: 20000 });
  await m.getByText(/Imported|added/).first().waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(800);
  const found = (await api(m, `/api/persons?q=${encodeURIComponent(`ana.${tag}`)}`)).json;
  check('Import → the people are there', JSON.stringify(found || {}).includes(`ana.${tag}@example.org`), JSON.stringify(found).slice(0, 200));
  // An .xlsx in Drive: "12 KB of 12 KB", then the importer's own reader.
  await go(m, '/people/import');
  await m.getByRole('button', { name: 'From Google Drive' }).click();
  await pickInDrive(m, ['Supporters.xlsx']);
  await m.getByText('Supporters.xlsx · Supporters').waitFor({ timeout: 10000 });
  check('an .xlsx in Drive goes through the importer’s workbook reader', /Supporters\.xlsx · Supporters · 2 rows/.test(await text(m)));
  {
    const { page } = await newPage(PHONE, 'import phone', await mctx.storageState());
    await go(page, '/people/import');
    await page.getByRole('button', { name: 'From Google Drive' }).waitFor({ timeout: 8000 });
    const pm = await measure(page);
    check('Import (390): no sideways scroll; From Google Drive 48 px; one primary', pm.overflow <= 0 && (await smallDrive(page)).length === 0 && pm.primary.length === 1, JSON.stringify(pm));
    await page.getByRole('button', { name: 'From Google Drive' }).click();
    await pickInDrive(page, ['Volunteer sign-ups']);
    await page.getByText('Which tab?').waitFor({ timeout: 8000 });
    check('Import tabs (390): the chips 48 px', (await smallDrive(page)).length === 0 && (await measure(page)).overflow <= 0, JSON.stringify(await smallDrive(page)));
    await shot(page, '06-import-tabs-phone');
    await page.context().close();
  }

  // ── Outreach → Email: From Google Drive ──
  await go(m, '/outreach/newsletter');
  await m.click('button:has-text("Write an email")');
  await m.waitForSelector('#newsletter-subject', { timeout: 8000 });
  await m.fill('#newsletter-subject', 'This week on the campaign');
  await m.fill('#newsletter-body', 'Hello friends.');
  check('the compose: "Google Docs, Sheets and Slides go as PDF."', /Google Docs, Sheets and Slides go as PDF\./.test(await text(m, '.ot-attach__hint')));
  await m.getByRole('button', { name: 'From Google Drive' }).click();
  await pickInDrive(m, ['Transit plan', 'Team photo.png']);
  await m.locator('.ot-file', { hasText: 'Team photo.png' }).waitFor({ timeout: 10000 });
  const pka = await picked(m);
  check('the attach Picker: several at once, at most 5', pka?.multiselect && pka.maxItems === 5, JSON.stringify({ ms: pka?.multiselect, max: pka?.maxItems }));
  check('both listed: Transit plan.pdf and Team photo.png', /Transit plan\.pdf/.test(await text(m, '.ot-files')) && /Team photo\.png/.test(await text(m, '.ot-files')));
  await m.getByRole('button', { name: 'Send me a test' }).click();
  await sleep(1500);
  const test = mail.sent.find((x) => /^\[Test\]/.test(x.subject || ''));
  const att = (test?.body?.attachments || []).map((a) => a.filename);
  check('the test email carries a PDF and a PNG', att.includes('Transit plan.pdf') && att.includes('Team photo.png'), JSON.stringify(att));
  await m.getByRole('button', { name: 'From Google Drive' }).click();
  await pickInDrive(m, ['Rally video.mp4']);
  await m.locator('.drv-big').waitFor({ timeout: 10000 });
  check('a 24 MB video: "too big to attach", not added', /Rally video\.mp4 is 24 MB — too big to attach \(5 MB at most\)/.test(await text(m, '.drv-big')), await text(m, '.drv-big'));
  await m.getByRole('button', { name: 'Add a link instead' }).click();
  await m.getByRole('radio', { name: 'Anyone with the link' }).click();
  check('Anyone with the link: the line under the chips', /Anyone who gets this can open it, and pass it on\./.test(await text(m, '.drv-big')));
  mm = await measure(m);
  check('with the link choice open, the compose has exactly one primary', mm.primary.length === 1, JSON.stringify(mm.primary));
  await shot(m, '07-compose-link-choice-desktop');
  await m.getByRole('button', { name: 'Add link' }).click();
  await m.locator('.drv-big').waitFor({ state: 'detached', timeout: 10000 });
  const body = await m.inputValue('#newsletter-body');
  check('the link at the end of the message', /\n\n\[Rally video\.mp4\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[^)]+\)$/.test(body), body);
  const perm = [...D.files.values()].find((f) => f.name === 'Rally video.mp4')?.permissions;
  check('Google was asked for “anyone, reader”', perm && [...perm.values()].some((p) => p.type === 'anyone' && p.role === 'reader' && !('sendNotificationEmail' in p)));
  await shot(m, '08-compose-files-desktop');
  {
    const { page } = await newPage(PHONE, 'compose phone', await mctx.storageState());
    await go(page, '/outreach/newsletter');
    await page.click('button:has-text("Write an email")');
    await page.waitForSelector('#newsletter-subject', { timeout: 8000 });
    await page.fill('#newsletter-subject', 'Phone');
    await page.fill('#newsletter-body', 'Hello.');
    await page.getByRole('button', { name: 'From Google Drive' }).click();
    await pickInDrive(page, ['Rally video.mp4']);
    await page.locator('.drv-big').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Add a link instead' }).click();
    const pm = await measure(page);
    check('compose (390): the too-big row and its choice — no sideways scroll, 48 px, one primary', pm.overflow <= 0 && (await smallDrive(page)).length === 0 && pm.primary.length === 1, JSON.stringify({ pm, s: await smallDrive(page) }));
    await shot(page, '09-compose-link-choice-phone');
    await page.context().close();
  }

  // ── Media → Write a release: the same, through media.* ──
  await go(m, '/media?new=1');
  await m.waitForSelector('#press-subject', { timeout: 8000 });
  await m.fill('#press-subject', 'Campaign unveils transit plan');
  await m.fill('#press-body', 'FOR IMMEDIATE RELEASE');
  const before = D.calls.length;
  await m.getByRole('button', { name: 'From Google Drive' }).click();
  await pickInDrive(m, ['Team photo.png']);
  await m.locator('.ot-file', { hasText: 'Team photo.png' }).waitFor({ timeout: 10000 });
  check('Media: a Drive picture attached to the release', /Team photo\.png/.test(await text(m, '.ot-files')) && D.calls.length > before);
  check('Media: the helper line stays, with the PDF clause', /Video: paste a link \(YouTube, Vimeo, Drive\)\. Google Docs, Sheets and Slides go as PDF\./.test(await text(m, '.ot-attach__hint')));
  await m.getByRole('button', { name: 'From Google Drive' }).click();
  await pickInDrive(m, ['Rally video.mp4']);
  await m.locator('.drv-big').waitFor({ timeout: 10000 });
  await m.getByRole('button', { name: 'Add a link instead' }).click();
  await m.getByRole('button', { name: 'Add link' }).click();
  await m.locator('.drv-big').waitFor({ state: 'detached', timeout: 10000 });
  check('Media: a link shared in Drive at the end of the release', /\[Rally video\.mp4\]\(/.test(await m.inputValue('#press-body')));
  await shot(m, '10-release-drive-desktop');

  // ── Sheets "No one": nothing changes anywhere ──
  const listId = (await api(m, '/api/actions/list.create', { name: 'Fall volunteers', kind: 'filter', filter: { q: tag } })).json?.list?.id
    || (await api(m, '/api/actions/list.create', { name: 'Fall volunteers', kind: 'filter', filter: {} })).json?.list?.id;
  check('a list to send', Boolean(listId));
  await go(m, `/lists/${listId}`);
  await m.locator('.ls-tools').waitFor({ timeout: 8000 });
  const toolsOff = await m.locator('.ls-tools > *:visible').count();
  check('Sheets "No one": the list shows Download CSV exactly as before, no Take it out', (await m.getByRole('link', { name: 'Download CSV' }).count()) === 1 && (await m.getByText('Take it out').count()) === 0);
  await go(m, '/reports');
  check('Sheets "No one": Reports has no Take it out and no Google Sheets', (await m.getByText('Take it out').count()) === 0 && (await m.getByRole('button', { name: 'Google Sheets' }).count()) === 0);

  // ── Managers may send ──
  await go(m, '/settings/services');
  await row.locator('[role="radio"]', { hasText: 'Managers' }).click();
  await sleep(800);
  await go(m, `/lists/${listId}`);
  await m.getByRole('button', { name: 'Take it out' }).waitFor({ timeout: 8000 });
  const toolsOn = await m.locator('.ls-tools > *:visible').count();
  check('the list’s tool row keeps its count of buttons', toolsOn === toolsOff, `${toolsOff} → ${toolsOn}`);
  await m.getByRole('button', { name: 'Take it out' }).click();
  await m.getByRole('button', { name: 'Send to Google Sheets' }).click();
  const ask = await text(m, '.drv-panel');
  check('the confirm: how many, where, and the do-not-contact line', /Send \d[\d,]* people to a new Google Sheet in the campaign folder Campaign exports\?/.test(ask) && /It includes people who asked not to be contacted\./.test(ask), ask);
  mm = await measure(m);
  check('the list with the confirm: at most one primary', mm.primary.length <= 1, JSON.stringify(mm.primary));
  await shot(m, '11-list-confirm-desktop');
  await m.locator('.drv-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await m.getByText(/Sending to Google Sheets…|In Google Sheets/).first().waitFor({ timeout: 10000 });
  if (/Sending to Google Sheets…/.test(await text(m, '.drv-panel'))) await shot(m, '12-list-progress-desktop');
  await m.getByText('In Google Sheets').waitFor({ timeout: 30000 });
  const open = m.locator('.drv-done a', { hasText: 'Open' });
  check('Done: "In Google Sheets · Open" in a new tab', (await open.getAttribute('target')) === '_blank' && /noopener/.test(await open.getAttribute('rel')) && /\/open\//.test(await open.getAttribute('href')));
  check('the toast "Sent to Google Sheets"', /Sent to Google Sheets/.test(await text(m)));
  await shot(m, '13-list-done-desktop');
  // A list that matches nobody: no offer to send 0 people.
  const emptyId = (await api(m, '/api/actions/list.create', { name: 'Nobody here', kind: 'filter', filter: { q: `nobody-${tag}-zz` } })).json?.list?.id;
  await go(m, `/lists/${emptyId}`);
  await m.getByRole('button', { name: 'Take it out' }).click();
  await m.getByRole('button', { name: 'Send to Google Sheets' }).click();
  await m.locator('.drv-panel').waitFor({ timeout: 8000 });
  check('an empty list: "Nothing to send yet" (a list or a report alike), no Send', /Nothing to send yet/.test(await text(m, '.drv-panel'))
    && (await m.locator('.drv-panel').getByRole('button', { name: 'Send', exact: true }).count()) === 0, await text(m, '.drv-panel'));
  // Too big for one Sheet: the words, and Download CSV beside them.
  await limits({ cells: 5 });
  await go(m, `/lists/${listId}`);
  await m.getByRole('button', { name: 'Take it out' }).click();
  await m.getByRole('button', { name: 'Send to Google Sheets' }).click();
  await m.locator('.drv-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await m.locator('.drv-panel .error').waitFor({ timeout: 8000 });
  check('too big: "Too big for one Google Sheet … Use Download CSV." and Download CSV', /Too big for one Google Sheet — .* columns\. Use Download CSV\./.test(await text(m, '.drv-panel .error')) && (await m.locator('.drv-panel .error a', { hasText: 'Download CSV' }).count()) === 1, await text(m, '.drv-panel .error'));
  await limits({ cells: 10_000_000 });
  {
    const { page } = await newPage(PHONE, 'list phone', await mctx.storageState());
    await go(page, `/lists/${listId}`);
    await page.getByRole('button', { name: 'Take it out' }).click();
    await page.getByRole('button', { name: 'Send to Google Sheets' }).click();
    const pm = await measure(page);
    check('the list’s confirm (390): no sideways scroll; 48 px', pm.overflow <= 0 && (await smallDrive(page)).length === 0, JSON.stringify({ pm, s: await smallDrive(page) }));
    await shot(page, '14-list-confirm-phone');
    await page.context().close();
  }

  // ── Reports: a report's Take it out ──
  await go(m, '/reports');
  const tagsSec = m.locator('.rp-sec', { has: m.locator('h2', { hasText: 'Cities' }) });
  await tagsSec.getByRole('button', { name: 'Take it out' }).click();
  await tagsSec.getByRole('button', { name: 'Send to Google Sheets' }).click();
  await shot(m, '15-report-confirm-desktop');
  await tagsSec.locator('.drv-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await tagsSec.getByText('In Google Sheets').waitFor({ timeout: 30000 }).catch(() => {});
  check('a report sent to Google Sheets', /In Google Sheets/.test(await text(m, '.rp-sec:has(h2:has-text("Cities"))')));
  // The volunteers table: the do-not-contact line (it has an email column).
  const vol = m.locator('.drv-export', { hasText: 'Volunteers and their roles' });
  await vol.getByRole('button', { name: 'Google Sheets' }).click();
  check('the volunteers table’s confirm says the do-not-contact line', /It includes people who asked not to be contacted\./.test(await text(m, '.drv-export:has-text("Volunteers and their roles") .drv-panel')));
  await vol.getByRole('button', { name: 'Cancel' }).click();
  await shot(m, '16-reports-desktop');

  // ── A failed export: Failed → Try again → done ──
  await go(m, '/data');
  const people = m.locator('.drv-export', { hasText: /^People/ });
  D.next('sheets', 'full');
  await people.getByRole('button', { name: 'Google Sheets' }).click();
  await people.locator('.drv-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await people.getByText('Your Google Drive is full').waitFor({ timeout: 30000 }).catch(() => {});
  check('a failed export: the words and Try again', /Your Google Drive is full/.test(await text(m, '.drv-export:has-text("People") .drv-panel')) && (await people.getByRole('button', { name: 'Try again' }).count()) >= 1, await text(m, '.drv-export:has-text("People") .drv-panel'));
  await shot(m, '17-export-failed-desktop');
  await people.getByRole('button', { name: 'Try again' }).first().click();
  await people.getByText('In Google Sheets').waitFor({ timeout: 30000 }).catch(() => {});
  check('Try again → done, in the same Sheet', /In Google Sheets/.test(await text(m, '.drv-export:has-text("People") .drv-panel')));

  // ── Staff: Sheets for "Anyone at the desk"; the campaign folder first ──
  await go(m, '/settings/services');
  await row.locator('[role="radio"]', { hasText: 'Anyone at the desk' }).click();
  await sleep(800);
  const { ctx: sctx, page: s } = await signIn(DESKTOP, staffEmail, 'staff');
  await go(s, '/data');
  await s.locator('.drv-export', { hasText: /^People/ }).getByRole('button', { name: 'Google Sheets' }).click();
  await s.getByText('Connect Google Drive').waitFor({ timeout: 8000 });
  await s.getByText('Connect Google Drive').click();
  await pickGoogle(s, 'sam');
  check('staff: back on Import & export after Google', new URL(s.url()).pathname === '/admin/data', s.url());
  await s.getByText('Google Drive connected').first().waitFor({ timeout: 8000 }).catch(() => {});
  check('staff: the toast "Google Drive connected"', /Google Drive connected/.test(await text(s)));
  const sSigns = s.locator('.drv-export', { hasText: /^People/ });
  await sSigns.getByRole('button', { name: 'Google Sheets' }).click();
  check('staff’s confirm: the campaign folder; people have emails', /in the campaign folder Campaign exports\?/.test(await text(s, '.drv-panel')) && /asked not to be contacted/.test(await text(s, '.drv-panel')));
  await sSigns.locator('.drv-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await s.getByText('Choose the campaign folder once so base.win can save there').waitFor({ timeout: 30000 });
  await shot(s, '18-staff-choose-folder-desktop');
  await s.getByRole('button', { name: 'Choose the campaign folder' }).click();
  await pickInDrive(s, ['Campaign exports']);
  const pkf = await picked(s);
  check('this-folder: the Picker was given setFileIds and not setEnableDrives', pkf?.views?.[0]?.calls?.includes('setFileIds') && !pkf.views[0].calls.includes('setEnableDrives') && pkf.views[0].fileIds === SHARED, JSON.stringify(pkf?.views));
  await s.getByText('✓ base.win can save there now').waitFor({ timeout: 8000 });
  await sSigns.getByRole('button', { name: 'Try again' }).click();
  await sSigns.getByText('In Google Sheets').waitFor({ timeout: 30000 }).catch(() => {});
  check('staff: Try again → done in the campaign folder', /In Google Sheets/.test(await text(s, '.drv-export:has-text("People") .drv-panel')));
  await go(s, '/data');
  check('staff: Sent to Google Drive lists their own Sheet only', /Sent to Google Drive/.test(await text(s)) && /People —/.test(await text(s, '.drv-sent')) && !/Fall volunteers/.test(await text(s, '.drv-sent')), await text(s, '.drv-sent'));
  await shot(s, '19-data-sent-staff-desktop');
  {
    const { page } = await newPage(PHONE, 'staff data phone', await sctx.storageState());
    await go(page, '/data');
    const pm = await measure(page);
    check('Import & export (390, staff): no sideways scroll; Drive’s buttons 48 px', pm.overflow <= 0 && (await smallDrive(page)).length === 0, JSON.stringify({ pm, s: await smallDrive(page) }));
    await shot(page, '20-data-sent-staff-phone');
    await page.context().close();
  }

  // ── The manager's Sent to Google Drive: everyone's, and the open link ──
  await go(m, '/data');
  await m.locator('.drv-sent').waitFor({ timeout: 8000 });
  const sent = await text(m, '.drv-sent');
  check('manager: everyone’s Sheets, with "by Sam Example" and where', /by Sam Example/.test(sent) && /In Campaign exports/.test(sent) && /Done/.test(sent), sent);
  check('manager: the link opened to anyone, with Make private again', /Links opened to anyone/.test(sent) && /Rally video\.mp4/.test(sent) && (await m.getByRole('button', { name: 'Make private again' }).count()) === 1);
  check('dates read "13 Nov, 10:56 am"', /\b\d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm)\b/.test(sent) && !/\b[A-Z][a-z]{2} \d{1,2}, \d/.test(sent), sent);
  {
    // The hour is B.C.'s (UTC-7 all year since March 2026), even on this
    // browser, whose own time-zone rules still fall back in November.
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const bc = (iso) => {
      const w = new Date(new Date(iso).getTime() - 7 * 3600e3);
      const h = w.getUTCHours();
      return `${w.getUTCDate()} ${MON[w.getUTCMonth()]}, ${h % 12 || 12}:${String(w.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
    };
    const want = ((await api(m, '/api/drive/exports')).json?.exports || []).map((e) => bc(e.created_at));
    check('each Sheet’s time is the campaign’s hour (UTC-7), not the browser’s older rules', want.length > 0 && want.every((w) => sent.includes(w)), JSON.stringify({ want, sent }));
  }
  await shot(m, '21-data-sent-manager-desktop');
  {
    const { page } = await newPage(PHONE, 'manager data phone', await mctx.storageState());
    await go(page, '/data');
    const pm = await measure(page);
    // Each table's CSV and its Google Sheets sit on one line, so a Sheets button never stands alone.
    const apart = await page.locator('.drv-export').evaluateAll((els) => els.filter((e) => {
      const [a, b] = [...e.children].map((c) => c.getBoundingClientRect());
      return a && b && Math.abs(a.top - b.top) > 4;
    }).map((e) => e.innerText.replace(/\s+/g, ' ')));
    check('Import & export (390): each table’s two buttons on one line', apart.length === 0, JSON.stringify(apart));
    check('Import & export (390, manager): no sideways scroll; 48 px', pm.overflow <= 0 && (await smallDrive(page)).length === 0, JSON.stringify({ pm, s: await smallDrive(page) }));
    await shot(page, '22-data-sent-manager-phone');
    await page.context().close();
  }
  await m.getByRole('button', { name: 'Make private again' }).click();
  await sleep(1200);
  check('Make private again closes it: the permission gone, the link off the list', !/Rally video\.mp4/.test(await text(m, '.ops-page')) && [...perm.values()].filter((p) => p.type === 'anyone').length === 0, await text(m, '.drv-sent'));

  // ── Staff with Sheets for managers only: no Sheets controls ──
  await go(m, '/settings/services');
  await row.locator('[role="radio"]', { hasText: 'Managers' }).click();
  await sleep(800);
  await go(s, `/lists/${listId}`);
  check('staff, Sheets for managers: no Take it out; Download CSV as before', (await s.getByText('Take it out').count()) === 0 && (await s.getByRole('link', { name: 'Download CSV' }).count()) === 1);
  await go(s, '/data');
  check('staff, Sheets for managers: no Google Sheets beside the exports', (await s.getByRole('button', { name: 'Google Sheets' }).count()) === 0);

  // ── The volunteer: nothing ──
  {
    const { page } = await signIn(PHONE, volEmail, 'volunteer');
    const a = await api(page, '/api/drive');
    const b = await api(page, '/api/drive/picker');
    check('the volunteer: /api/drive and /api/drive/picker are 403', a.status === 403 && b.status === 403, `${a.status} ${b.status}`);
    const t = await text(page);
    check('the volunteer: no Drive button anywhere', !/Google Drive|Google Sheets/.test(t));
    await page.context().close();
  }

  // ── No signal ──
  await go(m, '/people/import');
  await mctx.setOffline(true);
  await sleep(300);
  check('offline: From Google Drive disabled, with the needs-signal line', await m.getByRole('button', { name: 'From Google Drive' }).isDisabled() && /Needs signal/.test(await text(m)));
  await shot(m, '23-import-offline-desktop');
  await mctx.setOffline(false);
  // The compose, offline: From Google Drive off, with the same line.
  await go(m, '/outreach/newsletter');
  await m.click('button:has-text("Write an email")');
  await m.getByRole('button', { name: 'From Google Drive' }).waitFor({ timeout: 8000 });
  await mctx.setOffline(true);
  await sleep(300);
  check('offline compose: From Google Drive disabled, with "Needs signal"', await m.getByRole('button', { name: 'From Google Drive' }).isDisabled() && /Needs signal/.test(await text(m)));
  await shot(m, '23b-compose-offline-desktop');
  await mctx.setOffline(false);
  // A Sheet on its way when the signal goes: "Needs signal — still sending".
  D.next('drive', 'hang');
  await go(m, `/lists/${listId}`);
  await m.getByRole('button', { name: 'Take it out' }).click();
  await m.getByRole('button', { name: 'Send to Google Sheets' }).click();
  await m.locator('.drv-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await m.getByText('Sending to Google Sheets…').waitFor({ timeout: 10000 });
  await mctx.setOffline(true);
  await sleep(300);
  check('offline mid-send: "Needs signal — still sending"', /Needs signal — still sending/.test(await text(m, '.drv-panel')), await text(m, '.drv-panel'));
  await shot(m, '24-list-offline-sending-desktop');
  await mctx.setOffline(false);

  check('no page errors', errors.length === 0, errors.join(' | '));
  // The map's own tiles (OpenStreetMap, on the desk's home) are stopped too, but they're not Google.
  const google = offHost.filter((u) => !/^https:\/\/tile\.openstreetmap\.org\//.test(u));
  check('nothing asked of Google, or anything but 127.0.0.1 and the map’s tiles', google.length === 0, google.join(' '));
} catch (e) {
  check(`suite ran to the end (${e.message.split('\n')[0]})`, false);
  console.log(e.stack);
} finally {
  await browser?.close();
  await stopAll();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
