// Phone banks (ext/banks): a bank from a list of people (only those with a
// phone, never do-not-contact), numbers handed to a caller or split across
// a team, a caller's own list, a logged call crossing the number off,
// skipping, taking numbers back, closing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';

let mgr, vic, wen, staff;
let ids = {};
const tokenOf = (url) => url.split('/join/')[1];
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name}.bank@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'bank-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.bank@example.org', jurisdiction: 'bc-municipal' });
  staff = await joinAs('staff', 'Sam');
  vic = await joinAs('volunteer', 'Vic');
  wen = await joinAs('volunteer', 'Wen');
  ids.people = [];
  for (let i = 0; i < 6; i++) ids.people.push((await mgr.createPerson(`Caller Target ${i}`, { phone: `604-555-01${String(i).padStart(2, '0')}` })).id);
  ids.noPhone = (await mgr.createPerson('No Phone')).id;
  ids.dnc = (await mgr.createPerson('Do Not', { phone: '604-555-0199', tags: ['do-not-contact'] })).id;
});

test('a bank is made from a list: with a phone, never do-not-contact; the desk sees it, volunteers don’t', async () => {
  const r = ok(await mgr.action('bank.create', { name: 'Undecided in Newton', script: 'Hi, this is {you} from Imagine Surrey…', person_ids: [...ids.people, ids.noPhone, ids.dnc, ids.people[0]] }));
  ids.bank = r.bank.id;
  assert.equal(r.added, 6, 'six with a phone, the repeat once');
  assert.equal(r.skipped, 3, 'no phone, do-not-contact, and the repeat');
  assert.deepEqual([r.bank.total, r.bank.assigned, r.bank.done, r.bank.open], [6, 0, 0, 6]);
  assert.equal((await vic.action('bank.create', { name: 'x', person_ids: [] })).status, 403);
  assert.equal((await vic.get('/api/banks')).status, 403);
  assert.equal((await vic.get(`/api/banks/${ids.bank}`)).status, 403);
  const list = ok(await staff.get('/api/banks')).banks;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Undecided in Newton');
  assert.equal(list[0].total, 6);
});

test('numbers are handed to a caller; their list is the people left; a logged call crosses one off', async () => {
  const a = ok(await mgr.action('bank.assign', { id: ids.bank, user_id: ids.Vic, count: 3 }));
  assert.equal(a.handed, 3);
  assert.equal(a.assigned, 3);
  assert.deepEqual(a.given, { [ids.Vic]: 3 });
  assert.equal((await mgr.action('bank.assign', { id: ids.bank })).status, 400, 'a caller or a team');
  const mine = ok(await vic.get('/api/banks/mine')).banks;
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].total, mine[0].done, mine[0].left], [3, 0, 3]);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 0, 'nothing handed to Wen yet');
  const list = ok(await vic.get(`/api/banks/${ids.bank}/mine`));
  assert.equal(list.bank.script, 'Hi, this is {you} from Imagine Surrey…');
  assert.equal(list.persons.length, 3);
  assert.equal(list.persons[0].name, 'Caller Target 0', 'in the bank’s order');
  assert.ok(list.persons[0].phone);
  assert.equal(list.persons[0].email, null, 'a volunteer never gets an email that isn’t theirs');
  // A phone call Vic logs crosses the number off; a door knock does not.
  ok(await vic.action('contact.log', { person_id: ids.people[0], channel: 'phone', outcome: 'contacted', rating: '2' }));
  ok(await vic.action('contact.log', { person_id: ids.people[1], channel: 'door', outcome: 'no_answer' }));
  const after = ok(await vic.get(`/api/banks/${ids.bank}/mine`));
  assert.deepEqual(after.persons.map((p) => p.name), ['Caller Target 1', 'Caller Target 2']);
  assert.deepEqual([after.bank.total, after.bank.done], [3, 1]);
  const detail = ok(await mgr.get(`/api/banks/${ids.bank}`));
  const n0 = detail.numbers.find((n) => n.person_id === ids.people[0]);
  assert.equal(n0.outcome, 'contacted'); assert.equal(n0.caller, 'Vic'); assert.ok(n0.done_at);
  assert.deepEqual(detail.bank.callers, [{ user_id: ids.Vic, name: 'Vic', total: 3, done: 1 }]);
  // Someone else's phone call to that number doesn't cross off Vic's.
  ok(await wen.action('contact.log', { person_id: ids.people[1], channel: 'phone', outcome: 'no_answer' }));
  assert.equal(ok(await vic.get(`/api/banks/${ids.bank}/mine`)).persons.length, 2, 'still Vic’s to call');
});

