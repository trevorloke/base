// Live GOTV, the scrutineer's side and who may do what (ext/voted):
// the sending rule for every route (a scrutineer, a runner, the desk's
// Enter a sheet, a file), live sending only after the Chief Election
// Officer's yes, the manager's own actions, posts at the voter guide's
// places, the look-up and its limits, marks that answer the same bytes
// whatever was there, undo, practice for a group only, volunteers kept to
// their turfs and phone banks, and the election-day sign-in code.
// test:pg-safe: a fresh campaign per run, every query scoped to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';
import { campaign, ok, no, at, clockBack, plus, square } from './gotv-helpers.js';
import { _resetLookups } from '../ext/voted/find.js';

const HELD = 'Names go to the office after polls close.';
const MANAGER = 'Only a manager can do this';
const DUTY = 'Only a scrutineer or runner on duty can do this';
let k;
const sheet = (c, person, place, extra = {}) => c.action('vote.mark', { person_id: person.id, source: 'scrutineer', place_id: place, client_id: randomUUID(), ...extra });
const find = (c, q, extra = '') => c.get(`/api/gotv/find?q=${encodeURIComponent(q)}${extra}`);

before(async () => {
  await freshDb();
  k = await campaign('scrut');
});
after(clockBack);

test('who may: a manager posts a volunteer; staff and an Admin-area grantee get 403 on the manager’s actions and keep the days editor', async () => {
  no(await k.staff.client.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1 }), 403);
  for (const [name, input] of [
    ['gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1 }],
    ['gotv.signin.code', { user_id: k.scrut.id }],
    ['vote.settings', { mode: 'practice' }],
    ['vote.settings', { send: 'after_close' }],
    ['vote.settings', { scope: 'campaign' }],
  ]) no(await k.admin.client.action(name, input), 403, MANAGER);
  ok(await k.admin.client.action('vote.settings', { advance_days: [k.A1, k.A2], election_day: k.G }), 'the days editor works as today');
  // A desk role can't be posted; a plain Shifts place isn't a voting place.
  no(await k.mgr.action('gotv.post.set', { user_id: k.staff.id, role: 'scrutineer', place_id: k.p1 }), 400, 'Scrutineers are volunteers — change their role first.');
  const saved = ok(await k.mgr.action('place.save', { name: `Office ${k.tag}`, address: '1 Office Rd', source: 'typed' }));
  const shiftPlace = saved.place?.id || saved.id;
  no(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: shiftPlace }), 400, 'Pick a voting place from the voter guide’s list');
  no(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer' }), 400, 'Pick a voting place from the voter guide’s list');
  const post = ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1, appointed: true }));
  assert.deepEqual(post.not_open, []);
  ok(await k.mgr.action('gotv.post.set', { user_id: k.runner.id, role: 'runner' }));
  const db = await getDb();
  assert.equal((await db.query('select count(*)::int as n from gotv_posts where workspace_id = $1 and ended_at is null', [k.ws])).rows[0].n, 2);
  // The places for the pickers: the guide's only, and only for posts and the desk.
  const places = ok(await k.scrut.client.get('/api/gotv/places')).places.map((p) => p.id).sort();
  assert.deepEqual(places, [k.p1, k.p2].sort());
  no(await k.volA.client.get('/api/gotv/places'), 403, DUTY);
  no(await k.volA.client.get('/api/gotv/posts'), 403);
  assert.equal(ok(await k.staff.client.get('/api/gotv/posts')).posts.length, 2);
});

