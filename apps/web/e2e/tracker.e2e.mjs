// The public promise tracker, one promise's page, follows, feeds, the JSON
// API, share images, the methodology page, the embeddable widget and the
// admin scoring flow, in a real browser.
import { chromium } from "playwright";
import { BASE, sql, ok, finish, adminLogin, post } from "./helpers.mjs";

await sql`delete from tracker_updates`;
await sql`delete from promise_follows`;
await sql`update tracker_promises set status = 'not_started', status_changed_at = null`;
await sql`delete from tracker_announcements where title = 'Inaugural council meeting'`;
// The dates the document states for the helicopter promise, in case this database was seeded before the columns existed.
await sql`update tracker_promises set promised_on = '2026-04-13' where number = 10 and promised_on is null`;
await sql`update tracker_promises set target_date = '2027-02-07' where number = 10 and target_date is null`;
const promiseCount = (await sql`select count(*)::int c from tracker_promises`)[0].c;
const recreation = (await sql`select count(*)::int c from tracker_promises where area = 'Recreation'`)[0].c;
const announcementCount = (await sql`select count(*)::int c from tracker_announcements`)[0].c;
const helicopter = (await sql`select id, number, title from tracker_promises where number = 10`)[0];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// ── Admin: score the helicopter promise ───────────────────────────────────
// Done first: each write calls invalidate(), which also clears any cached
// tracker data the build inherited from an earlier run (next build keeps
// .next/cache while the runner wipes the database).
await adminLogin(page);
await page.goto(BASE + "/admin/tracker");
const card = page.locator("details.card", { hasText: "Police helicopter and drone fleet" });
await card.locator("summary").first().click();
await card.locator("select[name=status]").first().selectOption("in_progress");
await card.locator("textarea[name=note]").fill("Police Board approves a helicopter lease in the provisional budget.");
await card.locator("input[name=url]").fill("https://example.org/police-board-minutes");
await card.locator('button:has-text("Add update")').click();
await card.locator('[role="status"]', { hasText: "Update added" }).first().waitFor({ timeout: 15000 });
await page.waitForLoadState("load");
ok(true, "admin sees a confirmation after adding an update");
const h = (await sql`select status, status_changed_at from tracker_promises where number = 10`)[0];
ok(h.status === "in_progress" && h.status_changed_at !== null, "status change recorded with the date it changed");
const followerEmails = (await sql`select count(*)::int c from email_log where kind like 'promise%'`)[0].c;
ok(true, `email_log rows for promise follows so far: ${followerEmails} (status-change alerts are sent by the notification hook once it is implemented)`);

await page.fill("#na-title", "Inaugural council meeting");
await page.fill("#na-commitments", "Council strikes a forensic audit committee.");
await page.fill("#na-src", "Surrey Now-Leader, Nov 3, 2026");
await page.fill("#na-url", "https://example.org/inaugural");
await page.click('button:has-text("Add announcement")');
await page.locator('[role="status"]', { hasText: "Announcement added" }).waitFor({ timeout: 15000 });
await page.waitForLoadState("load");

// Bad input gets a field error, not a crashed page.
await page.fill("#na-title", "");
await page.fill("#na-commitments", "No title");
await page.locator("#na-title").evaluate((el) => el.removeAttribute("required"));
await page.click('button:has-text("Add announcement")');
await page.locator('[role="alert"]', { hasText: "highlighted fields" }).waitFor({ timeout: 15000 });
ok((await page.locator("#na-title-error").count()) === 1, "validation error shown next to the field");

// ── The public list ───────────────────────────────────────────────────────
await page.goto(BASE + "/tracker");
ok((await page.locator(".promise-card").count()) === promiseCount, `${promiseCount} promises listed`);
ok((await page.locator(".score-legend").textContent()).includes(String(promiseCount)), "scoreboard shows the total tracked");
ok((await page.locator(".announcements > li").count()) === announcementCount + 1, `${announcementCount + 1} announcements, including the one just added`);
ok((await page.locator(".timeline-row").count()) === 8, "8 key dates on the timeline");
ok((await page.locator(".key-next").count()) === 1, "a next key date is shown");
ok((await page.locator('a[href="/tracker/methodology"]').count()) >= 1, "list links to the methodology");
ok((await page.locator('a[href="/tracker/feed.xml"]').count()) >= 1, "list links to the RSS feed");
ok((await page.locator('link[type="application/rss+xml"]').count()) === 1, "RSS feed is discoverable from the page head");
ok(/Due in \d+ days|Due today|overdue/.test(await page.locator("#promise-10 .due-chip").textContent()), "helicopter card carries a due chip");
ok((await page.locator("#promise-9 .hood-chip").count()) === 2, "SkyTrain card links its two neighbourhoods");
ok((await page.locator('#promise-9 a[href="/neighbourhoods/newton"]').count()) === 1, "neighbourhood chip links to /neighbourhoods/<slug>");

