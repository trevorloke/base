// Database client — one tiny interface over two backends:
//   db.query(sql, params) → { rows, affectedRows }
//   db.exec(sql)          → run a multi-statement script (DDL)
//   db.transaction(async (tx) => ...) → tx.query; commits, or rolls back on throw
//
// DATABASE_URL set → node-postgres pool (hosted Postgres: Render, Fly, Neon …).
// Otherwise PGlite (embedded, real Postgres): file-backed at STARBASE_DATA
// (default ./data/starbase), or in-memory under the test runner / =memory.
// Type parsing is pinned so both backends return identical shapes:
// date → Date at UTC midnight, int8 → number, json → object.
//
// On Render (RENDER is set on every service there) with no DATABASE_URL the
// server does not start: the embedded database would live inside the
// container, which is thrown away at the next deploy, and the campaign with
// it. STARBASE_EMBEDDED_DB=1 says a disk is mounted for it on purpose.
import { bootstrap } from './schema.js';

let dbPromise = null;

// Why this server must not start, in one line for the log — or null.
export const storeRefusal = (env = process.env) => {
  if (!env.RENDER || String(env.DATABASE_URL || '').trim() || env.STARBASE_EMBEDDED_DB === '1') return null;
  return 'starbase: not starting — this service is on Render with no DATABASE_URL, so the campaign would be kept in the built-in database inside the container and lost at the next deploy. '
    + 'To fix: Render → this service → Environment → DATABASE_URL = the database’s Internal Database URL. '
    + '(Or set STARBASE_EMBEDDED_DB=1 if a disk is mounted for the built-in database on purpose.)';
};

// The store's name at /api/health: "postgres" (DATABASE_URL) or "embedded"
// (the built-in database). Without a database object (it isn't answering),
// the one the settings name.
export const storeOf = (db, env = process.env) => ((db ? db.kind === 'postgres' : Boolean(env.DATABASE_URL)) ? 'postgres' : 'embedded');

const createPg = async (url) => {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(1082, (v) => new Date(`${v}T00:00:00Z`)); // date
  pg.types.setTypeParser(20, (v) => Number(v));                     // int8
  const ssl = /sslmode=(require|verify)/.test(url) || process.env.PGSSL === '1'
    ? { rejectUnauthorized: process.env.PGSSL_STRICT === '1' }
    : undefined;
  const pool = new pg.Pool({
    connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX) || 10,
    // A connection that can't be made in 30 s (PG_CONNECT_TIMEOUT_MS) is an
    // error, not a request left hanging; long enough for a database that is
    // restarting, or busy handing over a connection.
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 30_000, keepAlive: true,
  });
  // An idle connection the database drops (a restart, a plan change, its
  // maintenance) is an error on the pool; unheard it would stop the whole
  // server. The pool opens a fresh connection on the next query instead.
  pool.on('error', (e) => console.error(`database: an idle connection dropped (${e.message}); the next query reconnects`));
  const wrap = (client) => ({
    query: async (sql, params = []) => {
      const r = await client.query(sql, params);
      return { rows: r.rows, affectedRows: r.rowCount ?? 0 };
    },
  });
  return {
    kind: 'postgres',
    // The pool itself, for a test that counts connections in use (an open
    // live GOTV stream must hold none).
    pool,
    ...wrap(pool),
    exec: async (sql) => { await pool.query(sql); },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
};

const createPglite = async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  // Real runs persist by default (./data/starbase) so a restart never wipes a
  // campaign; the test runner and STARBASE_DATA=memory use an in-memory DB.
  const testing = !!process.env.NODE_TEST_CONTEXT;
  const dataDir = process.env.STARBASE_DATA || (testing ? 'memory' : './data/starbase');
  if (dataDir !== 'memory') {
    // PGlite won't create parent folders; a first run must not crash.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
  }
  const db = dataDir === 'memory' ? new PGlite() : new PGlite(dataDir);
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
};

const create = async () => {
  const refused = storeRefusal();
  if (refused) throw new Error(refused);
  const db = process.env.DATABASE_URL ? await createPg(process.env.DATABASE_URL) : await createPglite();
  await bootstrap(db);
  return db;
};

// A database that couldn't be reached is asked again next time, never
// remembered as down: it may be restarting and back in a minute.
export const getDb = () => {
  if (!dbPromise) {
    const p = create();
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
  }
  return dbPromise;
};

// Is the database answering right now? (For /api/health.)
export const dbReachable = async (ms = 3000) => {
  try {
    const db = await getDb();
    await Promise.race([db.query('select 1'), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
    return true;
  } catch { return false; }
};

// Tests only: swap in a fresh database.
export const _resetDbForTest = () => { dbPromise = null; };
