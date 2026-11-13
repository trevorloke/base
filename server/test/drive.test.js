// Google Drive and Sheets, stage 1 (server/ext/drive): the one permission,
// the campaign's switches, who may use it, the Picker's narrowed token,
// where Sheets land, and "Send to Google Sheets" — a job, one part at a
// time, that never writes a row twice. Google is the fake
// (fake-google.js, fake-google-drive.js); nothing reaches Google.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { ACTIONS } from '../actions/index.js';
import { areaOfAction } from '../lib/perms.js';
import { MAX_ATTEMPTS, runDueJobs } from '../lib/jobs.js';
import { definePurpose } from '../lib/google/purposes.js';
import { _resetPausesForTest } from '../lib/google/flow.js';
import { _resetTokensForTest } from '../lib/google/tokens.js';
import { MAX_ATTEMPTS as EXPORT_MAX } from '../lib/jobs.js';
import { _setLimitsForTest, LIMITS } from '../ext/drive/export.js';
import { _setPaceForTest } from '../ext/drive/sheets.js';
import { _resetPickerForTest } from '../ext/drive/picker.js';
import { Browser, acct, join, restoreEnv, signup, startGoogle, tag } from './google-helpers.js';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const GMAIL = 'https://www.googleapis.com/auth/gmail.send';
definePurpose('test.gmailish', { label: 'Test Gmail', scopes: [GMAIL], roles: ['manager', 'treasurer', 'staff'], area: null });

const DKEYS = ['GOOGLE_PICKER_KEY', 'GOOGLE_CLOUD_PROJECT_NUMBER', 'GOOGLE_DRIVE_API_BASE', 'GOOGLE_SHEETS_API_BASE', 'GOOGLE_PICKER_SCRIPT'];
const dsaved = Object.fromEntries(DKEYS.map((k) => [k, process.env[k]]));
const WORK = 'campaign.example.org';
const A = Array.from({ length: 12 }, (_, i) => acct(i + 1));
A[0] = acct(1, { email: `mo.${tag}@${WORK}`, hd: WORK });
A[2] = acct(3, { email: `tia.${tag}@${WORK}`, hd: WORK });
A[4] = acct(5, { email: `una.${tag}@${WORK}`, hd: WORK });
A[6] = acct(7, { email: `vi.${tag}@${WORK}`, hd: WORK });
let fake, db;
const D = () => fake.drive;

