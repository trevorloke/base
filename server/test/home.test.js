// Today's win number (ext/pathtowin/brief.js → GET /api/brief goal): the
// desk people who may open Path to win see supporters against the first set
// race's win number, the days left and the weekly pace, by the same clock
// and the same supporters rule as Path to win and a candidate's Your race —
// and the brief adds no count over the people for it. The desk's whole-list
// counts are kept half a minute per campaign and dropped by any write to a
// person (ext/todaycounts). Made-up people throughout.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { winNumber } from '../ext/pathtowin/rules.js';
import { raceNow } from '../ext/pathtowin/api.js';
import { deps, briefGoal } from '../ext/pathtowin/brief.js';

process.env.STARBASE_PTW_CACHE_MS = '0';

const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)?.slice(0, 400)}`); return r.json; };
let db, mgr, staff, noData, vol, ws;

const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name.toLowerCase()}.home@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'home-page-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  cl.id = r.json.user.id;
  return cl;
};
const brief = async (cl = mgr) => ok(await cl.get('/api/brief'));
const ctxOf = () => ({ workspaceId: ws, workspace: { settings: {} } });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Home page', email: 'mgr.home@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
  staff = await joinAs('staff', 'Sam');
  noData = await joinAs('staff', 'Dana');
  ok(await mgr.action('permission.member.set', { user_id: noData.id, grant: [], deny: ['data'] }));
  vol = await joinAs('volunteer', 'Vic');
  // Seven supporters (four 1s, three 2s), two undecided, one opposed.
  const ratings = ['1', '1', '1', '1', '2', '2', '2', '3', '3', '4'];
  for (const [i, rating] of ratings.entries()) {
    const p = ok(await mgr.action('person.create', { name: `Home ${i + 1} Example` })).person;
    ok(await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating }));
  }
});

test('nothing set: a manager may set it, staff may not; no win number', async () => {
  assert.deepEqual((await brief()).goal, { set: false, supporters: 7, can_set: true });
  assert.deepEqual((await brief(staff)).goal, { set: false, supporters: 7, can_set: false });
});

test('staff denied Data and a volunteer get no goal at all', async () => {
  assert.equal('goal' in (await brief(noData)), false);
  assert.equal('goal' in (await brief(vol)), false);
  assert.equal(typeof (await brief(noData)).ratings['1'], 'number', 'the plain count is still theirs');
});

test('one race set: supporters, needed and the days, as Path to win and Your race have them', async () => {
  ok(await mgr.action('pathtowin.save', { election_day: '2027-10-16', races: { council: { how: 'direct', votes: 40, vote_rate: 80 } } }));
  const g = (await brief()).goal;
  const ptw = ok(await mgr.get('/api/pathtowin?fresh=1'));
  const race = await raceNow(db, ctxOf(), 'council');
  assert.equal(g.set, true);
  assert.equal(g.race, 'council');
  assert.equal(g.label, 'City council');
  assert.equal(g.needed, winNumber({ how: 'direct', votes: 40, vote_rate: 80 }).supporters);
  assert.equal(g.needed, 50);
  assert.equal(g.supporters, ptw.standing.supporters);
  assert.equal(g.supporters, race.supporters);
  assert.equal(g.supporters, 7);
  assert.equal(g.still, 43);
  assert.equal(g.pct, 14);
  assert.equal(g.days_left, race.days_left, 'the same clock as Your race');
  assert.equal(g.days_left, ptw.election.days_left);
  assert.ok(g.days_left > 0);
  assert.equal(g.per_week_needed, Math.ceil((43 * 7) / g.days_left));
  assert.equal(g.others, 0);
});

test('GOTV’s election day wins over Path to win’s; neither: no days', async () => {
  ok(await mgr.action('vote.settings', { on: false, election_day: '2027-10-23' }));
  const g = (await brief()).goal;
  assert.equal(g.days_left, (await raceNow(db, ctxOf(), 'council')).days_left);
  assert.equal(g.days_left, ok(await mgr.get('/api/pathtowin')).election.days_left);
  ok(await mgr.action('vote.settings', { on: false, election_day: null }));
  const back = (await brief()).goal;
  assert.equal(back.days_left, g.days_left - 7, 'Path to win’s own day, a week earlier');
  ok(await mgr.action('pathtowin.save', { election_day: null }));
  const none = (await brief()).goal;
  assert.equal(none.days_left, null);
  assert.equal(none.per_week_needed, null);
  ok(await mgr.action('pathtowin.save', { election_day: '2027-10-16' }));
});

test('two races set: the first in the race list, one more on Path to win', async () => {
  ok(await mgr.action('pathtowin.save', { races: { school_board: { how: 'direct', votes: 30 } } }));
  let g = (await brief()).goal;
  assert.equal(g.race, 'council');
  assert.equal(g.others, 1);
  ok(await mgr.action('pathtowin.save', { races: { council: null } }));
  g = (await brief()).goal;
  assert.equal(g.race, 'school_board');
  assert.equal(g.label, 'School board');
  assert.equal(g.needed, 30);
  assert.equal(g.others, 0);
  ok(await mgr.action('pathtowin.save', { races: { council: { how: 'direct', votes: 40, vote_rate: 80 } } }));
});

test('a failure reading the numbers: the brief still answers, goal unavailable', async () => {
  const real = deps.readSettings;
  deps.readSettings = async () => { throw new Error('made-up failure'); };
  const err = console.error;
  console.error = () => {};
  try {
    const b = await brief();
    assert.deepEqual(b.goal, { unavailable: true });
    assert.equal(b.ratings['1'], 4, 'the rest of Today is there');
  } finally {
    deps.readSettings = real;
    console.error = err;
  }
});

// Counts every query the brief runs, and which of them count over persons.
const watched = async (fn) => {
  const asked = [];
  const real = db.query;
  db.query = async (sql, ...rest) => { asked.push(String(sql).replace(/\s+/g, ' ')); return real.call(db, sql, ...rest); };
  try { return { answer: await fn(), asked }; } finally { db.query = real; }
};
const overPersons = (asked) => asked.filter((q) => /from persons\b/i.test(q) && /count\s*\(/i.test(q));

test('the goal costs at most three queries, none over persons', async () => {
  const asked = [];
  const q = { query: (sql, ...rest) => { asked.push(String(sql).replace(/\s+/g, ' ')); return db.query(sql, ...rest); } };
  const body = { ratings: { 1: 4, 2: 3 } };
  await briefGoal(q, { role: 'manager', workspaceId: ws, workspace: { settings: {} } }, body);
  assert.equal(body.goal.set, true);
  assert.equal(body.goal.supporters, 7);
  assert.ok(asked.length <= 3, asked.join('\n'));
  assert.deepEqual(asked.filter((x) => /\bpersons\b/i.test(x)), []);
});

test('a desk reloading Today counts nothing over the list; a write shows at once', async () => {
  // A fresh campaign whose people came in straight to the table (no write
  // through an action, so nothing has dropped its counts lately).
  const m2 = new Client();
  const w2 = (await m2.signup({ workspaceName: 'Home kept', email: 'mgr.kept@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
  await db.query(
    `insert into persons (id, workspace_id, name, rating) select gen_random_uuid(), $1, 'Kept ' || g || ' Example', case when g % 2 = 0 then '1' end from generate_series(1, 20) g`,
    [w2],
  );
  const first = await watched(async () => ok(await m2.get('/api/brief')));
  assert.equal(first.answer.people.total, 20);
  assert.equal(first.answer.ratings['1'], 10);
  const again = await watched(async () => ok(await m2.get('/api/brief')));
  assert.deepEqual(overPersons(again.asked), [], 'kept: no count over persons');
  assert.equal(again.answer.people.total, 20);
  assert.equal(again.answer.ratings['1'], 10);
  // Their own new supporter shows on the next Today.
  const p = ok(await m2.action('person.create', { name: 'Kept New Example' })).person;
  ok(await m2.action('contact.log', { person_id: p.id, channel: 'phone', outcome: 'contacted', rating: '2' }));
  const after = ok(await m2.get('/api/brief'));
  assert.equal(after.people.total, 21);
  assert.equal(after.ratings['2'], 1);
});
