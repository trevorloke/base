// Every 5 minutes (±30 s; Check now at once): each campaign's public
// /api/health, from the Render address saved for it, and for a client's
// production also through the door (https://base.win/<name>, built here,
// never taken from an answer). Only known fields are kept, each string cut
// to 200 characters; nothing about people is in a health check. The first
// answer whose own address is the one saved pins the server's instance;
// a later change is never re-pinned here (the operator confirms it).
import { safeGet } from './safe-fetch.mjs';
import { cfg } from './config.mjs';
import { appendLog } from './log.mjs';

const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
export const INSTANCE_RE = /^[A-Za-z0-9_-]{22}$/;

// A health answer → the columns a check keeps.
export const fieldsOf = (h) => ({
  database: str(h.database),
  commit: str(h.commit),
  build: str(h.build),
  tz_current: bool(h.tzdataCurrent),
  env_reported: str(h.env),
  own_origin: str(h.ownOrigin),
  instance: str(h.instance),
  address: str(h.address),
  entry: str(h.entry),
  platform_kids: Array.isArray(h.platformKids) ? h.platformKids.filter((k) => typeof k === 'string').slice(0, 8).map((k) => k.slice(0, 200)) : null,
  setup_open: bool(h.setupOpen),
  door_key: bool(h.doorKey),
});

// One request → a check's columns.
export const checkUrl = async (url, { fetcher = safeGet } = {}) => {
  const started = Date.now();
  try {
    const res = await fetcher(url);
    const base = { status: res.status, ms: res.ms ?? Date.now() - started };
    if (res.status >= 300 && res.status < 400) return { ...base, answering: false, problem: 'redirect' };
    let h;
    try { h = JSON.parse(res.body); } catch { return { ...base, answering: false, problem: 'not-json' }; }
    if (!h || typeof h !== 'object' || Array.isArray(h)) return { ...base, answering: false, problem: 'not-json' };
    // A 503 is a server that answers with its database down: kept, and said.
    if (res.status !== 200 && res.status !== 503) return { ...base, answering: false, problem: `http-${res.status}`, ...fieldsOf(h) };
    return { ...base, answering: true, problem: null, ...fieldsOf(h) };
  } catch (e) {
    return { answering: false, status: null, ms: Date.now() - started, problem: String(e?.name || 'error').slice(0, 40) };
  }
};

const COLS = ['answering', 'status', 'ms', 'database', 'commit', 'build', 'tz_current', 'env_reported', 'own_origin', 'instance', 'address', 'entry', 'platform_kids', 'setup_open', 'door_key', 'problem'];
const record = (db, campaign, env, via, r) => db.query(
  `insert into checks (campaign, env, via, ${COLS.join(', ')}) values ($1, $2, $3, ${COLS.map((_, i) => `$${i + 4}`).join(', ')})`,
  [campaign, env, via, ...COLS.map((k) => (k === 'platform_kids' ? (r[k] == null ? null : JSON.stringify(r[k])) : r[k] ?? null))],
);

// First match pins: the server says it is at the address saved, and no
// other environment holds that instance (the unique index refuses it).
export const maybePin = async (db, envRow, check) => {
  if (envRow.instance || !check.answering || check.own_origin !== envRow.server_url || !INSTANCE_RE.test(check.instance || '')) return false;
  try {
    return await db.transaction(async (tx) => {
      const r = await tx.query(`update environments set instance = $3, instance_at = now()
        where campaign = $1 and env = $2 and instance is null and server_url = $4 returning campaign`, [envRow.campaign, envRow.env, check.instance, envRow.server_url]);
      if (!r.rows.length) return false;
      await appendLog(tx, { action: 'environment.pin', campaign: envRow.campaign, payload: { env: envRow.env, instance: check.instance } });
      return true;
    });
  } catch { return false; }
};

// At most `limit` at once.
const pool = async (tasks, limit) => {
  let next = 0;
  const run = async () => { while (next < tasks.length) { const t = tasks[next++]; await t(); } };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, run));
};

export const SWEEP_SQL = "delete from checks where at < now() - interval '7 days'";

export const pollOnce = async (db, { only = null, fetcher } = {}) => {
  const envs = (await db.query(`select e.*, c.kind from environments e join campaigns c on c.name = e.campaign
    where c.archived_at is null and e.server_url is not null and ($1::text is null or e.campaign = $1)
    order by e.campaign, e.env`, [only])).rows;
  const tasks = [];
  for (const e of envs) {
    tasks.push(async () => {
      const r = await checkUrl(`${e.server_url}/api/health`, { fetcher });
      await record(db, e.campaign, e.env, 'server', r);
      await maybePin(db, e, r);
    });
    if (e.kind === 'client' && e.env === 'production') {
      tasks.push(async () => {
        const r = await checkUrl(`${cfg().doorOrigin}/${e.campaign}/api/health`, { fetcher });
        await record(db, e.campaign, e.env, 'door', r);
      });
    }
  }
  await pool(tasks, 4);
  await db.query(SWEEP_SQL);
  return envs.length;
};

// Every 5 minutes ± 30 s, the first 10 s after start.
export const startPoller = (db) => {
  let timer;
  const loop = async () => {
    try { await pollOnce(db); } catch (e) { console.error(`poller: ${e.name}`); }
    timer = setTimeout(loop, 300_000 + Math.round((Math.random() - 0.5) * 60_000));
    timer.unref?.();
  };
  timer = setTimeout(loop, 10_000);
  timer.unref?.();
  return () => clearTimeout(timer);
};
