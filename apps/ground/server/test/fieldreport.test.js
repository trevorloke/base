// Field, by turf (ext/fieldreport): the desk's knocks by turf, by canvasser
// and by day over a range of the campaign's days, as JSON and CSV; and each
// person's all-time line in the brief. Reads only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';
import { turfNumbers, rangeOf, addDays, localDay } from '../ext/fieldreport/numbers.js';
import { fromLocal } from '../lib/tzsql.js';

const TZ = 'America/Vancouver'; // a new campaign's zone (lib/org.js DEFAULT_TZ)
const lat = 49.1327; const lng = -122.855;
const tokenOf = (url) => url.split('/join/')[1];
let mgr, vol, staff, ws, turfId;
const ids = {};
const P = {};
const C = {};

const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name.toLowerCase()}.fr@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'field-report-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};
const knock = async (who, person, outcome, extra = {}) => {
  const r = await who.action('contact.log', { person_id: person.id, channel: 'door', outcome, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.contact.id;
};
const csvOf = async (cl, qs = '') => app.request(`/api/field-report.csv${qs}`, { headers: { cookie: cl.cookie } });

before(async () => {
  await freshDb();
  mgr = new Client();
  const s = await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.fr@example.org', jurisdiction: 'bc-municipal' });
  ws = s.json.workspace.id;
  ids.mgr = s.json.user.id;
  vol = await joinAs('volunteer', 'Jas');
  staff = await joinAs('staff', 'Sam');
  // organize.test.js's block: four doors inside, one far away.
  const mk = (name, address, dLng) => mgr.createPerson(name, { address, lat, lng: lng + dLng });
  P.a = await mk('Ada Example', '13213 72 Ave', 0.0000);
  P.b = await mk('Ben Example', '13225 72 Ave', 0.0003);
  P.c = await mk('Cy Example', '13224 72 Ave', 0.0003);
  P.d = await mk('Di Example', '13212 72 Ave', 0.0000);
  P.far = await mgr.createPerson('Far Example', { address: '1 Other Rd', lat: 49.3, lng: -122.5 });
  const t = await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  });
  turfId = t.json.turf.id;
  const team = await mgr.action('team.create', { name: 'Newton crew' });
  await mgr.action('team.member.add', { team_id: team.json.team?.id ?? team.json.id, user_id: ids.Jas });

  C.a = await knock(vol, P.a, 'contacted', { rating: '1' });
  C.b1 = await knock(vol, P.b, 'no_answer');
  C.b2 = await knock(vol, P.b, 'no_answer');
  C.c = await knock(mgr, P.c, 'refused');
  // A call is never a knock (and a support rating on it is the caller's, any channel, for mine_all only).
  await mgr.action('contact.log', { person_id: P.a.id, channel: 'phone', outcome: 'contacted', rating: '2' });
  // Forty days ago: outside the default thirty.
  C.old = await knock(mgr, P.d, 'no_answer');
  const db = await getDb();
  await db.query("update contacts set created_at = now() - interval '40 days' where id = $1", [C.old]);
});

test('default range: the last 30 days by turf — a door knocked twice counts once, calls ignored', async () => {
  const r = await mgr.get('/api/field-report');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const today = localDay(new Date(), TZ);
  assert.deepEqual({ from: r.json.range.from, to: r.json.range.to }, { from: addDays(today, -29), to: today });
  assert.equal(r.json.turfs.length, 1);
  const t = r.json.turfs[0];
  assert.equal(t.id, turfId);
  assert.equal(t.name, 'Newton block');
  assert.equal(t.doors, 4, 'the far-away door is not in the turf');
  assert.equal(t.people, 4);
  assert.equal(t.knocked, 3, 'B twice is one door; D was 40 days ago');
  assert.equal(t.coverage_pct, 75);
  assert.equal(t.talked, 1);
  assert.equal(t.support_found, 1);
  assert.equal(t.no_answer, 2, 'both knocks at B are not-homes');
  assert.equal(t.refused, 1);
  assert.equal(t.moved, 0);
  assert.equal(t.inaccessible, 0);
  assert.equal(t.other, 0);
  assert.equal(t.canvassers, 2);
  assert.ok(t.last_knock_at && Date.now() - new Date(t.last_knock_at).getTime() < 60_000, t.last_knock_at);
  assert.deepEqual(r.json.totals, { doors: 4, knocked: 3, doors_knocked: 3, talked: 1, support_found: 1, canvassers: 2 });
  assert.deepEqual(r.json.days, [{ day: today, doors: 3, talked: 1 }]);
});

