// Lit drops: "Left lit" at the door. A drop is a door contact with outcome
// 'left_lit' — a visit, not a conversation: it finishes the door, sets no
// rating, is never Reached, and Today counts the doors lit this week on its
// own (field.lit, field.mine.lit). The check on contacts.outcome is widened
// at boot, and booting again changes nothing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';
import { sql as litSql } from '../ext/litdrop/sql.js';
import { OUTCOMES } from '@base-ground/shared/canvass';
import { itemText } from '../../web/src/offline.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, vol, volUser, ws, turfId;
const P = {};

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const asVolunteer = async (client, name, email) => {
  const v = await client.signup({ name, workspaceName: `Temp ${tag}`, email });
  const db = await getDb();
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [v.json.user.id, ws, 'volunteer']);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [v.json.user.id, ws]);
  return v.json.user;
};
const outcomeChecks = async () => (await (await getDb()).query(
  `select pg_get_constraintdef(oid) as def from pg_constraint
   where conrelid = 'contacts'::regclass and conname = 'contacts_outcome_check'`,
)).rows;
const brief = async (client) => ok(await client.get('/api/brief')).field;
const lit = (client, p, extra = {}) => client.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'left_lit', ...extra });

before(async () => {
  // Two boots: under test:pg both run against one database, so the second
  // runs the constraint swap over a check that already knows 'left_lit'.
  await freshDb();
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ name: 'Riley Desk', workspaceName: `Lit WS ${tag}`, email: `lit-desk+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  vol = new Client();
  volUser = await asVolunteer(vol, 'Amrit Volunteer', `lit-vol+${tag}@example.org`);

  const lat = 49.1327; const lng = -122.855;
  // Two people at one door, one at the next, one at a third.
  P.ana = await mgr.createPerson('Ana Example', { address: '13213 72 Ave', lat, lng, phone: '604-555-0140' });
  P.ben = await mgr.createPerson('Ben Example', { address: '13213 72 Ave', lat, lng, phone: '604-555-0141' });
  P.cy = await mgr.createPerson('Cy Example', { address: '13225 72 Ave', lat, lng: lng + 0.0003, phone: '604-555-0142' });
  P.dee = await mgr.createPerson('Dee Example', { address: '13224 72 Ave', lat, lng: lng + 0.0003, phone: '604-555-0143' });
  const t = ok(await mgr.action('turf.create', {
    name: `Lit block ${tag}`, polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  }));
  turfId = t.turf.id;
});

test('contact.log takes left_lit at the door; the widened check is there once and booting again changes nothing', async () => {
  assert.ok(OUTCOMES.includes('left_lit'), 'the shared vocabulary has it');
  const r = ok(await lit(vol, P.ana), 'a lit drop logs');
  const db = await getDb();
  const row = (await db.query('select channel, outcome, rating, created_by from contacts where id = $1', [r.contact.id])).rows[0];
  assert.deepEqual({ ...row }, { channel: 'door', outcome: 'left_lit', rating: null, created_by: volUser.id });

  let checks = await outcomeChecks();
  assert.equal(checks.length, 1, 'one outcome check');
  assert.match(checks[0].def, /left_lit/);
  // The module's script again, twice (another boot): still the one check, still taking the drop.
  await db.exec(litSql);
  await db.exec(litSql);
  checks = await outcomeChecks();
  assert.equal(checks.length, 1);
  assert.match(checks[0].def, /left_lit/);
  assert.match(checks[0].def, /inaccessible/, 'the old outcomes stay');
  assert.equal((await mgr.action('contact.log', { person_id: P.dee.id, channel: 'door', outcome: 'pamphlet' })).status, 400, 'still only the known outcomes');

  // A phone left_lit is accepted by the enum (documented; no screen offers it).
  const phone = ok(await mgr.action('contact.log', { person_id: P.dee.id, channel: 'phone', outcome: 'left_lit' }));
  assert.equal(phone.contact.outcome, 'left_lit');
  // The database itself refuses an outcome outside the check.
  await assert.rejects(db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome) values (gen_random_uuid(), $1, $2, 'door', 'pamphlet')`,
    [ws, P.dee.id],
  ));
});

test('a replayed lit drop (same client_id) is one drop', async () => {
  const cid = '7d1f8a4e-2b3c-4d5e-8f90-1a2b3c4d5e6f';
  const first = ok(await lit(vol, P.ben, { client_id: cid }));
  const again = ok(await lit(vol, P.ben, { client_id: cid }));
  assert.equal(again.duplicate, true);
  assert.equal(again.contact.id, first.contact.id);
  const n = (await (await getDb()).query('select count(*)::int as n from contacts where client_id = $1', [cid])).rows[0].n;
  assert.equal(n, 1);
});

