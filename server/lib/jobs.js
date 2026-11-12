// Background jobs: work that must happen later and on its own — a ladder's
// "wait 3 days, then email", an A/B test's "send the winner in 4 hours".
// Each job is a row in `jobs`; a runner claims due rows and hands each to
// the handler registered for its kind. Handlers do their own writes through
// runAction, so everything a job does is on the event log like any other
// write. Failures retry with backoff, then park as 'failed' with the error.
//
//   registerJob(kind, async (db, job) => {...})
//       A handler with slow work outside any transaction (a call to
//       another tool) may hand it back instead of waiting for it: return
//       { later: <promise> }. The next job starts at once; this one is
//       done — or failed, and tried again — when the promise settles.
//       Or, when it can't start the work now (a line that is full), hand
//       the job back to the queue: return { again: <ms> } — it runs again
//       that much later, and no try is counted.
//   enqueueJob(tx, { workspaceId, kind, runAt?, payload?, key? })
//       inside an action's transaction, so scheduling commits with the
//       event that caused it; `key` makes it idempotent per workspace.
//   runDueJobs(db, { limit, workspaceId }) → { ran, failed }
//       tests call this directly, scoped to their own workspace (under
//       test:pg every test file shares one database). It answers once
//       handed-back work has ended too; the runner's own passes
//       (settle: false) don't wait for it.
//   startJobRunner(db, { everyMs }) / stopJobRunner()
//   runJobsSoon()  run due jobs now (once the runner has started)
//   jobRunnerOn()  whether it has
import { newId } from './events.js';

const handlers = new Map();
const MAX_ATTEMPTS = 5;

export const registerJob = (kind, fn) => {
  if (handlers.has(kind)) throw new Error(`job kind ${kind} registered twice`);
  handlers.set(kind, fn);
};

export const enqueueJob = async (tx, { workspaceId, kind, runAt = null, payload = {}, key = null }) => {
  const id = newId();
  const { rows } = await tx.query(
    `insert into jobs (id, workspace_id, kind, run_at, payload, key)
     values ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6)
     on conflict (workspace_id, key) where key is not null do nothing
     returning id`,
    [id, workspaceId, kind, runAt, JSON.stringify(payload), key],
  );
  return rows[0]?.id || null;
};

export const cancelJobs = async (tx, { workspaceId, kind, where = {} }) => {
  // Cancel pending jobs of a kind whose payload contains `where`.
  const n = await tx.query(
    `update jobs set status = 'cancelled', done_at = now()
     where workspace_id = $1 and kind = $2 and status = 'pending' and payload @> $3::jsonb`,
    [workspaceId, kind, JSON.stringify(where)],
  );
  return n.affectedRows;
};

const parse = (row) => ({ ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload });

export const runDueJobs = async (db, { limit = 25, workspaceId = null, settle = true } = {}) => {
  // A runner that died mid-job leaves it 'running'; give it back after 10 min.
  await db.query(
    `update jobs set status = 'pending' where status = 'running' and started_at < now() - interval '10 minutes'`,
  );
  const claimed = (await db.query(
    `update jobs set status = 'running', attempts = attempts + 1, started_at = now()
     where id in (select id from jobs where status = 'pending' and run_at <= now()
                    and ($2::uuid is null or workspace_id = $2)
                  order by run_at limit $1 for update skip locked)
     returning *`,
    [limit, workspaceId],
  )).rows.map(parse);
  let ran = 0; let failed = 0;
  const done = async (job) => {
    await db.query(`update jobs set status = 'done', done_at = now(), last_error = null where id = $1`, [job.id]);
    ran += 1;
  };
  const fail = async (job, e) => {
    failed += 1;
    const last = job.attempts >= MAX_ATTEMPTS;
    await db.query(
      `update jobs set status = $2, last_error = $3,
         run_at = case when $2 = 'pending' then now() + ($4 || ' seconds')::interval else run_at end,
         done_at = case when $2 = 'failed' then now() else null end
       where id = $1`,
      [job.id, last ? 'failed' : 'pending', String(e?.message || e).slice(0, 1000), String(30 * 2 ** job.attempts)],
    );
  };
  // Work handed back by a handler ({ later }): the jobs behind it start now.
  const later = [];
  for (const job of claimed) {
    const fn = handlers.get(job.kind);
    try {
      if (!fn) throw new Error(`no handler for job kind ${job.kind}`);
      const out = await fn(db, job);
      if (out?.later) later.push(Promise.resolve(out.later).then(() => done(job)).catch((e) => fail(job, e)));
      else if (out?.again) {
        await db.query(
          `update jobs set status = 'pending', attempts = greatest(attempts - 1, 0), run_at = now() + ($2 || ' milliseconds')::interval
           where id = $1`, [job.id, String(Math.max(0, Math.round(Number(out.again) || 0)))],
        );
      } else await done(job);
    } catch (e) {
      await fail(job, e);
    }
  }
  // The runner goes on without it: each such job is noted when its work
  // ends. Anyone else who asked is answered once everything has.
  if (!settle) {
    for (const end of later) end.catch((e) => console.error('jobs:', e.message));
    return { ran, failed };
  }
  const ends = await Promise.allSettled(later);
  const lost = ends.find((x) => x.status === 'rejected');
  if (lost) throw lost.reason;
  return { ran, failed };
};

// One runner per process: the timer, and runJobsSoon() for work that should
// start now rather than on the next tick (a send handed over by the request
// that started it; the next part of a big list). A call while the runner is
// busy makes it go round once more when it's done. Before startJobRunner
// (tests) runJobsSoon does nothing: tests call runDueJobs themselves.
let timer = null;
let runner = null;
const tick = async () => {
  const r = runner;
  if (!r) return;
  if (r.busy) { r.again = true; return; }
  r.busy = true;
  try {
    do { r.again = false; await runDueJobs(r.db, { settle: false }); } while (r.again && runner === r);
  } catch (e) {
    console.error('jobs:', e.message);
  } finally {
    r.busy = false;
  }
};
export const startJobRunner = (db, { everyMs = 30_000 } = {}) => {
  if (timer) return;
  runner = { db, busy: false, again: false };
  timer = setInterval(tick, everyMs);
  timer.unref?.();
};
export const runJobsSoon = () => { if (runner) setImmediate(tick); };
// Whether this process runs jobs (off before startJobRunner, or STARBASE_JOBS=off).
export const jobRunnerOn = () => !!runner;
export const stopJobRunner = () => { if (timer) clearInterval(timer); timer = null; runner = null; };
