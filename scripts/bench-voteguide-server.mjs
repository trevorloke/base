// The server scripts/bench-voteguide.mjs runs (a child process, so its
// clients don't share this event loop): server/index.js's app on PORT, with
// every database query counted by kind and the counts sent to the parent
// when it asks ('counts'; 'reset' starts them again).
//   page    a page drawn (loadData's first query: the cache missed)
//   rev     the guide memo's "anything new?" (select rev from vote_guide)
//   rows    the guide's rows read again (rev or the site's pages moved)
//   total   every query
import { serve } from '@hono/node-server';
import { app } from '../server/index.js';
import { getDb } from '../server/db/client.js';

const counts = { page: 0, rev: 0, rows: 0, total: 0 };
const kinds = new Map(); // BENCH_KINDS=1: the commonest queries, to see what a request costs
const note = (sql) => {
  const s = String(sql);
  counts.total += 1;
  if (process.env.BENCH_KINDS) { const k = s.replace(/\s+/g, ' ').trim().slice(0, 90); kinds.set(k, (kinds.get(k) || 0) + 1); }
  if (/from site_posts/.test(s)) counts.page += 1;
  else if (/^select rev from vote_guide/.test(s.trim())) counts.rev += 1;
  else if (/from vote_place_info i join places/.test(s)) counts.rows += 1;
};
const db = await getDb();
const q0 = db.query.bind(db);
db.query = (...a) => { note(a[0]); return q0(...a); };
if (db.transaction) {
  const t0 = db.transaction.bind(db);
  db.transaction = (fn) => t0((tx) => {
    const tq = tx.query.bind(tx);
    tx.query = (...a) => { note(a[0]); return tq(...a); };
    return fn(tx);
  });
}
process.on('message', (m) => {
  if (m === 'reset') { for (const k of Object.keys(counts)) counts[k] = 0; kinds.clear(); }
  if (m === 'counts') process.send({ counts: { ...counts, kinds: [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 8) } });
});
serve({ fetch: app.fetch, port: Number(process.env.PORT) }, () => process.send?.({ ready: true }));
// A plain exit when the parent stops it, so NODE_OPTIONS=--cpu-prof writes its profile.
process.on('SIGTERM', () => process.exit(0));
