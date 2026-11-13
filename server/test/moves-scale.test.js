// "Needs an address" on a city's voter file: 300,000 people (Surrey's is
// about that), 30,000 knocks, 2,000 of them the team's Moved taps and 200
// of those already moved, plus 5,000 "Moved" brought in from an old list's
// history (never in the queue). movedCounts and People's first page of
// moved=open each come back quickly, and the plan starts from the Moved
// taps' own index (contacts_moved_idx), never reading the whole list.
// MOVES_PEOPLE sets a smaller list for a quick run; MOVES_MS the budget.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { movedCounts, movedOpenIds, movedOpenWhere } from '../ext/moves/index.js';

const PEOPLE = Number(process.env.MOVES_PEOPLE) || 300_000;
const MS = Number(process.env.MOVES_MS) || 300;
let db, mgr, ws;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Moves at scale', email: 'moves-scale@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
  await db.query(
    `insert into persons (id, workspace_id, name, address, city, created_at)
     select gen_random_uuid(), $1, 'Voter ' || g || ' Example', g || ' Example St', 'Surrey', now() - make_interval(secs => g)
       from generate_series(1, $2::int) g`,
    [ws, PEOPLE],
  );
  // Every tenth person knocked once; 2,000 of them the team's Moved.
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, created_at)
     select gen_random_uuid(), $1, id, 'door', case when rn <= 2000 then 'moved' else 'no_answer' end, now() - interval '1 day'
       from (select id, row_number() over (order by id) as rn from persons where workspace_id = $1) p where rn % 10 = 0 or rn <= 2000`,
    [ws],
  );
  // An old list's Moved history: not the team's.
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, source, created_at)
     select gen_random_uuid(), $1, id, 'door', 'moved', 'import', now() - interval '400 days'
       from (select id, row_number() over (order by id desc) as rn from persons where workspace_id = $1) p where rn <= 5000`,
    [ws],
  );
  // 200 of the Moved already have an address (or Address unknown).
  await db.query(
    `insert into person_moves (id, workspace_id, person_id, reason, result, from_address, created_at)
     select gen_random_uuid(), $1, c.person_id, 'moved', 'unknown', 'x', now()
       from (select person_id from contacts where workspace_id = $1 and outcome = 'moved' and source is null order by person_id limit 200) c`,
    [ws],
  );
  await db.query('analyze persons'); await db.query('analyze contacts'); await db.query('analyze person_moves');
});

const timed = async (fn) => { await fn(); const t = Date.now(); const v = await fn(); return [v, Date.now() - t]; };

test(`movedCounts and the first People page of moved=open: under ${MS} ms each`, async (t) => {
  const [c, ms] = await timed(() => movedCounts(db, ws));
  assert.equal(c.open, 1800);
  assert.ok(ms < MS, `movedCounts took ${ms} ms`);
  const [r, pms] = await timed(() => mgr.get('/api/persons?moved=open'));
  assert.equal(r.status, 200);
  assert.ok(r.json.persons.length > 0);
  assert.ok(pms < MS, `the first page took ${pms} ms`);
  t.diagnostic(`movedCounts ${ms} ms · first page ${pms} ms`);
  const ids = await movedOpenIds(db, ws);
  assert.equal(ids.length, c.open, 'the ids and the count agree');
});

test('the plan starts from the Moved taps’ index and never reads the whole list', async () => {
  const plan = (await db.query(
    `explain select count(*) from persons p where p.workspace_id = $1 and p.deleted_at is null and ${movedOpenWhere('p', '$1')}`, [ws],
  )).rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.match(plan, /contacts_moved_idx/, plan);
  assert.doesNotMatch(plan, /Seq Scan on persons/, plan);
});
