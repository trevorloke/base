// Duplicates (ext/duplicates): pairs that look like one person, and
// person.merge — everything that pointed at the second record now points at
// the first; where the first already has the same (one shift, one list),
// its own stays; blanks are filled, tags joined; a donor made one is checked
// against the limit again; "Not the same" keeps a pair away.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { mergedSaid } from '../../web/src/components/DuplicatesWords.js';

let mgr, vol, db;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const pairsOf = async () => ok(await mgr.get('/api/duplicates')).pairs
  .map((p) => [[p.a.name, p.b.name].sort().join(' + '), p.why.sort().join(',')]);
const cheque = async (p, cents, date) => ok(await mgr.action('gift.log', { person_id: p.id, amount_cents: cents, date, method: 'cheque' })).gift;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Dupes', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'vol@example.org', role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vol Example', password: 'vol-pass-123' }));
});

test('found: the same email; the same phone and name; the same name at one door — never a different name on one phone', async () => {
  await mgr.createPerson('Ana Example', { email: 'ana@example.org', phone: '604-555-0101', tags: ['volunteer'] });
  await mgr.createPerson('Ana Example', { email: 'ANA@example.org', address: '1 Main St', city: 'Surrey', tags: ['petition'] });
  await mgr.createPerson('Ben Example', { phone: '(604) 555-0102' });
  await mgr.createPerson('Ben Example', { phone: '6045550102', email: 'ben@example.org' });
  await mgr.createPerson('Cy Example', { address: '9 Oak Ave' });
  await mgr.createPerson('cy  example', { address: '9 oak ave' });
  await mgr.createPerson('Di Example', { phone: '604-555-0103' });
  await mgr.createPerson('Ed Example', { phone: '604-555-0103' });
  assert.deepEqual((await pairsOf()).sort(), [
    ['Ana Example + Ana Example', 'email'],
    ['Ben Example + Ben Example', 'phone'],
    ['Cy Example + cy  example', 'address'],
  ]);
  assert.equal((await vol.get('/api/duplicates')).status, 403, 'the desk’s');
});

test('found: a donor and the same first and last name in one postal code (an address typed another way), never a postal code apart', async () => {
  const gave = async (p) => ok(await mgr.action('gift.log', { person_id: p.id, amount_cents: 5000, date: '2026-05-01', method: 'cheque' }));
  await mgr.createPerson('Rhea Voter', { address: '9876 54 St', city: 'Surrey', postal: 'V3S 2A1' });
  await gave(await mgr.createPerson('Rhea Voter', { email: 'rhea@example.org', address: '9876 54 Street', postal: 'v3s2a1' }));
  await gave(await mgr.createPerson('Theo Apart', { postal: 'V4A 1A1' }));
  await mgr.createPerson('Theo Apart', { postal: 'V3W 9Z9' });
  await gave(await mgr.createPerson('Fay Partial', { postal: 'V3S' }));
  await mgr.createPerson('Fay Partial', { postal: 'V3S' });
  await mgr.createPerson('Nell Nogift', { postal: 'V3R 1B2' });
  await mgr.createPerson('Nell Nogift', { postal: 'V3R 1B2' });
  const found = (await pairsOf()).filter(([n]) => /Rhea|Theo|Fay|Nell/.test(n));
  assert.deepEqual(found, [['Rhea Voter + Rhea Voter', 'postal']]);
  const pair = ok(await mgr.get('/api/duplicates')).pairs.find((p) => p.why.includes('postal'));
  ok(await mgr.action('person.notDuplicate', { a: pair.a.id, b: pair.b.id }));
  assert.ok(!(await pairsOf()).some(([n]) => /Rhea/.test(n)), 'Not the same: away');
});

test('found: a postal code typed with a hyphen is the same postal code', async () => {
  const p = await mgr.createPerson('Hana Hyphen', { email: 'hana@example.org', address: '4321 100 Avenue', postal: 'V3T-2C3' });
  ok(await mgr.action('gift.log', { person_id: p.id, amount_cents: 5000, date: '2026-05-01', method: 'cheque' }));
  await mgr.createPerson('Hana Hyphen', { address: '4321 100 Ave', postal: 'V3T 2C3' });
  assert.deepEqual((await pairsOf()).filter(([n]) => /Hana/.test(n)), [['Hana Hyphen + Hana Hyphen', 'postal']]);
});

test('Not the same: the pair stays away', async () => {
  const p = ok(await mgr.get('/api/duplicates')).pairs.find((x) => x.why.includes('address'));
  ok(await mgr.action('person.notDuplicate', { a: p.b.id, b: p.a.id }));
  assert.ok(!(await pairsOf()).some(([n]) => /Cy/.test(n)));
});

