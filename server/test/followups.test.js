// Speed to lead (ext/followups): every new volunteer (the website's form,
// the door's "Wants to volunteer", Mainstreeting's, the membership form's),
// every website message and every RSVP from someone new becomes one
// follow-up for a named organizer — whoever brought them in, else whoever
// knows them, else someone on the turf their pin falls in (a captain
// first), else the managers (the least busy) — due a day later. It is on
// that organizer's own list (volunteers see no email), a second thing the
// person does joins it, a pin that arrives later hands it from the office
// to the turf, and a contact closes it: the organizer's (any outcome) or
// anyone's talk — which also marks the door request it came from done.
// The desk sees every open one by organizer, what's overdue and the time
// to first contact, and can hand one over. Never for someone marked do not
// contact or a teammate. All on the hash chain.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { ensureSiteTables, siteAction } from './siteactions.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.stl.${tag}@example.org`;
let db, mgr, ws;
const users = {};
const clients = {};
const records = {};

const ok = (r) => { assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json; };
// A teammate, with their own record on the list (as My people finds it).
const joinAs = async (role, first) => {
  const inv = ok(await mgr.action('member.invite', { email: mail(first.toLowerCase()), role }));
  const cl = new Client();
  const r = ok(await cl.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${first} Example`, password: 'follow-up-2026' }));
  users[first] = r.user.id;
  clients[first] = cl;
  records[first] = (await mgr.createPerson(`${first} Example`, { email: mail(first.toLowerCase()) })).id;
  return cl;
};
const mine = async (who) => ok(await clients[who].get('/api/followups/mine')).followups;
const rowsOf = async (personId) => (await db.query(
  'select * from ladder_followups where workspace_id = $1 and person_id = $2 order by created_at', [ws, personId],
)).rows;
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// A square around a point, as a turf's polygon ([lat, lng] corners).
const square = (lat, lng, d = 0.01) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = ok(await mgr.signup({ name: 'Mona Example', workspaceName: `Speed ${tag}`, email: mail('mona'), jurisdiction: 'bc-municipal' }));
  ws = r.workspace.id;
  users.Mona = r.user.id;
  clients.Mona = mgr;
  await ensureSiteTables(db);
  await joinAs('volunteer', 'Rae');
  await joinAs('volunteer', 'Theo');
  await joinAs('volunteer', 'Vic');
  await joinAs('volunteer', 'Cap');
  await joinAs('manager', 'Max');
  await joinAs('staff', 'Sid');
});

test('a website volunteer goes to whoever brought them in, due in a day, on their own list with what they said', async () => {
  const before = Date.now();
  const { personId } = await siteAction(db, ws, {
    kind: 'volunteer', person: { name: 'Nora Example', email: mail('nora'), phone: '604-555-0170' },
    referrerId: records.Rae,
    payload: { roles: ['Door knocking', 'Phone banking'], availability: 'Weekday evenings', note: 'I live near the library' },
  });
  const [f] = await rowsOf(personId);
  assert.equal(f.kind, 'volunteer');
  assert.equal(f.assigned_to, users.Rae);
  assert.equal(f.routed, 'brought_in');
  assert.equal(f.status, 'open');
  const due = new Date(f.due_at).getTime() - new Date(f.created_at).getTime();
  assert.equal(due, 24 * 3600 * 1000, 'a 24-hour clock');
  assert.ok(new Date(f.created_at).getTime() >= before - 5000);

  const list = await mine('Rae');
  assert.equal(list.length, 1);
  const card = list[0];
  assert.equal(card.text, 'Offered to volunteer on the website');
  assert.equal(card.person.name, 'Nora Example');
  assert.equal(card.person.phone, '604-555-0170');
  assert.equal(card.person.email, null, 'a volunteer never gets someone else’s email');
  assert.deepEqual(card.did[0].roles, ['Door knocking', 'Phone banking']);
  assert.equal(card.did[0].availability, 'Weekday evenings');
  assert.equal(card.did[0].note, 'I live near the library');
  assert.ok(!('site_action_id' in card.did[0]), 'the card carries what they said, not the rows');
  assert.equal((await mine('Theo')).length, 0, 'nobody else has it');
});

test('a door "Wants to volunteer" goes to a teammate who knows them (My people)', async () => {
  const owen = await mgr.createPerson('Owen Example', { phone: '604-555-0171' });
  ok(await clients.Theo.action('relationship.add', { person_id: owen.id, kind: 'neighbour' }));
  ok(await mgr.action('request.ask', { person_id: owen.id, kind: 'volunteer', note: 'Free on Saturdays' }));
  const [f] = await rowsOf(owen.id);
  assert.equal(f.assigned_to, users.Theo);
  assert.equal(f.routed, 'knows');
  const card = (await mine('Theo')).find((x) => x.person.id === owen.id);
  assert.equal(card.text, 'Wants to volunteer — told Mona Example');
  assert.equal(card.did[0].note, 'Free on Saturdays');
  assert.equal(card.did[0].from, 'door');
});

test('someone on the turf their pin falls in: a captain first', async () => {
  const lat = 49.19;
  const lng = -122.85;
  const turf = ok(await mgr.action('turf.create', { name: 'Whalley north', polygon: square(lat, lng) })).turf;
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: users.Vic }));
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: users.Cap }));
  ok(await mgr.action('volunteer.assign', { person_id: records.Cap, role: 'zone_house_captain' }));
  const { personId } = await siteAction(db, ws, {
    kind: 'contact', person: { name: 'Pia Example', email: mail('pia'), lat, lng },
    payload: { topic: 'Transit', message: 'When does the bus come back to 104 Ave?' },
  });
  const [f] = await rowsOf(personId);
  assert.equal(f.kind, 'message');
  assert.equal(f.assigned_to, users.Cap, 'the captain, not the other walker');
  assert.equal(f.routed, 'turf');
  const card = (await mine('Cap'))[0];
  assert.equal(card.text, 'Wrote on the website: Transit');
  assert.equal(card.did[0].message, 'When does the bus come back to 104 Ave?');

  // Without a captain, the one the desk put there by hand.
  const turf2 = ok(await mgr.action('turf.create', { name: 'Newton east', polygon: square(49.12, -122.84) })).turf;
  ok(await mgr.action('turf.assign', { turf_id: turf2.id, user_id: users.Vic }));
  const two = await siteAction(db, ws, { kind: 'volunteer', person: { name: 'Quin Example', email: mail('quin'), lat: 49.12, lng: -122.84 } });
  assert.equal((await rowsOf(two.personId))[0].assigned_to, users.Vic);
});

test('nobody knows them and no turf: the managers — the one with fewer open follow-ups', async () => {
  const counts = async () => Object.fromEntries((await db.query(
    "select assigned_to, count(*)::int as n from ladder_followups where workspace_id = $1 and status = 'open' group by assigned_to", [ws],
  )).rows.map((r) => [r.assigned_to, r.n]));
  const before = await counts();
  const a = await siteAction(db, ws, { kind: 'volunteer', person: { name: 'Ruth Example', email: mail('ruth') } });
  const fa = (await rowsOf(a.personId))[0];
  assert.equal(fa.routed, 'office');
  assert.ok([users.Mona, users.Max].includes(fa.assigned_to));
  const b = await siteAction(db, ws, { kind: 'volunteer', person: { name: 'Saul Example', email: mail('saul') } });
  const fb = (await rowsOf(b.personId))[0];
  assert.equal(fb.routed, 'office');
  const after = await counts();
  // Shared out: the two land on the two managers when they started level.
  if ((before[users.Mona] || 0) === (before[users.Max] || 0)) assert.notEqual(fa.assigned_to, fb.assigned_to);
  assert.ok(Math.abs((after[users.Mona] || 0) - (after[users.Max] || 0)) <= 1);
});

test('a pin placed after the follow-up was made hands it from the office to the turf', async () => {
  const { personId } = await siteAction(db, ws, { kind: 'volunteer', person: { name: 'Tara Example', email: mail('tara') } });
  assert.equal((await rowsOf(personId))[0].routed, 'office');
  ok(await mgr.action('person.locate', { id: personId, lat: 49.12, lng: -122.84 }));
  const [f] = await rowsOf(personId);
  assert.equal(f.routed, 'turf');
  assert.equal(f.assigned_to, users.Vic);
  const moved = (await mgr.get('/api/events?since=0&limit=2000')).json.events
    .filter((e) => e.entity_type === 'ladder_followup' && e.entity_id === f.id).map((e) => e.payload);
  assert.ok(moved.some((p) => p.reason === 'pin' && p.routed === 'turf'));
});

test('one open follow-up per person: a second thing they do joins it, same clock, same organizer', async () => {
  const { personId } = await siteAction(db, ws, {
    kind: 'volunteer', person: { name: 'Uma Example', email: mail('uma') }, referrerId: records.Rae,
  });
  const first = (await rowsOf(personId))[0];
  await siteAction(db, ws, { kind: 'contact', personId, payload: { topic: 'Housing', message: 'Can I help with the housing plan?' } });
  const rows = await rowsOf(personId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assigned_to, users.Rae);
  assert.equal(new Date(rows[0].due_at).getTime(), new Date(first.due_at).getTime(), 'the clock keeps running from the first');
  assert.deepEqual(parse(rows[0].detail).did.map((d) => d.kind), ['volunteer', 'message']);
  assert.equal(rows[0].text, 'Offered to volunteer on the website (+1 more)');
});

test('a website form that also files a "Wants to volunteer" request is one thing they did; a talk closes the request too', async () => {
  const { personId } = await siteAction(db, ws, {
    kind: 'volunteer', person: { name: 'Lyn Example', email: mail('lyn'), phone: '604-555-0186' },
    payload: { roles: ['Phone banking'] },
    extra: async (tx, emit, pid) => {
      const id = (await import('node:crypto')).randomUUID();
      await tx.query("insert into door_requests (id, workspace_id, person_id, kind, note) values ($1, $2, $3, 'volunteer', 'From the website')", [id, ws, pid]);
      emit('door_request', id, 'create', { id, person_id: pid, kind: 'volunteer', note: 'From the website', from: 'website' });
    },
  });
  const [f] = await rowsOf(personId);
  const did = parse(f.detail).did;
  assert.equal(did.length, 1, 'one thing, said once');
  assert.ok(did[0].request_id && did[0].site_action_id);
  assert.deepEqual(did[0].roles, ['Phone banking']);
  assert.equal(f.text, 'Offered to volunteer on the website');
  ok(await mgr.action('contact.log', { person_id: personId, channel: 'phone', outcome: 'contacted' }));
  assert.equal((await rowsOf(personId))[0].status, 'done');
  assert.ok((await db.query('select done_at from door_requests where workspace_id = $1 and person_id = $2', [ws, personId])).rows[0].done_at);
});

test('an RSVP makes a follow-up only from someone new', async () => {
  const shift = ok(await mgr.action('shift.create', { title: 'Saturday canvass', starts_at: new Date(Date.now() + 3 * 86400000).toISOString() })).shift;
  const book = (pid) => async (tx, emit) => {
    const id = (await import('node:crypto')).randomUUID();
    await tx.query('insert into shift_assignments (id, workspace_id, shift_id, person_id) values ($1, $2, $3, $4)', [id, ws, shift.id, pid]);
    emit('shift_assignment', id, 'create', { id, shift_id: shift.id, person_id: pid });
  };
  // New: made by this very form.
  const fresh = await siteAction(db, ws, {
    kind: 'rsvp', person: { name: 'Vera Example', email: mail('vera') }, payload: { shift_id: shift.id },
    extra: async (tx, emit, pid) => book(pid)(tx, emit),
  });
  const [f] = await rowsOf(fresh.personId);
  assert.equal(f.kind, 'rsvp');
  assert.equal(f.text, 'New — RSVP’d to Saturday canvass');
  assert.equal(parse(f.detail).did[0].shift.title, 'Saturday canvass');
  // On file and talked to before: no follow-up.
  const known = await mgr.createPerson('Walt Example', { email: mail('walt') });
  ok(await mgr.action('contact.log', { person_id: known.id, channel: 'door', outcome: 'contacted' }));
  await siteAction(db, ws, { kind: 'rsvp', personId: known.id, payload: { shift_id: shift.id }, extra: async (tx, emit) => book(known.id)(tx, emit) });
  assert.equal((await rowsOf(known.id)).length, 0);
  // On file, never contacted, on no other shift: new to us.
  const quiet = await mgr.createPerson('Xena Example', { email: mail('xena') });
  await siteAction(db, ws, { kind: 'rsvp', personId: quiet.id, payload: { shift_id: shift.id }, extra: async (tx, emit) => book(quiet.id)(tx, emit) });
  assert.equal((await rowsOf(quiet.id)).length, 1);
  // A petition signature is not a follow-up (a ladder's job).
  const signer = await siteAction(db, ws, { kind: 'petition', person: { name: 'Yuri Example', email: mail('yuri') } });
  assert.equal((await rowsOf(signer.personId)).length, 0);
});

test('a contact closes it: the organizer’s (any outcome) or anyone’s talk — and the door request it came from is done', async () => {
  // Owen's follow-up is Theo's (he knows him). Rae's no-answer leaves it.
  const owen = (await db.query("select id from persons where workspace_id = $1 and name = 'Owen Example'", [ws])).rows[0];
  ok(await clients.Rae.action('contact.log', { person_id: owen.id, channel: 'phone', outcome: 'no_answer' }));
  assert.equal((await rowsOf(owen.id))[0].status, 'open', 'someone else not reaching them closes nothing');
  // Theo calls, no answer: his own log closes it (and the clock stops).
  const log = ok(await clients.Theo.action('contact.log', { person_id: owen.id, channel: 'phone', outcome: 'no_answer' }));
  const [f] = await rowsOf(owen.id);
  assert.equal(f.status, 'done');
  assert.equal(f.contact_id, log.contact.id);
  assert.equal(f.contacted_by, users.Theo);
  assert.ok(f.contacted_at);
  assert.equal((await mine('Theo')).filter((x) => x.person.id === owen.id).length, 0, 'off his Today');
  const req = (await db.query("select done_at from door_requests where workspace_id = $1 and person_id = $2", [ws, owen.id])).rows[0];
  assert.equal(req.done_at, null, 'not reached: the office still has the request');

  // Zed asked at the door; Sid (not the organizer) talks with him: closed, request done.
  const zed = await mgr.createPerson('Zed Example', { phone: '604-555-0179' });
  ok(await clients.Rae.action('relationship.add', { person_id: zed.id, kind: 'friend' }));
  ok(await mgr.action('request.ask', { person_id: zed.id, kind: 'volunteer' }));
  assert.equal((await rowsOf(zed.id))[0].assigned_to, users.Rae);
  ok(await clients.Sid.action('contact.log', { person_id: zed.id, channel: 'phone', outcome: 'contacted', rating: '1' }));
  const [z] = await rowsOf(zed.id);
  assert.equal(z.status, 'done');
  assert.equal(z.contacted_by, users.Sid);
  const zreq = (await db.query('select done_at, done_note, done_by from door_requests where workspace_id = $1 and person_id = $2', [ws, zed.id])).rows[0];
  assert.ok(zreq.done_at);
  assert.equal(zreq.done_note, 'Followed up by Sid Example — on the phone');
  assert.equal(zreq.done_by, users.Sid);
});

test('Mainstreeting and the membership form make one; the meeting’s own talk doesn’t close it', async () => {
  const met = ok(await clients.Vic.action('mainstreet.meet', {
    client_id: (await import('node:crypto')).randomUUID(), place: 'Surrey Central bus loop',
    first_name: 'Abe', last_name: 'Example', phone: '604-555-0181', rating: '2', volunteer: true,
  }));
  const [f] = await rowsOf(met.person_id);
  assert.equal(f.status, 'open', 'the talk at the bus loop is not the follow-up');
  assert.equal(f.text, 'Wants to volunteer — met at Surrey Central bus loop');
  const form = ok(await mgr.action('membership.enter', { first_name: 'Bea', last_name: 'Example', email: mail('bea'), phone: '604-555-0182', volunteer: true }));
  const pid = form.person?.id || form.person_id || (await db.query("select id from persons where workspace_id = $1 and name = 'Bea Example'", [ws])).rows[0].id;
  const [m] = await rowsOf(pid);
  assert.equal(m.kind, 'volunteer');
  assert.equal(m.text, 'Wants to volunteer — on their membership form');
});

test('never for someone marked do not contact, or for a teammate', async () => {
  const dnc = await mgr.createPerson('Cy Example', { phone: '604-555-0183', tags: ['do-not-contact'] });
  ok(await mgr.action('request.ask', { person_id: dnc.id, kind: 'volunteer' }));
  assert.equal((await rowsOf(dnc.id)).length, 0);
  await siteAction(db, ws, { kind: 'volunteer', personId: records.Vic });
  assert.equal((await rowsOf(records.Vic)).length, 0, 'Vic is on the team already');
  // A "Call them back" is the office's, not a follow-up.
  const cb = await mgr.createPerson('Dee Example', { phone: '604-555-0184' });
  ok(await mgr.action('request.ask', { person_id: cb.id, kind: 'call_back' }));
  assert.equal((await rowsOf(cb.id)).length, 0);
});

test('the desk: open follow-ups by organizer, overdue, time to first contact; one handed over', async () => {
  // Nora's (Rae's) is a day and a half old.
  const nora = (await db.query("select id from persons where workspace_id = $1 and name = 'Nora Example'", [ws])).rows[0];
  await db.query(
    `update ladder_followups set created_at = now() - interval '36 hours', due_at = now() - interval '12 hours'
     where workspace_id = $1 and person_id = $2`, [ws, nora.id],
  );
  const count = ok(await mgr.get('/api/ladders/followups/count'));
  assert.ok(count.overdue >= 1);
  const desk = ok(await mgr.get('/api/ladders/followups'));
  const rae = desk.by.find((b) => b.id === users.Rae);
  assert.ok(rae.open >= 2 && rae.overdue >= 1, JSON.stringify(desk.by));
  assert.equal(rae.name, 'Rae Example');
  const row = desk.open.find((f) => f.person.id === nora.id);
  assert.equal(row.assigned.name, 'Rae Example');
  assert.equal(row.kind, 'volunteer');
  assert.ok(new Date(row.due_at) < new Date());
  // Owen (Theo, no answer, within the hour) and Zed (Sid) were reached.
  assert.ok(desk.stats.reached >= 2 && desk.stats.made >= desk.stats.reached);
  assert.ok(desk.stats.in_a_day >= 2);
  assert.ok(desk.stats.median_hours != null && desk.stats.median_hours < 1);
  // Only Rae's.
  const raes = ok(await mgr.get(`/api/ladders/followups?who=${users.Rae}`)).open;
  assert.ok(raes.length >= 2 && raes.every((f) => f.assigned.id === users.Rae));

  // Handed to Theo: his now, the clock as it was.
  const f = (await rowsOf(nora.id))[0];
  ok(await mgr.action('ladder.followupAssign', { id: f.id, user_id: users.Theo }));
  const moved = (await rowsOf(nora.id))[0];
  assert.equal(moved.assigned_to, users.Theo);
  assert.equal(moved.routed, 'desk');
  assert.equal(new Date(moved.due_at).getTime(), new Date(f.due_at).getTime());
  assert.ok((await mine('Theo')).some((x) => x.person.id === nora.id));
  assert.ok(!(await mine('Rae')).some((x) => x.person.id === nora.id));

  // Volunteers: not the desk's list, not the hand-over.
  assert.equal((await clients.Rae.get('/api/ladders/followups')).status, 403);
  assert.equal((await clients.Rae.action('ladder.followupAssign', { id: f.id, user_id: users.Rae })).status, 403);
  assert.equal((await mgr.action('ladder.followupAssign', { id: f.id, user_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
});

test('a ladder’s own follow-up stays with the desk; the organizer it was handed to closes it with a call', async () => {
  const p = await mgr.createPerson('Eve Example', { phone: '604-555-0185' });
  const id = (await import('node:crypto')).randomUUID();
  await db.query("insert into ladder_followups (id, workspace_id, person_id, text) values ($1, $2, $3, 'Thank Eve for her gift')", [id, ws, p.id]);
  const toVol = await mgr.action('ladder.followupAssign', { id, user_id: users.Rae });
  assert.equal(toVol.status, 400, 'a volunteer never gets a ladder’s (money) follow-up');
  ok(await mgr.action('ladder.followupAssign', { id, user_id: users.Sid }));
  // Someone else's talk leaves a ladder's follow-up alone…
  ok(await clients.Rae.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted' }));
  assert.equal((await db.query('select status from ladder_followups where id = $1', [id])).rows[0].status, 'open');
  // …Sid's own call closes it.
  ok(await clients.Sid.action('contact.log', { person_id: p.id, channel: 'phone', outcome: 'contacted' }));
  assert.equal((await db.query('select status from ladder_followups where id = $1', [id])).rows[0].status, 'done');
});

test('someone leaves the team: their open follow-ups go to whoever the rules pick now', async () => {
  // Max (a manager) has the office's share; he leaves.
  const maxs = (await db.query(
    "select id from ladder_followups where workspace_id = $1 and status = 'open' and assigned_to = $2", [ws, users.Max],
  )).rows.map((r) => r.id);
  assert.ok(maxs.length >= 1, 'Max had some');
  ok(await mgr.action('member.remove', { user_id: users.Max }));
  const after = (await db.query('select assigned_to, routed from ladder_followups where id = any($1::uuid[])', [maxs])).rows;
  assert.ok(after.every((f) => f.assigned_to && f.assigned_to !== users.Max), JSON.stringify(after));
  assert.ok(after.every((f) => f.assigned_to === users.Mona), 'the office is Mona now');
});

test('the books still verify', async () => {
  const v = ok(await mgr.get('/api/audit/verify'));
  assert.equal(v.ok, true, JSON.stringify(v));
});
