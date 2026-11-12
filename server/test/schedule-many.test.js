// Many shifts in one write (ext/schedule): shift.createMany makes every
// chosen day — and each again every week — in one transaction, with an
// ordinary shift/create event per shift; shift.copyWeek copies a week (the
// same local times, turfs, target, limit) and, when asked, its people as
// plain bookings; a repeating slot is changed or ended from one of its
// shifts (shift.series.update / shift.series.cancel).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { verifyChain } from '../lib/events.js';

const tag = Math.random().toString(36).slice(2, 8);
let db, mgr, ws, vol, volId, staff, staffId;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const iso = (v) => new Date(v).toISOString();
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const shiftsOf = (title) => rows('select * from shifts where workspace_id = $1 and title = $2 and deleted_at is null order by starts_at', [ws, title]);
const eventsOf = (action, type) => rows(
  `select entity_id, op, payload, server_ts, actor_id from events where workspace_id = $1 and action = $2 and entity_type = $3 order by seq`, [ws, action, type]);
const join = async (role, name) => {
  const inv = ok(await mgr.action('member.invite', { email: `many-${name}+${tag}@example.org`.toLowerCase(), role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'many-pass-2026' }));
  return { client: c, id: j.user.id };
};
// Monday May 6, 2030 and the weeks after: always ahead, and B.C. is on UTC-7.
const MON = '2030-05-06';
const BS = { kind: 'burma_shave', location: 'King George Blvd & 88 Ave', start: '06:30', end: '08:30' };

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Many ${tag}`, email: `many-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  ({ client: vol, id: volId } = await join('volunteer', 'Vik'));
  ({ client: staff, id: staffId } = await join('staff', 'Sam'));
});

test('five weekdays in one write: five ordinary shifts, named and timed by the server', async () => {
  const days = ['2030-05-06', '2030-05-07', '2030-05-08', '2030-05-09', '2030-05-10'];
  const r = ok(await mgr.action('shift.createMany', { ...BS, days, need: 4 }));
  assert.equal(r.shifts.length, 5);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.series_id, null, 'just this week: not a repeating slot');
  const made = await shiftsOf('Burma Shave — King George Blvd & 88 Ave');
  assert.deepEqual(made.map((s) => [iso(s.starts_at), iso(s.ends_at)]), days.map((d) => [`${d}T13:30:00.000Z`, `${d}T15:30:00.000Z`]),
    '6:30–8:30 on the campaign’s clock, each day');
  for (const s of made) {
    assert.deepEqual([s.kind, s.role, s.location, s.need, s.capacity, s.title_custom, s.series_id, s.public, s.place_id],
      ['burma_shave', 'burmashave', 'King George Blvd & 88 Ave', 4, null, false, null, false, null]);
  }
  // One shift/create per shift, as shift.create writes them — and all in one transaction.
  const events = await eventsOf('shift.createMany', 'shift');
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => e.op), Array(5).fill('create'));
  assert.deepEqual(events.map((e) => e.entity_id).sort(), made.map((s) => s.id).sort());
  assert.equal(new Set(events.map((e) => iso(e.server_ts))).size, 1, 'one transaction');
  const p = events[0].payload;
  assert.deepEqual(p, {
    id: events[0].entity_id, title: 'Burma Shave — King George Blvd & 88 Ave', kind: 'burma_shave', role: 'burmashave',
    location: 'King George Blvd & 88 Ave', starts_at: '2030-05-06T06:30:00-07:00', ends_at: '2030-05-06T08:30:00-07:00', need: 4,
  });
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('a day that already has that kind at that place and time is skipped and said so', async () => {
  const r = ok(await mgr.action('shift.createMany', { ...BS, days: ['2030-05-10', '2030-05-11', '2030-05-06'] }));
  assert.deepEqual(r.shifts.map((s) => s.day), ['2030-05-11'], 'only Saturday is new');
  assert.deepEqual(r.skipped, [{ day: '2030-05-06', start: '06:30' }, { day: '2030-05-10', start: '06:30' }]);
  assert.equal((await shiftsOf('Burma Shave — King George Blvd & 88 Ave')).length, 6);
  // Another place, another time or another kind is a different shift.
  assert.equal(ok(await mgr.action('shift.createMany', { ...BS, location: '152 St & 64 Ave', days: [MON] })).shifts.length, 1);
  assert.equal(ok(await mgr.action('shift.createMany', { ...BS, start: '16:00', end: '18:00', days: [MON] })).shifts.length, 1);
  assert.equal(ok(await mgr.action('shift.createMany', { ...BS, kind: 'mainstreet', days: [MON] })).shifts.length, 1);
  // The same words in another case are the same place; a called-off shift is not in the way.
  assert.equal(ok(await mgr.action('shift.createMany', { ...BS, location: 'king george blvd & 88 ave', days: [MON] })).shifts.length, 0);
  const sat = (await shiftsOf('Burma Shave — King George Blvd & 88 Ave')).find((s) => iso(s.starts_at).startsWith('2030-05-11'));
  ok(await mgr.action('shift.delete', { id: sat.id }));
  assert.equal(ok(await mgr.action('shift.createMany', { ...BS, days: ['2030-05-11'] })).shifts.length, 1);
});

