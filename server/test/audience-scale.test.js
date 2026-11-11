// The new People rules on a city's voter file: 300,000 people (Surrey's is
// about that), with gifts, memberships, survey answers, shifts and lists in
// the proportions a campaign has them. Each rule is found through an index
// (ext/audience's on gifts, shift assignments and when someone was added;
// ext/surveys' on a question's answers; memberships' and lists' own): with
// sequential scans switched off, its count's plan reads every table through
// one. And each count comes back quickly with the planner left to itself.
// AUDIENCE_PEOPLE sets a smaller list for a quick run.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { personsWhere } from '../lib/audience.js';
import { todayOf } from '../ext/audience/index.js';

const PEOPLE = Number(process.env.AUDIENCE_PEOPLE) || 300_000;
// Generous for a slow test machine and the in-memory database (an embedded
// Postgres compiled to WebAssembly, several times slower than a hosted one).
const COUNT_MS = Number(process.env.AUDIENCE_COUNT_MS) || 15_000;

let db, mgr, ws, ctx;
const ids = {};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 300)); return r.json; };
// This year in the campaign's own calendar, as the rules count it.
const year = Number(todayOf({}).slice(0, 4));

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Audience at scale', email: 'audience-scale@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
  ctx = { workspaceId: ws, role: 'manager', workspace: { settings: {} }, user: { email: 'audience-scale@example.org' } };
  await db.query(
    `insert into persons (id, workspace_id, name, phone, email, rating, created_at)
     select gen_random_uuid(), $1, 'Voter ' || g || ' Example',
            case when g % 5 <> 0 then '604-555-' || lpad((g % 10000)::text, 4, '0') end,
            case when g % 2 = 0 then 'v' || g || '@example.org' end,
            case when g % 7 = 0 then '1' when g % 11 = 0 then '2' end,
            now() - make_interval(days => g % 400)
       from generate_series(1, $2::int) g`,
    [ws, PEOPLE],
  );
  // Every fortieth person gave last year; every eightieth this year too.
  await db.query(
    `insert into gifts (id, workspace_id, person_id, amount_cents, date, method)
     select gen_random_uuid(), $1, id, 10000 + (h / 40 % 5) * 10000, make_date($2::int - 1, 1 + h / 40 % 12, 1), 'cheque'
       from (select id, abs(hashtext(id::text)) as h from persons where workspace_id = $1) p where h % 40 = 0
     union all
     select gen_random_uuid(), $1, id, 5000, make_date($2::int, 1, 1), 'card'
       from (select id, abs(hashtext(id::text)) as h from persons where workspace_id = $1) p where h % 80 = 0`,
    [ws, year],
  );
  // Every hundredth a member: half running, half ended.
  await db.query(
    `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, source)
     select gen_random_uuid(), $1, id, 1, current_date - 400 + (h / 100 % 2) * 300, current_date - 35 + (h / 100 % 2) * 300, 'paper'
       from (select id, abs(hashtext(id::text)) as h from persons where workspace_id = $1) p where h % 100 = 0`,
    [ws],
  );
  // A survey of five questions, answered at one door in thirty.
  const s = ok(await mgr.action('survey.create', { name: 'Doorstep issues' })).survey;
  const qs = [];
  for (const text of ['What matters most?', 'And next?', 'Your street’s worry?', 'The city’s worry?', 'What would you fix?']) {
    qs.push(ok(await mgr.action('survey.question.add', { survey_id: s.id, kind: 'choice', text, options: ['Transit', 'Housing'] })).question.id);
  }
  ids.question = qs[0];
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, created_at)
     select gen_random_uuid(), $1, id, 'door', 'contacted', now() - make_interval(days => h % 90)
       from (select id, abs(hashtext(id::text)) as h from persons where workspace_id = $1) p where h % 30 = 0`,
    [ws],
  );
  await db.query(
    `insert into survey_responses (id, workspace_id, survey_id, question_id, contact_id, person_id, value, created_at)
     select gen_random_uuid(), $1, $2, q, c.id, c.person_id, case when abs(hashtext(c.id::text || q::text)) % 2 = 0 then '"Transit"' else '"Housing"' end::jsonb, c.created_at
       from contacts c cross join unnest($3::uuid[]) q where c.workspace_id = $1`,
    [ws, s.id, qs],
  );
  // Twenty shifts over the last sixty days; one person in three hundred on one, came or missed.
  await db.query(
    `insert into shifts (id, workspace_id, title, starts_at)
     select gen_random_uuid(), $1, 'Canvass ' || g, now() - make_interval(days => g * 3) from generate_series(1, 20) g`,
    [ws],
  );
  await db.query(
    `insert into shift_assignments (id, workspace_id, shift_id, person_id, status)
     select gen_random_uuid(), $1, (select id from shifts where workspace_id = $1 order by starts_at offset (p.h / 300 % 20) limit 1), p.id,
            case when p.h / 300 % 2 = 0 then 'completed' else 'no_show' end
       from (select id, abs(hashtext(id::text)) as h from persons where workspace_id = $1) p where p.h % 300 = 0`,
    [ws],
  );
  // A saved filter and a hand-picked list of one person in two hundred.
  ids.ones = ok(await mgr.action('list.create', { name: 'Rated 1', kind: 'filter', filter: { rating: '1' } })).list.id;
  ids.picked = ok(await mgr.action('list.create', { name: 'Picked', kind: 'people' })).list.id;
  await db.query(
    `insert into list_members (list_id, workspace_id, person_id)
     select $2, $1, id from (select id, abs(hashtext(id::text)) as h from persons where workspace_id = $1) p where h % 200 = 0`,
    [ws, ids.picked],
  );
  for (const t of ['persons', 'gifts', 'member_terms', 'contacts', 'survey_responses', 'shifts', 'shift_assignments', 'list_members']) await db.query(`analyze ${t}`);
});

// Each rule, the table it reads beside persons, and the index that finds it there.
const RULES = () => [
  ['gave=year', { gave: 'year' }, /gifts_ws_person_date_idx|gifts_ws_idx/],
  ['gave=lapsed', { gave: 'lapsed' }, /gifts_ws_person_date_idx|gifts_ws_idx/],
  ['gave=never', { gave: 'never' }, /gifts_ws_person_date_idx|gifts_ws_idx/],
  ['gave=min:300', { gave: 'min:300' }, /gifts_ws_person_date_idx|gifts_ws_idx/],
  ['member=now', { member: 'now' }, /member_terms_(person|ends)_idx/],
  ['member=lapsed', { member: 'lapsed' }, /member_terms_(person|ends)_idx/],
  ['answer', { answer: `${ids.question}:Transit` }, /survey_responses_question_idx/],
  ['shift=came:30', { shift: 'came:30' }, /sassign_ws_person_idx|sassign_ws_shift_idx|shift_assignments_shift_id_person_id_key/],
  ['shift=missed:30', { shift: 'missed:30' }, /sassign_ws_person_idx|sassign_ws_shift_idx|shift_assignments_shift_id_person_id_key/],
  ['since', { since: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10) }, /persons_created_brin_idx/],
  ['list (a saved filter)', { list: ids.ones }, /persons_/],
  ['notlist (a saved filter)', { notlist: ids.ones }, /persons_/],
  ['list (hand-picked)', { list: ids.picked }, /list_members_pkey/],
  ['notlist (hand-picked)', { notlist: ids.picked }, /list_members_pkey/],
];
const countSql = async (query) => {
  const { where, params } = await personsWhere(db, ctx, query);
  params[3] = 1;
  return { sql: `select count(*)::int as n from persons p where ${where}`, params };
};

test(`${PEOPLE.toLocaleString('en-CA')} people: every new rule is found through an index`, async () => {
  for (const [name, query, index] of RULES()) {
    const { sql, params } = await countSql(query);
    const plan = await db.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      return (await tx.query(`explain ${sql}`, params)).rows.map((r) => Object.values(r)[0]).join('\n');
    });
    assert.doesNotMatch(plan, /Seq Scan/, `${name}: a table read end to end\n${plan}`);
    assert.match(plan, index, `${name}\n${plan}`);
  }
});

test(`${PEOPLE.toLocaleString('en-CA')} people: each rule’s count comes back quickly, and right`, async () => {
  const counts = {};
  for (const [name, query] of RULES()) {
    const { sql, params } = await countSql(query);
    const t0 = performance.now();
    counts[name] = (await db.query(sql, params)).rows[0].n;
    const ms = performance.now() - t0;
    console.log(`  ${name}: ${counts[name].toLocaleString('en-CA')} in ${Math.round(ms)} ms`);
    assert.ok(ms < COUNT_MS, `${name} took ${Math.round(ms)} ms`);
  }
  const n = async (sql, params = [ws]) => Number((await db.query(sql, params)).rows[0].n);
  const donors = await n('select count(distinct person_id) as n from gifts where workspace_id = $1');
  assert.equal(counts['gave=year'], await n(`select count(distinct person_id) as n from gifts where workspace_id = $1 and date >= make_date(${year}, 1, 1)`));
  assert.equal(counts['gave=year'] + counts['gave=lapsed'], donors, 'a donor gave this year, or before and not since');
  assert.equal(counts['gave=never'], PEOPLE - donors);
  assert.equal(counts['member=now'] + counts['member=lapsed'], await n('select count(distinct person_id) as n from member_terms where workspace_id = $1'));
  assert.equal(counts.answer, await n(`select count(*) as n from survey_responses where workspace_id = $1 and question_id = $2 and value = '"Transit"'`, [ws, ids.question]));
  assert.equal(counts['list (hand-picked)'] + counts['notlist (hand-picked)'], PEOPLE);
  assert.equal(counts['list (a saved filter)'], await n(`select count(*) as n from persons where workspace_id = $1 and rating = '1'`));
  assert.ok(counts['shift=came:30'] > 0 && counts['shift=missed:30'] > 0 && counts.since > 0);
  // The People total and a list's numbers, over the whole file.
  const t1 = performance.now();
  assert.equal(ok(await mgr.get('/api/persons/count')).total, PEOPLE);
  console.log(`  People's total: ${Math.round(performance.now() - t1)} ms`);
  const t2 = performance.now();
  const all = ok(await mgr.action('list.create', { name: 'Everyone', kind: 'filter', filter: {} })).list;
  const listCounts = ok(await mgr.get(`/api/lists/${all.id}/counts`)).counts;
  console.log(`  a list of everyone, its numbers: ${Math.round(performance.now() - t2)} ms`);
  assert.equal(listCounts.total, PEOPLE);
  assert.ok(listCounts.with_phone > 0 && listCounts.with_email > 0 && listCounts.reachable <= PEOPLE);
});

test('a snapshot of the whole file is one write', async () => {
  const t0 = performance.now();
  const snap = ok(await mgr.action('list.snapshot', { name: `Everyone on ${new Date().toISOString().slice(0, 10)}`, filter: {} }));
  console.log(`  a snapshot of ${snap.added.toLocaleString('en-CA')}: ${Math.round(performance.now() - t0)} ms`);
  assert.equal(snap.added, PEOPLE);
  assert.equal(Number((await db.query('select count(*) as n from list_members where list_id = $1', [snap.list.id])).rows[0].n), PEOPLE);
  assert.equal((await mgr.action('list.snapshot', { name: 'x', list_id: randomUUID() })).status, 404);
});
