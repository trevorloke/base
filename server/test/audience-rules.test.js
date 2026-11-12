// The rules a saved filter can hold beyond People's own (ext/audience,
// ext/lists): what they gave, a membership, a survey answer, a shift they
// came to or missed, being on another list or not, and when they were
// added — on People, on a saved list, and so on every send, phone bank and
// sweep made from one. A value a rule doesn't understand matches nobody; a
// volunteer never sorts people by money, memberships, answers, attendance
// or the desk's lists.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { FILTER_KEYS, cleanFilter, shiftParams } from '../lib/audience.js';
import { todayOf } from '../ext/audience/index.js';
import { ensureSiteTables, siteAction } from './siteactions.js';

let db, mgr, vol, ws;
const P = {};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const tag = Math.random().toString(36).slice(2, 8);
const who = async (query, cl = mgr) => ok(await cl.get(`/api/persons?limit=200&tag=rules&${query}`)).persons.map((p) => p.name.split(' ')[0]);
// Days in the campaign's own calendar (Vancouver), as the rules count them.
const today = todayOf({});
const year = Number(today.slice(0, 4));
const day = (offset) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const gift = (key, cents, date) => mgr.action('gift.log', { person_id: P[key].id, amount_cents: cents, date, method: 'cheque' });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Imagine Surrey', email: `mgr.rules.${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = await mgr.action('member.invite', { email: `vol.rules.${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Volunteer', password: 'rules-pass-2026' }));
  for (const [key, name] of [['ana', 'Ana'], ['ben', 'Ben'], ['cy', 'Cy'], ['dee', 'Dee'], ['eve', 'Eve'], ['fay', 'Fay']]) {
    P[key] = await mgr.createPerson(`${name} Example`, { phone: `604-555-01${10 + Object.keys(P).length}`, tags: ['rules'] });
  }
});