test('the sending rule holds every route before close, for a scrutineer, a runner, staff and a manager alike', async () => {
  at(k.A1, '15:00');
  no(await find(k.scrut.client, 'harjit'), 409, HELD);
  no(await sheet(k.scrut.client, k.inA, k.p1), 409, HELD);
  no(await sheet(k.runner.client, k.inA, k.p2), 409, HELD);
  no(await sheet(k.staff.client, k.inA, k.p2), 409, HELD);
  no(await sheet(k.mgr, k.inA, k.p2), 409, HELD);
  no(await k.scrut.client.action('gotv.check', { typed: 'Someone Example', place_id: k.p1 }), 409, HELD);
  // A desk mark naming a place must be a scrutineer's; a desk mark with none is never held.
  no(await k.staff.client.action('vote.mark', { person_id: k.inA.id, source: 'desk', place_id: k.p1 }), 400, 'A name from a voting place is a scrutineer’s mark');
  // A file on a voting day before close, while held.
  no(await k.staff.client.post('/api/data/import', { rows: [{ name: `File Example ${k.tag}`, phone: '604-555-0171', voted: '1' }] }), 409, 'Voted lists from voting places go in after polls close.');
  ok(await k.staff.client.post('/api/data/import', { rows: [{ name: `File Two Example ${k.tag}`, phone: '604-555-0172' }] }), 'other columns import as usual');
  // Door, phone and desk marks without a place are never held.
  ok(await k.volA.client.action('vote.mark', { person_id: k.inA2.id, source: 'door', client_id: randomUUID() }));
  ok(await k.staff.client.action('vote.mark', { person_id: k.inB.id, source: 'desk' }));
  // The release opens every route.
  ok(await k.mgr.action('vote.settings', { release: true }));
  ok(await find(k.scrut.client, 'harjit'));
  ok(await sheet(k.scrut.client, k.inA, k.p1));
  ok(await sheet(k.staff.client, k.inA, k.p2), 'the desk’s Enter a sheet');
  ok(await k.staff.client.post('/api/data/import', { rows: [{ name: `File Example ${k.tag}`, phone: '604-555-0171', voted: '1' }] }), 'a file after a release');
  ok(await k.scrut.client.action('gotv.check', { typed: 'Someone Example', place_id: k.p1, client_id: randomUUID() }));
});

test('live sending only after the Chief Election Officer’s yes; a recorded no takes it back', async () => {
  no(await k.mgr.action('vote.settings', { send: 'live' }), 400, 'First record the Chief Election Officer’s answer (Ready list)');
  ok(await k.mgr.action('vote.settings', { ceo_answer: { allows_live: true, note: 'Asked by email; yes for advance and general days' } }));
  ok(await k.mgr.action('vote.settings', { send: 'live' }));
  at(k.A2, '10:00');
  ok(await sheet(k.scrut.client, k.inA2, k.p1), 'live: names go at once');
  const back = ok(await k.mgr.action('vote.settings', { ceo_answer: { allows_live: false, note: 'Changed their mind' } }));
  assert.equal(back.send, 'after_close');
  no(await sheet(k.scrut.client, k.inA2, k.p1), 409, HELD);
  const s = ok(await k.mgr.get('/api/voted/status'));
  assert.equal(s.held_line, 'Scrutineers’ names are held until polls close — the Chief Election Officer said no.');
  assert.equal(ok(await k.volA.client.get('/api/voted/status')).held_line, undefined, 'the desk’s line only');
});

test('a scrutineer: own place only, voted:true only, on duty only; a runner picks any place', async () => {
  at(k.A2, '20:30');
  no(await sheet(k.scrut.client, k.inA, k.p2), 403, 'That isn’t your voting place');
  no(await sheet(k.scrut.client, k.inA, k.p1, { voted: false }), 403, 'Ask the office to change this');
  ok(await sheet(k.runner.client, k.inA, k.p1));
  ok(await sheet(k.runner.client, k.inA, k.p2));
  no(await sheet(k.volA.client, k.inA, k.p1), 403, DUTY);
  // A post for A2 only: off duty on G.
  ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1, days: [k.A2] }));
  at(k.G, '21:00');
  no(await sheet(k.scrut.client, k.inA, k.p1), 403, DUTY);
  // Not a voting day at all.
  at(plus(15), '21:00');
  no(await sheet(k.runner.client, k.inA, k.p1, { client_at: new Date().toISOString() }), 403, DUTY);
  ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1, days: [] }));
});