test('every week for 4 weeks, or until a day: one repeating slot', async () => {
  const r = ok(await mgr.action('shift.createMany', {
    kind: 'mainstreet', location: 'Newton Exchange', start: '07:00', end: '09:00', days: ['2030-06-04', '2030-06-06'], repeat: { weeks: 4 },
  }));
  assert.equal(r.shifts.length, 8);
  assert.ok(r.series_id, 'a repeating slot');
  const made = await shiftsOf('Mainstreet — Newton Exchange');
  assert.deepEqual(made.map((s) => iso(s.starts_at).slice(0, 10)),
    ['2030-06-04', '2030-06-06', '2030-06-11', '2030-06-13', '2030-06-18', '2030-06-20', '2030-06-25', '2030-06-27']);
  assert.deepEqual([...new Set(made.map((s) => s.series_id))], [r.series_id]);
  assert.ok((await eventsOf('shift.createMany', 'shift')).filter((e) => e.payload.series_id === r.series_id).length === 8, 'the events say so too');

  const until = ok(await mgr.action('shift.createMany', {
    kind: 'phone_bank', location: 'Campaign office', start: '18:00', end: '20:00', days: ['2030-06-05'], repeat: { until: '2030-06-20' },
  }));
  assert.deepEqual(until.shifts.map((s) => s.day), ['2030-06-05', '2030-06-12', '2030-06-19'], 'while on or before the day');
  // Two chosen days a week apart, repeating: their weeks overlap, and each day is made once.
  const overlap = ok(await mgr.action('shift.createMany', {
    kind: 'office', location: 'Campaign office', start: '09:00', end: '12:00', days: ['2030-06-03', '2030-06-10'], repeat: { weeks: 3 },
  }));
  assert.deepEqual(overlap.shifts.map((s) => s.day), ['2030-06-03', '2030-06-10', '2030-06-17', '2030-06-24']);
  assert.equal((await shiftsOf('Office — Campaign office')).length, 4, 'never two at the same place and time');
  // Asking again only fills what is missing: nothing.
  const again = ok(await mgr.action('shift.createMany', {
    kind: 'phone_bank', location: 'Campaign office', start: '18:00', end: '20:00', days: ['2030-06-05'], repeat: { until: '2030-06-20' },
  }));
  assert.deepEqual([again.shifts.length, again.skipped.length], [0, 3]);
});

test('limits and refusals: 200 shifts and 26 weeks a call, an end after the start — and nothing half-made', async () => {
  const count = async () => (await rows('select count(*)::int as n from shifts where workspace_id = $1', [ws]))[0].n;
  const had = await count();
  const week = ['2030-07-01', '2030-07-02', '2030-07-03', '2030-07-04', '2030-07-05', '2030-07-06', '2030-07-07'];
  const call = (extra) => mgr.action('shift.createMany', { kind: 'canvass', location: 'Somewhere', start: '10:00', end: '13:00', days: week, ...extra });
  // Every day of July, each again for 26 weeks: 206 different days.
  const july = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2030, 6, 1 + i)).toISOString().slice(0, 10));
  const big = await call({ days: july, repeat: { weeks: 26 } });
  assert.equal(big.status, 400, '206 shifts');
  assert.match(big.json.error, /206 shifts — 200 at most/);
  assert.equal((await call({ repeat: { weeks: 27 } })).status, 400, '27 weeks');
  const far = await call({ days: ['2030-07-01'], repeat: { until: '2031-01-01' } });
  assert.equal(far.status, 400, 'until a day more than 26 weeks on');
  assert.match(far.json.error, /26 weeks/);
  assert.equal((await call({ start: '13:00', end: '13:00' })).status, 400, 'an end at the start');
  assert.equal((await call({ start: '13:00', end: '10:00' })).status, 400, 'an end before the start');
  assert.equal((await call({ days: [] })).status, 400, 'no day');
  assert.equal((await call({ days: ['2030-02-30'] })).status, 400, 'not a day');
  assert.equal((await call({ start: '10am' })).status, 400, 'not a time');
  assert.equal((await call({ kind: 'parade' })).status, 400, 'not a kind');
  assert.equal((await call({ place_id: '99999999-9999-4999-8999-999999999999' })).status, 400, 'no such place');
  assert.equal((await call({ turf_ids: ['99999999-9999-4999-8999-999999999999'] })).status, 400, 'no such turf');
  assert.equal(await count(), had, 'a refused call makes nothing');
  // 26 weeks of one day is fine — and so is exactly 200 (25 days in a row, each again for 26 weeks).
  const full = ok(await call({ repeat: { weeks: 26 }, days: week.slice(0, 1) }));
  assert.equal(full.shifts.length, 26);
  const exact = ok(await call({ kind: 'signs', repeat: { weeks: 26 }, days: july.slice(0, 25) }));
  assert.equal(exact.shifts.length, 200);
  assert.equal((await eventsOf('shift.createMany', 'shift')).filter((e) => e.payload.series_id === exact.series_id).length, 200, 'an event each, however many');
});

