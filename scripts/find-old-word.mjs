// Where the product's older name is still written in a database's stored
// text, as counts only: for each table and column of text or JSON, how many
// rows mention it (any case). Run by hand in Render's Shell for a service:
//
//   node scripts/find-old-word.mjs
//
// It prints "table.column: rows" lines, then a total, and nothing else: no
// value, no name, no address. Notes a website wrote ("…in <older name>
// too") are the kind of row it finds. A release never rewrites them; what
// to do with them is decided by hand.
//
// Read only, twice over: the session's default_transaction_read_only is on
// before anything else is asked, and everything runs in one read-only
// transaction (the database itself refuses any write in it), ended with a
// rollback. It connects on its own with DATABASE_URL and never starts the
// server's database set-up.
import { pathToFileURL } from 'node:url';
import { OLD_WORD } from '../shared/old-names.js';

// The kinds of column that can hold the word.
const TEXT_TYPES = ['text', 'character varying', 'character', 'json', 'jsonb'];
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

// q(sql, params) → { rows }, on one connection. → [{ table, column, rows }], only those with a mention.
export const findOldWord = async (q, word = OLD_WORD) => {
  const columns = (await q(
    `select table_name as t, column_name as c from information_schema.columns
      where table_schema = current_schema() and data_type = any($1::text[])
        and table_name in (select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE')
      order by table_name, ordinal_position`,
    [TEXT_TYPES],
  )).rows;
  const found = [];
  for (const { t, c } of columns) {
    const n = (await q(`select count(*)::int as n from ${ident(t)} where strpos(lower(${ident(c)}::text), $1) > 0`, [word.toLowerCase()])).rows[0].n;
    if (n) found.push({ table: t, column: c, rows: n });
  }
  return found;
};

// fn(q) with writes refused: the session first, then one read-only transaction, always rolled back.
export const readOnly = async (q, fn) => {
  await q('set default_transaction_read_only = on');
  await q('begin transaction isolation level repeatable read read only');
  try {
    await q("set local statement_timeout = '10min'");
    return await fn(q);
  } finally {
    await q('rollback');
  }
};

// A connection of its own, with the server's TLS rule (server/db/client.js).
export const connectPg = async (url) => {
  const { default: pg } = await import('pg');
  const ssl = /sslmode=(require|verify)/.test(url) || process.env.PGSSL === '1'
    ? { rejectUnauthorized: process.env.PGSSL_STRICT === '1' }
    : undefined;
  const client = new pg.Client({ connectionString: url, ssl, connectionTimeoutMillis: 30_000 });
  await client.connect();
  return client;
};

export const main = async ({ url = process.env.DATABASE_URL, out = console.log, connect = connectPg } = {}) => {
  if (!String(url || '').trim()) throw new Error('DATABASE_URL is not set: run this in Render’s Shell for the service.');
  const client = await connect(url);
  try {
    const found = await readOnly((sql, params) => client.query(sql, params), findOldWord);
    for (const f of found) out(`${f.table}.${f.column}: ${f.rows}`);
    out(`Rows that mention the older name: ${found.reduce((n, f) => n + f.rows, 0)} (in ${found.length} columns)`);
  } finally {
    await client.end();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`find-old-word: ${e.message}`);
    process.exit(1);
  });
}
