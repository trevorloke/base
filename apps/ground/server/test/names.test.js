// First, middle and last names kept apart, the way the campaign's lists
// keep them (ext/names, shared/names.js): every way a person is written fills
// them, and the whole name every screen reads follows them. A whole name is
// split first · middle · last (a van, de… stays with the last name); a first
// name with a second word or an initial is offered as first + middle.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const names = async (id) => (await db.query('select name, first_name, middle_name, last_name from persons where id = $1', [id])).rows[0];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Names', jurisdiction: 'bc-municipal' });
});

test('Add a person with first, middle and last: the whole name follows; the whole alone is split', async () => {
  const a = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Mary', middle_name: 'Anne', last_name: 'Example' })).person;
  assert.deepEqual({ ...(await names(a.id)) }, { name: 'Mary Anne Example', first_name: 'Mary', middle_name: 'Anne', last_name: 'Example' });
  assert.deepEqual([a.name, a.first_name, a.middle_name, a.last_name], ['Mary Anne Example', 'Mary', 'Anne', 'Example'], 'the answer says so too');
  const kept = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Mary Anne', last_name: 'Sample' })).person;
  assert.deepEqual([kept.first_name, kept.middle_name], ['Mary Anne', null], 'a first name as given stays as given (the forms offer the split)');
  const b = await mgr.createPerson('Jo  Van Sample');
  assert.deepEqual({ ...(await names(b.id)) }, { name: 'Jo  Van Sample', first_name: 'Jo', middle_name: null, last_name: 'Van Sample' }, 'van stays with the last name');
  const m = await mgr.createPerson('Riya K. Sample');
  assert.deepEqual({ ...(await names(m.id)) }, { name: 'Riya K. Sample', first_name: 'Riya', middle_name: 'K.', last_name: 'Sample' });
  const d = await mgr.createPerson('Ana Maria de la Example');
  assert.deepEqual({ ...(await names(d.id)) }, { name: 'Ana Maria de la Example', first_name: 'Ana', middle_name: 'Maria', last_name: 'de la Example' });
  const c = await mgr.createPerson('Cher');
  assert.deepEqual({ ...(await names(c.id)) }, { name: 'Cher', first_name: 'Cher', middle_name: null, last_name: null });
  const org = ok(await mgr.action('person.create', { kind: 'org', name: 'Surrey Food Bank' })).person;
  assert.deepEqual({ ...(await names(org.id)) }, { name: 'Surrey Food Bank', first_name: null, middle_name: null, last_name: null }, 'an organization keeps its name whole');
  assert.equal((await mgr.action('person.create', { kind: 'person' })).status, 400, 'no name at all');
});

test('editing: a new last or middle name changes the whole; a new whole name is split again', async () => {
  const p = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Riya', last_name: 'Sample' })).person;
  const u = ok(await mgr.action('person.update', { id: p.id, last_name: 'Example' })).person;
  assert.deepEqual([u.name, u.first_name, u.last_name], ['Riya Example', 'Riya', 'Example']);
  const mid = ok(await mgr.action('person.update', { id: p.id, middle_name: 'K.' })).person;
  assert.deepEqual([mid.name, mid.middle_name], ['Riya K. Example', 'K.']);
  ok(await mgr.action('person.update', { id: p.id, last_name: 'Sample' }));
  assert.equal((await names(p.id)).name, 'Riya K. Sample', 'the middle name stays when the last changes');
  ok(await mgr.action('person.update', { id: p.id, name: 'Riya Kaur Example' }));
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Riya Kaur Example', first_name: 'Riya', middle_name: 'Kaur', last_name: 'Example' });
  const read = ok(await mgr.get(`/api/persons/${p.id}`)).person;
  assert.deepEqual([read.first_name, read.middle_name, read.last_name], ['Riya', 'Kaur', 'Example'], 'the profile reads all three');
});

