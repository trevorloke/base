// More room in a shift's hours (ext/schedule): a length in minutes — the
// only way past midnight, as elapsed time — a "Drop in any time" mark, and a
// booking's own hours inside its shift ("only part of it": shift.hours for
// the volunteer's own booking, shift.setHours for the desk). The hours are
// the plan, cleared when a booking comes back, fitted when the shift's times
// change, read back where the person and the desk look, and said in every
// notice. This file runs as a laptop set to Toronto; the campaign is on the
// B.C. clock (UTC-7 all year) unless a test says otherwise.
process.env.TZ = 'America/Toronto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { verifyChain } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { _setClockForTest } from '../ext/texting/rules.js';
import { noticeWords } from '../ext/schedule/tell.js';
import { shiftMessage } from '../lib/notify.js';
import { hoursOf } from '@starbase/shared/shifthours';

const tag = Math.random().toString(36).slice(2, 8);
const TZ = 'America/Vancouver';
const ENV = ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_API_BASE'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const emails = [];
const texts = [];

let db, mgr, ws, vik, vikPerson, una, staff, staffId, granted, grantedId, denied, deniedId;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const no = (r, status, msg) => { assert.equal(r.status, status, JSON.stringify(r.json)); if (msg) assert.equal(r.json.error, msg); };
const iso = (v) => (v ? new Date(v).toISOString() : null);
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const shiftRow = async (id) => (await rows('select * from shifts where id = $1', [id]))[0];
const hoursAt = async (id) => {
  const a = (await rows('select arrive_at, leave_at from shift_assignments where id = $1', [id]))[0];
  return [iso(a.arrive_at), iso(a.leave_at)];
};
const eventsOf = (action, type = 'shift_assignment') => rows(
  'select entity_id, op, payload from events where workspace_id = $1 and action = $2 and entity_type = $3 order by seq', [ws, action, type]);
const join = async (role, name) => {
  const email = `hrs-${name}+${tag}@example.org`.toLowerCase();
  const inv = ok(await mgr.action('member.invite', { email, role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'hours-pass-2026' }));
  return { client: c, id: j.user.id, email };
};
// One shift a call, made by tap: a day, a start and an end or a length.
let n = 0;
const make = async (when, extra = {}) => ok(await mgr.action('shift.createMany', {
  kind: 'canvass', location: `Hours place ${(n += 1)}`, days: [when.day], start: when.start,
  ...(when.end ? { end: when.end } : {}), ...(when.minutes ? { minutes: when.minutes } : {}), ...extra,
})).shifts[0];
// A 2–8 pm canvass on Saturday, November 16, 2030 (B.C.: UTC-7).
const SAT = '2030-11-16';
const at = (clock, day = SAT) => new Date(`${day}T${clock}:00-07:00`).toISOString();
const canvass = () => make({ day: SAT, start: '14:00', end: '20:00' });