test('find: names, street, block, voter number; at most 8 and more; nothing else; 2 letters; the limits', async () => {
  at(k.G, '21:00');
  const db = await getDb();
  await db.query('update persons set voter_number = $2 where id = $1', [k.inA.id, 'V12345']);
  const names = (r) => r.people.map((p) => p.name);
  const harjit = 'Harjit Singh';
  assert.ok(names(ok(await find(k.scrut.client, `SINGH, Harjit`))).includes(harjit));
  assert.ok(names(ok(await find(k.scrut.client, 'harjit singh'))).includes(harjit));
  assert.deepEqual(ok(await find(k.scrut.client, 'V12345')).people.map((p) => p.id), [k.inA.id]);
  // Two Singhs on 72 Ave, one Singh elsewhere.
  await k.mgr.createPerson('Harjit Singh', { address: '7250 140 St', house_number: '7250' });
  const street = ok(await find(k.scrut.client, 'singh 72 ave'));
  assert.ok(street.people.every((p) => /72 Ave/.test(p.where)), JSON.stringify(street));
  assert.equal(street.people.length, 2);
  const block = ok(await find(k.scrut.client, 'harjit singh 14'));
  assert.deepEqual(names(block), [harjit]);
  assert.equal(block.people[0].id, k.inA.id);
  assert.equal(block.people[0].where, '72 Ave · 14000 block');
  // The answer's keys: nothing about voting, rating, contact or numbers.
  assert.deepEqual(Object.keys(street).sort(), ['more', 'people']);
  for (const p of street.people) assert.deepEqual(Object.keys(p).sort(), ['id', 'name', 'where']);
  // Nine Examples: eight and more.
  for (let i = 0; i < 9; i += 1) await k.mgr.createPerson(`Zed${i} Nineexample`);
  const many = ok(await find(k.scrut.client, 'nineexample'));
  assert.equal(many.people.length, 8);
  assert.equal(many.more, true);
  no(await find(k.scrut.client, 'ha'), 400, 'Type at least 3 letters or a voter number.');
  // 121 in a minute.
  _resetLookups();
  let last;
  for (let i = 0; i < 121; i += 1) last = await find(k.scrut.client, 'harjit');
  no(last, 429, 'Slow down — try again in a minute.');
});

test('the day limit: the 5,001st look-up, the flag on the posts, and Allow 2,000 more', async () => {
  _resetLookups();
  const { takeLookup } = await import('../ext/voted/find.js');
  // 5,000 counted straight through the counter (the minute limit aside).
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => (t += 1000);
  try { for (let i = 0; i < 5000; i += 1) assert.equal(takeLookup(k.ws, k.scrut.id, 'America/Vancouver'), null); } finally { Date.now = realNow; }
  no(await find(k.scrut.client, 'harjit'), 429, 'Today’s look-up limit is reached — names are kept to match later. The office has been told.');
  const row = ok(await k.mgr.get('/api/gotv/posts')).posts.find((p) => p.user_id === k.scrut.id);
  assert.equal(row.limit_reached, true);
  ok(await k.mgr.action('gotv.find.allow', { user_id: k.scrut.id }));
  ok(await find(k.scrut.client, 'harjit'));
  assert.equal(ok(await k.mgr.get('/api/gotv/posts')).posts.find((p) => p.user_id === k.scrut.id).limit_reached, false);
  _resetLookups();
});

test('a mark answers the same bytes for a voted and a not-voted person, and on a replay; the desk still gets its numbers', async () => {
  at(k.G, '21:00');
  const voted = await k.mgr.createPerson(`Voted Example ${k.tag}`);
  const fresh = await k.mgr.createPerson(`Fresh Example ${k.tag}`);
  ok(await k.mgr.action('vote.mark', { person_id: voted.id, source: 'desk' }));
  const cid1 = randomUUID(); const cid2 = randomUUID();
  const r1 = await k.scrut.client.req('POST', '/api/actions/vote.mark', { person_id: voted.id, source: 'scrutineer', place_id: k.p1, client_id: cid1 });
  const r2 = await k.scrut.client.req('POST', '/api/actions/vote.mark', { person_id: fresh.id, source: 'scrutineer', place_id: k.p1, client_id: cid2 });
  assert.deepEqual(r1.json, { ok: true, client_id: cid1 });
  assert.deepEqual(r2.json, { ok: true, client_id: cid2 });
  const replay = await k.scrut.client.req('POST', '/api/actions/vote.mark', { person_id: voted.id, source: 'scrutineer', place_id: k.p1, client_id: cid1 });
  assert.deepEqual(replay.json, r1.json);
  const desk = ok(await k.staff.client.action('vote.mark', { person_id: fresh.id, source: 'scrutineer', place_id: k.p2, client_id: randomUUID() }));
  assert.ok(desk.voted_at && desk.feed_id && desk.seq);
  const dup = ok(await k.mgr.action('vote.mark', { person_id: voted.id, source: 'desk', client_id: cid1 }));
  assert.equal(dup.duplicate, true);
});

