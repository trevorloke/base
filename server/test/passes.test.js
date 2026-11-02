// Passes: sweep a turf again, and come back to not-home doors (ext/passes).
// With no pass the walk lists work as they always did (organize.test.js
// stays untouched); pass.start ends the open pass and starts the new one;
// volunteers are refused and read only the open pass; a persuasion pass with
// two tries brings knocked doors back, keeps a No answer door as "again" and
// finishes it on the second, or at once on a talk; universes narrow the
// lists and the counts; door knocks are stamped with the pass (never a call,
// never a tap from before it started; a visit_of amendment keeps it); a lit
// drop finishes a door on any visit; the brief carries the open pass; the
// export carries the passes; and the books verify. Plus the shared rule on
// its own. test:pg-safe: unique emails per run, everything scoped to this
// workspace.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { doorState, inUniverse, inPass, passLine, KINDS, WHO } from '@starbase/shared/passes';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, vol, ws, turf;
const P = {};
const lat = 49.1327; const lng = -122.855;

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const knock = (c, personId, outcome, extra = {}) => c.action('contact.log', { person_id: personId, channel: 'door', outcome, ...extra });
const walk = async (c = mgr) => ok(await c.get(`/api/turfs/${turf.id}/walk`), 'walk');
const turfRow = async (c = mgr) => ok(await c.get('/api/turfs'), 'turfs').turfs.find((t) => t.id === turf.id);
const doorOf = (w, address) => w.doors.find((d) => d.address === address);
const start = async (input) => ok(await mgr.action('pass.start', input), 'pass.start').pass;

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Imagine Surrey ${tag}`, email: `pass-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  // A turf of four doors, as organize.test.js builds it (odd side up, even side back).
  const mk = async (key, name, address, dLng, extra = {}) => { P[key] = await mgr.createPerson(name, { address, lat, lng: lng + dLng, ...extra }); };
  await mk('a', 'Ana Example', '13213 72 Ave', 0.0000);
  await mk('b', 'Ben Example', '13225 72 Ave', 0.0003);
  await mk('c', 'Cy Example', '13224 72 Ave', 0.0003);
  await mk('d', 'Dee Example', '13212 72 Ave', 0.0000);
  await mgr.createPerson('Far Example', { address: '1 Other Rd', lat: 49.3, lng: -122.5 });
  turf = ok(await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  })).turf;
  const inv = ok(await mgr.action('member.invite', { email: `pass-vol+${tag}@example.org`, role: 'volunteer' }));
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Jas Example', password: 'walker-pass-1' }));
  const walker = ok(await mgr.get('/api/members')).members.find((m) => m.name === 'Jas Example');
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: walker.id }));
});

test('with no pass, /turfs and /walk behave exactly as before', async () => {
  ok(await knock(mgr, P.a.id, 'contacted', { rating: '1' }), 'a knock before any pass');
  const t = await turfRow();
  assert.equal(t.doors, 4, 'the far-away person is not in the turf');
  assert.equal(t.doorsDone, 1);
  assert.equal(t.doorsAgain, 0);
  const w = await walk();
  assert.equal(w.pass, null);
  assert.deepEqual(w.doors.map((d) => d.address), ['13213 72 Ave', '13225 72 Ave', '13224 72 Ave', '13212 72 Ave'], 'walk order unchanged');
  assert.equal(w.doors[0].done, true);
  assert.equal(w.doors[0].state, 'done');
  assert.equal(w.doors[1].done, false);
  assert.equal(w.doors[1].state, 'open');
  assert.equal(w.stats.doorsDone, 1);
  assert.equal(w.stats.doorsAgain, 0);
  assert.deepEqual(ok(await mgr.get('/api/passes')), { open: null, past: [] });
  assert.deepEqual(ok(await vol.get('/api/passes')), { open: null, past: [] });
});

