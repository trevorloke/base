// Relationships: who knows whom. A link is undirected and deduped (either way
// round, twice, or replayed from the phone's outbox, it is one link); a
// volunteer keeps "My people" — only their own, through the volunteer rule —
// and adds someone they know (matched by the dedupe rules, else added and
// "brought in" by them); the desk reads a profile's Knows (with a nudge) and
// Most connected. A talk in person is a contact like any other. The sample
// campaign has links, and Clear sample data takes them (yours stay).
// A tie can be close (relationship.update changes it, its kind or its note);
// the desk reads the key ties of up to 20 people at once; People, lists and
// sends can pick "knows a supporter / a donor / a volunteer / anyone /
// this person" — never for a volunteer, never past the People area.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { personsWhere } from '../lib/audience.js';
import { permsOf } from '../lib/perms.js';
import { whereFor, loadList } from '../ext/lists/audience.js';
import { api as relApi } from '../ext/relationships/api.js';

const tag = Math.random().toString(36).slice(2, 8);
let desk, vol, vol2, other, ws;
const P = {};

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const asVolunteer = async (client, name, email) => {
  const v = await client.signup({ name, workspaceName: `Temp ${tag}`, email });
  const db = await getDb();
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [v.json.user.id, ws, 'volunteer']);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [v.json.user.id, ws]);
  return v.json.user;
};
const add = (client, input) => client.action('relationship.add', input);
const knowsOf = async (id) => ok(await desk.get(`/api/persons/${id}/knows`));
const linkCount = async (a, b) => (await (await getDb()).query(
  `select count(*)::int as n from relationships where workspace_id = $1
     and person_a = least($2::uuid, $3::uuid) and person_b = greatest($2::uuid, $3::uuid)`,
  [ws, a, b],
)).rows[0].n;

