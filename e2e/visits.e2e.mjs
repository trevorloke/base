// The first-party visit counter: page views recorded by the beacon with no
// cookie, nothing identifying stored, the admin and portal never counted,
// bots skipped, old rows deleted by the daily job, and the four dashboard
// tiles. Run with `npm run e2e -- visits`.
import { chromium } from "playwright";
import { adminLogin, BASE, finish, ok, sql } from "./helpers.mjs";

// Headless Chromium says so in its user agent, and the counter skips it like any bot.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PACIFIC_TODAY = sql`(now() at time zone 'America/Vancouver')::date`;

const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fn();
};
const rows = (path) => sql`select * from page_views where path = ${path} order by created_at`;

/** Post a page view the way the beacon does, from a chosen IP and browser. */
async function beacon(body, { ip = "192.0.2.10", ua = UA, origin } = {}) {
  const headers = { "content-type": "text/plain;charset=UTF-8", "user-agent": ua, "x-forwarded-for": ip };
  if (origin) headers.origin = origin;
  return fetch(BASE + "/api/v", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

await sql`delete from page_views`;
await sql`delete from visit_salts`;

const browser = await chromium.launch();

// ── The beacon in a browser: recorded, with no cookie ─────────────────────
{
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/news");
  const news = await until(async () => (await rows("/news")).length > 0 && (await rows("/news")));
  ok(news.length === 1, "a page view of /news is recorded");
  ok(news[0].referrer_host === null && news[0].source === null && news[0].ref === null, "a direct visit has no referrer, source or ref");
  ok(/^[0-9a-f]{32}$/.test(news[0].visitor_hash), "the visitor is a 32-character hash");
  const [{ day, stored }] = await sql`select ${PACIFIC_TODAY}::text as day, (select day::text from page_views where path = '/news') as stored`;
  ok(stored === day, `the view is filed under today's Pacific date (${stored}, expected ${day})`);
  ok((await ctx.cookies()).length === 0, "no cookie was set by the visit or the counter");
  const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
  ok(storage[0] === 0 && storage[1] === 0, "nothing was written to localStorage or sessionStorage");
  ok((await sql`select count(*)::int as n from visit_salts`)[0].n === 1, "one salt for today");

  // Moving to another page inside the site is a page view too, by the same visitor, with no outside referrer.
  await page.locator('footer a[href="/volunteer"]').click();
  await page.waitForURL(BASE + "/volunteer");
  const vol = await until(async () => (await rows("/volunteer")).length > 0 && (await rows("/volunteer")));
  ok(vol.length === 1 && vol[0].visitor_hash === news[0].visitor_hash, "an in-site move is recorded for the same visitor");
  ok(vol[0].referrer_host === null, "a move within the site is not a referral");

  // A shared link with a tag, arriving from another site.
  await page.goto(BASE + "/act/skytrain-south-surrey?source=e2e-visits&ref=REFV1&email=someone%40example.com", { referer: "http://www.facebook.com/groups/surrey/posts/1" });
  const act = await until(async () => (await rows("/act/skytrain-south-surrey")).length > 0 && (await rows("/act/skytrain-south-surrey")));
  ok(act.length === 1, "the campaign page view is recorded under its path, without the query string");
  ok(act[0]?.source === "e2e-visits" && act[0]?.ref === "REFV1", "?source and ?ref are kept for the sign-up rate");
  ok(act[0]?.referrer_host === "facebook.com", `the referrer is stored as a bare hostname (${act[0]?.referrer_host})`);
  ok((await sql`select count(*)::int as n from page_views where path like '%?%' or path like '%someone%'`)[0].n === 0, "no stored path carries a query string or an email address");

  // The existing attribution cookie (from the tagged link) carries the source on to later pages.
  await page.goto(BASE + "/events");
  const ev = await until(async () => (await rows("/events")).length > 0 && (await rows("/events")));
  ok(ev[0]?.source === "e2e-visits", "a later page in the visit keeps the source from the attribution cookie");
  await ctx.close();
}

// ── The admin and the supporter portal are never counted ──────────────────
{
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await adminLogin(page);
  await page.goto(BASE + "/admin/people");
  await page.goto(BASE + "/me/login");
  // A public page last: once its view is in, any view the earlier pages sent would be too.
  await page.goto(BASE + "/tracker");
  await until(async () => (await rows("/tracker")).length > 0);
  ok((await rows("/tracker")).length === 1, "the public page after them is counted");
  ok((await sql`select count(*)::int as n from page_views where path like '/admin%' or path like '/me%' or path like '/api%'`)[0].n === 0, "no /admin or /me page view was recorded");
  await ctx.close();
}

// ── The endpoint: what it refuses and what it keeps ───────────────────────
{
  const r = await beacon({ path: "/admin/people", referrer: "" });
  ok(r.status === 204 && r.headers.get("set-cookie") === null, "the endpoint answers 204 and never sets a cookie");
  await beacon({ path: "/me/preferences" });
  await beacon({ path: "/api/promises" });
  await beacon({ path: "/shop" }, { ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
  await beacon({ path: "/shop" }, { ua: "facebookexternalhit/1.1" });
  await beacon({ path: "/shop" }, { origin: "https://evil.example" });
  await beacon("not json");
  await beacon({ path: "https://evil.example/" });
  ok((await sql`select count(*)::int as n from page_views where path in ('/admin/people', '/me/preferences', '/api/promises', '/shop') or path like 'http%'`)[0].n === 0, "admin, portal, API and malformed paths, bots and other sites' posts are not recorded");

  const IP = "203.0.113.77";
  const MARK = "VisitsE2EMarker/7.3";
  const ua = `${UA} ${MARK}`;
  const res = await beacon({ path: "/donate?amount=5000", referrer: `${BASE}/act`, source: "e2e-ip" }, { ip: IP, ua });
  ok(res.status === 204, "a page view is accepted");
  const donate = await until(async () => (await rows("/donate")).length > 0 && (await rows("/donate")));
  ok(donate.length === 1 && donate[0].referrer_host === null, "/donate stored without its query string, and the site's own address is not a referrer");
  const dump = JSON.stringify(await sql`select row_to_json(p)::text as r from page_views p`);
  ok(!dump.includes(IP) && !dump.includes("203.0.113") && !dump.includes(MARK) && !dump.includes("Chrome/130") && !dump.includes("amount"), "neither the IP address nor the user agent is anywhere in page_views");
  const cols = (await sql`select column_name from information_schema.columns where table_name = 'page_views' order by column_name`).map((c) => c.column_name);
  ok(JSON.stringify(cols) === JSON.stringify(["created_at", "day", "id", "path", "ref", "referrer_host", "source", "visitor_hash"]), `page_views has no column for an IP address or user agent (${cols.join(", ")})`);
  ok(!JSON.stringify(await sql`select * from visit_salts`).includes(IP), "nor is the IP address in the salts table");

  await beacon({ path: "/donate" }, { ip: IP, ua });
  await beacon({ path: "/donate" }, { ip: "203.0.113.78", ua });
  const hashes = (await rows("/donate")).map((r) => r.visitor_hash);
  ok(hashes.length === 3 && hashes[0] === hashes[1] && hashes[0] !== hashes[2], "the same IP and browser on the same day is one visitor; another IP is another");

  const LIMIT_IP = "198.51.100.200";
  for (let i = 0; i < 130; i++) await beacon({ path: "/rate-limit-check" }, { ip: LIMIT_IP });
  const limited = (await rows("/rate-limit-check")).length;
  ok(limited <= 120 && limited >= 100, `one IP address is rate-limited (${limited} of 130 kept)`);
  await beacon({ path: "/" + "p".repeat(1000) });
  const [{ longest }] = await sql`select coalesce(max(length(path)), 0)::int as longest from page_views`;
  ok(longest <= 200, `paths are capped at 200 characters (${longest})`);
}

// ── The dashboard's four tiles ─────────────────────────────────────────────
{
  await sql`delete from page_views`;
  const [{ week_start, today }] = await sql`select (${PACIFIC_TODAY} - extract(dow from ${PACIFIC_TODAY})::int)::text as week_start, ${PACIFIC_TODAY}::text as today`;
  const lastWeekDay = sql`(${week_start}::date - 3)`;
  const view = (day, hash, path, host, source) =>
    sql`insert into page_views (day, path, referrer_host, source, visitor_hash) values (${day}, ${path}, ${host}, ${source}, ${hash})`;
  // This week: three visitors, five views.
  await view(sql`${today}::date`, "a".repeat(32), "/", "facebook.com", "e2e-flyer");
  await view(sql`${today}::date`, "a".repeat(32), "/act", null, "e2e-flyer");
  await view(sql`${today}::date`, "b".repeat(32), "/act", "facebook.com", "e2e-flyer");
  await view(sql`${today}::date`, "c".repeat(32), "/act", "news.example.ca", null);
  await view(sql`${today}::date`, "c".repeat(32), "/donate", null, null);
  // Last week: two visitors, two views.
  await view(lastWeekDay, "d".repeat(32), "/", null, null);
  await view(lastWeekDay, "e".repeat(32), "/act", null, null);
  // Older than 30 days: in no tile.
  await view(sql`${today}::date - 40`, "f".repeat(32), "/old-page", "old.example", "e2e-flyer");
  // New supporters credited to the source, in each format the forms record it in, and two that must not match.
  for (const [email, source] of [
    ["flyer-1@visits.example", "petition:skytrain-south-surrey/e2e-flyer"],
    ["flyer-2@visits.example", "e2e-flyer"],
    ["flyer-3@visits.example", "volunteer:e2e-flyer"],
    ["flyer-4@visits.example", "e2e-flyer-two"],
    ["flyer-5@visits.example", "petition:x/xe2e-flyer"],
  ])
    await sql`insert into people (email, first_name, source) values (${email}, 'Flyer', ${source}) on conflict (email) do nothing`;

  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await adminLogin(page);
  await page.goto(BASE + "/admin");
  const cell = (tile, row, col) => page.locator(`[data-tile="${tile}"] tr${row} td[data-col="${col}"]`).textContent();
  ok((await page.locator("[data-tile]").count()) === 4, "the dashboard has four visit tiles");
  ok((await cell("week", '[data-row="visitors"]', "this")) === "3" && (await cell("week", '[data-row="visitors"]', "last")) === "2", "visits this week vs last week: 3 visitors against 2");
  ok((await cell("week", '[data-row="views"]', "this")) === "5" && (await cell("week", '[data-row="views"]', "last")) === "2", "page views this week vs last week: 5 against 2");
  ok((await cell("sources", '[data-source="e2e-flyer"]', "visitors")) === "2", "sign-up rate by source: 2 visitors tagged e2e-flyer in 30 days");
  ok((await cell("sources", '[data-source="e2e-flyer"]', "signups")) === "3" && (await cell("sources", '[data-source="e2e-flyer"]', "rate")) === "150%", "…and 3 new supporters with that source (150%)");
  const [{ people30 }] = await sql`select count(*)::int as people30 from people where created_at >= ((${today}::date - 29)::timestamp at time zone 'America/Vancouver')`;
  ok((await cell("sources", '[data-source="(all)"]', "visitors")) === "5" && (await cell("sources", '[data-source="(all)"]', "signups")) === String(people30), `all visits: 5 visitors and ${people30} new supporters in 30 days`);
  ok((await cell("pages", '[data-path="/act"]', "views")) === "4" && (await cell("pages", '[data-path="/act"]', "visitors")) === "4", "top pages: /act with 4 views by 4 visitors");
  ok((await page.locator('[data-tile="pages"] tbody tr').first().getAttribute("data-path")) === "/act", "the most viewed page comes first");
  ok((await page.locator('[data-tile="pages"] [data-path="/old-page"]').count()) === 0, "pages older than 30 days are left out");
  ok((await cell("referrers", '[data-host="facebook.com"]', "visitors")) === "2" && (await cell("referrers", '[data-host="news.example.ca"]', "visitors")) === "1", "where visitors come from: facebook.com 2, news.example.ca 1");
  ok((await page.locator('[data-tile="referrers"] [data-host="old.example"]').count()) === 0, "referrers older than 30 days are left out");
  ok((await sql`select count(*)::int as n from page_views where path like '/admin%'`)[0].n === 0, "reading the dashboard is not a page view");
  await ctx.close();

  // Nowhere else: the public pages show none of it.
  const home = await (await fetch(BASE + "/")).text();
  ok(!home.includes("e2e-flyer") && !home.includes("Website visits"), "the public site shows no visit numbers");
}

// ── Kept for 13 months, deleted by the daily job ───────────────────────────
{
  await sql`insert into page_views (day, path, visitor_hash) values (${PACIFIC_TODAY} - interval '14 months', '/too-old', ${"1".repeat(32)}), (${PACIFIC_TODAY} - interval '12 months', '/kept', ${"2".repeat(32)})`;
  await sql`insert into visit_salts (day, salt) values (${PACIFIC_TODAY} - 5, 'stale-salt') on conflict do nothing`;
  const r = await fetch(BASE + "/api/cron/email");
  const body = await r.json().catch(() => null);
  ok(r.status === 200 && body?.visits?.deleted >= 1, `the daily job reports deleted page views (${JSON.stringify(body?.visits)})`);
  ok((await rows("/too-old")).length === 0 && (await rows("/kept")).length === 1, "page views older than 13 months are deleted, younger ones kept");
  ok((await sql`select count(*)::int as n from visit_salts where salt = 'stale-salt'`)[0].n === 0, "salts older than a day are deleted");
}

await browser.close();
await finish();