test('a turf is the place: its walk list comes with the shift, and its name is the name', async () => {
  const turf = (n, name) => mgr.action('turf.create', { name, polygon: [[49.13 + n, -122.86], [49.13 + n, -122.85], [49.12 + n, -122.85], [49.12 + n, -122.86]] });
  const newton = ok(await turf(0, 'Newton block')).turf;
  const east = ok(await turf(0.02, '72 Ave east')).turf;
  const one = ok(await mgr.action('shift.createMany', { kind: 'canvass', turf_ids: [newton.id], start: '10:00', end: '13:00', days: ['2030-08-03', '2030-08-10'] }));
  assert.deepEqual(one.shifts.map((s) => s.title), ['Canvass — Newton block', 'Canvass — Newton block']);
  const carried = ok(await mgr.get('/api/shiftturfs')).shifts;
  for (const s of one.shifts) assert.deepEqual(carried[s.id].map((t) => t.name), ['Newton block']);
  const set = (await eventsOf('shift.createMany', 'shift')).filter((e) => e.op === 'update' && one.shifts.some((s) => s.id === e.entity_id));
  assert.deepEqual(set.map((e) => e.payload), [{ turf_ids: [newton.id] }, { turf_ids: [newton.id] }], 'as shift.turfs.set writes them');
  // Two turfs: both names. A saved place or words as well: those are the name, the turfs still come.
  const two = ok(await mgr.action('shift.createMany', { kind: 'lit_drop', turf_ids: [east.id, newton.id], start: '10:00', end: '12:00', days: ['2030-08-04'] }));
  assert.equal(two.shifts[0].title, 'Lit drop — Newton block, 72 Ave east');
  const meet = ok(await mgr.action('shift.createMany', { kind: 'canvass', turf_ids: [newton.id], location: 'Newton Rec Centre', start: '14:00', end: '17:00', days: ['2030-08-03'] }));
  assert.equal(meet.shifts[0].title, 'Canvass — Newton Rec Centre');
  assert.deepEqual(ok(await mgr.get(`/api/shiftturfs/${meet.shifts[0].id}`)).turfs.map((t) => t.name), ['Newton block']);
  // The same turf at the same time again: skipped.
  assert.equal(ok(await mgr.action('shift.createMany', { kind: 'canvass', turf_ids: [newton.id], start: '10:00', end: '13:00', days: ['2030-08-03'] })).shifts.length, 0);
  // Someone who joins gets the walk list (the shift's hooks see ordinary shifts).
  ok(await vol.action('shift.join', { shift_id: one.shifts[0].id }));
  assert.deepEqual(ok(await vol.get('/api/turfs')).turfs.map((t) => t.name), ['Newton block']);
  ok(await vol.action('shift.leave', { shift_id: one.shifts[0].id }));
});

test('who may: the desk; a volunteer only when granted Shifts — and walk lists need Map & turfs too', async () => {
  const call = (c, extra = {}) => c.action('shift.createMany', { kind: 'office', location: 'Campaign office', start: '09:00', end: '12:00', days: ['2030-09-02'], ...extra });
  assert.equal((await call(vol)).status, 403);
  assert.equal((await vol.action('shift.copyWeek', { from: MON, to: '2030-05-13' })).status, 403);
  const made = ok(await call(staff), 'staff');
  assert.equal((await rows('select created_by from shifts where id = $1', [made.shifts[0].id]))[0].created_by, staffId);
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: ['shifts'], deny: [] }));
  ok(await call(vol, { start: '13:00', end: '16:00' }), 'a volunteer granted Shifts');
  const turf = (await rows(`select id from turfs where workspace_id = $1 and name = 'Newton block'`, [ws]))[0];
  assert.equal((await call(vol, { kind: 'canvass', turf_ids: [turf.id], days: ['2030-09-03'] })).status, 403, 'Shifts alone hands out no walk list');
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: [], deny: [] }));
});

