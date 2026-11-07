// A list from a past election (routes/data.js, past: { year }): what it says
// about support, signs, voting, volunteering and conversations comes in as
// tags with the year — never as today's rating, sign, voted mark, knock or
// role. Contact details come in as usual; someone on file keeps their rating.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const imp = (rows, extra = {}) => mgr.post('/api/data/import', { rows, ...extra });
const person = async (first) => (await db.query('select * from persons where first_name = $1', [first])).rows[0];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Past', jurisdiction: 'bc-municipal' });
});

test('ratings, signs, voted, volunteer and donor flags, roles and talks become year tags', async () => {
  const rows = [
    { first: 'Ana', last: 'Example', phone: '604-555-0101', address: '1 Main St', rating: '1', sign: 'installed', voted: 'yes', volunteer: '1', donor: '1', roles: ['doorknocking'], history: { channel: 'door', outcome: 'contacted', date: '2022-10-01' }, tags: 'Zone 1' },
    { first: 'Ben', last: 'Example', phone: '604-555-0102', rating: 'Locke', sign: 'requested', history: { channel: 'door', outcome: 'no_answer', date: '2022-10-01' } },
  ];
  const dry = ok(await imp(rows, { past: { year: 2022 }, dryRun: true }));
  assert.equal(dry.created, 2);
  ok(await imp(rows, { past: { year: 2022 } }));
  const ana = await person('Ana');
  assert.equal(ana.rating, null, 'no rating today');
  assert.equal(ana.voted_at, null, 'not marked voted');
  assert.deepEqual([...ana.tags].sort(), ['Donor 2022', 'Doorknocking 2022', 'Lawn sign 2022', 'Strong support 2022', 'Talked 2022', 'Volunteer 2022', 'Voted 2022', 'Zone 1']);
  assert.equal(ana.phone, '604-555-0101', 'contact details as usual');
  const ben = await person('Ben');
  assert.deepEqual([...ben.tags].sort(), ['Lawn sign request 2022', 'Voting Locke 2022'], 'a not-home is no tag');
  for (const t of ['contacts', 'signs', 'volunteer_roles', 'voted_marks']) {
    assert.equal((await db.query(`select count(*)::int as n from ${t}`)).rows[0].n, 0, `no ${t}`);
  }
});

test('someone on file keeps today’s rating; the past is added as tags; again → unchanged', async () => {
  const cy = await mgr.createPerson('Cy Example', { phone: '604-555-0103' });
  ok(await mgr.action('contact.log', { person_id: cy.id, channel: 'door', outcome: 'contacted', rating: '2' }));
  const rows = [{ first: 'Cy', last: 'Example', phone: '604-555-0103', rating: '4' }];
  const r = ok(await imp(rows, { past: { year: 2018 } }));
  assert.equal(r.merged, 1);
  const p = await person('Cy');
  assert.equal(p.rating, '2');
  assert.ok(p.tags.includes('Opposed 2018'), JSON.stringify(p.tags));
  assert.equal(ok(await imp(rows, { past: { year: 2018 } })).unchanged, 1);
});

test('an opposed candidate’s supporter is “Voting <name> <year>”; a bad year is refused; the books verify', async () => {
  const r = ok(await imp([{ name: 'Dee Example', rating: '4D' }], { past: { year: 2018 } }));
  assert.equal(r.created, 1);
  assert.deepEqual([...(await person('Dee')).tags], ['Voting McCallum 2018']);
  assert.equal((await mgr.post('/api/data/import', { rows: [{ name: 'Eve' }], past: { year: 1200 } })).status, 400);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('profile fields chosen for tags: Support 5 2022, Sign 2022 (a no is nothing); the rest stay fields', async () => {
  const add = async (name, kind, extra = {}) => ok(await mgr.action('field.create', { name, kind, ...extra })).field;
  const support = await add('Past support', 'number');
  const sign = await add('Past sign', 'yesno');
  const notes = await add('Past notes', 'text');
  const rows = [
    { first: 'Fay', last: 'Example', phone: '604-555-0111', fields: { [support.id]: '5', [sign.id]: 'yes', [notes.id]: 'Corner lot' } },
    { first: 'Gil', last: 'Example', phone: '604-555-0112', fields: { [support.id]: '2', [sign.id]: 'f' } },
  ];
  ok(await imp(rows, { past: { year: 2022, field_tags: [support.id, sign.id] } }));
  const fay = await person('Fay');
  assert.deepEqual([...fay.tags].sort(), ['Past sign 2022', 'Past support 5 2022']);
  const gil = await person('Gil');
  assert.deepEqual([...gil.tags].sort(), ['Past support 2 2022'], 'a no on a Yes/No field is no tag');
  const vals = (await db.query(
    'select f.name, v.value from person_field_values v join person_fields f on f.id = v.field_id where v.person_id = any($1::uuid[]) order by f.name',
    [[fay.id, gil.id]],
  )).rows.map((r) => [r.name, r.value]);
  assert.deepEqual(vals, [['Past notes', 'Corner lot']], 'only the unticked field is a field');
  const bad = ok(await imp([{ first: 'Hal', last: 'Example', fields: { [support.id]: 'lots' } }], { past: { year: 2022, field_tags: [support.id] } }));
  assert.equal(bad.invalid.length, 1, 'a value that doesn’t fit is still refused');
});
