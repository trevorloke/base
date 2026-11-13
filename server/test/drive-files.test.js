// Google Drive and Sheets, stage 2 (server/ext/drive): reading a file
// someone picked (for People → Import), attaching a Drive file to an email
// or a release, and a link instead of a copy for a file too big to attach.
// Google is the fake (fake-google.js, fake-google-drive.js); nothing
// reaches Google.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { startFakeMail } from './fake-mail.js';
import { _resetPausesForTest } from '../lib/google/flow.js';
import { _resetTokensForTest } from '../lib/google/tokens.js';
import { _setPaceForTest } from '../ext/drive/sheets.js';
import { _resetPickerForTest } from '../ext/drive/picker.js';
import { _resetReadsForTest } from '../ext/drive/reads.js';
import { _setStreamForTest, STREAM } from '../ext/drive/stream.js';
import { acct, join, restoreEnv, signup, startGoogle, tag } from './google-helpers.js';

const DKEYS = ['GOOGLE_PICKER_KEY', 'GOOGLE_CLOUD_PROJECT_NUMBER', 'GOOGLE_DRIVE_API_BASE', 'GOOGLE_SHEETS_API_BASE', 'GOOGLE_PICKER_SCRIPT', 'RESEND_API_KEY', 'RESEND_API_BASE', 'MAIL_FROM', 'MAIL_PROVIDER'];
const dsaved = Object.fromEntries(DKEYS.map((k) => [k, process.env[k]]));
const WORK = 'campaign.example.org';
const A = Array.from({ length: 16 }, (_, i) => acct(i + 21, { email: `w${i + 21}.${tag}@${WORK}`, hd: WORK }));
const STREAM_AS_SHIPPED = { ...STREAM };
const DOC = 'application/vnd.google-apps.document';
const FORM = 'application/vnd.google-apps.form';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const FOLDER = 'application/vnd.google-apps.folder';
const MB = 1024 * 1024;
let fake, db, resend;
const D = () => fake.drive;

const driveEnv = () => Object.assign(process.env, {
  GOOGLE_PICKER_KEY: 'AIza-test-picker-key', GOOGLE_CLOUD_PROJECT_NUMBER: '123456789012',
  GOOGLE_DRIVE_API_BASE: fake.base, GOOGLE_SHEETS_API_BASE: fake.base, GOOGLE_PICKER_SCRIPT: `${fake.base}/picker.js`,
  RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, MAIL_FROM: 'Campaign <team@example.org>',
});
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const no = (r, status, words) => {
  assert.equal(r.status, status, JSON.stringify(r.json));
  if (words) assert.equal(r.json.error, words);
  return r.json;
};
const connect = async (b, sub) => {
  const r = await b.google(fake, { do: 'connect', for: 'drive', app: 'desk', back: '/admin/profile' }, sub);
  assert.equal(r.google, 'connected', JSON.stringify(r));
};
const events = async (ws, type) => (await db.query('select entity_id, op, payload from events where workspace_id = $1 and entity_type = $2 order by seq', [ws, type])).rows;
const picked = (spec, sub) => { const id = spec.tabs ? D().readable(spec) : D().file(spec); D().pick(id, sub); return id; };
const text = async (b, path) => { const res = await b.send('GET', path); return { status: res.status, res, body: res.status === 200 ? await res.text() : await res.json() }; };

let n = 0;
let acctAt = 0;
const nextAcct = () => { acctAt += 1; return A[acctAt - 1]; };
// A campaign with Drive on and its manager connected (a Workspace account).
const campaign = async () => {
  n += 1;
  const M = await signup(`Drive files ${n} ${tag}`, `dfm${n}.${tag}@example.org`);
  ok(await M.b.action('drive.settings', { on: true }));
  M.acct = nextAcct();
  await connect(M.b, M.acct.sub);
  return M;
};
const staffOf = async (M, name, perms) => {
  const S = await join(M.b, `${name}.${n}.${tag}@example.org`, 'staff', `${name} Example`);
  if (perms) ok(await M.b.action('permission.member.set', { user_id: S.id, ...perms }));
  S.acct = nextAcct();
  await connect(S.b, S.acct.sub);
  return S;
};

