// End-to-end runner: resets a dedicated test database, migrates and seeds it,
// builds the site, starts it with the fake Stripe server, runs the suites,
// and tears everything down. Usage:
//   npm run e2e              # all suites
//   npm run e2e -- api       # one suite
// Environment: E2E_DATABASE_URL (a database that may be WIPED), E2E_PORT,
// E2E_STRIPE_PORT, E2E_SKIP_BUILD=1 to reuse the last build. The desk suite
// also starts a server on E2E_HUMAN_PORT (default E2E_PORT + 1), and the mfa
// suite one on E2E_MFA_PORT (default E2E_PORT + 2).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const root = path.resolve(import.meta.dirname, "..");
const dbUrl = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/imagine_surrey_e2e";
const port = Number(process.env.E2E_PORT ?? 3100);
const stripePort = Number(process.env.E2E_STRIPE_PORT ?? 12111);
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ["api", "shifts", "tracker", "admin", "volunteer", "portal", "forms", "comms", "content", "shell", "desk", "visits", "mfa"];

const env = {
  ...process.env,
  DATABASE_URL: dbUrl,
  E2E_DATABASE_URL: dbUrl,
  E2E_PORT: String(port),
  E2E_STRIPE_PORT: String(stripePort),
  NEXT_PUBLIC_SITE_URL: `http://localhost:${port}`,
  STRIPE_SECRET_KEY: "sk_test_local",
  STRIPE_WEBHOOK_SECRET: "whsec_localtestsecret",
  STRIPE_API_BASE: `http://localhost:${stripePort}`,
  CONTRIBUTION_LIMIT_CENTS: "142970",
  MEMBERSHIP_FEE_CENTS: "1000",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "local-admin-pw",
  ADMIN_SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
  // Every suite forwards to the fake base ground in fake-stripe.mjs. The human
  // check stays off (Cloudflare's widget can't load offline); the desk suite
  // starts a second server with it on, against the fake siteverify.
  BASE_GROUND_URL: `http://localhost:${stripePort}`,
  BASE_GROUND_KEY: "sbk_e2eTestKey0123456789abcdefABCDEF",
  // The key the desk suite sends to POST /api/in/consent, as base ground would.
  BASE_GROUND_INBOUND_KEY: "e2e-inbound-key-0123456789abcdefABCDEF",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
  TURNSTILE_SECRET_KEY: "",
  TURNSTILE_VERIFY_URL: "",
  NODE_ENV: "production",
  // Current time-zone rules (BC is on permanent UTC-7 from November 2026); see tzdata/README.md.
  ICU_TIMEZONE_FILES_DIR: path.join(root, "tzdata"),
  // Next.js also reads .env.local; the suites always test the real sign-in gate.
  ADMIN_PREVIEW_MODE: "",
  // Owners and administrators must set up two-factor sign-in, which would
  // stop every suite at the enrolment page. The site honours this switch
  // only under this runner (E2E=1) or off production, never on Render; the
  // mfa suite starts its own server with the requirement on.
  E2E: "1",
  ADMIN_MFA_REQUIRED: "0",
};

function run(cmd, args, label) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

// A clean database every run.
if (!/(_e2e|_test|rls_check)\b/.test(new URL(dbUrl).pathname)) {
  console.error(`Refusing to wipe ${dbUrl}: the e2e database name must end in _e2e or _test.`);
  process.exit(1);
}
const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
await sql.unsafe("drop schema if exists drizzle cascade; drop schema public cascade; create schema public;");
await sql.end();
run("npx", ["tsx", "scripts/migrate.ts"], "migrate");
run("npx", ["tsx", "scripts/seed.ts"], "seed");
if (!process.env.E2E_SKIP_BUILD || !existsSync(path.join(root, ".next", "BUILD_ID"))) run("npx", ["next", "build"], "build");

const children = [];
const start = (cmd, args, extraEnv = {}) => {
  // Own process group, so stopping it also stops the server npx starts.
  const child = spawn(cmd, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(d));
  children.push(child);
  return child;
};
start("node", ["e2e/fake-stripe.mjs"], { PORT: String(stripePort) });
start("npx", ["next", "start", "-p", String(port)]);

async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up in ${ms / 1000}s`);
}
await waitFor(`http://localhost:${stripePort}/__log`);
await waitFor(`http://localhost:${port}/`);

async function refreshPublicPages() {
  const login = await fetch(`http://localhost:${port}/api/admin/login`, { method: "POST", body: new URLSearchParams({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const res = cookie ? await fetch(`http://localhost:${port}/api/admin/revalidate`, { method: "POST", headers: { cookie } }) : null;
  if (!res?.ok) console.error(`Could not refresh cached pages before the suite (${res?.status ?? login.status})`);
  // Sign-in left a staff session and an audit row; the suite starts clean.
  await resetSql`delete from admin_users`;
}

let failed = 0;
const resetSql = postgres(dbUrl, { max: 1, onnotice: () => {} });
for (const suite of suites) {
  console.log(`\n▶ suite: ${suite}`);
  // Each suite starts with the bootstrap owner only: suites test wrong
  // passwords, invite staff and change the owner's password, and none of that
  // may leak into the next suite. (Sign-in recreates the owner from
  // ADMIN_EMAIL + ADMIN_PASSWORD when no staff account exists.)
  await resetSql`delete from login_attempts`;
  await resetSql`delete from admin_users`;
  // Suites write straight to the database; refresh the public pages' cached
  // data so each suite sees what is really there.
  await refreshPublicPages();
  const r = spawnSync("node", [`e2e/${suite}.e2e.mjs`], { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0) failed += 1;
}
await resetSql.end();
function stopAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      c.kill();
    }
  }
}
process.on("exit", stopAll);
stopAll();
console.log(failed ? `\n${failed} suite(s) FAILED` : "\nAll e2e suites passed");
process.exit(failed ? 1 : 0);
