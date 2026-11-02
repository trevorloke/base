// Voted (ext/voted): a volunteer marks a voter with one tap (replayed from
// a phone, once); a take-back is a new mark; vote.settings is a manager's
// and every role reads the switch; voted_at rides on the walk list, the
// map's doors and the people list (a volunteer's included, emails still
// stripped); the import's Voted column marks from a file and never un-marks;
// the summary counts by band and by turf for the desk only; Today's brief
// carries the numbers for everyone; a mark goes with its person, the export
// carries the marks, and the books verify. test:pg-safe: unique emails and
// names per run, every query scoped to this workspace.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, staff, vol, ws, volId;

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const join = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `vt-${role}+${tag}@example.org`, role });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const c = new Client();
  const j = await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'election-day-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { client: c, id: j.json.user.id };
};
const marksOf = async (c, id) => ok(await c.get(`/api/voted/persons/${id}`));
const square = (lat, lng, d = 0.001) => [[lat + d, lng - d], [lat + d, lng + d], [lat - d, lng + d], [lat - d, lng - d]];

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Voted WS ${tag}`, email: `vt-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ws = r.json.workspace.id;
  staff = (await join('staff', 'Sam Staff')).client;
  const v = await join('volunteer', 'Ana Volunteer');
  vol = v.client;
  volId = v.id;
});

test('a volunteer marks a voter; a replay is a duplicate; voted:false takes it back', async () => {
  const p = await mgr.createPerson('Gill Example', { phone: '604-555-0141', email: 'gill@example.org', address: '13225 72 Ave', lat: 49.1327, lng: -122.8547 });
  const client_id = randomUUID();
  const first = ok(await vol.action('vote.mark', { person_id: p.id, client_id }));
  assert.equal(first.voted, true);
  assert.ok(first.voted_at, 'the fact is set');
  assert.equal(first.duplicate, undefined);
  const view = ok(await vol.get(`/api/persons/${p.id}`));
  assert.ok(view.person.voted_at, 'the volunteer reads voted_at on the profile');
  assert.equal(view.person.email, null, 'and still never the email');
  const replay = ok(await vol.action('vote.mark', { person_id: p.id, client_id }));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.voted, true);
  const db = await getDb();
  const rows = (await db.query('select count(*)::int as n from voted_marks where workspace_id = $1 and person_id = $2', [ws, p.id])).rows[0].n;
  assert.equal(rows, 1, 'one mark for one tap');
  const evs = (await db.query(`select count(*)::int as n from events where workspace_id = $1 and entity_type = 'voted_mark'`, [ws])).rows[0].n;
  assert.equal(evs, 1, 'one event for one mark');

  // Change: a take-back is a new mark, and the fact clears.
  const back = ok(await vol.action('vote.mark', { person_id: p.id, voted: false, source: 'door' }));
  assert.equal(back.voted_at, null);
  assert.equal((await mgr.get(`/api/persons/${p.id}`)).json.person.voted_at, null);
  const mine = await marksOf(vol, p.id);
  assert.equal(mine.voted_at, null);
  assert.deepEqual(mine.marks.map((m) => [m.voted, m.source]), [[false, 'door'], [true, 'door']], 'both marks, newest first');
  assert.ok(mine.marks.every((m) => !('by_name' in m)), 'a volunteer never gets who marked');
  const desk = await marksOf(staff, p.id);
  assert.equal(desk.marks[0].by_name, 'Ana Volunteer');

  // Not on the list, not a tap's source, another campaign's person.
  assert.equal((await vol.action('vote.mark', { person_id: randomUUID() })).status, 404);
  assert.equal((await vol.action('vote.mark', { person_id: p.id, source: 'file' })).status, 400, 'a file is not a tap');
  const other = new Client();
  await other.signup({ workspaceName: `Other ${tag}`, email: `vt-other+${tag}@example.org` });
  assert.equal((await other.action('vote.mark', { person_id: p.id })).status, 404, 'another campaign’s person is not found');
  assert.equal((await other.get(`/api/voted/persons/${p.id}`)).status, 404);
});

