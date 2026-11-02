import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { rowsOf, type DbHandle } from "./client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "migrations");

export function listMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

/** Apply every migration not yet recorded. Idempotent. */
export async function migrate(handle: DbHandle): Promise<string[]> {
  await handle.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());",
  );
  const applied = new Set<string>(rowsOf<{ name: string }>(await handle.db.execute(sql`SELECT name FROM schema_migrations`)).map((r) => r.name));
  const done: string[] = [];
  for (const m of listMigrations()) {
    if (applied.has(m.name)) continue;
    await handle.exec(m.sql);
    await handle.db.execute(sql`INSERT INTO schema_migrations (name) VALUES (${m.name})`);
    done.push(m.name);
  }
  return done;
}