test('pass.start ends the open pass; one open per workspace; volunteers refused', async () => {
  const p1 = await start({ name: 'Persuasion · first', kind: 'persuasion', who: 'all', tries: 2 });
  assert.equal(p1.ended_at, null);
  assert.equal(p1.tries, 2);
  const r2 = ok(await mgr.action('pass.start', { name: 'Persuasion · second', kind: 'persuasion' }), 'a second start');
  assert.equal(r2.ended, p1.id, 'the first one is ended by the second start');
  assert.equal(r2.pass.who, 'all', 'who defaults to all');
  assert.equal(r2.pass.tries, 2, 'tries defaults to 2');
  const db = await getDb();
  const rows = (await db.query('select id, ended_at from canvass_passes where workspace_id = $1 order by created_at', [ws])).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows[0].ended_at, 'the first has ended_at');
  assert.equal(rows[1].ended_at, null);
  assert.equal((await db.query('select count(*)::int as n from canvass_passes where workspace_id = $1 and ended_at is null', [ws])).rows[0].n, 1, 'one open pass');

  // Volunteers may not start, end or change a pass; they read only the open one.
  assert.equal((await vol.action('pass.start', { name: 'v', kind: 'persuasion' })).status, 403);
  assert.equal((await vol.action('pass.end', { id: r2.pass.id })).status, 403);
  assert.equal((await vol.action('pass.update', { id: r2.pass.id, tries: 3 })).status, 403);
  const v = ok(await vol.get('/api/passes'));
  assert.equal(v.open.id, r2.pass.id);
  assert.equal(v.open.name, 'Persuasion · second');
  assert.deepEqual(v.past, [], 'a volunteer gets no past passes');
  const d = ok(await mgr.get('/api/passes'));
  assert.equal(d.open.id, r2.pass.id);
  assert.deepEqual(d.open.stats, { doors_knocked: 0, talked: 0, support_found: 0 });
  assert.equal(d.past.length, 1);
  assert.equal(d.past[0].id, p1.id);
  assert.ok(d.past[0].ended_at);
  assert.deepEqual(d.past[0].stats, { doors_knocked: 0, talked: 0, support_found: 0 });

  // Bad input is refused; a pass of another campaign is not found.
  assert.equal((await mgr.action('pass.start', { name: '', kind: 'persuasion' })).status, 400);
  assert.equal((await mgr.action('pass.start', { name: 'x', kind: 'canvass' })).status, 400);
  assert.equal((await mgr.action('pass.start', { name: 'x', kind: 'persuasion', tries: 6 })).status, 400);
  const other = new Client();
  await other.signup({ workspaceName: `Other ${tag}`, email: `pass-other+${tag}@example.org` });
  assert.equal((await other.action('pass.end', { id: r2.pass.id })).status, 404, 'another campaign’s pass is not found');
  assert.equal((await other.get('/api/passes')).json.open, null);

  // pass.update changes the open pass; pass.end closes it once.
  const up = ok(await mgr.action('pass.update', { id: r2.pass.id, name: 'Persuasion · renamed', tries: 3 }), 'update').pass;
  assert.equal(up.name, 'Persuasion · renamed');
  assert.equal(up.tries, 3);
  const ended = ok(await mgr.action('pass.end', { id: r2.pass.id }), 'end').pass;
  assert.ok(ended.ended_at);
  assert.equal((await mgr.action('pass.end', { id: r2.pass.id })).status, 409, 'already over');
  assert.equal((await mgr.action('pass.update', { id: r2.pass.id, tries: 1 })).status, 409, 'an ended pass can’t change');
  assert.equal((await mgr.action('pass.end', { id: randomUUID() })).status, 404);
  assert.equal(ok(await mgr.get('/api/passes')).open, null);
  // Back to the old rule: the door knocked before is done again.
  assert.equal((await walk()).doors[0].state, 'done');
});

