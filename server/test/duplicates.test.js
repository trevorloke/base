// Duplicates (ext/duplicates): pairs that look like one person, and
// person.merge — everything that pointed at the second record now points at
// the first; where the first already has the same (one shift, one list),
// its own stays; blanks are filled, tags joined; a donor made one is checked
// against the limit again; "Not the same" keeps a pair away.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, vol, db;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const pairsOf = async () => ok(await mgr.get('/api/duplicates')).pairs
  .map((p) => [[p.a.name, p.b.name].sort().join(' + '), p.why.sort().join(',')]);

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