test('a canvasser marks only people on their list while GOTV keeps them to it; someone they added at a door counts', async () => {
  at(k.G, '12:00'); // GOTV on by itself: a voting day, auto on
  assert.equal(ok(await k.volA.client.get('/api/voted/status')).active, true);
  no(await k.volA.client.action('vote.mark', { person_id: k.inB.id, source: 'door', client_id: randomUUID() }), 403, 'This person isn’t on your list.');
  ok(await k.volA.client.action('vote.mark', { person_id: k.inA.id, source: 'door', client_id: randomUUID() }));
  const met = ok(await k.volA.client.action('person.addAtDoor', { id: randomUUID(), housemate_id: k.inA.id, name: `Door Example ${k.tag}` }));
  const metId = met.person?.id || met.id;
  ok(await k.volA.client.action('vote.mark', { person_id: metId, source: 'door', client_id: randomUUID() }), 'added at a door an hour ago');
});

test('undo: 15 minutes from reaching the office, own marks only, the fact from the other marks; the desk any', async () => {
  at(k.G, '21:00');
  const p = await k.mgr.createPerson(`Undo Example ${k.tag}`, { lat: 49.14, lng: -122.8402 });
  ok(await k.volA.client.action('vote.mark', { person_id: p.id, source: 'door', client_id: randomUUID() }));
  const doorAt = (await k.mgr.get(`/api/persons/${p.id}`)).json.person.voted_at;
  // A name written 6 hours ago, matched now.
  const cid = randomUUID();
  ok(await sheet(k.scrut.client, p, k.p1, { client_id: cid, client_at: new Date(Date.now() + Number(process.env.STARBASE_CLOCK_SHIFT_MS) - 6 * 3600_000).toISOString() }));
  no(await k.runner.client.action('vote.undo', { client_id: cid }), 404, 'That mark isn’t one of yours');
  assert.deepEqual(ok(await k.scrut.client.action('vote.undo', { client_id: cid })), { ok: true, client_id: cid });
  assert.equal((await k.mgr.get(`/api/persons/${p.id}`)).json.person.voted_at, doorAt, 'the door mark still says voted');
  // Fifteen minutes after it reached the office: too late here.
  const cid2 = randomUUID();
  ok(await sheet(k.scrut.client, k.inA2, k.p1, { client_id: cid2 }));
  const db = await getDb();
  await db.query("update voted_marks set inserted_at = now() - interval '16 minutes' where workspace_id = $1 and client_id = $2", [k.ws, cid2]);
  no(await k.scrut.client.action('vote.undo', { client_id: cid2 }), 409, 'Too late to undo here — ask the office.');
  const undone = ok(await k.mgr.action('vote.undo', { client_id: cid2 }));
  assert.equal(undone.undone, true);
  // A canvasser can't undo through vote.undo (no post).
  no(await k.volA.client.action('vote.undo', { client_id: cid2 }), 403, DUTY);
});

