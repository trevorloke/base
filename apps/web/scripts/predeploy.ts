// Runs before `next build` on a deploy: on Vercel through the "vercel-build"
// script, on Render through the build command `npm ci && npm run build:deploy`.
// On a production deploy it brings the database up to date: pending
// migrations, then the seed, which only adds missing rows (it never
// overwrites anything changed in /admin). Previews and local builds skip it.
// Set SKIP_DB_MIGRATE=1 to skip it on production too.
import { spawnSync } from "node:child_process";

// Vercel marks production deploys with VERCEL_ENV; Render sets RENDER=true on
// every deploy and IS_PULL_REQUEST=true on pull-request previews.
const onRender = process.env.RENDER === "true";
const production = process.env.VERCEL_ENV === "production" || (onRender && process.env.IS_PULL_REQUEST !== "true");
if (!production || process.env.SKIP_DB_MIGRATE === "1") {
  const why = production ? "SKIP_DB_MIGRATE=1" : onRender ? "a Render pull-request preview" : `VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}`;
  console.log(`Skipping database migrations (${why}).`);
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set for this production deploy. Set it in the host's environment settings (Vercel: Settings, Environment Variables; Render: the service's Environment tab).");
  process.exit(1);
}
for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
  const r = spawnSync("npx", ["tsx", script], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`${script} failed; the deploy stops here and the current site stays live.`);
    process.exit(r.status ?? 1);
  }
}
