// The membership form (ext/membership): every box on the paper form lands
// somewhere it is used — the person, their profile fields, a volunteer
// request, a sign request, the membership (youth rate from the birth date),
// gifts on the right slates (Superstar and Star Club from the year's limit),
// a monthly pledge, the opt-in on joining. Card numbers are never taken. A
// website membership (Base Web's tag) is a membership too; the members
// export lists both.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

let mgr, db, vol;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const yr = new Date().getFullYear();
const today = new Date().toISOString().slice(0, 10);
const fieldsOf = async (id) => Object.fromEntries(ok(await mgr.get(`/api/persons/${id}/fields`)).fields.map((f) => [f.name, f.value]));
const enter = (input) => mgr.action('membership.enter', input);

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Members', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'vol@example.org', role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vol Example', password: 'vol-pass-123' }));
});

test('the club amounts come from the year’s contribution limit (2026: $1,429.70 a slate)', async () => {
  const f = ok(await mgr.get('/api/membership/form?date=2026-11-08'));
  assert.deepEqual(
    [f.clubs.star_once, f.clubs.superstar_once, f.clubs.star_monthly, f.clubs.superstar_monthly],
    [142970, 285940, 11900, 23800],
    'Star $1,429.70 · Superstar $2,859.40 · monthly $119 / $238, as printed on the form',
  );
  assert.deepEqual(f.minimum, { adult_cents: 1000, youth_cents: 500, youth_ages: [14, 30] });
});

test('a full form: the person, every field, a volunteer and a window sign, a youth membership, Superstar once', async () => {
  const birth = `${yr - 25}-03-04`;
  const r = ok(await enter({
    first_name: 'Ana', last_name: 'Example', gender: 'Woman', birth_date: birth,
    email: 'ana.member@example.org', phone: '604-555-0101', address: '13450 104 Ave', city: 'Surrey', postal: 'v3t 1v8',
    citizenship: 'citizen', union_member: true, union_local: 'CUPE 402', campus: 'Kwantlen',
    volunteer: true, candidate: true, sign: 'window',
    languages: ['English', 'Filipino', 'Tamil'], other_language: '',
    interests: ['Safer streets', 'Homes I can afford'],
    term: 1, once: { kind: 'superstar' }, method: 'cheque', signed: true, signed_on: today,
  }));
  assert.equal(r.person.name, 'Ana Example');
  assert.deepEqual([r.membership.term_years, r.membership.youth, r.membership.source, r.membership.starts_on], [1, true, 'paper', today]);
  assert.equal(r.membership.ends_on, `${yr + 1}${today.slice(4)}`.replace(/-02-29$/, '-02-28'));
  assert.deepEqual(r.gifts.map((g) => [g.slate, g.amount_cents, g.method, g.cadence]).sort(), [['council', 142970, 'cheque', 'one-time'], ['school_board', 142970, 'cheque', 'one-time']]);
  assert.equal(r.sign.kind, 'window');
  assert.deepEqual(r.entered, { by: 'Avery Chen', on: today }, 'office use: who entered it, and when');
  const f = await fieldsOf(r.person.id);
  assert.equal(f.Gender, 'Woman');
  assert.equal(f['Birth date'], birth);
  assert.equal(f.Citizenship, 'Canadian citizen');
  assert.deepEqual([f['Union member'], f['Union local'], f.Campus], [true, 'CUPE 402', 'Kwantlen']);
  assert.deepEqual(f.Language, ['English', 'Filipino', 'Other']);
  assert.equal(f['Other language'], 'Tamil', 'a language not on the list is kept in Other language');
  assert.deepEqual(f.Interests, ['Safer streets', 'Homes I can afford']);
  assert.equal(f['Interested in being a candidate'], true);
  assert.deepEqual([f['Email opt-in'], f['SMS opt-in']], [true, true], 'joining opts them in, as the form says');
  const p = (await db.query('select tags, postal from persons where id = $1', [r.person.id])).rows[0];
  assert.ok(p.tags.includes('member') && p.tags.includes('volunteer'));
  assert.equal(p.postal, 'V3T 1V8');
  assert.equal((await db.query("select count(*)::int as n from door_requests where person_id = $1 and kind = 'volunteer'", [r.person.id])).rows[0].n, 1);
  assert.equal((await db.query("select status, source from subscriptions where email = 'ana.member@example.org'")).rows[0].source, 'membership-form');
  const m = ok(await mgr.get(`/api/persons/${r.person.id}/membership`));
  assert.equal(m.member, true);
});

