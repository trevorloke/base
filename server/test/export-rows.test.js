// The CSV downloads, pinned byte for byte: a list, a report and the people
// dataset. Their rows are also what "Send to Google Sheets" reads
// (ext/lists/rows.js, ext/reports/rows.js), so splitting the routes into a
// rows function and a thin response must change nothing a download gives.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
let db, mgr, ws, listId;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const csv = async (path) => {
  const res = await app.request(path, { headers: { cookie: mgr.cookie } });
  assert.equal(res.status, 200, path);
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
};

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Rows ${tag}`, email: `rows.${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  const field = ok(await mgr.action('field.create', { name: 'Languages', kind: 'text' })).field;
  const people = [
    ['Ann Example', { email: `ann.${tag}@example.org`, phone: '+1 604 555 0101', address: '12 Example St', city: 'Surrey', tags: ['donor', 'yard sign'] }],
    ['bo Example', { email: `bo.${tag}@example.org`, phone: '604-555-0102', address: '=HYPERLINK("x")', tags: [] }],
    ['Cy, "Junior" Example', { phone: '00123', unit: '4', postal: 'V3T 0A1', tags: ['+plus'] }],
  ];
  const ids = [];
  for (const [name, extra] of people) ids.push((await mgr.createPerson(name, extra)).id);
  ok(await mgr.action('field.values.set', { person_id: ids[0], values: [{ field_id: field.id, value: 'Punjabi' }] }));
  await db.query(`update persons set created_at = '2026-03-04T05:06:07.000Z' where workspace_id = $1`, [ws]);
  listId = ok(await mgr.action('list.create', { name: 'Pinned', kind: 'people', person_ids: ids })).list.id;
});

const LIST = '﻿Name,Email,Phone,Address,Unit,City,Postal code,Rating,Tags,Added\r\n'
  + `Ann Example,ann.${tag}@example.org,'+1 604 555 0101,12 Example St,,Surrey,,,donor; yard sign,2026-03-04T05:06:07.000Z\r\n`
  + `bo Example,bo.${tag}@example.org,604-555-0102,"'=HYPERLINK(""x"")",,,,,,2026-03-04T05:06:07.000Z\r\n`
  + `"Cy, ""Junior"" Example",,00123,,4,,V3T 0A1,,'+plus,2026-03-04T05:06:07.000Z\r\n`;

test('a list’s CSV, byte for byte', async () => {
  assert.equal(await csv(`/api/lists/${listId}/export.csv`), LIST);
});

test('a report’s CSV, byte for byte', async () => {
  assert.equal(await csv('/api/reports/tags.csv'), '﻿Tag,People\r\n\'+plus,1\r\ndonor,1\r\nyard sign,1\r\n');
});

test('the people dataset’s CSV, byte for byte, profile fields included', async () => {
  const text = await csv('/api/export/people.csv');
  const lines = text.split('\r\n');
  const base = 'first_name,middle_name,last_name,name,email,phone,unit,house_number,street,address,city,postal,rating,rated_at,tags,lat,lng,voted,voter_number,kind,created_at';
  assert.ok(lines[0].startsWith(`﻿${base},`), lines[0]);
  assert.ok(lines[0].endsWith(',Languages'), 'the campaign’s own field last');
  const fields = lines[0].split(',').length - base.split(',').length;
  assert.equal(lines.length, 5);
  assert.equal(lines[1], `Ann,,Example,Ann Example,ann.${tag}@example.org,'+1 604 555 0101,,12,Example St,12 Example St,Surrey,,,,donor; yard sign,,,,,person,2026-03-04T05:06:07.000Z,${','.repeat(fields - 1)}Punjabi`);
  assert.equal(lines[3], `"Cy,","""Junior""",Example,"Cy, ""Junior"" Example",,00123,4,,,,,V3T 0A1,,,'+plus,,,,,person,2026-03-04T05:06:07.000Z,${','.repeat(fields - 1)}`);
  assert.equal(lines[4], '');
});

