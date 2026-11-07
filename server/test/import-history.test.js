// A list's own history (ext/importhistory, routes/data.js): its last
// interaction comes in as a knock or a call on that day, marked as from an
// imported list (no one on the team logged it); its Sign column as a lawn
// sign. Importing the file again doubles neither; no day, no knock; a
// person who has a sign gets no second one; the field report names the
// imported knocks for what they are.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const imp = (rows, extra = {}) => mgr.post('/api/data/import', { rows, ...extra });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'History', jurisdiction: 'bc-municipal' });
});

test('the last interaction is a knock on its day; the sign a lawn sign; again → unchanged', async () => {
  const rows = [
    { first: 'Ana', last: 'Example', address: '1 Main St', city: 'Surrey', history: { channel: 'door', outcome: 'no_answer', date: '10/04/2026' }, sign: 'requested' },
    { first: 'Ben', last: 'Example', phone: '604-555-0101', history: { channel: 'phone', outcome: 'left_message', date: '2026-09-30' } },
    { first: 'Cy', last: 'Example', address: '2 Main St', history: { channel: 'door', outcome: 'contacted', date: '' } },
    { first: 'Di', last: 'Example', sign: 'installed' },
  ];
  const dry = ok(await imp(rows, { dryRun: true }));
  assert.equal(dry.created, 4);
  assert.equal((await db.query('select count(*)::int as n from contacts')).rows[0].n, 0, 'a dry run writes nothing');
  ok(await imp(rows));
  const c = (await db.query(
    `select p.first_name, c.channel, c.outcome, c.source, c.created_by, c.note, to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at
       from contacts c join persons p on p.id = c.person_id order by p.first_name`,
  )).rows;
  assert.deepEqual(c.map((x) => [x.first_name, x.channel, x.outcome, x.source, x.created_by, x.at]), [
    ['Ana', 'door', 'no_answer', 'import', null, '2026-10-04 19:00'],
    ['Ben', 'phone', 'left_message', 'import', null, '2026-09-30 19:00'],
  ], 'noon in Surrey on the day; Cy has no day, so no knock');
  assert.equal(c[0].note, 'From an imported list');
  const s = (await db.query('select p.first_name, s.kind, s.status, s.address from signs s join persons p on p.id = s.person_id')).rows;
  assert.deepEqual(s.map((x) => [x.first_name, x.kind, x.status, x.address]), [['Ana', 'lawn', 'requested', '1 Main St']], 'Di has nowhere to send a crew');
  const again = ok(await imp(rows));
  assert.deepEqual([again.created, again.merged, again.unchanged], [0, 0, 4]);
  assert.equal((await db.query('select count(*)::int as n from contacts')).rows[0].n, 2);
  assert.equal((await db.query('select count(*)::int as n from signs')).rows[0].n, 1);
});

test('someone on file: a newer status is a new knock; someone with a sign gets no second', async () => {
  const r = ok(await imp([{ first: 'Ana', last: 'Example', address: '1 Main St', history: { channel: 'door', outcome: 'contacted', date: '2026-10-11' }, sign: 'installed' }]));
  const ana = r.decisions[0];
  assert.equal(ana.action, 'merged');
  assert.deepEqual(ana.fields, ['history']);
  assert.equal((await db.query("select count(*)::int as n from signs where status = 'installed'")).rows[0].n, 0);
});

test('a date in the future, or not a date: no knock; a bad outcome is refused; the books verify', async () => {
  ok(await imp([{ first: 'Eve', last: 'Example', history: { channel: 'door', outcome: 'contacted', date: '2099-01-01' } }]));
  ok(await imp([{ first: 'Fay', last: 'Example', history: { channel: 'door', outcome: 'contacted', date: 'last spring' } }]));
  assert.equal((await db.query("select count(*)::int as n from contacts c join persons p on p.id = c.person_id where p.first_name in ('Eve', 'Fay')")).rows[0].n, 0);
  assert.equal(ok(await imp([{ name: 'Gus Example', history: { channel: 'door', outcome: 'waved', date: '2026-10-01' } }])).invalid.length, 1);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('the field report names imported knocks for what they are', async () => {
  const rep = ok(await mgr.get('/api/field-report?from=all'));
  const row = rep.canvassers.find((x) => x.id === 'import');
  assert.equal(row?.name, 'From an imported list');
  assert.equal(row.doors, 1, 'Ana’s door (her two knocks are one door)');
});