before(async () => {
  db = await freshDb();
  resend = await startFakeMail({ provider: 'resend' });
  fake = await startGoogle(A);
  driveEnv();
  _setPaceForTest(0);
});
beforeEach(() => {
  fake.clearKnobs(); D().clear(); resend.reset();
  _resetPausesForTest(); _resetTokensForTest(); _resetPickerForTest(); _resetReadsForTest();
  _setStreamForTest(STREAM_AS_SHIPPED);
  driveEnv();
});
after(async () => {
  D().clear();
  await fake.close();
  await resend.close();
  restoreEnv();
  for (const k of DKEYS) { if (dsaved[k] === undefined) delete process.env[k]; else process.env[k] = dsaved[k]; }
});

test('reads: a Sheet’s tabs, a tab as CSV in whole-row pages, a blank gap kept, quoted titles, the importer’s limits, six reads in 15 minutes', async () => {
  const M = await campaign();
  const sub = M.acct.sub;
  const big = [['Name', 'Phone', 'Code', 'Sum']];
  for (let i = 1; i < 12_000; i += 1) big.push([`Person ${i} Example`, '+1 604 555 0101', '00123', i === 1 ? '=SUM(A1)' : '']);
  const gap = [['Name'], ['Ann Example'], ['Bo Example'], ...Array.from({ length: 6000 }, () => []), ['After the gap']];
  const sheet = picked({
    name: 'Volunteers', tabs: [
      { title: 'Everyone', rows: big },
      { title: 'Old', rows: [['x']], hidden: true },
      { title: 'Don\'t call', rows: [['Name'], ['Cy Example']], rowCount: 5000 },
    ],
  }, sub);
  const gapSheet = picked({ name: 'Gap', tabs: [{ title: 'Gap', rows: gap, rowCount: 7000 }] }, sub);

  const meta = ok(await M.b.get(`/api/drive/files/${sheet}`));
  assert.deepEqual([meta.name, meta.kind, meta.bytes], ['Volunteers', 'sheet', null]);
  assert.deepEqual(meta.tabs.map((t) => [t.title, t.rows]), [['Everyone', 12_000], ['Don\'t call', 5000]], 'the hidden tab left out');

  D().clear();
  const csv = await text(M.b, `/api/drive/files/${sheet}/tabs/0.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.res.headers.get('content-type'), /^text\/csv/);
  assert.equal(csv.res.headers.get('cache-control'), 'no-store');
  assert.notEqual(csv.body.charCodeAt(0), 0xfeff, 'no BOM');
  const lines = csv.body.split('\r\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length - 1, 12_000);
  assert.equal(lines[0], 'Name,Phone,Code,Sum');
  assert.equal(lines[1], 'Person 1 Example,+1 604 555 0101,00123,=SUM(A1)', 'no apostrophe; the formula stays text');
  const ranges = D().calls.filter((c) => c.api === 'sheets' && c.path.includes('/values/')).map((c) => c.path.split('/values/')[1]);
  assert.deepEqual(ranges, ['\'Everyone\'!1:5000', '\'Everyone\'!5001:10000', '\'Everyone\'!10001:12000'], 'three whole-row calls');
  assert.ok(D().calls.filter((c) => c.path.includes('/values/')).every((c) => c.query.valueRenderOption === 'FORMATTED_VALUE' && c.query.majorDimension === 'ROWS'));

  const g = await text(M.b, `/api/drive/files/${gapSheet}/tabs/0.csv`);
  const gl = g.body.split('\r\n');
  assert.equal(gl.length - 1, 6004, 'the rows after a 6,000-row gap are kept; the blank rows after the last are not');
  assert.equal(gl[6003], 'After the gap');

  D().clear();
  const q = await text(M.b, `/api/drive/files/${sheet}/tabs/1002.csv`);
  assert.equal(q.body, 'Name\r\nCy Example\r\n');
  assert.equal(D().calls.find((c) => c.path.includes('/values/')).path.split('/values/')[1], '\'Don\'\'t call\'!1:5000');

  // The importer's own limits, before any download.
  D().clear();
  const huge = picked({ name: 'everyone.csv', mimeType: 'text/csv', size: 400 * MB }, sub);
  no(await M.b.get(`/api/drive/files/${huge}/content`), 413, 'That file is over 300 MB. Split it into parts and import them one at a time.');
  const pdf = picked({ name: 'flyer.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF') }, sub);
  no(await M.b.get(`/api/drive/files/${pdf}/content`), 415, 'Pick a Google Sheet, a CSV or an Excel file');
  assert.equal(D().streams.opened, 0, 'nothing downloaded');
  const notPicked = D().file({ name: 'secret.csv', mimeType: 'text/csv', data: Buffer.from('a') });
  no(await M.b.get(`/api/drive/files/${notPicked}`), 404, 'base.win can only open files you pick — pick it again.');
  no(await M.b.get('/api/drive/files/short'), 404);

  const bytes = Buffer.from('PK\u0003\u0004 a pretend spreadsheet');
  const xlsx = picked({ name: 'donors.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: bytes }, sub);
  assert.equal(ok(await M.b.get(`/api/drive/files/${xlsx}`)).kind, 'xlsx');
  const got = await M.b.send('GET', `/api/drive/files/${xlsx}/content`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-length'), String(bytes.length), 'the screen can show how much has come');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
  // Six reads (three tabs, the 413, the 415, the .xlsx): the seventh waits.
  no(await M.b.get(`/api/drive/files/${xlsx}/content`), 429);
});

test('reads, bounded: one open read at a time; a download that stalls or never starts ends inside the limits', async () => {
  const M = await campaign();
  const S = await staffOf(M, 'rea');
  _setStreamForTest({ firstMs: 400, idleMs: 400 });
  const csv = picked({ name: 'big.csv', mimeType: 'text/csv', data: Buffer.alloc(1 * MB, 97) }, S.acct.sub);

  D().next('drive', 'none'); // the metadata read
  D().next('drive', 'stall'); // the download: 64 KB, then nothing
  const res = await S.b.send('GET', `/api/drive/files/${csv}/content`);
  assert.equal(res.status, 200);
  no(await S.b.get(`/api/drive/files/${csv}/content`), 409, 'Already reading one from Google Drive');
  const t0 = Date.now();
  await assert.rejects(res.arrayBuffer());
  assert.ok(Date.now() - t0 < 3000, 'ended by the idle limit');
  await new Promise((r) => { setTimeout(r, 100); });
  assert.equal(D().streams.cut, 1, 'Google’s stream let go');

  // Never starts: the first-byte limit.
  D().next('drive', 'none');
  D().next('drive', 'hang');
  const t1 = Date.now();
  const hung = await S.b.get(`/api/drive/files/${csv}/content`);
  no(hung, 504, 'Google Drive stopped sending — Try again');
  assert.ok(Date.now() - t1 < 3000);
  D().clear(); // let the hanging answer go, then forget the pause it leaves
  await new Promise((r) => { setTimeout(r, 100); });
  _resetTokensForTest();

  const whole = await S.b.send('GET', `/api/drive/files/${csv}/content`);
  assert.equal(whole.status, 200, 'the open read was let go each time');
  assert.equal((await whole.arrayBuffer()).byteLength, MB);
});

test('attach from Drive: a Doc as PDF, a picture as itself, too big offers a link, the wrong kinds refused, areas by prefix, it goes with a release', async () => {
  const M = await campaign();
  const sub = M.acct.sub;
  const doc = picked({ name: 'Platform', mimeType: DOC }, sub);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const pic = picked({ name: 'rally', mimeType: 'image/png', data: png }, sub);

  const a = ok(await M.b.action('blast.attach.drive', { file_id: doc })).attachment;
  assert.equal(a.filename, 'Platform.pdf');
  const row = (await db.query('select content_type, data from blast_attachments where id = $1', [a.id])).rows[0];
  assert.equal(row.content_type, 'application/pdf');
  assert.match(Buffer.from(row.data).toString(), /^%PDF-1\.4\n% a fake PDF of Platform/);
  assert.ok(D().calls.some((c) => c.path.endsWith('/export') && c.query.mimeType === 'application/pdf'));
  const p = ok(await M.b.action('blast.attach.drive', { file_id: pic })).attachment;
  assert.equal(p.filename, 'rally.png', 'a name without an extension gets one from its type');
  assert.deepEqual(Buffer.from((await db.query('select data from blast_attachments where id = $1', [p.id])).rows[0].data), png);
  const ev = (await events(M.ws, 'blast_attachment')).filter((e) => e.op === 'create');
  assert.deepEqual(ev.map((e) => e.payload), [{ id: a.id, filename: 'Platform.pdf', bytes: a.bytes, from: 'drive' }, { id: p.id, filename: 'rally.png', bytes: p.bytes, from: 'drive' }]);
  assert.ok(!JSON.stringify(ev).includes(doc), 'no Drive id in the event');

  // Too big: by Drive's size (nothing downloaded), or cut off at 5 MB.
  D().clear();
  const video = picked({ name: 'rally.mp4', mimeType: 'video/mp4', size: 24 * MB }, sub);
  const big = no(await M.b.action('blast.attach.drive', { file_id: video }), 409, 'rally.mp4 is 24 MB — too big to attach (5 MB at most)');
  assert.equal(big.link, true);
  const quiet = picked({ name: 'report.pdf', mimeType: 'application/pdf', data: Buffer.alloc(40 * MB, 1), hideSize: true }, sub);
  const cut = no(await M.b.action('blast.attach.drive', { file_id: quiet }), 409, 'report.pdf is over 5 MB — too big to attach (5 MB at most)');
  assert.equal(cut.link, true);
  await new Promise((r) => { setTimeout(r, 100); });
  assert.deepEqual([D().streams.opened, D().streams.cut], [1, 1], 'the download stopped at 5 MB');
  const bigDoc = picked({ name: 'Plan', mimeType: DOC }, sub);
  D().next('drive', 'none'); D().next('drive', 'exportTooBig'); // the metadata read, then the export
  const bd = no(await M.b.action('blast.attach.drive', { file_id: bigDoc }), 409);
  assert.equal(bd.link, false, 'a Google file too big as a PDF: no link');

  const exe = picked({ name: 'setup.exe', mimeType: 'application/x-msdownload', data: Buffer.from('MZ') }, sub);
  assert.match(no(await M.b.action('blast.attach.drive', { file_id: exe }), 409).error, /^use a PDF, a picture/);
  const folder = D().folder({ name: 'Stuff' }); D().pick(folder, sub);
  assert.match(no(await M.b.action('blast.attach.drive', { file_id: folder }), 409).error, /^use a PDF, a picture/);
  const form = picked({ name: 'Survey', mimeType: FORM }, sub);
  assert.match(no(await M.b.action('blast.attach.drive', { file_id: form }), 409).error, /^use a PDF, a picture/);
  no(await M.b.action('blast.attach.drive', { file_id: D().file({ name: 'x.pdf', mimeType: 'application/pdf', data: Buffer.from('x') }) }), 404, 'base.win can only open files you pick — pick it again.');

  // Staff denied Outreach but holding Media: Media's only.
  const S = await staffOf(M, 'med', { grant: ['media'], deny: ['outreach'] });
  const sdoc = picked({ name: 'Release notes', mimeType: DOC }, S.acct.sub);
  assert.equal((await S.b.action('blast.attach.drive', { file_id: sdoc })).status, 403);
  const sa = ok(await S.b.action('media.attach.drive', { file_id: sdoc })).attachment;
  assert.equal(sa.filename, 'Release notes.pdf');
  ok(await S.b.action('media.unattach', { id: sa.id }), '✕ takes it back the same way');
  const again = ok(await S.b.action('media.attach.drive', { file_id: sdoc })).attachment;
  resend.reset();
  const t = ok(await S.b.action('media.test', { subject: 'Draft', body: 'News', attachment_ids: [again.id] }));
  assert.equal(t.sent, true);
  const files = resend.sent.at(-1).body.attachments;
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'Release notes.pdf');
  assert.match(Buffer.from(files[0].content, 'base64').toString(), /^%PDF/);
});

test('a link instead: for the people it’s shared with, or anyone (never a base.win Sheet, a folder or a Google Sheet); made private again by its opener only', async () => {
  const M = await campaign();
  const sub = M.acct.sub;
  const video = picked({ name: 'rally.mp4', mimeType: 'video/mp4', size: 24 * MB }, sub);

  const shared = ok(await M.b.action('blast.link.drive', { file_id: video, anyone: false }));
  assert.deepEqual(shared, { name: 'rally.mp4', url: `${fake.base}/open/${video}`, anyone: false, seq: shared.seq });
  assert.equal(D().files.get(video).permissions, undefined, 'nothing changed at Google');
  assert.equal((await db.query('select count(*)::int as n from drive_links where workspace_id = $1', [M.ws])).rows[0].n, 0);

  D().clear();
  const open = ok(await M.b.action('blast.link.drive', { file_id: video, anyone: true }));
  assert.equal(open.anyone, true);
  const perm = D().calls.find((c) => c.path.endsWith('/permissions') && c.method === 'POST');
  assert.deepEqual(perm.body, { type: 'anyone', role: 'reader' });
  assert.equal(perm.query.sendNotificationEmail, undefined);
  assert.equal(perm.query.supportsAllDrives, 'true');
  const [pid] = [...D().files.get(video).permissions.keys()];
  const link = (await db.query('select * from drive_links where workspace_id = $1', [M.ws])).rows[0];
  assert.deepEqual([link.file_id, link.permission_id, link.name, link.closed_at], [video, pid, 'rally.mp4', null]);
  const ev = await events(M.ws, 'drive_link');
  assert.deepEqual(ev.map((e) => [e.entity_id, e.op, e.payload]), [[link.id, 'create', { name: 'rally.mp4', anyone: true }]]);
  assert.ok(!JSON.stringify(ev).includes(video) && !JSON.stringify(ev).includes('/open/'), 'no Drive id or link in the event');
  const listed = ok(await M.b.get('/api/drive/links')).links;
  assert.deepEqual(listed.map((l) => [l.id, l.name, l.mine, l.left]), [[link.id, 'rally.mp4', true, false]]);

  // Never "anyone" for a Sheet base.win made (no Google call at all), a folder or a Google Sheet.
  const made = picked({ name: 'Export', mimeType: SHEET }, sub);
  await db.query(
    `insert into drive_exports (id, workspace_id, user_id, client_key, source, ref, name, rows, cols, land, status, file_id)
     values ($1, $2, $3, $4, 'dataset', 'people', 'People', 1, 1, 'mine', 'done', $5)`,
    [randomUUID(), M.ws, M.id, randomUUID(), made],
  );
  D().clear();
  no(await M.b.action('blast.link.drive', { file_id: made, anyone: true }), 409, 'Sheets base.win made stay private — share them in Drive if you must');
  assert.equal(D().calls.length, 0, 'Google not asked');
  const folder = D().folder({ name: 'Stuff' }); D().pick(folder, sub);
  no(await M.b.action('blast.link.drive', { file_id: folder, anyone: true }), 409, 'Only single files can be opened to anyone');
  const gsheet = picked({ name: 'Budget', mimeType: SHEET }, sub);
  no(await M.b.action('blast.link.drive', { file_id: gsheet, anyone: true }), 409, 'Only single files can be opened to anyone');
  const doc = picked({ name: 'Notes.pdf', mimeType: 'application/pdf', size: 9 * MB }, sub);
  D().next('drive', 'none'); D().next('drive', 'shareRefused');
  no(await M.b.action('blast.link.drive', { file_id: doc, anyone: true }), 409, 'Google wouldn’t open this file to anyone with the link. Share it in Drive, or ask your Google admin.');

  // Staff denied Outreach: Media's link only. A manager can't close it.
  const S = await staffOf(M, 'lnk', { grant: ['media'], deny: ['outreach'] });
  const sv = picked({ name: 'speech.mov', mimeType: 'video/quicktime', size: 30 * MB }, S.acct.sub);
  assert.equal((await S.b.action('blast.link.drive', { file_id: sv, anyone: true })).status, 403);
  ok(await S.b.action('media.link.drive', { file_id: sv, anyone: true }));
  const theirs = (await db.query('select id from drive_links where user_id = $1', [S.id])).rows[0].id;
  assert.deepEqual(ok(await S.b.get('/api/drive/links')).links.map((l) => l.id), [theirs], 'staff see their own');
  assert.equal(ok(await M.b.get('/api/drive/links')).links.length, 2, 'managers see everyone’s');
  no(await M.b.action('drive.link.close', { id: theirs }), 403, 'Only lnk Example can make this private — or change it in Drive');

  // Make private again: the stored permission, deleted; closed.
  D().clear();
  ok(await M.b.action('drive.link.close', { id: link.id }));
  const del = D().calls.find((c) => c.method === 'DELETE');
  assert.equal(del.path, `/drive/v3/files/${video}/permissions/${pid}`);
  assert.equal(D().files.get(video).permissions.size, 0);
  const closed = (await db.query('select closed_at, closed_by from drive_links where id = $1', [link.id])).rows[0];
  assert.ok(closed.closed_at);
  assert.equal(closed.closed_by, M.id);
  assert.deepEqual((await events(M.ws, 'drive_link')).at(-1).payload, { closed: true });
  no(await M.b.action('drive.link.close', { id: link.id }), 409, 'It’s already private');
  assert.deepEqual(ok(await M.b.get('/api/drive/links')).links.map((l) => l.id), [theirs]);
});

test('attach, link and reads are for the desk: a volunteer granted Outreach, Media and Data gets nothing, and Google sees nothing', async () => {
  const M = await campaign();
  const V = await join(M.b, `vol.df.${tag}@example.org`, 'volunteer', 'Vic Example');
  ok(await M.b.action('permission.member.set', { user_id: V.id, grant: ['outreach', 'media', 'data'], deny: [] }));
  const f = picked({ name: 'a.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF') }, M.acct.sub);
  D().clear();
  for (const name of ['blast.attach.drive', 'media.attach.drive', 'blast.link.drive', 'media.link.drive']) {
    no(await V.b.action(name, { file_id: f, anyone: true }), 403, 'Google Drive is for the desk');
  }
  no(await V.b.action('drive.link.close', { id: randomUUID() }), 403, 'Google Drive is for the desk');
  for (const path of [`/api/drive/files/${f}`, `/api/drive/files/${f}/content`, `/api/drive/files/${f}/tabs/0.csv`, '/api/drive/links']) {
    assert.equal((await V.b.get(path)).status, 403, path);
  }
  assert.equal(D().calls.length, 0);
  // Drive switched off: the same reads say so.
  ok(await M.b.action('drive.settings', { on: false }));
  no(await M.b.get(`/api/drive/files/${f}`), 409, 'Google Drive is off for this campaign');
  no(await M.b.action('blast.attach.drive', { file_id: f }), 409, 'Google Drive is off for this campaign');
});