test('a persuasion pass tries=2: knocked doors come back, No answer is "again" until the limit, a talk finishes', async () => {
  const pass = await start({ name: 'Persuasion · October', kind: 'persuasion', who: 'all', tries: 2 });
  let w = await walk();
  assert.equal(w.pass.id, pass.id);
  assert.equal(w.pass.tries, 2);
  assert.equal(doorOf(w, '13213 72 Ave').state, 'open', 'a door knocked before the pass is open again');
  assert.equal(doorOf(w, '13213 72 Ave').done, false);
  assert.equal(doorOf(w, '13213 72 Ave').tries, 0);
  assert.equal(w.stats.doors, 4);
  assert.equal(w.stats.doorsDone, 0);
  assert.equal((await turfRow()).doorsDone, 0);

  // No answer: the door stays in the count, to try again.
  ok(await knock(vol, P.a.id, 'no_answer'), 'first no answer');
  w = await walk(vol);
  let a = doorOf(w, '13213 72 Ave');
  assert.equal(a.state, 'again');
  assert.equal(a.tries, 1);
  assert.equal(a.done, false);
  assert.equal(a.persons[0].pass_tries, 1);
  assert.equal(a.persons[0].pass_last_outcome, 'no_answer');
  assert.equal(w.stats.doors - w.stats.doorsDone, 4, 'doors left unchanged');
  assert.equal(w.stats.doorsAgain, 1);
  const t = await turfRow();
  assert.equal(t.doorsDone, 0);
  assert.equal(t.doorsAgain, 1);

  // The second No answer gives the door up.
  ok(await knock(vol, P.a.id, 'no_answer'), 'second no answer');
  w = await walk();
  a = doorOf(w, '13213 72 Ave');
  assert.equal(a.state, 'done');
  assert.equal(a.tries, 2);
  assert.equal(a.done, true);
  assert.equal(w.stats.doorsDone, 1);
  assert.equal(w.stats.doorsAgain, 0);

  // A fresh door with a talk is done on the first try.
  ok(await knock(vol, P.b.id, 'contacted', { rating: '3' }), 'a talk');
  w = await walk();
  assert.equal(doorOf(w, '13225 72 Ave').state, 'done');
  assert.equal(doorOf(w, '13225 72 Ave').tries, 1);
  assert.equal(w.stats.doorsDone, 2);
  assert.equal(w.stats.doors - w.stats.doorsDone, 2);

  // The knocks carry the pass; the stats count them.
  const db = await getDb();
  const stamped = (await db.query('select person_id, outcome from contacts where workspace_id = $1 and pass_id = $2 order by created_at', [ws, pass.id])).rows;
  assert.deepEqual(stamped.map((r) => `${r.person_id === P.a.id ? 'a' : 'b'}:${r.outcome}`), ['a:no_answer', 'a:no_answer', 'b:contacted']);
  const s = ok(await mgr.get('/api/passes')).open.stats;
  assert.deepEqual(s, { doors_knocked: 2, talked: 1, support_found: 0 });
  assert.equal(passLine(pass), 'Persuasion · All doors · 2 tries');
});

