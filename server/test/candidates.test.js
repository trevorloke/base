// Candidates (ext/candidates): a seat on the slate, held by a volunteer
// account. The seat is made and invited by a manager (the invite's email
// goes after the write commits), taken on joining only by a volunteer, kept
// apart from the desk (no role change while seated), and read back as
// ctx.candidate / me.candidate. Its own Permissions row is kept apart from
// the Volunteers'. The candidate's home read is theirs alone, and what a
// candidate may never do is refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { hashPassword } from '../lib/auth.js';
import { newId } from '../lib/events.js';

const ok = (r) => { assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json; };
const tokenOf = (url) => url.split('/join/')[1];

// A stand-in for the email sender. Each send notes whether the invite it
// carries was already committed when it arrived: a send from inside the
// write would find the row not there yet (another connection can't see it;
// PGlite's one connection waits for the write to end).
const sends = [];
let mailer;
const committed = async (to) => {
  const db = await getDb();
  const look = db.query(
    'select 1 from invites where email = $1 and candidate_id is not null and accepted_at is null and expires_at > now()', [to],
  ).then((r) => r.rows.length > 0);
  return Promise.race([look, new Promise((res) => { setTimeout(() => res(false), 1500); })]);
};
const saved = {};
const ENV = ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_API_BASE', 'MAIL_FROM', 'STARBASE_PTW_CACHE_MS'];

let mgr, vol, cand;
const ids = {};
const join = async (joinUrl, name, password = 'candidate-2026') => {
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(joinUrl), name, password });
  return { cl, r };
};
const joinAs = async (role, name) => {
  const inv = ok(await mgr.action('member.invite', { email: `${name.toLowerCase()}.can@example.org`, role }));
  const { cl, r } = await join(inv.joinUrl, `${name} Example`);
  ok(r);
  ids[name] = r.json.user.id;
  return cl;
};
const seats = async () => ok(await mgr.get('/api/candidates')).candidates;

before(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  mailer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const msg = JSON.parse(body || '{}');
      const to = Array.isArray(msg.to) ? msg.to[0] : msg.to;
      sends.push({ to, subject: msg.subject, text: msg.text, committed: await committed(to) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `em_${sends.length}` }));
    });
  });
  await new Promise((r) => { mailer.listen(0, '127.0.0.1', r); });
  Object.assign(process.env, {
    MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', RESEND_API_BASE: `http://127.0.0.1:${mailer.address().port}`,
    MAIL_FROM: 'Team <team@example.org>', STARBASE_PTW_CACHE_MS: '0',
  });
  await freshDb();
  mgr = new Client();
  ok(await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.can@example.org', jurisdiction: 'bc-municipal' }));
  vol = await joinAs('volunteer', 'Vic');
});

after(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await new Promise((r) => { mailer.close(r); });
});