test('skipping a number, taking numbers back, splitting the rest across a team, closing', async () => {
  assert.equal((await wen.action('bank.done', { id: ids.bank, person_id: ids.people[1] })).status, 403, 'not Wen’s number');
  ok(await vic.action('bank.done', { id: ids.bank, person_id: ids.people[1], outcome: 'wrong number' }));
  assert.equal(ok(await vic.get(`/api/banks/${ids.bank}/mine`)).persons.length, 1);
  const rel = ok(await mgr.action('bank.release', { id: ids.bank, user_id: ids.Vic }));
  assert.equal(rel.released, 1, 'the one left, not the two done');
  assert.equal(ok(await vic.get('/api/banks/mine')).banks[0].left, 0);
  // A team of two gets the four open numbers, two each.
  const team = ok(await mgr.action('team.create', { name: 'Phone crew' })).team;
  ok(await mgr.action('team.member.add', { team_id: team.id, user_id: ids.Vic }));
  ok(await mgr.action('team.member.add', { team_id: team.id, user_id: ids.Wen }));
  const split = ok(await mgr.action('bank.assign', { id: ids.bank, team_id: team.id }));
  assert.equal(split.handed, 4);
  assert.equal(split.assigned, 6, 'counting the two already done');
  assert.deepEqual(split.given, { [ids.Vic]: 2, [ids.Wen]: 2 });
  assert.equal(split.open, 0);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks[0].left, 2);
  // More numbers later; closing stops handing out, and the bank leaves callers' lists.
  const more = ok(await mgr.action('bank.add', { id: ids.bank, person_ids: [ids.noPhone, ids.people[5]] }));
  assert.equal(more.added, 0, 'already in, or no phone');
  ok(await mgr.action('bank.update', { id: ids.bank, closed: true }));
  assert.equal((await mgr.action('bank.assign', { id: ids.bank, user_id: ids.Wen })).status, 409);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 0, 'a closed bank is off the list');
  assert.equal(ok(await mgr.get('/api/banks')).banks[0].closed, true);
  ok(await mgr.action('bank.update', { id: ids.bank, closed: false, name: 'Undecided in Newton (2)' }));
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 1);
  ok(await mgr.action('bank.remove', { id: ids.bank }));
  assert.equal((await mgr.get(`/api/banks/${ids.bank}`)).status, 404);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 0);
});