before(async () => {
  db = await freshDb();
  for (const k of ENV) delete process.env[k];
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Hours ${tag}`, email: `hrs-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  ({ client: vik } = await join('volunteer', 'Vik'));
  ({ client: una } = await join('volunteer', 'Una'));
  ({ client: staff, id: staffId } = await join('staff', 'Sam'));
  ({ client: granted, id: grantedId } = await join('volunteer', 'Gia'));
  ({ client: denied, id: deniedId } = await join('staff', 'Dan'));
  ok(await mgr.action('permission.member.set', { user_id: grantedId, grant: ['shifts'], deny: [] }));
  ok(await mgr.action('permission.member.set', { user_id: deniedId, grant: [], deny: ['shifts'] }));
});
after(() => {
  globalThis.fetch = realFetch;
  _setClockForTest(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// ── 1. Lengths by minutes ──

test('20:00 for 300 minutes ends at 1:00 the next day, on the B.C. clock in a Toronto process', async () => {
  const s = await make({ day: '2030-05-06', start: '20:00', minutes: 300 });
  const row = await shiftRow(s.id);
  assert.deepEqual([iso(row.starts_at), iso(row.ends_at)], ['2030-05-07T03:00:00.000Z', '2030-05-07T08:00:00.000Z']);
  // Slots take a length too, beside a slot said by its end.
  const two = ok(await mgr.action('shift.createMany', {
    kind: 'event', location: 'Election night hall', days: ['2030-10-19'],
    slots: [{ start: '20:00', minutes: 300 }, { start: '09:00', end: '12:00' }],
  })).shifts;
  assert.deepEqual(two.map((x) => [iso(x.starts_at), iso(x.ends_at)]), [
    ['2030-10-19T16:00:00.000Z', '2030-10-19T19:00:00.000Z'],
    ['2030-10-20T03:00:00.000Z', '2030-10-20T08:00:00.000Z'],
  ]);
});

test('an end before the start is still refused; a length is 15 minutes to a day; never both', async () => {
  no(await mgr.action('shift.createMany', { kind: 'event', location: 'Typo hall', days: ['2030-05-06'], start: '20:00', end: '01:00' }),
    400, 'the end has to be after the start');
  for (const minutes of [14, 1441, 90.5]) {
    no(await mgr.action('shift.createMany', { kind: 'event', location: 'Bounds hall', days: ['2030-05-06'], start: '10:00', minutes }), 400);
  }
  const short = await make({ day: '2030-05-06', start: '10:00', minutes: 15 });
  const day = await make({ day: '2030-05-06', start: '11:00', minutes: 1440 });
  assert.equal(Date.parse(short.ends_at) - Date.parse(short.starts_at), 15 * 60e3);
  assert.equal(Date.parse(day.ends_at) - Date.parse(day.starts_at), 1440 * 60e3);
  no(await mgr.action('shift.createMany', { kind: 'event', location: 'Both hall', days: ['2030-05-06'], start: '10:00', end: '12:00', minutes: 60 }),
    400, 'say how long, or when it ends — not both');
  no(await mgr.action('shift.createMany', { kind: 'event', location: 'Both hall', days: ['2030-05-06'], slots: [{ start: '10:00', end: '12:00', minutes: 60 }] }),
    400, 'say how long, or when it ends — not both');
  no(await mgr.action('shift.createMany', { kind: 'event', location: 'Half hall', days: ['2030-05-06'], slots: [{ start: '10:00' }] }), 400);

  // shift.update: minutes in place of end — any end key beside it, even null, is refused.
  const s = await make({ day: '2030-05-08', start: '18:00', end: '20:00' });
  no(await mgr.action('shift.update', { id: s.id, minutes: 60, end: null }), 400, 'say how long, or when it ends — not both');
  no(await mgr.action('shift.update', { id: s.id, minutes: 60, end: '19:00' }), 400, 'say how long, or when it ends — not both');
  no(await mgr.action('shift.update', { id: s.id, minutes: 14 }), 400);
  no(await mgr.action('shift.update', { id: s.id, minutes: 60, starts_at: '2030-05-08T10:00:00-07:00' }), 400);
  ok(await mgr.action('shift.update', { id: s.id, start: '22:00', minutes: 180 }));
  const row = await shiftRow(s.id);
  assert.deepEqual([iso(row.starts_at), iso(row.ends_at)], ['2030-05-09T05:00:00.000Z', '2030-05-09T08:00:00.000Z'], '10 pm to 1 am');
  no(await mgr.action('shift.update', { id: s.id, end: '01:00' }), 400, 'the end has to be after the start');
});

test('a Toronto shift from 10 pm on the night the clocks go back runs 300 elapsed minutes (2:00, not 3:00)', async () => {
  const savedTz = process.env.STARBASE_TZ;
  process.env.STARBASE_TZ = 'America/Toronto';
  const east = new Client();
  let eastWs;
  try { eastWs = (await east.signup({ workspaceName: `East ${tag}`, email: `hrs-east+${tag}@example.org` })).json.workspace.id; } finally {
    if (savedTz === undefined) delete process.env.STARBASE_TZ; else process.env.STARBASE_TZ = savedTz;
  }
  // Sunday, November 3, 2030: 2:00 EDT becomes 1:00 EST.
  const s = ok(await east.action('shift.createMany', { kind: 'event', location: 'Queen St', days: ['2030-11-02'], start: '22:00', minutes: 300 })).shifts[0];
  const row = (await rows('select starts_at, ends_at from shifts where id = $1 and workspace_id = $2', [s.id, eastWs]))[0];
  assert.deepEqual([iso(row.starts_at), iso(row.ends_at)], ['2030-11-03T02:00:00.000Z', '2030-11-03T07:00:00.000Z']);
  assert.equal(new Date(row.ends_at).toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit' }), '2:00 a.m.');
});

test('a repeating slot takes a length and the drop-in mark through “this and the following”', async () => {
  const r = ok(await mgr.action('shift.createMany', {
    kind: 'phone_bank', location: 'Series office', start: '16:00', end: '18:00', days: ['2030-06-04'], repeat: { weeks: 3 },
  }));
  const u = ok(await mgr.action('shift.series.update', { id: r.shifts[0].id, patch: { minutes: 240, drop_in: true } }));
  assert.equal(u.changed.length, 3);
  for (const s of r.shifts) {
    const row = await shiftRow(s.id);
    assert.equal(Date.parse(row.ends_at) - Date.parse(row.starts_at), 240 * 60e3);
    assert.equal(row.drop_in, true);
  }
  no(await mgr.action('shift.series.update', { id: r.shifts[0].id, patch: { minutes: 60, end: null } }), 400);
});

test('moved to another day or copied a week on, a shift past midnight still runs past midnight', async () => {
  const s = await make({ day: '2030-07-01', start: '20:00', minutes: 300 }, { drop_in: true });
  ok(await mgr.action('shift.update', { id: s.id, day: '2030-07-02' }));
  let row = await shiftRow(s.id);
  assert.deepEqual([iso(row.starts_at), iso(row.ends_at)], ['2030-07-03T03:00:00.000Z', '2030-07-03T08:00:00.000Z']);
  const copy = ok(await mgr.action('shift.copyWeek', { from: '2030-07-01', to: '2030-07-08' }));
  const moved = copy.shifts.find((x) => iso(x.starts_at) === '2030-07-10T03:00:00.000Z');
  assert.ok(moved, JSON.stringify(copy.shifts));
  row = await shiftRow(moved.id);
  assert.equal(iso(row.ends_at), '2030-07-10T08:00:00.000Z');
  assert.equal(row.drop_in, true, 'copied as drop-in');
});

// ── 3. Drop in any time ──

test('drop-in is saved by each way of making a shift, and changed by shift.update', async () => {
  const many = await make({ day: '2030-08-05', start: '16:00', end: '20:00' }, { drop_in: true });
  assert.equal((await shiftRow(many.id)).drop_in, true);
  const ev = (await rows(`select payload from events where workspace_id = $1 and entity_type = 'shift' and entity_id = $2 and op = 'create'`, [ws, many.id]))[0];
  assert.equal(ev.payload.drop_in, true);
  const plain = await make({ day: '2030-08-05', start: '10:00', end: '12:00' });
  const plainEv = (await rows(`select payload from events where workspace_id = $1 and entity_type = 'shift' and entity_id = $2 and op = 'create'`, [ws, plain.id]))[0];
  assert.equal('drop_in' in plainEv.payload, false, 'in the payload only when true');
  const one = ok(await mgr.action('shift.create', { title: 'Office hours', starts_at: '2030-08-06T16:00:00-07:00', ends_at: '2030-08-06T20:00:00-07:00', drop_in: true })).shift;
  assert.equal((await shiftRow(one.id)).drop_in, true);
  ok(await mgr.action('shift.update', { id: one.id, drop_in: false }));
  assert.equal((await shiftRow(one.id)).drop_in, false);
  ok(await mgr.action('shift.update', { id: one.id, title: 'Office hours, 2' }));
  assert.equal((await shiftRow(one.id)).drop_in, false, 'kept when not sent');
});

// ── 5. A booking's own hours ──

test('shift.hours: the volunteer’s own booking, inside the shift, half an hour at least', async () => {
  const s = await canvass();
  const joined = ok(await vik.action('shift.join', { shift_id: s.id })).assignment;
  vikPerson = joined.person_id;
  const r = ok(await vik.action('shift.hours', { shift_id: s.id, from: at('16:30'), to: at('18:00') }));
  assert.deepEqual([r.assignment.arrive_at, r.assignment.leave_at], [at('16:30'), at('18:00')]);
  assert.deepEqual(await hoursAt(joined.id), [at('16:30'), at('18:00')]);
  const ev = (await eventsOf('shift.hours')).at(-1);
  assert.deepEqual([ev.entity_id, ev.op, ev.payload], [joined.id, 'update', { arrive_at: at('16:30'), leave_at: at('18:00'), self: true }]);
  assert.equal('status' in ev.payload, false);

  const INSIDE = 'pick a time inside the shift, at least half an hour';
  no(await vik.action('shift.hours', { shift_id: s.id, from: at('13:30'), to: at('15:00') }), 400, INSIDE);
  no(await vik.action('shift.hours', { shift_id: s.id, from: at('19:00'), to: at('20:30') }), 400, INSIDE);
  no(await vik.action('shift.hours', { shift_id: s.id, from: at('16:00'), to: at('16:29') }), 400, INSIDE);
  no(await vik.action('shift.hours', { shift_id: s.id, from: at('17:00'), to: at('16:00') }), 400, INSIDE);
  no(await vik.action('shift.hours', { shift_id: s.id, from: at('17:00'), to: null }), 400, INSIDE);
  no(await vik.action('shift.hours', { shift_id: s.id, from: '2030-11-16T16:30', to: '2030-11-16T18:00' }), 400); // no offset: never read on the server’s clock
  // Exactly the whole shift is stored as the whole shift; so is null/null.
  ok(await vik.action('shift.hours', { shift_id: s.id, from: at('14:00'), to: at('20:00') }));
  assert.deepEqual(await hoursAt(joined.id), [null, null]);
  ok(await vik.action('shift.hours', { shift_id: s.id, from: at('16:00'), to: at('16:30') }), 'half an hour exactly');
  ok(await vik.action('shift.hours', { shift_id: s.id, from: null, to: null }));
  assert.deepEqual(await hoursAt(joined.id), [null, null]);

  // Not on it: the one 409 (the outbox drops exactly these). Una isn't booked.
  no(await una.action('shift.hours', { shift_id: s.id, from: at('16:30'), to: at('18:00') }), 409, 'you’re not on this shift');
  no(await una.action('shift.hours', { shift_id: '00000000-0000-4000-8000-000000000000', from: null, to: null }), 409);
  ok(await vik.action('shift.leave', { shift_id: s.id }));
  no(await vik.action('shift.hours', { shift_id: s.id, from: at('16:30'), to: at('18:00') }), 409, 'you’re not on this shift'); // Can’t make it is not on it

  // A shift with no end is the whole thing.
  const open = ok(await mgr.action('shift.create', { title: 'Open house', starts_at: at('12:00', '2030-11-17') })).shift;
  ok(await vik.action('shift.join', { shift_id: open.id }));
  no(await vik.action('shift.hours', { shift_id: open.id, from: at('12:00', '2030-11-17'), to: at('13:00', '2030-11-17') }),
    400, 'this shift has no end time — it’s the whole thing');

  // Over: a 400, not the 409 the outbox would drop.
  const past = ok(await mgr.action('shift.create', { title: 'Last spring', starts_at: '2020-05-02T21:00:00Z', ends_at: '2020-05-03T03:00:00Z' })).shift;
  ok(await mgr.action('shift.assign', { shift_id: past.id, person_id: vikPerson }));
  no(await vik.action('shift.hours', { shift_id: past.id, from: '2020-05-02T22:00:00Z', to: '2020-05-02T23:00:00Z' }), 400, 'that shift is over');
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('shift.setHours: the desk and those granted Shifts; never a volunteer or someone denied Shifts', async () => {
  const s = await canvass();
  const p = await mgr.createPerson('Priya Example');
  const a = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: p.id })).assignment;
  const set = (c, from, to) => c.action('shift.setHours', { id: a.id, from: at(from), to: at(to) });
  ok(await set(mgr, '15:00', '17:00'), 'a manager');
  ok(await set(staff, '15:30', '17:00'), 'staff');
  no(await set(vik, '16:00', '17:00'), 403);
  no(await set(denied, '16:00', '17:00'), 403);
  ok(await set(granted, '16:30', '18:00'), 'a volunteer granted Shifts');
  assert.deepEqual(await hoursAt(a.id), [at('16:30'), at('18:00')]);
  const ev = (await eventsOf('shift.setHours')).at(-1);
  assert.deepEqual(ev.payload, { arrive_at: at('16:30'), leave_at: at('18:00') });
  no(await set(mgr, '13:00', '15:00'), 400);
  ok(await mgr.action('shift.setStatus', { id: a.id, status: 'declined' }));
  no(await set(mgr, '16:00', '17:00'), 409, 'they’re not on this shift');

  // After the shift: the plan can still be corrected.
  const past = ok(await mgr.action('shift.create', { title: 'Done canvass', starts_at: '2020-05-02T21:00:00Z', ends_at: '2020-05-03T03:00:00Z' })).shift;
  const b = ok(await mgr.action('shift.assign', { shift_id: past.id, person_id: p.id })).assignment;
  ok(await mgr.action('shift.setStatus', { id: b.id, status: 'completed' }));
  ok(await mgr.action('shift.setHours', { id: b.id, from: '2020-05-02T22:00:00Z', to: '2020-05-03T00:00:00Z' }));
  assert.deepEqual(await hoursAt(b.id), ['2020-05-02T22:00:00.000Z', '2020-05-03T00:00:00.000Z']);
});

test('two people with one email: GET /shifts and shift.hours both take the older one’s booking', async () => {
  const { client: wen, email } = await join('volunteer', 'Wen');
  // The join made the first; the desk adds a second with the same email.
  const s = await canvass();
  const first = (await rows('select id from persons where workspace_id = $1 and lower(email) = $2 order by created_at', [ws, email]));
  const older = first[0]?.id || (await mgr.createPerson('Wen Example', { email })).id;
  const younger = (await mgr.createPerson('Wen Twin Example', { email })).id;
  const a1 = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: older })).assignment;
  const a2 = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: younger })).assignment;
  ok(await mgr.action('shift.setHours', { id: a1.id, from: at('15:00'), to: at('16:00') }));
  ok(await mgr.action('shift.setHours', { id: a2.id, from: at('18:00'), to: at('19:00') }));
  const list = ok(await wen.get('/api/shifts'));
  const row = list.shifts.find((x) => x.id === s.id);
  assert.deepEqual([iso(row.my_arrive_at), iso(row.my_leave_at), row.mine], [at('15:00'), at('16:00'), true]);
  ok(await wen.action('shift.hours', { shift_id: s.id, from: at('16:00'), to: at('17:00') }));
  assert.deepEqual(await hoursAt(a1.id), [at('16:00'), at('17:00')]);
  assert.deepEqual(await hoursAt(a2.id), [at('18:00'), at('19:00')], 'the other booking is left alone');
  // Someone not on it reads nulls; every row carries drop_in.
  const other = ok(await una.get('/api/shifts')).shifts.find((x) => x.id === s.id);
  assert.deepEqual([other.my_arrive_at, other.my_leave_at, other.drop_in], [null, null, null]);
});

