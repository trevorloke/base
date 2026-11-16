// "Send to Google Sheets" (ext/drive, batch 7) where batch 8 meets it:
// quick reports as a fourth source (REP decision 10), A–Z pages for people
// (PS), a People filter of moved people (MOVED), and nothing of a letter
// writer's reaching Drive (LTE). Google is the fake (fake-google.js,
// fake-google-drive.js); nothing reaches Google.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { runDueJobs } from '../lib/jobs.js';
import { _resetPausesForTest } from '../lib/google/flow.js';
import { _resetTokensForTest } from '../lib/google/tokens.js';
import { _setLimitsForTest } from '../ext/drive/export.js';
import { _setPaceForTest } from '../ext/drive/sheets.js';
import { _resetPickerForTest } from '../ext/drive/picker.js';
import { sql as driveSql } from '../ext/drive/sql.js';
import { RECIPES } from '../ext/reports/quick.js';
import { acct, join, restoreEnv, signup, startGoogle, tag } from './google-helpers.js';

const DKEYS = ['GOOGLE_PICKER_KEY', 'GOOGLE_CLOUD_PROJECT_NUMBER', 'GOOGLE_DRIVE_API_BASE', 'GOOGLE_SHEETS_API_BASE', 'GOOGLE_PICKER_SCRIPT'];
const dsaved = Object.fromEntries(DKEYS.map((k) => [k, process.env[k]]));
const WORK = 'campaign8.example.org';
const A = Array.from({ length: 6 }, (_, i) => acct(i + 41, { email: `w${i}.${tag}@${WORK}`, hd: WORK }));
let fake, db;
const D = () => fake.drive;

