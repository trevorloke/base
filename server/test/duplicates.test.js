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

// ── One donor on many records: what the desk rules stays ruled ──
// A maybe (ext/payments limits.js) can name more than one record. The desk
// rules them out one by one (Donations: one choice per record), a pair it
// ruled apart is never added up — beside a third record either — and a
// merge keeps the rulings of the record merged in.
const briefRow = async (id) => ok(await mgr.get('/api/brief')).flagged.find((f) => f.id === id);
const ledgerRow = async (id) => ok(await mgr.get('/api/records/gift?limit=200')).records.find((g) => g.id === id);
const giftNow = async (id) => (await db.query('select flagged, flag_reason, attrs from gifts where id = $1', [id])).rows[0];

test('a maybe naming two records: one choice each, and ruling one out keeps the other added up', async () => {
  const v = await mgr.createPerson('Aman Gill', { phone: '604-555-1111', address: '1 Alpha St', postal: 'V3S 1A1' });
  const z = await mgr.createPerson('Aman Gill', { phone: '778-555-2222', address: '99 Zed St', postal: 'V3W 5B5' });
  await cheque(v, 40000, '2026-09-01');
  await cheque(z, 30000, '2026-09-02');
  // The donor gives again with a new email: V's phone, Z's postal code.
  const w = await mgr.createPerson('Aman Gill', { email: 'aman.new@example.org', phone: '604-555-1111', address: '5 Whisky Ave', postal: 'V3W 5B5' });
  const g = await cheque(w, 90000, '2026-12-01');
  assert.match(g.flag_reason, /^Possibly the same donor as Aman Gill \(same phone\) and Aman Gill \(same postal code\): together they are at \$1,600\.00/);
  const row = await briefRow(g.id);
  assert.deepEqual(row.maybe_same_as?.map((n) => [n.id, n.name, n.shares]), [[v.id, 'Aman Gill', 'phone'], [z.id, 'Aman Gill', 'postal code']],
    'Needs you names each record and what it shares');
  assert.deepEqual((await ledgerRow(g.id)).maybe_same_as, row.maybe_same_as, 'so does the ledger');
  const { apartChoices } = await import('../../web/src/components/MoneyWords.js');
  const { choices, duplicates } = apartChoices(row);
  assert.deepEqual([choices.map((c) => c.label), duplicates], [['Not Aman Gill (same phone)', 'Not Aman Gill (same postal code)'], false]);
  const notZ = choices.find((c) => c.id === z.id);
  assert.equal(notZ.ask, 'Not the same person as Aman Gill (same postal code)? The two records are kept apart, and the limit is checked again.');
  // Z is someone else: that pair alone.
  const r = ok(await mgr.action('person.notDuplicate', { a: w.id, b: notZ.id }));
  assert.deepEqual(r.rechecked.map((x) => [x.id, x.flagged]), [[g.id, false]], 'W with V is $1,300: under');
  assert.ok((await pairsOf()).some(([n, why]) => n === 'Aman Gill + Aman Gill' && why === 'phone'), 'W and V still a pair in Duplicates');
  const later = await cheque(v, 50000, '2026-12-02');
  assert.match(later.flag_reason ?? '', /^Possibly the same donor as Aman Gill \(same phone\): together they are at \$1,800\.00 for 2026/, 'V and W still added up');
  assert.deepEqual(later.maybe_same_donor, [w.id]);
});

