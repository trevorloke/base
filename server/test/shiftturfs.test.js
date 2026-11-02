// Shifts on a turf (server/ext/shiftturfs): a shift carries turfs, and
// "Count me in" / the desk's assign put the walker on them; leaving, being
// taken off, declined or no_show take back only what the shift gave.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';

let mgr, vol, ws, walkerId, walkerPersonId;
const lat = 49.1327; const lng = -122.855;
const square = (dLat = 0) => [
  [lat + dLat + 0.001, lng - 0.001], [lat + dLat + 0.001, lng + 0.002],
  [lat + dLat - 0.001, lng + 0.002], [lat + dLat - 0.001, lng - 0.001],
];
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString();
let turfN = 0;
const mkTurf = async (name) => {
  turfN += 1;
  const r = await mgr.action('turf.create', { name, polygon: square(turfN * 0.01), color: '#2b6cb0' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.turf;
};
const mkShift = async (title, days = 3, turfs = []) => {
  const r = await mgr.action('shift.create', { title, location: 'Newton Rec Centre', starts_at: inDays(days), ends_at: inDays(days + 0.1) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (turfs.length) {
    const set = await mgr.action('shift.turfs.set', { shift_id: r.json.shift.id, turf_ids: turfs.map((t) => t.id) });
    assert.equal(set.status, 200, JSON.stringify(set.json));
  }
  return r.json.shift;
};
const joinAs = async (email, name) => {
  const inv = await mgr.action('member.invite', { email, role: 'volunteer' });
  const c = new Client();
  const j = await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'walker-pass-1' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { c, userId: j.json.user.id };
};
const turfsOf = async (c) => (await c.get('/api/turfs')).json.turfs.map((t) => t.name).sort();
const membersOn = async (turfId) => (await (await getDb()).query(
  'select user_id from turf_members where turf_id = $1 order by user_id', [turfId],
)).rows.map((r) => r.user_id);
const assignmentOf = async (shiftId, personId) => (await mgr.get(`/api/shifts/${shiftId}`)).json.assignees
  .find((a) => a.id === personId);

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  ({ c: vol, userId: walkerId } = await joinAs('walker@example.org', 'Walker Example'));
});

test('shift.turfs.set then Count me in puts the walk list on the volunteer', async () => {
  await mgr.createPerson('Door Example', { address: '13213 72 Ave', lat: lat + 0.01, lng });
  const newton = await mkTurf('Newton block');
  const east = await mkTurf('72 Ave east');
  const shift = await mkShift('Saturday canvass', 3, [newton, east]);

  // The desk reads the shift's turfs; the volunteer has none yet.
  const one = await mgr.get(`/api/shiftturfs/${shift.id}`);
  assert.deepEqual(one.json.turfs.map((t) => t.name), ['Newton block', '72 Ave east'], 'in the campaign’s turf order');
  assert.deepEqual(one.json.no_sign_in, []);
  assert.deepEqual(await turfsOf(vol), []);
  assert.equal((await vol.get(`/api/turfs/${newton.id}/walk`)).status, 403);

  const join = await vol.action('shift.join', { shift_id: shift.id });
  assert.equal(join.status, 200, JSON.stringify(join.json));
  walkerPersonId = join.json.assignment.person_id;
  assert.deepEqual(await turfsOf(vol), ['72 Ave east', 'Newton block']);
  const walk = await vol.get(`/api/turfs/${newton.id}/walk`);
  assert.equal(walk.status, 200);
  assert.equal(walk.json.doors.length, 1);

  const brief = (await vol.get('/api/brief')).json;
  assert.deepEqual(brief.myTurfs.map((t) => t.name), ['Newton block', '72 Ave east']);
  assert.deepEqual(brief.shiftTurfs[shift.id], [{ id: newton.id, name: 'Newton block' }, { id: east.id, name: '72 Ave east' }]);

  // A volunteer reads every shift's turfs — names and colours, nothing else.
  const all = await vol.get('/api/shiftturfs');
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.shifts[shift.id], [
    { id: newton.id, name: 'Newton block', color: '#2b6cb0' },
    { id: east.id, name: '72 Ave east', color: '#2b6cb0' },
  ]);
  const mine = await vol.get(`/api/shiftturfs/${shift.id}`);
  assert.deepEqual(Object.keys(mine.json), ['turfs'], 'no one’s sign-in status for a volunteer');
  assert.equal((await vol.get('/api/shiftturfs/not-a-uuid')).status, 404);
  assert.equal((await vol.get('/api/shiftturfs/0b6c3d8e-1f2a-4c5b-8d9e-0a1b2c3d4e5f')).status, 404);
  // /api/shifts/:id is the core's shift read and stays it.
  assert.equal((await vol.get(`/api/shifts/${shift.id}`)).json.shift.id, shift.id);

  // The log says who went on which turf, and why.
  const db = await getDb();
  const ev = (await db.query(
    `select payload from events where workspace_id = $1 and action = 'shift.join' and entity_type = 'turf' order by seq`, [ws],
  )).rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  assert.deepEqual(ev, [{ member_added: walkerId, via_shift: shift.id }, { member_added: walkerId, via_shift: shift.id }]);
});

test('shift.assign by the desk walks a member on by login email', async () => {
  const { c: vol2, userId: v2 } = await joinAs('walker.two@example.org', 'Second Example');
  const fleetwood = await mkTurf('Fleetwood loop');
  const shift = await mkShift('Sunday canvass', 4, [fleetwood]);
  const p = await mgr.createPerson('Second Example', { email: 'Walker.Two@Example.org', phone: '604-555-0142' });
  assert.equal((await mgr.action('shift.assign', { shift_id: shift.id, person_id: p.id })).status, 200);
  assert.deepEqual(await turfsOf(vol2), ['Fleetwood loop'], 'matched by login email, any case');

  const before = await membersOn(fleetwood.id);
  const nobody = await mgr.createPerson('Nosign Example', { email: 'nosign@example.org', phone: '604-555-0143' });
  const noMail = await mgr.createPerson('Nomail Example', { phone: '604-555-0144' });
  assert.equal((await mgr.action('shift.assign', { shift_id: shift.id, person_id: nobody.id })).status, 200);
  assert.equal((await mgr.action('shift.assign', { shift_id: shift.id, person_id: noMail.id })).status, 200);
  assert.deepEqual(await membersOn(fleetwood.id), before, 'no sign-in: on the shift, not on the turf');
  const detail = (await mgr.get(`/api/shifts/${shift.id}`)).json;
  assert.equal(detail.assignees.length, 3);
  const noSignIn = (await mgr.get(`/api/shiftturfs/${shift.id}`)).json.no_sign_in.sort();
  assert.deepEqual(noSignIn, detail.assignees.filter((a) => a.id !== p.id).map((a) => a.assignment_id).sort());

  // Joining the campaign later: the walk lists of the shifts they're booked on.
  const { c: late, userId: lateId } = await joinAs('nosign@example.org', 'Nosign Example');
  assert.deepEqual(await turfsOf(late), ['Fleetwood loop']);
  assert.ok((await membersOn(fleetwood.id)).includes(lateId));

  // Leaving the campaign forgets what their shifts held.
  assert.equal((await mgr.action('member.remove', { user_id: v2 })).status, 200);
  const db = await getDb();
  assert.equal((await db.query('select count(*)::int as n from shift_turf_walkers where user_id = $1', [v2])).rows[0].n, 0);
});

test('Can’t make it takes back only what the shift gave', async () => {
  const hand = await mkTurf('Hand turf');
  const only = await mkTurf('Shift-only turf');
  const shift = await mkShift('Weeknight canvass', 5, [hand, only]);
  // September: the desk put Walker on "Hand turf" by hand.
  assert.equal((await mgr.action('turf.assign', { turf_id: hand.id, user_id: walkerId })).status, 200);

  assert.equal((await vol.action('shift.join', { shift_id: shift.id })).status, 200);
  assert.ok((await turfsOf(vol)).includes('Shift-only turf'));
  assert.equal((await vol.action('shift.leave', { shift_id: shift.id })).status, 200);
  let names = await turfsOf(vol);
  assert.ok(names.includes('Hand turf'), 'a hand assignment survives Can’t make it');
  assert.ok(!names.includes('Shift-only turf'), 'what the shift gave goes');

  // Back in (the join's update path), then the desk takes them off the shift:
  // shift.unassign deletes the row and voids it with an empty payload.
  assert.equal((await vol.action('shift.join', { shift_id: shift.id })).status, 200);
  assert.ok((await turfsOf(vol)).includes('Shift-only turf'), 'Count me in again puts it back');
  const a = await assignmentOf(shift.id, walkerPersonId);
  assert.equal((await mgr.action('shift.unassign', { id: a.assignment_id })).status, 200);
  const db = await getDb();
  const voided = (await db.query(
    `select payload from events where workspace_id = $1 and entity_type = 'shift_assignment' and entity_id = $2 and op = 'void'`,
    [ws, a.assignment_id],
  )).rows[0];
  assert.deepEqual(typeof voided.payload === 'string' ? JSON.parse(voided.payload) : voided.payload, {});
  names = await turfsOf(vol);
  assert.ok(names.includes('Hand turf'));
  assert.ok(!names.includes('Shift-only turf'), 'shift.unassign takes back what the shift gave');

  // Two upcoming shifts on the same turf: leaving one keeps it, in either order.
  const z = await mkTurf('Shared turf');
  const first = await mkShift('First on shared', 6, [z]);
  const second = await mkShift('Second on shared', 7, [z]);
  for (const [a1, a2] of [[first, second], [second, first]]) {
    assert.equal((await vol.action('shift.join', { shift_id: a1.id })).status, 200);
    assert.equal((await vol.action('shift.join', { shift_id: a2.id })).status, 200);
    assert.equal((await vol.action('shift.leave', { shift_id: a1.id })).status, 200);
    assert.ok((await turfsOf(vol)).includes('Shared turf'), 'another upcoming shift on the turf keeps them on');
    assert.equal((await vol.action('shift.leave', { shift_id: a2.id })).status, 200);
    assert.ok(!(await turfsOf(vol)).includes('Shared turf'), 'the last shift holding it gives it back');
  }

  // On by a shift, then the desk assigns the same turf by hand: it is the
  // desk's now, and leaving the shift leaves it.
  const y = await mkTurf('Then by hand');
  const s7 = await mkShift('Shift then hand', 8, [y]);
  assert.equal((await vol.action('shift.join', { shift_id: s7.id })).status, 200);
  assert.equal((await mgr.action('turf.assign', { turf_id: y.id, user_id: walkerId })).status, 200);
  assert.equal((await vol.action('shift.leave', { shift_id: s7.id })).status, 200);
  assert.ok((await turfsOf(vol)).includes('Then by hand'));
  // …and taken off by hand, no shift puts it back behind the desk's back.
  assert.equal((await mgr.action('turf.unassign', { turf_id: y.id, user_id: walkerId })).status, 200);
  assert.equal((await db.query('select count(*)::int as n from shift_turf_walkers where turf_id = $1', [y.id])).rows[0].n, 0);
});

test('shift.setStatus declined/no_show removes, confirmed adds back; a turf off the shift takes its walkers off', async () => {
  const w = await mkTurf('Status turf');
  const shift = await mkShift('Status shift', 9, [w]);
  assert.equal((await mgr.action('shift.assign', { shift_id: shift.id, person_id: walkerPersonId })).status, 200);
  const has = async () => (await turfsOf(vol)).includes('Status turf');
  assert.equal(await has(), true, 'assigned by the desk');
  const { assignment_id: id } = await assignmentOf(shift.id, walkerPersonId);
  const steps = [['declined', false], ['confirmed', true], ['no_show', false], ['assigned', true], ['completed', true]];
  for (const [status, on] of steps) {
    assert.equal((await mgr.action('shift.setStatus', { id, status })).status, 200);
    assert.equal(await has(), on, `${status} → ${on ? 'on' : 'off'}`);
  }

  // Turfs added to a shift people are on: they get them; taken off: they go.
  const a = await mkTurf('Turf A');
  const b = await mkTurf('Turf B');
  const s9 = await mkShift('Changing turfs', 10, [a, b]);
  assert.equal((await vol.action('shift.join', { shift_id: s9.id })).status, 200);
  assert.ok((await turfsOf(vol)).includes('Turf A'));
  let set = await mgr.action('shift.turfs.set', { shift_id: s9.id, turf_ids: [b.id] });
  assert.deepEqual(set.json.turf_ids, [b.id]);
  let names = await turfsOf(vol);
  assert.ok(!names.includes('Turf A') && names.includes('Turf B'), 'removing a turf from the shift removes its walkers');
  set = await mgr.action('shift.turfs.set', { shift_id: s9.id, turf_ids: [a.id, b.id, a.id] });
  assert.deepEqual(set.json.turf_ids, [a.id, b.id], 'duplicates once, in turf order');
  assert.ok((await turfsOf(vol)).includes('Turf A'), 'a turf added later reaches who is on the shift');
  assert.equal((await mgr.action('shift.turfs.set', { shift_id: s9.id, turf_ids: [] })).status, 200);
  names = await turfsOf(vol);
  assert.ok(!names.includes('Turf A') && !names.includes('Turf B'));

  // Who may, and what's refused.
  assert.equal((await vol.action('shift.turfs.set', { shift_id: s9.id, turf_ids: [a.id] })).status, 403);
  assert.equal((await mgr.action('shift.turfs.set', { shift_id: '0b6c3d8e-1f2a-4c5b-8d9e-0a1b2c3d4e5f', turf_ids: [] })).status, 404);
  assert.equal((await mgr.action('shift.turfs.set', { shift_id: s9.id, turf_ids: ['0b6c3d8e-1f2a-4c5b-8d9e-0a1b2c3d4e5f'] })).status, 400);
  const other = new Client();
  await other.signup({ workspaceName: 'Elsewhere' });
  const theirs = (await other.action('turf.create', { name: 'Theirs', polygon: square() })).json.turf;
  assert.equal((await mgr.action('shift.turfs.set', { shift_id: s9.id, turf_ids: [theirs.id] })).status, 400, 'another campaign’s turf');
  assert.equal((await other.get(`/api/shiftturfs/${s9.id}`)).status, 404, 'another campaign’s shift');

  // turf.delete: the turf leaves every shift.
  const d = await mkTurf('Deleted turf');
  const s10 = await mkShift('Loses a turf', 11, [d]);
  assert.equal((await vol.action('shift.join', { shift_id: s10.id })).status, 200);
  assert.equal((await mgr.action('turf.delete', { id: d.id })).status, 200);
  const db = await getDb();
  assert.equal((await db.query('select count(*)::int as n from shift_turfs where turf_id = $1', [d.id])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from shift_turf_walkers where turf_id = $1', [d.id])).rows[0].n, 0);
  assert.equal((await mgr.get('/api/shiftturfs')).json.shifts[s10.id], undefined);

  // The export carries both tables; the chain verifies.
  const exp = (await mgr.get('/api/export')).json;
  assert.ok(Array.isArray(exp.shift_turfs) && exp.shift_turfs.length > 0);
  assert.ok(Array.isArray(exp.shift_turf_walkers) && exp.shift_turf_walkers.length > 0);
  assert.ok(exp.shift_turfs.every((r) => r.workspace_id === ws));
  assert.equal((await vol.get('/api/export')).status, 403);
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});

test('a shift that is over gives no walk lists', async () => {
  const t = await mkTurf('Past turf');
  const r = await mgr.action('shift.create', { title: 'Last week', starts_at: inDays(-7), ends_at: inDays(-6.9) });
  assert.equal((await mgr.action('shift.turfs.set', { shift_id: r.json.shift.id, turf_ids: [t.id] })).status, 200);
  assert.equal((await mgr.action('shift.assign', { shift_id: r.json.shift.id, person_id: walkerPersonId })).status, 200);
  assert.ok(!(await turfsOf(vol)).includes('Past turf'));
});

test('the sample loads with the hook on, a sample shift takes a turf, and the sample clears', async () => {
  const fresh = new Client();
  await fresh.signup({ workspaceName: 'Sample WS', jurisdiction: 'bc-municipal' });
  const load = await fresh.post('/api/data/sample', {});
  assert.equal(load.status, 200, JSON.stringify(load.json));
  const shift = (await fresh.get('/api/shifts')).json.shifts[0];
  const turf = (await fresh.get('/api/turfs')).json.turfs[0];
  assert.ok(shift && turf);
  assert.equal((await fresh.action('shift.turfs.set', { shift_id: shift.id, turf_ids: [turf.id] })).status, 200);
  assert.equal((await fresh.req('DELETE', '/api/data/sample')).status, 200);
  assert.equal((await fresh.get('/api/audit/verify')).json.ok, true);
});

test('a turf the desk took off by hand stays off when the booking is confirmed', async () => {
  const t = await mkTurf('Hand-off turf');
  const shift = await mkShift('Confirm shift', 12, [t]);
  assert.equal((await mgr.action('shift.assign', { shift_id: shift.id, person_id: walkerPersonId })).status, 200);
  assert.ok((await membersOn(t.id)).includes(walkerId), 'the shift put them on');
  assert.equal((await mgr.action('turf.unassign', { turf_id: t.id, user_id: walkerId })).status, 200);
  assert.ok(!(await membersOn(t.id)).includes(walkerId), 'taken off by hand');
  const { assignment_id: id } = await assignmentOf(shift.id, walkerPersonId);
  for (const status of ['confirmed', 'assigned', 'completed']) {
    assert.equal((await mgr.action('shift.setStatus', { id, status })).status, 200);
    assert.ok(!(await membersOn(t.id)).includes(walkerId), `${status}: still off`);
  }
  // A real return (declined, then booked again) is a fresh booking: back on.
  assert.equal((await mgr.action('shift.setStatus', { id, status: 'declined' })).status, 200);
  assert.equal((await mgr.action('shift.setStatus', { id, status: 'confirmed' })).status, 200);
  assert.ok((await membersOn(t.id)).includes(walkerId), 'declined → confirmed puts them back');
});