const driveEnv = (on = true) => {
  if (!on) { for (const k of DKEYS) delete process.env[k]; return; }
  Object.assign(process.env, {
    GOOGLE_PICKER_KEY: 'AIza-test-picker-key', GOOGLE_CLOUD_PROJECT_NUMBER: '123456789012',
    GOOGLE_DRIVE_API_BASE: fake.base, GOOGLE_SHEETS_API_BASE: fake.base, GOOGLE_PICKER_SCRIPT: `${fake.base}/picker.js`,
  });
};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const no = (r, status, words) => {
  assert.equal(r.status, status, JSON.stringify(r.json));
  if (words) assert.equal(r.json.error, words);
};
const connect = async (b, sub, purpose = 'drive') => {
  const r = await b.google(fake, { do: 'connect', for: purpose, app: 'desk', back: '/admin/profile' }, sub);
  assert.equal(r.google, 'connected', JSON.stringify(r));
};
const drain = async (ws, max = 30) => {
  for (let i = 0; i < max; i += 1) {
    const r = await runDueJobs(db, { workspaceId: ws });
    if (!r.ran && !r.failed) return;
  }
};
// Every part to the end, even on a slow machine (a call over googleFetch's
// 10 s is a counted try: brought forward and run again), and even while the
// server's own runner (runJobsSoon, after drive.export) holds a part.
const finish = async (ws) => {
  for (let i = 0, tries = 0; i < 600 && tries < 8; i += 1) {
    await drain(ws);
    const left = (await db.query(`select status from jobs where workspace_id = $1 and status in ('pending', 'running')`, [ws])).rows;
    if (!left.length) return;
    if (left.some((r) => r.status === 'pending')) { tries += 1; await due(ws); } else await new Promise((r) => { setTimeout(r, 100); });
  }
};
// A job handed back or tried again later: due now (and Google's 30 s pause over).
const due = async (ws) => {
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and status = 'pending'`, [ws]);
  _resetTokensForTest();
};
const exportRow = async (id) => (await db.query('select * from drive_exports where id = $1', [id])).rows[0];
const jobKeys = async (ws) => (await db.query(`select key from jobs where workspace_id = $1 and kind = 'drive.export' order by created_at, key`, [ws])).rows.map((r) => r.key);
const events = async (ws, type) => (await db.query('select action, op, payload from events where workspace_id = $1 and entity_type = $2 order by seq', [ws, type])).rows;
const people = async (ws, n, { tag: t = 'bulk', from = 0 } = {}) => {
  await db.query(
    `insert into persons (id, workspace_id, name, phone, tags)
     select md5($1 || ':' || i)::uuid, $1::uuid, 'Person ' || lpad(i::text, 7, '0') || ' Example', '604-555-01' || lpad((i % 100)::text, 2, '0'), $3::jsonb
     from generate_series($2::int + 1, $2::int + $4::int) i`,
    [ws, from, JSON.stringify([t]), n],
  );
};
const listOf = async (b, name, t = 'bulk') => ok(await b.action('list.create', { name, kind: 'filter', filter: { tag: t } })).list.id;
const send = (b, source, ref, key = randomUUID()) => b.action('drive.export', { source, ref, client_key: key });

// A campaign with Drive on: a manager connected with a Workspace account.
let n = 0;
const campaign = async ({ sheets = 'managers', mgrAcct = A[0] } = {}) => {
  n += 1;
  const M = await signup(`Drive ${n} ${tag}`, `mgr${n}.${tag}@example.org`);
  ok(await M.b.action('drive.settings', { on: true }));
  if (sheets !== 'off') ok(await M.b.action('drive.settings', { sheets }));
  await connect(M.b, mgrAcct.sub);
  return M;
};

before(async () => {
  db = await freshDb();
  fake = await startGoogle(A);
  driveEnv();
  _setPaceForTest(0);
});
beforeEach(() => {
  fake.clearKnobs(); D().clear(); fake.setNarrow(true);
  _resetPausesForTest(); _resetTokensForTest(); _resetPickerForTest();
  _setLimitsForTest({ cells: 10_000_000, sliceMs: 20_000, pageRows: 2000 });
  driveEnv();
});
after(async () => {
  await fake.close();
  restoreEnv();
  for (const k of DKEYS) { if (dsaved[k] === undefined) delete process.env[k]; else process.env[k] = dsaved[k]; }
});

test('setup: nothing set says so everywhere; set up but off draws nothing; test addresses ignored in production', async () => {
  const M = await signup(`Drive setup ${tag}`, `setup.${tag}@example.org`);
  driveEnv(false);
  assert.equal(ok(await M.b.get('/api/integrations')).drive, false);
  assert.equal(ok(await M.b.get('/api/drive')).setup, false);
  assert.deepEqual(ok(await M.b.get('/api/drive/picker')), { ready: false });
  no(await M.b.action('drive.settings', { on: true }), 409, 'Google Drive isn’t set up — see Settings → Services');
  no(await send(M.b, 'dataset', 'people'), 409, 'Google Drive isn’t set up — see Settings → Services');
  no(await M.b.action('drive.folder', { file_id: 'abc' }), 409, 'Google Drive isn’t set up — see Settings → Services');
  const row = ok(await M.b.get('/api/connections')).services.find((s) => s.key === 'drive');
  assert.deepEqual(row.missing, ['GOOGLE_PICKER_KEY', 'GOOGLE_CLOUD_PROJECT_NUMBER']);
  assert.equal(row.state, 'missing');
  const keep = process.env.GOOGLE_TOKEN_KEY;
  delete process.env.GOOGLE_TOKEN_KEY;
  try {
    const r2 = ok(await M.b.get('/api/connections')).services.find((s) => s.key === 'drive');
    assert.match(r2.detail, /^Set up Google sign-in and connections first/);
  } finally { process.env.GOOGLE_TOKEN_KEY = keep; }
  const g = ok(await M.b.get('/api/connections')).services.findIndex((s) => s.key === 'google');
  assert.equal(ok(await M.b.get('/api/connections')).services[g + 1].key, 'drive', 'right after Google’s row');

  driveEnv();
  assert.equal(ok(await M.b.get('/api/integrations')).drive, true);
  const d = ok(await M.b.get('/api/drive'));
  assert.deepEqual([d.setup, d.on, d.sheets, d.canSend], [true, false, 'off', false]);
  no(await send(M.b, 'dataset', 'people'), 409, 'Google Drive is off for this campaign');
  assert.equal(ok(await M.b.get('/api/connections')).services.find((s) => s.key === 'drive').state, 'ready');

  const { driveBase, sheetsBase, pickerScript } = await import('../ext/drive/config.js');
  process.env.NODE_ENV = 'production';
  try {
    assert.deepEqual([driveBase(), sheetsBase(), pickerScript()], ['https://www.googleapis.com', 'https://sheets.googleapis.com', 'https://apis.google.com/js/api.js']);
  } finally { delete process.env.NODE_ENV; }
  assert.equal(driveBase(), fake.base);
});

test('scope: connecting Drive asks for exactly openid, email and drive.file', async () => {
  const M = await signup(`Drive scope ${tag}`, `scope.${tag}@example.org`);
  const start = await M.b.send('GET', `/api/auth/google/start?${new URLSearchParams({ do: 'connect', for: 'drive', app: 'desk', back: '/admin/profile' })}`);
  const at = new URL(start.headers.get('location'));
  assert.equal(at.searchParams.get('scope'), `openid email ${DRIVE_FILE}`);
});

test('roles: a volunteer granted Outreach, Media and Data, and a demoted member who still has a grant, get nothing and Google sees nothing', async () => {
  const M = await campaign();
  const V = await join(M.b, `vol.${tag}@example.org`, 'volunteer', 'Vic Example');
  ok(await M.b.action('permission.member.set', { user_id: V.id, grant: ['outreach', 'media', 'data', 'admin'], deny: [] }));
  const S = await join(M.b, `dem.${tag}@example.org`, 'staff', 'Dee Example');
  await connect(S.b, A[2].sub);
  ok(await M.b.action('member.setRole', { user_id: S.id, role: 'volunteer' }));
  // GSI's hook dropped the purpose; put a stored grant back as if it hadn't.
  await db.query(`update google_grants set purposes = array['drive'] where user_id = $1`, [S.id]);
  if (!(await db.query('select 1 from google_grants where user_id = $1', [S.id])).rows[0]) {
    const m = (await db.query('select * from google_grants where user_id = $1', [M.id])).rows[0];
    await db.query(
      `insert into google_grants (id, user_id, sub, email, hd, scopes, purposes, refresh_sealed) values ($1, $2, $3, $4, $5, $6, array['drive'], $7)`,
      [randomUUID(), S.id, A[2].sub, A[2].email, WORK, m.scopes, m.refresh_sealed],
    );
  }
  D().clear();
  const before = fake.counts.refresh;
  for (const who of [V, S]) {
    for (const [name, input] of [
      ['drive.export', { source: 'dataset', ref: 'people', client_key: randomUUID() }],
      ['drive.export.retry', { id: randomUUID() }],
      ['drive.folder.reach', { file_id: 'abc' }],
      ['drive.settings', { on: false }],
      ['drive.folder', { file_id: null }],
      ['blast.attach.drive', { file_id: 'abcdefghijkl' }],
      ['media.attach.drive', { file_id: 'abcdefghijkl' }],
      ['blast.link.drive', { file_id: 'abcdefghijkl', anyone: true }],
      ['media.link.drive', { file_id: 'abcdefghijkl', anyone: true }],
      ['drive.link.close', { id: randomUUID() }],
    ]) {
      const r = await who.b.action(name, input);
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.json)}`);
      if (!['drive.settings', 'drive.folder'].includes(name) || who === V) assert.equal(r.json.error, 'Google Drive is for the desk', name);
    }
    for (const path of ['/api/drive', '/api/drive/picker', '/api/drive/exports', `/api/drive/exports/${randomUUID()}`, '/api/drive/links',
      '/api/drive/files/abcdefghijkl', '/api/drive/files/abcdefghijkl/content', '/api/drive/files/abcdefghijkl/tabs/0.csv']) {
      assert.equal((await who.b.get(path)).status, 403, path);
    }
  }
  assert.equal(D().calls.length, 0, 'no Drive or Sheets call');
  assert.equal(fake.counts.refresh, before, 'no token asked for');
});

