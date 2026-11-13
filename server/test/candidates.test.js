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
  // Members lists the invite as the seat's, and its New link can't turn it
  // into a plain volunteer invite (nor can any other role's invite).
  const pending = ok(await mgr.get('/api/team')).invites.find((i) => i.email === 'cleo.can@example.org');
  assert.deepEqual([pending.candidate_id, pending.candidate_office], [ids.council, 'Council']);
  for (const role of ['volunteer', 'staff']) {
    const plain = await mgr.action('member.invite', { email: 'cleo.can@example.org', role });
    assert.deepEqual([plain.status, plain.json.error], [409, 'Cleo Example has a candidate invite — use Settings → Candidates, or cancel it first']);
  }
  assert.equal((await db.query('select candidate_id from invites where email = $1 and accepted_at is null and expires_at > now()', ['cleo.can@example.org'])).rows[0].candidate_id, ids.council);

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
  // The gifts list is /records/gift (there's no /api/gifts read).
  for (const path of ['/api/records/gift', '/api/gifts/imports', '/api/receipts/needs', '/api/stewardship', '/api/pathtowin', '/api/banks', '/api/candidates']) {
    const r = await cand.get(path);
    assert.ok([403, 404].includes(r.status), `${path}: ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
  }
  // People granted on the Candidates row: still none of the desk's ties.
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: ['people'], deny: [] }));
  assert.deepEqual(ok(await cand.get('/api/auth/me')).areas, ['people']);
  assert.equal((await cand.get(`/api/persons/${p.id}/knows`)).status, 403);
  assert.equal((await cand.get('/api/relationships/connected')).status, 403);
  // R's key ties refuse a candidate too (TIE_READERS is the desk's roles).
  const key = await cand.get(`/api/relationships/key?ids=${p.id}`);
  assert.equal(key.status, 403, `/relationships/key: ${JSON.stringify(key.json)}`);
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

// ── Stage 2: call time and pledges ──
// A call-time bank is a phone bank for one candidate: made by the desk
// holding Donations, every number the candidate's, crossed off only by
// their own call-time log. A pledge is a promise heard, never a gift.
const ct = {};
// The campaign's today (B.C.), as the gift form and the room count it.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const thisYear = () => Number(today().slice(0, 4));
const seat = async (name) => {
  const id = ok(await mgr.action('candidate.save', { name: `${name} Example`, office: 'Council', race: 'council', email: `${name.toLowerCase()}.ct@example.org` })).candidate.id;
  return id;
};
const sit = async (seatId, name) => {
  const { cl, r } = await join(ok(await mgr.action('candidate.invite', { id: seatId })).joinUrl, `${name} Example`);
  ok(r);
  ids[name] = r.json.user.id;
  return cl;
};
const numbersOf = async (bankId) => (await (await getDb()).query(
  'select person_id, assigned_to, done_at from call_bank_numbers where bank_id = $1 order by position', [bankId],
)).rows;
const openFor = async (bankId, personId) => (await numbersOf(bankId)).find((n) => n.person_id === personId).done_at === null;

test('call time: only the desk holding Donations makes one; every number is the candidate’s', async () => {
  ct.pat = await seat('Pat');
  ct.patCl = await sit(ct.pat, 'Pat');
  ct.quinn = await seat('Quinn');
  ct.tess = await joinAs('treasurer', 'Tess');
  ct.sid = await joinAs('staff', 'Sid');
  ct.donors = [];
  for (const [i, n] of ['Dee', 'Eli', 'Fay'].entries()) {
    ct.donors.push((await mgr.createPerson(`${n} Example`, { phone: `604-555-01${String(40 + i)}`, email: `${n.toLowerCase()}.ct@example.org`, tags: ['donor'] })).id);
  }
  const make = (cl, extra = {}) => cl.action('bank.create', { name: 'Pat’s call time', person_ids: ct.donors, candidate_id: ct.pat, ask_cents: 25000, ...extra });
  // A volunteer given People makes ordinary banks, never call time.
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: ['people'], deny: [] }));
  let r = await make(vol);
  assert.deepEqual([r.status, r.json.error], [403, 'Call time needs the Donations area']);
  ok(await vol.action('bank.create', { name: 'Vic’s own', person_ids: [] }));
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
  // A candidate given People: the same.
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: ['people'], deny: [] }));
  r = await make(ct.patCl);
  assert.deepEqual([r.status, r.json.error], [403, 'Call time needs the Donations area']);
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: [], deny: [] }));
  // Staff denied Donations.
  ok(await mgr.action('permission.member.set', { user_id: ids.Sid, grant: [], deny: ['money'] }));
  r = await make(ct.sid);
  assert.deepEqual([r.status, r.json.error], [403, 'Call time needs the Donations area']);
  r = await ct.sid.action('bank.create', { name: 'x', person_ids: [], ask_cents: 1000 });
  assert.equal(r.status, 403, 'an ask alone is call time too');
  r = await make(ct.tess, { candidate_id: ids.Vic });
  assert.deepEqual([r.status, r.json.error], [400, 'Pick a candidate']);
  // The treasurer: made, and every number Pat’s at once.
  const made = ok(await make(ct.tess)).bank;
  ct.patBank = made.id;
  assert.deepEqual([made.candidate_id, made.candidate_name, made.ask_cents, made.total, made.assigned], [ct.pat, 'Pat Example', 25000, 3, 3]);
  assert.ok((await numbersOf(ct.patBank)).every((n) => n.assigned_to === ids.Pat));
  // Quinn hasn't signed in: nobody's numbers until they do.
  ct.quinnBank = ok(await mgr.action('bank.create', { name: 'Quinn’s call time', person_ids: ct.donors.slice(0, 1), candidate_id: ct.quinn })).bank.id;
  assert.equal((await numbersOf(ct.quinnBank))[0].assigned_to, null);
  // The desk can’t hand them out or take them back.
  for (const [name, input] of [['bank.assign', { id: ct.patBank, user_id: ids.Vic }], ['bank.release', { id: ct.patBank }]]) {
    r = await mgr.action(name, input);
    assert.deepEqual([r.status, r.json.error], [409, 'This is Pat Example’s call time'], name);
  }
  // Not on anyone's own bank list: worked on /call-time alone.
  assert.equal(ok(await ct.patCl.get('/api/banks/mine')).banks.length, 0);
  assert.equal((await ct.patCl.get(`/api/banks/${ct.patBank}/mine`)).status, 404);
  const desk = ok(await mgr.get('/api/banks')).banks.find((b) => b.id === ct.patBank);
  assert.deepEqual([desk.candidate_name, desk.ask_cents], ['Pat Example', 25000]);
  const listed = (await seats()).find((c) => c.id === ct.pat);
  assert.deepEqual(listed.calltime, { left: 3, pledged_cents: 0 });
  const home = ok(await ct.patCl.get('/api/candidate/home'));
  assert.deepEqual([home.calltime.left, home.calltime.banks.map((b) => b.id)], [3, [ct.patBank]]);
});

test('crossing off: other calls and CallHub never touch call time; a call-time call touches no other bank', async () => {
  const dee = ct.donors[0];
  // Quinn's number for Dee is nobody's yet. A volunteer's call to Dee leaves it.
  ok(await vol.action('contact.log', { person_id: dee, channel: 'phone', outcome: 'contacted' }));
  assert.ok(await openFor(ct.quinnBank, dee), 'a volunteer’s call');
  assert.ok(await openFor(ct.patBank, dee));
  // A call made in CallHub (any caller's) leaves it too.
  const { crossOff } = await import('../ext/banks/actions.js');
  const db = await getDb();
  const ws = (await db.query('select workspace_id from candidates where id = $1', [ct.quinn])).rows[0].workspace_id;
  ct.ws = ws;
  await crossOff(db, { workspaceId: ws, user: { id: null } }, { contact: { person_id: dee, channel: 'phone', outcome: 'contacted' }, anyCaller: true });
  assert.ok(await openFor(ct.quinnBank, dee), 'a CallHub result');
  assert.ok(await openFor(ct.patBank, dee));
  // Quinn signs in: the number is theirs now.
  ct.quinnCl = await sit(ct.quinn, 'Quinn');
  assert.equal((await numbersOf(ct.quinnBank))[0].assigned_to, ids.Quinn, 'handed over on link');
  // Dee in a volunteers' bank too. Pat's call-time answer crosses off Pat's number only.
  ct.volBank = ok(await mgr.action('bank.create', { name: 'Volunteers', person_ids: [dee] })).bank.id;
  ok(await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: dee, result: 'no' }));
  assert.equal(await openFor(ct.patBank, dee), false, 'Pat’s own');
  assert.ok(await openFor(ct.volBank, dee), 'the volunteers’ bank');
  assert.ok(await openFor(ct.quinnBank, dee), 'another candidate’s call time');
});

test('the call-time card: giving, room and the ask — no email or tags; theirs alone', async () => {
  const [dee, eli, fay] = ct.donors;
  ok(await mgr.action('gift.log', { person_id: eli, amount_cents: 50000, date: today(), slate: 'council', method: 'cheque' }));
  ok(await mgr.action('gift.log', { person_id: fay, amount_cents: 20000, date: `${thisYear() - 1}-06-01`, slate: 'council', method: 'cheque' }));
  const page = ok(await ct.patCl.get(`/api/calltime/${ct.patBank}`));
  assert.deepEqual([page.bank.name, page.bank.left], ['Pat’s call time', 2], 'Dee is done');
  const eliRow = page.numbers.find((n) => n.person_id === eli);
  assert.deepEqual(
    [eliRow.name, eliRow.phone, eliRow.given_year_cents, eliRow.given_ever_cents, eliRow.last_gift, eliRow.room_cents, eliRow.ask_cents],
    ['Eli Example', '604-555-0141', 50000, 50000, { amount_cents: 50000, date: today() }, 142970 - 50000, 25000],
  );
  const fayRow = page.numbers.find((n) => n.person_id === fay);
  assert.deepEqual([fayRow.given_year_cents, fayRow.given_ever_cents, fayRow.room_cents], [0, 20000, 142970]);
  for (const n of page.numbers) assert.deepEqual(Object.keys(n).filter((k) => ['email', 'tags', 'note', 'attrs'].includes(k)), [], 'no email, tags or notes');
  assert.equal(page.donate_url, null, 'no live donate page');
  // Anyone else: not found. A bad id: not found. "pledges" is never a bank id.
  assert.equal((await ct.quinnCl.get(`/api/calltime/${ct.patBank}`)).status, 404, 'another candidate');
  assert.equal((await vol.get(`/api/calltime/${ct.patBank}`)).status, 404, 'a volunteer');
  assert.equal((await mgr.get(`/api/calltime/${ct.patBank}`)).status, 404, 'the desk works it from Phone banks');
  assert.equal((await ct.patCl.get('/api/calltime/nope')).status, 404);
  assert.equal((await ct.patCl.get('/api/calltime/pledges')).status, 403, 'the treasurer’s list, not a bank');
  assert.equal(ok(await ct.tess.get('/api/calltime/pledges')).pledges.length, 0);
});

test('calltime.log: each answer, a bank call with no words on it, within the room, once', async () => {
  const [, eli, fay] = ct.donors;
  const db = await getDb();
  // Over the room: refused in the server's words.
  const over = await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: eli, result: 'pledged', amount_cents: 100000 });
  assert.deepEqual([over.status, over.json.error], [400, 'That’s over what they can give this year — up to $929.70']);
  // No answer: back on the list later, as any bank call.
  const na = ok(await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: fay, result: 'no_answer' }));
  assert.ok(na.bank?.back_at, 'calls back');
  assert.ok(await openFor(ct.patBank, fay));
  ok(await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: fay, result: 'left_message' }));
  // A pledge, with a note: denies on the Candidates row don't stop it.
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: [], deny: ['people', 'money'] }));
  const key = newId();
  const p = ok(await ct.patCl.action('calltime.log', { client_id: key, bank_id: ct.patBank, person_id: eli, result: 'pledged', amount_cents: 25000, note: 'Wants a lawn sign too' }));
  ok(await mgr.action('permission.role.set', { role: 'candidate', grant: [], deny: [] }));
  assert.deepEqual([p.result.result, p.result.amount_cents], ['pledged', 25000]);
  ct.pledge = p.result.id;
  const again = ok(await ct.patCl.action('calltime.log', { client_id: key, bank_id: ct.patBank, person_id: eli, result: 'pledged', amount_cents: 25000 }));
  assert.deepEqual([again.result.id, again.duplicate], [ct.pledge, true], 'a replay is the same answer');
  assert.equal((await db.query('select count(*)::int as n from calltime_results where client_id = $1', [key])).rows[0].n, 1);
  // The call is a phone contact with no words; the event names no note.
  const contact = (await db.query('select channel, outcome, note from contacts where client_id = $1', [key])).rows[0];
  assert.deepEqual(contact, { channel: 'phone', outcome: 'contacted', note: null });
  const ev = (await db.query("select payload from events where entity_type = 'calltime_result' and entity_id = $1", [ct.pledge])).rows[0];
  assert.equal(ev.payload.has_note, true);
  assert.ok(!JSON.stringify(ev.payload).includes('lawn sign'), 'never the note’s words');
  // A second candidate's pledge for Eli: refused once the two together go over.
  ok(await mgr.action('bank.add', { id: ct.quinnBank, person_ids: [eli] }));
  const together = await ct.quinnCl.action('calltime.log', { client_id: newId(), bank_id: ct.quinnBank, person_id: eli, result: 'pledged', amount_cents: 70000 });
  assert.deepEqual([together.status, together.json.error], [400, 'That’s over what they can give this year — up to $679.70']);
  // Who else may not: staff (the desk), a plain volunteer, another candidate's bank, a pledge with no amount.
  assert.equal((await mgr.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: eli, result: 'no' })).status, 403);
  assert.equal((await vol.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: eli, result: 'no' })).status, 403);
  const theirs = await ct.quinnCl.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: fay, result: 'no' });
  assert.deepEqual([theirs.status, theirs.json.error], [403, 'That’s not on your call time']);
  assert.equal((await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: fay, result: 'pledged' })).status, 400);
  // The card now: Eli's room counts the pledge.
  const page = ok(await ct.patCl.get(`/api/calltime/${ct.patBank}`));
  assert.deepEqual(page.done, { calls: 4, pledged_cents: 25000 });
  assert.equal(page.numbers.some((n) => n.person_id === eli), false, 'Eli is called');
});

test('room: roomsFor is roomFor less open pledges, donor by donor', async () => {
  const { roomFor } = await import('../ext/payments/limits.js');
  const { roomsFor, pledgedFor } = await import('../ext/candidates/room.js');
  const db = await getDb();
  const ws = (await db.query('select id, jurisdiction, settings from workspaces where id = $1', [ct.ws])).rows[0];
  // Five kinds: nothing given, a gift this year and a pledge (Eli), last
  // year only (Fay), a monthly gift running, and a gift on the other slate.
  const monthly = (await mgr.createPerson('Gus Example')).id;
  await db.query(`insert into gift_pledges (id, workspace_id, person_id, amount_cents, slate, starts_on) values ($1, $2, $3, 5000, 'council', $4)`,
    [newId(), ct.ws, monthly, `${thisYear()}-01-01`]);
  const other = (await mgr.createPerson('Hal Example')).id;
  ok(await mgr.action('gift.log', { person_id: other, amount_cents: 30000, date: today(), slate: 'school_board', method: 'cheque' }));
  const five = [ct.donors[0], ct.donors[1], ct.donors[2], monthly, other];
  const many = await roomsFor(db, ws, five, 'council');
  for (const id of five) {
    const one = await roomFor(db, ws, id, 'council');
    const less = Math.max(0, one.roomCents - await pledgedFor(db, ws, id, 'council'));
    assert.equal(many.get(id).roomCents, less, id);
  }
  assert.equal(many.get(ct.donors[1]).roomCents, 142970 - 50000 - 25000);
});

test('pledges for the treasurer: a gift in, dropped, 60 days, the brief, the export', async () => {
  const eli = ct.donors[1];
  let list = ok(await ct.tess.get('/api/calltime/pledges'));
  assert.equal(list.pledges.length, 1);
  const p = list.pledges[0];
  assert.deepEqual([p.person.name, p.candidate, p.amount_cents, p.gift_in, p.note], ['Eli Example', 'Pat Example', 25000, null, 'Wants a lawn sign too']);
  assert.deepEqual(list.open, { n: 1, cents: 25000 });
  assert.deepEqual(ok(await ct.tess.get('/api/brief')).calltime_pledges, { n: 1, cents: 25000, listed: 1 });
  assert.equal(ok(await ct.patCl.get('/api/brief')).calltime_pledges, undefined, 'not a candidate’s');
  assert.equal((await vol.get('/api/calltime/pledges')).status, 403);
  // The gift comes in (the treasurer logs it): "Gift in", and no longer open.
  ok(await ct.tess.action('gift.log', { person_id: eli, amount_cents: 25000, date: today(), slate: 'council', method: 'cheque' }));
  list = ok(await ct.tess.get('/api/calltime/pledges'));
  assert.deepEqual(list.pledges[0].gift_in, { amount_cents: 25000, date: today() });
  assert.deepEqual(list.open, { n: 0, cents: 0 });
  assert.deepEqual(ok(await ct.tess.get('/api/brief')).calltime_pledges, { n: 0, cents: 0, listed: 1 }, 'still listed: Gift in');
  // Another pledge, dropped by the treasurer (a candidate may not). Fay
  // took a message already, so it's someone new on Pat's list.
  const kim = (await mgr.createPerson('Kim Example', { phone: '604-555-0149' })).id;
  ok(await mgr.action('bank.add', { id: ct.patBank, person_ids: [kim] }));
  const p2 = ok(await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: ct.patBank, person_id: kim, result: 'pledged', amount_cents: 10000 })).result.id;
  assert.equal((await ct.patCl.action('calltime.drop', { id: p2 })).status, 403);
  assert.equal((await ct.sid.action('calltime.drop', { id: p2 })).status, 403, 'staff denied Donations');
  ok(await ct.tess.action('calltime.drop', { id: p2 }));
  assert.ok(!ok(await ct.tess.get('/api/calltime/pledges')).pledges.some((x) => x.id === p2));
  // Older than 60 days: off the list (still in the export).
  const db = await getDb();
  await db.query("update calltime_results set said_on = said_on - 61, created_at = created_at - interval '61 days' where id = $1", [ct.pledge]);
  assert.equal(ok(await ct.tess.get('/api/calltime/pledges')).pledges.length, 0);
  const exp = ok(await mgr.get('/api/export'));
  const rows = exp.calltime_results || exp.tables?.calltime_results;
  assert.ok(Array.isArray(rows) && rows.length >= 2, `calltime_results in the export: ${Object.keys(exp).join(',')}`);
});

test('isolation: two candidates on one slate never see each other’s call time', async () => {
  assert.equal((await ct.quinnCl.get(`/api/calltime/${ct.patBank}`)).status, 404);
  assert.equal((await ct.patCl.get(`/api/calltime/${ct.quinnBank}`)).status, 404);
  const qh = ok(await ct.quinnCl.get('/api/candidate/home'));
  assert.deepEqual(qh.calltime.banks.map((b) => b.id), [ct.quinnBank]);
  assert.equal(qh.calltime.pledged_week_cents, 0);
  assert.equal(ok(await ct.patCl.get('/api/candidate/home')).calltime.pledged_week_cents, 0, 'the old one is past the week; the dropped one isn’t counted');
});

test('measured: a call-time page of 200 numbers', async () => {
  const db = await getDb();
  const people = [];
  for (let i = 0; i < 200; i++) {
    const id = newId();
    people.push(id);
    await db.query('insert into persons (id, workspace_id, name, phone) values ($1, $2, $3, $4)', [id, ct.ws, `Many Example ${i}`, `604-555-${String(1000 + i).slice(-4)}`]);
    if (i % 3 === 0) await db.query("insert into gifts (id, workspace_id, person_id, amount_cents, date, slate) values ($1, $2, $3, 10000, $4, 'council')", [newId(), ct.ws, id, today()]);
  }
  const bank = ok(await mgr.action('bank.create', { name: 'Big call time', person_ids: people, candidate_id: ct.pat })).bank.id;
  ok(await ct.patCl.get(`/api/calltime/${bank}`)); // warm
  let queries = 0;
  const real = db.query.bind(db);
  db.query = (...a) => { queries++; return real(...a); };
  const t0 = performance.now();
  let page;
  try {
    page = ok(await ct.patCl.get(`/api/calltime/${bank}`));
  } finally {
    db.query = real;
  }
  const ms = performance.now() - t0;
  console.log(`# call-time page: ${page.numbers.length} numbers in ${ms.toFixed(0)} ms, ${queries} queries (with sign-in)`);
  assert.equal(page.numbers.length, 200);
  assert.ok(queries < 30, `a fixed handful of queries, not one per donor: ${queries}`);
});

