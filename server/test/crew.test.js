// The crew board (ext/shiftturfs shift_crew + shift.place, ext/volunteers):
// the desk puts each person on a shift onto one of its turfs ("placed"), on
// "No walk list", or back to every turf (the default, unchanged); phones
// follow at once and never lose a turf given by hand or held by another
// shift. A turf taken off the shift (or deleted) puts its crew back to every
// turf. shift.add books someone from the tray in one step — placed, with a
// job — and closes their "Wants to volunteer" request. GET /crew/:id and
// GET /volunteers: who's on, where, first shifts, the tray (free or busy
// then), the roster's stages. Volunteers can't read or do any of it; moving
// walk lists needs Map & turfs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';

let mgr, walker, walkerUser, ws, shift, t1, t2, t3;
const P = {};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const lat = 49.1327; const lng = -122.855;
let n = 0;
const square = () => {
  n += 1;
  const d = n * 0.01;
  return [[lat + d + 0.001, lng - 0.001], [lat + d + 0.001, lng + 0.002], [lat + d - 0.001, lng + 0.002], [lat + d - 0.001, lng - 0.001]];
};
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
const mkTurf = async (name) => ok(await mgr.action('turf.create', { name, polygon: square() })).turf;
const join = async (email, name) => {
  const inv = await mgr.action('member.invite', { email, role: 'volunteer' });
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'walker-pass-1' }));
  return { c, userId: j.user.id };
};
const turfsOf = async (userId) => (await (await getDb()).query(
  'select t.name from turf_members m join turfs t on t.id = m.turf_id and t.deleted_at is null where m.user_id = $1 order by t.name', [userId],
)).rows.map((r) => r.name);
const crew = async (id = shift.id) => ok(await mgr.get(`/api/crew/${id}`));
const crewOf = async (personId) => (await crew()).crew.find((x) => x.person_id === personId);

before(async () => {
  await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Crew board', jurisdiction: 'bc-municipal' })).json.workspace.id;
  ({ c: walker, userId: walkerUser } = await join('walker.crew@example.org', 'Walker Example'));
  t1 = await mkTurf('Newton block');
  t2 = await mkTurf('72 Ave east');
  t3 = await mkTurf('Fleetwood loop');
  shift = ok(await mgr.action('shift.create', { title: 'Saturday canvass', location: 'Newton Rec Centre', starts_at: inDays(3), ends_at: inDays(3.1), capacity: 4 })).shift;
  ok(await mgr.action('shift.turfs.set', { shift_id: shift.id, turf_ids: [t1.id, t2.id] }));
  P.asker = await mgr.createPerson('Asker Example', { phone: '604-555-0171' });
  P.driver = await mgr.createPerson('Driver Example', { phone: '604-555-0172' });
  P.nosign = await mgr.createPerson('Nosign Example', { phone: '604-555-0173' });
  ok(await mgr.action('request.ask', { person_id: P.asker.id, kind: 'volunteer', note: 'Wants to knock on Saturdays' }));
  ok(await mgr.action('volunteer.assign', { person_id: P.driver.id, role: 'driver' }));
});

test('not placed: every turf the shift carries, as before the board', async () => {
  const j = ok(await walker.action('shift.join', { shift_id: shift.id }));
  P.walker = { id: j.assignment.person_id, assignment: j.assignment.id };
  assert.deepEqual(await turfsOf(walkerUser), ['72 Ave east', 'Newton block']);
  const me = await crewOf(P.walker.id);
  assert.deepEqual([me.to, me.job, me.signed_in, me.first_shift], ['every', null, true, true]);
});

test('placed on one turf: only that one on their phone; none; every again', async () => {
  const r = ok(await mgr.action('shift.place', { id: P.walker.assignment, to: t2.id }));
  assert.deepEqual([r.added, r.removed], [[], [t1.id]]);
  assert.deepEqual(await turfsOf(walkerUser), ['72 Ave east']);
  assert.equal((await crewOf(P.walker.id)).to, t2.id);

  ok(await mgr.action('shift.place', { id: P.walker.assignment, to: 'none' }));
  assert.deepEqual(await turfsOf(walkerUser), []);
  assert.equal((await crewOf(P.walker.id)).to, 'none');

  ok(await mgr.action('shift.place', { id: P.walker.assignment, to: 'every' }));
  assert.deepEqual(await turfsOf(walkerUser), ['72 Ave east', 'Newton block']);

  // A turf the shift doesn't carry is refused; so is nothing to do.
  assert.equal((await mgr.action('shift.place', { id: P.walker.assignment, to: t3.id })).status, 400);
  assert.equal((await mgr.action('shift.place', { id: P.walker.assignment })).status, 400);
});