test('call backs: a No answer comes back after the bank’s hours, up to its tries; "Call back…" sets the time', async () => {
  const db = await getDb();
  const people = [];
  for (let i = 0; i < 3; i++) people.push((await mgr.createPerson(`Callback Target ${i}`, { phone: `604-555-02${String(i).padStart(2, '0')}` })).id);
  const b = ok(await mgr.action('bank.create', { name: 'Call backs', person_ids: people, retry_hours: 2, max_tries: 2 })).bank;
  assert.deepEqual([b.retry_hours, b.max_tries], [2, 2]);
  ok(await mgr.action('bank.assign', { id: b.id, user_id: ids.Wen }));
  const mine = async () => ok(await wen.get(`/api/banks/${b.id}/mine`));

  // A No answer: back in two hours, not crossed off.
  const r = ok(await wen.action('contact.log', { person_id: people[0], channel: 'phone', outcome: 'no_answer' }));
  const back = Date.parse(r.bank.back_at);
  assert.ok(Math.abs(back - (Date.now() + 2 * 3600_000)) < 60_000, `back in two hours: ${r.bank.back_at}`);
  assert.deepEqual([r.bank.tries, r.bank.max_tries], [1, 2]);
  let m = await mine();
  assert.ok(!m.persons.some((p) => p.id === people[0]), 'off the list until then');
  assert.deepEqual([m.bank.later, m.bank.done], [1, 0]);
  assert.equal(m.bank.next_at, r.bank.back_at);
  // The time comes: back on the list; a second No answer spends the last try.
  await db.query(`update call_bank_numbers set next_at = now() - interval '1 minute' where bank_id = $1 and person_id = $2`, [b.id, people[0]]);
  assert.ok((await mine()).persons.some((p) => p.id === people[0]), 'due again');
  const r2 = ok(await wen.action('contact.log', { person_id: people[0], channel: 'phone', outcome: 'no_answer' }));
  assert.equal(r2.bank, undefined, 'no more tries: crossed off');
  m = await mine();
  assert.deepEqual([m.bank.done, m.bank.later], [1, 0]);

  // "Call back at 7": their own number, a time in the next two weeks.
  const at = new Date(Date.now() + 5 * 3600_000).toISOString();
  ok(await wen.action('bank.callback', { id: b.id, person_id: people[1], at }));
  m = await mine();
  assert.ok(!m.persons.some((p) => p.id === people[1]));
  assert.equal(m.bank.later, 1);
  const desk = ok(await mgr.get(`/api/banks/${b.id}`)).numbers.find((n) => n.person_id === people[1]);
  assert.equal(new Date(desk.next_at).toISOString(), at, 'the desk sees when');
  assert.equal((await vic.action('bank.callback', { id: b.id, person_id: people[2], at })).status, 403, 'not Vic’s number');
  assert.equal((await wen.action('bank.callback', { id: b.id, person_id: people[2], at: '2020-01-01T10:00' })).status, 400);
  // A talk crosses it off whatever the time said.
  ok(await wen.action('contact.log', { person_id: people[1], channel: 'phone', outcome: 'contacted', rating: '3' }));
  assert.equal((await mine()).bank.later, 0);

  // A bank set to never try again: a No answer crosses it off, as before.
  const solo = (await mgr.createPerson('Once Target', { phone: '604-555-0299' })).id;
  const once = ok(await mgr.action('bank.create', { name: 'Once', person_ids: [solo], retry_hours: 0 })).bank;
  ok(await mgr.action('bank.assign', { id: once.id, user_id: ids.Wen }));
  const r3 = ok(await wen.action('contact.log', { person_id: solo, channel: 'phone', outcome: 'no_answer' }));
  assert.equal(r3.bank, undefined);
  assert.equal(ok(await wen.get(`/api/banks/${once.id}/mine`)).bank.done, 1);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('Left message: a call that left word — kept as itself, and a bank number is done (no second voicemail)', async () => {
  const p = (await mgr.createPerson('Voicemail Target', { phone: '604-555-0298' })).id;
  const b = ok(await mgr.action('bank.create', { name: 'Voicemail', person_ids: [p] })).bank;
  ok(await mgr.action('bank.assign', { id: b.id, user_id: ids.Wen }));
  const r = ok(await wen.action('contact.log', { person_id: p, channel: 'phone', outcome: 'left_message' }));
  assert.equal(r.contact.outcome, 'left_message');
  assert.equal(r.bank, undefined, 'not called back');
  assert.deepEqual([ok(await wen.get(`/api/banks/${b.id}/mine`)).bank.done, (await wen.get(`/api/banks/${b.id}/mine`)).json.persons.length], [1, 0]);
  const prof = ok(await mgr.get(`/api/persons/${p}`));
  assert.equal(prof.contacts[0].outcome, 'left_message');
});
