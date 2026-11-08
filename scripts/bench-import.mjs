// How fast an import is, and why: N made-up rows shaped like the campaign's
// list (names, phones, an email, a street address with unit, city, postal,
// tags, a pin, profile fields), imported in the import screen's chunks,
// counting the database round trips each row costs. A hosted database is a
// network hop away, so the count (× its latency) is what decides the time.
//
//   node scripts/bench-import.mjs 2000
import { freshDb, Client } from '../server/test/helpers.js';
import { getDb } from '../server/db/client.js';

const N = Number(process.argv[2]) || 2000;
const CHUNK = 1000;
await freshDb();
const db = await getDb();
let queries = 0;
const kinds = new Map();
const note = (sql) => { if (process.env.BENCH_KINDS) { const k = String(sql).replace(/\s+/g, ' ').trim().slice(0, 70); kinds.set(k, (kinds.get(k) || 0) + 1); } };
const q0 = db.query.bind(db);
db.query = (...a) => { queries += 1; note(a[0]); return q0(...a); };
if (db.transaction) {
  const t0 = db.transaction.bind(db);
  db.transaction = (fn) => t0((tx) => {
    const tq = tx.query.bind(tx);
    tx.query = (...a) => { queries += 1; note(a[0]); return tq(...a); };
    return fn(tx);
  });
}
const mgr = new Client();
await mgr.signup({ workspaceName: 'Bench', jurisdiction: 'bc-municipal' });
const fields = (await mgr.get('/api/fields')).json.fields;
const fid = (n) => fields.find((f) => f.name === n)?.id;
const streets = ['104 Ave', '83 Ave', '72 Ave', 'King George Blvd', '152 St', '128 St', '64 Ave', 'Fraser Hwy'];
const row = (i) => ({
  first: `Person${i}`, last: `Example${i % 97}`,
  phone: `604555${String(1000 + (i % 9000)).padStart(4, '0')}`,
  email: i % 3 ? `p${i}@example.org` : undefined,
  house_number: String(10000 + (i % 8000)), address: streets[i % streets.length], unit: i % 5 ? undefined : String(100 + (i % 40)),
  city: 'Surrey', postal: 'V3T 1V8',
  lat: 49.1 + (i % 1000) / 10000, lng: -122.8 + (i % 1000) / 10000,
  tags: i % 4 ? 'Zone 1;Vol: Door Knocker' : 'Zone 2',
  fields: { [fid('Province')]: 'BC', [fid('Email opt-in')]: 't', [fid('SMS opt-in')]: 'f', [fid('Support')]: String(1 + (i % 5)), [fid('Dwelling type')]: i % 2 ? 'House' : 'Apartment' },
});
const rows = Array.from({ length: N }, (_, i) => row(i));
const t0 = performance.now();
let q = queries;
for (let i = 0; i < N; i += CHUNK) {
  const r = await mgr.post('/api/data/import', { rows: rows.slice(i, i + CHUNK) });
  if (r.status !== 200) { console.error(r.status, JSON.stringify(r.json).slice(0, 300)); process.exit(1); }
}
const ms = performance.now() - t0;
const perRow = (queries - q) / N;
console.log(`${N} rows in ${(ms / 1000).toFixed(1)} s here (${(ms / N).toFixed(1)} ms a row) — ${perRow.toFixed(1)} database round trips a row`);
for (const lat of [1, 3, 10]) {
  const est = (N * perRow * lat) / 1000;
  console.log(`  at ${lat} ms a round trip (a hosted database${lat === 1 ? ' in the same region' : lat === 10 ? ' far away, or a busy small one' : ''}): + ${est.toFixed(0)} s for ${N}; ${((est / N) * 100000 / 3600).toFixed(1)} h for 100,000`);
}
if (process.env.BENCH_KINDS) for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String(n).padStart(7), k);
process.exit(0);