test('more than the bare shift: a typed name, instructions, a link, a limit, the website', async () => {
  const r = ok(await mgr.action('shift.createMany', {
    kind: 'event', location: 'Bear Creek Park', start: '11:00', end: '14:00', days: ['2030-09-07'],
    name: 'Family picnic', instructions: 'Bring a blanket.', link: 'https://example.org/picnic', capacity: 40, public: true,
  }));
  const s = (await rows('select * from shifts where id = $1', [r.shifts[0].id]))[0];
  assert.deepEqual([s.title, s.title_custom, s.instructions, s.link, s.capacity, s.need, s.public, s.kind, s.role],
    ['Family picnic', true, 'Bring a blanket.', 'https://example.org/picnic', 40, null, true, 'event', 'event_hosting']);
  // The limit is the same hard limit as ever.
  const a = await mgr.createPerson('Ana Example');
  ok(await mgr.action('shift.update', { id: s.id, capacity: 1 }));
  ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: a.id }));
  const b = await mgr.createPerson('Bo Example');
  assert.equal((await mgr.action('shift.assign', { shift_id: s.id, person_id: b.id })).status, 409, 'shift is at capacity');
});

test('copy a week: the same shifts a week on — and, when asked, the same people as plain bookings', async () => {
  // The week of Apr 7, 2031: a Burma Shave with a target, a canvass on a turf with a limit and on the website, a typed-name shift.
  const turf = (await rows(`select id from turfs where workspace_id = $1 and name = 'Newton block'`, [ws]))[0];
  const bs = ok(await mgr.action('shift.createMany', { ...BS, days: ['2031-04-07', '2031-04-09'], need: 4 })).shifts;
  const cv = ok(await mgr.action('shift.createMany', { kind: 'canvass', turf_ids: [turf.id], start: '10:00', end: '13:00', days: ['2031-04-12'], capacity: 6, public: true })).shifts[0];
  const typed = ok(await mgr.action('shift.create', { title: 'Sign crew', role: 'driver', starts_at: '2031-04-10T09:00:00-07:00', ends_at: '2031-04-10T12:00:00-07:00', instructions: 'Bring gloves.' })).shift;
  // People: one booked by the desk, one who confirmed herself (with an app sign-in), one checked in, one who couldn't make it, one who didn't show.
  const people = {};
  for (const n of ['Asha', 'Ben', 'Cam', 'Dee']) people[n] = await mgr.createPerson(`${n} Example`, { email: `${n.toLowerCase()}.${tag}@example.org` });
  const on = async (shift, person) => ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: person.id })).assignment.id;
  await on(bs[0], people.Asha);
  ok(await mgr.action('shift.setStatus', { id: await on(bs[0], people.Ben), status: 'completed' }));
  ok(await mgr.action('shift.setStatus', { id: await on(bs[0], people.Cam), status: 'declined' }));
  ok(await mgr.action('shift.setStatus', { id: await on(bs[0], people.Dee), status: 'no_show' }));
  ok(await vol.action('shift.join', { shift_id: cv.id })); // confirmed, by herself
  await on(typed, people.Asha);

  // Without people first.
  const r = ok(await mgr.action('shift.copyWeek', { from: '2031-04-09', to: '2031-04-14' }), 'any day of a week names the week');
  assert.equal(r.shifts.length, 4);
  assert.deepEqual([r.already, r.booked], [0, 0]);
  const copies = await rows(`select * from shifts where workspace_id = $1 and starts_at >= '2031-04-14T00:00:00-07:00' and starts_at < '2031-04-21T00:00:00-07:00' and deleted_at is null order by starts_at`, [ws]);
  assert.deepEqual(copies.map((s) => [s.title, iso(s.starts_at), iso(s.ends_at)]), [
    ['Burma Shave — King George Blvd & 88 Ave', '2031-04-14T13:30:00.000Z', '2031-04-14T15:30:00.000Z'],
    ['Burma Shave — King George Blvd & 88 Ave', '2031-04-16T13:30:00.000Z', '2031-04-16T15:30:00.000Z'],
    ['Sign crew', '2031-04-17T16:00:00.000Z', '2031-04-17T19:00:00.000Z'],
    ['Canvass — Newton block', '2031-04-19T17:00:00.000Z', '2031-04-19T20:00:00.000Z'],
  ]);
  const [c1, , cSign, cCanvass] = copies;
  assert.deepEqual([c1.kind, c1.need, c1.capacity, c1.public, c1.title_custom, c1.role], ['burma_shave', 4, null, false, false, 'burmashave']);
  assert.deepEqual([cSign.kind, cSign.role, cSign.instructions, cSign.title_custom], [null, 'driver', 'Bring gloves.', true], 'a shift from the long form copies as it is');
  assert.deepEqual([cCanvass.capacity, cCanvass.public, cCanvass.kind], [6, true, 'canvass'], 'limit and on-the-website come too');
  assert.deepEqual(ok(await mgr.get(`/api/shiftturfs/${cCanvass.id}`)).turfs.map((t) => t.name), ['Newton block'], 'and its turfs');
  const created = (await eventsOf('shift.copyWeek', 'shift')).filter((e) => e.op === 'create');
  assert.equal(created.length, 4, 'an ordinary shift/create each');
  assert.equal((await rows('select count(*)::int as n from shift_assignments where shift_id = any($1::uuid[])', [copies.map((s) => s.id)]))[0].n, 0, 'nobody yet');

  // Again, with the people: nothing is made twice; the same people arrive on the shifts already there.
  const again = ok(await mgr.action('shift.copyWeek', { from: '2031-04-07', to: '2031-04-14', with_people: true }));
  assert.deepEqual([again.shifts.length, again.already, again.booked], [0, 4, 4]);
  const booked = await rows(
    `select s.title, p.name, a.status, a.id from shift_assignments a join persons p on p.id = a.person_id join shifts s on s.id = a.shift_id
      where a.shift_id = any($1::uuid[]) order by s.starts_at, p.name`, [copies.map((s) => s.id)]);
  assert.deepEqual(booked.map((b) => [b.title, b.name, b.status]), [
    ['Burma Shave — King George Blvd & 88 Ave', 'Asha Example', 'assigned'],
    ['Burma Shave — King George Blvd & 88 Ave', 'Ben Example', 'assigned'],
    ['Sign crew', 'Asha Example', 'assigned'],
    ['Canvass — Newton block', 'Vik Example', 'assigned'],
  ], 'booked, never confirmed — and nobody who declined or didn’t show');
  const bookings = await eventsOf('shift.copyWeek', 'shift_assignment');
  assert.deepEqual(bookings.map((e) => [e.op, Object.keys(e.payload).sort()]), Array(4).fill(['create', ['id', 'person_id', 'shift_id']]),
    'the events shift.assign writes: no status in them');
  assert.equal((await rows('select count(*)::int as n from shift_turf_walkers where shift_id = $1 and user_id = $2', [cCanvass.id, volId]))[0].n, 1,
    'the walk list follows the booking, as for any booking (the shift’s hook saw an ordinary event)');
  // A third time changes nothing.
  const third = ok(await mgr.action('shift.copyWeek', { from: '2031-04-07', to: '2031-04-14', with_people: true }));
  assert.deepEqual([third.shifts.length, third.already, third.booked], [0, 4, 0]);
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('copy a week: a full shift takes no more, a week copies only onto another week, and never into the past', async () => {
  // The copy of the canvass has room for 6 and one booked: fill the source past it by lifting its limit there.
  const src = (await rows(`select id from shifts where workspace_id = $1 and title = 'Canvass — Newton block' and starts_at = '2031-04-12T10:00:00-07:00'`, [ws]))[0];
  const dst = (await rows(`select id from shifts where workspace_id = $1 and title = 'Canvass — Newton block' and starts_at = '2031-04-19T10:00:00-07:00'`, [ws]))[0];
  ok(await mgr.action('shift.update', { id: dst.id, capacity: 2 }));
  for (const n of ['Eli', 'Flo', 'Gus']) {
    const p = await mgr.createPerson(`${n} Example`);
    ok(await mgr.action('shift.assign', { shift_id: src.id, person_id: p.id }));
  }
  const r = ok(await mgr.action('shift.copyWeek', { from: '2031-04-07', to: '2031-04-14', with_people: true }));
  assert.deepEqual([r.booked, r.full], [1, 2], 'one more fits the limit of 2; two are left out and counted');
  assert.equal((await rows(`select count(*)::int as n from shift_assignments where shift_id = $1 and status = 'assigned'`, [dst.id]))[0].n, 2);

  assert.equal((await mgr.action('shift.copyWeek', { from: '2031-04-07', to: '2031-04-13' })).status, 400, 'the same week');
  assert.equal((await mgr.action('shift.copyWeek', { from: '2031-03-03', to: '2031-03-10' })).status, 409, 'an empty week has nothing to copy');
  assert.equal((await mgr.action('shift.copyWeek', { from: 'last week', to: '2031-04-14' })).status, 400);

  // Into a week already over: nothing is made (people would be credited with shifts that never were).
  const before = (await rows('select count(*)::int as n from shifts where workspace_id = $1', [ws]))[0].n;
  const past = ok(await mgr.action('shift.copyWeek', { from: '2031-04-07', to: '2020-10-05', with_people: true }));
  assert.deepEqual([past.shifts.length, past.past, past.booked], [0, 4, 0]);
  assert.equal((await rows('select count(*)::int as n from shifts where workspace_id = $1', [ws]))[0].n, before);
});

