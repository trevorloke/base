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
