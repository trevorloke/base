// How fast Quick reports are on a city's voter file: 300,000 made-up people
// in a scratch Postgres, with 20,000 donors, 2,000 people interested in
// being a candidate, 3,000 volunteers (by role and by tag), 3,000 members,
// 2,000 signs and 2,000 Moved marks. Each read five times, warm; the median
// and the slowest, against REP's budget (TESTING.md):
//   count            median ≤ 150 ms, none over 400
//   a 2,000-row page with its total   median ≤ 300 ms, none over 800
//   a walking list of ~300 doors      ≤ 300 ms
//   a turf round the whole city       the 409 in ≤ 100 ms
//   the donors CSV (20,000 rows)      the heap grows by under 50 MB
//
//   node scripts/bench-quick.mjs postgres://…/quick_bench [people]
// Refuses a database whose name doesn't say bench or scratch, or that holds
// any campaign: it fills one with 300,000 people.
import pg from 'pg';

const url = process.argv[2];
const N = Number(process.argv[3]) || 300_000;
if (!url) { console.error('usage: node scripts/bench-quick.mjs <DATABASE_URL> [people]'); process.exit(2); }
const dbName = new URL(url).pathname.slice(1);
if (!/bench|scratch/i.test(dbName)) { console.error(`refused: "${dbName}" doesn't say bench or scratch`); process.exit(2); }
{
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const has = await c.query("select to_regclass('public.workspaces') is not null as t");
  const n = has.rows[0].t ? Number((await c.query('select count(*) from workspaces')).rows[0].count) : 0;
  await c.end();
  if (n) { console.error(`refused: "${dbName}" already holds ${n} campaign(s)`); process.exit(2); }
}
process.env.DATABASE_URL = url;
process.env.STARBASE_OPEN_SIGNUP = '1';
process.env.GEOCODE_ON_SAVE = 'off';
const { app } = await import('../server/index.js');
const { getDb } = await import('../server/db/client.js');