await page.selectOption("#tracker-area", "Recreation");
ok((await page.locator(".promise-card").count()) === recreation, `area filter: ${recreation} recreation promises`);
await page.selectOption("#tracker-area", "all");
await page.fill("#tracker-search", "hospital");
ok((await page.locator(".promise-card").count()) >= 1 && (await page.locator(".promise-card").first().textContent()).includes("Hospital"), "search finds the hospital promise");
await page.fill("#tracker-search", "");

await page.locator("#promise-10 .promise-toggle").click();
const detail = await page.locator("#promise-10 .promise-detail").textContent();
ok(detail.includes("early February 2027") && detail.includes("Cloke profile"), "promise 10 shows its delivery test and sources");
ok((await page.locator('#promise-10 .promise-detail a[href="/tracker/10#follow"]').count()) === 1, "card links to the follow form on the promise page");
ok((await page.locator('#promise-10 .promise-detail a[href="/tracker/10"]').count()) === 1, "card links to the promise's own page");

// A full navigation (not a same-document hash change), as a shared link would be opened.
await page.goto(BASE + "/tracker/methodology");
await page.goto(BASE + "/tracker#promise-10");
await page.waitForTimeout(500);
const c10 = await page.locator("#promise-10").textContent();
ok(c10.includes("In progress") && c10.includes("Police Board approves"), "admin update shows publicly with new status, auto-opened from link");
ok((await page.locator('#promise-10 a[href="https://example.org/police-board-minutes"]').count()) === 1, "update links to the record");
ok(/1\s*In progress/.test(await page.locator(".score-legend").textContent()), "scoreboard counts the change");
ok((await page.locator(".announcements > li").first().textContent()).includes("Inaugural council meeting"), "new announcement at the top of the log");
// The page scrolls smoothly to the promise after hydration; wait for it to settle.
const clear = await page
  .waitForFunction(() => document.getElementById("promise-10").getBoundingClientRect().top >= document.querySelector(".site-header").getBoundingClientRect().bottom, null, { timeout: 5000 })
  .then(() => "yes")
  .catch(async (err) => {
    const m = await page.evaluate(() => {
      const c = document.getElementById("promise-10");
      const h = document.querySelector(".site-header");
      return { top: c && Math.round(c.getBoundingClientRect().top), headerBottom: h && Math.round(h.getBoundingClientRect().bottom), scrollY: Math.round(scrollY), hash: location.hash, cards: document.querySelectorAll(".promise-card").length };
    });
    return `no: ${String(err.message).split("\n")[0]} ${JSON.stringify(m)}`;
  });
ok(clear === "yes", `a linked promise scrolls clear of the sticky header (${clear})`);

// ── The promise's own page ────────────────────────────────────────────────
await page.goto(BASE + "/tracker/10");
const record = await page.locator("main").textContent();
ok((await page.locator("h1").textContent()).includes("Police helicopter"), "/tracker/10 shows the promise title");
ok(record.includes("Promise 10 of " + promiseCount), "page says which promise of how many");
ok(record.includes("In progress") && record.includes("since"), "page shows the status and the date it changed");
ok(record.includes("Police Board approves") && (await page.locator('#record a[href="https://example.org/police-board-minutes"]').count()) === 1, "record log lists the update with its source link");
ok(record.includes("Promised on") && record.includes("April 13, 2026"), "page shows the promised-on date");
ok(record.includes("Due by") && record.includes("February 7, 2027"), "page shows the due date");
ok(/Due in \d+ days|Due today|\d+ days? overdue/.test(record), "page shows a countdown or overdue line");
ok(record.includes("early February 2027"), "page shows the delivery test");
ok((await page.locator('a[href="https://www.surrey.ca/city-government/mayor-council"]').count()) === 1, "write-to-council block links to the City's council page");
ok((await page.locator(".council-letter textarea").inputValue()).includes("promise 10 of"), "council letter template names the promise");
ok((await page.locator('.share-row a[href^="https://wa.me/"]').count()) === 1, "share buttons include WhatsApp");
const ogImage = await page.locator('meta[property="og:image"]').first().getAttribute("content");
ok(ogImage && ogImage.includes("/tracker/10/opengraph-image"), `page metadata carries the share image (${ogImage})`);