test('a turf given by hand stays when the board moves them; a job is kept', async () => {
  ok(await mgr.action('turf.assign', { turf_id: t1.id, user_id: walkerUser }));
  ok(await mgr.action('shift.place', { id: P.walker.assignment, to: t2.id, job: 'lead' }));
  assert.deepEqual(await turfsOf(walkerUser), ['72 Ave east', 'Newton block'], 'Newton block was given by hand');
  const me = await crewOf(P.walker.id);
  assert.deepEqual([me.to, me.job], [t2.id, 'lead']);
  ok(await mgr.action('turf.unassign', { turf_id: t1.id, user_id: walkerUser }));
  assert.deepEqual(await turfsOf(walkerUser), ['72 Ave east']);
  ok(await mgr.action('shift.place', { id: P.walker.assignment, job: null }));
  assert.deepEqual([(await crewOf(P.walker.id)).to, (await crewOf(P.walker.id)).job], [t2.id, null], 'a job alone leaves the turf');
});

test('confirming keeps them where they were placed', async () => {
  ok(await mgr.action('shift.setStatus', { id: P.walker.assignment, status: 'declined' }));
  assert.deepEqual(await turfsOf(walkerUser), []);
  ok(await mgr.action('shift.setStatus', { id: P.walker.assignment, status: 'confirmed' }));
  assert.deepEqual(await turfsOf(walkerUser), ['72 Ave east'], 'back on, on the turf they were placed on only');
});

test('shift.add from the tray: booked, placed, a job, and their "Wants to volunteer" done', async () => {
  const before = (await crew()).tray.map((v) => v.name);
  assert.ok(before.includes('Asker Example') && before.includes('Driver Example'));
  assert.ok(!before.includes('Walker Example'), 'someone on the shift is not in the tray');
  const asker = (await crew()).tray.find((v) => v.id === P.asker.id);
  assert.deepEqual([asker.asked, asker.stage, asker.busy], [true, 'new', null]);

  const r = ok(await mgr.action('shift.add', { shift_id: shift.id, person_id: P.asker.id, to: t1.id }));
  assert.equal(r.requests_done, 1);
  const req = (await mgr.get(`/api/persons/${P.asker.id}/requests`)).json.requests[0];
  assert.ok(req.done_at);
  assert.match(req.done_note, /^On Saturday canvass, [A-Z][a-z]{2} \d{1,2}$/);
  const a = await crewOf(P.asker.id);
  assert.deepEqual([a.to, a.signed_in, a.first_shift], [t1.id, false, true]);

  ok(await mgr.action('shift.add', { shift_id: shift.id, person_id: P.driver.id, to: 'none', job: 'driver' }));
  const d = await crewOf(P.driver.id);
  assert.deepEqual([d.to, d.job], ['none', 'driver']);
  assert.equal((await mgr.action('shift.add', { shift_id: shift.id, person_id: P.driver.id })).status, 409, 'already on it');
  assert.equal((await mgr.action('shift.add', { shift_id: shift.id, person_id: P.nosign.id, to: t3.id })).status, 400);
});

test('room is the core’s rule; someone who couldn’t make it is booked again', async () => {
  ok(await mgr.action('shift.add', { shift_id: shift.id, person_id: P.nosign.id }));
  const extra = await mgr.createPerson('Extra Example', { phone: '604-555-0174' });
  assert.equal((await mgr.action('shift.add', { shift_id: shift.id, person_id: extra.id })).status, 409, 'four of four');
  const no = await crewOf(P.nosign.id);
  ok(await mgr.action('shift.setStatus', { id: no.assignment_id, status: 'declined' }));
  const c = await crew();
  assert.deepEqual(c.out.map((x) => x.name), ['Nosign Example']);
  ok(await mgr.action('shift.add', { shift_id: shift.id, person_id: P.nosign.id, to: t2.id }));
  const back = await crewOf(P.nosign.id);
  assert.deepEqual([back.assignment_id, back.status, back.to], [no.assignment_id, 'assigned', t2.id]);
});

