// How fast the person search is on a city's voter file, before and after:
// 300,000 made-up people (scripts/search-fixture.mjs, skewed on purpose) in
// a scratch Postgres, each term five times, the median.
//   before: the relationship editor's old ask (/persons?q=…&limit=12: any
//           part of the name, address, phone, email or a handle, by name)
//   after:  /search/people, 25 a page — page 1 and page 5 — and its plan
//           (uncapped: an exact count; capped: "more than", A–Z streams)
// Then People's own count and box (/persons/count?q=smith, /persons?q=smith
// kevin) before and after their changes, and each new index's build time
// and size on the full file.
//
//   node scripts/bench-search.mjs postgres://…/search_bench [people]
// Refuses a database whose name doesn't say bench or scratch, or that holds
// any campaign: it fills one with 300,000 people.
import pg from 'pg';

const url = process.argv[2];
const N = Number(process.argv[3]) || 300_000;
if (!url) { console.error('usage: node scripts/bench-search.mjs <DATABASE_URL> [people]'); process.exit(2); }
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
const { Client } = await import('../server/test/helpers.js');
const { getDb } = await import('../server/db/client.js');
const { fillPeople, BIG, BIG2 } = await import('./search-fixture.mjs');
// SEARCH_CAP=2000 tries the lower cap (ext/search's fallback).
const search = await import('../server/ext/search/index.js');
if (process.env.SEARCH_CAP) search.setSearchCap(Number(process.env.SEARCH_CAP));
console.log(`cap: ${search.SEARCH_CAP}`);