test('universes: who=unrated leaves rated doors out; who=support keeps only support; a household with one unrated person stays in', async () => {
  // Ana is rated 1 (support), Ben 3 (undecided), Cy and Dee unrated; Eve,
  // unrated, lives at Ana's door.
  P.e = await mgr.createPerson('Eve Example', { address: '13213 72 Ave', lat, lng });
  await start({ name: 'ID · unrated', kind: 'id', who: 'unrated', tries: 2 });
  let w = await walk();
  assert.deepEqual(w.doors.map((d) => d.address).sort(), ['13212 72 Ave', '13213 72 Ave', '13224 72 Ave'], 'Ben’s door is out; Ana’s stays for Eve');
  assert.equal(w.stats.doors, 3);
  assert.equal(w.stats.people, 4, 'Ana, Eve, Cy, Dee');
  assert.equal((await turfRow()).doors, 3);
  assert.equal(doorOf(w, '13213 72 Ave').state, 'open', 'a new pass: nothing knocked in it yet');

  await start({ name: 'GOTV · supporters', kind: 'gotv', who: 'support', tries: 3 });
  w = await walk();
  assert.deepEqual(w.doors.map((d) => d.address), ['13213 72 Ave'], 'only the door with a support-band person');
  assert.equal(w.stats.doors, 1);
  assert.equal(w.pass.kind, 'gotv');
  assert.equal((await turfRow()).doors, 1);

  await start({ name: 'Persuasion · undecided', kind: 'persuasion', who: 'undecided', tries: 2 });
  w = await walk();
  assert.deepEqual(w.doors.map((d) => d.address).sort(), ['13212 72 Ave', '13213 72 Ave', '13224 72 Ave', '13225 72 Ave'], 'undecided or not rated: everyone but a pure-support door — Eve keeps Ana’s in');

  await start({ name: 'Persuasion · not opposed', kind: 'persuasion', who: 'not_opposed', tries: 2 });
  ok(await knock(mgr, P.d.id, 'contacted', { rating: '4' }), 'Dee is opposed');
  w = await walk();
  assert.deepEqual(w.doors.map((d) => d.address).sort(), ['13213 72 Ave', '13224 72 Ave', '13225 72 Ave'], 'Dee’s door leaves the list');
  // Volunteers see the same list, person rows still filtered (no emails).
  const vw = await walk(vol);
  assert.equal(vw.doors.length, 3);
  assert.ok(vw.doors.every((d) => d.persons.every((p) => p.email == null)));
  assert.equal(typeof vw.doors[0].persons[0].pass_tries, 'number', 'the pass fields stay on a volunteer’s rows');
});

test('stamping: never a tap from before the pass, never a call; a visit_of amendment keeps the stamp and its outcome changes the door', async () => {
  const pass = await start({ name: 'Persuasion · stamps', kind: 'persuasion', who: 'all', tries: 2 });
  const db = await getDb();
  const passOf = async (id) => (await db.query('select pass_id from contacts where id = $1 and workspace_id = $2', [id, ws])).rows[0].pass_id;
  const before = new Date(new Date(pass.started_at).getTime() - 86400_000).toISOString();
  // A knock replayed from a phone that tapped it the day before the pass began.
  const old = ok(await knock(vol, P.c.id, 'no_answer', { client_id: randomUUID(), client_at: before }), 'an old tap').contact;
  assert.equal(await passOf(old.id), null, 'a tap from before the pass is not stamped');
  assert.equal(doorOf(await walk(), '13224 72 Ave').state, 'open', '…and the door is still open in this pass');
  // A call is never a knock.
  const call = ok(await mgr.action('contact.log', { person_id: P.c.id, channel: 'phone', outcome: 'contacted', rating: '2' }), 'a call').contact;
  assert.equal(await passOf(call.id), null, 'a phone contact is never stamped');
  assert.equal(doorOf(await walk(), '13224 72 Ave').state, 'open', 'a call doesn’t finish a door in a pass either');
  // A tap with a client_at after the start is stamped like any other.
  const fresh = ok(await knock(vol, P.d.id, 'no_answer', { client_id: randomUUID(), client_at: new Date().toISOString() }), 'a fresh tap').contact;
  assert.equal(await passOf(fresh.id), pass.id);
  assert.equal(doorOf(await walk(), '13212 72 Ave').state, 'again');
  // A replay of it is the same knock: one row, one stamp.
  const again = await knock(vol, P.d.id, 'no_answer', { client_id: fresh.client_id, client_at: new Date().toISOString() });
  assert.equal(again.json.duplicate, true);
  assert.equal(doorOf(await walk(), '13212 72 Ave').tries, 1, 'a replay is not a second try');

  // "Save answers" (a talk with no rating), then the same visit finished.
  const cid = randomUUID();
  const first = ok(await knock(vol, P.c.id, 'contacted', { client_id: cid }), 'the visit’s first tap').contact;
  assert.equal(await passOf(first.id), pass.id, 'stamped');
  assert.equal(doorOf(await walk(), '13224 72 Ave').state, 'done', 'a talk finishes the door');
  const amended = ok(await knock(vol, P.c.id, 'no_answer', { client_id: randomUUID(), visit_of: cid }), 'the same visit, amended');
  assert.equal(amended.amended, true);
  assert.equal(amended.contact.id, first.id, 'one record for the visit');
  assert.equal(await passOf(first.id), pass.id, 'the stamp stays');
  const n = (await db.query('select count(*)::int as n from contacts where workspace_id = $1 and person_id = $2 and pass_id = $3', [ws, P.c.id, pass.id])).rows[0].n;
  assert.equal(n, 1, 'still one knock in the pass for Cy');
  const c = doorOf(await walk(), '13224 72 Ave');
  assert.equal(c.state, 'again', 'its new outcome changes the door’s state');
  assert.equal(c.tries, 1);
});