test('vote.settings is a manager’s; GET /voted/status tells every role', async () => {
  assert.equal((await staff.action('vote.settings', { on: true })).status, 403);
  assert.equal((await vol.action('vote.settings', { on: true })).status, 403);
  assert.deepEqual(ok(await vol.get('/api/voted/status')), { on: false, election_day: null });
  const on = ok(await mgr.action('vote.settings', { on: true, election_day: '2026-10-17' }));
  assert.deepEqual({ on: on.on, election_day: on.election_day }, { on: true, election_day: '2026-10-17' });
  assert.deepEqual(ok(await vol.get('/api/voted/status')), { on: true, election_day: '2026-10-17' });
  assert.equal((await mgr.action('vote.settings', { on: true, election_day: 'tomorrow' })).status, 400);
  // The date stays when a save leaves it out; null clears it.
  ok(await mgr.action('vote.settings', { on: false }));
  assert.deepEqual(ok(await staff.get('/api/voted/status')), { on: false, election_day: '2026-10-17' });
  ok(await mgr.action('vote.settings', { on: true, election_day: null }));
  assert.deepEqual(ok(await vol.get('/api/voted/status')), { on: true, election_day: null });
  ok(await mgr.action('vote.settings', { on: true, election_day: '2026-10-17' }));
  const evs = (await mgr.get('/api/events?since=0&limit=5000')).json.events.filter((e) => e.action === 'vote.settings');
  assert.equal(evs.length, 4);
  assert.equal(evs.at(-1).entity_type, 'workspace');
  assert.deepEqual(evs.at(-1).payload, { election_day_mode: true, election_day: '2026-10-17' });
});

test('the walk list, /map/doors and /persons carry voted_at', async () => {
  const lat = 49.1407; const lng = -122.8407;
  const a = await mgr.createPerson('Walk Example', { phone: '604-555-0142', email: 'walk@example.org', address: '13213 72 Ave', lat, lng });
  const t = ok(await mgr.action('turf.create', { name: `Newton block ${tag}`, polygon: square(lat, lng) })).turf;
  ok(await mgr.action('turf.assign', { turf_id: t.id, user_id: volId }));
  ok(await vol.action('vote.mark', { person_id: a.id, source: 'door' }));
  const walk = ok(await vol.get(`/api/turfs/${t.id}/walk`));
  const atDoor = walk.doors.flatMap((d) => d.persons).find((p) => p.id === a.id);
  assert.ok(atDoor?.voted_at, 'the walk list carries voted_at');
  assert.equal(atDoor.email, null, 'the walk list still strips the email');
  const doors = ok(await vol.get('/api/map/doors'));
  assert.ok(doors.persons.find((p) => p.id === a.id)?.voted_at, '/map/doors carries voted_at');
  const list = ok(await vol.get('/api/persons?has=phone&limit=500'));
  assert.ok(list.persons.find((p) => p.id === a.id)?.voted_at, '/persons carries voted_at');
});

