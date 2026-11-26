// Another campaign's profile fields are the product's own, never Imagine
// Surrey's (ext/fields, shared/fieldlists.js, lib/preset.js). Under brand
// base: a new campaign starts with exactly ten fields and general lists; no
// button, form, restart, job or later change of brand adds another; every
// start-up marker is written, so nothing can back-fill one; the features
// that find a field by its name still work; GET /api/fields carries no
// Campus list and no guesses for one. Under brand imagine-surrey,
// everything is as it was.
// test:pg-safe: the first campaign made here is the neutral one (the public
// website at /site/ answers for it); every query is scoped to a campaign.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { send } from './site-helpers.js';
import { presetFor } from '../lib/preset.js';
import { runDueJobs } from '../lib/jobs.js';
import * as fieldsSql from '../ext/fields/sql.js';
import * as people from '../ext/fields/people.js';
import * as lists from '@starbase/shared/fieldlists';

// Read at call time everywhere (lib/preset.js), so set after the imports.
const brandWas = process.env.STARBASE_BRAND;
process.env.STARBASE_BRAND = 'base';
after(() => { if (brandWas === undefined) delete process.env.STARBASE_BRAND; else process.env.STARBASE_BRAND = brandWas; });
const asBrand = async (key, fn) => {
  const was = process.env.STARBASE_BRAND;
  process.env.STARBASE_BRAND = key;
  try { return await fn(); } finally { process.env.STARBASE_BRAND = was; }
};