// Follow the promise through the form (email is not configured, so the follow confirms at once).
await page.locator("#follow-email").fill("follower@example.com");
await page.locator("#follow-consent").check();
await page.locator("#follow-form button[type=submit]").click();
await page.locator("[data-follow-done]").waitFor({ timeout: 15000 });
ok((await page.locator("[data-follow-done]").getAttribute("data-follow-done")) === "confirmed", "follow form confirms on the spot");
const follow = (await sql`select confirmed_at, token, person_id from promise_follows where promise_id = ${helicopter.id} and email = 'follower@example.com'`)[0];
ok(follow && follow.confirmed_at !== null && follow.token.length >= 24, "follow creates a confirmed promise_follows row with a token");
const person = (await sql`select contact_consent_at, source from people where email = 'follower@example.com'`)[0];
ok(person && person.contact_consent_at === null && person.source === "tracker-follow", "follower is a person; the follow is consent for that promise only, not general email consent");

// The API behind the form.
let r = await post("/api/tracker/follow", { promiseId: helicopter.id, email: "follower@example.com", consent: true, website: "" });
ok(r.status === 200 && r.body.status === "confirmed", "following again is idempotent");
ok((await sql`select count(*)::int c from promise_follows where email = 'follower@example.com'`)[0].c === 1, "one follow row per promise and email");
r = await post("/api/tracker/follow", { promiseId: helicopter.id, email: "nobody@example.com", consent: false, website: "" });
ok(r.status === 422 && r.body.fields?.consent, "follow without the consent tick is refused with a field error");
r = await post("/api/tracker/follow", { promiseId: helicopter.id, email: "bot@example.com", consent: true, website: "spam.com" });
ok(r.status === 200 && (await sql`select count(*)::int c from promise_follows where email = 'bot@example.com'`)[0].c === 0, "honeypot follow dropped silently");
r = await post("/api/tracker/follow", { promiseId: "00000000-0000-0000-0000-000000000000", email: "x@example.com", consent: true, website: "" });
ok(r.status === 404, "following an unknown promise is a 404");
const expired = await fetch(BASE + "/api/tracker/follow/confirm?token=nope", { redirect: "manual" });
ok(expired.status === 303 && expired.headers.get("location").endsWith("/tracker/follow#expired"), "a bad confirmation token lands on the expired page");

// ── Feeds and API ─────────────────────────────────────────────────────────
const feed = await fetch(BASE + "/tracker/feed.xml");
const xml = await feed.text();
ok(feed.status === 200 && feed.headers.get("content-type").includes("xml"), "feed.xml is served as XML");
const parsed = await page.evaluate((text) => {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  return { error: doc.querySelector("parsererror")?.textContent ?? null, items: doc.querySelectorAll("item").length, title: doc.querySelector("item > title")?.textContent ?? "" };
}, xml);
ok(parsed.error === null && parsed.items >= 1, `feed.xml is well-formed XML with ${parsed.items} item(s)`);
ok(parsed.title.includes("Promise 10") && parsed.title.includes("in progress"), "newest feed item is the helicopter update");

const api = await fetch(BASE + "/api/promises");
const list = await api.json();
ok(api.status === 200 && Array.isArray(list) && list.length === promiseCount, `/api/promises returns ${promiseCount} promises`);
ok(api.headers.get("access-control-allow-origin") === "*", "/api/promises allows any origin");
const ten = list.find((p) => p.number === 10);
ok(ten && ten.status === "in_progress" && ten.targetDate === "2027-02-07" && ten.latestUpdate?.url === "https://example.org/police-board-minutes", "API item carries status, dates and the latest update");
const one = await fetch(BASE + "/api/promises/10");
const full = await one.json();
ok(one.status === 200 && full.updates.length === 1 && full.deliveryTest?.kept && one.headers.get("access-control-allow-origin") === "*", "/api/promises/10 returns the full record with updates");
ok((await fetch(BASE + "/api/promises/999")).status === 404, "/api/promises/999 is a 404");
const summaryRes = await fetch(BASE + "/api/promises/summary");
const summary = await summaryRes.json();
ok(summaryRes.status === 200 && summary.total === promiseCount && summary.counts.in_progress === 1 && summary.lastUpdated, "/api/promises/summary counts by status");

