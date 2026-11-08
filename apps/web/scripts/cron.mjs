// A Render cron job's command: calls one of the site's daily jobs and fails
// (exit 1) if the site doesn't answer 2xx, so Render shows the run as failed.
//
//   node scripts/cron.mjs reminders     # /api/cron/reminders
//   node scripts/cron.mjs email         # /api/cron/email
//
// Needs CRON_SECRET (the same value as on the web service) and where to find
// the site: BASE_WEB_INTERNAL_URL (Render's private "hostport", e.g.
// base-web-imaginesurrey:10000, or a full URL) if set, else
// NEXT_PUBLIC_SITE_URL. No dependencies: it runs straight from the repository.
const job = process.argv[2];
if (job !== "reminders" && job !== "email") {
  console.error("Usage: node scripts/cron.mjs reminders|email");
  process.exit(2);
}
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set for this cron job.");
  process.exit(1);
}
const internal = process.env.BASE_WEB_INTERNAL_URL?.trim();
const base = (internal ? (/^https?:\/\//.test(internal) ? internal : `http://${internal}`) : process.env.NEXT_PUBLIC_SITE_URL?.trim())?.replace(/\/+$/, "");
if (!base) {
  console.error("Set BASE_WEB_INTERNAL_URL or NEXT_PUBLIC_SITE_URL so the job knows where the site is.");
  process.exit(1);
}
const url = `${base}/api/cron/${job}`;
try {
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  console.log(`${res.status} ${url}\n${text.slice(0, 2000)}`);
  if (!res.ok) process.exit(1);
} catch (err) {
  console.error(`Could not reach ${url}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}