test('permissions: every drive.* and *.drive action’s area is as planned — Outreach and Media by prefix; the switches are Admin', () => {
  const names = Object.keys(ACTIONS).filter((k) => k.startsWith('drive.') || k.endsWith('.drive'));
  assert.deepEqual(names.sort(), [
    'blast.attach.drive', 'blast.link.drive', 'drive.export', 'drive.export.retry', 'drive.folder', 'drive.folder.reach',
    'drive.link.close', 'drive.settings', 'media.attach.drive', 'media.link.drive',
  ]);
  const area = { blast: 'outreach', media: 'media', drive: null };
  for (const k of names) assert.equal(areaOfAction(k), area[k.split('.')[0]], k);
  for (const k of names) assert.ok(!ACTIONS[k].area, `${k}: its area from its prefix, none of its own`);
  assert.deepEqual(ACTIONS['drive.settings'].roles, ['manager']);
  assert.deepEqual(ACTIONS['drive.folder'].roles, ['manager']);
  assert.ok(!ACTIONS['drive.settings'].area && !ACTIONS['drive.folder'].area, 'manager-only with no area: Admin');
});

test('the Picker’s token: narrowed to Drive, kept an hour, never stored; not narrowed or refused → off; 31 in 15 minutes → 429', async () => {
  const M = await campaign();
  const logs = [];
  const log = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await connect(M.b, A[0].sub, 'test.gmailish'); // the grant now holds Gmail too
    const refreshes = fake.counts.refresh;
    const p = ok(await M.b.get('/api/drive/picker'));
    assert.deepEqual([p.ready, p.apiKey, p.appId, p.script, p.email], [true, 'AIza-test-picker-key', '123456789012', `${fake.base}/picker.js`, A[0].email]);
    assert.ok(p.token && p.expiresAt);
    assert.equal(fake.counts.refresh, refreshes + 1);
    const again = ok(await M.b.get('/api/drive/picker'));
    assert.equal(again.token, p.token);
    assert.equal(fake.counts.refresh, refreshes + 1, 'no second Google call within the hour');
    for (const t of ['google_grants', 'drive_exports']) {
      const dump = JSON.stringify((await db.query(`select * from ${t}`)).rows);
      assert.ok(!dump.includes(p.token), t);
    }
    assert.ok(!JSON.stringify((await db.query('select payload from events')).rows).includes(p.token), 'no event');
    assert.ok(logs.some((l) => l === 'drive: picker tokens are narrowed'));
    assert.ok(!logs.some((l) => l.includes(p.token)), 'no log line');

    for (const mode of [false, 'refuse']) {
      _resetTokensForTest(); _resetPickerForTest(); logs.length = 0;
      fake.setNarrow(mode);
      const u = ok(await M.b.get('/api/drive/picker'));
      assert.deepEqual([u.ready, u.unsafe, u.token], [true, true, undefined], String(mode));
      await M.b.get('/api/drive/picker');
      assert.equal(logs.filter((l) => l === 'drive: Google did not narrow the Picker token — the Picker is off').length, 1);
    }
  } finally { console.log = log; }

  // Someone holding only drive.file: nothing to narrow away.
  const S = await join(M.b, `pick.${tag}@example.org`, 'staff', 'Pat Example');
  await connect(S.b, A[2].sub);
  fake.setNarrow(false);
  assert.ok(ok(await S.b.get('/api/drive/picker')).token);
  let last;
  for (let i = 0; i < 30; i += 1) last = await S.b.get('/api/drive/picker');
  assert.equal(last.status, 429);
});