const driveEnv = () => Object.assign(process.env, {
  GOOGLE_PICKER_KEY: 'AIza-test-picker-key', GOOGLE_CLOUD_PROJECT_NUMBER: '123456789012',
  GOOGLE_DRIVE_API_BASE: fake.base, GOOGLE_SHEETS_API_BASE: fake.base, GOOGLE_PICKER_SCRIPT: `${fake.base}/picker.js`,
});
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const no = (r, status, words) => {
  assert.equal(r.status, status, JSON.stringify(r.json));
  if (words) assert.equal(r.json.error, words);
};
const connect = async (b, sub) => {
  const r = await b.google(fake, { do: 'connect', for: 'drive', app: 'desk', back: '/admin/profile' }, sub);
  assert.equal(r.google, 'connected', JSON.stringify(r));
};
const drain = async (ws) => {
  for (let i = 0; i < 60; i += 1) {
    const r = await runDueJobs(db, { workspaceId: ws });
    if (!r.ran && !r.failed) {
      const left = (await db.query(`select 1 from jobs where workspace_id = $1 and status in ('pending', 'running')`, [ws])).rows;
      if (!left.length) return;
      await db.query(`update jobs set run_at = now() where workspace_id = $1 and status = 'pending'`, [ws]);
      _resetTokensForTest(); _resetPausesForTest();
      await new Promise((r2) => { setTimeout(r2, 50); });
    }
  }
};
const exportRow = async (id) => (await db.query('select * from drive_exports where id = $1', [id])).rows[0];
const send = (b, source, ref) => b.action('drive.export', { source, ref, client_key: randomUUID() });
// Every row of a finished Sheet, header first.
const sheetRows = async (id) => {
  const ex = await exportRow(id);
  assert.equal(ex.status, 'done', JSON.stringify(ex));
  const rows = D().sheet(ex.file_id).rows;
  return [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k));
};
const person = async (ws, first, last, extra = {}) => {
  const id = randomUUID();
  await db.query(
    `insert into persons (id, workspace_id, name, first_name, last_name, phone, email, tags, address, city)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [id, ws, `${first} ${last}`, first, last, extra.phone || null, extra.email || null, JSON.stringify(extra.tags || []), extra.address || null, extra.city || null],
  );
  return id;
};
const gift = (ws, personId, cents) => db.query(
  `insert into gifts (id, workspace_id, person_id, amount_cents, date, method, cadence, attrs)
   values ($1, $2, $3, $4, current_date, 'cash', 'one-time', '{}'::jsonb)`,
  [randomUUID(), ws, personId, cents],
);

let n = 0;
const campaign = async () => {
  n += 1;
  const M = await signup(`Drive8 ${n} ${tag}`, `mgr8-${n}.${tag}@example.org`);
  ok(await M.b.action('drive.settings', { on: true }));
  ok(await M.b.action('drive.settings', { sheets: 'managers' }));
  await connect(M.b, A[0].sub);
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

test('the source check takes quick, on a new database and on one made before it; run twice is the same', async () => {
  const def = async () => (await db.query(
    `select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'drive_exports'::regclass and conname = 'drive_exports_source_check'`,
  )).rows.map((r) => r.d);
  assert.match((await def())[0], /'quick'/);
  // A database from before batch 8: the old check.
  await db.query('alter table drive_exports drop constraint drive_exports_source_check');
  await db.query(`alter table drive_exports add constraint drive_exports_source_check check (source in ('list','report','dataset'))`);
  await db.exec(driveSql);
  await db.exec(driveSql);
  const after2 = await def();
  assert.equal(after2.length, 1);
  assert.match(after2[0], /'quick'/);
});

test('quick reports to Sheets: A–Z pages with the raw number and the Do not contact column; Largest first, the walking list and a denied Donations are refused', async () => {
  const M = await campaign();
  const S = await join(M.b, `staff8.${tag}@example.org`, 'staff', 'Sam Example');
  await connect(S.b, A[2].sub);
  const shared = D().folder({ name: 'Shared exports', driveId: '0AShared8' });
  for (const a of [A[0], A[2]]) D().pick(shared, a.sub);
  ok(await M.b.action('drive.folder', { file_id: shared }));
  ok(await M.b.action('drive.settings', { sheets: 'desk' }));
  const zed = await person(M.ws, 'Ann', 'Zed', { phone: '604-555-0101' });
  const abe = await person(M.ws, 'Cy', 'Abe', { phone: '604-555-0102', tags: ['do-not-contact'] });
  const mid = await person(M.ws, 'Bo', 'Mid', { phone: '604-555-0103' });
  await gift(M.ws, zed, 90000); await gift(M.ws, abe, 1000); await gift(M.ws, mid, 5000);

  // Refused before Google is called.
  const calls = D().calls.length;
  no(await send(M.b, 'quick', 'donors?period=year&order=largest'), 400, 'Choose A–Z to send to Sheets');
  no(await send(M.b, 'quick', 'walk'), 404, 'No such report');
  ok(await M.b.action('permission.member.set', { user_id: S.id, grant: [], deny: ['money'] }));
  no(await send(S.b, 'quick', 'donors?period=year&order=az'), 403, 'not for you — ask a manager under Admin → Permissions');
  // Donations by month, like its CSV, needs Donations too.
  no(await send(S.b, 'report', 'donations'), 403, 'not for you — ask a manager under Admin → Permissions');
  assert.equal(D().calls.length, calls, 'Google never asked');
  ok(await M.b.action('permission.member.set', { user_id: S.id, grant: [], deny: [] }));

  _setLimitsForTest({ pageRows: 1, sliceMs: 60_000 });
  const ex = ok(await send(S.b, 'quick', 'donors?period=year&order=az')).export;
  assert.equal(ex.rows, 3);
  await drain(M.ws);
  const rows = await sheetRows(ex.id);
  const head = rows[0];
  assert.deepEqual(rows.slice(1).map((r) => r[0]), ['Abe', 'Mid', 'Zed'], 'A–Z by last name, a page at a time');
  const phone = head.indexOf('Phone'); const why = head.indexOf('Do not contact');
  assert.equal(rows[1][phone], '604-555-0102', 'the number as stored, never the screen’s mask');
  assert.equal(rows[1][why], 'Do not contact');
  const row = await exportRow(ex.id);
  assert.equal(row.source, 'quick');
  assert.match(row.name, /^Donors · This year/);
});

test('a quick report with an id set reads it once for the whole job, however many pages', async () => {
  const M = await campaign();
  for (let i = 0; i < 5; i += 1) {
    const id = await person(M.ws, `V${i}`, `Vol${String.fromCharCode(69 - i)}`);
    await db.query(`insert into volunteer_roles (id, workspace_id, person_id, role) values ($1, $2, $3, 'canvass')`, [randomUUID(), M.ws, id]);
  }
  const real = RECIPES.volunteers.idsFor;
  let calls = 0;
  RECIPES.volunteers.idsFor = function counted(...a) { calls += 1; return real.apply(this, a); };
  try {
    _setLimitsForTest({ pageRows: 2, sliceMs: 60_000 });
    const ex = ok(await send(M.b, 'quick', 'volunteers?role=all')).export;
    calls = 0;
    await drain(M.ws);
    const rows = await sheetRows(ex.id);
    assert.deepEqual(rows.slice(1).map((r) => r[0]), ['VolA', 'VolB', 'VolC', 'VolD', 'VolE']);
    assert.equal(calls, 1, 'idsFor once for three pages');
  } finally { RECIPES.volunteers.idsFor = real; }
});

test('a quick report sent in several parts carries on when the row it stopped at leaves the set between parts', async () => {
  const M = await campaign();
  const ids = [];
  for (const [f, l] of [['Ann', 'Ames'], ['Bo', 'Bell'], ['Cy', 'Cole'], ['Di', 'Dunn']]) {
    const id = await person(M.ws, f, l, { address: `${ids.length + 1} Example St`, city: 'Surrey' });
    ok(await M.b.action('contact.log', { person_id: id, channel: 'door', outcome: 'moved' }));
    ids.push(id);
  }
  const signAt = async (address, ageMin) => {
    const id = randomUUID();
    await db.query(`insert into signs (id, workspace_id, address, kind, created_at) values ($1, $2, $3, 'lawn', now() - make_interval(mins => $4))`, [id, M.ws, address, ageMin]);
    return id;
  };
  for (const [a, m] of [['10 Example St', 4], ['12 Example St', 3], ['14 Example St', 2], ['16 Example St', 1]]) await signAt(a, m);
  _setLimitsForTest({ pageRows: 1, sliceMs: 0 });
  // One part, then the row at the cursor leaves: a new address; a sign put up.
  const partThenLeave = async (ref, leave) => {
    const ex = ok(await send(M.b, 'quick', ref)).export;
    for (let i = 0; i < 10 && !(await exportRow(ex.id)).cursor?.page?.after; i += 1) await runDueJobs(db, { workspaceId: M.ws });
    const at = (await exportRow(ex.id)).cursor.page.after;
    await leave(at);
    await drain(M.ws);
    return ex.id;
  };
  const m = await partThenLeave('moved', (at) => M.b.action('person.move', { person_id: at, to: { address: '99 New St' } }));
  assert.deepEqual((await sheetRows(m)).slice(1).map((r) => r[0]), ['Ames', 'Bell', 'Cole', 'Dunn'], 'every row once, A–Z');
  const sg = await partThenLeave('signs?kind=all', (at) => db.query(`update signs set status = 'installed' where id = $1`, [at]));
  assert.equal((await sheetRows(sg)).length - 1, 4, 'every sign once');
  // Gone from the database altogether: stopped in plain words, not Google's fault.
  for (const [f, l] of [['Ed', 'Eby'], ['Flo', 'Fox']]) {
    const id = await person(M.ws, f, l);
    await db.query(`insert into volunteer_roles (id, workspace_id, person_id, role) values ($1, $2, $3, 'canvass')`, [randomUUID(), M.ws, id]);
  }
  const v = await partThenLeave('volunteers?role=all', async (at) => {
    await db.query('delete from volunteer_roles where person_id = $1', [at]);
    await db.query('delete from persons where id = $1', [at]);
  });
  const row = await exportRow(v);
  assert.deepEqual([row.status, row.said], ['failed', 'What was being sent changed while sending — send it again']);
});

test('a People filter of moved people (moved=open, moved=unknown) sends the same people to Sheets, A–Z', async () => {
  const M = await campaign();
  const ana = await person(M.ws, 'Ana', 'Souza', { address: '1 Example St', city: 'Surrey' });
  const ben = await person(M.ws, 'Ben', 'Allen', { address: '2 Example St', city: 'Surrey' });
  const cy = await person(M.ws, 'Cy', 'Moss', { address: '3 Example St', city: 'Surrey' });
  await person(M.ws, 'Di', 'Stay', { address: '4 Example St', city: 'Surrey' });
  for (const id of [ana, ben, cy]) ok(await M.b.action('contact.log', { person_id: id, channel: 'door', outcome: 'moved' }));
  ok(await M.b.action('person.move', { person_id: cy, unknown: true }));
  const open = ok(await M.b.action('list.create', { name: 'Moved, where to?', kind: 'filter', filter: { moved: 'open' } })).list;
  const unknown = ok(await M.b.action('list.create', { name: 'Address unknown', kind: 'filter', filter: { moved: 'unknown' } })).list;
  const people = async (v) => ok(await M.b.get(`/api/persons?moved=${v}&limit=500`)).persons.map((p) => p.name);
  for (const [list, v] of [[open, 'open'], [unknown, 'unknown']]) {
    const ex = ok(await send(M.b, 'list', list.id)).export;
    await drain(M.ws);
    const names = (await sheetRows(ex.id)).slice(1).map((r) => r[0]);
    assert.deepEqual(names, await people(v), `moved=${v}: the Sheet holds who People shows`);
  }
  assert.deepEqual((await sheetRows((await db.query(
    `select id from drive_exports where workspace_id = $1 and ref = $2`, [M.ws, open.id],
  )).rows[0].id)).slice(1).map((r) => r[0]), ['Ben Allen', 'Ana Souza']);
});

test('people and lists page A–Z by last name across pages, as People and the CSV do', async () => {
  const M = await campaign();
  for (const [f, l] of [['Zoe', 'Adams'], ['Al', 'Young'], ['Mo', 'Baker'], ['Ty', 'Baker'], ['Ed', 'Cole']]) await person(M.ws, f, l, { tags: ['az'] });
  _setLimitsForTest({ pageRows: 2, sliceMs: 60_000 });
  const list = ok(await M.b.action('list.create', { name: 'A to Z', kind: 'filter', filter: { tag: 'az' } })).list;
  const ex = ok(await send(M.b, 'list', list.id)).export;
  await drain(M.ws);
  const want = ['Zoe Adams', 'Mo Baker', 'Ty Baker', 'Ed Cole', 'Al Young'];
  assert.deepEqual((await sheetRows(ex.id)).slice(1).map((r) => r[0]), want);
  const csv = ok(await M.b.get('/api/persons?tag=az&limit=50')).persons.map((p) => p.name);
  assert.deepEqual(csv, want);
  const pe = ok(await send(M.b, 'dataset', 'people')).export;
  await drain(M.ws);
  const rows = await sheetRows(pe.id);
  const name = rows[0].indexOf('name');
  assert.deepEqual(rows.slice(1).map((r) => r[name]), want);
});

test('a letter writer’s address and phone never reach Drive: letters and the media lists are not tables Sheets can send', async () => {
  const M = await campaign();
  for (const t of ['letters', 'letter_versions', 'letter_notes', 'letter_sends', 'media_outlets', 'media_contacts']) {
    no(await send(M.b, 'dataset', t), 404, 'No such table');
  }
  assert.equal(D().calls.length, 0);
  // The full export (JSON) still leaves the writer's signing details out.
  const out = ok(await M.b.get('/api/export'));
  const letters = (out.tables || out).letters || [];
  for (const r of letters) for (const k of ['sign_name', 'sign_city', 'sign_address', 'sign_phone']) assert.ok(!(k in r), k);
});
