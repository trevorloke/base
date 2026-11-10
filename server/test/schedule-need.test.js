// No maximum (ext/schedule): nothing has to say how many people a shift
// takes. A shift may carry a target — "need" — that never refuses anyone:
// it is what Today's "Needs you" counts against ("3 of 4 — one more"). A
// limit is still the hard limit it always was, on the shifts that set one,
// and an older shift with only a limit is still listed when it is thin.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { addDays, dayOf, instantOf } from '@starbase/shared/dayparts';
import { shortBy } from '@starbase/shared/shiftkinds';

const TZ = 'America/Vancouver';
const tag = Math.random().toString(36).slice(2, 8);
const ahead = (n) => addDays(dayOf(new Date(), TZ), n);
let db, mgr, vol, ws;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const person = (name) => mgr.createPerson(`${name} Example`);
const assign = async (shift, name) => mgr.action('shift.assign', { shift_id: shift.id, person_id: (await person(name)).id });
const wave = async (day, extra = {}) => ok(await mgr.action('shift.createMany', {
  kind: 'burma_shave', location: 'King George Blvd & 88 Ave', days: [day], start: '06:30', end: '08:30', ...extra,
})).shifts[0];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Need ${tag}`, email: `need-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = ok(await mgr.action('member.invite', { email: `need-vol+${tag}@example.org`, role: 'volunteer' }));
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Vik Example', password: 'need-pass-2026' }));
});

test('how many more a shift wants: by its target, else by an older shift’s limit, else nothing', () => {
  assert.equal(shortBy({ need: 4, filled: 3 }), 1);
  assert.equal(shortBy({ need: 4, filled: 4 }), 0);
  assert.equal(shortBy({ need: 4, filled: 9 }), 0, 'more than it wanted is not a shortage');
  assert.equal(shortBy({ need: 4, capacity: 10, filled: 4 }), 0, 'the target, not the limit, when it has both');
  assert.equal(shortBy({ need: null, capacity: 5, filled: 2 }), 3, 'an older shift: by its limit');
  assert.equal(shortBy({ filled: 0 }), 0, 'no number wanted');
  assert.equal(shortBy({ need: 2 }), 2, 'nobody yet');
  assert.equal(shortBy(null), 0);
});

test('a target never refuses anyone; a limit still does', async () => {
  const s = await wave(ahead(3), { need: 1 });
  for (const n of ['Asha', 'Ben', 'Cam']) assert.equal((await assign(s, n)).status, 200, `${n}: past the target, still welcome`);
  ok(await vol.action('shift.join', { shift_id: s.id }), 'and a volunteer counts themselves in');
  const row = ok(await vol.get('/api/shifts')).shifts.find((x) => x.id === s.id);
  assert.deepEqual([row.need, row.capacity, row.filled, shortBy(row)], [1, null, 4, 0]);
  // "Can't make it" and back again: no room is checked against a target.
  ok(await vol.action('shift.leave', { shift_id: s.id }));
  ok(await vol.action('shift.join', { shift_id: s.id }));

  // Both: the target is what it hopes for, the limit what it can take.
  const both = await wave(ahead(4), { need: 2, capacity: 3 });
  for (const n of ['Dee', 'Eli', 'Flo']) assert.equal((await assign(both, n)).status, 200);
  const full = await assign(both, 'Gus');
  assert.deepEqual([full.status, full.json.error], [409, 'shift is at capacity']);
  assert.deepEqual([(await vol.action('shift.join', { shift_id: both.id })).status], [409], 'full is still full');

  // Nothing said: no target, no limit — anyone, any number.
  const open = await wave(ahead(5));
  const stored = (await db.query('select need, capacity from shifts where id = $1', [open.id])).rows[0];
  assert.deepEqual([stored.need, stored.capacity], [null, null], 'the kind’s usual number is a suggestion, never written by itself');
  for (const n of ['Hal', 'Ivy', 'Jo', 'Kai', 'Lu', 'Mo']) assert.equal((await assign(open, n)).status, 200);
});