test('the Sheets switch and where Sheets land: off by default; "desk" needs a shared-drive folder; personal accounts never hold an export', async () => {
  const M = await signup(`Drive switch ${tag}`, `switch.${tag}@example.org`);
  ok(await M.b.action('drive.settings', { on: true }));
  await connect(M.b, A[0].sub);
  await people(M.ws, 3);
  const list = await listOf(M.b, 'Three');
  assert.equal(ok(await M.b.get('/api/drive')).sheets, 'off');
  no(await send(M.b, 'list', list), 403, 'Google Sheets is off for this campaign');
  no(await M.b.action('drive.settings', { sheets: 'desk' }), 409, 'Pick a shared-drive folder first, so staff Sheets stay with the campaign');
  ok(await M.b.action('drive.settings', { sheets: 'managers' }));

  // Only a folder; a shared-drive folder allows "desk"; clearing it then is refused.
  const doc = D().file({ name: 'Notes', mimeType: 'application/vnd.google-apps.document' });
  D().pick(doc, A[0].sub);
  no(await M.b.action('drive.folder', { file_id: doc }), 409, 'Pick a folder');
  const mine = D().folder({ name: 'My folder' });
  D().pick(mine, A[0].sub);
  assert.deepEqual(ok(await M.b.action('drive.folder', { file_id: mine })).folder, { id: mine, name: 'My folder', shared: false });
  no(await M.b.action('drive.settings', { sheets: 'desk' }), 409, 'Pick a shared-drive folder first, so staff Sheets stay with the campaign');
  const shared = D().folder({ name: 'Campaign exports', driveId: '0AShared' });
  D().pick(shared, A[0].sub);
  ok(await M.b.action('drive.folder', { file_id: shared }));
  ok(await M.b.action('drive.settings', { sheets: 'desk' }));
  no(await M.b.action('drive.folder', { file_id: null }), 409, 'Pick a shared-drive folder first, so staff Sheets stay with the campaign');
  no(await M.b.action('drive.folder', { file_id: mine }), 409, 'Pick a shared-drive folder first, so staff Sheets stay with the campaign');
  const ev = (await events(M.ws, 'workspace')).filter((e) => e.payload.drive).map((e) => e.payload.drive);
  assert.deepEqual(ev.at(-1), { on: true, sheets: 'desk' });
  assert.ok(ev.some((d) => d.folder === 'Campaign exports'), 'the folder’s name only');

  // A personal account: allowed into the shared drive, refused anywhere else.
  const S = await join(M.b, `per.${tag}@example.org`, 'staff', 'Per Example');
  await connect(S.b, A[1].sub);
  assert.equal(ok(await S.b.get('/api/drive')).canSend, true);
  ok(await M.b.action('drive.settings', { sheets: 'managers' }));
  ok(await M.b.action('drive.folder', { file_id: null }));
  await db.query(`update google_grants set hd = null where user_id = $1`, [M.id]);
  assert.equal(ok(await M.b.get('/api/drive')).canSend, false);
  no(await send(M.b, 'list', list), 409, 'Sheets can’t go to a personal Google account. Ask a manager for a shared-drive folder.');
  // With the domain rule, another Workspace domain is refused too.
  await db.query(`update google_grants set hd = 'other.example.org' where user_id = $1`, [M.id]);
  const s = (await db.query('select settings from workspaces where id = $1', [M.ws])).rows[0].settings;
  await db.query('update workspaces set settings = $2 where id = $1', [M.ws, JSON.stringify({ ...(typeof s === 'string' ? JSON.parse(s) : s), google: { domain: 'third.example.org' } })]);
  no(await send(M.b, 'list', list), 409);
  assert.equal(ok(await M.b.get('/api/drive')).canSend, false);
});

