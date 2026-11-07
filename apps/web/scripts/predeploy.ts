// Brings the database up to date before the site starts: pending migrations,
// then the seed, which only adds missing rows (it never overwrites anything
// changed in /admin). In the Docker image this is bundled to predeploy.mjs
// and runs before `node server.js` (see the Dockerfile); `npm run
// build:deploy` runs it before `next build` on a native Node service.
//
// It runs on a Render deploy (RENDER=true), except pull-request previews
// (IS_PULL_REQUEST=true), and when BASE_WEB_MIGRATE=1 on any other host.
// SKIP_DB_MIGRATE=1 turns it off everywhere. If it fails, the process exits
// non-zero: the new deploy never goes live and the current site stays up.
import { migrateDatabase } from "./lib/migrate";
import { seedDatabase } from "./lib/seed";

export function shouldMigrate(e: Record<string, string | undefined>): { run: boolean; why: string } {
  if (e.SKIP_DB_MIGRATE === "1") return { run: false, why: "SKIP_DB_MIGRATE=1" };
  if (e.BASE_WEB_MIGRATE === "1") return { run: true, why: "BASE_WEB_MIGRATE=1" };
  if (e.RENDER === "true") return e.IS_PULL_REQUEST === "true" ? { run: false, why: "a Render pull-request preview" } : { run: true, why: "a Render deploy" };
  return { run: false, why: "not on Render (set BASE_WEB_MIGRATE=1 to run it here)" };
}

async function main() {
  const { run, why } = shouldMigrate(process.env);
  if (!run) {
    console.log(`Skipping database migrations (${why}).`);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set for this deploy. Set it in the service's Environment settings on Render.");
    process.exit(1);
  }
  try {
    await migrateDatabase(url);
    console.log("Database is up to date.");
    console.log(await seedDatabase(url));
  } catch (err) {
    console.error("Database migrations or the seed failed; this deploy stops here and the current site stays live.", err);
    process.exit(1);
  }
}

if (!process.env.VITEST) await main();
