// First and last names kept apart, the way the campaign's lists keep them
// (ext/names): every way a person is written fills both, and the whole name
// every screen reads follows them.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const names = async (id) => (await db.query('select name, first_name, last_name from persons where id = $1', [id])).rows[0];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Names', jurisdiction: 'bc-municipal' });
});

test('Add a person with first and last: the whole name follows; the whole alone is split at the last space', async () => {
  const a = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Mary Anne', last_name: 'Example' })).person;
  assert.deepEqual({ ...(await names(a.id)) }, { name: 'Mary Anne Example', first_name: 'Mary Anne', last_name: 'Example' });
  assert.deepEqual([a.name, a.first_name, a.last_name], ['Mary Anne Example', 'Mary Anne', 'Example'], 'the answer says so too');
  const b = await mgr.createPerson('Jo  Van Sample');
  assert.deepEqual({ ...(await names(b.id)) }, { name: 'Jo  Van Sample', first_name: 'Jo Van', last_name: 'Sample' });
  const c = await mgr.createPerson('Cher');
  assert.deepEqual({ ...(await names(c.id)) }, { name: 'Cher', first_name: 'Cher', last_name: null });
  const org = ok(await mgr.action('person.create', { kind: 'org', name: 'Surrey Food Bank' })).person;
  assert.deepEqual({ ...(await names(org.id)) }, { name: 'Surrey Food Bank', first_name: null, last_name: null }, 'an organization keeps its name whole');
  assert.equal((await mgr.action('person.create', { kind: 'person' })).status, 400, 'no name at all');
});

test('editing: a new last name changes the whole; a new whole name is split again', async () => {
  const p = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Riya', last_name: 'Sample' })).person;
  const u = ok(await mgr.action('person.update', { id: p.id, last_name: 'Example' })).person;
  assert.deepEqual([u.name, u.first_name, u.last_name], ['Riya Example', 'Riya', 'Example']);
  ok(await mgr.action('person.update', { id: p.id, name: 'Riya K. Sample' }));
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Riya K. Sample', first_name: 'Riya K.', last_name: 'Sample' });
  const read = ok(await mgr.get(`/api/persons/${p.id}`)).person;
  assert.deepEqual([read.first_name, read.last_name], ['Riya K.', 'Sample'], 'the profile reads both');
});

test('an import keeps First Name and Surname as the file has them; the website’s first_name/last_name too', async () => {
  const r = ok(await mgr.post('/api/data/import', { rows: [{ first: 'Ana Maria', last: 'de la Example', phone: '604-555-0101' }] }));
  assert.equal(r.created, 1);
  const p = (await db.query("select name, first_name, last_name from persons where phone = '604-555-0101'")).rows[0];
  assert.deepEqual({ ...p }, { name: 'Ana Maria de la Example', first_name: 'Ana Maria', last_name: 'de la Example' }, 'a two-word first and a three-word last stay as the file split them');
  const key = ok(await mgr.action('intake.key.create', { name: 'Site' })).key;
  const { app } = await import('../index.js');
  const res = await app.request('/in/v1/people', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'Jean Luc', last_name: 'Example', email: 'jl@example.org' }),
  });
  const id = (await res.json()).person_id;
  assert.deepEqual({ ...(await names(id)) }, { name: 'Jean Luc Example', first_name: 'Jean Luc', last_name: 'Example' });
});

test('made an organization: no first or last; a person again: the name follows what is given', async () => {
  const p = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Old', last_name: 'Person' })).person;
  ok(await mgr.action('person.update', { id: p.id, kind: 'org', name: 'Acme Ltd' }));
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Acme Ltd', first_name: null, last_name: null });
  ok(await mgr.action('person.update', { id: p.id, kind: 'person', first_name: 'Old', last_name: 'Person' }));
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Old Person', first_name: 'Old', last_name: 'Person' });
  const q = ok(await mgr.action('person.create', { kind: 'org', name: 'Two Words' })).person;
  ok(await mgr.action('person.update', { id: q.id, kind: 'person' }));
  assert.deepEqual({ ...(await names(q.id)) }, { name: 'Two Words', first_name: 'Two', last_name: 'Words' }, 'no parts given: the name is split');
});

test('the one-time split leaves a name exactly as written', async () => {
  const p = await mgr.createPerson('Jo  Van Sample');
  await db.query('alter table persons disable trigger persons_names');
  await db.query('update persons set first_name = null, last_name = null where id = $1', [p.id]);
  await db.query('alter table persons enable trigger persons_names');
  const { sql } = await import('../ext/names/index.js');
  await db.exec(sql);
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Jo  Van Sample', first_name: 'Jo Van', last_name: 'Sample' });
});
