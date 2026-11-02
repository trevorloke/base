import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import pg from "pg";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

/** Common base of the node-postgres and PGlite drivers, so services are driver-agnostic. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Rows from db.execute(), whichever driver. */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  if (Array.isArray(r)) return r;
  return r.rows ?? [];
}

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  /** Run raw multi-statement SQL (migrations). */
  exec(sqlText: string): Promise<void>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** Postgres connection string. When absent, PGlite is used. */
  url?: string;
  /** PGlite data directory; omit for in-memory. */
  pglitePath?: string;
}

export async function createDb(opts: DbOptions = {}): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return {
      db,
      kind: "postgres",
      exec: async (sqlText) => {
        await pool.query(sqlText);
      },
      close: () => pool.end(),
    };
  }
  const client = opts.pglitePath ? new PGlite(opts.pglitePath, { extensions: { vector } }) : new PGlite({ extensions: { vector } });
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return {
    db,
    kind: "pglite",
    exec: async (sqlText) => {
      await client.exec(sqlText);
    },
    close: () => client.close(),
  };
}