test('removing a candidate closes their call time', async () => {
  const db = await getDb();
  ok(await mgr.action('candidate.remove', { id: ct.quinn }));
  const b = (await db.query('select closed_at from call_banks where id = $1', [ct.quinnBank])).rows[0];
  assert.ok(b.closed_at, 'closed, not left open with nobody to call it');
  const ev = (await db.query("select payload from events where entity_type = 'call_bank' and entity_id = $1 order by seq desc limit 1", [ct.quinnBank])).rows[0];
  assert.equal(ev.payload.closed, true);
  assert.ok((await db.query('select closed_at from call_banks where id = $1', [ct.patBank])).rows[0].closed_at === null, 'Pat’s stays open');
  // Reopened, it would be nobody's to call and nobody's to hand out: it stays
  // closed, and the desk is told so (no Reopen to tap).
  const again = await mgr.action('bank.update', { id: ct.quinnBank, closed: false });
  assert.deepEqual([again.status, again.json.error], [409, 'Quinn Example is no longer a candidate — make a new bank']);
  assert.ok((await db.query('select closed_at from call_banks where id = $1', [ct.quinnBank])).rows[0].closed_at);
  assert.equal(ok(await mgr.get(`/api/banks/${ct.quinnBank}`)).bank.candidate_removed, true);
  assert.equal(ok(await mgr.get(`/api/banks/${ct.patBank}`)).bank.candidate_removed, false);
  // A rename on the closed bank is still the desk's.
  ok(await mgr.action('bank.update', { id: ct.quinnBank, name: 'Quinn’s old call time' }));
});