// ── 6. Hours reset when a booking comes back ──

test('back on after Can’t make it or a no-show: the whole shift again, and the event says so', async () => {
  const s = await canvass();
  const a = ok(await vik.action('shift.join', { shift_id: s.id })).assignment;
  ok(await vik.action('shift.hours', { shift_id: s.id, from: at('16:30'), to: at('18:00') }));
  ok(await vik.action('shift.leave', { shift_id: s.id }));
  assert.deepEqual(await hoursAt(a.id), [at('16:30'), at('18:00')], 'kept while off: it is what they had said');
  ok(await vik.action('shift.join', { shift_id: s.id }));
  assert.deepEqual(await hoursAt(a.id), [null, null]);
  const ev = (await eventsOf('shift.join')).at(-1);
  assert.deepEqual(ev.payload, { status: 'confirmed', self: true, arrive_at: null, leave_at: null });

  // shift.add (the desk's crew board) reuses the row the same way.
  ok(await vik.action('shift.hours', { shift_id: s.id, from: at('16:30'), to: at('18:00') }));
  ok(await mgr.action('shift.setStatus', { id: a.id, status: 'declined' }));
  ok(await mgr.action('shift.add', { shift_id: s.id, person_id: vikPerson }));
  assert.deepEqual(await hoursAt(a.id), [null, null]);
  const add = (await eventsOf('shift.add')).at(-1);
  assert.deepEqual([add.payload.status, add.payload.arrive_at, add.payload.leave_at], ['assigned', null, null]);

  // shift.setStatus from a no-show back to booked; a move between held statuses keeps them.
  ok(await mgr.action('shift.setHours', { id: a.id, from: at('16:30'), to: at('18:00') }));
  ok(await mgr.action('shift.setStatus', { id: a.id, status: 'confirmed' }));
  assert.deepEqual(await hoursAt(a.id), [at('16:30'), at('18:00')], 'assigned → confirmed is not a comeback');
  ok(await mgr.action('shift.setStatus', { id: a.id, status: 'no_show' }));
  ok(await mgr.action('shift.setStatus', { id: a.id, status: 'assigned' }));
  assert.deepEqual(await hoursAt(a.id), [null, null]);
  const st = (await eventsOf('shift.setStatus')).at(-1);
  assert.deepEqual(st.payload, { status: 'assigned', from: 'no_show', arrive_at: null, leave_at: null });
});