before(async () => {
  await freshDb();
  desk = new Client();
  const r = await desk.signup({ name: 'Riley Desk', workspaceName: `Relationships WS ${tag}`, email: `rel-desk+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  vol = new Client();
  await asVolunteer(vol, 'Priya Volunteer', `rel-vol+${tag}@example.org`);
  vol2 = new Client();
  await asVolunteer(vol2, 'Sam Volunteer', `rel-vol2+${tag}@example.org`);
  other = new Client();
  await other.signup({ workspaceName: `Other ${tag}`, email: `rel-other+${tag}@example.org` });

  P.ana = await desk.createPerson('Ana Example', { phone: '604-555-0130', email: `ana+${tag}@example.org`, tags: ['donor-prospect', 'VIP'] });
  P.ben = await desk.createPerson('Ben Example', { phone: '604-555-0131' });
  P.cy = await desk.createPerson('Cy Example', { phone: '604-555-0132' });
  P.dee = await desk.createPerson('Dee Example', { phone: '604-555-0133' });
});

test('a link is undirected and deduped: either way round, or twice, it is the same link', async () => {
  const first = ok(await add(desk, { from_id: P.ana.id, person_id: P.ben.id, kind: 'friend' }));
  assert.equal(first.relationship.kind, 'friend');
  assert.equal(first.person.id, P.ben.id);
  assert.ok(!first.duplicate);

  const back = ok(await add(desk, { from_id: P.ben.id, person_id: P.ana.id }));
  assert.equal(back.duplicate, true, 'B knows A is A knows B');
  assert.equal(back.relationship.id, first.relationship.id);
  assert.equal(back.relationship.kind, 'friend', 'no kind given: the kind stays');
  const again = ok(await add(desk, { from_id: P.ana.id, person_id: P.ben.id, kind: 'work', note: 'Same office' }));
  assert.equal(again.duplicate, true);
  assert.equal(again.relationship.id, first.relationship.id);
  assert.equal(again.relationship.kind, 'work', 'adding it again with a new kind takes the kind');
  assert.equal(await linkCount(P.ana.id, P.ben.id), 1, 'one row for the pair');

  const ana = await knowsOf(P.ana.id);
  const ben = await knowsOf(P.ben.id);
  assert.deepEqual(ana.knows.map((k) => k.person.name), ['Ben Example']);
  assert.deepEqual(ben.knows.map((k) => k.person.name), ['Ana Example']);
  assert.equal(ana.knows[0].note, 'Same office');

  assert.equal((await add(desk, { from_id: P.ana.id, person_id: P.ana.id })).status, 400, 'nobody knows themselves here');
  assert.equal((await add(desk, { from_id: P.ana.id, person_id: randomUUID() })).status, 404);
  assert.equal((await add(desk, { from_id: P.ana.id, person_id: P.ben.id, kind: 'pen-pal' })).status, 400, 'kinds are the six');
  assert.equal((await add(desk, { from_id: P.ana.id })).status, 400, 'someone to know is needed');
  assert.equal((await add(desk, { from_id: P.ana.id, person_id: P.ben.id, person: { name: 'X', phone: '604-555-0199' } })).status, 400, 'one or the other');
});

test('a replay with the phone-made id is the same link — even after it was removed', async () => {
  const id = randomUUID();
  const made = ok(await add(desk, { id, from_id: P.cy.id, person_id: P.dee.id, kind: 'neighbour' }));
  assert.equal(made.relationship.id, id);
  const replay = ok(await add(desk, { id, from_id: P.cy.id, person_id: P.dee.id, kind: 'neighbour' }));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.relationship.id, id);
  assert.equal(await linkCount(P.cy.id, P.dee.id), 1);

  const gone = ok(await desk.action('relationship.remove', { id }));
  assert.equal(gone.removed, true);
  assert.equal(ok(await desk.action('relationship.remove', { id })).duplicate, true, 'removing twice is one removal');
  assert.deepEqual((await knowsOf(P.cy.id)).knows, [], 'removed: off the profile');
  const late = ok(await add(desk, { id, from_id: P.cy.id, person_id: P.dee.id, kind: 'neighbour' }));
  assert.equal(late.duplicate, true, 'a late replay of the add does not bring it back');
  assert.equal(late.relationship.removed, true);
  assert.deepEqual((await knowsOf(P.cy.id)).knows, []);

  const fresh = ok(await add(desk, { from_id: P.dee.id, person_id: P.cy.id, kind: 'friend' }));
  assert.ok(!fresh.duplicate, 'added again on purpose: a new link');
  assert.notEqual(fresh.relationship.id, id);
  assert.deepEqual((await knowsOf(P.cy.id)).knows.map((k) => k.kind), ['friend']);

  // Someone else's id (another campaign's) is never this campaign's link.
  const o1 = await other.createPerson('Other One');
  const o2 = await other.createPerson('Other Two');
  const theirs = ok(await add(other, { from_id: o1.id, person_id: o2.id })).relationship.id;
  assert.equal((await add(desk, { id: theirs, from_id: P.cy.id, person_id: P.ana.id })).status, 409);
  assert.equal((await other.get(`/api/persons/${P.ana.id}/knows`)).status, 404, 'another campaign cannot read this one');
});

test('a volunteer adds someone they know: matched by the dedupe rules, else added and brought in by them', async () => {
  const empty = ok(await vol.get('/api/relationships/mine'));
  assert.deepEqual(empty, { me: null, people: [] }, 'no record of their own yet: nobody');

  const r1 = ok(await add(vol, { person: { name: 'Rowan Example', phone: '604-555-0140', email: `rowan+${tag}@example.org` }, kind: 'neighbour' }));
  assert.equal(r1.created_person, true);
  assert.equal(r1.person.name, 'Rowan Example');
  assert.equal(r1.person.email, null, 'the email they typed is not handed back');
  P.rowan = r1.person;
  const mine = ok(await vol.get('/api/relationships/mine'));
  assert.equal(mine.me.name, 'Priya Volunteer', 'their own record, made on the first add');
  P.priya = mine.me;
  assert.deepEqual(mine.people.map((x) => [x.person.name, x.kind, x.brought_in]), [['Rowan Example', 'neighbour', true]]);
  const db = await getDb();
  const self = (await db.query('select tags, email from persons where id = $1', [P.priya.id])).rows[0];
  assert.deepEqual(self.tags, ['volunteer']);
  assert.equal(self.email, `rel-vol+${tag}@example.org`);
  const rowan = await knowsOf(P.rowan.id);
  assert.deepEqual(rowan.brought_in_by, { id: P.priya.id, name: 'Priya Volunteer' }, 'Brought in by Priya');
  const stored = (await db.query('select email, phone from persons where id = $1', [P.rowan.id])).rows[0];
  assert.deepEqual(stored, { email: `rowan+${tag}@example.org`, phone: '604-555-0140' }, 'kept for the desk');

  const again = ok(await add(vol, { person: { name: '  rowan   EXAMPLE ', phone: '+1 (604) 555-0140' }, kind: 'friend' }));
  assert.equal(again.person.id, P.rowan.id, 'same name + same phone digits: the same person');
  assert.equal(again.duplicate, true, '…and the same link');
  assert.equal((await db.query(`select count(*)::int as n from persons where workspace_id = $1 and lower(name) like 'rowan%'`, [ws])).rows[0].n, 1);

  const ben = ok(await add(vol, { person: { name: 'Ben Example', phone: '604 555 0131' }, kind: 'work' }));
  assert.equal(ben.person.id, P.ben.id, 'someone already on the list is linked, not added again');
  assert.equal(ben.matched, true);
  assert.equal(ben.created_person, false);
  assert.equal((await knowsOf(P.ben.id)).brought_in_by, null, 'already on the list: nobody brought them in');

  // A bare email never matches for a volunteer: it would tell them whose it is.
  const stranger = await add(vol, { person: { name: 'Someone Else', email: `ana+${tag}@example.org` }, kind: 'other' });
  ok(stranger);
  assert.notEqual(stranger.json.person.id, P.ana.id);
  assert.equal(stranger.json.person.name, 'Someone Else');
  assert.ok(!JSON.stringify(stranger.json).includes('Ana'), 'nothing of Ana comes back');
  const typed = (await db.query('select email, attrs from persons where id = $1', [stranger.json.person.id])).rows[0];
  assert.equal(typed.email, null, 'Ana’s email is not handed to a second person');
  assert.deepEqual(typed.attrs, { typed_email: `ana+${tag}@example.org`, maybe_same_as: P.ana.id }, 'kept for the desk: what was typed, who it may be');
  // The desk matches on the email alone (the import's rule).
  const deskMatch = ok(await add(desk, { from_id: P.dee.id, person: { name: 'A. Example', email: `ANA+${tag}@example.org` } }));
  assert.equal(deskMatch.person.id, P.ana.id);

  assert.equal((await add(vol, { person: { name: 'No Way To Reach' }, kind: 'friend' })).status, 400, 'a phone or an email');
  assert.equal((await add(vol, { person: { name: 'Bad Email', email: 'not-an-email' } })).status, 400);
});

test('a volunteer’s guess at someone’s email tells them nothing, and the new person never takes an email someone has', async () => {
  const db = await getDb();
  P.eve = await desk.createPerson('Eve Example', { phone: '604-555-0134', email: `eve+${tag}@example.org` });
  // Eve's right email and a wrong one: the same answer, a new person each time.
  const right = ok(await add(vol, { person: { name: 'Eve Example', email: `eve+${tag}@example.org` }, kind: 'friend' }));
  const wrong = ok(await add(vol, { person: { name: 'Eve Example', email: `eve.wrong+${tag}@example.org` }, kind: 'friend' }));
  const shape = (r) => ({
    matched: r.matched, created_person: r.created_person, duplicate: Boolean(r.duplicate), brought_in: r.relationship.brought_in === r.person.id,
    person: { ...r.person, id: null },
  });
  assert.deepEqual(shape(right), shape(wrong), 'nothing in the answer says which guess was right');
  assert.equal(right.matched, false);
  assert.notEqual(right.person.id, P.eve.id, 'not linked to Eve');
  const mine = ok(await vol.get('/api/relationships/mine')).people.filter((x) => x.person.name === 'Eve Example');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((x) => x.brought_in && x.person.phone === null && x.person.email === null), 'My people shows them alike');
  const row = async (id) => (await db.query('select email, attrs from persons where id = $1', [id])).rows[0];
  const r1 = await row(right.person.id);
  assert.equal(r1.email, null, 'Eve’s email stays Eve’s: nothing keyed by email reaches it under this record');
  assert.deepEqual(r1.attrs, { typed_email: `eve+${tag}@example.org`, maybe_same_as: P.eve.id });
  const r2 = await row(wrong.person.id);
  assert.equal(r2.email, `eve.wrong+${tag}@example.org`, 'an email nobody has is kept');
  assert.equal(r2.attrs.maybe_same_as, P.eve.id, 'same name: may be Eve too');

  // The desk is told, on both profiles.
  assert.deepEqual((await knowsOf(right.person.id)).same_as, [{ id: P.eve.id, name: 'Eve Example' }]);
  assert.deepEqual((await knowsOf(P.eve.id)).same_as.map((x) => x.id), [right.person.id, wrong.person.id]);
  assert.deepEqual((await knowsOf(P.ben.id)).same_as, [], 'nobody doubled: nothing said');

  // The same name and typed email again, from the same volunteer: that one person, not a third.
  const again = ok(await add(vol, { person: { name: ' eve  EXAMPLE', email: `EVE+${tag}@example.org` }, kind: 'work' }));
  assert.equal(again.person.id, right.person.id);
  assert.equal(again.duplicate, true, '…and the same link');
  assert.equal((await db.query(`select count(*)::int as n from persons where workspace_id = $1 and name = 'Eve Example'`, [ws])).rows[0].n, 3);
  // Another volunteer's guess never finds what someone else typed: right or wrong, the same answer.
  const theirRight = ok(await add(vol2, { person: { name: 'Eve Example', email: `eve+${tag}@example.org` }, kind: 'work' }));
  const theirWrong = ok(await add(vol2, { person: { name: 'Eve Example', email: `eve.wrong+${tag}@example.org` }, kind: 'work' }));
  assert.deepEqual(shape(theirRight), shape(theirWrong), 'nothing says another volunteer typed it before');
  assert.equal(theirRight.matched, false);
  assert.equal(theirRight.created_person, true);
  assert.ok(![P.eve.id, right.person.id, wrong.person.id].includes(theirRight.person.id), 'not linked to Eve or to Priya’s adds');
  assert.ok(![P.eve.id, right.person.id, wrong.person.id].includes(theirWrong.person.id));
  assert.equal((await row(theirRight.person.id)).email, null, 'still nobody else holds Eve’s email');
  assert.equal((await row(theirWrong.person.id)).email, null, '…nor the email Priya typed');
  // Their own add again does find their own: not a fifth.
  const theirAgain = ok(await add(vol2, { person: { name: 'Eve Example', email: `eve+${tag}@example.org` }, kind: 'work' }));
  assert.equal(theirAgain.person.id, theirRight.person.id);
  assert.equal(theirAgain.duplicate, true);
  assert.equal((await db.query(`select count(*)::int as n from persons where workspace_id = $1 and name = 'Eve Example'`, [ws])).rows[0].n, 5);
  // Their own email is theirs to know: that's them.
  const me = await add(vol, { person: { name: 'Not Me', email: `REL-VOL+${tag}@example.org` }, kind: 'friend' });
  assert.equal(me.status, 400);
  assert.match(me.json.error, /that’s you/);
  // A volunteer's name + email no longer finds someone: name + phone still does.
  const byPhone = ok(await add(vol, { person: { name: 'Eve Example', phone: '604 555 0134', email: `eve+${tag}@example.org` }, kind: 'friend' }));
  assert.equal(byPhone.person.id, P.eve.id, 'name + phone: Eve herself');
  for (const id of [right.relationship.id, wrong.relationship.id, byPhone.relationship.id]) ok(await vol.action('relationship.remove', { id }));
  for (const id of [theirRight.relationship.id, theirWrong.relationship.id]) ok(await vol2.action('relationship.remove', { id }));
});

test('a volunteer sees and changes only their own people', async () => {
  const theirs = ok(await vol2.get('/api/relationships/mine'));
  assert.deepEqual(theirs.people, [], 'another volunteer sees none of Priya’s people');
  assert.equal((await add(vol, { from_id: P.ana.id, person_id: P.cy.id })).status, 403, 'only their own people');
  const deskLink = (await knowsOf(P.ana.id)).knows.find((k) => k.person.id === P.ben.id);
  assert.equal((await vol.action('relationship.remove', { id: deskLink.id })).status, 404, 'someone else’s link is not there for them');
  assert.equal((await vol2.action('relationship.remove', { id: (await vol.get('/api/relationships/mine')).json.people[0].id })).status, 404);
  // A replayed id of someone else's link is not theirs to read.
  assert.equal((await add(vol, { id: deskLink.id, person_id: P.cy.id })).status, 409);
  for (const path of [`/api/persons/${P.ana.id}/knows`, '/api/relationships/connected']) {
    assert.equal((await vol.get(path)).status, 403, `volunteers cannot read ${path}`);
  }
  const mine = ok(await vol.get('/api/relationships/mine'));
  const stranger = mine.people.find((x) => x.person.name === 'Someone Else');
  ok(await vol.action('relationship.remove', { id: stranger.id }));
  const after = ok(await vol.get('/api/relationships/mine'));
  assert.ok(!after.people.some((x) => x.person.name === 'Someone Else'), 'removed from My people');
  assert.equal(after.people.length, mine.people.length - 1);
});

test('My people goes through the volunteer rule: no one else’s email, no money tags', async () => {
  const r = ok(await add(vol, { person_id: P.ana.id, kind: 'community' }));
  assert.equal(r.person.email, null);
  assert.deepEqual(r.person.tags, ['VIP'], 'donor-prospect is never sent to a volunteer');
  const raw = JSON.stringify(ok(await vol.get('/api/relationships/mine')));
  assert.ok(!raw.includes(`ana+${tag}`) && !raw.includes(`rowan+${tag}`), 'no one else’s email anywhere');
  assert.ok(!raw.includes('donor'), 'no money tags anywhere');
  const ana = ok(await vol.get('/api/relationships/mine')).people.find((x) => x.person.id === P.ana.id);
  assert.equal(ana.person.phone, '604-555-0130', 'their phone, to call them');
  // The desk sees the person whole.
  const deskSees = ok(await desk.get(`/api/persons/${P.ana.id}`)).person;
  assert.ok(deskSees.tags.includes('donor-prospect'));
});

test('in person: a talk with someone you know is a contact like any other', async () => {
  const b0 = ok(await vol.get('/api/brief'));
  const before = b0.field;
  const r = ok(await vol.action('contact.log', { person_id: P.ana.id, channel: 'in_person', outcome: 'contacted', rating: '2' }));
  assert.equal(r.contact.channel, 'in_person');
  const b1 = ok(await vol.get('/api/brief'));
  const after = b1.field;
  assert.deepEqual(b1.inPerson, { week: b0.inPerson.week + 1, mine: 1 }, 'in person this week: the team’s and theirs');
  assert.deepEqual(Object.keys(after.mine).sort(), ['calls', 'doors', 'lit', 'texts'], 'the core’s own counts keep their shape');
  assert.equal(after.week, before.week + 1, 'every contact counts in the week');
  assert.equal(after.doors, before.doors, 'a talk in person is not a door knocked');
  assert.equal(after.calls, before.calls);
  assert.equal(after.texts, before.texts);
  assert.equal(ok(await desk.get(`/api/persons/${P.ana.id}`)).person.rating, '2');
  assert.equal(ok(await desk.get(`/api/persons/${P.ana.id}`)).contacts[0].channel, 'in_person');
  const ana = ok(await vol.get('/api/relationships/mine')).people.find((x) => x.person.id === P.ana.id);
  assert.ok(ana.last_at, 'My people shows when you last talked');
  assert.equal((await vol.action('contact.log', { person_id: P.ana.id, channel: 'pigeon', outcome: 'contacted' })).status, 400);
  // Today: "My people · N".
  const brief = ok(await vol.get('/api/brief'));
  assert.equal(brief.myPeople, ok(await vol.get('/api/relationships/mine')).people.length);
  assert.equal(ok(await vol2.get('/api/brief')).myPeople, 0);
});

test('Most connected: how many people each knows, and how many of them are supporters', async () => {
  const mk = (n, extra = {}) => desk.createPerson(`${n} Hub`, { phone: `604-555-01${String(50 + Object.keys(P).length).slice(-2)}`, ...extra });
  P.hub = await mk('Hana');
  P.s1 = await mk('Ivo');
  P.s2 = await mk('Jo');
  P.u = await mk('Kit');
  P.n = await mk('Lee');
  const rate = (p, rating) => desk.action('contact.log', { person_id: p.id, channel: 'phone', outcome: 'contacted', rating });
  ok(await rate(P.s1, '1'));
  ok(await rate(P.s2, '2'));
  ok(await rate(P.u, '3'));
  for (const p of [P.s1, P.s2, P.u, P.n]) ok(await add(desk, { from_id: P.hub.id, person_id: p.id, kind: 'community' }));
  const gone = ok(await add(desk, { from_id: P.hub.id, person_id: P.cy.id })).relationship.id;
  ok(await desk.action('relationship.remove', { id: gone }));

  const list = ok(await desk.get('/api/relationships/connected')).people;
  const hub = list.find((x) => x.id === P.hub.id);
  assert.deepEqual({ knows: hub.knows, supporters: hub.supporters }, { knows: 4, supporters: 2 }, 'a removed link does not count');
  assert.equal(list[0].id, P.hub.id, 'most connected first');
  const s1 = list.find((x) => x.id === P.s1.id);
  assert.deepEqual({ knows: s1.knows, supporters: s1.supporters }, { knows: 1, supporters: 0 }, 'Hana is not rated: not a supporter');
  for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1].knows >= list[i].knows, 'sorted by how many they know');
  assert.ok(!list.some((x) => x.id === P.cy.id && x.knows > 1));
  // The nudge: an undecided voter, and a supporter who knows them.
  const kit = await knowsOf(P.u.id);
  assert.equal(kit.nudge, null, 'Kit only knows Hana, who is not rated');
  ok(await add(desk, { from_id: P.u.id, person_id: P.s2.id, kind: 'friend' }));
  ok(await add(desk, { from_id: P.u.id, person_id: P.s1.id, kind: 'friend' }));
  assert.deepEqual((await knowsOf(P.u.id)).nudge, { id: P.s1.id, name: 'Ivo Hub' }, 'a strong yes first');
  assert.deepEqual((await knowsOf(P.n.id)).nudge, null, 'Lee (not rated) knows only Hana (not rated)');
  ok(await add(desk, { from_id: P.n.id, person_id: P.s2.id, kind: 'work' }));
  assert.deepEqual((await knowsOf(P.n.id)).nudge, { id: P.s2.id, name: 'Jo Hub' }, 'not rated yet: nudged too');
  assert.equal((await knowsOf(P.s2.id)).nudge, null, 'a supporter needs no nudge');
  // Do not contact: no nudge to reach them, and never through a supporter who asked not to be contacted.
  ok(await desk.action('person.update', { id: P.u.id, tags: ['do-not-contact'] }));
  assert.equal((await knowsOf(P.u.id)).nudge, null, 'Kit asked not to be contacted');
  ok(await desk.action('person.update', { id: P.u.id, tags: [] }));
  ok(await desk.action('person.update', { id: P.s1.id, tags: ['do-not-contact'] }));
  assert.deepEqual((await knowsOf(P.u.id)).nudge, { id: P.s2.id, name: 'Jo Hub' }, 'Ivo asked not to be contacted: Jo instead');
  ok(await desk.action('person.update', { id: P.s2.id, tags: ['do-not-contact'] }));
  assert.equal((await knowsOf(P.u.id)).nudge, null, 'no supporter left to ask');
  ok(await desk.action('person.update', { id: P.s1.id, tags: [] }));
  ok(await desk.action('person.update', { id: P.s2.id, tags: [] }));
});

test('a desk member’s own record is tagged volunteer, as Count me in tags it — whichever they did first', async () => {
  const m = new Client();
  await m.signup({ name: 'Tia Staff', workspaceName: `Rel Self ${tag}`, email: `rel-self+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ok(await add(m, { person: { name: 'Uma Example', phone: '604-555-0135' }, kind: 'friend' }));
  const me = ok(await m.get('/api/relationships/mine')).me;
  const db = await getDb();
  assert.deepEqual((await db.query('select tags from persons where id = $1', [me.id])).rows[0].tags, ['volunteer']);
  const tagged = ok(await m.get('/api/persons?tag=volunteer')).persons.map((p) => p.id);
  assert.deepEqual(tagged, [me.id]);
});

test('the export carries every link, removed ones too, and every write is on the hash chain', async () => {
  const exp = ok(await desk.get('/api/export'));
  assert.ok(Array.isArray(exp.relationships));
  const db = await getDb();
  const all = (await db.query('select id from relationships where workspace_id = $1', [ws])).rows.map((r) => r.id).sort();
  assert.deepEqual(exp.relationships.map((r) => r.id).sort(), all);
  assert.ok(exp.relationships.some((r) => r.removed_at), 'removed links are in the books');
  assert.ok(exp.relationships.every((r) => r.workspace_id === ws), 'only this campaign');
  assert.equal((await vol.get('/api/export')).status, 403);

  const evs = (await db.query(
    `select action, op from events where workspace_id = $1 and entity_type = 'relationship' order by seq`, [ws],
  )).rows;
  assert.ok(evs.some((e) => e.op === 'create') && evs.some((e) => e.op === 'update') && evs.some((e) => e.op === 'void'));
  assert.ok(evs.every((e) => e.action.startsWith('relationship.')));
  const brought = (await db.query(
    `select payload from events where workspace_id = $1 and entity_type = 'person' and op = 'create' and entity_id = $2`, [ws, P.rowan.id],
  )).rows[0];
  assert.equal(brought.payload.brought_in_by, P.priya.id, 'the new person is on the log, brought in by Priya');
  assert.equal(ok(await desk.get('/api/audit/verify')).ok, true);
});

test('the sample: Priya’s people, a nudge, "Brought in by" — and Clear sample data takes the sample’s links, yours stay', async () => {
  const m = new Client();
  await m.signup({ name: 'Sample Manager', workspaceName: `Rel Sample ${tag}`, email: `rel-sample+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ok(await m.post('/api/data/sample', {}));
  const named = async (n) => ok(await m.get(`/api/persons?q=${encodeURIComponent(n)}`)).persons.find((p) => p.name === n);
  const connected = ok(await m.get('/api/relationships/connected')).people;
  const priya = connected.find((p) => p.name === 'Priya Nair');
  assert.equal(priya.knows, 6, 'a sample volunteer with six people');
  assert.equal(connected[0].name, 'Priya Nair', 'the most connected');
  const jasmine = await named('Jasmine Wong');
  const jk = ok(await m.get(`/api/persons/${jasmine.id}/knows`));
  assert.deepEqual(jk.knows.map((k) => [k.person.name, k.kind, k.note]), [['Priya Nair', 'neighbour', 'Same block']]);
  if (jasmine.rating == null || jasmine.rating === '3') assert.deepEqual(jk.nudge, { id: priya.id, name: 'Priya Nair' });
  const sofia = await named('Sofia Petrova');
  assert.equal(ok(await m.get(`/api/persons/${sofia.id}/knows`)).brought_in_by.name, 'Priya Nair');

  // Yours: a link between two sample people, and one to someone of your own.
  const tom = await named('Tom Riley');
  const ana = await named('Ana Souza');
  const mine = await m.createPerson('Real Friend', { phone: '604-555-0188' });
  ok(await add(m, { from_id: tom.id, person_id: ana.id, kind: 'friend' }));
  ok(await add(m, { from_id: mine.id, person_id: tom.id, kind: 'neighbour' }));

  const clear = ok(await m.req('DELETE', '/api/data/sample'));
  assert.match(clear.message, /Kept 2 sample people with your own records on them \(2 connections\)/);
  assert.equal(clear.removed.relationships, 16, 'the sample’s own links go');
  const left = ok(await m.get('/api/relationships/connected')).people.map((p) => [p.name, p.knows]).sort();
  assert.deepEqual(left, [['Ana Souza', 1], ['Real Friend', 1], ['Tom Riley', 2]]);
  const db = await getDb();
  const W = (await m.get('/api/auth/me')).json.workspace.id;
  const voids = (await db.query(
    `select count(*)::int as n from events where workspace_id = $1 and action = 'sample.clear' and entity_type = 'relationship' and op = 'void'`, [W],
  )).rows[0].n;
  assert.equal(voids, 16, 'each sample link leaves the books with an event');
  assert.equal(ok(await m.get('/api/audit/verify')).ok, true);
});

test('the sample again after a clear: Priya Nair stays one person and knows her six again', async () => {
  const m = new Client();
  const su = await m.signup({ name: 'Reload Manager', workspaceName: `Rel Reload ${tag}`, email: `rel-reload+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  const W = su.json.workspace.id;
  ok(await m.post('/api/data/sample', {}));
  // The sample's volunteer signs in with the sample's email.
  const priya = new Client();
  const u = await priya.signup({ name: 'Priya Nair', workspaceName: `Temp Priya ${tag}`, email: 'priya.nair@example.org' });
  const db = await getDb();
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [u.json.user.id, W, 'volunteer']);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [u.json.user.id, W]);
  const first = ok(await priya.get('/api/relationships/mine'));
  assert.equal(first.people.length, 6);
  const six = first.people.map((x) => x.person.name).sort();
  // Hers: someone new, and a talk with Daniel Kim (a sample voter, no email).
  ok(await add(priya, { person: { name: 'Robin Offline', phone: '604-555-0189' }, kind: 'friend' }));
  const daniel = first.people.find((x) => x.person.name === 'Daniel Kim').person;
  ok(await priya.action('contact.log', { person_id: daniel.id, channel: 'in_person', outcome: 'contacted', rating: '1' }));

  const clear = ok(await m.req('DELETE', '/api/data/sample'));
  assert.match(clear.message, /Kept 2 sample people/);
  ok(await m.post('/api/data/sample', {}));
  const named = async (n) => ok(await m.get(`/api/persons?q=${encodeURIComponent(n)}&limit=50`)).persons.filter((p) => p.name === n);
  assert.deepEqual((await named('Priya Nair')).map((p) => p.id), [first.me.id], 'one Priya Nair: the one she signs in as');
  assert.deepEqual((await named('Daniel Kim')).map((p) => p.id), [daniel.id], 'kept by her talk: used again, not added twice');
  assert.equal((await named('Jasmine Wong')).length, 1);
  const mine = ok(await priya.get('/api/relationships/mine'));
  assert.equal(mine.me.id, first.me.id);
  assert.deepEqual(mine.people.map((x) => x.person.name).sort(), [...six, 'Robin Offline'].sort(), 'her six again, and hers');
  assert.equal(ok(await priya.get('/api/brief')).myPeople, 7);
  const connected = ok(await m.get('/api/relationships/connected')).people.filter((p) => p.name === 'Priya Nair');
  assert.deepEqual(connected.map((p) => [p.id, p.knows]), [[first.me.id, 7]]);
  const emails = (await db.query(
    `select lower(email) as e, count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and email is not null
     group by 1 having count(*) > 1`, [W],
  )).rows;
  assert.deepEqual(emails, [], 'no email on two people');

  // Clear again: those two aren't the sample's this time — they stay; the sample's links and roles on them go.
  ok(await m.req('DELETE', '/api/data/sample'));
  assert.deepEqual(ok(await priya.get('/api/relationships/mine')).people.map((x) => x.person.name), ['Robin Offline']);
  assert.equal((await named('Daniel Kim')).length, 1);
  assert.deepEqual((await db.query('select role from volunteer_roles where workspace_id = $1 and person_id = $2', [W, first.me.id])).rows, []);
  assert.equal(ok(await m.get('/api/audit/verify')).ok, true);
});

// ── Close ties, relationship.update, the key read and the knows= rule ──

const events = async (id) => (await (await getDb()).query(
  `select op, payload from events where workspace_id = $1 and entity_type = 'relationship' and entity_id = $2 order by seq`, [ws, id],
)).rows;
const update = (client, input) => client.action('relationship.update', input);
const invite = async (role, deny = [], grant = []) => {
  const inv = ok(await desk.action('member.invite', { email: `rel-${role}-${deny.join('')}${grant.join('')}-${randomUUID().slice(0, 6)}@example.org`, role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'ties-pass-2026' }));
  if (deny.length || grant.length) ok(await desk.action('permission.member.set', { user_id: j.user.id, grant, deny }));
  return c;
};

test('a tie can be close: on add, on update, and adding again never clears it; the create event carries it', async () => {
  const p1 = await desk.createPerson('Close One Example', { phone: '604-555-0161' });
  const p2 = await desk.createPerson('Close Two Example', { phone: '604-555-0162' });
  const made = ok(await add(desk, { from_id: p1.id, person_id: p2.id, kind: 'friend', close: true }));
  assert.equal(made.relationship.close, true);
  const id = made.relationship.id;
  assert.equal((await events(id))[0].payload.close, true, 'the create event says close');
  assert.equal((await knowsOf(p1.id)).knows[0].close, true, 'Knows says close');
  const again = ok(await add(desk, { from_id: p2.id, person_id: p1.id, kind: 'friend', close: false }));
  assert.equal(again.duplicate, true);
  assert.equal(again.relationship.close, true, 'adding again never un-marks a tie');
  const off = ok(await update(desk, { id, close: false }));
  assert.equal(off.relationship.close, false, 'close: false un-marks');
  assert.equal((await knowsOf(p1.id)).knows[0].close, false);
  const on = ok(await update(desk, { id, close: true }));
  assert.equal(on.relationship.close, true);
  const plain = ok(await add(desk, { from_id: p1.id, person_id: (await desk.createPerson('Close Three Example', { phone: '604-555-0163' })).id }));
  assert.equal(plain.relationship.close, false, 'a new link is not close unless said');
  assert.equal((await events(plain.relationship.id))[0].payload.close, false);
});

test('relationship.update: kind, note (blank clears it) and close — only what changes, on the hash chain', async () => {
  const p1 = await desk.createPerson('Upd One Example', { phone: '604-555-0164' });
  const p2 = await desk.createPerson('Upd Two Example', { phone: '604-555-0165' });
  const id = ok(await add(desk, { from_id: p1.id, person_id: p2.id, kind: 'work', note: 'Same office' })).relationship.id;
  const n0 = (await events(id)).length;
  assert.deepEqual(Object.keys(ok(await update(desk, { id }))).filter((k) => k !== 'seq'), ['duplicate'], 'nothing to change');
  assert.equal(ok(await update(desk, { id, kind: 'work', note: 'Same office', close: false })).duplicate, true, 'the same values again');
  assert.equal((await events(id)).length, n0, 'and no event');
  const k = ok(await update(desk, { id, kind: 'family' }));
  assert.deepEqual([k.relationship.kind, k.relationship.note], ['family', 'Same office'], 'what is not given stays');
  assert.deepEqual((await events(id)).at(-1), { op: 'update', payload: { kind: 'family' } }, 'the patch, only what changed');
  ok(await update(desk, { id, note: '' }));
  assert.equal((await knowsOf(p1.id)).knows[0].note, null, '"" clears the note');
  assert.deepEqual((await events(id)).at(-1).payload, { note: null });
  ok(await update(desk, { id, note: '  Choir  ' }));
  assert.equal((await knowsOf(p1.id)).knows[0].note, 'Choir');
  ok(await update(desk, { id, note: '   ' }));
  assert.equal((await (await getDb()).query('select note from relationships where id = $1', [id])).rows[0].note, null, 'only spaces clears it too');
  assert.equal((await update(desk, { id, kind: 'pen-pal' })).status, 400);
  assert.equal((await update(desk, { id, note: 'x'.repeat(201) })).status, 400);
  assert.equal((await update(desk, { id: randomUUID(), close: true })).status, 404);
  assert.equal((await update(other, { id, close: true })).status, 404, 'another campaign’s link is not there');

  // A volunteer changes only a link with their own record at one end.
  assert.equal((await update(vol, { id, close: true })).status, 404, 'someone else’s link is not there for them');
  const theirs = ok(await vol.get('/api/relationships/mine')).people[0];
  const mine = ok(await update(vol, { id: theirs.id, close: true, note: 'From choir' }));
  assert.deepEqual([mine.relationship.close, mine.relationship.note], [true, 'From choir']);
  const now = ok(await vol.get('/api/relationships/mine')).people.find((x) => x.id === theirs.id);
  assert.deepEqual([now.close, now.note], [true, 'From choir'], 'My people says close');
  // Removed: not found.
  ok(await desk.action('relationship.remove', { id }));
  assert.equal((await update(desk, { id, close: true })).status, 404, 'a removed link is not there');
  const evs = (await events(id)).map((e) => e.op);
  assert.deepEqual(evs, ['create', 'update', 'update', 'update', 'update', 'void']);
  assert.equal(ok(await desk.get('/api/audit/verify')).ok, true, 'every change on the hash chain');
});

test('"I know them" from a volunteer: a person on the list by id, replayed with the same id, is one link', async () => {
  const x = await desk.createPerson('Door Example', { phone: '604-555-0166' });
  const id = randomUUID();
  const r = ok(await add(vol, { id, person_id: x.id, kind: 'friend' }));
  assert.equal(r.relationship.id, id);
  const again = ok(await add(vol, { id, person_id: x.id, kind: 'friend' }));
  assert.equal(again.duplicate, true);
  assert.equal(await linkCount(P.priya.id, x.id), 1);
  assert.ok(ok(await vol.get('/api/relationships/mine')).people.some((p) => p.person.id === x.id && p.kind === 'friend'));
});

// The key read: the ties that matter for up to 20 people.
const K = {};
test('GET /relationships/key: the two ties that matter, how many in all, for up to 20 people', async () => {
  const mk = (n, ph) => desk.createPerson(`${n} Key`, { phone: `604-555-01${ph}` });
  K.hub = await mk('Hub', '70');
  K.close = await mk('Zed', '71');           // close, kind other, not rated
  K.yes = await mk('Yan', '72');             // a supporter, kind work
  K.fam = await mk('Fay', '73');             // family
  K.dnc = await mk('Dot', '74');             // close but do-not-contact
  K.lone = await mk('Lone', '75');
  K.gone = await mk('Gone', '76');
  ok(await desk.action('contact.log', { person_id: K.yes.id, channel: 'phone', outcome: 'contacted', rating: '1' }));
  ok(await desk.action('person.update', { id: K.dnc.id, tags: ['Do-Not-Contact'] }));
  ok(await add(desk, { from_id: K.hub.id, person_id: K.close.id, kind: 'other', close: true }));
  ok(await add(desk, { from_id: K.hub.id, person_id: K.yes.id, kind: 'work' }));
  ok(await add(desk, { from_id: K.hub.id, person_id: K.fam.id, kind: 'family' }));
  ok(await add(desk, { from_id: K.hub.id, person_id: K.dnc.id, kind: 'family', close: true }));
  ok(await add(desk, { from_id: K.gone.id, person_id: K.hub.id, kind: 'friend' }));
  await (await getDb()).query('update persons set deleted_at = now() where id = $1', [K.gone.id]);
  const theirs = await other.createPerson('Other Key');

  const ids = [K.hub.id, K.lone.id, K.gone.id, theirs.id, randomUUID(), K.yes.id];
  const r = ok(await desk.get(`/api/relationships/key?ids=${ids.join(',')}`));
  assert.deepEqual(Object.keys(r.ties).sort(), [K.hub.id, K.lone.id, K.yes.id].sort(), 'unknown, deleted and other campaigns’ people are absent');
  const hub = r.ties[K.hub.id];
  assert.equal(hub.n, 4, 'four live links to people on the list — do-not-contact counted, the deleted one not');
  assert.deepEqual(hub.top.map((t) => t.person.name), ['Zed Key', 'Yan Key'], 'close first, then a supporter; do-not-contact never named');
  assert.deepEqual(Object.keys(hub.top[0]).sort(), ['close', 'id', 'kind', 'person']);
  assert.deepEqual(hub.top[0].person, { id: K.close.id, name: 'Zed Key', rating: null });
  assert.equal(hub.top[0].close, true);
  assert.deepEqual(r.ties[K.lone.id], { n: 0, top: [] });
  assert.deepEqual(r.ties[K.yes.id].top.map((t) => t.person.id), [K.hub.id]);

  const many = Array.from({ length: 21 }, () => randomUUID()).join(',');
  assert.equal((await desk.get(`/api/relationships/key?ids=${many}`)).status, 400, '21 ids');
  assert.equal((await desk.get(`/api/relationships/key?ids=${many.split(',').slice(1).join(',')}`)).status, 200, '20 ids');
  assert.equal((await desk.get(`/api/relationships/key?ids=${K.hub.id},nope`)).status, 400, 'a bad id');
  assert.equal((await vol.get(`/api/relationships/key?ids=${K.hub.id}`)).status, 403, 'volunteers never read another person’s ties');
});

test('the desk reads are TIE_READERS’ and the People area’s; My people stays everyone’s', async () => {
  // A role outside TIE_READERS (as a candidate would be, until CAN says otherwise).
  const db = await getDb();
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('ctx', { workspaceId: ws, role: 'candidate', user: { id: randomUUID(), email: '' } }); c.set('db', db); await next(); });
  app.route('/', relApi);
  for (const path of [`/relationships/key?ids=${K.hub.id}`, '/relationships/connected', `/persons/${K.hub.id}/knows`]) {
    assert.equal((await app.request(path)).status, 403, `a candidate: ${path}`);
  }
  assert.equal((await app.request('/relationships/mine')).status, 200);

  const noPeople = await invite('staff', ['people']);
  assert.equal((await noPeople.get(`/api/relationships/key?ids=${K.hub.id}`)).status, 403);
  assert.equal((await noPeople.get('/api/relationships/connected')).status, 403);
  assert.equal((await noPeople.get(`/api/persons/${K.hub.id}/knows`)).status, 403);
  assert.equal((await noPeople.get('/api/relationships/mine')).status, 200, 'My people is in no area');
  const treasurer = await invite('treasurer');
  assert.equal((await treasurer.get(`/api/relationships/key?ids=${K.hub.id}`)).status, 200);
});