test('by canvasser: doors, talks, supporters found, days out, last out, team; a call changes nothing', async () => {
  const r = (await mgr.get('/api/field-report')).json;
  const jas = r.canvassers.find((x) => x.id === ids.Jas);
  const me = r.canvassers.find((x) => x.id === ids.mgr);
  assert.equal(r.canvassers.length, 2);
  assert.equal(r.canvassers[0].id, ids.Jas, 'most doors first');
  assert.deepEqual({ ...jas, last_out: !!jas.last_out },
    { id: ids.Jas, name: 'Jas', team: 'Newton crew', doors: 2, talked: 1, support_found: 1, days_out: 1, last_out: true });
  assert.deepEqual({ ...me, last_out: !!me.last_out },
    { id: ids.mgr, name: 'Avery Chen', team: null, doors: 1, talked: 0, support_found: 0, days_out: 1, last_out: true },
    'the call on A (talked, a yes) is not a knock');
});

test('from=all brings back the old knock; a narrow range leaves it out; a bad date is a 400', async () => {
  const all = (await mgr.get('/api/field-report?from=all')).json;
  assert.equal(all.range.from, 'all');
  assert.equal(all.turfs[0].knocked, 4);
  assert.equal(all.turfs[0].coverage_pct, 100);
  assert.equal(all.turfs[0].no_answer, 3);
  assert.equal(all.days.length, 2);
  const today = localDay(new Date(), TZ);
  const old = (await mgr.get(`/api/field-report?from=${addDays(today, -45)}&to=${addDays(today, -35)}`)).json;
  assert.equal(old.turfs[0].knocked, 1, 'only the old knock');
  assert.equal(old.canvassers.length, 1);
  const narrow = (await mgr.get(`/api/field-report?from=${addDays(today, -1)}&to=${today}`)).json;
  assert.equal(narrow.turfs[0].knocked, 3);
  for (const qs of ['?from=yesterday', '?to=2026-02-30', '?from=2026-13-01&to=2026-12-01', '?from=all&to=soon']) {
    const bad = await mgr.get(`/api/field-report${qs}`);
    assert.equal(bad.status, 400, qs);
    assert.equal(bad.json.error, 'from and to are dates');
  }
  assert.equal((await mgr.get('/api/field-report?from=2026-10-10&to=2026-10-01')).status, 400, 'from after to');
  assert.equal((await csvOf(mgr, '?from=nope')).status, 400);
  assert.throws(() => rangeOf({ from: '2026-1-1' }, TZ), /from and to are dates/);
});

test('a lit drop has its own column; an outcome this report does not know counts as other; the rating on the knock, not the person, is support', async () => {
  const db = await getDb();
  const at = new Date().toISOString();
  const k = (person, outcome, rating, extra = {}) => ({
    person_id: person.id, outcome, rating, created_by: ids.Jas, created_at: at, day: localDay(new Date(), TZ),
    lat: person.lat, lng: person.lng, address: person.address, unit: null, door: `${person.address.toLowerCase()}|`, ...extra,
  });
  const [t] = await turfNumbers(db, ws, [k(P.a, 'left_lit', null), k(P.a, 'some_new_outcome', null), k(P.b, 'contacted', '3'), k(P.b, 'contacted', '2'), k(P.far, 'contacted', '1')]);
  assert.equal(t.left_lit, 1, 'Left lit, never a talk');
  assert.equal(t.other, 1);
  assert.equal(t.talked, 2, 'the far door is not in the turf');
  assert.equal(t.knocked, 2);
  assert.equal(t.support_found, 1);
  // Re-rating Ada later doesn't take last week's yes away.
  await mgr.action('contact.log', { person_id: P.a.id, channel: 'phone', outcome: 'contacted', rating: '4' });
  assert.equal((await mgr.get('/api/field-report')).json.turfs[0].support_found, 1);
});