test('kind=lit: any door contact finishes the door', async () => {
  await start({ name: 'Lit · flyers', kind: 'lit', who: 'all', tries: 2 });
  let w = await walk();
  assert.ok(w.doors.every((d) => d.state === 'open'), 'a new pass: every door open');
  ok(await knock(vol, P.c.id, 'no_answer'), 'a no answer while dropping lit');
  w = await walk();
  assert.equal(doorOf(w, '13224 72 Ave').state, 'done');
  assert.equal(w.stats.doorsDone, 1);
  assert.equal(w.stats.doorsAgain, 0);
});

test('brief.pass is set for a volunteer and null after pass.end; the export carries the passes; the books verify', async () => {
  const open = ok(await mgr.get('/api/passes')).open;
  assert.equal(open.name, 'Lit · flyers');
  const b = ok(await vol.get('/api/brief'));
  assert.equal(b.pass.id, open.id);
  assert.equal(b.pass.kind, 'lit');
  assert.equal(b.pass.name, 'Lit · flyers');
  assert.ok(b.pass.started_at);
  assert.equal(b.myTurfs[0].name, 'Newton block');
  ok(await mgr.action('pass.end', { id: open.id }));
  assert.equal(ok(await vol.get('/api/brief')).pass, null);
  const exp = ok(await mgr.get('/api/export'));
  assert.ok(Array.isArray(exp.canvass_passes));
  assert.equal(exp.canvass_passes.length, 9, 'every pass this file started');
  assert.ok(exp.canvass_passes.every((p) => p.workspace_id === ws && p.ended_at));
  assert.ok(exp.contacts.some((c) => c.pass_id), 'contacts.pass_id rides along');
  assert.equal((await vol.get('/api/export')).status, 403);
  const v = ok(await mgr.get('/api/audit/verify'));
  assert.equal(v.ok, true);
  assert.ok(v.checked > 20);
});

