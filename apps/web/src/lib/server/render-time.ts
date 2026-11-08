import "server-only";
import { connection } from "next/server";

/**
 * A build with no database (the Docker image is built without secrets, so
 * `next build` can't read site settings, the brand or any content) must not
 * bake the code's fallback copy and look into prerendered pages: the first
 * visitor after every deploy would see them. Called at the top of the root
 * layout, it makes every page render when it is asked for instead; the data
 * each page reads still comes from the hour-long cache (`cached()`), so a
 * visit still costs no database query. A build that can reach the database
 * prerenders as before.
 */
export async function renderAtRequestTimeWithoutDatabase(): Promise<void> {
  if (buildingWithoutDatabase()) await connection();
}

/** True while `next build` runs without a database (nothing it reads is real yet; don't log it as an outage). */
export function buildingWithoutDatabase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build" && !process.env.DATABASE_URL;
}