test('gave: this year, before but not this year, never, at least $X in one year', async () => {
  ok(await gift('ana', 60_000, `${year}-01-01`));                    // $600 this year
  ok(await gift('ben', 5_000, `${year - 1}-06-01`));                 // $50 last year only
  ok(await gift('cy', 30_000, `${year - 1}-03-01`));                 // $300 + $250 in one earlier year
  ok(await gift('cy', 25_000, `${year - 1}-09-01`));
  ok(await gift('eve', 30_000, `${year - 1}-05-01`));                // $300 last year and $300 this year: never $500 in one
  ok(await gift('eve', 30_000, `${year}-01-01`));
  const voided = ok(await gift('fay', 90_000, `${year}-01-01`)).gift; // taken out of the books: as if never given
  ok(await mgr.action('gift.void', { id: voided.id }));
  assert.deepEqual(await who('gave=year'), ['Ana', 'Eve']);
  assert.deepEqual(await who('gave=lapsed'), ['Ben', 'Cy']);
  assert.deepEqual(await who('gave=never'), ['Dee', 'Fay']);
  assert.deepEqual(await who('gave=min:500'), ['Ana', 'Cy'], 'Cy’s two gifts in one year add up; Eve’s two years don’t');
  assert.deepEqual(await who('gave=min:600'), ['Ana']);
  assert.deepEqual(await who('gave=min:601'), []);
  for (const bad of ['gave=sometimes', 'gave=min:', 'gave=min:0', 'gave=min:-5', 'gave=min:abc']) assert.deepEqual(await who(bad), [], bad);
  // Everyone is exactly one of the three.
  const all = [...await who('gave=year'), ...await who('gave=lapsed'), ...await who('gave=never')].sort();
  assert.deepEqual(all, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay']);
});

test('member: a membership running today, or one that ended with none running', async () => {
  const term = (key, starts, ends, voided = false) => db.query(
    `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, source, voided_at)
     values ($1, $2, $3, 1, $4, $5, 'paper', case when $6 then now() end)`, [randomUUID(), ws, P[key].id, starts, ends, voided],
  );
  await term('ana', day(-30), day(335));                 // running
  await term('ben', day(-800), day(-435));               // ended, nothing since
  await term('cy', day(-400), day(-35));                 // ended…
  await term('cy', day(-34), day(331));                  // …and renewed
  await term('dee', day(-10), day(355), true);           // entered by mistake, voided
  await term('eve', day(-365), today);                   // ends today: still a member today
  assert.deepEqual(await who('member=now'), ['Ana', 'Cy', 'Eve']);
  assert.deepEqual(await who('member=lapsed'), ['Ben']);
  assert.deepEqual(await who('member=soon'), []);
});

test('answer: their latest answer to a survey question', async () => {
  const s = ok(await mgr.action('survey.create', { name: 'Doorstep issues' })).survey;
  const add = async (input) => ok(await mgr.action('survey.question.add', { survey_id: s.id, ...input })).question;
  const issue = await add({ kind: 'choice', text: 'What matters most?', options: ['Transit', 'Housing', 'Safety'] });
  const help = await add({ kind: 'choices', text: 'Which would you help with?', options: ['Lawn sign', 'Phone calls'] });
  const early = await add({ kind: 'yesno', text: 'Will you vote early?' });
  const likely = await add({ kind: 'scale', text: 'How likely are you to vote?' });
  const other = await add({ kind: 'text', text: 'Anything else?' });
  const say = (key, answers) => mgr.action('contact.log', { person_id: P[key].id, channel: 'door', outcome: 'contacted', answers });
  ok(await say('ana', [{ question_id: issue.id, value: 'Transit' }, { question_id: early.id, value: true }]));
  ok(await say('ben', [{ question_id: issue.id, value: 'Transit' }, { question_id: likely.id, value: 4 }, { question_id: help.id, value: ['Lawn sign', 'Phone calls'] }]));
  ok(await say('cy', [{ question_id: early.id, value: false }, { question_id: other.id, value: 'A bike lane on 72 Ave' }, { question_id: help.id, value: ['Phone calls'] }]));
  await new Promise((r) => { setTimeout(r, 15); });
  ok(await say('ana', [{ question_id: issue.id, value: 'Housing' }])); // Ana changed her mind at the next visit
  const a = (q, v) => who(`answer=${q.id}:${encodeURIComponent(v)}`);
  assert.deepEqual(await a(issue, 'Transit'), ['Ben'], 'Ana’s latest answer is Housing');
  assert.deepEqual(await a(issue, 'Housing'), ['Ana']);
  assert.deepEqual(await a(issue, 'any'), ['Ana', 'Ben']);
  assert.deepEqual(await a(help, 'Phone calls'), ['Ben', 'Cy'], 'one of several picked');
  assert.deepEqual(await a(help, 'Lawn sign'), ['Ben']);
  assert.deepEqual(await a(early, 'yes'), ['Ana']);
  assert.deepEqual(await a(early, 'no'), ['Cy']);
  assert.deepEqual(await a(likely, '4'), ['Ben']);
  assert.deepEqual(await a(likely, '5'), []);
  assert.deepEqual(await a(other, 'any'), ['Cy'], 'a short answer: answered it, or not');
  assert.deepEqual(await a(other, 'A bike lane on 72 Ave'), [], 'never by its words');
  assert.deepEqual(await a(issue, 'Parking'), [], 'not one of its choices');
  assert.deepEqual(await who(`answer=${randomUUID()}:any`), [], 'a question that isn’t this campaign’s');
  assert.deepEqual(await who('answer=nonsense'), []);
  const choices = ok(await mgr.get('/api/audience/choices'));
  assert.equal(choices.year, year);
  assert.deepEqual(choices.questions.map((q) => [q.text, q.kind, q.survey]).slice(0, 2),
    [['What matters most?', 'choice', 'Doorstep issues'], ['Which would you help with?', 'choices', 'Doorstep issues']]);
  assert.deepEqual(choices.questions[0].options, ['Transit', 'Housing', 'Safety']);
  assert.equal((await vol.get('/api/audience/choices')).status, 403);
});

test('shift: came to one, or missed one, in the last N days', async () => {
  const at = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
  const shift = async (title, offsetDays) => ok(await mgr.action('shift.create', { title, starts_at: at(offsetDays) })).shift;
  const put = async (s, key, status) => {
    const a = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: P[key].id }));
    if (status) ok(await mgr.action('shift.setStatus', { id: a.assignment.id, status }));
  };
  const recent = await shift('Canvass Newton', -5);
  const old = await shift('Canvass Fleetwood', -60);
  const next = await shift('Canvass Guildford', 3);
  await put(recent, 'ana', 'completed');
  await put(recent, 'ben', 'no_show');
  await put(recent, 'dee', null);                 // booked, never marked
  await put(old, 'cy', 'completed');
  await put(old, 'ana', 'no_show');
  await put(next, 'eve', 'completed');            // a shift that hasn't started doesn't count yet
  assert.deepEqual(await who('shift=came:30'), ['Ana']);
  assert.deepEqual(await who('shift=came:90'), ['Ana', 'Cy']);
  assert.deepEqual(await who('shift=missed:30'), ['Ben']);
  assert.deepEqual(await who('shift=missed:90'), ['Ana', 'Ben']);
  for (const bad of ['shift=came', 'shift=came:0', 'shift=came:9999', 'shift=slept:30']) assert.deepEqual(await who(bad), [], bad);
});

