// The week screen's tray (GET /api/shifts/board → people): who can be put
// on a shift by tap. Not only people holding a volunteer role or a volunteer
// sign-in: someone who signed up on the website — the volunteer form, or a
// spot on a public shift — is there too, marked while their "wants to
// volunteer" is still open, and so is anyone who has been on a shift. Names
// and roles only, never a phone or an email; nobody else on the voter list.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayOf, weekBounds, weekStart } from '@starbase/shared/dayparts';

const { send, ok, campaign, member } = await import('./site-helpers.js');

const TZ = 'America/Vancouver';
const day = addDays(dayOf(new Date(), TZ), 3);
let mgr;
let opening;
const tray = async (client = mgr) => {
  const { from, to } = weekBounds(weekStart(day), TZ);
  const r = await client.get(`/api/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.people;
};
const row = (people, name) => people.find((p) => p.name === name);

before(async () => {
  ({ mgr } = await campaign());
  ok(await mgr.get('/api/site'));
  opening = ok(await mgr.action('shift.createMany', {
    kind: 'burma_shave', location: 'King George Blvd & 88 Ave', days: [day], start: '06:30', end: '08:30', public: true,
  })).shifts[0];
});

test('the tray lists people who signed up on the website: the volunteer form, and a spot on a public shift', async () => {
  const sam = await mgr.createPerson('Sam Example', { phone: '604-555-0101', email: 'sam@example.org' });
  ok(await mgr.action('volunteer.assign', { person_id: sam.id, role: 'burmashave' }));
  await mgr.createPerson('Nell Example', { phone: '604-555-0102' }); // on the voter list, never a volunteer
  assert.deepEqual((await tray()).map((p) => p.name), ['Sam Example'], 'before anyone signs up: people with a role');

  ok(await send('volunteer', { first_name: 'Vera', last_name: 'Example', email: 'vera@example.org', roles: ['Doorknocking'], availability: 'Weekday mornings' }));
  ok(await send('rsvp', { first_name: 'Ana', last_name: 'Example', email: 'ana@example.org', shift_id: opening.id }));

  const people = await tray();
  assert.deepEqual(people.map((p) => p.name), ['Ana Example', 'Sam Example', 'Vera Example'], 'by name; nobody else on the list');
  assert.deepEqual(row(people, 'Vera Example'), { id: row(people, 'Vera Example').id, name: 'Vera Example', roles: [], asked: true },
    'the volunteer form: there, and marked as asking');
  assert.equal(row(people, 'Ana Example').asked, false, 'a spot taken on the website: there, not asking for anything');
  assert.deepEqual(row(people, 'Sam Example').roles, ['burmashave']);
  for (const p of people) assert.deepEqual(Object.keys(p).sort(), ['asked', 'id', 'name', 'roles'], 'names and roles only — never a phone or an email');
});

test('put on a shift, they stay in the tray — no longer marked as asking', async () => {
  const vera = row(await tray(), 'Vera Example');
  const added = ok(await mgr.action('shift.add', { shift_id: opening.id, person_id: vera.id }));
  assert.equal(added.requests_done, 1, 'their “wants to volunteer” is closed by the booking');
  const after = row(await tray(), 'Vera Example');
  assert.ok(after, 'still there for next week');
  assert.equal(after.asked, false);
});

test('someone who was only ever on a shift is in the tray; a volunteer granted Shifts reads the same names', async () => {
  const lee = await mgr.createPerson('Lee Example', { phone: '604-555-0103' });
  ok(await mgr.action('shift.assign', { shift_id: opening.id, person_id: lee.id }));
  assert.ok(row(await tray(), 'Lee Example'), 'booked once by the desk, no role and no sign-in');

  const vol = await member(mgr, 'volunteer', 'Vic Example');
  const { from, to } = weekBounds(weekStart(day), TZ);
  const q = `/api/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  assert.equal((await vol.client.get(q)).status, 403, 'a volunteer without Shifts cannot read the board');
  ok(await mgr.action('permission.member.set', { user_id: vol.id, grant: ['shifts'] }));
  const theirs = await tray(vol.client);
  assert.deepEqual(theirs.map((p) => p.name), ['Ana Example', 'Lee Example', 'Sam Example', 'Vera Example']);
  assert.ok(theirs.every((p) => !('phone' in p) && !('email' in p)));
});
