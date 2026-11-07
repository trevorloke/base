// Voter eligibility (Pick one), Language (Pick several — Surrey's languages)
// and Notes (Long text): standard profile fields (ext/fields). Set on a
// profile, imported, filtered, exported; and added once to a campaign set up
// before they were standard — never put back after a rename.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

let mgr, db, F, ws;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const fieldsBy = async () => Object.fromEntries(ok(await mgr.get('/api/fields')).fields.map((f) => [f.name, f]));

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Std', jurisdiction: 'bc-municipal' })).json.workspace.id;
  F = await fieldsBy();
});

test('a new campaign has them: eligibility (Eligible/Ineligible), Language (12, pick several), Notes (long text)', async () => {
  assert.deepEqual([F['Voter eligibility'].kind, F['Voter eligibility'].choices], ['choice', ['Eligible', 'Ineligible']]);
  assert.equal(F.Language.kind, 'choices');
  assert.equal(F.Language.choices.length, 12);
  assert.ok(['English', 'Punjabi', 'Mandarin', 'Tagalog', 'Cantonese'].every((l) => F.Language.choices.includes(l)));
  assert.equal(F.Notes.kind, 'note');
});

test('on a profile: several languages (in the list’s order), a long note with its lines, eligibility', async () => {
  const p = await mgr.createPerson('Ana Example');
  const note = 'Met at the Newton market.\nPrefers evening calls.\n\n' + 'x'.repeat(1500);
  ok(await mgr.action('field.values.set', { person_id: p.id, values: [
    { field_id: F.Language.id, value: ['Hindi', 'punjabi'] },
    { field_id: F.Notes.id, value: note },
    { field_id: F['Voter eligibility'].id, value: 'eligible' },
  ] }));
  const got = Object.fromEntries(ok(await mgr.get(`/api/persons/${p.id}/fields`)).fields.map((f) => [f.name, f.value]));
  assert.deepEqual(got.Language, ['Punjabi', 'Hindi']);
  assert.equal(got.Notes, note);
  assert.equal(got['Voter eligibility'], 'Eligible');
  assert.equal((await mgr.action('field.values.set', { person_id: p.id, values: [{ field_id: F.Language.id, value: ['Klingon'] }] })).status, 400);
  assert.equal((await mgr.action('field.values.set', { person_id: p.id, values: [{ field_id: F.Notes.id, value: 'y'.repeat(4001) }] })).status, 400);
  ok(await mgr.action('field.values.set', { person_id: p.id, values: [{ field_id: F.Language.id, value: [] }] }));
  const cleared = ok(await mgr.get(`/api/persons/${p.id}/fields`)).fields.find((f) => f.name === 'Language');
  assert.equal(cleared.value, null, 'none picked: cleared');
});

test('import “Punjabi; hindi”, filter by a language, the People export has the three columns', async () => {
  const r = ok(await mgr.post('/api/data/import', { rows: [
    { name: 'Ben Example', phone: '604-555-0102', fields: { Language: 'Punjabi; hindi', 'Voter eligibility': 'Ineligible', Notes: 'Line one' } },
    { name: 'Cy Example', phone: '604-555-0103', fields: { Language: 'Mandarin' } },
    { name: 'Di Example', phone: '604-555-0104', fields: { Language: 'Klingon' } },
  ] }));
  assert.deepEqual([r.created, r.invalid.length], [2, 1]);
  const punjabi = ok(await mgr.get(`/api/persons?field=${F.Language.id}:Punjabi`)).persons.map((p) => p.name);
  assert.deepEqual(punjabi, ['Ben Example']);
  const uses = (await fieldsBy()).Language.uses.map((u) => [u.value, u.n]).sort();
  assert.deepEqual(uses, [['Hindi', 1], ['Mandarin', 1], ['Punjabi', 1]]);
  const res = await app.request('/api/export/people.csv', { headers: { cookie: mgr.cookie } });
  const csv = await res.text();
  const [head, ...lines] = csv.replace(/^﻿/, '').trim().split(/\r\n/);
  const cols = head.split(',');
  assert.ok(['Voter eligibility', 'Language', 'Notes'].every((c) => cols.includes(c)), head);
  const ben = lines.find((l) => l.startsWith('Ben,'));
  assert.match(ben, /Ineligible,Punjabi; Hindi,Line one/);
});

test('a campaign from before gets the three once; one renamed or taken off is never put back', async () => {
  const { sql } = await import('../ext/fields/sql.js');
  await db.query(`delete from person_fields where workspace_id = $1 and name in ('Voter eligibility', 'Language', 'Notes')`, [ws]);
  await db.query('delete from fields_seeded where workspace_id = $1', [ws]);
  await db.exec(sql);
  let names = Object.keys(await fieldsBy());
  assert.ok(['Voter eligibility', 'Language', 'Notes'].every((n) => names.includes(n)), 'added once');
  const notes = (await fieldsBy()).Notes;
  ok(await mgr.action('field.update', { id: notes.id, name: 'Comments' }));
  await db.exec(sql);
  names = Object.keys(await fieldsBy());
  assert.ok(names.includes('Comments') && !names.includes('Notes'), 'renamed: not put back');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('Pick one → Pick several keeps everyone’s choice', async () => {
  const f = ok(await mgr.action('field.create', { name: 'Ward', kind: 'choice', choices: ['North', 'South'] })).field;
  const p = await mgr.createPerson('Eve Example');
  ok(await mgr.action('field.values.set', { person_id: p.id, values: [{ field_id: f.id, value: 'North' }] }));
  ok(await mgr.action('field.update', { id: f.id, kind: 'choices' }));
  const v = ok(await mgr.get(`/api/persons/${p.id}/fields`)).fields.find((x) => x.name === 'Ward').value;
  assert.deepEqual(v, ['North']);
});