test('export, the happy path: three parts, one Sheet in "base.win exports" made once, exact RAW ranges, the right events', async () => {
  const M = await campaign();
  await people(M.ws, 2497);
  await M.b.createPerson ? null : null;
  await db.query(
    `insert into persons (id, workspace_id, name, phone, postal, tags) values
       ($2, $1, 'Aa Phone Example', '+1 604 555 0101', '00123', '["bulk"]'::jsonb),
       ($3, $1, 'Ab Formula Example', '=HYPERLINK("x")', null, '["bulk"]'::jsonb),
       ($4, $1, 'Ac Dated Example', null, null, '["bulk"]'::jsonb)`,
    [M.ws, randomUUID(), randomUUID(), randomUUID()],
  );
  await db.query(`update persons set created_at = '2026-03-04T19:06:07Z' where workspace_id = $1 and name = 'Ac Dated Example'`, [M.ws]);
  const list = await listOf(M.b, 'Big list');
  _setLimitsForTest({ pageRows: 1000, sliceMs: 0 });
  const r = ok(await send(M.b, 'list', list));
  assert.equal(r.export.rows, 2500);
  assert.equal(r.export.status, 'waiting');
  await drain(M.ws);
  assert.deepEqual(await jobKeys(M.ws), [`${r.export.id}:0`, `${r.export.id}:1000`, `${r.export.id}:2000`]);
  const ex = await exportRow(r.export.id);
  assert.deepEqual([ex.status, ex.done_rows, ex.land], ['done', 2500, 'mine']);
  assert.ok(ex.url && ex.file_id);
  assert.deepEqual(D().foldersMade().map((f) => f.name), ['base.win exports']);
  const sheet = D().sheet(ex.file_id);
  assert.equal(D().files.get(ex.file_id).parents[0], D().foldersMade()[0].id);
  assert.deepEqual([sheet.tabs[0].title, sheet.tabs[0].rowCount, sheet.tabs[0].columnCount, sheet.tabs[0].frozen], ['base.win', 2501, 10, 1]);
  assert.deepEqual(sheet.writes.map((w) => [w.at, w.rows, w.valueInputOption]), [[1, 1, 'RAW'], [2, 1000, 'RAW'], [1002, 1000, 'RAW'], [2002, 500, 'RAW']]);
  assert.deepEqual(sheet.rows.get(1), ['Name', 'Email', 'Phone', 'Address', 'Unit', 'City', 'Postal code', 'Rating', 'Tags', 'Added']);
  assert.deepEqual(sheet.rows.get(2).slice(0, 7), ['Aa Phone Example', '', '+1 604 555 0101', '', '', '', '00123']);
  assert.equal(sheet.rows.get(3)[2], '=HYPERLINK("x")', 'words, never a formula (RAW)');
  assert.equal(sheet.rows.get(4)[9], '2026-03-04 11:06', 'a moment in the campaign’s time zone (still PST on 4 March 2026)');
  assert.equal(sheet.rows.get(4)[8], 'bulk');
  const ev = await events(M.ws, 'drive_export');
  assert.deepEqual(ev.map((e) => [e.op, e.payload.status || null]), [['create', null], ['update', 'done']]);
  assert.ok(!JSON.stringify(ev).includes(ex.file_id), 'no Drive id on the log');
  assert.ok(!JSON.stringify(ev).includes('604'), 'no cells on the log');

  // The folder is found the second time, not made again.
  const r2 = ok(await send(M.b, 'list', list));
  await drain(M.ws);
  assert.equal((await exportRow(r2.export.id)).status, 'done');
  assert.equal(D().foldersMade().length, 1);
  const read = ok(await M.b.get('/api/drive/exports')).exports;
  assert.deepEqual(read.map((e) => e.status), ['done', 'done']);
  assert.equal(read[0].url, (await exportRow(r2.export.id)).url);
});