test('already on file: the desk picks them; the form’s details update theirs; a renewal starts when the current term ends', async () => {
  const ana = (await db.query("select id from persons where email = 'ana.member@example.org'")).rows[0].id;
  const match = ok(await mgr.get('/api/membership/match?email=ANA.MEMBER@example.org'));
  assert.deepEqual(match.people.map((p) => p.id), [ana]);
  const r = ok(await enter({ person_id: ana, phone: '604-555-0199', term: 4, once: { kind: 'amount', amount_cents: 2000 }, method: 'cash', signed: true }));
  assert.equal(r.person.id, ana);
  assert.equal((await db.query('select phone from persons where id = $1', [ana])).rows[0].phone, '604-555-0199');
  const first = (await db.query("select ends_on from member_terms where person_id = $1 order by created_at limit 1", [ana])).rows[0];
  assert.equal(r.membership.starts_on, new Date(first.ends_on).toISOString().slice(0, 10), 'renewed from the end of the current term');
  assert.ok(r.warnings.some((w) => /renewal/.test(w)));
  assert.equal(r.membership.youth, true, 'the birth date on file still makes it the youth rate');
  assert.equal(r.membership.citizenship, 'citizen', 'nothing ticked this time: what is on file');
  assert.ok(r.warnings.some((w) => /on file: Canadian citizen/.test(w)), r.warnings.join(' | '));
});

test('monthly Star Club to the school board: a pledge, and the first month logged as a monthly gift on that slate', async () => {
  const r = ok(await enter({
    first_name: 'Ben', last_name: 'Example', email: 'ben.member@example.org', term: 1, citizenship: 'pr',
    monthly: { kind: 'star', slate: 'school_board' }, method: 'pad', signed: true,
  }));
  assert.deepEqual(r.pledges.map((p) => [p.amount_cents, p.slate, p.method]), [[11900, 'school_board', 'pad']]);
  assert.deepEqual(r.gifts.map((g) => [g.amount_cents, g.slate, g.cadence, g.method]), [[11900, 'school_board', 'monthly', 'pad']]);
  assert.equal(r.membership.citizenship, 'pr');
  assert.equal(r.membership.youth, false, 'no birth date: the adult rate');
});

test('refused: no signature for a membership or a gift; a gift without how it was paid; under 14', async () => {
  assert.equal((await enter({ first_name: 'Cy', last_name: 'Example', term: 1 })).status, 400);
  assert.equal((await enter({ first_name: 'Cy', last_name: 'Example', once: { kind: 'amount', amount_cents: 1000 }, signed: true })).status, 400);
  const young = await enter({ first_name: 'Cy', last_name: 'Example', birth_date: `${yr - 12}-01-01`, term: 1, signed: true });
  assert.equal(young.status, 400);
  assert.match(young.json.error, /14 or older/);
  assert.equal((await enter({ first_name: 'Cy', last_name: 'Example', term: 1, signed: true, signed_on: `${yr + 1}-01-01` })).status, 400, 'not in the future');
});