test('a target is set, changed and taken off like any other detail', async () => {
  const s = await wave(ahead(6));
  ok(await mgr.action('shift.update', { id: s.id, need: 4 }));
  assert.equal((await db.query('select need from shifts where id = $1', [s.id])).rows[0].need, 4);
  ok(await mgr.action('shift.update', { id: s.id, capacity: 6 }), 'another detail leaves it alone');
  assert.equal((await db.query('select need from shifts where id = $1', [s.id])).rows[0].need, 4);
  ok(await mgr.action('shift.update', { id: s.id, need: null }));
  assert.equal((await db.query('select need from shifts where id = $1', [s.id])).rows[0].need, null);
  for (const bad of [0, -1, 1.5, 1000, 'four']) assert.equal((await mgr.action('shift.update', { id: s.id, need: bad })).status, 400, `need: ${bad}`);
  assert.equal((await mgr.action('shift.createMany', { kind: 'office', location: 'Campaign office', days: [ahead(6)], start: '09:00', end: '12:00', need: 0 })).status, 400);
  assert.equal((await vol.action('shift.update', { id: s.id, need: 2 })).status, 403);
  ok(await mgr.action('shift.delete', { id: s.id }));
});

test('Today’s “Needs you”: shifts in the next seven days short of their target — or of an older shift’s limit', async () => {
  // In the first test: need 1 with four on it (enough), need 2 / limit 3 with three (enough), no number with six.
  const thin = await wave(ahead(2), { need: 4 });
  await assign(thin, 'Nat');
  const oldWay = ok(await mgr.action('shift.create', { title: 'Saturday doorknock', starts_at: instantOf(ahead(2), '10:00', TZ), capacity: 5 })).shift;
  await assign(oldWay, 'Oli'); await assign(oldWay, 'Pia');
  const nobody = ok(await mgr.action('shift.createMany', { kind: 'mainstreet', location: 'Newton Exchange', days: [ahead(1)], start: '07:00', end: '09:00', need: 2 })).shifts[0];
  const far = await wave(ahead(9), { need: 4 }); // more than a week out
  const called = await wave(ahead(1), { need: 4, location: 'Scott Rd & 72 Ave' });
  ok(await mgr.action('shift.delete', { id: called.id }));
  // Someone who can't make it doesn't count as on it.
  const dropped = ok(await mgr.action('shift.assign', { shift_id: nobody.id, person_id: (await person('Quin')).id })).assignment.id;
  ok(await mgr.action('shift.setStatus', { id: dropped, status: 'declined' }));

  const brief = ok(await mgr.get('/api/brief'));
  assert.deepEqual(brief.shortShifts.map((s) => [s.title, s.need, s.capacity, s.filled, s.short]), [
    ['Mainstreet — Newton Exchange', 2, null, 0, 2],
    ['Burma Shave — King George Blvd & 88 Ave', 4, null, 1, 3],
    ['Saturday doorknock', null, 5, 2, 3],
  ], 'soonest first; not the ones with enough, the one with no number, next week’s or the called-off one');
  assert.deepEqual(Object.keys(brief.shortShifts[0]).sort(),
    ['capacity', 'ends_at', 'filled', 'id', 'kind', 'location', 'need', 'role', 'short', 'starts_at', 'title']);
  assert.ok(brief.shortShifts.every((s) => s.short === shortBy(s)), 'the server and the screens count the same way');
  assert.ok(!brief.shortShifts.some((s) => s.id === far.id));
  // Today's own rows carry what a card needs to say "1 of 4".
  const next = brief.shifts.find((s) => s.id === nobody.id);
  assert.deepEqual([next.kind, next.need, next.filled], ['mainstreet', 2, 0]);
  // One more and it has enough: off the list.
  ok(await mgr.action('shift.update', { id: thin.id, need: 1 }));
  assert.ok(!ok(await mgr.get('/api/brief')).shortShifts.some((s) => s.id === thin.id));
  // A volunteer's Today is their own shifts: no desk list.
  assert.equal(ok(await vol.get('/api/brief')).shortShifts, undefined);
});
