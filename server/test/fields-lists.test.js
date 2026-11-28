// Faith, Dwelling type and Campus as pick lists (ext/fields, shared/fieldlists.js):
// the three lists a new campaign starts with, choice words matched a little
// more loosely (and the same in SQL), a group in the People filter
// ("Christian – *"), standard fields never put back after a rename, what
// "Private" keeps out (volunteers, downloads, backups, the event log,
// tags, and every list handed on), the one-time upgrade of a campaign from
// before, Turn into a list (a Text field with words on file, in chunks,
// stopped and started again), the membership form's Campus, and a move's
// Undo after Dwelling type became a list. test:pg-safe: every query is
// scoped to this file's campaign.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { DWELLING_TYPES, splits, choiceKey, guessChoice, groupsOf } from '@base-win/shared/fieldlists';
import { CHOICE_KEY_SQL } from '../ext/fields/kinds.js';
import { presetFor } from '../lib/preset.js';
import { runDueJobs } from '../lib/jobs.js';

// Imagine Surrey's own lists and fields (the suite runs as its server does:
// helpers.js). Its Campus guesses reach a screen by GET /api/fields.
const { standard: STANDARD_FIELDS, faiths: FAITHS, campuses: CAMPUSES } = presetFor('imagine-surrey').fields;