test('copy a week across a clock change keeps the local time — not “168 hours later”', async () => {
  // A campaign on Toronto time: clocks go forward on March 14, 2027.
  const saved = process.env.STARBASE_TZ;
  process.env.STARBASE_TZ = 'America/Toronto';
  const east = new Client();
  let eastWs;
  try { eastWs = (await east.signup({ workspaceName: `East ${tag}`, email: `many-east+${tag}@example.org` })).json.workspace.id; } finally {
    if (saved === undefined) delete process.env.STARBASE_TZ; else process.env.STARBASE_TZ = saved;
  }
  const made = ok(await east.action('shift.createMany', { kind: 'burma_shave', location: 'Yonge & Bloor', start: '06:30', end: '08:30', days: ['2027-03-09'], repeat: { weeks: 2 } }));
  const mine = await rows('select starts_at, ends_at from shifts where workspace_id = $1 order by starts_at', [eastWs]);
  assert.deepEqual(mine.map((s) => iso(s.starts_at)), ['2027-03-09T11:30:00.000Z', '2027-03-16T10:30:00.000Z'], 'a repeat is 6:30 each week: EST, then EDT');
  assert.equal(made.shifts.length, 2);
  ok(await east.action('shift.copyWeek', { from: '2027-03-08', to: '2027-03-22' }));
  const all = await rows('select starts_at, ends_at from shifts where workspace_id = $1 order by starts_at', [eastWs]);
  assert.deepEqual([iso(all[2].starts_at), iso(all[2].ends_at)], ['2027-03-23T10:30:00.000Z', '2027-03-23T12:30:00.000Z'], '6:30–8:30 EDT, not 7:30');
});