test('export, the job’s edges: tries count per part, a pause counts none, a part tried again lands on the same rows', async () => {
  assert.equal(EXPORT_MAX, MAX_ATTEMPTS);
  assert.equal(MAX_ATTEMPTS, 5);
  const M = await campaign();
  await people(M.ws, 2500);
  const list = await listOf(M.b, 'Edges');
  _setLimitsForTest({ pageRows: 1000, sliceMs: 0 });

  // Five tries on one part with no answer: the export itself says failed.
  const a = ok(await send(M.b, 'list', list)).export;
  await runDueJobs(db, { workspaceId: M.ws }); // part 1
  for (let i = 0; i < 10; i += 1) D().next('sheets', '500'); // each try is a call and googleFetch's one repeat
  for (let i = 0; i < 5; i += 1) { await due(M.ws); await runDueJobs(db, { workspaceId: M.ws }); }
  let ex = await exportRow(a.id);
  const sameSheet = ex.file_id;
  assert.equal(ex.status, 'failed');
  assert.equal(ex.said, 'Google didn’t answer — Try again carries on from row 1,001');
  assert.equal(ok(await M.b.get(`/api/drive/exports/${a.id}`)).export.status, 'failed');
  ok(await M.b.action('drive.export.retry', { id: a.id }));
  assert.ok((await jobKeys(M.ws)).includes(`${a.id}:retry:0`));
  _resetTokensForTest();
  await drain(M.ws);
  ex = await exportRow(a.id);
  assert.deepEqual([ex.status, ex.done_rows], ['done', 2500]);
  const sheet = D().sheet(ex.file_id);
  assert.equal(ex.file_id, sameSheet, 'the same Sheet');
  assert.equal(sheet.rows.size, 2501, 'every row once');

  // Four no-answers then an answer, twice: tries count per part.
  D().clear();
  const b = ok(await send(M.b, 'list', list)).export;
  await runDueJobs(db, { workspaceId: M.ws });
  for (const page of [2, 3]) {
    void page;
    for (let i = 0; i < 8; i += 1) D().next('sheets', '500');
    for (let i = 0; i < 5; i += 1) { await due(M.ws); await runDueJobs(db, { workspaceId: M.ws }); }
  }
  await due(M.ws); await drain(M.ws);
  ex = await exportRow(b.id);
  assert.deepEqual([ex.status, ex.done_rows], ['done', 2500]);

  // Google asks to wait: handed back with no try counted.
  D().clear();
  const c = ok(await send(M.b, 'list', list)).export;
  D().next('drive', '429', { retryAfter: 120 });
  await runDueJobs(db, { workspaceId: M.ws });
  const job = (await db.query(`select * from jobs where workspace_id = $1 and payload->>'id' = $2`, [M.ws, c.id])).rows[0];
  assert.deepEqual([job.status, job.attempts], ['pending', 0]);
  assert.ok(new Date(job.run_at).getTime() - Date.now() > 100_000, 'about 120 s later');
  assert.equal((await exportRow(c.id)).status, 'sending');
  await db.query('update google_grants set paused_until = null');
  await due(M.ws); await drain(M.ws);
  assert.equal((await exportRow(c.id)).status, 'done');
});

