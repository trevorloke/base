// How Turn into a list holds up on a city's voter file (ext/fields/convert.js),
// against a real Postgres:
//   (a) 300,000 Dwelling type values, 40 different words: GET …/words, each
//       chunk's write, the whole conversion with the runner going round at
//       once, and a profile save on another field started mid-run.
//   (b) 300,000 values, every one different: GET …/words refuses, and GET
//       /fields against the grouping it had before (lower(value)).
//
//   DATABASE_URL=postgres://… PG_POOL_MAX=4 node scripts/bench-fieldlist.mjs
import { performance } from 'node:perf_hooks';

if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL to a Postgres to measure against.'); process.exit(1); }
process.env.PG_POOL_MAX ||= '4';
const { freshDb, Client } = await import('../server/test/helpers.js');
const { runDueJobs } = await import('../server/lib/jobs.js');
const { DWELLING_TYPES } = await import('@starbase/shared/fieldlists');

const db = await freshDb();
const ms = (t) => Math.round(performance.now() - t);
const ok = (r) => { if (r.status < 200 || r.status > 299) throw new Error(JSON.stringify(r.json)); return r.json; };
const N = Number(process.argv[2]) || 300_000;

const mgr = new Client();
const ws = ok(await mgr.signup({ workspaceName: `Bench lists ${Date.now()}`, jurisdiction: 'bc-municipal' })).workspace.id;
await db.query(`insert into persons (id, workspace_id, name) select gen_random_uuid(), $1, 'Bench Example ' || i from generate_series(1, $2) i`, [ws, N]);
const a = (await mgr.action('field.create', { name: 'Home words', kind: 'text' })).json.field;
const words = Array.from({ length: 40 }, (_, i) => (i < 20 ? `${['house', 'House', 'townhouse', 'basement suite', 'Apt'][i % 5]} ${i}` : `word ${i}`));
await db.query(
  `insert into person_field_values (id, workspace_id, field_id, person_id, value)
   select gen_random_uuid(), $1, $2, p.id, to_jsonb(($3::text[])[1 + (row_number() over (order by p.id))::int % 40])
     from persons p where p.workspace_id = $1`, [ws, a.id, words],
);
await db.query('analyze person_field_values');

console.log(`(a) ${N.toLocaleString('en-CA')} values, 40 different words`);
let t = performance.now();
const w = ok(await mgr.get(`/api/fields/${a.id}/words`));
console.log(`  GET …/words: ${ms(t)} ms (${w.distinct} words)`);
const map = w.words.map((x, i) => ({ word: x.word, to: i % 4 === 3 ? null : DWELLING_TYPES[i % DWELLING_TYPES.length] }));
ok(await mgr.action('field.list.start', { id: a.id, choices: DWELLING_TYPES, display: 'list', map }));
// Each chunk's write: every transaction the run makes is timed.
const chunks = [];
const t0 = db.transaction.bind(db);
db.transaction = async (fn) => { const s = performance.now(); try { return await t0(fn); } finally { chunks.push(performance.now() - s); } };
const other = ok(await mgr.action('field.create', { name: 'Other words', kind: 'text' })).field;
const p = (await db.query('select id from persons where workspace_id = $1 limit 1', [ws])).rows[0].id;
t = performance.now();
let saveMs = null;
const saving = new Promise((r) => { setTimeout(async () => { const s = performance.now(); ok(await mgr.action('field.values.set', { person_id: p, values: [{ field_id: other.id, value: 'mid-run' }] })); saveMs = ms(s); r(); }, 1500); });
for (;;) {
  const n = (await db.query("select count(*)::int as n from jobs where workspace_id = $1 and status = 'pending'", [ws])).rows[0].n;
  if (!n) break;
  await runDueJobs(db, { workspaceId: ws });
}
await saving;
const whole = ms(t);
db.transaction = t0;
const kind = (await db.query('select kind from person_fields where id = $1', [a.id])).rows[0].kind;
console.log(`  conversion: ${(whole / 60000).toFixed(2)} min (${kind}); slowest chunk ${Math.round(Math.max(...chunks))} ms over ${chunks.length} writes`);
console.log(`  a profile save on another field, mid-run: ${saveMs} ms`);

console.log(`(b) ${N.toLocaleString('en-CA')} values, every one different`);
const b = ok(await mgr.action('field.create', { name: 'Doorstep words', kind: 'text' })).field;
await db.query(
  `insert into person_field_values (id, workspace_id, field_id, person_id, value)
   select gen_random_uuid(), $1, $2, p.id, to_jsonb('note ' || p.id) from persons p where p.workspace_id = $1`, [ws, b.id],
);
await db.query('analyze person_field_values');
t = performance.now();
const r = await mgr.get(`/api/fields/${b.id}/words`);
console.log(`  GET …/words: ${r.status} in ${ms(t)} ms`);
// GET /fields's grouping of every Text value, as it was and as it is now
// (plus how many different words, and how many people the top 40 cover).
const grouping = (extra, keep) => async () => {
  const s = performance.now();
  await db.query(
    `select * from (
       select v.field_id, f.kind, min(v.value #>> '{}') as words, count(*)::int as n,
              row_number() over (partition by v.field_id order by count(*) desc, min(v.value #>> '{}')) as r${extra}
       from person_field_values v
       join persons p on p.id = v.person_id and p.deleted_at is null
       join person_fields f on f.id = v.field_id and f.kind in ('text', 'number')
       where v.workspace_id = $1
       group by v.field_id, f.kind, case when f.kind = 'text' then lower(v.value #>> '{}') else v.value #>> '{}' end
     ) t where r <= ${keep} order by field_id, r`, [ws],
  );
  return performance.now() - s;
};
const before = grouping('', 8);
const after = grouping(', count(*) over (partition by v.field_id) as d, sum(count(*)) over (partition by v.field_id) as people', 40);
const now = async () => { const s = performance.now(); ok(await mgr.get('/api/fields')); return performance.now() - s; };
// The middle of five tries: one slow or fast run doesn't decide it.
const best = async (fn) => { const t = []; for (let i = 0; i < 5; i += 1) t.push(await fn()); return Math.round(t.sort((x, y) => x - y)[2]); };
const old = await best(before);
const neu = await best(after);
const cur = await best(now);
console.log(`  GET /fields: ${cur} ms; its Text grouping ${neu} ms now against ${old} ms before (${neu >= old ? '+' : ''}${Math.round((neu / old - 1) * 100)}%)`);
process.exit(0);