test('an hours change leaves walk lists alone', async () => {
  const lat = 49.1327; const lng = -122.855;
  const turf = ok(await mgr.action('turf.create', {
    name: `Hours turf ${tag}`, color: '#2b6cb0',
    polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  })).turf;
  const s = await canvass();
  ok(await mgr.action('shift.turfs.set', { shift_id: s.id, turf_ids: [turf.id] }));
  ok(await una.action('shift.join', { shift_id: s.id }));
  const members = () => rows('select user_id from turf_members where turf_id = $1 order by user_id', [turf.id]);
  const before = await members();
  assert.equal(before.length, 1, 'the join put her on the turf');
  const seq = (await rows('select max(seq)::int as n from events where workspace_id = $1', [ws]))[0].n;
  ok(await una.action('shift.hours', { shift_id: s.id, from: at('16:30'), to: at('18:00') }));
  ok(await mgr.action('shift.setHours', { id: (await rows('select id from shift_assignments where shift_id = $1', [s.id]))[0].id, from: null, to: null }));
  assert.deepEqual(await members(), before);
  const since = await rows('select entity_type, op from events where workspace_id = $1 and seq > $2 order by seq', [ws, seq]);
  assert.deepEqual(since, [{ entity_type: 'shift_assignment', op: 'update' }, { entity_type: 'shift_assignment', op: 'update' }]);
});