test('export, Google not answering the same way 20 times, a wrong client, a full Drive, the APIs off', async () => {
  const M = await campaign();
  await people(M.ws, 30);
  const list = await listOf(M.b, 'Small');
  const { googleFetch: _gf } = await import('../lib/google/tokens.js');
  void _gf;
  // Unavailable without reaching Google (GSI's server-wide 30 s pause): waits, 20 at most.
  const a = ok(await send(M.b, 'list', list)).export;
  await db.query('update drive_exports set waits = 19 where id = $1', [a.id]);
  D().next('drive', '500'); D().next('drive', '500'); // the first: Google pauses the host
  await runDueJobs(db, { workspaceId: M.ws });
  let ex = await exportRow(a.id);
  assert.equal(ex.status, 'sending', 'a reached 500 is a counted try');
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and status = 'pending'`, [M.ws]); // host still paused
  await runDueJobs(db, { workspaceId: M.ws });
  ex = await exportRow(a.id);
  assert.deepEqual([ex.status, ex.said], ['failed', 'Google didn’t answer — Try again carries on from row 1']);

  // Google refuses base.win's client: handed back 60 s, never failed at once.
  _resetTokensForTest(); _resetPausesForTest();
  const b = ok(await send(M.b, 'list', list)).export;
  fake.next('refresh', 'invalid_client');
  await runDueJobs(db, { workspaceId: M.ws });
  ex = await exportRow(b.id);
  assert.deepEqual([ex.status, ex.waits], ['sending', 1]);
  const job = (await db.query(`select * from jobs where workspace_id = $1 and payload->>'id' = $2 and status = 'pending'`, [M.ws, b.id])).rows[0];
  assert.ok(new Date(job.run_at).getTime() - Date.now() > 50_000);
  _resetPausesForTest(); await due(M.ws); await drain(M.ws);
  assert.equal((await exportRow(b.id)).status, 'done');

  const c = ok(await send(M.b, 'list', list)).export;
  D().next('drive', 'full');
  await drain(M.ws);
  assert.deepEqual([(await exportRow(c.id)).status, (await exportRow(c.id)).said], ['failed', 'Your Google Drive is full']);
  const d = ok(await send(M.b, 'list', list)).export;
  D().next('sheets', 'disabled');
  await drain(M.ws);
  assert.equal((await exportRow(d.id)).said, 'The Google Drive API (or Sheets API) isn’t turned on in this Google Cloud project.');

  // Left `sending` with no job and untouched for 16 minutes: shown as failed.
  await db.query(`update drive_exports set status = 'sending', touched_at = now() - interval '16 minutes' where id = $1`, [d.id]);
  const shown = ok(await M.b.get(`/api/drive/exports/${d.id}`)).export;
  assert.deepEqual([shown.status, shown.said], ['failed', 'It stopped part-way — Try again']);
});

test('export, the other edges: no cap, profile fields, too big, empty, replayed, one at a time, three a campaign, who may send, leaving', async () => {
  const M = await campaign({ sheets: 'managers' });
  const S = await join(M.b, `staff.${tag}@example.org`, 'staff', 'Sam Example');
  await connect(S.b, A[4].sub);
  await people(M.ws, 100_001);
  const list = await listOf(M.b, 'Whole city');
  _setLimitsForTest({ pageRows: 25_000, sliceMs: 60_000 });
  const big = ok(await send(M.b, 'list', list)).export;
  assert.equal(big.rows, 100_001);
  // One running per person; a replayed key is the same export.
  const key = randomUUID();
  no(await send(M.b, 'report', 'tags', key), 409, 'You’re already sending one to Google Sheets — wait for it to finish');
  await finish(M.ws);
  let ex = await exportRow(big.id);
  assert.deepEqual([ex.status, ex.done_rows], ['done', 100_001]);
  const sheet = D().sheet(ex.file_id);
  assert.ok(sheet.rows.get(100_002), 'the 100,001st person is in the Sheet');

  const r1 = ok(await send(M.b, 'report', 'tags', key));
  const r2 = ok(await send(M.b, 'report', 'tags', key));
  assert.equal(r2.export.id, r1.export.id);
  assert.equal(r2.duplicate, true);
  await drain(M.ws);

  // The people table carries the campaign's profile fields.
  ok(await M.b.action('field.create', { name: 'Languages', kind: 'text' }));
  const pe = ok(await send(M.b, 'dataset', 'people')).export;
  const { datasetCols } = await import('../ext/reports/rows.js');
  assert.equal((await exportRow(pe.id)).cols, await datasetCols(db, M.ws, 'people'));
  await drain(M.ws);
  const head = D().sheet((await exportRow(pe.id)).file_id).rows.get(1);
  assert.equal(head.at(-1), 'Languages');

  // Too big for one Sheet: refused before Google is called.
  _setLimitsForTest({ cells: 1_000_000 });
  D().clear();
  no(await send(M.b, 'list', list), 409, 'Too big for one Google Sheet — 100,001 people × 10 columns. Use Download CSV.');
  assert.equal(D().calls.length, 0);
  _setLimitsForTest({ cells: 10_000_000 });
  no(await send(M.b, 'list', await listOf(M.b, 'Nobody', 'none')), 409, 'Nothing to send — the list is empty');

  // "managers": staff refused; gifts need Donations.
  no(await send(S.b, 'report', 'tags'), 403, 'Only managers can send to Google Sheets here');
  const shared = D().folder({ name: 'Shared exports', driveId: '0AShared2' });
  D().pick(shared, A[0].sub);
  ok(await M.b.action('drive.folder', { file_id: shared }));
  ok(await M.b.action('drive.settings', { sheets: 'desk' }));
  for (const a of [A[4], A[6], A[2]]) D().pick(shared, a.sub);
  ok(await M.b.action('permission.member.set', { user_id: S.id, grant: [], deny: ['money'] }));
  no(await send(S.b, 'dataset', 'gifts'), 403, 'not for you — ask a manager under Admin → Permissions');
  ok(await M.b.action('permission.member.set', { user_id: S.id, grant: [], deny: [] }));

  // Three a campaign.
  const T = await join(M.b, `tia2.${tag}@example.org`, 'staff', 'Tia Example');
  await connect(T.b, A[6].sub);
  const U = await join(M.b, `uma2.${tag}@example.org`, 'staff', 'Uma Example');
  await connect(U.b, A[2].sub);
  for (const b of [M.b, S.b, T.b]) ok(await send(b, 'report', 'cities'));
  no(await send(U.b, 'report', 'cities'), 409, 'Three are already going for this campaign — try in a few minutes');
  await drain(M.ws);

  // Mid-export: demoted, removed, Drive off — the next part stops.
  _setLimitsForTest({ pageRows: 1000, sliceMs: 0 });
  const small = await listOf(M.b, 'Small again');
  await people(M.ws, 2500, { tag: 'small', from: 200_000 });
  const smallList = await listOf(M.b, 'Small', 'small');
  void small;
  const stopsWhen = async (who, change, said) => {
    const e = ok(await send(who.b, 'list', smallList)).export;
    await runDueJobs(db, { workspaceId: M.ws });
    await change();
    await drain(M.ws);
    const row = await exportRow(e.id);
    assert.deepEqual([row.status, row.said], ['stopped', said]);
  };
  await stopsWhen(S, () => M.b.action('member.setRole', { user_id: S.id, role: 'volunteer' }), 'They can’t send to Google Sheets any more');
  await stopsWhen(T, () => M.b.action('member.remove', { user_id: T.id }), 'They left the team');
  await stopsWhen(U, () => M.b.action('drive.settings', { on: false }), 'Google Drive was turned off');
  const { ctxFor } = await import('../ext/drive/export.js');
  assert.equal((await ctxFor(db, M.ws, S.id)).role, 'volunteer');
  assert.equal(await ctxFor(db, M.ws, T.id), null);
});

test('where it lands: the campaign folder, chosen once by each person; a different folder is refused', async () => {
  const M = await campaign();
  const shared = D().folder({ name: 'Campaign exports', driveId: '0AShared3' });
  D().pick(shared, A[0].sub);
  ok(await M.b.action('drive.folder', { file_id: shared }));
  ok(await M.b.action('drive.settings', { sheets: 'desk' }));
  const S = await join(M.b, `land.${tag}@example.org`, 'staff', 'Lee Example');
  await connect(S.b, A[1].sub); // a personal account: fine in a shared drive
  await people(M.ws, 20);
  const list = await listOf(M.b, 'Lands');
  const e = ok(await send(S.b, 'list', list)).export;
  await drain(M.ws);
  let ex = await exportRow(e.id);
  assert.deepEqual([ex.status, ex.said, ex.land], ['failed', 'pick-folder', 'campaign']);
  const create = D().calls.find((c) => c.api === 'drive' && c.method === 'POST');
  assert.equal(create.query.supportsAllDrives, 'true');
  assert.deepEqual(create.body.parents, [shared]);
  no(await S.b.action('drive.folder.reach', { file_id: D().folder({ name: 'Other' }) }), 409, 'That’s a different folder — choose Campaign exports');
  no(await S.b.action('drive.folder.reach', { file_id: shared }), 409, 'You don’t have this folder in your Google Drive. Ask a manager to add you to the shared drive.');
  D().pick(shared, A[1].sub);
  assert.deepEqual(ok(await S.b.action('drive.folder.reach', { file_id: shared })).ok, true);
  ok(await S.b.action('drive.export.retry', { id: e.id }));
  await drain(M.ws);
  ex = await exportRow(e.id);
  assert.equal(ex.status, 'done');
  assert.deepEqual(D().files.get(ex.file_id).parents, [shared]);
  // Only managers set the switches and the folder.
  no(await S.b.action('drive.settings', { sheets: 'managers' }), 403);
  no(await S.b.action('drive.folder', { file_id: null }), 403);
  // Staff see their own; managers see everyone's, by name.
  const mine = ok(await S.b.get('/api/drive/exports')).exports;
  assert.deepEqual(mine.map((x) => [x.id, x.mine, x.by]), [[e.id, true, 'Lee Example']]);
  ok(await send(M.b, 'list', list));
  await drain(M.ws);
  assert.equal(ok(await S.b.get('/api/drive/exports')).exports.length, 1);
  assert.equal(ok(await M.b.get('/api/drive/exports')).exports.length, 2);
  assert.equal((await S.b.get(`/api/drive/exports/${ok(await M.b.get('/api/drive/exports')).exports.find((x) => x.mine).id}`)).status, 404);
  // A manager can carry on someone else's, as them; not once they've disconnected.
  await db.query(`update drive_exports set status = 'failed' where id = $1`, [e.id]);
  await db.query(`update google_grants set purposes = '{}' where user_id = $1`, [S.id]);
  no(await M.b.action('drive.export.retry', { id: e.id }), 409, 'Only Lee Example can carry this on');
});

test('records: drive_exports and drive_links are in the full export and google_grants still is not', async () => {
  const M = await campaign();
  await people(M.ws, 2);
  ok(await send(M.b, 'list', await listOf(M.b, 'Two')));
  const out = ok(await M.b.get('/api/export'));
  const keys = Object.keys(out.tables || out);
  assert.ok(JSON.stringify(keys).includes('drive_exports'), JSON.stringify(keys));
  assert.ok(JSON.stringify(keys).includes('drive_links'), JSON.stringify(keys));
  assert.ok(!JSON.stringify(out).includes('google_grants'));
  assert.ok(!JSON.stringify(out).includes('refresh_sealed'));
});

test('Services’ Check: working; no connection; the Testing hint only within a week of connecting', async () => {
  const M = await campaign();
  const check = async () => ok(await M.b.post('/api/connections/check', { key: 'drive' }));
  assert.deepEqual(await check(), { key: 'drive', ok: true, said: 'Working · Drive and Sheets answer' });
  D().next('drive', 'disabled');
  const off = await check();
  assert.equal(off.ok, false);
  assert.match(off.todo, /Google Drive API/);
  await db.query(`update google_grants set state = 'reconnect', said = 'Google stopped letting base.win use this account', created_at = now() - interval '3 days' where user_id = $1`, [M.id]);
  assert.match((await check()).said, /Is the Google app still in Testing\?/);
  await db.query(`update google_grants set created_at = now() - interval '10 days' where user_id = $1`, [M.id]);
  assert.doesNotMatch((await check()).said, /Testing/);
  await db.query('delete from google_grants where user_id = $1', [M.id]);
  assert.equal((await check()).said, 'Connect your own Google Drive (Your profile) to check it');
  void LIMITS; void Browser;
});