test('since: added on or after a day, in the campaign’s own calendar', async () => {
  await db.query(`update persons set created_at = now() - interval '10 days' where id = any($1::uuid[])`, [[P.ana.id, P.ben.id]]);
  assert.deepEqual(await who(`since=${day(-3)}`), ['Cy', 'Dee', 'Eve', 'Fay']);
  assert.deepEqual(await who(`since=${day(-30)}`), ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay']);
  assert.deepEqual(await who(`since=${day(1)}`), []);
  for (const bad of ['since=yesterday', 'since=2026-02-30', 'since=20261001', 'since=2026-13-01', 'since=2026-00-10', 'since=0000-00-00', 'since=0000-01-01', 'since=2026-01-99']) {
    assert.deepEqual(await who(bad), [], bad);
    assert.equal(ok(await mgr.get(`/api/persons/count?tag=rules&${bad}`)).total, 0, `${bad}: counted, not an error`);
  }
});

test('list and notlist: on another list as it stands, or not — a filter can stand on other lists', async () => {
  const donors = ok(await mgr.action('list.create', { name: 'Gave this year', kind: 'filter', filter: { tag: 'rules', gave: 'year' } })).list;
  const picked = ok(await mgr.action('list.create', { name: 'Hand-picked', kind: 'people', person_ids: [P.ana.id, P.ben.id, P.cy.id] })).list;
  assert.deepEqual(await who(`list=${donors.id}`), ['Ana', 'Eve']);
  assert.deepEqual(await who(`list=${picked.id}`), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(await who(`notlist=${picked.id}`), ['Dee', 'Eve', 'Fay']);
  assert.deepEqual(await who(`list=${picked.id}&notlist=${donors.id}`), ['Ben', 'Cy']);
  // A saved filter keeps the rule, and follows the other list as it changes.
  const both = ok(await mgr.action('list.create', { name: 'Picked, not yet given', kind: 'filter', filter: { list: picked.id, notlist: donors.id } })).list;
  assert.deepEqual(both.filter, { list: picked.id, notlist: donors.id });
  const names = async (id) => ok(await mgr.get(`/api/lists/${id}`)).people.map((p) => p.name.split(' ')[0]);
  assert.deepEqual(await names(both.id), ['Ben', 'Cy']);
  ok(await gift('ben', 2_500, `${year}-01-01`));
  assert.deepEqual(await names(both.id), ['Cy'], 'Ben gave: on the donors’ list now, so off this one');
  ok(await mgr.action('list.add', { id: picked.id, person_ids: [P.dee.id] }));
  assert.deepEqual(await names(both.id), ['Cy', 'Dee']);
  // "Not on a list" keeps someone the other list's rules can't say yes or no about (no rating: neither 1 nor not 1).
  const ones = ok(await mgr.action('list.create', { name: 'Rated 1', kind: 'filter', filter: { rating: '1' } })).list;
  ok(await mgr.action('contact.log', { person_id: P.fay.id, channel: 'door', outcome: 'contacted', rating: '1' }));
  assert.deepEqual(await who(`notlist=${ones.id}`), ['Ana', 'Ben', 'Cy', 'Dee', 'Eve']);
  // A list on a list on a list; one that leads back to itself names nobody, never everybody.
  const third = ok(await mgr.action('list.create', { name: 'Third', kind: 'filter', filter: { list: both.id } })).list;
  assert.deepEqual(await names(third.id), ['Cy', 'Dee']);
  ok(await mgr.action('list.update', { id: both.id, filter: { list: third.id } }));
  assert.deepEqual(await names(both.id), []);
  assert.deepEqual(await names(third.id), []);
  assert.deepEqual(await who(`notlist=${third.id}`), [], 'not “everyone”: a rule that can’t be read matches nobody');
  const self = ok(await mgr.action('list.create', { name: 'Self', kind: 'filter', filter: { tag: 'rules' } })).list;
  ok(await mgr.action('list.update', { id: self.id, filter: { tag: 'rules', list: self.id } }));
  assert.deepEqual(await names(self.id), []);
  // Gone, or not a list: nobody.
  ok(await mgr.action('list.delete', { id: picked.id }));
  assert.deepEqual(await who(`list=${picked.id}`), []);
  assert.deepEqual(await who(`notlist=${picked.id}`), []);
  assert.deepEqual(await who('list=everyone'), []);
});

test('a volunteer never sorts people by money, memberships, answers, attendance or the desk’s lists', async () => {
  const donors = (await mgr.get('/api/lists')).json.lists.find((l) => l.name === 'Gave this year');
  assert.deepEqual(await who(`list=${donors.id}`), ['Ana', 'Ben', 'Eve']);
  for (const q of ['gave=year', 'gave=never', 'gave=min:1', 'member=now', 'member=lapsed', 'shift=came:90', 'shift=missed:90', `list=${donors.id}`, `notlist=${donors.id}`]) {
    assert.deepEqual(await who(q, vol), [], `${q} for a volunteer`);
    assert.equal(ok(await vol.get(`/api/persons/count?tag=rules&${q}`)).total, 0, `${q}: no count either`);
  }
  const anyQ = (await db.query('select id from survey_questions where workspace_id = $1 limit 1', [ws])).rows[0].id;
  assert.deepEqual(await who(`answer=${anyQ}:any`, vol), []);
  assert.equal((await who(`since=${day(-3)}`, vol)).length, 4, 'when someone was added is no secret');
  assert.equal((await vol.get('/api/lists')).status, 403);
});

// A manager can give a volunteer the People area (and Map): they may then
// make lists, banks and passes — and still never learn who gave, who is a
// member, what anyone answered or who came to a shift by way of one.
test('a volunteer given People and Map still never reads the desk’s rules through a list, a phone bank or a sweep', async () => {
  const me = ok(await vol.get('/api/auth/me')).user;
  const donors = (await mgr.get('/api/lists')).json.lists.find((l) => l.name === 'Gave this year');
  ok(await mgr.action('permission.member.set', { user_id: me.id, grant: ['people', 'map'] }));
  try {
    // A list by a plain rule is theirs to make now…
    const plain = ok(await vol.action('list.create', { name: 'Vic’s rules list', kind: 'filter', filter: { tag: 'rules' } })).list;
    // …one by money, memberships, answers, attendance or another list never is.
    const anyQ = (await db.query('select id from survey_questions where workspace_id = $1 limit 1', [ws])).rows[0].id;
    const deskRules = [{ gave: 'year' }, { gave: 'min:5000' }, { member: 'now' }, { answer: `${anyQ}:any` }, { shift: 'came:30' }, { list: donors.id }, { notlist: donors.id }];
    for (const filter of deskRules) {
      const what = JSON.stringify(filter);
      assert.equal((await vol.action('list.create', { name: 'x', kind: 'filter', filter: { tag: 'rules', ...filter } })).status, 403, `list.create ${what}`);
      assert.equal((await vol.action('list.update', { id: plain.id, filter })).status, 403, `list.update ${what}`);
      assert.equal((await vol.action('list.snapshot', { name: 'x', filter })).status, 403, `list.snapshot ${what}`);
    }
    assert.equal((await vol.action('list.snapshot', { name: 'x', list_id: donors.id })).status, 403, 'a copy of the desk’s list');
    // A phone bank or a sweep from a list is the desk’s to make: handed to
    // themselves, it would read the list out to them.
    assert.equal((await vol.action('bank.create', { name: 'Donors to call', list_id: donors.id })).status, 403);
    assert.equal((await vol.action('bank.create', { name: 'Mine to call', list_id: plain.id })).status, 403);
    const byHand = ok(await vol.action('bank.create', { name: 'By hand', person_ids: [P.ana.id] })).bank;
    assert.equal(byHand.total, 1, 'people picked by hand still make a bank');
    const desks = ok(await mgr.action('bank.create', { name: 'Thank the donors', list_id: donors.id })).bank;
    assert.equal((await vol.action('bank.topup', { id: desks.id })).status, 403);
    assert.equal((await vol.action('pass.start', { name: 'Donor doors', kind: 'persuasion', list_id: donors.id })).status, 403);
    const pass = ok(await vol.action('pass.start', { name: 'Every door', kind: 'persuasion' })).pass;
    assert.equal((await vol.action('pass.update', { id: pass.id, list_id: donors.id })).status, 403);
    ok(await vol.action('pass.update', { id: pass.id, name: 'Every door, twice', list_id: null }));
    ok(await mgr.action('pass.end', { id: pass.id }));
    // What the desk makes and hands them is theirs to call, as before.
    ok(await mgr.action('bank.assign', { id: desks.id, user_id: me.id }));
    assert.deepEqual(ok(await vol.get(`/api/banks/${desks.id}/mine`)).persons.map((p) => p.name.split(' ')[0]), ['Ana', 'Ben', 'Eve']);
    ok(await mgr.action('bank.remove', { id: desks.id }));
    ok(await mgr.action('bank.remove', { id: byHand.id }));
    ok(await mgr.action('list.delete', { id: plain.id }));
  } finally {
    await mgr.action('permission.member.set', { user_id: me.id, grant: [] });
  }
  assert.equal((await vol.action('list.create', { name: 'x', kind: 'filter', filter: { tag: 'rules' } })).status, 403, 'the grant taken back');
});

// The desk's list under an open sweep or a phone bank is read with the
// desk's eyes. A volunteer given People must not be able to point it at
// what People hides from them (a money tag, the website's money forms, who
// has an email, a field not marked for volunteers) and read the answer off
// their walk list or their calls; and a list of their own is read with a
// volunteer's eyes, whoever walks or calls it later.
test('a volunteer given People never reads what People hides from them off a walk list or a call list', async () => {
  const me = ok(await vol.get('/api/auth/me')).user;
  await ensureSiteTables(db);
  const lat = 49.1327; const lng = -122.855;
  const mk = async (key, name, n, more = {}) => {
    P[key] = await mgr.createPerson(`${name} Example`, { phone: `604-555-016${n}`, address: `1321${n} 72 Ave`, lat, lng: lng + n * 0.0003, tags: ['chk'], ...more });
  };
  await mk('gus', 'Gus', 1, { tags: ['chk', 'donor'] });
  await mk('hal', 'Hal', 2, { email: `hal.rules.${tag}@example.org` });
  await mk('ida', 'Ida', 3);
  await mk('jo', 'Jo', 4);
  await siteAction(db, ws, { kind: 'donate', personId: P.ida.id });
  const hidden = ok(await mgr.action('field.create', { name: `Union ${tag}`, kind: 'yesno', volunteers: false })).field;
  ok(await mgr.action('field.values.set', { person_id: P.jo.id, values: [{ field_id: hidden.id, value: true }] }));
  const turf = ok(await mgr.action('turf.create', {
    name: 'Chk block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.003], [lat - 0.001, lng + 0.003], [lat - 0.001, lng - 0.001]],
  })).turf;
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: me.id }));
  const desks = ok(await mgr.action('list.create', { name: 'All chk', kind: 'filter', filter: { tag: 'chk' } })).list;
  const picked = ok(await mgr.action('list.create', { name: 'Chk by hand', kind: 'people', person_ids: [P.gus.id] })).list;
  const pass = ok(await mgr.action('pass.start', { name: 'Walk chk', kind: 'persuasion', list_id: desks.id })).pass;
  const bank = ok(await mgr.action('bank.create', { name: 'Call chk', list_id: desks.id })).bank;
  ok(await mgr.action('bank.assign', { id: bank.id, user_id: me.id }));
  const walked = async () => ok(await vol.get(`/api/turfs/${turf.id}/walk`)).doors.flatMap((d) => d.persons.filter((p) => p.pass_listed).map((p) => p.name.split(' ')[0])).sort();
  const called = async () => ok(await vol.get(`/api/banks/${bank.id}/mine`)).persons.map((p) => p.name.split(' ')[0]).sort();
  const all = ['Gus', 'Hal', 'Ida', 'Jo'];
  // What People hides from a volunteer, each as a rule (the desk reads one person by it).
  const secrets = [
    [{ tag: 'donor' }, ['Gus']], [{ tag: 'chk', notag: 'donor' }, ['Hal', 'Ida', 'Jo']],
    [{ tag: 'chk', web: 'donate' }, ['Ida']], [{ tag: 'chk', has: 'email' }, ['Hal']], [{ tag: 'chk', q: 'hal.rules' }, ['Hal']],
    [{ tag: 'chk', field: `${hidden.id}:yes` }, ['Jo']],
  ];
  ok(await mgr.action('permission.member.set', { user_id: me.id, grant: ['people', 'map'] }));
  try {
    assert.deepEqual(await walked(), all);
    assert.deepEqual(await called(), all);
    // The desk's lists are not theirs to change, by rule or by hand.
    for (const [filter] of secrets) {
      assert.equal((await vol.action('list.update', { id: desks.id, filter })).status, 403, `list.update ${JSON.stringify(filter)}`);
    }
    assert.equal((await vol.action('list.update', { id: desks.id, name: 'Mine now' })).status, 403);
    assert.equal((await vol.action('list.add', { id: picked.id, person_ids: [P.hal.id] })).status, 403);
    assert.equal((await vol.action('list.remove', { id: picked.id, person_ids: [P.gus.id] })).status, 403);
    assert.equal((await vol.action('list.delete', { id: picked.id })).status, 403);
    assert.deepEqual(await walked(), all, 'the desk’s list still names who it named');
    assert.deepEqual(await called(), all);
    assert.deepEqual(ok(await mgr.get(`/api/lists/${desks.id}`)).list.filter, { tag: 'chk' });
    // A list of their own keeps a volunteer's eyes: put under a sweep and a
    // bank by the desk, a hidden rule names nobody — as People does for them.
    const own = ok(await vol.action('list.create', { name: 'Vic’s chk', kind: 'filter', filter: { tag: 'chk' } })).list;
    ok(await mgr.action('pass.update', { id: pass.id, list_id: own.id }));
    const theirs = ok(await mgr.action('bank.create', { name: 'Call Vic’s chk', list_id: own.id })).bank;
    ok(await mgr.action('bank.assign', { id: theirs.id, user_id: me.id }));
    const calledOwn = async () => ok(await vol.get(`/api/banks/${theirs.id}/mine`)).persons.map((p) => p.name.split(' ')[0]).sort();
    assert.deepEqual(await walked(), all);
    assert.equal(ok(await mgr.get(`/api/lists/${own.id}`)).list.by_volunteer, true, 'the desk’s page says whose it is');
    for (const [filter, desk] of secrets) {
      const what = JSON.stringify(filter);
      const asked = new URLSearchParams(filter).toString();
      const sees = ok(await vol.get(`/api/persons?limit=50&${asked}`)).persons.map((p) => p.name.split(' ')[0]).sort();
      assert.deepEqual(ok(await mgr.get(`/api/persons?limit=50&${asked}`)).persons.map((p) => p.name.split(' ')[0]).sort(), desk, `the desk, ${what}`);
      ok(await vol.action('list.update', { id: own.id, filter }));
      assert.deepEqual(await walked(), sees, `walk list, ${what}: what People shows them, no more`);
      assert.deepEqual(await calledOwn(), sees, `calls, ${what}`);
      assert.equal(ok(await mgr.get(`/api/lists/${own.id}`)).total, sees.length, `the desk’s page of it reads the same, ${what}`);
    }
    // The desk makes the rule its own by saving it: read with the desk's eyes again.
    ok(await mgr.action('list.update', { id: own.id, filter: { tag: 'chk', has: 'email' } }));
    const adopted = ok(await mgr.get(`/api/lists/${own.id}`));
    assert.deepEqual([adopted.people.map((p) => p.name.split(' ')[0]), adopted.list.by_volunteer], [['Hal'], false]);
    // …and from then on it is no longer the volunteer's to re-point.
    assert.equal((await vol.action('list.update', { id: own.id, filter: { tag: 'chk' } })).status, 403);
    ok(await mgr.action('pass.end', { id: pass.id }));
    ok(await mgr.action('bank.remove', { id: bank.id }));
    ok(await mgr.action('bank.remove', { id: theirs.id }));
  } finally {
    await mgr.action('permission.member.set', { user_id: me.id, grant: [] });
  }
});

test('a saved filter keeps the new rules; unknown keys are dropped; placeholders move without touching quoted text', () => {
  for (const k of ['gave', 'member', 'answer', 'shift', 'since', 'list', 'notlist']) assert.ok(FILTER_KEYS.includes(k), k);
  assert.deepEqual(cleanFilter({ gave: ' year ', member: 'now', bogus: 'x', since: '' }), { gave: 'year', member: 'now' });
  assert.equal(shiftParams("p.a = $1 and p.b ~ 'x$2.*$' and p.c = any($12::uuid[]) and p.d = 'it''s $3'", 5),
    "p.a = $6 and p.b ~ 'x$2.*$' and p.c = any($17::uuid[]) and p.d = 'it''s $3'");
});