test('Today: field.lit and field.mine.lit count distinct doors left lit this week', async () => {
  // Ana and Ben share a door, both left lit by the volunteer: one door.
  let v = await brief(vol);
  assert.equal(v.lit, 1, 'two people at one door are one door lit');
  assert.equal(v.mine.lit, 1);
  // Someone else drops at Cy's door: the team's count, not the volunteer's.
  ok(await lit(mgr, P.cy));
  v = await brief(vol);
  assert.equal(v.lit, 2);
  assert.equal(v.mine.lit, 1, 'a drop by someone else is not mine');
  const m = await brief(mgr);
  assert.equal(m.lit, 2);
  assert.equal(m.mine.lit, 1);
  // A knock that talked, or a no answer, is not a drop.
  ok(await mgr.action('contact.log', { person_id: P.dee.id, channel: 'door', outcome: 'no_answer' }));
  assert.equal((await brief(vol)).lit, 2);
  // The phone left_lit on Dee's record is not a door left lit (2, not 3);
  // the doors visited still count the lit doors (a visit is a visit).
  v = await brief(vol);
  assert.equal(v.doors, 3, 'Ana+Ben, Cy and Dee: three doors visited');
  assert.equal(v.mine.doors, 1);
  // Older than a week: not this week.
  const db = await getDb();
  await db.query(`update contacts set created_at = now() - interval '8 days' where person_id = $1 and outcome = 'left_lit'`, [P.cy.id]);
  assert.equal((await brief(vol)).lit, 1);
  await db.query(`update contacts set created_at = now() where person_id = $1 and outcome = 'left_lit'`, [P.cy.id]);
  // Another campaign sees none of it.
  const other = new Client();
  await other.signup({ workspaceName: `Other ${tag}`, email: `lit-other+${tag}@example.org` });
  const o = await brief(other);
  assert.equal(o.lit, 0);
  assert.equal(o.mine.lit, 0);
});

test('a drop sets no rating; the walk list door is done and the person last reads left_lit', async () => {
  const db = await getDb();
  // Cy was rated on an earlier knock; the drop leaves the rating alone.
  ok(await mgr.action('contact.log', { person_id: P.cy.id, channel: 'door', outcome: 'contacted', rating: '2' }));
  const ratedAt = (await db.query('select rating, rated_at from persons where id = $1', [P.cy.id])).rows[0];
  ok(await lit(vol, P.cy));
  const after = (await db.query('select rating, rated_at from persons where id = $1', [P.cy.id])).rows[0];
  assert.equal(after.rating, '2');
  assert.equal(String(after.rated_at), String(ratedAt.rated_at), 'rated_at untouched');
  for (const p of [P.ana, P.ben]) {
    assert.equal((await db.query('select rating from persons where id = $1', [p.id])).rows[0].rating, null, 'never rated by a drop');
  }

  const walk = ok(await mgr.get(`/api/turfs/${turfId}/walk`));
  const door = walk.doors.find((d) => d.address === '13213 72 Ave');
  assert.ok(door, 'the shared door is on the list');
  assert.equal(door.done, true, 'a lit door is done');
  for (const p of door.persons) assert.equal(p.last_outcome, 'left_lit');
  const cyDoor = walk.doors.find((d) => d.address === '13225 72 Ave');
  assert.equal(cyDoor.persons[0].last_outcome, 'left_lit');
  // The outbox strip says what it is.
  assert.equal(itemText({ name: 'contact.log', input: { channel: 'door', outcome: 'left_lit', person_id: P.ana.id }, meta: { who: 'Ana Example' } }), 'Left lit · Ana Example');
  assert.equal(itemText({ name: 'contact.log', input: { channel: 'door', outcome: 'no_answer', person_id: P.ana.id }, meta: { who: 'Ana Example' } }), 'Knock · Ana Example');
});

test('the dashboard still answers with left_lit in its rows; contacts by week has Lit and Reached is only talks', async () => {
  const d = ok(await mgr.get('/api/dashboard?period=7d'));
  assert.ok(d.outcomes.includes('left_lit'));
  const week = d.series.reduce((a, r) => a + (r.left_lit || 0), 0);
  const db = await getDb();
  const want = (await db.query(`select count(*)::int as n from contacts where workspace_id = $1 and outcome = 'left_lit'`, [ws])).rows[0].n;
  assert.equal(week, want, 'every drop is in the series');
  for (const r of d.series) assert.equal(typeof r.left_lit, 'number');
  // Amrit's own: Ana, Ben (once, the replay too) and Cy.
  const amrit = d.people.find((p) => p.id === volUser.id);
  assert.equal(amrit.by_outcome.left_lit, 3);

  const res = await app.request('/api/reports/contacts.csv', { headers: { cookie: mgr.cookie } });
  assert.equal(res.status, 200);
  const lines = (await res.text()).replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
  const head = lines[0];
  assert.deepEqual(head, ['Week of', 'Doors', 'Calls', 'Texts', 'Mainstreeting', 'Reached', 'No answer', 'Refused', 'Lit']);
  const sum = (col) => lines.slice(1).reduce((a, r) => a + Number(r[head.indexOf(col)]), 0);
  const talked = (await db.query(`select count(*)::int as n from contacts where workspace_id = $1 and outcome = 'contacted'`, [ws])).rows[0].n;
  assert.equal(sum('Reached'), talked, 'Reached never counts a drop');
  assert.equal(sum('Lit'), want);
  const rep = ok(await mgr.get('/api/reports'));
  assert.equal(rep.reports.contacts.head.at(-1), 'Lit');
});

test('the books still verify', async () => {
  const v = ok(await mgr.get('/api/audit/verify'));
  assert.equal(v.ok, true, JSON.stringify(v));
});
