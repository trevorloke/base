// Path to win at a city's scale: a 300,000-person voter file (Surrey's is
// about that), a third of them knocked or called, forty turfs covering the
// city. The counts are made in SQL — turf by turf from the turf's corners
// (persons_ws_geo_idx), Postgres's own polygon test, one pass over the
// contacts — and kept for a minute, so the desk's second look is instant.
// PATHTOWIN_PEOPLE sets a smaller list for a quick run.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const PEOPLE = Number(process.env.PATHTOWIN_PEOPLE) || 300_000;
// Generous for a slow test machine and the in-memory database (an embedded
// Postgres compiled to WebAssembly, several times slower than a hosted one).
const COLD_MS = Number(process.env.PATHTOWIN_COLD_MS) || 30_000;
const WARM_MS = 400;

let mgr, ws, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 300)); return r.json; };

before(async () => {
  process.env.STARBASE_PTW_CACHE_MS = '60000';
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Path to win at scale', email: 'ptw-scale@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
  // A grid over the city: 600 rows by 500 columns, two people a door; one
  // in 7 a strong yes, then 1 in 11 a lean yes, 1 in 13 undecided, 1 in 17
  // opposed (a made-up spread).
  await db.query(
    `insert into persons (id, workspace_id, name, address, lat, lng, rating, created_at)
     select gen_random_uuid(), $1, 'Voter ' || g || ' Example', (g / 2) || ' Example St',
            49.0 + ((g % 600) * 0.22 / 600) + 0.0001, -122.93 + ((g / 600) * 0.25 / 500) + 0.0001,
            case when g % 7 = 0 then '1' when g % 11 = 0 then '2' when g % 13 = 0 then '3' when g % 17 = 0 then '4' end,
            now() - interval '200 days'
       from generate_series(0, $2::int - 1) g`,
    [ws, PEOPLE],
  );
  // A third have a contact: four in five at the door, over the last 100 days,
  // with the rating they have now.
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, rating, created_at)
     select gen_random_uuid(), $1, id, case when h % 5 = 0 then 'phone' else 'door' end, 'contacted', rating,
            now() - make_interval(days => h % 100)
       from (select id, rating, abs(hashtext(id::text)) as h from persons where workspace_id = $1) p
      where h % 3 = 0`,
    [ws],
  );
  // Forty turfs, eight rows of five, each a six-cornered block.
  for (let i = 0; i < 8; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      const s = 49.0 + i * 0.0275; const w = -122.93 + j * 0.05;
      ok(await mgr.action('turf.create', {
        name: `Block ${i + 1}-${j + 1}`,
        polygon: [[s, w], [s, w + 0.05], [s + 0.01, w + 0.05], [s + 0.0275, w + 0.05], [s + 0.0275, w], [s + 0.01, w]],
      }));
    }
  }
});

test(`${PEOPLE.toLocaleString('en-CA')} people, forty turfs: counted in SQL, then kept`, async () => {
  const t0 = performance.now();
  const cold = ok(await mgr.get('/api/pathtowin'));
  const coldMs = performance.now() - t0;
  console.log(`  cold: ${Math.round(coldMs)} ms for ${PEOPLE} people`);
  assert.ok(coldMs < COLD_MS, `the first count took ${Math.round(coldMs)} ms`);
  assert.equal(cold.standing.people, PEOPLE);
  assert.equal(cold.turfs.length, 40);
  const inside = cold.turfs.reduce((a, t) => a + t.people, 0);
  assert.ok(inside >= PEOPLE * 0.98 && inside <= PEOPLE, `the turfs cover the grid: ${inside} of ${PEOPLE}`);
  assert.ok(cold.turfs.every((t) => t.knocked > 0 && t.doors > t.knocked), 'every block has doors knocked and doors left');
  assert.ok(cold.campaign_rate > 0);
  assert.deepEqual(cold.turfs.map((t) => t.rank), cold.turfs.map((_, i) => i + 1));
  assert.ok(cold.turfs.every((t, i) => i === 0 || cold.turfs[i - 1].score >= t.score), 'best first');
  assert.equal(cold.trend.length, 12);
  assert.equal(cold.trend.at(-1).supporters, cold.standing.supporters, 'this week’s count is the people on file now');

  const t1 = performance.now();
  const warm = ok(await mgr.get('/api/pathtowin'));
  const warmMs = performance.now() - t1;
  console.log(`  warm: ${Math.round(warmMs)} ms`);
  assert.ok(warmMs < WARM_MS, `the second look took ${Math.round(warmMs)} ms`);
  assert.equal(warm.computed_at, cold.computed_at, 'kept, not counted again');
});
