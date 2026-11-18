// Loaded into the server under test by scripts/load-gotv.mjs
// (node --import ./scripts/load-gotv-probe.mjs server/index.js): measures
// the server's own event-loop delay, its memory and its database pool, and
// writes them to LOAD_PROBE_FILE every second. Changes nothing.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

const file = process.env.LOAD_PROBE_FILE;
if (file) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const rss0 = process.memoryUsage().rss;
  let rssMax = rss0;
  let poolMax = 0; let waitMax = 0; let waitRun = 0; let waitRunMax = 0; let since = Date.now();
  let pool = null;
  setTimeout(async () => {
    const { getDb } = await import('../server/db/client.js');
    pool = (await getDb()).pool || null;
  }, 3000).unref();
  // The pool, every 50 ms: the most connections out, the most callers
  // waiting, and the longest stretch with someone waiting.
  setInterval(() => {
    if (!pool) return;
    poolMax = Math.max(poolMax, pool.totalCount);
    waitMax = Math.max(waitMax, pool.waitingCount);
    if (pool.waitingCount > 0) { waitRun += 50; waitRunMax = Math.max(waitRunMax, waitRun); } else waitRun = 0;
  }, 50).unref();
  setInterval(() => {
    rssMax = Math.max(rssMax, process.memoryUsage().rss);
    const out = {
      at: Date.now(), since, p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6,
      rss0, rss: process.memoryUsage().rss, rssMax, poolMax, waitMax, waitRunMax,
    };
    try { writeFileSync(file, JSON.stringify(out)); } catch { /* the next second */ }
  }, 1000).unref();
  // LOAD_PROBE_RESET (a file's mtime would do; a signal is simpler): the
  // load script resets the histogram once seeding is over.
  process.on('SIGUSR2', () => { h.reset(); since = Date.now(); poolMax = 0; waitMax = 0; waitRunMax = 0; });
}
