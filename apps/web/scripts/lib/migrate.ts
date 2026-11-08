import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Applies any pending migrations from ./drizzle (relative to the working directory). */
export async function migrateDatabase(url: string): Promise<void> {
  // prepare: false so it also works through a transaction pooler.
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    await client.end();
  }
}