test('merge: history moves, blanks fill, tags join, clashes keep the kept one’s, the old link knows where', async () => {
  const pair = ok(await mgr.get('/api/duplicates')).pairs.find((x) => x.why.includes('email'));
  const [keep, drop] = pair.a.phone ? [pair.a, pair.b] : [pair.b, pair.a];
  // Both on one shift; each with a contact; drop on a list and in a relationship with keep and with Ben.
  const shift = ok(await mgr.action('shift.create', { title: 'Canvass', starts_at: new Date(Date.now() + 864e5).toISOString() })).shift;
  ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: keep.id }));
  ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: drop.id }));
  const shift2 = ok(await mgr.action('shift.create', { title: 'Phones', starts_at: new Date(Date.now() + 2 * 864e5).toISOString() })).shift;
  ok(await mgr.action('shift.assign', { shift_id: shift2.id, person_id: drop.id }));
  ok(await mgr.action('contact.log', { person_id: keep.id, channel: 'door', outcome: 'contacted' }));
  ok(await mgr.action('contact.log', { person_id: drop.id, channel: 'phone', outcome: 'contacted' }));
  const list = ok(await mgr.action('list.create', { name: 'Keen', kind: 'people', person_ids: [drop.id] }));
  const ben = (await db.query("select id from persons where name = 'Ben Example' order by created_at limit 1")).rows[0].id;
  ok(await mgr.action('relationship.add', { from_id: drop.id, person_id: ben, kind: 'friend' }), 'drop knows Ben');
  ok(await mgr.action('relationship.add', { from_id: drop.id, person_id: keep.id, kind: 'family' }), 'drop knows keep');
  // Gifts: each under the limit, together over it (BC 2026: $1,429.70).
  ok(await mgr.action('gift.log', { person_id: keep.id, amount_cents: 100000, date: '2026-03-01', method: 'cheque' }));
  ok(await mgr.action('gift.log', { person_id: drop.id, amount_cents: 80000, date: '2026-04-01', method: 'cheque' }));

  const r = ok(await mgr.action('person.merge', { keep: keep.id, drop: drop.id }));
  assert.ok(r.filled.includes('address') && r.filled.includes('city'), JSON.stringify(r.filled));
  assert.equal(r.flagged.length, 1, 'together over the limit: the latest gift is flagged');
  assert.match(r.flagged[0].reason, /over the \$1429\.70 limit/);

  const kept = ok(await mgr.get(`/api/persons/${keep.id}`));
  assert.deepEqual([kept.person.email, kept.person.phone, kept.person.address], ['ana@example.org', '604-555-0101', '1 Main St']);
  assert.deepEqual([...kept.person.tags].sort(), ['petition', 'volunteer']);
  assert.equal(kept.contacts.length, 2, 'both contacts');
  assert.equal(kept.gifts.length, 2);
  assert.deepEqual(kept.shifts.map((s) => s.title).sort(), ['Canvass', 'Phones'], 'one spot on Canvass, not two');
  assert.equal((await db.query('select count(*)::int as n from shift_assignments where shift_id = $1', [shift.id])).rows[0].n, 1);
  assert.deepEqual((await db.query('select person_id from list_members where list_id = $1', [list.list?.id ?? list.id])).rows.map((x) => x.person_id), [keep.id]);
  const rel = (await db.query('select person_a, person_b from relationships where removed_at is null and (person_a = $1 or person_b = $1 or person_a = $2 or person_b = $2)', [keep.id, drop.id])).rows;
  assert.equal(rel.length, 1, 'keep knows Ben; keep–drop is gone');
  assert.deepEqual([rel[0].person_a, rel[0].person_b].sort(), [keep.id, ben].sort());
  const old = await mgr.get(`/api/persons/${drop.id}`);
  assert.deepEqual([old.status, old.json.merged_into], [404, keep.id], 'an old link says where they went');
  const gone = (await db.query("select deleted_at, attrs->>'merged_into' as into from persons where id = $1", [drop.id])).rows[0];
  assert.ok(gone.deleted_at);
  assert.equal(gone.into, keep.id);
  assert.ok(!(await pairsOf()).some(([n]) => /Ana/.test(n)), 'no longer a pair');
});

test('merge: maybes one donor on the two become the plain over-limit flag, and the answer says the year is over, once', async () => {
  const voter = await mgr.createPerson('Una Twice', { address: '7 One Way', city: 'Surrey', postal: 'V3T 4K4' });
  const other = await mgr.createPerson('Una Twice', { email: 'una.twice@example.org', postal: 'V3T 4K4' });
  await cheque(voter, 100000, '2026-03-01');
  const maybes = [await cheque(other, 50000, '2026-04-01'), await cheque(other, 10000, '2026-05-01')];
  for (const g of maybes) {
    assert.match(g.flag_reason, /^Possibly the same donor as Una Twice \(same postal code\)/);
    assert.deepEqual(g.maybe_same_donor, [voter.id]);
  }
  assert.ok((await pairsOf()).some(([n, why]) => n === 'Una Twice + Una Twice' && why === 'postal'), 'Duplicates lists the two');
  const r = ok(await mgr.action('person.merge', { keep: voter.id, drop: other.id }));
  const now = (await db.query('select id, flagged, flag_reason from gifts where id = any($1::uuid[]) order by date', [maybes.map((g) => g.id)])).rows;
  for (const g of now) assert.match(g.flag_reason, /^Una Twice is at \$1600\.00 for 2026 — over the \$1429\.70 limit/);
  assert.deepEqual(r.flagged, [{ gift_id: maybes[0].id, year: 2026, reason: now[0].flag_reason }], 'over now: 2026, said once');
  assert.equal(mergedSaid('Una Twice', r), '✓ Una Twice: one record — over the donation limit now, flagged in Donations');
});