test('a seat: made and edited by a manager; a race must be one of the slates', async () => {
  const bad = await mgr.action('candidate.save', { name: 'Mo Example', office: 'Mayor', race: 'senate' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'Pick a race from the list');
  ids.mayor = ok(await mgr.action('candidate.save', { name: 'Mo Example', office: 'Mayor' })).candidate.id;
  ids.council = ok(await mgr.action('candidate.save', { name: 'Cleo Example', office: 'Council', race: 'council', email: 'Cleo.Can@Example.org' })).candidate.id;
  const list = ok(await mgr.get('/api/candidates'));
  assert.deepEqual(list.slates.map((s) => s.code), ['council', 'school_board']);
  assert.deepEqual(list.candidates.map((c) => [c.name, c.office, c.race_label, c.email, c.signed_in, c.invited_until]), [
    ['Mo Example', 'Mayor', null, null, false, null],
    ['Cleo Example', 'Council', 'City council', 'cleo.can@example.org', false, null],
  ]);
  ok(await mgr.action('candidate.save', { id: ids.mayor, name: 'Mo Example', office: 'Mayor', email: 'mo.can@example.org' }));
  assert.equal((await seats())[0].email, 'mo.can@example.org');
  assert.equal((await vol.action('candidate.save', { name: 'Not Example' })).status, 403, 'managers only');
  assert.equal((await vol.get('/api/candidates')).status, 403);
});

test('invite: the row is written, the email goes only after the write commits; joining takes the seat', async () => {
  const noEmail = ok(await mgr.action('candidate.save', { name: 'Nell Example' })).candidate.id;
  const r = await mgr.action('candidate.invite', { id: noEmail });
  assert.deepEqual([r.status, r.json.error], [409, 'Add their email first']);
  ok(await mgr.action('candidate.remove', { id: noEmail }));

  const sent = sends.length;
  const inv = ok(await mgr.action('candidate.invite', { id: ids.council }));
  assert.equal(inv.email, 'sent');
  assert.equal(inv.linked, false);
  assert.match(inv.joinUrl, /\/join\/[0-9a-f]{48}$/);
  assert.equal(sends.length, sent + 1);
  const mail = sends.at(-1);
  assert.equal(mail.to, 'cleo.can@example.org');
  assert.equal(mail.committed, true, 'the send came after the invite was committed');
  assert.ok(mail.text.includes(inv.joinUrl));
  const db = await getDb();
  const row = (await db.query('select role, candidate_id from invites where email = $1', ['cleo.can@example.org'])).rows[0];
  assert.deepEqual(row, { role: 'volunteer', candidate_id: ids.council });
  const ev = (await db.query("select payload from events where entity_type = 'invite' and op = 'create' order by seq desc limit 1")).rows[0];
  assert.ok(!JSON.stringify(ev.payload).includes(tokenOf(inv.joinUrl)), 'the token never enters the event log');
  const listed = (await seats()).find((c) => c.id === ids.council);
  assert.ok(listed.invited_until, 'Invited');

  const { cl, r: j } = await join(inv.joinUrl, 'Cleo Example');
  ok(j);
  cand = cl;
  ids.Cleo = j.json.user.id;
  assert.equal(j.json.role, 'volunteer', 'a candidate is a volunteer with a seat');
  assert.deepEqual(j.json.candidate, { id: ids.council, name: 'Cleo Example', office: 'Council', race: 'council', race_label: 'City council' });
  assert.deepEqual(j.json.areas, []);
  assert.deepEqual(ok(await cand.get('/api/auth/me')).candidate.id, ids.council);
  const now = (await seats()).find((c) => c.id === ids.council);
  assert.deepEqual([now.signed_in, now.invited_until], [true, null]);
  const again = await mgr.action('candidate.invite', { id: ids.council });
  assert.deepEqual([again.status, again.json.error], [409, 'Cleo Example is already signed in']);
  // Team shows the seat in place of the role.
  const team = ok(await mgr.get('/api/team')).members.find((m) => m.id === ids.Cleo);
  assert.deepEqual([team.role, team.candidate, team.candidate_office], ['volunteer', true, 'Council']);
});

test('someone already on the team: a volunteer takes the seat now (no email); anyone at the desk is refused', async () => {
  const staff = await joinAs('staff', 'Sam');
  const before = sends.length;
  const s = ok(await mgr.action('candidate.save', { name: 'Sam Example', office: 'School trustee', email: 'sam.can@example.org' })).candidate.id;
  const r = await mgr.action('candidate.invite', { id: s });
  assert.deepEqual([r.status, r.json.error], [409, 'Sam Example is staff — make them a volunteer first']);
  assert.equal((await seats()).find((c) => c.id === s).not_linked_reason, 'Sam Example is staff — not linked');
  ok(await mgr.action('candidate.remove', { id: s }));
  assert.equal((await staff.get('/api/auth/me')).json.candidate, null);

  // Vic, a volunteer already: in the seat at once.
  const v = ok(await mgr.action('candidate.save', { name: 'Vic Example', office: 'Council', race: 'council', email: 'vic.can@example.org' })).candidate.id;
  const linked = ok(await mgr.action('candidate.invite', { id: v }));
  assert.deepEqual([linked.linked, linked.joinUrl, linked.email], [true, undefined, undefined]);
  assert.equal(sends.length, before, 'no email: nothing to join');
  assert.equal(ok(await vol.get('/api/auth/me')).candidate.id, v);
  // One person, one seat.
  const other = ok(await mgr.action('candidate.save', { name: 'Vic Twice', email: 'vic.can@example.org' })).candidate.id;
  const twice = await mgr.action('candidate.invite', { id: other });
  assert.equal(twice.status, 409);
  ok(await mgr.action('candidate.remove', { id: other }));
  // Unlinked: a volunteer again, no seat.
  ok(await mgr.action('candidate.unlink', { id: v }));
  assert.equal(ok(await vol.get('/api/auth/me')).candidate, null);
  assert.equal(ok(await vol.get('/api/auth/me')).role, 'volunteer');
  ok(await mgr.action('candidate.remove', { id: v }));
});

test('a seated candidate’s role can’t change; leaving the campaign leaves the seat in the same write', async () => {
  const r = await mgr.action('member.setRole', { user_id: ids.Cleo, role: 'staff' });
  assert.deepEqual([r.status, r.json.error], [409, 'Cleo Example is a candidate — unlink them under Candidates first']);
  assert.equal(ok(await cand.get('/api/auth/me')).role, 'volunteer');
  ok(await mgr.action('member.setRole', { user_id: ids.Cleo, role: 'volunteer' }));

  // A second candidate account, removed from the campaign: their seat empties.
  const seat = ok(await mgr.action('candidate.save', { name: 'Rex Example', office: 'Council', email: 'rex.can@example.org' })).candidate.id;
  const { r: j } = await join(ok(await mgr.action('candidate.invite', { id: seat })).joinUrl, 'Rex Example');
  ok(j);
  ok(await mgr.action('member.remove', { user_id: j.json.user.id }));
  assert.equal((await seats()).find((c) => c.id === seat).signed_in, false);
  const db = await getDb();
  const ev = (await db.query("select action, payload from events where entity_type = 'candidate' and entity_id = $1 order by seq desc limit 1", [seat])).rows[0];
  assert.equal(ev.action, 'member.remove');
  ok(await mgr.action('candidate.remove', { id: seat }));
});

test('the /join race: the email became staff after the invite went out — the seat stays empty, on the record', async () => {
  const seat = ok(await mgr.action('candidate.save', { name: 'Tia Example', office: 'Council', email: 'tia.can@example.org' })).candidate.id;
  const inv = ok(await mgr.action('candidate.invite', { id: seat }));
  // Meanwhile Tia is put on the team as staff (by another way in).
  const db = await getDb();
  const ws = (await db.query('select workspace_id from candidates where id = $1', [seat])).rows[0].workspace_id;
  const uid = newId();
  await db.query('insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)',
    [uid, 'tia.can@example.org', 'Tia Example', await hashPassword('candidate-2026')]);
  await db.query("insert into memberships (user_id, workspace_id, role) values ($1, $2, 'staff')", [uid, ws]);
  const { r } = await join(inv.joinUrl, 'Tia Example');
  ok(r);
  assert.equal(r.json.role, 'staff', 'their role is kept');
  assert.equal(r.json.candidate, null, 'not a candidate: the desk never is');
  const row = (await seats()).find((c) => c.id === seat);
  assert.equal(row.signed_in, false);
  assert.equal(row.not_linked_reason, 'Tia Example is staff — not linked');
  const ev = (await db.query("select payload from events where entity_type = 'candidate' and entity_id = $1 order by seq desc limit 1", [seat])).rows[0];
  assert.deepEqual(ev.payload, { not_linked: 'role', role: 'staff' });
  ok(await mgr.action('candidate.remove', { id: seat }));
});

test('the Candidates row under Permissions is kept apart from the Volunteers’', async () => {
  const perms = ok(await mgr.get('/api/admin/permissions'));
  assert.deepEqual(perms.roles.candidate, { grant: [], deny: [], base: [] });
  assert.ok(perms.members.find((m) => m.id === ids.Cleo).candidate, 'the member list knows the seat');
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: ['signs'], deny: [] }));
  assert.deepEqual(ok(await vol.get('/api/auth/me')).areas, ['signs']);
  assert.deepEqual(ok(await cand.get('/api/auth/me')).areas, [], 'a grant to Volunteers doesn’t reach candidates');
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: ['shifts'], deny: [] }));
  assert.deepEqual(ok(await cand.get('/api/auth/me')).areas, ['shifts']);
  assert.deepEqual(ok(await vol.get('/api/auth/me')).areas, [], 'nor the other way round');
  assert.deepEqual(ok(await mgr.get('/api/admin/permissions')).members.find((m) => m.id === ids.Cleo).areas, ['shifts']);
  // A deny of People on the row takes away Met someone, as for volunteers.
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: [], deny: ['people'] }));
  assert.equal((await cand.action('mainstreet.meet', { place: 'Market', first_name: 'Ana', last_name: 'Example', client_id: newId() })).status, 403);
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: [], deny: [] }));
  assert.equal((await cand.action('mainstreet.meet', { place: 'Market', first_name: 'Ana', last_name: 'Example', client_id: newId() })).status, 200);
});