test('a maybe kept from before (the record ids alone) still offers Not the same person', async () => {
  const { apartChoices } = await import('../../web/src/components/MoneyWords.js');
  const reason = 'Possibly the same donor as Mae Twin (same address and postal code): together they are at $2,000.00 for 2026 — over the $1,429.70 limit on the city council slate (LEOA)';
  assert.deepEqual(apartChoices({ flagged: true, maybe_same_donor: ['a'], flag_reason: reason }), {
    choices: [{ id: 'a', label: 'Not the same person', ask: 'Not the same person as Mae Twin (same address and postal code)? The two records are kept apart, and the limit is checked again.' }],
    duplicates: false,
  }, 'one record: the one the reason names');
  assert.deepEqual(apartChoices({ flagged: true, attrs: { maybe_same_donor: ['a', 'b'] }, flag_reason: reason }), { choices: [], duplicates: true },
    'two it can’t tell apart: People → Duplicates shows them side by side');
  assert.deepEqual(apartChoices({ flagged: false, attrs: { maybe_same_donor: ['a'] } }), { choices: [], duplicates: false }, 'not flagged: nothing to rule');
  // Two that would read the same (one name at one door) say what each gave.
  const both = { name: 'Raj Senior', shares: 'address and postal code' };
  const told = apartChoices({ flagged: true, date: '2026-05-01', maybe_same_donor: ['a', 'b'],
    maybe_same_as: [{ id: 'a', ...both, given_cents: 60000 }, { id: 'b', ...both, given_cents: 90000 }] });
  assert.deepEqual(told.choices.map((c) => c.label), ['Not Raj Senior (same address and postal code) · $600 in 2026', 'Not Raj Senior (same address and postal code) · $900 in 2026']);
  // Stored as before (ids only), the server still names them.
  const one = await mgr.createPerson('Old Maybe', { postal: 'V3V 9P9' });
  const two = await mgr.createPerson('Old Maybe', { email: 'old.maybe@example.org', postal: 'V3V 9P9' });
  await cheque(one, 100000, '2026-12-03');
  const g = await cheque(two, 50000, '2026-12-03');
  assert.deepEqual(g.maybe_same_donor, [one.id]);
  assert.deepEqual((await giftNow(g.id)).attrs.maybe_same_donor, [one.id], 'the ids are all the gift keeps');
  assert.deepEqual((await briefRow(g.id)).maybe_same_as?.map((n) => [n.id, n.name, n.shares]), [[one.id, 'Old Maybe', 'postal code']]);
});

test('two records the desk said are two people are never added up as one donor’s, beside a third either', async () => {
  const at = { address: '1 Sand Rd', postal: 'V3Y 2B2' };
  const x = await mgr.createPerson('Lou Sand', at);
  const y = await mgr.createPerson('Lou Sand', at);
  ok(await mgr.action('person.notDuplicate', { a: x.id, b: y.id }));
  await cheque(x, 70000, '2026-06-01');
  await cheque(y, 70000, '2026-06-02');
  const n = await mgr.createPerson('Lou Sand', { email: 'lou.sand@example.org', postal: 'V3Y2B2' });
  assert.equal((await cheque(n, 10000, '2026-06-03')).flagged, false, 'N is X or Y, never both: $800 at most');
  const q3 = await mgr.createPerson('Lou Sand', at);
  assert.equal((await cheque(q3, 30000, '2026-06-04')).flagged, false, 'with X (or Y) and N: $1,100 at most');
  const over = await cheque(n, 40000, '2026-06-05');
  assert.match(over.flag_reason ?? '', /^Possibly the same donor as Lou Sand \(same postal code\) and Lou Sand \(same postal code\): together they are at \$1,500\.00 for 2026/);
  assert.deepEqual(over.maybe_same_donor, [x.id, q3.id], 'the most they can be together, named: X and the third, never Y beside X');
  // Ruled apart after the flag (People → Duplicates): added up again the same way.
  const x2 = await mgr.createPerson('Ana Sand', { address: '3 Sand Rd', postal: 'V3Y 2B3' });
  const y2 = await mgr.createPerson('Ana Sand', { address: '3 Sand Rd', postal: 'V3Y 2B3' });
  await cheque(x2, 70000, '2026-06-06');
  await cheque(y2, 70000, '2026-06-07');
  const n2 = await mgr.createPerson('Ana Sand', { email: 'ana.sand@example.org', postal: 'V3Y 2B3' });
  const g2 = await cheque(n2, 10000, '2026-06-08');
  assert.deepEqual(g2.maybe_same_donor, [x2.id, y2.id], '$1,500 while they may be one');
  const r = ok(await mgr.action('person.notDuplicate', { a: x2.id, b: y2.id }));
  assert.deepEqual(r.rechecked.map((g) => [g.id, g.flagged]), [[g2.id, false]], 'two people: N is $800 with either');
});