// ── 7. Hours always fit their shift ──

test('fitHours: trimmed narrows, a short overlap / another day / no end clears, longer keeps', async () => {
  const s = await canvass();
  const p = await mgr.createPerson('Fit Example');
  const a = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: p.id })).assignment;
  const own = (from, to) => mgr.action('shift.setHours', { id: a.id, from: at(from), to: at(to) });
  const fitEvents = async () => (await eventsOf('shift.update')).filter((e) => e.entity_id === a.id).map((e) => e.payload);

  ok(await own('16:30', '18:00'));
  ok(await mgr.action('shift.update', { id: s.id, end: '17:00' }));
  assert.deepEqual(await hoursAt(a.id), [at('16:30'), at('17:00')], 'trimmed to 2–5: 4:30–5');
  ok(await mgr.action('shift.update', { id: s.id, end: '20:00' }));
  assert.deepEqual(await hoursAt(a.id), [at('16:30'), at('17:00')], 'lengthened: kept');
  ok(await mgr.action('shift.update', { id: s.id, title: 'Renamed canvass' }));
  ok(await own('16:30', '18:00'));
  ok(await mgr.action('shift.update', { id: s.id, end: '16:45' }));
  assert.deepEqual(await hoursAt(a.id), [null, null], 'trimmed to 2–4:45: a quarter hour left, cleared');
  ok(await mgr.action('shift.update', { id: s.id, end: '20:00' }));
  ok(await own('16:30', '18:00'));
  ok(await mgr.action('shift.update', { id: s.id, start: '16:00', end: '18:00' }));
  assert.deepEqual(await hoursAt(a.id), [at('16:30'), at('18:00')], 'still inside: kept');
  ok(await mgr.action('shift.update', { id: s.id, start: '16:30', end: '18:00' }));
  assert.deepEqual(await hoursAt(a.id), [null, null], 'the overlap is the whole shift: the whole shift');
  ok(await mgr.action('shift.update', { id: s.id, start: '14:00', end: '20:00' }));
  ok(await own('16:30', '18:00'));
  ok(await mgr.action('shift.update', { id: s.id, day: '2030-11-17' }));
  assert.deepEqual(await hoursAt(a.id), [null, null], 'another day: cleared');
  ok(await mgr.action('shift.update', { id: s.id, day: SAT }));
  ok(await own('16:30', '18:00'));
  ok(await mgr.action('shift.update', { id: s.id, end: null }));
  assert.deepEqual(await hoursAt(a.id), [null, null], 'no end: cleared');
  assert.deepEqual(await fitEvents(), [
    { arrive_at: at('16:30'), leave_at: at('17:00') },
    { arrive_at: null, leave_at: null },
    { arrive_at: null, leave_at: null },
    { arrive_at: null, leave_at: null },
    { arrive_at: null, leave_at: null },
  ], 'one event a change, none when kept');
  assert.equal((await verifyChain(db, ws)).ok, true);
});