test('practice: a group only; never the record; undo is a row; ending wipes it; refused while GOTV is on', async () => {
  at(k.G, '12:00');
  no(await k.mgr.action('vote.settings', { mode: 'practice' }), 409, 'GOTV is on today — practice another day');
  at(plus(5), '12:00');
  ok(await k.mgr.action('vote.settings', { mode: 'practice', practice_users: [k.volA.id] }));
  const p = await k.mgr.createPerson(`Practice Example ${k.tag}`, { lat: 49.14, lng: -122.8403, address: '14030 72 Ave', house_number: '14030' });
  const sA = ok(await k.volA.client.get('/api/voted/status'));
  const sB = ok(await k.volB.client.get('/api/voted/status'));
  assert.equal(sA.active, true, 'a canvasser in the group');
  assert.equal(sB.active, false, 'a canvasser outside it: practice doesn’t exist');
  // The scrutineer (posted, so in the group) marks in practice: always live.
  const cid = randomUUID();
  ok(await sheet(k.scrut.client, p, k.p1, { client_id: cid, practice: true }));
  const db = await getDb();
  assert.equal((await db.query('select voted_at from persons where id = $1', [p.id])).rows[0].voted_at, null, 'the record is untouched');
  assert.equal((await db.query('select count(*)::int as n from voted_marks where person_id = $1', [p.id])).rows[0].n, 0);
  // In the group: the walk list, the map, the list and History read it as voted.
  const walk = ok(await k.volA.client.get(`/api/turfs/${k.turfA}/walk`));
  assert.ok(walk.doors.flatMap((d) => d.persons).find((x) => x.id === p.id)?.voted_at, 'walk list');
  assert.ok(ok(await k.volA.client.get('/api/map/doors')).persons.find((x) => x.id === p.id)?.voted_at, 'map');
  assert.ok(!ok(await k.volA.client.get('/api/persons?voted=no&limit=500')).persons.some((x) => x.id === p.id), '/persons?voted=no');
  const hist = ok(await k.volA.client.get(`/api/persons/${p.id}/timeline`)).entries || [];
  assert.ok(JSON.stringify(hist).includes('Practice: marked as voted'), JSON.stringify(hist).slice(0, 300));
  // The desk and anyone outside the group read the record.
  assert.equal(ok(await k.mgr.get(`/api/persons/${p.id}`)).person.voted_at, null);
  assert.ok(ok(await k.mgr.get('/api/persons?voted=no&limit=2000')).persons.some((x) => x.id === p.id));
  const real = ok(await k.mgr.get('/api/voted/summary'));
  const drill = ok(await k.mgr.get('/api/voted/summary?practice=1'));
  assert.equal(drill.practice, true);
  assert.equal(real.practice, false);
  // An undo is a voted:false row with its own feed id.
  ok(await k.scrut.client.action('vote.undo', { client_id: cid }));
  const rows = (await db.query('select voted, feed_id, undoes from gotv_practice where person_id = $1 order by feed_id', [p.id])).rows;
  assert.deepEqual(rows.map((r) => r.voted), [true, false]);
  assert.ok(rows[1].feed_id > rows[0].feed_id && rows[1].undoes);
  // Ending practice wipes it all and says so.
  const cid3 = randomUUID();
  ok(await sheet(k.scrut.client, p, k.p1, { client_id: cid3, practice: true }));
  ok(await k.scrut.client.action('gotv.check', { typed: 'Practice Name', place_id: k.p1, practice: true, client_id: randomUUID() }));
  const end = ok(await k.mgr.action('vote.settings', { mode: 'off' }));
  assert.equal(end.practice, false);
  assert.equal(end.practice_cleared, 4);
  assert.equal((await db.query('select count(*)::int as n from gotv_practice where workspace_id = $1', [k.ws])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from gotv_checks where workspace_id = $1 and practice', [k.ws])).rows[0].n, 0);
  // A practice mark arriving after: 409 and nothing saved.
  no(await sheet(k.scrut.client, p, k.p1, { practice: true }), 409, 'Practice is over — nothing was saved');
  assert.equal((await db.query('select count(*)::int as n from gotv_practice where workspace_id = $1', [k.ws])).rows[0].n, 0);
});

test('scope: a turf-A canvasser sees only A’s and their bank’s people; B is hidden, not "not voted"; campaign restores it', async () => {
  at(k.G, '12:00');
  ok(await k.mgr.action('vote.settings', { mode: 'on' }));
  const list = ok(await k.volA.client.get('/api/persons?rating=1,2&limit=500'));
  assert.ok(!list.persons.some((p) => p.id === k.inB.id), 'no B rows');
  const notVoted = ok(await k.volA.client.get('/api/persons?voted=no&limit=500')).persons.map((p) => p.id);
  assert.ok(!notVoted.includes(k.inB.id));
  const b = ok(await k.volA.client.get(`/api/persons/${k.inB.id}`)).person;
  assert.equal('voted_at' in b, false);
  assert.equal(b.voted_hidden, true);
  const doors = ok(await k.volA.client.get('/api/map/doors'));
  assert.ok(!doors.persons.some((p) => p.id === k.inB.id), 'the map is A’s doors');
  no(await k.volA.client.get(`/api/voted/persons/${k.inB.id}`), 404);
  const hist = ok(await k.volA.client.get(`/api/persons/${k.inB.id}/timeline`));
  assert.ok(!JSON.stringify(hist).includes('"voted"'), 'no voted entries for B');
  // A's scrutineer mark: "At a voting place", the place's name only for the desk.
  const aHist = JSON.stringify(ok(await k.volA.client.get(`/api/persons/${k.inA.id}/timeline`)));
  assert.ok(aHist.includes('At a voting place') && !aHist.includes('Place One'));
  assert.ok(JSON.stringify(ok(await k.mgr.get(`/api/persons/${k.inA.id}/timeline`))).includes(`At a voting place · Place One ${k.tag}`));
  // A phone bank's number counts as theirs.
  const callee = await k.mgr.createPerson(`Callee Example ${k.tag}`, { phone: '604-555-0177' });
  assert.ok(!ok(await k.volA.client.get('/api/persons?limit=500')).persons.some((p) => p.id === callee.id));
  const bank = ok(await k.mgr.action('bank.create', { name: `Bank ${k.tag}`, person_ids: [callee.id] }));
  const given = ok(await k.mgr.action('bank.assign', { id: bank.bank?.id || bank.id, user_id: k.volA.id, count: 1 }));
  assert.ok(given.handed >= 1 || given.given, JSON.stringify(given));
  assert.ok(ok(await k.volA.client.get('/api/persons?limit=500')).persons.some((p) => p.id === callee.id), 'their bank’s number is theirs');
  // Reports and duplicates stay the desk's.
  no(await k.volA.client.get('/api/reports/people'), 403);
  no(await k.volA.client.get('/api/duplicates'), 403);
  // scope 'campaign' brings back today's behaviour.
  ok(await k.mgr.action('vote.settings', { scope: 'campaign' }));
  assert.ok(ok(await k.volA.client.get(`/api/persons/${k.inB.id}`)).person.voted_at !== undefined);
  ok(await k.mgr.action('vote.settings', { scope: 'turfs', mode: 'off', auto: false }));
  assert.ok('voted_at' in ok(await k.volA.client.get(`/api/persons/${k.inB.id}`)).person, 'GOTV off: nothing changes');
  ok(await k.mgr.action('vote.settings', { auto: true }));
});

test('the sign-in code: GETs leave it unused; one POST signs in to Who voted only; ends with the post', async () => {
  at(k.G, '21:00');
  const code = ok(await k.mgr.action('gotv.signin.code', { user_id: k.scrut.id }));
  assert.ok(code.qr_svg.startsWith('<svg'));
  const token = code.url.split('/go/')[1];
  const page1 = await app.request(`/go/${token}`);
  const page2 = await app.request(`/go/${token}`);
  assert.equal(page1.status, 200);
  assert.ok((await page2.text()).includes('Sign in as Sid'));
  const phone = new Client();
  const signed = ok(await phone.post('/api/auth/go', { token }));
  assert.equal(signed.to, '/gotv');
  no(await new Client().post('/api/auth/go', { token }), 410, 'That code has expired — ask the office for a new one.');
  // Who voted only.
  no(await phone.get('/api/persons'), 403, 'This sign-in only works for Who voted.');
  no(await phone.get('/api/turfs'), 403, 'This sign-in only works for Who voted.');
  no(await phone.get('/api/voted/summary'), 403);
  ok(await phone.get('/api/voted/status'));
  ok(await phone.get(`/api/gotv/open?place_id=${k.p1}&written_at=${new Date().toISOString()}`), 'kept names can be judged');
  ok(await find(phone, 'harjit'));
  const cid = randomUUID();
  ok(await phone.action('vote.mark', { person_id: k.inA2.id, source: 'scrutineer', place_id: k.p1, client_id: cid }));
  ok(await phone.action('vote.undo', { client_id: cid }));
  ok(await phone.action('gotv.check', { typed: 'Code Example', place_id: k.p1, client_id: randomUUID() }));
  no(await phone.action('contact.log', { person_id: k.inA.id, channel: 'door', outcome: 'contacted' }), 403);
  // The token is in no event and no log line.
  const db = await getDb();
  assert.equal((await db.query('select count(*)::int as n from events where workspace_id = $1 and payload::text like $2', [k.ws, `%${token}%`])).rows[0].n, 0);
  // Expired after 15 minutes.
  const late = ok(await k.mgr.action('gotv.signin.code', { user_id: k.scrut.id })).url.split('/go/')[1];
  await db.query("update gotv_signin set expires_at = now() - interval '1 second' where used_at is null and workspace_id = $1", [k.ws]);
  no(await new Client().post('/api/auth/go', { token: late }), 410);
  // The post ends: so does the code's session, and a new code is refused.
  const post = (await db.query('select id from gotv_posts where workspace_id = $1 and user_id = $2 and ended_at is null', [k.ws, k.scrut.id])).rows[0];
  const fresh = ok(await k.mgr.action('gotv.signin.code', { user_id: k.scrut.id })).url.split('/go/')[1];
  ok(await k.mgr.action('gotv.post.end', { id: post.id }));
  assert.equal((await phone.get('/api/voted/status')).status, 401);
  no(await new Client().post('/api/auth/go', { token: fresh }), 410);
  ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1 }));
});