test('Most connected credits who someone brought in, removed links too; the order is unchanged', async () => {
  const r = ok(await add(desk, { from_id: K.fam.id, person: { name: 'Brought Example', phone: '604-555-0177' }, kind: 'friend' }));
  ok(await desk.action('relationship.remove', { id: r.relationship.id }));
  const list = ok(await desk.get('/api/relationships/connected')).people;
  assert.equal(list.find((x) => x.id === K.fam.id).brought_in, 1, 'brought in stays true when the link goes');
  assert.equal(list.find((x) => x.id === K.hub.id).brought_in, 0);
  const priya = list.find((x) => x.id === P.priya.id);
  assert.ok(priya.brought_in >= 1, 'Priya brought Rowan in');
  for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1].knows >= list[i].knows, 'still most links first');
});

test('knows=: supporter, donor, volunteer, any, person — never everybody, never for a volunteer, never past People', async () => {
  const mk = (n, extra = {}) => desk.createPerson(`${n} Knows`, { tags: ['kn'], ...extra });
  const T = { a: await mk('Ava'), b: await mk('Bo'), c: await mk('Cal'), d: await mk('Dev'), e: await mk('Eli'), f: await mk('Flo'), g: await mk('Gus') };
  const S = await desk.createPerson('Sup Knows');
  const Sgone = await desk.createPerson('Sup Gone Knows');
  const G = await desk.createPerson('Giver Knows');
  const V = await desk.createPerson('Vol Knows', { tags: ['volunteer'] });
  const R = await desk.createPerson('Role Knows');
  const X = await desk.createPerson('Plain Knows');
  const db = await getDb();
  for (const p of [S, Sgone]) ok(await desk.action('contact.log', { person_id: p.id, channel: 'phone', outcome: 'contacted', rating: '2' }));
  ok(await desk.action('gift.log', { person_id: G.id, amount_cents: 5000, date: new Date().toISOString().slice(0, 10), method: 'cheque' }));
  await db.query('insert into volunteer_roles (id, workspace_id, person_id, role) values ($1, $2, $3, $4)', [randomUUID(), ws, R.id, 'canvasser']);
  ok(await add(desk, { from_id: T.a.id, person_id: S.id }));
  ok(await add(desk, { from_id: G.id, person_id: T.b.id }));
  ok(await add(desk, { from_id: T.c.id, person_id: V.id }));
  ok(await add(desk, { from_id: T.d.id, person_id: X.id }));
  ok(await add(desk, { from_id: T.g.id, person_id: R.id }));
  const gone = ok(await add(desk, { from_id: T.e.id, person_id: S.id })).relationship.id;
  ok(await desk.action('relationship.remove', { id: gone }));
  ok(await add(desk, { from_id: T.f.id, person_id: Sgone.id }));
  await db.query('update persons set deleted_at = now() where id = $1', [Sgone.id]);
  const theirs = await other.createPerson('Other Knows');

  const names = async (cl, knows) => ok(await cl.get(`/api/persons?limit=50&tag=kn&knows=${encodeURIComponent(knows)}`)).persons.map((p) => p.name.split(' ')[0]).sort();
  const count = async (cl, knows) => ok(await cl.get(`/api/persons/count?tag=kn&knows=${encodeURIComponent(knows)}`)).total;
  assert.deepEqual(await names(desk, 'supporter'), ['Ava'], 'a removed link and a deleted supporter do not count');
  assert.deepEqual(await names(desk, 'donor'), ['Bo']);
  assert.deepEqual(await names(desk, 'volunteer'), ['Cal', 'Gus'], 'tagged volunteer, or holding a volunteer role');
  assert.deepEqual(await names(desk, 'any'), ['Ava', 'Bo', 'Cal', 'Dev', 'Gus']);
  assert.deepEqual(await names(desk, `person:${S.id}`), ['Ava']);
  assert.deepEqual(await names(desk, `person:${X.id}`), ['Dev']);
  for (const bad of ['bogus', 'person:', 'person:nope', `person:${theirs.id}`, 'Supporter ', 'anyone']) {
    assert.deepEqual(await names(desk, bad), [], `${bad}: nobody, never everybody`);
  }
  assert.equal(await count(desk, 'any'), 5);

  // A volunteer: nobody, whatever the value — even granted People.
  for (const v of ['supporter', 'donor', 'volunteer', 'any', `person:${S.id}`]) assert.equal(await count(vol, v), 0, `volunteer: ${v}`);
  const granted = await invite('volunteer', [], ['people']);
  assert.equal(await count(granted, 'any'), 0, 'a volunteer granted People: still nobody');
  const refused = await granted.action('list.create', { name: 'Circle', kind: 'filter', filter: { knows: 'any' } });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /people they know/);

  // Donations denied: knows a donor is nobody; the rest as before.
  const noMoney = await invite('staff', ['money']);
  assert.equal(await count(noMoney, 'donor'), 0);
  assert.equal(await count(noMoney, 'supporter'), 1);

  // A desk member denied People filtering directly: nobody (their reads are
  // refused anyway — this is the rule itself).
  const ctx = { workspaceId: ws, role: 'staff', user: { email: '' }, workspace: { settings: {} }, perms: permsOf('staff', {}, { deny: ['people'] }) };
  const countWhere = async (c, q) => {
    const { where, params } = await personsWhere(db, c, q);
    params[3] = 1;
    return (await db.query(`select count(*)::int as n from persons p where ${where}`, params)).rows[0].n;
  };
  assert.equal(await countWhere(ctx, { tag: 'kn', knows: 'any' }), 0);
  // …but the desk's list, read in a send on their behalf, is read whole.
  const list = ok(await desk.action('list.create', { name: 'Know anyone', kind: 'filter', filter: { tag: 'kn', knows: 'any' } })).list;
  assert.deepEqual(list.filter, { tag: 'kn', knows: 'any' }, 'knows is kept in a saved filter');
  const asList = async (c) => {
    const { where, params } = await whereFor(db, c, { list: await loadList(db, ws, list.id) });
    params[3] = 1;
    return (await db.query(`select count(*)::int as n from persons p where ${where}`, params)).rows[0].n;
  };
  assert.equal(await asList(ctx), 5, 'a list the desk saved counts whole');
  assert.equal(ok(await desk.get(`/api/lists/${list.id}`)).counts.total, 5);
  // A list a volunteer made is read with a volunteer's eyes: nobody.
  await db.query('update lists set by_volunteer = true where id = $1', [list.id]);
  assert.equal(await asList({ ...ctx, perms: undefined, role: 'manager' }), 0, 'a by_volunteer list matches nobody by who they know');
});