// ── 8. Reads ──

test('GET /shifts/:id: a volunteer sees others’ names with no hours, and their own; the desk sees all', async () => {
  const s = await canvass();
  ok(await vik.action('shift.join', { shift_id: s.id }));
  ok(await una.action('shift.join', { shift_id: s.id }));
  ok(await vik.action('shift.hours', { shift_id: s.id, from: at('16:30'), to: at('18:00') }));
  ok(await una.action('shift.hours', { shift_id: s.id, from: at('14:00'), to: at('15:00') }));
  const asUna = ok(await una.get(`/api/shifts/${s.id}`)).assignees;
  const v = asUna.find((x) => x.name === 'Vik Example');
  const u = asUna.find((x) => x.name === 'Una Example');
  assert.deepEqual([v.arrive_at, v.leave_at, v.email], [null, null, null]);
  assert.deepEqual([iso(u.arrive_at), iso(u.leave_at)], [at('14:00'), at('15:00')]);
  const desk = ok(await mgr.get(`/api/shifts/${s.id}`)).assignees;
  assert.deepEqual(desk.map((x) => [x.name, iso(x.arrive_at), iso(x.leave_at)]).sort(), [
    ['Una Example', at('14:00'), at('15:00')], ['Vik Example', at('16:30'), at('18:00')],
  ]);
  // The crew board (desk): each booking's hours, on it and off it.
  ok(await vik.action('shift.leave', { shift_id: s.id }));
  const crew = ok(await mgr.get(`/api/crew/${s.id}`));
  assert.deepEqual(crew.crew.map((x) => [x.name, x.arrive_at, x.leave_at]), [['Una Example', at('14:00'), at('15:00')]]);
  assert.deepEqual(crew.out.map((x) => [x.name, x.arrive_at, x.leave_at]), [['Vik Example', at('16:30'), at('18:00')]]);
});