test('a repeating slot: “this and the following” changes those not changed on their own', async () => {
  const r = ok(await mgr.action('shift.createMany', {
    kind: 'burma_shave', location: '152 St & 64 Ave', start: '06:30', end: '08:30', days: ['2030-11-05'], repeat: { weeks: 5 }, need: 4,
  }));
  const [w1, w2, w3, w4, w5] = r.shifts;
  const at = async (id) => { const s = (await rows('select * from shifts where id = $1', [id]))[0]; return [iso(s.starts_at).slice(0, 16), s.location, s.title, s.need]; };
  // Week 4 is changed on its own (a later start).
  ok(await mgr.action('shift.update', { id: w4.id, start: '07:00', end: '09:00' }));

  // From week 2: a new place and target, for this one and the following.
  const office = ok(await mgr.action('place.save', { name: 'Fleetwood corner', lat: 49.15, lng: -122.8 })).place;
  const u = ok(await mgr.action('shift.series.update', { id: w2.id, patch: { place_id: office.id, need: 6 } }));
  assert.deepEqual([u.changed.length, u.left], [3, 1], 'weeks 2, 3 and 5 — week 4 is left as the desk set it');
  assert.deepEqual(await at(w1.id), ['2030-11-05T13:30', '152 St & 64 Ave', 'Burma Shave — 152 St & 64 Ave', 4], 'the one before is untouched');
  for (const w of [w2, w3, w5]) {
    assert.deepEqual((await at(w.id)).slice(1), ['Fleetwood corner', 'Burma Shave — Fleetwood corner', 6]);
  }
  assert.deepEqual(await at(w4.id), ['2030-11-26T14:00', '152 St & 64 Ave', 'Burma Shave — 152 St & 64 Ave', 4]);
  // Each change is an ordinary shift/update.
  const events = await eventsOf('shift.series.update', 'shift');
  assert.deepEqual(events.map((e) => [e.entity_id, e.op]), [w2, w3, w5].map((w) => [w.id, 'update']));
  assert.deepEqual(events[0].payload, { place_id: office.id, need: 6, location: 'Fleetwood corner', title: 'Burma Shave — Fleetwood corner' });

  // Other hours and another weekday, from week 3 on: each keeps its own week.
  ok(await mgr.action('shift.series.update', { id: w3.id, patch: { day: '2030-11-20', start: '16:00', end: '18:00' } }));
  assert.equal((await at(w2.id))[0], '2030-11-12T13:30', 'the one before stays');
  assert.equal((await at(w3.id))[0], '2030-11-20T23:00', 'Wednesday 4 pm');
  assert.equal((await at(w5.id))[0], '2030-12-04T23:00', 'the following one moves the same way');
  assert.equal((await at(w4.id))[0], '2030-11-26T14:00');
  // Changed together, they still follow each other: week 5 was not "changed on its own".
  ok(await mgr.action('shift.series.update', { id: w3.id, patch: { need: 8 } }));
  assert.equal((await at(w5.id))[3], 8);

  // Refusals: a shift that doesn't repeat, a bad patch, a limit below those booked on a following one (nothing changes).
  const single = ok(await mgr.action('shift.createMany', { ...BS, days: ['2030-12-09'] })).shifts[0];
  assert.equal((await mgr.action('shift.series.update', { id: single.id, patch: { need: 2 } })).status, 400);
  assert.equal((await mgr.action('shift.series.update', { id: w2.id, patch: { start: '25:00' } })).status, 400);
  assert.equal((await mgr.action('shift.series.update', { id: w2.id, patch: {} })).status, 400, 'nothing to change');
  for (const n of ['Hal', 'Ivy']) ok(await mgr.action('shift.assign', { shift_id: w5.id, person_id: (await mgr.createPerson(`${n} Example`)).id }));
  const tight = await mgr.action('shift.series.update', { id: w3.id, patch: { capacity: 1 } });
  assert.equal(tight.status, 409);
  assert.match(tight.json.error, /Dec 4/, 'it says which day');
  assert.equal((await rows('select capacity from shifts where id = $1', [w3.id]))[0].capacity, null, 'all or nothing');
  assert.equal((await vol.action('shift.series.update', { id: w2.id, patch: { need: 2 } })).status, 403);
});