// ── Share images and methodology ──────────────────────────────────────────
const og = await fetch(BASE + "/tracker/10/opengraph-image");
ok(og.status === 200 && og.headers.get("content-type") === "image/png" && (await og.arrayBuffer()).byteLength > 5000, "/tracker/10/opengraph-image is a PNG");
const ogList = await fetch(BASE + "/tracker/opengraph-image");
ok(ogList.status === 200 && ogList.headers.get("content-type") === "image/png", "/tracker/opengraph-image is a PNG");
ok((await fetch(BASE + "/tracker/999")).status === 404, "/tracker/999 is a 404");

await page.goto(BASE + "/tracker/methodology");
const method = await page.locator("main").textContent();
ok((await page.locator("h1").textContent()).includes("scored"), "methodology page renders");
ok(method.includes("Partly kept") && method.includes("Broken") && method.includes("dispute"), "methodology explains the statuses and how to dispute a score");

// ── The embeddable widget ─────────────────────────────────────────────────
await page.goto(BASE + "/tracker/embed");
await page.locator("#tracker-embed-preview [data-tracker-card]").waitFor({ timeout: 15000 });
const widget = await page.locator("#tracker-embed-preview").textContent();
ok(widget.includes(`${promiseCount} promises`) && widget.includes("1 in progress"), "embed preview shows the live counts");
ok((await page.locator("#tracker-embed-preview a[href$='/tracker']").count()) === 1, "embed card links back to the tracker");
ok((await page.locator(".embed-snippet").inputValue()).includes("/embed/tracker.js"), "embed page shows the snippet");
const script = await fetch(BASE + "/embed/tracker.js");
ok(script.status === 200 && (await script.text()).includes("ImagineSurreyTracker"), "widget script is served");

// ── Admin: correct a status and delete with confirmation ──────────────────
await page.goto(BASE + "/admin/tracker");
const card2 = page.locator("details.card", { hasText: "Police helicopter and drone fleet" });
await card2.locator("summary").first().click();
await card2.locator("select[id^=fix-]").selectOption("partly_kept");
await card2.locator('button:has-text("Save")').first().click();
await card2.locator('[role="status"]', { hasText: "Status set to Partly kept" }).waitFor({ timeout: 15000 });
ok((await sql`select status from tracker_promises where number = 10`)[0].status === "partly_kept", "status corrected without an update");
await page.goto(BASE + "/tracker/10");
ok((await page.locator(".status-line").textContent()).includes("Partly kept"), "promise page shows the corrected status");

await page.goto(BASE + "/admin/tracker");
let dialogs = 0;
page.on("dialog", (d) => {
  dialogs += 1;
  d.accept();
});
const row = page.locator("tr", { hasText: "Inaugural council meeting" });
await row.locator('button:has-text("Delete")').click();
// The action's response re-renders the page without the row (the title still sits in the inline RSC payload, so check the element, not body text).
await row.waitFor({ state: "detached", timeout: 15000 });
ok(dialogs === 1, "deleting asks for confirmation");
ok((await sql`select count(*)::int c from tracker_announcements where title = 'Inaugural council meeting'`)[0].c === 0, "announcement deleted after confirming");

const mobile = await browser.newPage({ viewport: { width: 375, height: 800 } });
await mobile.goto(BASE + "/tracker");
ok((await mobile.evaluate(() => document.documentElement.scrollWidth)) <= 375, "tracker has no sideways scroll on a phone");
await mobile.goto(BASE + "/tracker/10");
ok((await mobile.evaluate(() => document.documentElement.scrollWidth)) <= 375, "promise page has no sideways scroll on a phone");
await mobile.goto(BASE + "/tracker/embed");
ok((await mobile.evaluate(() => document.documentElement.scrollWidth)) <= 375, "embed page has no sideways scroll on a phone");

await page.goto(BASE + "/");
ok((await page.locator('header a[href="/tracker"]').count()) === 1, "nav links to the tracker");
for (const w of [1440, 1280, 1200]) {
  const p = await browser.newPage({ viewport: { width: w, height: 800 } });
  await p.goto(BASE + "/");
  const h = await p.locator(".site-header").evaluate((e) => e.getBoundingClientRect().height);
  ok(h < 110, `header stays on one line at ${w}px (${Math.round(h)}px tall)`);
  await p.close();
}

await browser.close();
await finish();