// ── The shared rule on its own ──
test('shared/passes: doorState and inUniverse over hand-built people', () => {
  const persuasion = { kind: 'persuasion', who: 'all', tries: 2 };
  const gotv = { kind: 'gotv', who: 'support', tries: 3 };
  const lit = { kind: 'lit', who: 'all', tries: 2 };
  const voted = { rating: '1', voted_at: '2026-10-18T10:00:00Z' };
  assert.equal(inUniverse(voted, gotv), false, 'someone who voted is out of a GOTV universe');
  assert.equal(inUniverse(voted, persuasion), true, '…and in a persuasion one');
  assert.equal(inUniverse({ rating: '1' }, gotv), true);
  assert.equal(inUniverse({ rating: '3' }, { kind: 'persuasion', who: 'support' }), false);
  assert.equal(inUniverse({ rating: null }, { kind: 'id', who: 'unrated' }), true);
  assert.equal(inUniverse({ rating: '3' }, { kind: 'id', who: 'unrated' }), false);
  assert.equal(inUniverse({ rating: '3' }, { kind: 'persuasion', who: 'undecided' }), true);
  assert.equal(inUniverse({ rating: '4B' }, { kind: 'persuasion', who: 'not_opposed' }), false);
  assert.equal(inUniverse({ rating: '2' }, { kind: 'persuasion', who: 'not_opposed' }), true);
  assert.equal(inUniverse({ rating: '4' }, null), true, 'no pass: everyone');
  assert.equal(inPass({ persons: [{ rating: '1' }, { rating: null }] }, { kind: 'id', who: 'unrated' }), true, 'one person in the universe keeps the door');
  assert.equal(inPass({ persons: [{ rating: '1' }] }, { kind: 'id', who: 'unrated' }), false);

  const door = (...persons) => ({ persons });
  assert.equal(doorState(door({ door_knocked: true }), null), 'done', 'no pass: the old rule');
  assert.equal(doorState(door({ door_knocked: false }), null), 'open');
  assert.equal(doorState(door({ pass_tries: 0, pass_last_outcome: null }), persuasion), 'open');
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'no_answer' }), persuasion), 'again');
  assert.equal(doorState(door({ pass_tries: 2, pass_last_outcome: 'no_answer' }), persuasion), 'done', 'the tries ran out');
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'contacted' }), persuasion), 'done');
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'refused' }), persuasion), 'done');
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'no_answer' }, { pass_tries: 1, pass_last_outcome: 'moved' }), persuasion), 'done', 'anyone’s terminal outcome');
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'no_answer' }, { pass_tries: 0, pass_last_outcome: null }), persuasion), 'again');
  assert.equal(doorState(door({ pass_tries: 2, pass_last_outcome: 'no_answer' }), gotv), 'again', 'three tries: two is not the limit');
  // A lit drop is a not-home: a try in a persuasion pass (it comes back until
  // the tries run out), and it finishes the door in a lit pass.
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'left_lit' }), persuasion), 'again');
  assert.equal(doorState(door({ pass_tries: 2, pass_last_outcome: 'left_lit' }), persuasion), 'done', 'lit twice: the tries ran out');
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'left_lit' }), lit), 'done');
  assert.equal(doorState(door({ pass_tries: 1, pass_last_outcome: 'no_answer' }), lit), 'done', 'any visit finishes a lit door');
  assert.equal(passLine(null), 'No pass open');
  assert.equal(passLine({ kind: 'gotv', who: 'support', tries: 1 }), 'Get out the vote · Yes (1–2) · 1 try');
  assert.deepEqual(KINDS.map((k) => k.code), ['persuasion', 'gotv', 'lit', 'id']);
  assert.deepEqual(WHO.map((w) => w.code), ['all', 'unrated', 'undecided', 'support', 'not_opposed']);
});

// ── Lit drops inside a pass (ext/litdrop) ──
test('a lit drop is a not-home: a try in a persuasion pass, given up when the tries run out; it finishes a lit-pass door', async () => {
  const pass = await start({ name: 'Persuasion · lit drops', kind: 'persuasion', who: 'all', tries: 2 });
  ok(await knock(vol, P.d.id, 'left_lit'), 'first drop');
  let w = await walk(vol);
  let d = doorOf(w, '13212 72 Ave');
  assert.equal(d.state, 'again', 'nobody home, lit left: the door comes back');
  assert.equal(d.tries, 1);
  ok(await knock(vol, P.d.id, 'left_lit'), 'second drop');
  w = await walk(vol);
  d = doorOf(w, '13212 72 Ave');
  assert.equal(d.state, 'done', 'lit left twice: the tries ran out');
  assert.equal(d.tries, 2);
  ok(await mgr.action('pass.end', { id: pass.id }));
  const lit = await start({ name: 'Lit · second round', kind: 'lit', who: 'all', tries: 2 });
  ok(await knock(vol, P.d.id, 'left_lit'), 'a drop in a lit pass');
  assert.equal(doorOf(await walk(vol), '13212 72 Ave').state, 'done');
  ok(await mgr.action('pass.end', { id: lit.id }));
});