test('the import’s Voted column marks from a file and never un-marks', async () => {
  const rows = [
    { name: 'One Example', phone: '604-555-0151', voted: '1' },
    { name: 'Yes Example', phone: '604-555-0152', voted: 'yes' },
    { name: 'Date Example', phone: '604-555-0153', voted: '2026-10-17' },
    { name: 'Zero Example', phone: '604-555-0154', voted: '0' },
    { name: 'Blank Example', phone: '604-555-0155', voted: '' },
  ];
  const byName = async (name) => (await staff.get(`/api/persons?q=${encodeURIComponent(name)}`)).json.persons.find((p) => p.name === name);
  const dry = ok(await staff.post('/api/data/import', { rows, dryRun: true }));
  assert.deepEqual(dry.invalid, []);
  assert.equal(dry.created, 5);
  assert.equal(await byName('One Example'), undefined, 'a dry run writes nothing');
  const real = ok(await staff.post('/api/data/import', { rows }));
  assert.equal(real.created, 5);
  for (const n of ['One Example', 'Yes Example', 'Date Example']) assert.ok((await byName(n)).voted_at, `${n} is marked`);
  for (const n of ['Zero Example', 'Blank Example']) assert.equal((await byName(n)).voted_at, null, `${n} is untouched`);
  const one = await byName('One Example');
  assert.deepEqual((await marksOf(staff, one.id)).marks.map((m) => [m.voted, m.source]), [[true, 'file']]);

  // The same file with a 0 for someone marked: nothing changes, nobody is un-marked.
  const again = ok(await staff.post('/api/data/import', { rows: [
    { name: 'One Example', phone: '604-555-0151', voted: '0' },
    { name: 'Yes Example', phone: '604-555-0152', voted: 'yes' },
  ] }));
  assert.deepEqual([again.created, again.merged, again.unchanged], [0, 0, 2]);
  assert.ok((await byName('One Example')).voted_at, 'still marked');
  assert.equal((await marksOf(staff, one.id)).marks.length, 1, 'no second mark from the same file');
  // Someone the field marked stays marked after a row with 0 — and a row with x adds nothing.
  const door = await mgr.createPerson('Door Example', { phone: '604-555-0156' });
  ok(await vol.action('vote.mark', { person_id: door.id }));
  const after = ok(await staff.post('/api/data/import', { rows: [{ name: 'Door Example', phone: '604-555-0156', voted: '0' }] }));
  assert.equal(after.unchanged, 1);
  ok(await staff.post('/api/data/import', { rows: [{ name: 'Door Example', phone: '604-555-0156', voted: 'x' }] }));
  assert.ok((await mgr.get(`/api/persons/${door.id}`)).json.person.voted_at);
  assert.deepEqual((await marksOf(staff, door.id)).marks.map((m) => m.source), ['door'], 'the field’s mark stands alone');

  // The decision names it; a cell that isn't 1/0, yes/no or a date refuses the row, in words.
  const dec = ok(await staff.post('/api/data/import', { rows: [
    { name: 'Zero Example', phone: '604-555-0154', voted: 'voted' },
    { name: 'Maybe Example', voted: 'maybe' },
    { name: 'Later Example', voted: 'Oct 17, 2026' },
  ], dryRun: true }));
  assert.deepEqual(dec.decisions.find((d) => d.name === 'Zero Example').fields, ['voted']);
  assert.equal(dec.decisions.find((d) => d.name === 'Zero Example').action, 'merged');
  assert.deepEqual(dec.invalid, ['row 2: voted: 1/0, yes/no or a date']);
  assert.equal(dec.created, 1);
  const db = await getDb();
  const ev = (await db.query(
    `select count(*)::int as n from events where workspace_id = $1 and action = 'import.persons' and entity_type = 'voted_mark'`, [ws],
  )).rows[0].n;
  assert.equal(ev, 3, 'each mark from a file is on the books');
  assert.equal((await vol.post('/api/data/import', { rows })).status, 403);
});