let db, mgr, staff, treas, vol, volData, volPeople, ws;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const said = (r, status, words, msg = '') => {
  assert.equal(r.status, status, `${msg} ${JSON.stringify(r.json)}`);
  if (words) assert.match(r.json.error, words instanceof RegExp ? words : new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), msg);
};
const fieldsBy = async () => Object.fromEntries(ok(await mgr.get('/api/fields')).fields.filter((f) => !f.retired).map((f) => [f.name, f]));
const valuesOf = async (c, id) => Object.fromEntries(ok(await c.get(`/api/persons/${id}/fields`)).fields.map((f) => [f.name, f.value]));
const setOne = (c, personId, fieldId, value) => c.action('field.values.set', { person_id: personId, values: [{ field_id: fieldId, value }] });
const tag = randomUUID().slice(0, 6);
const invite = async (role, grant = []) => {
  const inv = ok(await mgr.action('member.invite', { email: `fl-${role}-${grant.join('')}-${tag}@example.org`, role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'lists-pass-2026' }));
  if (grant.length) ok(await mgr.action('permission.member.set', { user_id: j.user.id, grant, deny: [] }));
  return c;
};
const runJobs = async () => {
  for (let i = 0; i < 50; i += 1) {
    const n = (await db.query("select count(*)::int as n from jobs where workspace_id = $1 and status = 'pending' and run_at <= now()", [ws])).rows[0].n;
    if (!n) return;
    await runDueJobs(db, { workspaceId: ws });
  }
};
const csvOf = async (c, path) => {
  const res = await app.request(path, { headers: { cookie: c.cookie } });
  return { status: res.status, text: await res.text() };
};
const today = new Date().toISOString().slice(0, 10);
const form = (extra) => mgr.action('membership.enter', {
  first_name: 'Form', last_name: `Example ${randomUUID().slice(0, 4)}`, term: 1, method: 'cheque', signed: true, signed_on: today,
  languages: [], interests: [], ...extra,
});

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Lists ${tag}`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  staff = await invite('staff');
  treas = await invite('treasurer');
  vol = await invite('volunteer');
  volData = await invite('volunteer', ['data']);
  volPeople = await invite('volunteer', ['people']);
});

test('a new campaign has Faith (private), Dwelling type (a scroll-down list) and Campus (three buttons), and their seeds', async () => {
  const F = await fieldsBy();
  assert.equal(STANDARD_FIELDS.length, 27);
  assert.deepEqual([F.Faith.kind, F.Faith.sensitive, F.Faith.volunteers, F.Faith.display], ['choice', true, false, 'buttons']);
  assert.deepEqual(F.Faith.choices, FAITHS);
  assert.equal(FAITHS.length, 29);
  assert.equal(groupsOf(FAITHS).find((g) => g.group === 'Christian').members[0].short, 'Just Christian (no church named)');
  assert.deepEqual([F['Dwelling type'].kind, F['Dwelling type'].display, F['Dwelling type'].volunteers], ['choice', 'list', true]);
  assert.deepEqual(F['Dwelling type'].choices, DWELLING_TYPES);
  assert.deepEqual([F.Campus.kind, F.Campus.display, F.Campus.volunteers, F.Campus.choices], ['choice', 'buttons', false, CAMPUSES]);
  assert.equal(groupsOf(CAMPUSES).length, 3, 'Campus’s two Kwantlen choices stay two plain buttons');
  const seeds = (await db.query('select name from fields_seeded where workspace_id = $1', [ws])).rows.map((r) => r.name);
  for (const s of ['Faith', 'Dwelling type list', 'Campus list', 'Gender', 'Notes']) assert.ok(seeds.includes(s), s);
  assert.equal([...FAITHS, ...DWELLING_TYPES, ...CAMPUSES].filter(splits).length, 0, 'no choice reads as two in Pick several');
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'fields.lists'", [ws])).rows[0].n, 0, 'no upgrade job');
});

test('choice words match a little more loosely, and CHOICE_KEY_SQL agrees with choiceKey', async () => {
  const F = await fieldsBy();
  const p = await mgr.createPerson('Loose Example');
  for (const [given, stored] of [['christian - catholic', 'Christian – Catholic'], ["Christian – Jehovah's Witness", 'Christian – Jehovah’s Witness'], ['CHRISTIAN – CATHOLIC', 'Christian – Catholic']]) {
    ok(await setOne(mgr, p.id, F.Faith.id, given), given);
    assert.equal((await valuesOf(mgr, p.id)).Faith, stored, given);
  }
  said(await setOne(mgr, p.id, F['Dwelling type'].id, 'Low-rise apartment (1-4 floors)'), 400, 'isn’t one of the choices', '"1-4" is not "1–4"');
  ok(await setOne(mgr, p.id, F['Dwelling type'].id, 'low-rise apartment (1–4 floors)'));
  // An import cell, too.
  const r = ok(await mgr.post('/api/data/import', { rows: [{ name: 'Cell Example', phone: '604-555-0170', fields: { Faith: 'christian - anglican', 'Dwelling type': ' house ' } }] }));
  assert.equal(r.created, 1);
  const tricky = [
    'House', ' house ', 'HOUSE', 'house\t', ' House ', 'Christian - Catholic', 'Christian — Catholic', 'Christian–Catholic',
    'Christian  –  Catholic', 'Christian\t-\tCatholic', '1–4', '1-4', '1 - 4', 'Jehovah’s', 'Jehovah‘s', "Jehovah's", 'Seniors’ or care home',
    'A - B', 'a — b', 'Ünïcode', '  ', '', 'x y', 'Line\nbreak', 'Tab\there', '5+ floors', 'rv/boat', 'A -B', 'A- B', 'Á – É',
  ];
  assert.equal(tricky.length, 30);
  const sql = (await db.query(`select ${CHOICE_KEY_SQL('w')} as k, i from unnest($1::text[]) with ordinality as t(w, i) order by i`, [tricky])).rows.map((x) => x.k);
  assert.deepEqual(sql, tricky.map(choiceKey));
  assert.equal(guessChoice('Dwelling type', 'Basement suite', DWELLING_TYPES), 'Suite in a house (basement or upper)');
  assert.equal(guessChoice('Dwelling type', 'apartment', DWELLING_TYPES), null, 'a bare apartment waits for a person');
  const { guesses } = ok(await mgr.get('/api/fields'));
  assert.equal(guessChoice('Campus', 'kwantlen', CAMPUSES, guesses), null);
  assert.equal(guessChoice('Campus', 'KPU Newton', CAMPUSES, guesses), 'Kwantlen Polytechnic University – Surrey');
});

test('People can filter Faith by a group: “Christian – *”', async () => {
  const F = await fieldsBy();
  const cath = await mgr.createPerson('Cath Example');
  const just = await mgr.createPerson('Just Example');
  const sikh = await mgr.createPerson('Sikh Example');
  ok(await setOne(mgr, cath.id, F.Faith.id, 'Christian – Catholic'));
  ok(await setOne(mgr, just.id, F.Faith.id, 'Christian – Just Christian (no church named)'));
  ok(await setOne(mgr, sikh.id, F.Faith.id, 'Sikh'));
  const names = async (want) => ok(await mgr.get(`/api/persons?field=${F.Faith.id}:${encodeURIComponent(want)}&limit=200`)).persons.map((p) => p.name).sort();
  const any = await names('Christian – *');
  assert.ok(any.includes('Cath Example') && any.includes('Just Example') && !any.includes('Sikh Example'), any.join());
  assert.deepEqual(await names('Nothing – *'), []);
  assert.deepEqual(await names('Sikh'), ['Sikh Example']);
});

test('a standard field renamed or taken off is never put back by a membership form; the manager’s button still adds what is missing', async () => {
  let F = await fieldsBy();
  ok(await mgr.action('field.update', { id: F.Faith.id, name: 'Religion' }));
  ok(await form({}));
  F = await fieldsBy();
  assert.ok(F.Religion && !F.Faith, 'renamed: no second Faith');
  ok(await mgr.action('field.retire', { id: F.Religion.id }));
  ok(await form({}));
  assert.ok(!(await fieldsBy()).Faith, 'taken off: still off');
  ok(await mgr.action('field.retire', { id: F.Campus.id }));
  const r = ok(await form({ campus: 'SFU Surrey' }));
  assert.ok(r.warnings.includes('There’s no Campus field — “SFU Surrey” wasn’t saved.'), r.warnings.join(' | '));
  assert.ok(r.membership && r.person);
  const added = ok(await mgr.action('field.standard', {})).added.map((f) => f.name).sort();
  assert.deepEqual(added, ['Campus', 'Faith']);
  // Back as they were for the tests below: the added ones go, the originals come back.
  F = await fieldsBy();
  ok(await mgr.action('field.retire', { id: F.Faith.id }));
  ok(await mgr.action('field.retire', { id: F.Campus.id }));
  const off = ok(await mgr.get('/api/fields')).fields.filter((f) => f.retired);
  for (const f of off.filter((x) => (x.name === 'Religion' || x.name === 'Campus') && x.choices.length && x.id !== F.Campus.id)) ok(await mgr.action('field.restore', { id: f.id }));
  F = await fieldsBy();
  ok(await mgr.action('field.update', { id: F.Religion.id, name: 'Faith' }));
  assert.ok((await fieldsBy()).Faith.sensitive);
});

test('Private keeps Faith from volunteers, downloads, backups, the event log and tags', async () => {
  const F = await fieldsBy();
  const p = await mgr.createPerson('Priv Example', { phone: '604-555-0171' });
  ok(await setOne(mgr, p.id, F.Faith.id, 'Hindu'));
  ok(await setOne(mgr, p.id, F['Dwelling type'].id, 'House'));
  ok(await setOne(staff, p.id, F.Faith.id, 'Buddhist'), 'staff record it');
  ok(await setOne(treas, p.id, F.Faith.id, 'Hindu'), 'a treasurer records it');
  // Volunteers.
  const v = await valuesOf(vol, p.id);
  assert.ok(!('Faith' in v) && v['Dwelling type'] === 'House', JSON.stringify(v));
  assert.ok(!('Faith' in (await valuesOf(volPeople, p.id))));
  said(await mgr.action('field.update', { id: F.Faith.id, volunteers: true }), 400, 'A private field can’t be shown to volunteers');
  said(await mgr.action('field.create', { name: 'Secret', kind: 'text', sensitive: true, volunteers: true }), 400, 'A private field can’t be shown to volunteers');
  said(await setOne(volPeople, p.id, F.Faith.id, 'Sikh'), 403, 'Only the office records Faith');
  ok(await setOne(volPeople, p.id, F['Dwelling type'].id, 'Townhouse or row house'), 'People granted: other fields as today');
  // The People CSV.
  const plain = await csvOf(mgr, '/api/export/people.csv');
  assert.equal(plain.status, 200);
  assert.ok(!plain.text.split(/\r?\n/)[0].split(',').includes('Faith'), 'no Faith column');
  assert.ok(plain.text.split(/\r?\n/)[0].split(',').includes('Dwelling type'));
  const priv = await csvOf(mgr, '/api/export/people.csv?private=1');
  assert.ok(priv.text.split(/\r?\n/)[0].split(',').includes('Faith'));
  assert.match(priv.text, /Hindu/);
  const st = await csvOf(staff, '/api/export/people.csv?private=1');
  assert.equal(st.status, 403);
  assert.match(st.text, /Only a manager can download private fields/);
  // The full backup and the event log.
  const faithEvents = (out) => out.events.filter((e) => e.entity_type === 'person_field_value' && (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload).field_id === F.Faith.id);
  for (const [who, c] of [['staff', staff], ['treasurer', treas], ['volunteer granted Data', volData]]) {
    const out = ok(await c.get('/api/export'), who);
    assert.deepEqual(out.left_out, { private_fields: ['Faith'], why: 'Only a manager’s backup carries private fields' }, who);
    assert.equal(out.person_field_values.filter((r) => r.field_id === F.Faith.id).length, 0, who);
    const evs = faithEvents(out);
    assert.ok(evs.length >= 3, who);
    assert.ok(evs.every((e) => e.payload.value === null && e.payload.was === null && e.payload.private === true), who);
    const valueWords = (evs2) => JSON.stringify(evs2.filter((e) => e.entity_type === 'person_field_value'));
    assert.ok(!valueWords(out.events).includes('Hindu') && !valueWords(out.events).includes('Buddhist'), `${who}: no Faith value in any event`);
    const log = ok(await c.get('/api/events?since=0&limit=1000'), who);
    assert.ok(!valueWords(log.events).includes('Hindu') && valueWords(log.events).includes('House'), `${who}: the event log`);
  }
  const all = ok(await mgr.get('/api/export'));
  assert.equal(all.left_out, undefined);
  assert.ok(all.person_field_values.some((r) => r.field_id === F.Faith.id));
  assert.ok(faithEvents(all).some((e) => e.payload.value === 'Hindu'));
  assert.ok(JSON.stringify(ok(await mgr.get('/api/events?since=0&limit=1000')).events.filter((e) => e.entity_type === 'person_field_value')).includes('Hindu'));
  // Never a tag.
  said(await mgr.post('/api/data/import', { rows: [{ name: 'Tag Example', fields: { [F.Faith.id]: 'Sikh' } }], past: { year: 2022, field_tags: [F.Faith.id] } }), 400, 'Faith is private — it can’t become a tag');
  // People and the desk still filter by it.
  const names = ok(await staff.get(`/api/persons?field=${F.Faith.id}:Hindu`)).persons.map((x) => x.name);
  assert.deepEqual(names, ['Priv Example']);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('a list picked by Faith is never walked, called, sent to CallHub, emailed, texted or copied', async () => {
  const F = await fieldsBy();
  const p = await mgr.createPerson('Faith Pick Example', { phone: '604-555-0172', email: `pick-${tag}@example.org` });
  ok(await setOne(mgr, p.id, F.Faith.id, 'Sikh'));
  const filter = { field: `${F.Faith.id}:Sikh` };
  const list = ok(await mgr.action('list.create', { name: 'By faith', kind: 'filter', filter })).list;
  const outer = ok(await mgr.action('list.create', { name: 'On that list', kind: 'filter', filter: { list: list.id } })).list;
  const plainOne = ok(await mgr.action('list.create', { name: 'Not by faith', kind: 'filter', filter: { q: 'Faith Pick' } })).list;
  const WORDS = 'This list picks people by Faith, which is private — it can’t be walked, called, sent to CallHub, emailed, texted or copied.';
  const body = `Hello from Lists ${tag}. Reply STOP to stop.`;
  said(await mgr.action('blast.send', { kind: 'eblast', subject: 'Hi', body: 'Hello there.', audience: { filter } }), 409, WORDS, 'email to the filter');
  said(await mgr.action('blast.send', { kind: 'eblast', subject: 'Hi', body: 'Hello there.', audience: { list_id: list.id } }), 409, WORDS, 'email to the list');
  said(await mgr.action('blast.send', { kind: 'eblast', subject: 'Hi', body: 'Hello there.', audience: { list_id: outer.id } }), 409, WORDS, 'a list naming it');
  said(await mgr.action('blast.send', { kind: 'text', body, audience: { list_id: list.id } }), 409, WORDS, 'a text');
  said(await mgr.get(`/api/callhub/preview?list=${list.id}`), 409, WORDS, 'CallHub');
  said(await mgr.action('bank.create', { name: 'Faith calls', list_id: list.id }), 409, WORDS, 'a phone bank');
  said(await mgr.action('pass.start', { name: 'Faith walk', kind: 'persuasion', list_id: list.id }), 409, WORDS, 'a pass');
  said(await mgr.action('list.snapshot', { name: 'Copy', filter }), 409, WORDS, 'a copy of the filter');
  said(await mgr.action('list.snapshot', { name: 'Copy', list_id: list.id }), 409, WORDS, 'a copy of the list');
  // Mailchimp: refused at the tap (when connected, before anything goes).
  const { startSync } = await import('../ext/mailchimp/push.js');
  await assert.rejects(db.transaction((tx) => startSync(tx, { workspaceId: ws }, () => {}, { list_id: list.id, audience: 'aud1' })), (e) => e.status === 409 && e.message === WORDS);
  // Its CSV and a Sheet: a manager's only, as the People download's ?private=1.
  const staffCsv = await csvOf(staff, `/api/lists/${list.id}/export.csv`);
  assert.equal(staffCsv.status, 403, 'staff: no CSV of who is Sikh');
  assert.match(staffCsv.text, /Only a manager can take out a list picked by a private field/);
  assert.equal((await csvOf(staff, `/api/lists/${outer.id}/export.csv`)).status, 403, 'nor of a list naming it');
  assert.equal((await csvOf(mgr, `/api/lists/${list.id}/export.csv`)).status, 200, 'a manager may');
  assert.equal((await csvOf(staff, `/api/lists/${plainOne.id}/export.csv`)).status, 200, 'a plain list as before');
  // The desk says it under the list picker: the same words as the refusal.
  assert.equal(ok(await staff.get(`/api/lists/${list.id}/hand-on`)).refused, WORDS);
  assert.equal(ok(await staff.get(`/api/lists/${plainOne.id}/hand-on`)).refused, null);
  const { sourceOf } = await import('../ext/drive/export.js');
  await assert.rejects(sourceOf(db, { workspaceId: ws, role: 'staff', user: { id: null } }, 'list', list.id), (e) => e.status === 403);
  // Google Sheets never gets it, a manager's included: the Sheet would say who is Sikh.
  await assert.rejects(sourceOf(db, { workspaceId: ws, role: 'manager', user: { id: null } }, 'list', list.id),
    (e) => e.status === 403 && e.message === 'Google Sheets never gets private fields');
  await assert.rejects(sourceOf(db, { workspaceId: ws, role: 'manager', user: { id: null } }, 'list', outer.id), (e) => e.status === 403, 'nor a list naming it');
  assert.ok(await sourceOf(db, { workspaceId: ws, role: 'manager', user: { id: null } }, 'list', plainOne.id), 'a plain list as before');
  // The office still counts it and filters by it.
  assert.equal(ok(await mgr.get(`/api/lists/${list.id}/counts?fresh=1`)).counts.total, 2, 'Sikh Example and Faith Pick Example');
  // A pass walks a plain list; changed to Faith afterwards → refused, or (a
  // list inside it) nobody at the door.
  const plain = ok(await mgr.action('list.create', { name: 'Plain', kind: 'filter', filter: { q: 'Faith Pick' } })).list;
  const walked = ok(await mgr.action('list.create', { name: 'Walked', kind: 'filter', filter: { list: plain.id } })).list;
  const pass = ok(await mgr.action('pass.start', { name: 'Walk', kind: 'persuasion', list_id: walked.id })).pass;
  said(await mgr.action('pass.update', { id: pass.id, list_id: list.id }), 409, WORDS, 'pass.update');
  said(await mgr.action('list.update', { id: walked.id, filter }), 409, WORDS, 'list.update on the walked list');
  ok(await mgr.action('list.update', { id: plain.id, filter }), 'the list inside it changes');
  const { listedWhere } = await import('../ext/passes/rule.js');
  const w = await listedWhere(db, { workspaceId: ws, role: 'volunteer', user: { id: null, email: '' } }, pass);
  assert.equal((await db.query(`select count(*)::int as n from persons p where ${w.where}`, w.params)).rows[0].n, 0, 'nobody at the door');
  const asDesk = ok(await mgr.get(`/api/persons?list=${walked.id}`)).persons.map((x) => x.name);
  assert.deepEqual(asDesk.sort(), ['Faith Pick Example', 'Sikh Example'], 'the office still sees who the list names');
  ok(await mgr.action('pass.end', { id: pass.id }));
});

test('display, Private and Pick several rules', async () => {
  said(await mgr.action('field.create', { name: 'Notes two', kind: 'text', display: 'list' }), 400, 'Only a Pick one field can be a scroll-down list');
  const f = ok(await mgr.action('field.create', { name: 'Home kind', kind: 'choice', choices: ['Other (boat, RV)', 'House'], display: 'list' })).field;
  assert.equal(f.display, 'list');
  said(await mgr.action('field.update', { id: f.id, kind: 'choices' }), 409, '“Other (boat, RV)” has a comma or slash in it, which Pick several reads as two choices — change its words first');
  ok(await mgr.action('field.update', { id: f.id, choices: ['Other (boat or RV)', 'House'] }));
  const g = ok(await mgr.action('field.update', { id: f.id, kind: 'choices' })).field;
  assert.equal(g.display, 'buttons', 'Pick several is buttons');
  said(await mgr.action('field.update', { id: f.id, choices: ['Other (boat or RV)', 'House', 'Flat/condo'] }), 400, 'has a comma or slash');
  ok(await mgr.action('field.retire', { id: f.id }));
});

test('a campaign from before: the upgrade job adds Faith once, makes an empty Dwelling type and Campus lists, and leaves the rest', async () => {
  const { sql } = await import('../ext/fields/sql.js');
  // As a campaign from before: Faith gone, Dwelling type and Campus Text.
  let F = await fieldsBy();
  await db.query("delete from person_field_values where workspace_id = $1 and field_id = any($2::uuid[])", [ws, [F.Faith.id, F['Dwelling type'].id, F.Campus.id]]);
  await db.query("delete from person_fields where workspace_id = $1 and lower(name) in ('faith', 'dwelling type as written', 'campus as written')", [ws]);
  await db.query("update person_fields set kind = 'text', choices = '[]', display = 'buttons' where workspace_id = $1 and name in ('Dwelling type', 'Campus')", [ws]);
  await db.query("delete from fields_seeded where workspace_id = $1 and name in ('Faith', 'Dwelling type list', 'Campus list')", [ws]);
  await db.query("delete from jobs where workspace_id = $1 and key = 'fields-lists-1'", [ws]);
  F = await fieldsBy();
  const p = await mgr.createPerson('Old Example');
  ok(await setOne(mgr, p.id, F['Dwelling type'].id, 'Basement suite'));
  await db.exec(sql());
  await db.exec(sql());
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'fields.lists'", [ws])).rows[0].n, 1, 'one job');
  await runJobs();
  F = await fieldsBy();
  assert.equal(F.Faith.kind, 'choice');
  assert.ok(F.Faith.sensitive);
  assert.equal(F.Campus.kind, 'choice', 'empty Campus: a list');
  assert.deepEqual(F.Campus.choices, CAMPUSES);
  assert.equal(F['Dwelling type'].kind, 'text', 'with words on file: left for a manager');
  const seeds = (await db.query('select name from fields_seeded where workspace_id = $1', [ws])).rows.map((r) => r.name);
  assert.ok(seeds.includes('Faith') && seeds.includes('Campus list') && !seeds.includes('Dwelling type list'));
  // Twice changes nothing; a renamed or taken-off field is left alone.
  const before = (await db.query('select count(*)::int as n from events where workspace_id = $1', [ws])).rows[0].n;
  await db.query("delete from jobs where workspace_id = $1 and key = 'fields-lists-1'", [ws]);
  await db.exec(sql());
  await runJobs();
  assert.equal((await db.query('select count(*)::int as n from events where workspace_id = $1', [ws])).rows[0].n, before, 'nothing again');
  const evs = (await db.query("select payload from events where workspace_id = $1 and action = 'field.standard.lists'", [ws])).rows.map((r) => r.payload);
  assert.equal(evs.length, 2, 'Faith added and Campus made a list, each an event');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('Turn into a list: 3,000 values, mapped words, words kept as written, stop and start again', async () => {
  let F = await fieldsBy();
  const dwell = F['Dwelling type'];
  assert.equal(dwell.kind, 'text');
  // 3,000 people with words (in SQL: quick).
  const words = ['House', 'house', 'Apt', 'Townhouse', 'bsmt suite', 'Kwantlen'];
  await db.query(
    `insert into persons (id, workspace_id, name) select gen_random_uuid(), $1, 'Bulk Example ' || i from generate_series(1, 3000) i`, [ws],
  );
  await db.query(
    `insert into person_field_values (id, workspace_id, field_id, person_id, value)
     select gen_random_uuid(), $1, $2, p.id, to_jsonb(($3::text[])[1 + (row_number() over (order by p.id))::int % 6])
       from persons p where p.workspace_id = $1 and p.name like 'Bulk Example %'`, [ws, dwell.id, words],
  );
  const someone = (await db.query("select id from persons where workspace_id = $1 and name = 'Bulk Example 7'", [ws])).rows[0].id;
  const bsmt = (await db.query(
    `select p.id from persons p join person_field_values v on v.person_id = p.id and v.field_id = $2 where p.workspace_id = $1 and v.value = '"bsmt suite"' limit 1`, [ws, dwell.id],
  )).rows[0].id;
  F = await fieldsBy();
  assert.ok(F['Dwelling type'].suits, 'it suits a list');
  const w = ok(await mgr.get(`/api/fields/${dwell.id}/words`));
  assert.equal(w.people, 3001);
  const house = w.words.find((x) => choiceKey(x.word) === 'house');
  assert.equal(house.n, 1000, '“House” and “house” are one word');
  assert.equal(w.distinct, 6, 'and “Basement suite” from the campaign from before');
  said(await staff.get(`/api/fields/${dwell.id}/words`), 403);
  const map = [{ word: 'Apt', to: 'Low-rise apartment (1–4 floors)' }, { word: 'Townhouse', to: 'Townhouse or row house' }, { word: 'bsmt suite', to: null }];
  said(await mgr.action('field.list.start', { id: dwell.id, choices: DWELLING_TYPES, display: 'list', map: [{ word: 'Flat', to: 'Apartment' }] }), 400, '“Flat” → “Apartment” isn’t one of the choices');
  // The person with bsmt suite already has an "as written" value: both words are kept.
  const start = ok(await mgr.action('field.list.start', { id: dwell.id, choices: DWELLING_TYPES, display: 'list', map }));
  assert.equal(start.total, 3001);
  assert.equal(start.kept, 1001, 'bsmt suite (500), Kwantlen (500) and Basement suite (1)');
  F = await fieldsBy();
  const keepF = F['Dwelling type as written'];
  assert.equal(keepF.as_written_of, dwell.id);
  assert.equal(keepF.position, F['Dwelling type'].position + 1, 'right after it');
  assert.deepEqual(F['Dwelling type'].converting, { done: 0, total: 3001 });
  ok(await setOne(mgr, bsmt, keepF.id, 'Upper floor'));
  said(await setOne(mgr, someone, dwell.id, 'House'), 409, '“Dwelling type” is being turned into a list — try again later');
  said(await mgr.action('field.update', { id: dwell.id, name: 'X' }), 409, 'try again later');
  said(await mgr.action('field.list.start', { id: dwell.id, choices: DWELLING_TYPES, map }), 409, 'is already being turned into a list');
  const imp = ok(await mgr.post('/api/data/import', { rows: [{ name: 'During Example', fields: { 'Dwelling type': 'House' } }] }));
  assert.match(imp.invalid[0]?.error || JSON.stringify(imp.invalid), /being turned into a list — try again later/);
  // One run does at most ten chunks: here, two then stopped.
  const { stepJob } = await import('../ext/fields/convert.js');
  const job = (await db.query("select * from jobs where workspace_id = $1 and kind = 'field.list.step' and status = 'pending'", [ws])).rows[0];
  const plan = (await db.query('select converting from person_fields where id = $1', [dwell.id])).rows[0].converting;
  // A Stop that lands mid-run: the next chunk re-reads the plan and stops.
  ok(await mgr.action('field.list.stop', { id: dwell.id }));
  assert.deepEqual(await stepJob(db, { ...job, payload: { field_id: dwell.id, key: plan.key } }), {});
  F = await fieldsBy();
  assert.equal(F['Dwelling type'].kind, 'text');
  assert.equal(F['Dwelling type'].converting, null);
  // Start again, and a chunk at a time by hand: halfway, then Stop.
  const again = ok(await mgr.action('field.list.start', { id: dwell.id, choices: DWELLING_TYPES, display: 'list', map }));
  const plan2 = (await db.query('select converting from person_fields where id = $1', [dwell.id])).rows[0].converting;
  assert.notEqual(plan2.key, plan.key, 'a fresh job key');
  assert.equal(again.total, 3001);
  await runDueJobs(db, { workspaceId: ws, limit: 1 });
  const mid = (await fieldsBy())['Dwelling type'];
  assert.ok(mid.kind === 'choice' || mid.converting, 'running or done');
  await runJobs();
  F = await fieldsBy();
  assert.equal(F['Dwelling type'].kind, 'choice');
  assert.equal(F['Dwelling type'].display, 'list');
  assert.equal(F['Dwelling type'].converting, null);
  const vals = (await db.query('select value from person_field_values where workspace_id = $1 and field_id = $2', [ws, dwell.id])).rows.map((r) => r.value);
  assert.ok(vals.every((v) => DWELLING_TYPES.includes(v)), 'every value is a choice');
  assert.equal(vals.filter((v) => v === 'House').length, 1000);
  assert.equal(vals.filter((v) => v === 'Low-rise apartment (1–4 floors)').length, 500);
  const kept = (await db.query('select value from person_field_values where workspace_id = $1 and field_id = $2', [ws, keepF.id])).rows.map((r) => r.value);
  assert.equal(kept.length, 1001);
  assert.equal(kept.filter((v) => v === 'Kwantlen').length, 500);
  const both = (await db.query('select value from person_field_values where field_id = $1 and person_id = $2', [keepF.id, bsmt])).rows[0].value;
  assert.equal(both, 'Upper floor; bsmt suite', 'an earlier “as written” value keeps both words');
  // Each value one event (this run's: updates for those mapped, a void for those kept).
  const evs = (await db.query(
    `select entity_id, op from events where workspace_id = $1 and action = 'field.list.step' and entity_type = 'person_field_value' and payload->>'field_id' = $2`, [ws, dwell.id],
  )).rows;
  assert.equal(new Set(evs.map((e) => e.entity_id)).size, evs.length, 'never two events for one value');
  assert.equal(evs.length, 3001 - 1000 + 500, 'House as typed stays; house, Apt, Townhouse, bsmt suite, Kwantlen and Basement suite move');
  const seeds = (await db.query('select name from fields_seeded where workspace_id = $1', [ws])).rows.map((r) => r.name);
  assert.ok(seeds.includes('Dwelling type list'));
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
  // Turned back into Text, then into a list again: it finishes.
  ok(await mgr.action('field.update', { id: dwell.id, kind: 'text' }));
  ok(await mgr.action('field.list.start', { id: dwell.id, choices: DWELLING_TYPES, display: 'list', map: [] }));
  await runJobs();
  assert.equal((await fieldsBy())['Dwelling type'].kind, 'choice');
});

test('Turn into a list refuses a field whose words are mostly different, and with no room for the words it can’t take', async () => {
  const f = ok(await mgr.action('field.create', { name: 'Doorstep words', kind: 'text' })).field;
  await db.query(
    `insert into person_field_values (id, workspace_id, field_id, person_id, value)
     select gen_random_uuid(), $1, $2, p.id, to_jsonb('word ' || row_number() over (order by p.id))
       from persons p where p.workspace_id = $1 and p.name like 'Bulk Example %' limit 2000`, [ws, f.id],
  );
  const F = await fieldsBy();
  assert.deepEqual([F['Doorstep words'].words, F['Doorstep words'].suits], [2000, false]);
  assert.ok(F['Doorstep words'].top40 === 40);
  said(await mgr.get(`/api/fields/${f.id}/words`), 409, 'Its words are mostly different — it doesn’t suit a list');
  said(await mgr.action('field.list.start', { id: f.id, choices: ['A', 'B'] }), 409, 'doesn’t suit a list');
  // 40 fields and words to keep: refused, nothing changed.
  const g = ok(await mgr.action('field.create', { name: 'Shoe size', kind: 'text' })).field;
  const p = await mgr.createPerson('Shoe Example');
  ok(await setOne(mgr, p.id, g.id, 'Nine'));
  const live = ok(await mgr.get('/api/fields')).fields.filter((x) => !x.retired).length;
  for (let i = live; i < 40; i += 1) ok(await mgr.action('field.create', { name: `Filler ${i}`, kind: 'yesno' }));
  said(await mgr.action('field.list.start', { id: g.id, choices: ['Small', 'Large'], map: [] }), 400, 'take one off first');
  assert.equal((await fieldsBy())['Shoe size'].converting, null);
  for (const x of ok(await mgr.get('/api/fields')).fields.filter((y) => y.name.startsWith('Filler '))) ok(await mgr.action('field.retire', { id: x.id }));
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('import: words kept as written go to “<list> as written”, made by the import; a dry run makes nothing', async () => {
  const f = ok(await mgr.action('field.create', { name: 'Shoe style', kind: 'choice', choices: ['Boot', 'Sandal'] })).field;
  const row = (name, word) => ({ name, phone: '604-555-0177', fields: { [f.id]: '', [`as_written:${f.id}`]: word } });
  const dry = ok(await mgr.post('/api/data/import', { rows: [row('Clog Example', 'Clog')], as_written: [f.id], dryRun: true }));
  assert.equal(dry.invalid.length, 0, JSON.stringify(dry.invalid));
  assert.equal((await fieldsBy())['Shoe style as written'], undefined);
  const r = ok(await mgr.post('/api/data/import', { rows: [row('Clog Example', 'Clog')], as_written: [f.id] }));
  assert.equal(r.invalid.length, 0, JSON.stringify(r.invalid));
  const F = await fieldsBy();
  assert.equal(F['Shoe style as written'].as_written_of, f.id);
  assert.equal(F['Shoe style as written'].kind, 'text');
  const made = (await db.query(
    `select payload from events where workspace_id = $1 and entity_type = 'person_field' and entity_id = $2 and op = 'create'`,
    [ws, F['Shoe style as written'].id],
  )).rows[0];
  assert.equal(JSON.parse(typeof made.payload === 'string' ? made.payload : JSON.stringify(made.payload)).by_import, true);
  const p = (await db.query("select id from persons where workspace_id = $1 and name = 'Clog Example'", [ws])).rows[0];
  const v = await valuesOf(mgr, p.id);
  assert.deepEqual([v['Shoe style'], v['Shoe style as written']], [null, 'Clog']);
  // Again: the same field, no second one.
  ok(await mgr.post('/api/data/import', { rows: [row('Mule Example', 'Mule')], as_written: [f.id] }));
  assert.equal(ok(await mgr.get('/api/fields')).fields.filter((x) => x.name === 'Shoe style as written').length, 1);
  ok(await mgr.action('field.retire', { id: F['Shoe style as written'].id }));
  ok(await mgr.action('field.retire', { id: f.id }));
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('import: a list taken off between Check and Import refuses the file, naming it — no kept word is dropped', async () => {
  const f = ok(await mgr.action('field.create', { name: 'Shoe', kind: 'choice', choices: ['Boot', 'Sandal'] })).field;
  const row = { name: 'Gone Example', phone: '604-555-0178', fields: { [`as_written:${f.id}`]: 'Clog' } };
  ok(await mgr.action('field.retire', { id: f.id }));
  for (const dryRun of [true, false]) said(await mgr.post('/api/data/import', { rows: [row], as_written: [f.id], dryRun }), 409, 'Shoe was taken off — check the file again');
  assert.equal((await db.query("select 1 from persons where workspace_id = $1 and name = 'Gone Example'", [ws])).rows.length, 0);
  // A list that isn't there at all.
  said(await mgr.post('/api/data/import', { rows: [row], as_written: ['00000000-0000-4000-8000-000000000000'] }), 409, 'taken off');
});

test('membership form: Campus a choice; other words in Notes (kept), never refusing the form', async () => {
  const F = await fieldsBy();
  const r1 = ok(await form({ campus: 'kwantlen polytechnic university - surrey' }));
  assert.equal((await valuesOf(mgr, r1.person.id)).Campus, 'Kwantlen Polytechnic University – Surrey');
  const p = await mgr.createPerson('Noted Example');
  ok(await setOne(mgr, p.id, F.Notes.id, 'Met at the market.'));
  const r2 = ok(await form({ person_id: p.id, campus: 'Kwantlen', once: { kind: 'amount', amount_cents: 2500 } }));
  assert.ok(r2.membership && r2.gifts.length, 'the membership and the gift are saved');
  const v2 = await valuesOf(mgr, p.id);
  assert.equal(v2.Campus, null);
  assert.equal(v2.Notes, 'Met at the market.\nCampus on the form: Kwantlen');
  assert.ok(r2.warnings.includes('Campus “Kwantlen” isn’t one of the choices — it’s in their Notes.'), r2.warnings.join(' | '));
  const q = await mgr.createPerson('Full Example');
  const full = 'n'.repeat(3990);
  ok(await setOne(mgr, q.id, F.Notes.id, full));
  const r3 = ok(await form({ person_id: q.id, campus: 'UBC' }));
  assert.ok(r3.membership);
  assert.equal((await valuesOf(mgr, q.id)).Notes, full, 'Notes unchanged');
  assert.ok(r3.warnings.includes('Campus “UBC” isn’t one of the choices — it wasn’t saved (their Notes are full).'), r3.warnings.join(' | '));
  // Campus still Text: as typed. Being turned into a list: left out.
  ok(await mgr.action('field.update', { id: F.Campus.id, kind: 'text' }));
  const r4 = ok(await form({ campus: 'UBC' }));
  assert.equal((await valuesOf(mgr, r4.person.id)).Campus, 'UBC');
  ok(await mgr.action('field.list.start', { id: F.Campus.id, choices: CAMPUSES, display: 'buttons', map: [] }));
  const r5 = ok(await form({ campus: 'SFU Surrey' }));
  assert.ok(r5.warnings.includes('Campus is being turned into a list — add it on their profile later.'), r5.warnings.join(' | '));
  assert.equal((await valuesOf(mgr, r5.person.id)).Campus, null);
  await runJobs();
  assert.equal((await fieldsBy()).Campus.kind, 'choice');
});

test('Undo a move after Dwelling type became a list: a word it would refuse goes to “Dwelling type as written”', async () => {
  const F = await fieldsBy();
  ok(await mgr.action('field.update', { id: F['Dwelling type'].id, kind: 'text' }));
  const p = await mgr.createPerson('Mover Example', { address: '13450 104 Ave', city: 'Surrey' });
  ok(await setOne(mgr, p.id, F['Dwelling type'].id, 'bsmt suite'));
  ok(await setOne(mgr, p.id, F['Dwelling type as written'].id, 'old words'));
  const move = ok(await mgr.action('person.move', { person_id: p.id, unknown: true })).move;
  const after = await valuesOf(mgr, p.id);
  assert.equal(after['Dwelling type'], null);
  assert.equal(after['Dwelling type as written'], null, 'the "as written" door words go with the move too');
  ok(await mgr.action('field.list.start', { id: F['Dwelling type'].id, choices: DWELLING_TYPES, display: 'list', map: [] }));
  await runJobs();
  assert.equal((await fieldsBy())['Dwelling type'].kind, 'choice');
  const r = ok(await mgr.action('person.unmove', { move_id: move.id }));
  const back = await valuesOf(mgr, p.id);
  assert.equal(back['Dwelling type'], null, 'never a word the list would refuse');
  assert.deepEqual(back['Dwelling type as written'].split('; ').sort(), ['bsmt suite', 'old words'], 'both words come back, into “as written”');
  assert.equal(r.door_words_kept_out, undefined);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

// Needs a real Postgres with more than one connection (two transactions at
// once): DATABASE_URL=… PG_POOL_MAX=4. PGlite and test:pg have one.
const twoAtOnce = !!process.env.DATABASE_URL && Number(process.env.PG_POOL_MAX || 10) > 1;
test('a value another write holds when the last chunk runs: the field isn’t finished until that value is a choice', { skip: !twoAtOnce && 'needs a Postgres with two connections' }, async () => {
  const f = ok(await mgr.action('field.create', { name: `Held words ${tag}`, kind: 'text' })).field;
  await db.query(
    `insert into person_field_values (id, workspace_id, field_id, person_id, value)
     select gen_random_uuid(), $1, $2, p.id, to_jsonb(case when row_number() over (order by p.id) % 2 = 0 then 'a' else 'b' end)
       from persons p where p.workspace_id = $1 and p.name like 'Bulk Example %' limit 20`, [ws, f.id],
  );
  ok(await mgr.action('field.list.start', { id: f.id, choices: ['A', 'B'], display: 'buttons', map: [] }));
  let release;
  const held = new Promise((r) => { release = r; });
  let locked;
  const isLocked = new Promise((r) => { locked = r; });
  const holder = db.transaction(async (tx) => {
    await tx.query('select id from person_field_values where field_id = $1 order by id limit 1 for update', [f.id]);
    locked();
    await held;
  });
  await isLocked;
  const run = runDueJobs(db, { workspaceId: ws });
  await new Promise((r) => { setTimeout(r, 400); });
  assert.equal((await db.query('select kind from person_fields where id = $1', [f.id])).rows[0].kind, 'text', 'not finished while a value is held');
  release();
  await holder;
  await run;
  await runJobs();
  const vals = (await db.query('select value from person_field_values where field_id = $1', [f.id])).rows.map((r) => r.value);
  assert.deepEqual([...new Set(vals)].sort(), ['A', 'B']);
  assert.equal((await db.query('select kind from person_fields where id = $1', [f.id])).rows[0].kind, 'choice');
});