test('merge: one donor now, over only with a third record that may be them — the flag, the answer and the line say maybe', async () => {
  const keep = await mgr.createPerson('Ida Thrice', { email: 'ida.thrice@example.org', postal: 'V3W 1A1' });
  const drop = await mgr.createPerson('Ida Thrice', { email: 'IDA.thrice@example.org' });
  const third = await mgr.createPerson('Ida Thrice', { postal: 'V3W 1A1' });
  await cheque(keep, 40000, '2026-03-01');
  const moved = await cheque(drop, 40000, '2026-04-01');
  assert.equal((await cheque(third, 70000, '2026-05-01')).flagged, false, '$1,100 with the first: under');
  const r = ok(await mgr.action('person.merge', { keep: keep.id, drop: drop.id }));
  // $800 on the one record; $1,500 with the third.
  const [f] = r.flagged;
  assert.match(f?.reason ?? '', /^Possibly the same donor as Ida Thrice \(same postal code\): together they are at \$1,500\.00 for 2026/);
  assert.deepEqual(r.flagged, [{ gift_id: moved.id, year: 2026, reason: f.reason, maybe_same_donor: [third.id] }], 'a maybe, naming the third record');
  const ev = (await db.query("select payload from events where action = 'person.merge' and entity_type = 'gift' and entity_id = $1", [moved.id])).rows[0];
  assert.deepEqual(ev?.payload.maybe_same_donor, [third.id], 'on the event log too');
  assert.equal(mergedSaid('Ida Thrice', r), '✓ Ida Thrice: one record — maybe over the donation limit together with another record, flagged in Donations');
});

test('refusals: the same record twice, one already gone, a volunteer; the books verify', async () => {
  const ben = (await db.query("select id from persons where name = 'Ben Example' and deleted_at is null order by created_at")).rows.map((x) => x.id);
  assert.equal((await mgr.action('person.merge', { keep: ben[0], drop: ben[0] })).status, 400);
  const ana = (await db.query("select id from persons where name = 'Ana Example' and deleted_at is not null")).rows[0].id;
  assert.equal((await mgr.action('person.merge', { keep: ben[0], drop: ana })).status, 404);
  assert.equal((await vol.action('person.merge', { keep: ben[0], drop: ben[1] })).status, 403);
  ok(await mgr.action('person.merge', { keep: ben[0], drop: ben[1] }));
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('a teammate’s own record merged in: their sign-in email stays on the kept record; links they made and brought in follow', async () => {
  const own = (await db.query("select id from persons where lower(email) = 'vol@example.org' and deleted_at is null")).rows[0]?.id
    ?? (await mgr.createPerson('Vol Example', { email: 'vol@example.org' })).id;
  const keep = await mgr.createPerson('Vol Example', { email: 'vol.personal@example.org', phone: '604-555-0199' });
  const friend = await mgr.createPerson('Fay Example');
  const [a, b] = own < friend.id ? [own, friend.id] : [friend.id, own];
  await db.query(
    `insert into relationships (id, workspace_id, person_a, person_b, kind, brought_in, from_person)
     select gen_random_uuid(), workspace_id, $1, $2, 'friend', $3, $4 from persons where id = $4`,
    [a, b, friend.id, own],
  );
  ok(await mgr.action('person.merge', { keep: keep.id, drop: own }));
  const k = (await db.query("select email, attrs->>'other_email' as other from persons where id = $1", [keep.id])).rows[0];
  assert.deepEqual([k.email, k.other], ['vol@example.org', 'vol.personal@example.org']);
  const rel = (await db.query('select from_person, brought_in from relationships where brought_in = $1', [friend.id])).rows[0];
  assert.equal(rel.from_person, keep.id, 'whose circle: the kept record');
  const mine = ok(await vol.get('/api/relationships/mine'));
  assert.equal(mine.me?.id, keep.id, 'My people still finds them');
});

test('a volunteer granted People still can’t read the duplicates (raw emails, gifts)', async () => {
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: ['people'], deny: [] }));
  assert.equal((await vol.get('/api/duplicates')).status, 403);
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
});