test('below the minimum, someone who left the email list, nothing ticked for citizenship: saved, with a word for each', async () => {
  ok(await mgr.action('subscription.add', { email: 'dee.member@example.org', name: 'Dee' }));
  const sid = (await db.query("select id from subscriptions where email = 'dee.member@example.org'")).rows[0].id;
  ok(await mgr.action('subscription.remove', { id: sid }));
  const r = ok(await enter({ first_name: 'Dee', last_name: 'Example', email: 'dee.member@example.org', term: 4, once: { kind: 'amount', amount_cents: 1000 }, method: 'etransfer', signed: true }));
  assert.ok(r.warnings.some((w) => /minimum is \$40\.00/.test(w)), r.warnings.join(' | '));
  assert.ok(r.warnings.some((w) => /weren’t put back/.test(w)));
  assert.ok(r.warnings.some((w) => /citizen/.test(w)));
  assert.equal((await db.query("select status from subscriptions where email = 'dee.member@example.org'")).rows[0].status, 'unsubscribed');
});

test('a website membership (Base Web’s tag) is a membership; the members export lists paper and website', async () => {
  const key = ok(await mgr.action('intake.key.create', { name: 'Site' })).key;
  const res = await app.request('/in/v1/people', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'Eve', last_name: 'Example', email: 'eve.member@example.org', tags: ['Member (joined online)'] }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const eve = (await res.json()).person_id;
  const m = (await db.query('select source, term_years from member_terms where person_id = $1', [eve])).rows;
  assert.deepEqual(m.map((x) => [x.source, x.term_years]), [['website', 1]]);
  const again = await app.request('/in/v1/people', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'eve.member@example.org', tags: ['Member (joined online)'] }),
  });
  assert.equal(again.status, 200);
  assert.equal((await db.query('select count(*)::int as n from member_terms where person_id = $1', [eve])).rows[0].n, 1, 'not twice');
  const csv = await (await app.request('/api/export/members.csv', { headers: { cookie: mgr.cookie } })).text();
  assert.match(csv, /Eve,Example,eve\.member@example\.org/);
  assert.match(csv, /Ana,Example/);
  assert.match(csv.split(/\r?\n/)[0], /term_years,starts_on,ends_on,status,youth,citizenship,source,declaration_on/);
});

// A volunteer given Donations enters paper forms. They never see an email
// on file (lib/viewer.js), and the form they enter still puts the member on
// the newsletter at that email — the same as the same form from the desk.
test('a volunteer given Donations enters a form for someone on file: the email on file joins the newsletter', async () => {
  const me = ok(await vol.get('/api/auth/me'));
  const fay = ok(await mgr.action('person.create', { name: 'Fay Example', email: 'fay.member@example.org', phone: '604-555-0161' })).person;
  const gil = ok(await mgr.action('person.create', { name: 'Gil Example', email: 'gil.member@example.org', phone: '604-555-0162' })).person;
  const form = { city: 'Surrey', citizenship: 'citizen', term: 1, once: { kind: 'amount', amount_cents: 1000 }, method: 'cash', signed: true };
  ok(await mgr.action('permission.member.set', { user_id: me.user.id, grant: ['money'] }));
  try {
    const r = ok(await vol.action('membership.enter', { person_id: fay.id, ...form }));
    assert.ok(!/fay\.member@/.test(JSON.stringify(r)), 'the answer names no email');
    ok(await enter({ person_id: gil.id, ...form }));
    const subs = (await db.query("select email, status from subscriptions where email in ('fay.member@example.org', 'gil.member@example.org') order by email")).rows;
    assert.deepEqual(subs.map((x) => [x.email, x.status]), [['fay.member@example.org', 'subscribed'], ['gil.member@example.org', 'subscribed']]);
    assert.deepEqual([(await fieldsOf(fay.id))['Email opt-in'], (await fieldsOf(gil.id))['Email opt-in']], [true, true]);
  } finally {
    ok(await mgr.action('permission.member.set', { user_id: me.user.id, grant: [] }));
  }
});

test('the desk’s: a volunteer can’t enter a form or read the club amounts; the books verify', async () => {
  assert.equal((await vol.action('membership.enter', { first_name: 'X', last_name: 'Y' })).status, 403);
  assert.equal((await vol.get('/api/membership/form')).status, 403);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