test('a merge keeps a close tie close', async () => {
  const keep = await desk.createPerson('Merge Keep Example', { phone: '604-555-0181' });
  const drop = await desk.createPerson('Merge Drop Example', { phone: '604-555-0182' });
  const friend = await desk.createPerson('Merge Friend Example', { phone: '604-555-0183' });
  ok(await add(desk, { from_id: keep.id, person_id: friend.id, kind: 'friend' }));
  ok(await add(desk, { from_id: drop.id, person_id: friend.id, kind: 'friend', close: true }));
  ok(await desk.action('person.merge', { keep: keep.id, drop: drop.id }));
  const k = (await knowsOf(keep.id)).knows;
  assert.deepEqual(k.map((x) => [x.person.id, x.close]), [[friend.id, true]], 'one link, close because either was');
  assert.equal(ok(await desk.get('/api/audit/verify')).ok, true);
});

test('housemates: the desk is told who asked not to be contacted; a volunteer’s rows are as before', async () => {
  const at = { address: '12 Example Street', phone: '604-555-0184' };
  const h1 = await desk.createPerson('House One Example', at);
  const h2 = await desk.createPerson('House Two Example', { ...at, tags: ['do-not-contact'] });
  const h3 = await desk.createPerson('House Three Example', at);
  const home = ok(await desk.get(`/api/persons/${h1.id}`)).household;
  assert.deepEqual(home.map((x) => [x.id, x.dnc]).sort(), [[h2.id, true], [h3.id, false]].sort());
  const theirs = ok(await vol.get(`/api/persons/${h1.id}`)).household;
  assert.equal(theirs.length, 2);
  for (const row of theirs) assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'rating'], 'no dnc for a volunteer');
});

test('the sample marks two ties close', async () => {
  const m = new Client();
  await m.signup({ name: 'Close Sample', workspaceName: `Rel Close ${tag}`, email: `rel-close+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ok(await m.post('/api/data/sample', {}));
  const named = async (n) => ok(await m.get(`/api/persons?q=${encodeURIComponent(n)}`)).persons.find((p) => p.name === n);
  const closeOf = async (n) => ok(await m.get(`/api/persons/${(await named(n)).id}/knows`)).knows.filter((k) => k.close).map((k) => k.person.name);
  assert.deepEqual(await closeOf('Priya Nair'), ['Sofia Petrova']);
  assert.deepEqual(await closeOf('Gurpreet Sandhu'), ['Navdeep Sandhu']);
  const key = ok(await m.get(`/api/relationships/key?ids=${(await named('Priya Nair')).id}`)).ties;
  assert.equal(Object.values(key)[0].top[0].person.name, 'Sofia Petrova', 'her close tie first');
});