test('ending a repeating slot calls off the ones nobody is on and answers with the rest', async () => {
  const r = ok(await mgr.action('shift.createMany', {
    kind: 'mainstreet', location: 'Guildford Exchange', start: '07:00', end: '09:00', days: ['2031-01-07'], repeat: { weeks: 4 }, public: true,
  }));
  const [w1, w2, w3, w4] = r.shifts;
  const p = await mgr.createPerson('Jo Example');
  const q = await mgr.createPerson('Kai Example');
  ok(await mgr.action('shift.assign', { shift_id: w3.id, person_id: p.id }));
  // Someone who can't make it holds no spot: that week can go.
  ok(await mgr.action('shift.setStatus', { id: ok(await mgr.action('shift.assign', { shift_id: w4.id, person_id: q.id })).assignment.id, status: 'declined' }));

  const c = ok(await mgr.action('shift.series.cancel', { id: w2.id }));
  assert.deepEqual(c.called_off.sort(), [w2.id, w4.id].sort());
  assert.deepEqual(c.kept.map((k) => [k.id, k.booked, k.title]), [[w3.id, 1, 'Mainstreet — Guildford Exchange']], 'the one with someone on it stays, and is named');
  const live = (await rows('select id from shifts where series_id = $1 and deleted_at is null order by starts_at', [r.series_id])).map((s) => s.id);
  assert.deepEqual(live, [w1.id, w3.id], 'the one before, and the one with people');
  const voided = (await eventsOf('shift.series.cancel', 'shift')).map((e) => [e.entity_id, e.op]);
  assert.deepEqual(voided.sort(), [[w2.id, 'void'], [w4.id, 'void']].sort(), 'an ordinary shift/void each');
  assert.equal((await mgr.action('shift.series.cancel', { id: w2.id })).status, 404, 'already called off');
  assert.equal((await vol.action('shift.series.cancel', { id: w1.id })).status, 403);
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('several times in one write: a morning and an afternoon on each chosen day, each its own repeating slot', async () => {
  const turfless = { kind: 'canvass', location: 'Bear Creek Park', days: ['2030-10-05', '2030-10-06'] };
  const two = ok(await mgr.action('shift.createMany', { ...turfless, slots: [{ start: '14:00', end: '17:00' }, { start: '10:00', end: '13:00' }] }));
  assert.deepEqual(two.shifts.map((s) => [s.day, iso(s.starts_at).slice(11, 16)]),
    [['2030-10-05', '17:00'], ['2030-10-05', '21:00'], ['2030-10-06', '17:00'], ['2030-10-06', '21:00']], 'each day, soonest first');
  assert.equal(two.series_id, null, 'just this week');
  const events = (await eventsOf('shift.createMany', 'shift')).filter((e) => two.shifts.some((s) => s.id === e.entity_id));
  assert.equal(events.length, 4, 'an ordinary shift/create each');
  assert.equal(new Set(events.map((e) => iso(e.server_ts))).size, 1, 'one transaction');
  // Asked again with a third time: only the new time is made, and each one skipped is said with its time.
  const more = ok(await mgr.action('shift.createMany', {
    ...turfless, slots: [{ start: '10:00', end: '13:00' }, { start: '14:00', end: '17:00' }, { start: '18:00', end: '20:00' }],
  }));
  assert.deepEqual(more.shifts.map((s) => iso(s.starts_at).slice(11, 16)), ['01:00', '01:00'], '6 pm both days');
  assert.deepEqual(more.skipped, [
    { day: '2030-10-05', start: '10:00' }, { day: '2030-10-05', start: '14:00' }, { day: '2030-10-06', start: '10:00' }, { day: '2030-10-06', start: '14:00' },
  ]);
  // Repeating: each time is its own repeating slot, so "this and the following" on the morning leaves the afternoon alone.
  const rep = ok(await mgr.action('shift.createMany', {
    kind: 'burma_shave', location: '152 St & 64 Ave', days: ['2030-10-07'], repeat: { weeks: 3 },
    slots: [{ start: '06:30', end: '08:30' }, { start: '16:00', end: '18:00' }],
  }));
  assert.equal(rep.shifts.length, 6);
  const made = await rows('select starts_at, series_id from shifts where id = any($1::uuid[]) order by starts_at', [rep.shifts.map((s) => s.id)]);
  const am = [...new Set(made.filter((s) => iso(s.starts_at).slice(11, 16) === '13:30').map((s) => s.series_id))];
  const pm = [...new Set(made.filter((s) => iso(s.starts_at).slice(11, 16) === '23:00').map((s) => s.series_id))];
  assert.deepEqual([am.length, pm.length], [1, 1], 'one slot a time');
  assert.ok(am[0] && pm[0] && am[0] !== pm[0], 'and not the same one');
  assert.deepEqual(rep.shifts.map((s) => s.series_id), made.map((s) => s.series_id), 'the answer says which');
  const moved = ok(await mgr.action('shift.series.update', { id: rep.shifts[0].id, patch: { start: '07:00', end: '09:00' } }));
  assert.equal(moved.changed.length, 3, 'the three mornings');
  assert.deepEqual((await rows('select starts_at from shifts where series_id = $1 order by starts_at', [pm[0]])).map((s) => iso(s.starts_at).slice(11, 16)),
    ['23:00', '23:00', '23:00'], 'the afternoons are as they were');
  // Refusals, and nothing half-made: a time said both ways, two that start together, an end before its start, 200 at most.
  const count = async () => (await rows('select count(*)::int as n from shifts where workspace_id = $1', [ws]))[0].n;
  const had = await count();
  const call = (extra) => mgr.action('shift.createMany', { kind: 'office', location: 'Campaign office', days: ['2030-10-08'], ...extra });
  assert.equal((await call({ start: '09:00', end: '12:00', slots: [{ start: '13:00', end: '16:00' }] })).status, 400, 'both ways');
  assert.equal((await call({})).status, 400, 'no time at all');
  assert.equal((await call({ start: '09:00' })).status, 400, 'a start with no end');
  assert.equal((await call({ slots: [] })).status, 400, 'no times');
  assert.equal((await call({ slots: [{ start: '09:00', end: '12:00' }, { start: '09:00', end: '11:00' }] })).status, 400, 'two that start together');
  const back = await call({ slots: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '12:00' }] });
  assert.equal(back.status, 400, 'an end before its start');
  assert.match(back.json.error, /end has to be after the start/);
  const july = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2031, 6, 1 + i)).toISOString().slice(0, 10));
  // 136 days would be fine once a day; twice a day they are 272 shifts.
  const big = await call({ days: july, repeat: { weeks: 16 }, slots: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '16:00' }] });
  assert.equal(big.status, 400);
  assert.match(big.json.error, /272 shifts — 200 at most/);
  assert.equal(await count(), had, 'a refused call makes nothing');
  assert.equal((await verifyChain(db, ws)).ok, true);
});