test('page by page, the rows are the download’s rows, none twice and none missed', async () => {
  const { listRows, listPage, listCount } = await import('../ext/lists/rows.js');
  const { datasetRows, datasetPage, datasetCount } = await import('../ext/reports/rows.js');
  const { loadList } = await import('../ext/lists/audience.js');
  // Same names, so the tie-breaker decides.
  for (let i = 0; i < 5; i += 1) await mgr.createPerson('Dee Example', { phone: `604-555-01${10 + i}` });
  const ctx = { workspaceId: ws, role: 'manager', perms: { grant: new Set(), deny: new Set() }, user: { id: null, email: '' } };
  const all = await loadList(db, ws, ok(await mgr.action('list.create', { name: 'Everyone', kind: 'filter', filter: {} })).list.id);
  const whole = await listRows(db, ctx, all);
  const paged = [];
  for (let cursor = null, n = 0; n < 20; n += 1) {
    const page = await listPage(db, ctx, all, { cursor, limit: 2 });
    paged.push(...page.rows);
    if (!(cursor = page.next)) break;
  }
  assert.deepEqual(paged, whole.rows);
  assert.equal(await listCount(db, ctx, all), whole.rows.length);
  for (const name of ['people', 'contacts']) {
    const w = await datasetRows(db, ws, name);
    const rows = [];
    for (let cursor = null, n = 0; n < 20; n += 1) {
      const page = await datasetPage(db, ws, name, { cursor, limit: 3 });
      if (page.rows.length) assert.deepEqual(page.head, w.head, name);
      rows.push(...page.rows);
      if (!(cursor = page.next)) break;
    }
    assert.deepEqual(rows, w.rows, name);
    assert.equal(await datasetCount(db, ws, name), w.rows.length, name);
  }
});

test('every dataset pages as it downloads; rows added or removed between pages never repeat or drop another', async () => {
  const { DATASETS, datasetRows, datasetPage } = await import('../ext/reports/rows.js');
  const pages = async (name, between = async () => {}) => {
    const rows = [];
    for (let cursor = null, n = 0; n < 50; n += 1) {
      const page = await datasetPage(db, ws, name, { cursor, limit: 3 });
      rows.push(...page.rows);
      if (!(cursor = page.next)) break;
      await between(n);
    }
    return rows;
  };
  // Signs with and without an address, gifts on one day and none: each key kind runs with a cursor.
  const pid = (await db.query('select id from persons where workspace_id = $1 limit 1', [ws])).rows[0].id;
  for (const [i, address] of [[1, '9 Example St'], [2, null], [3, '9 Example St'], [4, null], [5, '1 Example St']].entries()) {
    await db.query(`insert into signs (id, workspace_id, person_id, address, kind) values (gen_random_uuid(), $1, $2, $3, 'lawn')`, [ws, pid, address[1] ?? null]);
    await db.query(`insert into gifts (id, workspace_id, person_id, amount_cents, date, method) values (gen_random_uuid(), $1, $2, $3, $4, 'cheque')`,
      [ws, pid, 1000 + i, i % 2 ? '2026-04-01' : '2026-04-02']);
  }
  for (const name of Object.keys(DATASETS)) assert.deepEqual(await pages(name), (await datasetRows(db, ws, name)).rows, name);
  // Subscribers, newest first: one joins and one already sent leaves while it runs.
  const sub = (i, at) => db.query(
    `insert into subscriptions (id, workspace_id, email, name, created_at) values (gen_random_uuid(), $1, $2, $3, $4)`,
    [ws, `p${i}.${tag}@example.org`, `p${i}`, at],
  );
  for (let i = 0; i < 9; i += 1) await sub(i, `2026-05-0${i + 1}T12:00:00.123456Z`);
  const was = (await datasetRows(db, ws, 'subscribers')).rows.map((r) => r[1]);
  const got = (await pages('subscribers', async (n) => {
    if (n === 0) await sub(99, '2026-06-01T00:00:00Z');
    if (n === 1) await db.query('delete from subscriptions where workspace_id = $1 and name = $2', [ws, 'p8']);
  })).map((r) => r[1]);
  assert.deepEqual(got, was, 'each row once, in order; the newcomer, ahead of the pages, waits for the next send');
});