// ── 9. Notices in each person's own hours ──

test('hoursOf: a booking’s own hours, else the shift’s — across midnight too', () => {
  const shift = { starts_at: '2030-11-17T03:00:00.000Z', ends_at: '2030-11-17T08:00:00.000Z' };
  assert.deepEqual(hoursOf(shift, null), { starts_at: shift.starts_at, ends_at: shift.ends_at, part: false });
  assert.deepEqual(hoursOf(shift, { arrive_at: null, leave_at: null }), { starts_at: shift.starts_at, ends_at: shift.ends_at, part: false });
  assert.deepEqual(hoursOf(shift, { arrive_at: '2030-11-17T06:00:00.000Z', leave_at: new Date('2030-11-17T08:00:00.000Z') }),
    { starts_at: '2030-11-17T06:00:00.000Z', ends_at: '2030-11-17T08:00:00.000Z', part: true }, '11 pm to 1 am of an 8 pm–1 am shift');
  assert.deepEqual(hoursOf({ ...shift, my_arrive_at: '2030-11-17T04:00:00.000Z', my_leave_at: '2030-11-17T05:00:00.000Z' },
    { my_arrive_at: '2030-11-17T04:00:00.000Z', my_leave_at: '2030-11-17T05:00:00.000Z' }).part, true, 'a GET /shifts row');
  assert.equal(hoursOf({ starts_at: shift.starts_at, ends_at: null }, undefined).ends_at, null);
});

const PARTIAL = {
  title: 'Canvass — Fleetwood', starts_at: at('14:00'), ends_at: at('20:00'), location: 'Fleetwood',
  arrive_at: at('16:30'), leave_at: at('18:00'),
};
const DROP = { title: 'Phone bank — Campaign office', starts_at: at('16:00'), ends_at: at('20:00'), location: 'Campaign office', drop_in: true };