test('a turf taken off the shift (or deleted): its crew walks every turf left', async () => {
  // The walker is on 72 Ave east; Asker on Newton block.
  ok(await mgr.action('shift.turfs.set', { shift_id: shift.id, turf_ids: [t1.id, t3.id] }));
  assert.equal((await crewOf(P.walker.id)).to, 'every');
  assert.deepEqual(await turfsOf(walkerUser), ['Fleetwood loop', 'Newton block']);
  assert.equal((await crewOf(P.asker.id)).to, t1.id, 'Newton block is still on the shift');
  ok(await mgr.action('turf.delete', { id: t1.id }));
  assert.equal((await crewOf(P.asker.id)).to, 'every');
  assert.deepEqual(await turfsOf(walkerUser), ['Fleetwood loop']);
});

test('the tray says who is busy then; the roster’s stages and counts', async () => {
  const other = ok(await mgr.action('shift.create', { title: 'Phone bank', starts_at: inDays(3.02), ends_at: inDays(3.2) })).shift;
  const busyOne = await mgr.createPerson('Busy Example', { phone: '604-555-0175' });
  ok(await mgr.action('shift.assign', { shift_id: other.id, person_id: busyOne.id }));
  const b = (await crew()).tray.find((v) => v.id === busyOne.id);
  assert.equal(b.busy.title, 'Phone bank');

  // A shift long ago: done once, nothing since → lapsed.
  const past = ok(await mgr.action('shift.create', { title: 'Summer BBQ', starts_at: inDays(-60), ends_at: inDays(-59.9) })).shift;
  const old = await mgr.createPerson('Lapsed Example', { phone: '604-555-0176' });
  ok(await mgr.action('shift.assign', { shift_id: past.id, person_id: old.id }));
  const nope = await mgr.createPerson('Noshow Example', { phone: '604-555-0177' });
  const ns = ok(await mgr.action('shift.assign', { shift_id: past.id, person_id: nope.id })).assignment;
  ok(await mgr.action('shift.setStatus', { id: ns.id, status: 'no_show' }));

  const roster = ok(await mgr.get('/api/volunteers'));
  const by = Object.fromEntries(roster.volunteers.map((v) => [v.name, v]));
  assert.deepEqual([by['Lapsed Example'].stage, by['Lapsed Example'].done], ['lapsed', 1]);
  assert.deepEqual([by['Asker Example'].stage, by['Asker Example'].asked, by['Asker Example'].next.title], ['active', false, 'Saturday canvass']);
  assert.deepEqual([by['Noshow Example'].no_shows, by['Noshow Example'].stage], [1, 'new']);
  assert.deepEqual(by['Driver Example'].roles, ['driver']);
  assert.equal(by['Walker Example'].signed_in, true);
  assert.equal(roster.counts.all, roster.volunteers.length);
  assert.equal(roster.counts.active + roster.counts.new + roster.counts.lapsed, roster.counts.all);
  assert.equal(by['Driver Example'].phone, '604-555-0172');
});

test('volunteers can’t read the roster or the board, or move anyone; walk lists need Map & turfs', async () => {
  assert.equal((await walker.get('/api/volunteers')).status, 403);
  assert.equal((await walker.get(`/api/crew/${shift.id}`)).status, 403);
  assert.equal((await walker.action('shift.place', { id: P.walker.assignment, to: 'every' })).status, 403);
  assert.equal((await walker.action('shift.add', { shift_id: shift.id, person_id: P.walker.id })).status, 403);
  assert.equal((await mgr.get('/api/crew/not-a-uuid')).status, 404);

  // Staff kept out of Map & turfs: a job, yes; a turf, no.
  const { userId: staffUser } = await join('staff.crew@example.org', 'Staff Example');
  const db = await getDb();
  await db.query("update memberships set role = 'staff' where user_id = $1 and workspace_id = $2", [staffUser, ws]);
  ok(await mgr.action('permission.member.set', { user_id: staffUser, grant: [], deny: ['map'] }));
  const staff = new Client();
  ok(await staff.post('/api/auth/login', { email: 'staff.crew@example.org', password: 'walker-pass-1' }));
  ok(await staff.action('shift.place', { id: P.walker.assignment, job: 'lead' }));
  assert.equal((await staff.action('shift.place', { id: P.walker.assignment, to: 'none' })).status, 403);
  // And the log still verifies.
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
