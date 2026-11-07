// Fills in the dates and town centres the tracker document states for
// promises that were seeded before those columns existed. Only blank
// columns are touched, so anything an organizer set in /admin/tracker stays.
// Registered in scripts/seed.ts as `await seed(db)`.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { trackerPromises } from "../../../lib/db/schema";
import { seedPromises } from "./promises";

type SeedDb = Pick<PostgresJsDatabase<Record<string, unknown>>, "update">;

export async function seed(db: SeedDb): Promise<{ promisedOn: number; targetDate: number; neighbourhoods: number }> {
  const done = { promisedOn: 0, targetDate: 0, neighbourhoods: 0 };
  for (const p of seedPromises) {
    if (p.promisedOn) {
      const rows = await db
        .update(trackerPromises)
        .set({ promisedOn: p.promisedOn })
        .where(and(eq(trackerPromises.number, p.number), isNull(trackerPromises.promisedOn)))
        .returning({ id: trackerPromises.id });
      done.promisedOn += rows.length;
    }
    if (p.targetDate) {
      const rows = await db
        .update(trackerPromises)
        .set({ targetDate: p.targetDate })
        .where(and(eq(trackerPromises.number, p.number), isNull(trackerPromises.targetDate)))
        .returning({ id: trackerPromises.id });
      done.targetDate += rows.length;
    }
    if (p.neighbourhoods && p.neighbourhoods.length > 0) {
      const rows = await db
        .update(trackerPromises)
        .set({ neighbourhoods: p.neighbourhoods })
        .where(and(eq(trackerPromises.number, p.number), sql`cardinality(${trackerPromises.neighbourhoods}) = 0`))
        .returning({ id: trackerPromises.id });
      done.neighbourhoods += rows.length;
    }
  }
  return done;
}