test('the words: a week’s notice and a reminder, email and text, for part of a shift and a drop-in shift', () => {
  for (const kind of ['week', 'reminder']) {
    const w = noticeWords({ kind, shifts: [PARTIAL, DROP], workspaceName: 'Imagine Example', tz: TZ, thisWeek: true });
    assert.ok(w.email.includes('\nSaturday, November 16 at 4:30 p.m. – 6:00 p.m. (your time; the shift runs 2:00 p.m. – 8:00 p.m.)\n'), w.email);
    assert.ok(w.email.includes('\nDrop in any time, Saturday, November 16, 4:00 p.m. – 8:00 p.m.\n'), w.email);
    assert.ok(w.text.includes('\nSat, Nov 16, 4:30 p.m.: Canvass — Fleetwood\n'), w.text);
    assert.ok(w.text.includes('\nSat, Nov 16, drop in 4–8 p.m.: Phone bank — Campaign office\n'), w.text);
    assert.equal(w.text.includes('your time'), false, 'no brackets in a text');
  }
  // shift.notify's message to one person.
  assert.match(shiftMessage(PARTIAL, 'X', TZ, PARTIAL), /\nSaturday, November 16 at 4:30 p\.m\. – 6:00 p\.m\. \(your time; the shift runs 2:00 p\.m\. – 8:00 p\.m\.\)\n/);
  assert.match(shiftMessage(PARTIAL, 'X', TZ, PARTIAL, { forText: true }), /\nSaturday, November 16 at 4:30 p\.m\. – 6:00 p\.m\.\n/);
  assert.match(shiftMessage(DROP, 'X', TZ, null), /\nDrop in any time, Saturday, November 16, 4:00 p\.m\. – 8:00 p\.m\.\n/);
  assert.match(shiftMessage(PARTIAL, 'X', TZ, null), /\nSaturday, November 16 at 2:00 p\.m\. – 8:00 p\.m\.\n/, 'the whole shift as before');
});

test('sent: shift.notify and a week’s notice each say every person’s own hours', async () => {
  Object.assign(process.env, { RESEND_API_KEY: 'test-key', TWILIO_ACCOUNT_SID: `AC${tag}`, TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+16045550100' });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) { emails.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    if (u.startsWith('https://api.twilio.com/')) { texts.push(Object.fromEntries(new URLSearchParams(String(init.body)))); return new Response('{}', { status: 201 }); }
    return realFetch(url, init);
  };
  _setClockForTest(() => new Date('2030-11-14T19:00:00Z')); // a Thursday noon in Surrey
  const s = await make({ day: SAT, start: '14:00', end: '20:00' });
  const ann = await mgr.createPerson('Ann Example', { email: `ann.${tag}@example.org`, phone: '604-555-0161' });
  const bo = await mgr.createPerson('Bo Example', { email: `bo.${tag}@example.org`, phone: '604-555-0162' });
  const a = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: ann.id })).assignment;
  ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: bo.id }));
  ok(await mgr.action('shift.setHours', { id: a.id, from: at('16:30'), to: at('18:00') }));

  ok(await mgr.action('shift.notify', { shift_id: s.id }));
  const mail = (to) => emails.filter((e) => [].concat(e.to).includes(to)).at(-1);
  const text = (to) => texts.filter((t) => t.To === to).at(-1);
  assert.match(mail(`ann.${tag}@example.org`).text, /4:30 p\.m\. – 6:00 p\.m\. \(your time; the shift runs 2:00 p\.m\. – 8:00 p\.m\.\)/);
  assert.match(mail(`bo.${tag}@example.org`).text, /at 2:00 p\.m\. – 8:00 p\.m\.\n/);
  assert.match(text('+16045550161').Body, /4:30 p\.m\. – 6:00 p\.m\.\n/);
  assert.equal(text('+16045550161').Body.includes('your time'), false);

  ok(await mgr.action('shift.tellWeek', { week: SAT }));
  for (let i = 0; i < 6; i += 1) if (!(await runDueJobs(db, { workspaceId: ws })).ran) break;
  assert.match(mail(`ann.${tag}@example.org`).text, /Saturday, November 16 at 4:30 p\.m\. – 6:00 p\.m\. \(your time; the shift runs 2:00 p\.m\. – 8:00 p\.m\.\)/);
  assert.match(text('+16045550161').Body, /Sat, Nov 16, 4:30 p\.m\.: /);
  assert.match(text('+16045550162').Body, /Sat, Nov 16, 2:00 p\.m\.: /);
  globalThis.fetch = realFetch;
  _setClockForTest(null);
  for (const k of ENV) delete process.env[k];
});
