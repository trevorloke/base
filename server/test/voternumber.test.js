// A voter number on a person (ext/voternumber): one text column, as a list
// of electors carries one. People → Import fills it, and matches on it
// before email, name and address when both sides have one; a row found the
// old way on someone with another number is counted, and the person says
// what it is. The desk reads and sets it on a profile; it is in the exports
// and survives a merge; a volunteer never receives it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.vn.${tag}@example.org`;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
let db, mgr, vol, ws;

const imp = async (rows, extra = {}) => ok(await mgr.post('/api/data/import', { rows, ...extra }));
const people = async () => (await db.query(
  'select id, name, voter_number, phone, address, email from persons where workspace_id = $1 and deleted_at is null order by name, voter_number', [ws],
)).rows;
const byName = async (name) => (await people()).filter((p) => p.name === name);
const acts = (r) => r.decisions.map((d) => d.action);

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Voter numbers ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = await mgr.action('member.invite', { email: mail('vol'), role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Volunteer', password: 'voter-number-1' }));
});

test('an import fills it, and the check decides the same without saving', async () => {
  const rows = [
    { first: 'John', last: 'Smith', address: '13450 104 Ave', voter_number: ' 123 456 789 ' },
    { first: 'Pat', last: 'Example', address: '9 Oak Ave', voter_number: 'ab-111' },
    { name: 'Sam Example', email: mail('sam'), voter_number: '333' },
    { name: 'Lee Example', address: '5 Elm St' },
  ];
  const dry = await imp(rows, { dryRun: true });
  assert.deepEqual(acts(dry), ['created', 'created', 'created', 'created']);
  assert.equal((await people()).length, 0, 'a check saves no one');
  const r = await imp(rows);
  assert.deepEqual(acts(r), ['created', 'created', 'created', 'created']);
  assert.deepEqual((await people()).map((p) => [p.name, p.voter_number]),
    [['John Smith', '123456789'], ['Lee Example', null], ['Pat Example', 'AB111'], ['Sam Example', '333']], 'kept as letters and digits, in capitals');
  assert.deepEqual(acts(await imp(rows)), ['unchanged', 'unchanged', 'unchanged', 'unchanged'], 'the same file again adds no one');
});

test('the same number is the same person, however the name and address are written', async () => {
  const rows = [{ name: 'SMITH, Jon', address: '13450 104 Avenue', phone: '604-555-0131', voter_number: '123456789' }];
  assert.deepEqual(acts(await imp(rows, { dryRun: true })), ['merged']);
  const r = await imp(rows);
  assert.deepEqual(acts(r), ['merged']);
  assert.deepEqual(r.decisions[0].fields, ['phone'], 'blanks filled, nothing overwritten');
  const johns = await byName('John Smith');
  assert.equal(johns.length, 1);
  assert.deepEqual([johns[0].phone, johns[0].address], ['604-555-0131', '13450 104 Ave']);
  assert.equal((await people()).length, 4, 'no second record');
});

// A list numbered afresh (another year's, another office's) or a number typed
// wrong on a profile: the row still finds its person by email, or by name
// with phone or street, as before there were numbers. The check counts those
// rows, and the person says what they are (otherNumber): the same people,
// keeping the numbers on file (the default) or taking the file's; or, for a
// match by name, someone new. An email is one person's whatever is chosen.
test('a list numbered afresh: the same people, said in the check, never a second record', async () => {
  await imp([
    { first: 'Vera', last: 'Elector', address: '7 Elm St', email: mail('vera'), voter_number: 'A123456' },
    { first: 'Omar', last: 'Elector', address: '9 Oak St', voter_number: 'B555555' },
  ]);
  const next = [
    { first: 'Vera', last: 'Elector', address: '7 Elm St', email: mail('vera'), phone: '604-555-0150', voter_number: 'C000001' },
    { first: 'Omar', last: 'Elector', address: '9 Oak St', phone: '604-555-0151', voter_number: 'C000002' },
  ];
  const dry = await imp(next, { dryRun: true });
  assert.deepEqual(acts(dry), ['merged', 'merged'], 'found by email, and by name and street');
  assert.equal(dry.other_numbers, 2);
  assert.deepEqual(dry.other_number_rows.map((x) => [x.row, x.name, x.on_file, x.in_file, x.email]),
    [[1, 'Vera Elector', 'A123456', 'C000001', true], [2, 'Omar Elector', 'B555555', 'C000002', false]]);
  const r = await imp(next);
  assert.deepEqual(acts(r), ['merged', 'merged']);
  assert.equal(r.other_numbers, 2);
  assert.deepEqual(r.decisions.map((d) => d.fields), [['phone'], ['phone']], 'blanks filled; the numbers on file kept');
  assert.deepEqual((await people()).filter((p) => p.name.endsWith(' Elector')).map((p) => [p.name, p.voter_number, p.phone]),
    [['Omar Elector', 'B555555', '604-555-0151'], ['Vera Elector', 'A123456', '604-555-0150']]);
});