const db = await getDb();
const mgr = new Client();
const ws = (await mgr.signup({ workspaceName: 'Search bench', email: 'search-bench@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
let t0 = performance.now();
await fillPeople(db, ws, N);
console.log(`${N.toLocaleString('en-CA')} people in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
// As autovacuum leaves a hosted database soon after a big import.
await db.query('vacuum analyze persons');

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = async (fn, runs = 5) => {
  await fn();
  const ms = [];
  let last;
  for (let i = 0; i < runs; i += 1) { const s = performance.now(); last = await fn(); ms.push(performance.now() - s); }
  return { ms: median(ms), max: Math.max(...ms), last };
};
const esc = (s) => s.replace(/[%_\\]/g, (m) => `\\${m}`);
// The relationship editor's ask before this change: one %q% over the name,
// address, phone, email and handles, first-name order.
const oldWhere = (q) => {
  const like = `%${esc(q)}%`;
  const params = [ws, q, like, `%${esc(q.replace(/^@|^\/?u\//i, ''))}%`];
  let digits = /^[\d\s().+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  if (digits.startsWith('1') && digits.length > 4) digits = digits.slice(1);
  let phone = '';
  if (digits.length >= 4) { params.push(`%${digits}%`); phone = ` or regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') like $${params.length}`; }
  return {
    where: `p.workspace_id = $1 and p.deleted_at is null and ($2 = '' or p.name ilike $3 or p.address ilike $3 or p.phone ilike $3${phone}
      or p.email ilike $3 or exists (select 1 from jsonb_each_text(p.socials) s where regexp_replace(s.value, '^@|^/?u/', '', 'i') ilike $4))`,
    params,
  };
};
const before = (q) => { const { where, params } = oldWhere(q); return db.query(`select p.id, p.name from persons p where ${where} order by lower(p.name), p.id limit 13`, params); };
const ask = (path) => mgr.get(path).then((r) => { if (r.status !== 200) throw new Error(`${path}: ${r.status}`); return r.json; });
const find = (q, after = '') => ask(`/api/search/people?q=${encodeURIComponent(q)}&limit=25${after ? `&after=${after}` : ''}`);

const terms = ['smith', 'kevin smith', 'smith kevin', 'Smith, Kevin', 'si', 'ka', 'zzq', 'jose', 'berg', '604 555 01', '555 01', 'k.smith', 'ksmith',
  'ksmith3@example.org', '14', '145', '14520 72', BIG.toLowerCase(), BIG2.toLowerCase(), `kevin ${BIG.toLowerCase()}`, `${BIG.toLowerCase()} ${BIG2.toLowerCase()}`];
const rows = [];
for (const q of terms) {
  const b = await time(() => before(q));
  const p1 = await time(() => find(q));
  // Page 5: the 101st to the 125th, through four pages first.
  let after = '';
  let page = p1.last;
  let turned = 0;
  while (turned < 4 && page.more) { after = page.persons.at(-1).id; page = await find(q, after); turned += 1; }
  const p5 = turned === 4 ? await time(() => find(q, after)) : null;
  const plan = p1.last.hint ? 'hint' : p1.last.many ? 'capped' : 'uncapped';
  const found = p1.last.many ? `>${p1.last.cap}` : String(p1.last.total ?? 0);
  rows.push({ q, before: b.ms, p1: p1.ms, p5: p5?.ms ?? null, max: Math.max(p1.max, p5?.max ?? 0), plan, found });
}
const f = (ms) => (ms == null ? '—' : `${ms.toFixed(1)}`);
console.log('\n| Term | Before (ms) | After, page 1 (ms) | After, page 5 (ms) | Plan | Found |');
console.log('|---|---:|---:|---:|---|---:|');
for (const r of rows) console.log(`| \`${r.q}\` | ${f(r.before)} | ${f(r.p1)} | ${f(r.p5)} | ${r.plan} | ${r.found} |`);
const worst = Math.max(...rows.map((r) => Math.max(r.p1, r.p5 ?? 0)));
const over = rows.filter((r) => r.p1 > 50 || (r.p5 ?? 0) > 50).map((r) => r.q);
console.log(`\nSlowest new search: ${worst.toFixed(1)} ms (budget: median ≤ 50 ms, none over 150 ms)${over.length ? ` — over 50 ms: ${over.join(', ')}` : ''}`);
console.log(`Slowest single run of a new search: ${Math.max(...rows.map((r) => r.max)).toFixed(1)} ms`);

// People's own count and box, before and after (decision 8).
const oldCount = await time(() => { const { where, params } = oldWhere('smith'); return db.query(`select count(*)::int from persons p where ${where}`, params); });
const newCount = await time(() => ask('/api/persons/count?q=smith'));
const oldBox = await time(() => before('smith kevin'));
const newBox = await time(() => ask(`/api/persons?q=${encodeURIComponent('smith kevin')}&limit=300`));
console.log(`\nPeople's count, "smith": ${f(oldCount.ms)} ms before, ${f(newCount.ms)} ms after`);
console.log(`People's box, "smith kevin": ${f(oldBox.ms)} ms before (finds ${oldBox.last.rows.length}), ${f(newBox.ms)} ms after (finds ${newBox.last.persons.length}${newBox.last.more ? '+' : ''})`);

// Each new index, rebuilt on the full file: time and size.
console.log('\n| Index | Build (ms) | Size (MB) |');
console.log('|---|---:|---:|');
for (const name of ['persons_ws_name_fold_idx', 'persons_ws_last_fold_idx', 'persons_ws_last_tail_idx', 'persons_ws_middle_fold_idx', 'persons_ws_az_idx',
  'persons_ws_phone7_idx', 'persons_ws_email_prefix_idx', 'persons_ws_addr_prefix_idx']) {
  const def = (await db.query('select pg_get_indexdef($1::regclass) as d', [name])).rows[0].d;
  await db.query(`drop index ${name}`);
  t0 = performance.now();
  await db.query(def);
  const ms = performance.now() - t0;
  const size = Number((await db.query('select pg_relation_size($1::regclass) as s', [name])).rows[0].s) / 1024 / 1024;
  console.log(`| ${name} | ${ms.toFixed(0)} | ${size.toFixed(1)} |`);
}
process.exit(0);