test('an import keeps the names as the file (and the import screen) has them; the website’s first name with a second word is split', async () => {
  const r = ok(await mgr.post('/api/data/import', { rows: [
    { first: 'Ana Maria', last: 'de la Example', phone: '604-555-0101' },
    { first: 'Ana', middle: 'Maria', last: 'de la Sample', phone: '604-555-0102' },
  ] }));
  assert.equal(r.created, 2);
  const p = (await db.query("select name, first_name, middle_name, last_name from persons where phone = '604-555-0101'")).rows[0];
  assert.deepEqual({ ...p }, { name: 'Ana Maria de la Example', first_name: 'Ana Maria', middle_name: null, last_name: 'de la Example' }, 'as sent (the screen offers the split)');
  const q = (await db.query("select name, first_name, middle_name, last_name from persons where phone = '604-555-0102'")).rows[0];
  assert.deepEqual({ ...q }, { name: 'Ana Maria de la Sample', first_name: 'Ana', middle_name: 'Maria', last_name: 'de la Sample' });
  const key = ok(await mgr.action('intake.key.create', { name: 'Site' })).key;
  const { app } = await import('../index.js');
  const res = await app.request('/in/v1/people', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'Jean Luc', last_name: 'Example', email: 'jl@example.org' }),
  });
  const id = (await res.json()).person_id;
  assert.deepEqual({ ...(await names(id)) }, { name: 'Jean Luc Example', first_name: 'Jean', middle_name: 'Luc', last_name: 'Example' });
  const res2 = await app.request('/in/v1/people', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'Mary-Anne', last_name: 'Example', email: 'ma@example.org' }),
  });
  const id2 = (await res2.json()).person_id;
  assert.deepEqual([(await names(id2)).first_name, (await names(id2)).middle_name], ['Mary-Anne', null], 'hyphenated: one first name');
});

test('made an organization: no first or last; a person again: the name follows what is given', async () => {
  const p = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Old', last_name: 'Person' })).person;
  ok(await mgr.action('person.update', { id: p.id, kind: 'org', name: 'Acme Ltd' }));
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Acme Ltd', first_name: null, middle_name: null, last_name: null });
  ok(await mgr.action('person.update', { id: p.id, kind: 'person', first_name: 'Old', last_name: 'Person' }));
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Old Person', first_name: 'Old', middle_name: null, last_name: 'Person' });
  const q = ok(await mgr.action('person.create', { kind: 'org', name: 'Two Words' })).person;
  ok(await mgr.action('person.update', { id: q.id, kind: 'person' }));
  assert.deepEqual({ ...(await names(q.id)) }, { name: 'Two Words', first_name: 'Two', middle_name: null, last_name: 'Words' }, 'no parts given: the name is split');
});

test('the one-time split leaves a name exactly as written', async () => {
  const p = await mgr.createPerson('Jo  Van Sample');
  await db.query('alter table persons disable trigger persons_names');
  await db.query('update persons set first_name = null, middle_name = null, last_name = null where id = $1', [p.id]);
  await db.query('alter table persons enable trigger persons_names');
  const { sql } = await import('../ext/names/index.js');
  await db.exec(sql);
  assert.deepEqual({ ...(await names(p.id)) }, { name: 'Jo  Van Sample', first_name: 'Jo', middle_name: null, last_name: 'Van Sample' });
});

test('splitFirst: a second word or an initial is a middle name; hyphenated or bracketed is not', async () => {
  const { splitFirst } = await import('@base-ground/shared/names');
  assert.deepEqual(splitFirst('Mary Anne'), { first: 'Mary', middle: 'Anne' });
  assert.deepEqual(splitFirst('John A.'), { first: 'John', middle: 'A.' });
  assert.deepEqual(splitFirst('  Mary-Anne   Jo '), { first: 'Mary-Anne', middle: 'Jo' });
  assert.equal(splitFirst('Mary - Anne'), null);
  assert.equal(splitFirst('Mary-Anne'), null);
  assert.equal(splitFirst('Robert (Bob)'), null);
  assert.equal(splitFirst('Cher'), null);
});