test('the candidate’s home: their race now, null with no numbers, Unavailable when the count fails; theirs alone', async () => {
  let home = ok(await cand.get('/api/candidate/home'));
  assert.equal(home.race, null, 'no numbers set for the race');
  ok(await mgr.action('pathtowin.save', { election_day: '2030-10-19', races: { council: { how: 'direct', votes: 12000 } } }));
  home = ok(await cand.get('/api/candidate/home'));
  assert.equal(home.race.label, 'City council');
  assert.equal(home.race.supporters, 0);
  assert.ok(home.race.supporters_needed > 0);
  assert.equal(typeof home.race.days_left, 'number');
  const ptw = ok(await mgr.get('/api/pathtowin'));
  assert.equal(home.race.supporters_needed, ptw.races.find((r) => r.code === 'council').supporters_needed, 'the same number as Path to win');
  // The count fails: that part says so, never a 0.
  const db = await getDb();
  await db.query('alter table contacts rename to contacts_away');
  try {
    home = ok(await cand.get('/api/candidate/home'));
  } finally {
    await db.query('alter table contacts_away rename to contacts');
  }
  assert.deepEqual(home.race, { unavailable: true });
  assert.equal((await vol.get('/api/candidate/home')).status, 404, 'a plain volunteer');
  const staff = new Client();
  const inv = ok(await mgr.action('member.invite', { email: 'stu.can@example.org', role: 'staff' }));
  ok(await staff.post('/api/auth/join', { token: tokenOf(inv.joinUrl), name: 'Stu Example', password: 'candidate-2026' }));
  assert.equal((await staff.get('/api/candidate/home')).status, 404, 'staff');
});