test('told to, the file’s numbers replace the ones on file: a number typed wrong is put right', async () => {
  const pat = (await byName('Pat Example'))[0];
  ok(await mgr.action('person.voterNumber', { id: pat.id, voter_number: 'AB-112' })); // typed wrong at the desk
  const rows = [
    { first: 'Pat', last: 'Example', address: '9 Oak Ave', voter_number: 'AB-111' },
    { name: 'Sam Example', email: mail('sam'), voter_number: '444' },
  ];
  assert.deepEqual(acts(await imp(rows, { dryRun: true })), ['unchanged', 'unchanged'], 'unless told, the numbers on file stay');
  assert.deepEqual(acts(await imp(rows, { dryRun: true, otherNumber: 'take' })), ['merged', 'merged']);
  assert.equal((await byName('Pat Example'))[0].voter_number, 'AB112', 'a check changes nothing');
  const r = await imp(rows, { otherNumber: 'take' });
  assert.deepEqual(r.decisions.map((d) => [d.action, d.fields]), [['merged', ['voter_number']], ['merged', ['voter_number']]]);
  assert.deepEqual([(await byName('Pat Example'))[0].voter_number, (await byName('Sam Example'))[0].voter_number], ['AB111', '444']);
  // From then on the number finds them however the name is written; the old one finds no one.
  assert.deepEqual(acts(await imp([{ name: 'EXAMPLE, Pat', voter_number: 'ab111', phone: '604-555-0122' }])), ['merged']);
  assert.deepEqual(acts(await imp([{ name: 'S. Example', voter_number: '333', address: '1 Nowhere Rd' }], { dryRun: true })), ['created']);
  assert.equal((await byName('Pat Example')).length, 1);
});

test('told they are other people, a name match with another number is someone new; a shared email never is', async () => {
  const before = (await people()).length;
  // A father and son of one name at one door, each with their own number.
  const son = [{ first: 'Pat', last: 'Example', address: '9 Oak Ave', voter_number: 'AB-222' }];
  assert.deepEqual(acts(await imp(son, { dryRun: true })), ['unchanged'], 'unless told, the Pat on file');
  const dry = await imp(son, { dryRun: true, otherNumber: 'new' });
  assert.deepEqual(acts(dry), ['created']);
  assert.equal(dry.other_numbers, 1, 'still counted, so the question stays on screen');
  assert.deepEqual(acts(await imp(son, { otherNumber: 'new' })), ['created']);
  assert.deepEqual((await byName('Pat Example')).map((p) => p.voter_number).sort(), ['AB111', 'AB222']);
  // Alex with Sam's email: Sam, whatever is chosen.
  const alex = await imp([{ name: 'Alex Example', email: mail('sam'), voter_number: '888' }], { otherNumber: 'new' });
  assert.deepEqual(acts(alex), ['unchanged']);
  assert.deepEqual(alex.other_number_rows.map((x) => x.email), [true]);
  assert.equal((await byName('Sam Example'))[0].voter_number, '444');
  // Each Pat is then found by their own number, whatever is chosen.
  assert.deepEqual(acts(await imp([
    { first: 'Pat', last: 'Example', address: '9 Oak Ave', voter_number: 'AB-222' },
    { first: 'Pat', last: 'Example', address: '9 Oak Ave', voter_number: 'ab 111' },
  ])), ['unchanged', 'unchanged']);
  assert.equal((await people()).length, before + 1);
});

test('one side without a number: matched as before, and the number fills the blank', async () => {
  const r = await imp([{ name: 'Lee Example', address: '5 Elm St', voter_number: '555' }]);
  assert.deepEqual(acts(r), ['merged']);
  assert.deepEqual(r.decisions[0].fields, ['voter_number']);
  assert.equal((await byName('Lee Example'))[0].voter_number, '555');
  // A row with no number still finds the person who has one, and changes nothing.
  assert.deepEqual(acts(await imp([{ name: 'Lee Example', address: '5 Elm St' }])), ['unchanged']);
  assert.equal((await byName('Lee Example'))[0].voter_number, '555');
  // Two rows of one file with one number are one person.
  const two = await imp([
    { name: 'New Elector', voter_number: '777', address: '1 First St' },
    { name: 'N. Elector', voter_number: '777', phone: '604-555-0177' },
  ]);
  assert.deepEqual(acts(two), ['created', 'merged']);
  assert.equal((await byName('New Elector')).length, 1);
});

