// Volunteer roles from an import (routes/data.js): the roles a row names —
// chosen on the import screen from tags like "Vol: Door Knocker" — are added
// to the person, new or already on file, never twice; a dry run adds none;
// a role that isn't Base Ground's is refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const rolesOf = async (id) => (await db.query('select role from volunteer_roles where person_id = $1 order by role', [id])).rows.map((r) => r.role);
const imp = (rows, extra = {}) => mgr.post('/api/data/import', { rows, ...extra });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Roles', jurisdiction: 'bc-municipal' });
});

test('new and on-file people get the roles their row names; the tags stay; again → unchanged', async () => {
  const on = await mgr.createPerson('Ben Example', { email: 'ben@example.org' });
  ok(await mgr.action('volunteer.assign', { person_id: on.id, role: 'doorknocking' }));
  const rows = [
    { first: 'Ana', last: 'Example', email: 'ana@example.org', tags: 'Vol: Door Knocker; Vol: GOTV', roles: ['doorknocking', 'driver'] },
    { first: 'Ben', last: 'Example', email: 'ben@example.org', tags: 'Vol: Door Knocker', roles: ['doorknocking', 'phoning'] },
  ];
  const dry = ok(await imp(rows, { dryRun: true }));
  assert.deepEqual([dry.created, dry.merged], [1, 1], 'Ben: a new role is a change');
  assert.equal((await db.query('select count(*)::int as n from volunteer_roles')).rows[0].n, 1, 'the dry run adds no roles');
  const r = ok(await imp(rows));
  const ana = r.decisions.find((d) => d.name === 'Ana Example');
  assert.deepEqual(await rolesOf(ana.id), ['doorknocking', 'driver']);
  assert.deepEqual(await rolesOf(on.id), ['doorknocking', 'phoning'], 'what Ben had stays, once');
  assert.ok(r.decisions.find((d) => d.name === 'Ben Example').fields.includes('roles'));
  const tags = (await db.query('select tags from persons where id = $1', [ana.id])).rows[0].tags;
  assert.ok(tags.includes('Vol: GOTV') && tags.includes('Vol: Door Knocker'), 'the tags come in as they are');
  const again = ok(await imp(rows));
  assert.deepEqual([again.created, again.merged, again.unchanged], [0, 0, 2]);
  assert.deepEqual(await rolesOf(ana.id), ['doorknocking', 'driver']);
});

test('a role that isn’t on the list is refused; the books verify', async () => {
  const r = ok(await imp([{ name: 'Cy Example', roles: ['astronaut'] }]));
  assert.equal(r.invalid.length, 1);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
