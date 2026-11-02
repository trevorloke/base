import { createDb, type DbHandle } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Fresh in-memory PGlite with the full schema. ~200ms. */
export async function createTestDb(): Promise<DbHandle> {
  const handle = await createDb({});
  await migrate(handle);
  return handle;
}