const db = await getDb();
let cookie = '';
const req = async (path, opts = {}) => {
  const res = await app.request(path, { ...opts, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
};
const signup = await (await req('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Bench Example', email: 'quick-bench@example.org', password: 'quick-bench-2026', workspaceName: 'Quick bench', jurisdiction: 'bc-municipal' }) })).json();
const ws = signup.workspace.id;
const S = 49.0; const W = -122.9; const SPAN = 0.22;
let t0 = performance.now();
// People spread over a city-sized box; a door each, on 300 streets.
await db.query(
  `insert into persons (id, workspace_id, name, first_name, last_name, phone, email, address, house_number, city, lat, lng, created_at)
   select gen_random_uuid(), $1, f || ' ' || l, f, l,
          case when g % 4 <> 0 then '604-555-' || lpad((g % 10000)::text, 4, '0') end,
          case when g % 3 = 0 then 'v' || g || '@example.org' end,
          (100 + g / 300)::text || ' ' || (g % 300)::text || ' Ave', (100 + g / 300)::text, 'Surrey',
          case when g % 25 <> 0 then $3 + ((g::bigint * 7919) % 100000) / 100000.0 * $5 end,
          case when g % 25 <> 0 then $4 + ((g::bigint * 104729) % 100000) / 100000.0 * $5 end,
          now() - make_interval(days => g % 400)
     from (select g, (array['Ana','Ben','Cy','Dee','Eli','Fay','Gus','Hana','Ivan','Jo'])[1 + g % 10] as f,
                  (array['Example','Sample','Smith','Singh','Van Dyke','Lee','Brown','Chan','Gill','Wong','Nguyen','Kaur'])[1 + (g / 7) % 12] || (g % 97)::text as l
             from generate_series(1, $2::int) g) x`,
  [ws, N, S, W, SPAN],
);
const year = new Date().getFullYear();
// 20,000 donors: a gift last year, and this year for half.
await db.query(
  `insert into gifts (id, workspace_id, person_id, amount_cents, date, method, cadence)
   select gen_random_uuid(), $1, id, 2500 + (n % 8) * 2500, make_date($2::int - 1, (1 + n % 12)::int, 1), 'cheque', case when n % 10 = 0 then 'monthly' else 'one-time' end
     from (select id, (row_number() over (order by id))::int as n from persons where workspace_id = $1 order by id limit 20000) p
   union all
   select gen_random_uuid(), $1, id, 5000, current_date - (n % 200)::int, 'card', 'one-time'
     from (select id, (row_number() over (order by id))::int as n from persons where workspace_id = $1 order by id limit 20000) p where n % 2 = 0`,
  [ws, year],
);
const field = (await db.query("select id from person_fields where workspace_id = $1 and lower(name) = 'interested in being a candidate'", [ws])).rows[0].id;
await db.query(
  `insert into person_field_values (id, workspace_id, field_id, person_id, value)
   select gen_random_uuid(), $1, $2, id, 'true'::jsonb from persons where workspace_id = $1 order by id desc limit 2000`, [ws, field],
);
// Volunteers: 1,500 by role, 1,500 by the tag only.
await db.query(
  `insert into volunteer_roles (id, workspace_id, person_id, role)
   select gen_random_uuid(), $1, id, (array['driver','doorknocking','phoning'])[1 + (abs(hashtext(id::text)) % 3)] from persons where workspace_id = $1 order by name, id limit 1500`, [ws],
);
await db.query(
  `update persons set tags = '["volunteer"]'::jsonb where id in (select id from persons where workspace_id = $1 order by name desc, id limit 1500)`, [ws],
);
await db.query(
  `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, source)
   select gen_random_uuid(), $1, id, 1, current_date - 300, current_date + (abs(hashtext(id::text)) % 200) - 50, 'paper'
     from persons where workspace_id = $1 order by email nulls last, id limit 3000`, [ws],
);
await db.query(
  `insert into signs (id, workspace_id, person_id, address, kind, status)
   select gen_random_uuid(), $1, id, address, (array['lawn','window','large'])[1 + (abs(hashtext(id::text)) % 3)], 'requested'
     from persons where workspace_id = $1 order by phone nulls last, id limit 2000`, [ws],
);
await db.query(
  `insert into contacts (id, workspace_id, person_id, channel, outcome, created_at)
   select gen_random_uuid(), $1, id, 'door', 'moved', now() - interval '3 days'
     from persons where workspace_id = $1 order by created_at, id limit 2000`, [ws],
);
// A turf of about 300 doors, and one drawn round the whole city.
const side = Math.sqrt(300 / N) * SPAN * 1.04;
const turf = async (name, s, w, n, e) => (await (await req('/api/actions/turf.create', { method: 'POST', body: JSON.stringify({ name, polygon: [[s, w], [s, e], [n, e], [n, w]] }) })).json()).turf.id;
const small = await turf('Bench block', S + 0.1, W + 0.1, S + 0.1 + side, W + 0.1 + side);
const city = await turf('Whole city', S - 0.01, W - 0.01, S + SPAN + 0.01, W + SPAN + 0.01);
console.log(`${N.toLocaleString('en-CA')} people and the rest in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
await db.query('vacuum analyze');

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = async (path, want = 200, runs = 5) => {
  const one = async () => { const r = await req(path); if (r.status !== want) throw new Error(`${path}: ${r.status} ${await r.text()}`); return r.json(); };
  await one();
  const ms = [];
  let last;
  for (let i = 0; i < runs; i += 1) { const s = performance.now(); last = await one(); ms.push(performance.now() - s); }
  return { ms: median(ms), max: Math.max(...ms), last };
};
const rows = [];
const line = (what, r, budget, note = '') => {
  rows.push(`| ${what} | ${Math.round(r.ms)} | ${Math.round(r.max)} | ${budget} | ${note} |`);
  console.log(rows.at(-1));
};
const names = ['donors', 'running', 'volunteers', 'members', 'signs', 'moved'];
for (const n of names) {
  const r = await time(`/api/quick-reports/${n}/count`);
  line(`${n} count`, r, '150 / 400', `${r.last.count.toLocaleString('en-CA')}`);
}
line('volunteers count, role=driver', await time('/api/quick-reports/volunteers/count?role=driver'), '150 / 400');
for (const n of names) {
  const r = await time(`/api/quick-reports/${n}?limit=2000`);
  line(`${n} page of 2,000 with total`, r, '300 / 800', `${r.last.rows.length.toLocaleString('en-CA')} of ${r.last.total.toLocaleString('en-CA')}`);
}
line('donors page, largest first', await time('/api/quick-reports/donors?period=all&order=largest&limit=2000'), '300 / 800');
const w = await time(`/api/quick-reports/walk?turf=${small}&doors=all`);
line('walking list, one turf', w, '300', `${w.last.counts.doors} doors`);
let walkReads = 0;
{
  const real = db.query;
  db.query = (sql, p) => { if (String(sql).includes('pass_last_outcome')) walkReads += 1; return real.call(db, sql, p); };
  line('walking list, the whole city (409)', await time(`/api/quick-reports/walk?turf=${city}`, 409), '100', `walk list read ${walkReads} times`);
  db.query = real;
}
// The donors CSV, streamed: the heap's growth while it runs.
global.gc?.();
const heap0 = process.memoryUsage().heapUsed;
let peak = heap0;
t0 = performance.now();
const res = await req('/api/quick-reports/donors.csv?period=all');
const reader = res.body.getReader();
let bytes = 0; let lines = 0;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  bytes += value.length;
  for (const b of value) if (b === 10) lines += 1;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
}
const csvMs = performance.now() - t0;
console.log(`donors CSV: ${(lines - 1).toLocaleString('en-CA')} rows, ${(bytes / 1e6).toFixed(1)} MB in ${Math.round(csvMs)} ms; heap grew ${((peak - heap0) / 1e6).toFixed(1)} MB (budget 50)`);
console.log('\n| Read | Median (ms) | Slowest (ms) | Budget (ms) | |\n|---|---:|---:|---|---|');
for (const r of rows) console.log(r);
console.log(`| donors CSV, ${(lines - 1).toLocaleString('en-CA')} rows | ${Math.round(csvMs)} | — | heap +${((peak - heap0) / 1e6).toFixed(1)} MB (≤ 50) | |`);
process.exit(0);