test('places: GOTV keeps a guide place it used; the export carries posts and checks, not practice; the books verify', async () => {
  const db = await getDb();
  ok(await k.mgr.action('site.guide.place.delete', { id: k.p2 }));
  assert.equal((await db.query('select deleted_at from places where id = $1', [k.p2])).rows[0].deleted_at, null, 'kept: GOTV used it');
  const { forgetHours } = await import('../ext/voted/clock.js');
  forgetHours(k.ws);
  assert.ok(ok(await k.mgr.get('/api/gotv/places')).places.some((p) => p.id === k.p2), 'still listed');
  const ex = ok(await k.mgr.get('/api/export'));
  assert.ok(Array.isArray(ex.gotv_posts) && ex.gotv_posts.length >= 2);
  assert.ok(Array.isArray(ex.gotv_checks) && ex.gotv_checks.length >= 1);
  assert.equal(ex.gotv_practice, undefined);
  const v = ok(await k.mgr.get('/api/audit/verify'));
  assert.equal(v.ok, true, JSON.stringify(v));
  // GOTV's SQL creates none of the voter guide's tables and alters neither places nor vote_place_info.
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../ext/voted/sql.js', import.meta.url), 'utf8');
  assert.ok(!/create table if not exists vote_|alter table (places|vote_place_info)\b/.test(sql));
});

test('the migration runs twice; an old mark gets a feed id and inserted_at; a scrutineer source inserts and nope is refused', async () => {
  const db = await getDb();
  const { sql } = await import('../ext/voted/sql.js');
  await db.exec(sql);
  await db.exec(sql);
  assert.equal((await db.query('select count(*)::int as n from voted_marks where workspace_id = $1 and (feed_id is null or inserted_at is null)', [k.ws])).rows[0].n, 0);
  await assert.rejects(db.query("insert into voted_marks (id, workspace_id, person_id, voted, source) values ($1, $2, $3, true, 'nope')", [randomUUID(), k.ws, k.inA.id]));
  await db.query("insert into voted_marks (id, workspace_id, person_id, voted, source) values ($1, $2, $3, true, 'scrutineer')", [randomUUID(), k.ws, k.inA.id]);
  void square;
});