test('calltime.log: a number already answered is not answered twice', async () => {
  const people = [];
  for (const n of ['Ida', 'Jay']) people.push((await mgr.createPerson(`${n} Example`, { phone: '604-555-0150' })).id);
  const bank = ok(await mgr.action('bank.create', { name: 'Twice', person_ids: people, candidate_id: ct.pat })).bank.id;
  ok(await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: bank, person_id: people[0], result: 'no' }));
  const again = await ct.patCl.action('calltime.log', { client_id: newId(), bank_id: bank, person_id: people[0], result: 'pledged', amount_cents: 5000 });
  assert.deepEqual([again.status, again.json.error], [409, 'Already called']);
});

test('a candidate’s calendar link reads the Candidates row, as their sign-in does — and has no filing dates', async () => {
  const { app } = await import('../index.js');
  const rae = await seat('Rae');
  const raeCl = await sit(rae, 'Rae');
  const p = await mgr.createPerson('Rae Example', { email: 'rae.ct@example.org' });
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const shift = ok(await mgr.action('shift.create', { title: 'Rae’s town hall', starts_at: `${soon}T18:00:00-07:00`, ends_at: `${soon}T19:00:00-07:00` })).shift;
  ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: p.id }));
  const url = new URL(ok(await raeCl.action('calendar.feed.make', {})).feed.url).pathname;
  const uids = async () => {
    const res = await app.request(url, { headers: { 'x-real-ip': '203.0.113.77' } });
    assert.equal(res.status, 200);
    return [...(await res.text()).matchAll(/^UID:(.*?)\r?$/gm)].map((m) => m[1]);
  };
  try {
    assert.ok((await uids()).includes(`shift-${shift.id}@base.win`), 'their booked shift');
    // Volunteers kept out of Shifts: not the candidate, whose row is their own.
    ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: ['shifts'] }));
    assert.ok((await uids()).includes(`shift-${shift.id}@base.win`), 'a deny on Volunteers doesn’t reach candidates');
    ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
    ok(await mgr.action('permission.role.set', { role: 'candidate', grant: ['money'], deny: ['shifts'] }));
    const got = await uids();
    assert.ok(!got.some((u) => u.startsWith('shift-')), 'a deny on the Candidates row does');
    assert.ok(!got.some((u) => u.startsWith('filing-')), 'never the filing dates, even given Donations: a candidate is no desk role');
  } finally {
    ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
    ok(await mgr.action('permission.role.set', { role: 'candidate', grant: [], deny: [] }));
  }
});