test('the most records can be together: a ruling says nothing of a third record, and past a dozen the search is bounded', async () => {
  const { mostTogether } = await import('../ext/payments/limits.js');
  const r = (id, cents) => ({ id, given_cents: cents });
  const apart = (...pairs) => new Set(pairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  // X ≠ Y and Y ≠ Z: X and Z may still be one donor.
  assert.deepEqual(mostTogether([r('x', 500), r('y', 800), r('z', 400), r('f', 100)], apart(['x', 'y'], ['y', 'z'])).map((o) => o.id), ['x', 'z', 'f']);
  // Twenty records, each ruled apart from the next: never two of a pair.
  const many = Array.from({ length: 20 }, (_, i) => r(`p${i}`, 1000 + i));
  const chain = apart(...many.slice(1).map((o, i) => [many[i].id, o.id]));
  const got = mostTogether(many, chain).map((o) => o.id);
  assert.ok(got.length >= 10 && got.every((id, i) => !got.slice(i + 1).some((o) => chain.has(`${id}|${o}`))), got.join(' '));
});

test('merge: a Not the same ruling on the record merged in stays with the record kept', async () => {
  const k = await mgr.createPerson('Kim Lee', { email: 'kim.lee@example.org', phone: '604-555-2222' });
  const d = await mgr.createPerson('Kim Lee', { phone: '604-555-2222', postal: 'V3X 1A1' });
  const c = await mgr.createPerson('Kim Lee', { postal: 'V3X 1A1' });
  await cheque(c, 100000, '2026-07-01');
  ok(await mgr.action('person.notDuplicate', { a: d.id, b: c.id }));
  assert.equal((await cheque(k, 30000, '2026-07-02')).flagged, false);
  assert.equal((await cheque(d, 20000, '2026-07-03')).flagged, false, 'C is someone else');
  const r = ok(await mgr.action('person.merge', { keep: k.id, drop: d.id }));
  assert.ok(r.filled.includes('postal'), 'K takes D’s postal code, which C has too');
  assert.deepEqual(r.flagged, [], 'C is still someone else: no maybe comes back');
  assert.ok(!(await pairsOf()).some(([nm]) => nm === 'Kim Lee + Kim Lee'), 'and Duplicates doesn’t list K with C');
  assert.equal((await cheque(k, 1000, '2026-07-04')).flagged, false, 'nor is a later gift flagged');
});

test('merge: a maybe the merge clears (the record merged in matched a third one the kept one doesn’t) is said, naming it', async () => {
  const v = await mgr.createPerson('Ph One', { phone: '604-555-1111', postal: 'V3T 6P6' });
  const e = await mgr.createPerson('Ph One', { email: 'ph.one@example.org', phone: '604-555-2222', postal: 'V3T 6P6' });
  const t = await mgr.createPerson('Ph One', { phone: '604-555-2222' });
  await cheque(v, 40000, '2026-03-01');
  await cheque(t, 60000, '2026-03-15');
  const m = await cheque(e, 50000, '2026-04-01');
  assert.deepEqual(m.maybe_same_donor, [v.id, t.id]);
  const r = ok(await mgr.action('person.merge', { keep: v.id, drop: e.id }));
  assert.equal((await giftNow(m.id)).flagged, false, 'V keeps its own phone: T no longer matches');
  assert.deepEqual(r.cleared, [{ gift_id: m.id, person_id: t.id, name: 'Ph One', shares: 'phone' }], 'the answer says which');
  assert.equal(mergedSaid('Ph One', r), '✓ Ph One: one record — no longer flagged as possibly the same donor as Ph One (same phone): check that record');
});

test('a gift voided: the maybes that added it up are added up again without it — re-totalled, then cleared', async () => {
  const at = { address: '2 Moe Rd', postal: 'V3V 2M2' };
  const r1 = await mgr.createPerson('Moe Twice', at);
  const r3 = await mgr.createPerson('Moe Twice', at);
  const r2 = await mgr.createPerson('Moe Twice', { email: 'moe.twice@example.org', postal: 'V3V 2M2' });
  const g1 = await cheque(r1, 40000, '2026-12-04');
  const g3 = await cheque(r3, 100000, '2026-12-04');
  assert.equal(g3.flagged, false, '$1,400 with R1: under');
  const g2 = await cheque(r2, 50000, '2026-12-05');
  assert.match(g2.flag_reason, /together they are at \$1,900\.00/);
  const voided = ok(await mgr.action('gift.void', { id: g1.id }));
  const row = await briefRow(g2.id);
  assert.match(row?.flag_reason ?? '', /^Possibly the same donor as Moe Twice \(same postal code\): together they are at \$1,500\.00 for 2026/, 'without R1’s gift');
  assert.deepEqual(row.maybe_same_donor, [r3.id]);
  assert.deepEqual(voided.rechecked?.map((x) => x.id), [g2.id], 'the void’s answer says so');
  const { overLine, overOf } = await import('../../web/src/components/MoneyWords.js');
  assert.equal(overLine(overOf(row)), 'Maybe $70.30 over the $1,429.70 limit', 'what Needs you says');
  ok(await mgr.action('gift.void', { id: g3.id }));
  assert.deepEqual([(await giftNow(g2.id)).flagged, await briefRow(g2.id)], [false, undefined], 'nothing left to add up: cleared, off Needs you');
  // Back in the books: the restored gift is the one that crosses.
  const back = ok(await mgr.action('gift.restore', { id: g3.id }));
  assert.match(back.flag_reason ?? '', /^Possibly the same donor as Moe Twice \(same postal code\): together they are at \$1,500\.00/);
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