// A column that isn't a voter number — a 1/0 flag, yes/no, a poll's two
// digits — must never be read as one: "the same number is the same person"
// would make one person of everyone who shares the flag.
test('a flag is not a voter number: nothing is kept, and no two people are made one by it', async () => {
  const r = await imp([
    { name: 'Ann Flagged', address: '1 Flag St', voter_number: '1' },
    { name: 'Bob Flagged', address: '2 Flag St', voter_number: '1' },
    { name: 'Cam Flagged', address: '3 Flag St', voter_number: 'yes' },
    { name: 'Dot Flagged', address: '4 Flag St', voter_number: 'YES' },
    { name: 'Eve Flagged', address: '5 Flag St', voter_number: 'n/a' },
    { name: 'Fox Flagged', address: '6 Flag St', voter_number: '12' },
  ]);
  assert.deepEqual(acts(r), ['created', 'created', 'created', 'created', 'created', 'created']);
  const flagged = (await people()).filter((p) => p.name.endsWith(' Flagged'));
  assert.equal(flagged.length, 6);
  assert.ok(flagged.every((p) => p.voter_number === null), JSON.stringify(flagged.map((p) => p.voter_number)));
  // At the desk too: it is said, never saved as something else or silently dropped.
  const typed = await mgr.action('person.voterNumber', { id: flagged[0].id, voter_number: '12' });
  assert.equal(typed.status, 400);
  assert.match(typed.json.error, /voter number/i);
});

test('on a profile: the desk reads and sets it; a volunteer gets neither', async () => {
  const lee = (await byName('Lee Example'))[0];
  assert.deepEqual(ok(await mgr.get(`/api/persons/${lee.id}/voter-number`)), { voter_number: '555' });
  assert.equal(ok(await mgr.action('person.voterNumber', { id: lee.id, voter_number: ' 55-5x ' })).voter_number, '555X');
  assert.equal((await byName('Lee Example'))[0].voter_number, '555X');
  ok(await mgr.action('person.voterNumber', { id: lee.id, voter_number: '' }));
  assert.deepEqual(ok(await mgr.get(`/api/persons/${lee.id}/voter-number`)), { voter_number: null });
  ok(await mgr.action('person.voterNumber', { id: lee.id, voter_number: '555' }));
  const ev = (await db.query(
    `select payload from events where workspace_id = $1 and action = 'person.voterNumber' order by seq desc limit 1`, [ws],
  )).rows[0];
  assert.equal((typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload).voter_number, '555', 'on the books');

  assert.equal((await vol.get(`/api/persons/${lee.id}/voter-number`)).status, 403);
  assert.equal((await vol.action('person.voterNumber', { id: lee.id, voter_number: '1' })).status, 403);
  const seen = ok(await vol.get(`/api/persons/${lee.id}`));
  // The number as a value or under its name: a bare '555' can turn up inside
  // a random id or a timestamp's milliseconds on a busy run.
  assert.ok(!/"555"|voter_number/.test(JSON.stringify(seen)), 'nothing a volunteer reads carries it');
  assert.ok(!JSON.stringify(ok(await vol.get('/api/persons?q=Lee'))).includes('voter_number'));
  assert.equal((await mgr.action('person.voterNumber', { id: '00000000-0000-4000-8000-000000000000', voter_number: '111' })).status, 404);
});

test('in the exports, and kept when two records are made one', async () => {
  const res = await app.request('/api/export/people.csv', { headers: { cookie: mgr.cookie } });
  const lines = (await res.text()).replace(/^﻿/, '').split('\r\n');
  const head = lines[0].split(',');
  assert.ok(head.includes('voter_number'), head.join());
  const john = lines.find((l) => l.includes(',John Smith,')).split(',');
  assert.equal(john[head.indexOf('voter_number')], '123456789');
  const full = ok(await mgr.get('/api/export'));
  assert.equal(full.persons.find((p) => p.name === 'John Smith').voter_number, '123456789');

  // Keep this one: its blank voter number is filled from the other.
  const keep = ok(await mgr.action('person.create', { name: 'Jo Keeper', phone: '604-555-0188' })).person;
  const drop = (await byName('New Elector'))[0];
  ok(await mgr.action('person.merge', { keep: keep.id, drop: drop.id }));
  assert.equal((await byName('Jo Keeper'))[0].voter_number, '777');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