test('the summary counts by band and by turf for the desk only; brief.voted is everyone’s', async () => {
  const lat = 49.1507; const lng = -122.8307;
  const s1 = await mgr.createPerson('Support One Example', { address: '13301 72 Ave', lat, lng });
  const s2 = await mgr.createPerson('Support Two Example', { address: '13305 72 Ave', lat, lng: lng + 0.0002 });
  const u = await mgr.createPerson('Undecided Example', { address: '13309 72 Ave', lat, lng: lng + 0.0004 });
  await mgr.createPerson('Far Example', { address: '1 Other Rd', lat: 49.3, lng: -122.5, phone: '604-555-0157' });
  await mgr.action('contact.log', { person_id: s1.id, channel: 'door', outcome: 'contacted', rating: '1' });
  await mgr.action('contact.log', { person_id: s2.id, channel: 'door', outcome: 'contacted', rating: '2' });
  await mgr.action('contact.log', { person_id: u.id, channel: 'door', outcome: 'contacted', rating: '3' });
  const t = ok(await mgr.action('turf.create', { name: `Summary turf ${tag}`, polygon: square(lat, lng) })).turf;
  ok(await vol.action('vote.mark', { person_id: s1.id }));
  ok(await staff.action('vote.mark', { person_id: u.id, source: 'desk' }));

  assert.equal((await vol.get('/api/voted/summary')).status, 403, 'the numbers are the desk’s');
  const sum = ok(await staff.get('/api/voted/summary'));
  assert.deepEqual(sum.by_turf.find((r) => r.turf_id === t.id), { turf_id: t.id, name: `Summary turf ${tag}`, supporters: 2, voted: 1, people: 3 });
  assert.equal(sum.supporters, 2, 'the support band: the scale’s 1 and 2');
  assert.equal(sum.supporters_voted, 1);
  assert.deepEqual([sum.by_band.support, sum.by_band.undecided, sum.by_band.opposed], [1, 1, 0]);
  assert.ok(sum.by_band.unrated >= 1);
  assert.equal(sum.total, sum.by_band.support + sum.by_band.undecided + sum.by_band.opposed + sum.by_band.unrated);
  const db = await getDb();
  const todays = (await db.query('select count(*)::int as n from voted_marks where workspace_id = $1 and voted', [ws])).rows[0].n;
  assert.equal(sum.today, todays, 'today: every mark made today (all of them, here)');
  assert.deepEqual({ on: sum.on, election_day: sum.election_day }, { on: true, election_day: '2026-10-17' });

  const KEYS = ['election_day', 'on', 'supporters', 'supporters_voted', 'today', 'total'];
  const bv = ok(await vol.get('/api/brief')).voted;
  assert.deepEqual(Object.keys(bv).sort(), KEYS, 'the volunteer’s Today has the numbers, nothing else');
  const bd = ok(await mgr.get('/api/brief')).voted;
  assert.deepEqual(bd, bv, 'the desk reads the same');
  assert.deepEqual([bv.on, bv.total, bv.supporters, bv.supporters_voted], [true, sum.total, 2, 1]);
});

test('a mark goes with its person; the export carries the marks; the books verify', async () => {
  // The one path that removes a person outright: clearing the sample.
  const fresh = new Client();
  const r = await fresh.signup({ workspaceName: `Sample ${tag}`, email: `vt-sample+${tag}@example.org` });
  const fws = r.json.workspace.id;
  ok(await fresh.post('/api/data/sample', {}));
  const db = await getDb();
  const sp = (await db.query(
    `select p.id from persons p where p.workspace_id = $1 and p.deleted_at is null and p.tags @> '"sample"'::jsonb
       and not exists (select 1 from gifts g where g.person_id = p.id) order by p.name limit 1`, [fws],
  )).rows[0];
  assert.ok(sp, 'a sample person with no gift');
  ok(await fresh.action('vote.mark', { person_id: sp.id, source: 'desk' }));
  assert.equal((await db.query('select count(*)::int as n from voted_marks where person_id = $1', [sp.id])).rows[0].n, 1);
  assert.equal((await fresh.req('DELETE', '/api/data/sample')).status, 200);
  assert.equal((await db.query('select count(*)::int as n from persons where id = $1', [sp.id])).rows[0].n, 0, 'the sample person is gone');
  assert.equal((await db.query('select count(*)::int as n from voted_marks where person_id = $1', [sp.id])).rows[0].n, 0, 'and the mark with them');
  assert.equal((await fresh.get('/api/audit/verify')).json.ok, true);

  const ex = ok(await mgr.get('/api/export'));
  assert.ok(Array.isArray(ex.voted_marks) && ex.voted_marks.length >= 8, 'every mark');
  assert.ok(ex.voted_marks.every((m) => m.workspace_id === ws), 'this campaign’s only');
  assert.equal(ex.voted_settings.length, 1);
  assert.ok(ex.persons.some((p) => p.voted_at));
  assert.equal((await vol.get('/api/export')).status, 403);
  const v = (await mgr.get('/api/audit/verify')).json;
  assert.equal(v.ok, true, JSON.stringify(v));
});