const tag = Math.random().toString(36).slice(2, 8);
const IS = presetFor('imagine-surrey');
const ok = (r, msg = '') => { assert.ok(r.status === 200 || r.status === 201, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
// The start-up SQL, as the server runs it at every boot (db/schema.js).
const bootSql = () => (typeof fieldsSql.sql === 'function' ? fieldsSql.sql() : fieldsSql.sql);

// ── What the product itself gives a new campaign, written out ──
const DWELLING = [
  'House', 'Semi-detached or side-by-side duplex', 'Townhouse or row house', 'Suite in a house (basement or upper)',
  'Low-rise apartment (1–4 floors)', 'High-rise apartment (5+ floors)', 'Mobile or manufactured home', 'Seniors’ or care home',
  'Student residence', 'Other (boat or RV or rooming house)', 'Not sure',
];
const LANGUAGES = [
  'Arabic', 'Bengali', 'Cantonese', 'Cree', 'English', 'Farsi', 'French', 'German', 'Greek', 'Gujarati', 'Hindi', 'Inuktitut',
  'Italian', 'Japanese', 'Korean', 'Mandarin', 'Polish', 'Portuguese', 'Punjabi', 'Russian', 'Somali', 'Spanish', 'Tagalog',
  'Tamil', 'Ukrainian', 'Urdu', 'Vietnamese', 'Other',
];
const FAITHS = [
  'Buddhist',
  'Christian – Anglican', 'Christian – Baptist', 'Christian – Catholic', 'Christian – Evangelical or non-denominational',
  'Christian – Greek Orthodox', 'Christian – Jehovah’s Witness', 'Christian – Just Christian (no church named)',
  'Christian – Latter Day Saints', 'Christian – Lutheran', 'Christian – Mennonite or Anabaptist', 'Christian – Methodist or Wesleyan',
  'Christian – Other Orthodox', 'Christian – Pentecostal or Charismatic', 'Christian – Presbyterian', 'Christian – Reformed',
  'Christian – Russian Orthodox', 'Christian – Serbian Orthodox', 'Christian – Ukrainian Orthodox', 'Christian – United Church',
  'Christian – Other',
  'Hindu', 'Indigenous spirituality', 'Jewish', 'Muslim', 'Sikh',
  'Other religion', 'No religion', 'Prefer not to say',
];
// name, kind, volunteers, private, shown as, choices — in this order.
const TEN = [
  ['House notes', 'text', true, false, 'buttons', []],
  ['Building notes', 'text', true, false, 'buttons', []],
  ['Access type', 'text', true, false, 'buttons', []],
  ['Dwelling type', 'choice', true, false, 'list', DWELLING],
  ['Email opt-in', 'yesno', false, false, 'buttons', []],
  ['SMS opt-in', 'yesno', false, false, 'buttons', []],
  ['Language', 'choices', true, false, 'buttons', LANGUAGES],
  ['Notes', 'note', false, false, 'buttons', []],
  ['Faith', 'choice', false, true, 'buttons', FAITHS],
  ['Interested in being a candidate', 'yesno', false, false, 'buttons', []],
];
// Every name the start-up SQL and the lists job look for before they add a
// field (ext/fields/sql.js, people.js LIST_SEEDS): fifteen.
const MARKERS = [
  'Voter eligibility', 'Language', 'Notes',
  'Gender', 'Birth date', 'Citizenship', 'Union member', 'Union local', 'Campus', 'Other language', 'Interests', 'Interested in being a candidate',
  'Faith', 'Dwelling type list', 'Campus list',
];

let db, mgr, ws;
const allFields = async (c = mgr) => ok(await c.get('/api/fields')).fields;
const shape = (fields) => fields.map((f) => [f.name, f.kind, f.volunteers, f.sensitive, f.display, f.choices]);
const names = async (c = mgr) => (await allFields(c)).map((f) => f.name);
const markersOf = async (id = ws) => (await db.query('select name from fields_seeded where workspace_id = $1', [id])).rows.map((r) => r.name);
const fieldEvents = async (id = ws) => (await db.query("select count(*)::int as n from events where workspace_id = $1 and entity_type = 'person_field'", [id])).rows[0].n;
const valuesOf = async (personId) => Object.fromEntries(ok(await mgr.get(`/api/persons/${personId}/fields`)).fields.map((f) => [f.name, f.value]));
const setValues = async (personId, values) => {
  const by = Object.fromEntries((await allFields()).map((f) => [f.name, f.id]));
  return ok(await mgr.action('field.values.set', { person_id: personId, values: Object.entries(values).map(([k, value]) => ({ field_id: by[k], value })) }));
};
const runJobs = async (id = ws) => {
  for (let i = 0; i < 20; i += 1) {
    const n = (await db.query("select count(*)::int as n from jobs where workspace_id = $1 and status = 'pending' and run_at <= now()", [id])).rows[0].n;
    if (!n) return;
    await runDueJobs(db, { workspaceId: id });
  }
};
// The job a campaign from before Faith was queued (sql.js), as if it had
// been queued for this one.
const queueListsJob = async (id = ws) => {
  await db.query("delete from jobs where workspace_id = $1 and kind = 'fields.lists'", [id]);
  await db.query("insert into jobs (id, workspace_id, kind, key) values (gen_random_uuid(), $1, 'fields.lists', 'fields-lists-1')", [id]);
};

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = ok(await mgr.signup({ workspaceName: `Kamloops Forward ${tag}`, email: `nf-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).workspace.id;
});

test('a new campaign starts with exactly ten fields, in order, with general lists', async () => {
  assert.deepEqual(shape(await allFields()), TEN);
  const all = JSON.stringify(await allFields());
  for (const word of [...IS.fields.interests, ...IS.fields.campuses, 'Home phone', 'Voter eligibility', 'Union local', 'Filipino']) {
    assert.ok(!all.includes(word), `“${word}” is Imagine Surrey’s`);
  }
});

test('the lists the app holds are general: no campus, no guess for one; Faith and Language in a–z order', () => {
  assert.deepEqual(lists.CAMPUSES, []);
  assert.deepEqual(lists.FAITHS, FAITHS);
  assert.deepEqual(lists.LANGUAGES, LANGUAGES);
  assert.deepEqual(lists.DWELLING_TYPES, DWELLING);
  assert.deepEqual([...FAITHS].sort(), [...IS.fields.faiths].sort(), 'the same 29 answers as Imagine Surrey’s, in another order');
  assert.equal([...FAITHS, ...LANGUAGES, ...DWELLING].filter(lists.splits).length, 0, 'no choice reads as two in Pick several');
  assert.equal(lists.GUESSES.campus, undefined);
  assert.equal(lists.guessChoice('Campus', 'KPU Newton', IS.fields.campuses), null, 'the app alone has no guess for a campus');
  assert.equal(lists.guessChoice('Dwelling type', 'Basement suite', DWELLING), 'Suite in a house (basement or upper)', 'dwelling guesses are general, and stay');
  // A server's own guesses, as GET /api/fields sends them (word → choice by field name).
  const extra = { campus: { 'kpu newton': 'Kwantlen Polytechnic University – Surrey' } };
  assert.equal(lists.guessChoice('Campus', 'KPU Newton', IS.fields.campuses, extra), 'Kwantlen Polytechnic University – Surrey');
  assert.equal(lists.guessChoice('Campus', 'KPU Newton', ['Somewhere else'], extra), null, 'only a choice still on the list');
  assert.equal(lists.guessChoice('Campus', 'kwantlen', IS.fields.campuses, extra), null);
});

test('GET /api/fields: the standard list for Dwelling type only, and no guesses', async () => {
  const r = ok(await mgr.get('/api/fields'));
  assert.deepEqual(r.standard, { 'dwelling type': DWELLING });
  assert.deepEqual(r.guesses, {});
});

test('“Add the standard fields” adds nothing more; nor does the membership form’s own top-up; nor the sample', async () => {
  assert.deepEqual(ok(await mgr.action('field.standard', {})).added, []);
  const emitted = [];
  const ctx = { workspaceId: ws, user: null };
  const auto = await db.transaction((tx) => people.addStandardFields(tx, ctx, (...a) => emitted.push(a), { auto: true }));
  assert.deepEqual(auto, []);
  await db.transaction((tx) => people.sampleLoaded(tx, ctx, { people: {}, emit: (...a) => emitted.push(a) }));
  assert.deepEqual(emitted, [], 'nothing made');
  assert.deepEqual(shape(await allFields()), TEN);
  // One taken off comes back with the button, as the product's own.
  const notes = (await allFields()).find((f) => f.name === 'Notes');
  await db.query('delete from person_fields where id = $1 and workspace_id = $2', [notes.id, ws]);
  assert.deepEqual(ok(await mgr.action('field.standard', {})).added.map((f) => [f.name, f.kind]), [['Notes', 'note']]);
  // Put back where it was, for the cases below.
  await db.query('update person_fields set position = $3 where workspace_id = $1 and name = $2', [ws, 'Notes', notes.position]);
  assert.deepEqual(shape(await allFields()), TEN);
});

test('every start-up marker is there from the first day: all fifteen', async () => {
  const seeds = await markersOf();
  for (const m of MARKERS) assert.ok(seeds.includes(m), `${m}: ${seeds.join(', ')}`);
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'fields.lists'", [ws])).rows[0].n, 0, 'no lists job');
});

test('the server restarts twice, and the lists job runs: the fields are the same (nothing is put back)', async () => {
  const events = await fieldEvents();
  await db.exec(bootSql());
  await db.exec(bootSql());
  await runJobs();
  assert.deepEqual(shape(await allFields()), TEN);
  // A lists job left in the queue (one made under another brand) does nothing here.
  await queueListsJob();
  await runJobs();
  assert.deepEqual(shape(await allFields()), TEN);
  assert.equal(await fieldEvents(), events, 'no field made or changed');
  assert.equal((await db.query("select status from jobs where workspace_id = $1 and kind = 'fields.lists'", [ws])).rows[0].status, 'done');
});

test('a campaign from before the markers: a restart writes all fifteen and adds no field', async () => {
  const c = new Client();
  const id = ok(await c.signup({ workspaceName: `Older ${tag}`, email: `nf-older+${tag}@example.org`, jurisdiction: 'bc-municipal' })).workspace.id;
  // As one made before: no marker at all, a Text Dwelling type, no Notes, no Faith.
  await db.query('delete from fields_seeded where workspace_id = $1', [id]);
  await db.query("delete from person_fields where workspace_id = $1 and name in ('Notes', 'Faith')", [id]);
  await db.query("update person_fields set kind = 'text', choices = '[]', display = 'buttons' where workspace_id = $1 and name = 'Dwelling type'", [id]);
  const was = shape(await allFields(c));
  assert.equal(was.length, 8);
  await db.exec(bootSql());
  await runJobs(id);
  assert.deepEqual(shape(await allFields(c)), was, 'nothing added, nothing turned into a list');
  const seeds = await markersOf(id);
  for (const m of MARKERS) assert.ok(seeds.includes(m), `${m}: ${seeds.join(', ')}`);
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'fields.lists'", [id])).rows[0].n, 0, 'no lists job queued');
  // And the brand changed to Imagine Surrey's afterwards: its start-up and
  // its job find every marker, and add nothing.
  await asBrand('imagine-surrey', async () => {
    await db.exec(bootSql());
    await runJobs(id);
    await runJobs(ws);
  });
  assert.deepEqual(shape(await allFields(c)), was);
  assert.deepEqual(shape(await allFields()), TEN);
});

test('a website newsletter sign-up sets Email opt-in', async () => {
  const email = `cleo+${tag}@example.org`;
  const r = await send('newsletter', { first_name: 'Cleo', email, consent_email: true });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  // The website answers for the database's first campaign: this file's
  // neutral one, or (a second run on the same database) an earlier run's
  // neutral one. So the person is found by their address, wherever.
  const p = (await db.query('select id, workspace_id from persons where lower(email) = $1 and deleted_at is null', [email])).rows[0];
  assert.ok(p, 'on the list');
  assert.equal((await db.query('select count(*)::int as n from person_fields where workspace_id = $1 and retired_at is null', [p.workspace_id])).rows[0].n, 10, 'a campaign with the ten');
  const v = Object.fromEntries((await db.query(
    `select f.name, v.value from person_fields f left join person_field_values v on v.field_id = f.id and v.person_id = $2
      where f.workspace_id = $1 and f.name in ('Email opt-in', 'SMS opt-in')`, [p.workspace_id, p.id],
  )).rows.map((x) => [x.name, x.value]));
  assert.deepEqual([v['Email opt-in'], v['SMS opt-in']], [true, null]);
});

test('a person whose Language is Punjabi gets the Punjabi voter guide on the walk list', async () => {
  const at = { lat: 50.7, lng: -120.35 };
  const mk = async (name) => ok(await mgr.action('person.create', { name, address: '15 Example Way', city: 'Kamloops', lat: at.lat, lng: at.lng })).person;
  const raj = await mk('Raj Example');
  const mei = await mk('Mei Example');
  const bo = await mk('Bo Example');
  await setValues(raj.id, { Language: ['English', 'Punjabi'] });
  await setValues(mei.id, { Language: ['Cantonese'] });
  const turf = ok(await mgr.action('turf.create', { name: `Language block ${tag}`, polygon: [[at.lat - 0.001, at.lng - 0.001], [at.lat - 0.001, at.lng + 0.001], [at.lat + 0.001, at.lng + 0.001], [at.lat + 0.001, at.lng - 0.001]] })).turf;
  const walk = ok(await mgr.get(`/api/turfs/${turf.id}/walk`));
  const langs = Object.fromEntries(walk.doors.flatMap((d) => d.persons).map((p) => [p.name, p.guide_lang ?? null]));
  assert.deepEqual(langs, { 'Raj Example': 'pa', 'Mei Example': 'zh-Hant', 'Bo Example': null });
  assert.ok(bo.id);
});

test('a move clears the four door fields and leaves the rest', async () => {
  const p = await mgr.createPerson('Mover Example', { address: '20 Example Way', city: 'Kamloops' });
  await setValues(p.id, {
    'House notes': 'Dog in yard', 'Building notes': 'Buzz 12', 'Access type': 'Gated', 'Dwelling type': 'Townhouse or row house', Notes: 'Met at the market.',
  });
  const move = ok(await mgr.action('person.move', { person_id: p.id, unknown: true })).move;
  const v = await valuesOf(p.id);
  assert.deepEqual([v['House notes'], v['Building notes'], v['Access type'], v['Dwelling type'], v.Notes], [null, null, null, null, 'Met at the market.']);
  assert.equal(ok(await mgr.action('person.unmove', { move_id: move.id })).restored.length, 4);
  assert.equal((await valuesOf(p.id))['Dwelling type'], 'Townhouse or row house');
});

test('the “Interested in being a candidate” report counts', async () => {
  const ren = await mgr.createPerson('Ren Runner', { phone: '250-555-0110' });
  await mgr.createPerson('Nat Notrunning', { phone: '250-555-0111' });
  await setValues(ren.id, { 'Interested in being a candidate': true });
  const r = ok(await mgr.get('/api/quick-reports/running'));
  assert.deepEqual(r.rows.map((x) => x.last_name), ['Runner']);
  assert.deepEqual(ok(await mgr.get('/api/quick-reports/running/count')), { count: 1 });
});

test('an import whose only phone is a Home Phone column gives each person that number, and no error', async () => {
  // What the import screen sends for such a file on a campaign with no
  // “Home phone” field: the number as the phone, and no field cell.
  const r = ok(await mgr.post('/api/data/import', { rows: [
    { name: 'Omar Example', phone: '250-555-0177' },
    { name: 'Pia Example', phone: '250-555-0178', fields: { 'House notes': 'Side door' } },
  ] }));
  assert.deepEqual([r.created, r.invalid.length], [2, 0], JSON.stringify(r.invalid));
  const got = (await db.query("select name, phone from persons where workspace_id = $1 and name in ('Omar Example', 'Pia Example') order by name", [ws])).rows;
  assert.deepEqual(got.map((p) => [p.name, String(p.phone).replace(/\D/g, '').slice(-10)]), [['Omar Example', '2505550177'], ['Pia Example', '2505550178']]);
});

test('under Imagine Surrey’s brand nothing changes: its 27 fields with its own lists, its Campus list and guesses, its start-up SQL', async () => {
  await asBrand('imagine-surrey', async () => {
    const c = new Client();
    const id = ok(await c.signup({ workspaceName: `Surrey ${tag}`, email: `nf-is+${tag}@example.org`, jurisdiction: 'bc-municipal' })).workspace.id;
    const r = ok(await c.get('/api/fields'));
    assert.equal(r.fields.length, 27);
    assert.deepEqual(shape(r.fields), IS.fields.standard.map((s) => [s.name, s.kind, s.volunteers, !!s.sensitive, s.display || 'buttons', s.choices || []]));
    const by = Object.fromEntries(r.fields.map((f) => [f.name, f]));
    assert.deepEqual(by.Language.choices, ['English', 'Punjabi', 'Hindi', 'Urdu', 'Mandarin', 'Cantonese', 'Filipino', 'Korean', 'Vietnamese', 'Arabic', 'Farsi', 'Gujarati', 'Spanish', 'French', 'Other']);
    assert.equal(by.Faith.choices[0], 'Sikh');
    assert.deepEqual(by.Campus.choices, ['Kwantlen Polytechnic University – Surrey', 'Kwantlen Polytechnic University – Cloverdale', 'SFU Surrey']);
    assert.equal(by.Interests.choices.length, 11);
    assert.deepEqual(r.standard, { 'dwelling type': DWELLING, campus: by.Campus.choices });
    assert.deepEqual(Object.keys(r.guesses), ['campus']);
    assert.equal(r.guesses.campus['kpu newton'], 'Kwantlen Polytechnic University – Surrey');
    assert.equal(Object.keys(r.guesses.campus).length, 8);
    assert.equal(lists.guessChoice('Campus', 'Simon Fraser Surrey', by.Campus.choices, r.guesses), 'SFU Surrey');
    // The same markers a campaign of its own always got: its 27 names and the two list markers.
    assert.deepEqual((await markersOf(id)).sort(), [...IS.fields.standard.map((s) => s.name), 'Dwelling type list', 'Campus list'].sort());
    // Its start-up still gives a campaign from before what it lacks.
    await db.query("delete from person_fields where workspace_id = $1 and name in ('Interests', 'Notes')", [id]);
    await db.query("delete from fields_seeded where workspace_id = $1 and name in ('Interests', 'Notes')", [id]);
    await db.exec(bootSql());
    const back = Object.fromEntries((await allFields(c)).map((f) => [f.name, f]));
    assert.deepEqual(back.Interests.choices, IS.fields.interests);
    assert.equal(back.Notes.kind, 'note');
  });
  // The neutral campaign beside it was given nothing by that start-up.
  assert.deepEqual(shape(await allFields()), TEN);
  // The words themselves: only Imagine Surrey's start-up holds its lists.
  const mine = bootSql();
  const theirs = await asBrand('imagine-surrey', () => bootSql());
  assert.ok(!/Safer streets|Filipino|Voter eligibility', 'choice'|fields\.lists/.test(mine), 'a neutral start-up adds no field and queues no job');
  assert.ok(/Safer streets/.test(theirs) && /'fields\.lists'/.test(theirs));
});