test('desk only: volunteers 403 on the report and its CSV; staff 200; the CSV is the turfs, then the canvassers', async () => {
  assert.equal((await vol.get('/api/field-report')).status, 403);
  assert.equal((await csvOf(vol)).status, 403);
  assert.equal((await staff.get('/api/field-report')).status, 200);
  const res = await csvOf(staff, '?from=all');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /field-report-all-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = (await res.text()).replace(/^﻿/, '').split('\r\n');
  assert.ok(lines[0].startsWith('Turf,'), lines[0]);
  assert.equal(lines[0], 'Turf,Doors,Knocked,Coverage %,Talked,Yes,No answer,Refused,Moved,No access,Left lit,Other,Canvassers,Last knock');
  assert.match(lines[1], /^Newton block,4,4,100,1,1,3,1,0,0,0,0,2,\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(lines[2], '');
  assert.equal(lines[3], 'Canvasser,Team,Doors,Talked,Yes,Days out,Last out');
  assert.match(lines[4], /^Jas,Newton crew,2,1,1,1,/);
  assert.match(lines[5], /^Avery Chen,,2,0,0,2,/);
  // A volunteer given Data has the desk's report; a staffer denied Data does not.
  assert.equal((await mgr.action('permission.member.set', { user_id: ids.Jas, grant: ['data'] })).status, 200);
  assert.equal((await vol.get('/api/field-report')).status, 200);
  assert.equal((await mgr.action('permission.member.set', { user_id: ids.Jas, grant: [], deny: [] })).status, 200);
  assert.equal((await vol.get('/api/field-report')).status, 403);
  assert.equal((await mgr.action('permission.member.set', { user_id: ids.Sam, deny: ['data'] })).status, 200);
  assert.equal((await staff.get('/api/field-report')).status, 403);
  assert.equal((await csvOf(staff)).status, 403);
  assert.equal((await mgr.action('permission.member.set', { user_id: ids.Sam, grant: [], deny: [] })).status, 200);
});

test('the brief: field.mine_all is the caller’s own, all time, for every role', async () => {
  const v = (await vol.get('/api/brief')).json;
  assert.deepEqual(v.field.mine_all, { doors: 2, talked: 1, support_found: 1, days_out: 1 }, 'Jas: A and B, one talk, one yes');
  const m = (await mgr.get('/api/brief')).json;
  // C, and D forty days ago; Ada's '2' on the phone is a yes they found (any channel); '4' later doesn't undo it.
  assert.deepEqual(m.field.mine_all, { doors: 2, talked: 0, support_found: 1, days_out: 2 });
  const s = (await staff.get('/api/brief')).json;
  assert.deepEqual(s.field.mine_all, { doors: 0, talked: 0, support_found: 0, days_out: 0 });
});

// Last: it adds a door to the turf.
test('days are the campaign’s: a knock just before local midnight and one just after land on their own days', async () => {
  const db = await getDb();
  const day = addDays(localDay(new Date(), TZ), -3);
  const p = await mgr.createPerson('Mid Example', { address: '13219 72 Ave', lat, lng: lng + 0.0001 });
  const late = await knock(mgr, p, 'contacted');
  const early = await knock(mgr, p, 'no_answer');
  await db.query(`update contacts set created_at = ${fromLocal("(($2::date)::timestamp + time '23:59')", '$3::text')} where id = $1`, [late, day, TZ]);
  await db.query(`update contacts set created_at = ${fromLocal("(($2::date + 1)::timestamp + time '00:01')", '$3::text')} where id = $1`, [early, day, TZ]);
  const on = (await mgr.get(`/api/field-report?from=${day}&to=${day}`)).json;
  assert.equal(on.turfs[0].knocked, 1);
  assert.equal(on.turfs[0].talked, 1, '11:59 p.m. is that day');
  assert.equal(on.turfs[0].no_answer, 0, '12:01 a.m. is the next');
  assert.deepEqual(on.days, [{ day, doors: 1, talked: 1 }]);
  const next = (await mgr.get(`/api/field-report?from=${addDays(day, 1)}&to=${addDays(day, 1)}`)).json;
  assert.equal(next.turfs[0].no_answer, 1);
  assert.equal(next.turfs[0].talked, 0);
  assert.deepEqual(next.days, [{ day: addDays(day, 1), doors: 1, talked: 0 }]);
});

test('reads only: the books still verify', async () => {
  const v = (await mgr.get('/api/audit/verify')).json;
  assert.equal(v.ok, true, JSON.stringify(v));
});
