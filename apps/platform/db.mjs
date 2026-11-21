// The control centre's database: DATABASE_URL → Postgres (node-postgres);
// unset → PGlite in memory (tests, and a try-out on a laptop: nothing is
// kept across a restart). Both answer { rows } with the same shapes
// (int8 → number). db.sql runs at every start.
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('./db.sql', import.meta.url), 'utf8');

const fromPg = async (url, max) => {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v));
  const ssl = /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url, ssl, max, connectionTimeoutMillis: 30_000, keepAlive: true });
  pool.on('error', (e) => console.error(`database: an idle connection dropped (${e.message})`));
  const wrap = (client) => ({ query: async (sql, params = []) => { const r = await client.query(sql, params); return { rows: r.rows, affectedRows: r.rowCount ?? 0 }; } });
  return {
    kind: 'postgres',
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
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
};

const fromPglite = async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  // PGlite runs one thing at a time; a transaction's queries go through tx.
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
};

// max: connections in the pool (1 over PGlite's socket server in tests).
export const openDb = async (url = '', { max = 5 } = {}) => {
  const db = url ? await fromPg(url, max) : await fromPglite();
  await db.exec(SCHEMA);
  return db;
};

export const dbAnswers = async (db, ms = 3000) => {
  try {
    await Promise.race([db.query('select 1'), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms).unref())]);
    return true;
  } catch { return false; }
};