test('what a candidate may never do: money, records, sends, the team, permissions, seats — and the desk’s ties, even with People', async () => {
  const p = await mgr.createPerson('Dana Example');
  const refused = {
    'gift.log': { person_id: p.id, amount_cents: 5000, date: '2026-11-01' },
    'gift.void': { id: p.id },
    'receipt.send': { gift_id: p.id },
    'payment.ack': { id: p.id },
    'donor.step': { person_id: p.id },
    'person.update': { id: p.id, name: 'Changed' },
    'blast.send': { id: p.id },
    'member.invite': { email: 'x.can@example.org', role: 'staff' },
    'member.setRole': { user_id: ids.Cleo, role: 'manager' },
    'permission.role.set': { role: 'candidate', grant: ['money'], deny: [] },
    'candidate.save': { name: 'Myself' },
    'candidate.unlink': { id: ids.council },
  };
  for (const [name, input] of Object.entries(refused)) {
    assert.equal((await cand.action(name, input)).status, 403, name);
  }
  for (const path of ['/api/gifts', '/api/stewardship', '/api/pathtowin', '/api/banks', '/api/candidates']) {
    const r = await cand.get(path);
    assert.ok([403, 404].includes(r.status), `${path}: ${r.status}`);
  }
  // People granted on the Candidates row: still none of the desk's ties.
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: ['people'], deny: [] }));
  assert.deepEqual(ok(await cand.get('/api/auth/me')).areas, ['people']);
  assert.equal((await cand.get(`/api/persons/${p.id}/knows`)).status, 403);
  assert.equal((await cand.get('/api/relationships/connected')).status, 403);
  const key = await cand.get('/api/relationships/key');
  assert.notEqual(key.status, 200, '/relationships/key');
  // And no gifts on a profile.
  const prof = ok(await cand.get(`/api/persons/${p.id}`));
  assert.deepEqual(prof.gifts || [], []);
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: [], deny: [] }));
});

test('a removed candidate loses the seat on their very next request', async () => {
  assert.equal(ok(await cand.get('/api/candidate/home')).candidate.id, ids.council);
  ok(await mgr.action('candidate.remove', { id: ids.council }));
  assert.equal((await cand.get('/api/candidate/home')).status, 404);
  const me = ok(await cand.get('/api/auth/me'));
  assert.deepEqual([me.candidate, me.role], [null, 'volunteer']);
  assert.ok(!(await seats()).some((c) => c.id === ids.council), 'off the list');
  assert.equal((await mgr.action('candidate.invite', { id: ids.council })).status, 404);
});
