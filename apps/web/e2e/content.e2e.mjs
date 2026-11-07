// The content admin, driven in a real browser: news with an uploaded image
// (published and scheduled), site settings, free-form pages on /[slug],
// events with RSVP check-in and walk-ins, campaigns, the media library and
// the integrations page. Run with `npm run e2e -- content`.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";
import { ADMIN_PASSWORD, BASE, finish, ok, post, sql } from "./helpers.mjs";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
const root = path.resolve(import.meta.dirname, "..");
const COOKIE = "is_admin_session";

// ── Helpers ───────────────────────────────────────────────────────────────

async function eventually(fn, ms = 20_000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A tiny solid-navy PNG, built here so the test needs no fixture files. */
function tinyPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + 1 + x * 3;
      raw[i] = 0x00;
      raw[i + 1] = 0x39;
      raw[i + 2] = 0x79;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** "YYYY-MM-DDTHH:mm" in Surrey time, `days` from now at the given hour. */
function pacificLocal(days, hour) {
  const d = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}T${String(hour).padStart(2, "0")}:00`;
}

async function loginCookie() {
  const res = await fetch(BASE + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.9.8.7" },
    body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, next: "/admin" }),
    redirect: "manual",
  });
  const match = new RegExp(`${COOKIE}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  return { status: res.status, location: res.headers.get("location"), value: match?.[1] };
}

const html = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, text: await r.text() };
};

// ── Seeds and public pages ────────────────────────────────────────────────

const seeded = spawnSync(
  "npx",
  [
    "tsx",
    "--eval",
    'import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { seed } from "./src/content/seeds/pages.ts"; (async () => { const c = postgres(process.env.DATABASE_URL, { max: 1 }); await seed(drizzle(c)); await c.end(); })().catch((e) => { console.error(e); process.exit(1); });',
  ],
  { cwd: root, env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL }, encoding: "utf8" },
);
ok(seeded.status === 0, "page seeds load" + (seeded.status === 0 ? "" : ": " + seeded.stderr.trim().split("\n").slice(-3).join(" | ")));
const seededPages = await sql`select slug, published, show_in_footer from site_pages order by slug`;
ok(seededPages.length === 2 && seededPages[1].slug === "privacy" && seededPages[1].show_in_footer === true && seededPages[0].slug === "accessibility", "privacy (in footer) and accessibility pages seeded, both published");

let r = await html("/privacy");
ok(r.status === 200 && r.text.includes("Privacy policy") && r.text.includes("Draft for review") && r.text.includes("<h2>What we collect</h2>"), "/privacy renders the seeded page as HTML with headings");
r = await html("/accessibility");
ok(r.status === 200 && r.text.includes("WCAG"), "/accessibility renders");
r = await html("/no-such-page");
ok(r.status === 404, "unknown /[slug] is a 404");
r = await html("/not.a.slug");
ok(r.status === 404, "a slug with dots is a 404 without touching the database");

// ── Sign-in and gates ─────────────────────────────────────────────────────

let res = await fetch(BASE + "/api/admin/media", { method: "POST", body: new FormData() });
ok(res.status === 401, "media upload needs an admin session");
res = await fetch(BASE + "/admin/content", { redirect: "manual" });
ok(res.status >= 300 && res.status < 400 && /\/admin\/login/.test(res.headers.get("location") ?? ""), "admin content pages redirect to sign-in");

const login = await loginCookie();
ok(Boolean(login.value) && login.status === 303, `password sign-in sets the session cookie (status ${login.status}, to ${login.location})`);
const authed = { cookie: `${COOKIE}=${login.value}` };

const browser = await chromium.launch();
// Reduced motion turns off smooth scrolling, so clicks below the fold land at once.
const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, reducedMotion: "reduce" });
await context.addCookies([{ name: COOKIE, value: login.value, domain: "localhost", path: "/" }]);
const page = await context.newPage();
page.on("dialog", (d) => d.accept());

await page.goto(BASE + "/admin/content");
ok((await page.locator(".cms-card").count()) >= 6, "content hub lists the sections");

// ── News: publish with an uploaded image ──────────────────────────────────

await page.goto(BASE + "/admin/content/news/new");
await page.fill("#title", "Imagine Surrey opens a Newton office");
ok((await page.inputValue("#slug")) === "imagine-surrey-opens-a-newton-office", "slug follows the headline");
await page.fill("#summary", "Drop in Tuesday to Saturday.");
await page.fill("#body", "## Welcome\n\nWe **opened** the doors today.");
await page.locator(".md-preview h2").waitFor({ timeout: 15_000 });
ok((await page.locator(".md-preview").innerHTML()).includes("<strong>opened</strong>"), "live Markdown preview renders headings and bold");
await page.setInputFiles("#image-file", { name: "office.png", mimeType: "image/png", buffer: tinyPng(4, 3) });
// The preview <img> can't be relied on here: `next start` only serves files that existed at startup.
await page.waitForFunction(() => /^\/uploads\//.test(document.querySelector("#image-url")?.value ?? ""), null, { timeout: 15_000 });
const uploadedUrl = await page.locator("#image-url").inputValue();
ok((await page.locator(".image-field-preview img").count()) === 1, "image preview switches to the uploaded file");
ok(/^\/uploads\/\d{4}\/\d{2}\/[0-9a-f]+-office\.png$/.test(uploadedUrl), "upload stored the file and filled the URL: " + uploadedUrl);
await page.fill("#image-alt", "Our new office");
await page.click('button:has-text("Publish now")');
await page.waitForURL(/\/admin\/content\/news\/[0-9a-f-]{36}\?saved=created/, { timeout: 20_000 });
ok(true, "publishing redirects to the edit page");
const [post1] = await sql`select id, slug, image_url, image_alt, published_at from news_posts where title = 'Imagine Surrey opens a Newton office'`;
ok(post1 && post1.published_at && post1.published_at <= new Date() && post1.image_url === uploadedUrl && post1.image_alt === "Our new office", "post saved as published with its image and alt text");
const [mediaRow] = await sql`select id, width, height, alt, mime from media where filename = 'office.png'`;
ok(mediaRow && mediaRow.width === 4 && mediaRow.height === 3 && mediaRow.mime === "image/png", "media row records the PNG's size");
ok((await page.locator(".cms-badge--live").count()) >= 1, "edit page shows the Published badge");

const onNews = await eventually(async () => (await html("/news")).text.includes("Imagine Surrey opens a Newton office"));
ok(onNews, "published post appears on /news");
r = await html(`/news/${post1.slug}`);
ok(r.status === 200 && r.text.includes("Imagine Surrey opens a Newton office"), "post page renders");

// ── News: schedule for tomorrow ───────────────────────────────────────────

await page.goto(BASE + "/admin/content/news/new");
await page.fill("#title", "Scheduled for tomorrow");
await page.fill("#summary", "Not yet.");
await page.fill("#body", "Coming soon.");
await page.fill("#scheduledAt", pacificLocal(1, 9));
await page.click('button:has-text("Schedule")');
await page.waitForURL(/\/admin\/content\/news\/[0-9a-f-]{36}\?saved=created/, { timeout: 20_000 });
const [post2] = await sql`select published_at > now() as future from news_posts where title = 'Scheduled for tomorrow'`;
ok(post2?.future === true, "scheduled post has a future publish date");
ok((await page.locator(".cms-badge--scheduled").count()) >= 1, "edit page shows the Scheduled badge");
await new Promise((rs) => setTimeout(rs, 1500));
r = await html("/news");
ok(r.text.includes("Imagine Surrey opens a Newton office") && !r.text.includes("Scheduled for tomorrow"), "scheduled post is not on /news yet");
await page.goto(BASE + "/admin/content/news");
ok((await page.locator("tr", { hasText: "Scheduled for tomorrow" }).locator(".cms-badge--scheduled").count()) === 1, "news list marks it Scheduled");

// Validation: a scheduled time in the past is refused with a field error.
await page.goto(BASE + "/admin/content/news/new");
await page.fill("#title", "Bad schedule");
await page.fill("#summary", "x");
await page.fill("#body", "x");
await page.fill("#scheduledAt", "2020-01-01T09:00");
await page.click('button:has-text("Schedule")');
await page.locator("[role=alert]").waitFor({ timeout: 15_000 });
ok((await page.locator("#scheduledAt-error").textContent()).includes("future"), "past schedule time shows a field error");
ok(
  (await page.inputValue("#title")) === "Bad schedule" && (await page.inputValue("#summary")) === "x" && (await page.inputValue("#body")) === "x" && (await page.inputValue("#scheduledAt")) === "2020-01-01T09:00",
  "a refused post keeps everything that was typed",
);
// Another post already uses this address: the error keeps the summary, body and image too.
await page.fill("#slug", post1.slug);
await page.fill("#summary", "A summary worth keeping.");
await page.fill("#image-url", uploadedUrl);
await page.fill("#image-alt", "Kept alt text");
await page.click('button:has-text("Save as draft")');
await page.locator("#slug-error").waitFor({ timeout: 15_000 });
ok(
  (await page.inputValue("#summary")) === "A summary worth keeping." && (await page.inputValue("#slug")) === post1.slug && (await page.inputValue("#image-url")) === uploadedUrl && (await page.inputValue("#image-alt")) === "Kept alt text",
  "a slug clash keeps the summary, the address and the image as typed",
);
ok((await sql`select count(*)::int c from news_posts where title = 'Bad schedule'`)[0].c === 0, "nothing was saved for the refused post");

// ── Site settings ─────────────────────────────────────────────────────────

await page.goto(BASE + "/admin/settings");
ok((await page.locator(".cms-card").count()) === 16 && (await page.locator(".cms-badge--draft", { hasText: "Default" }).count()) === 16, "settings index lists 16 sections, all at defaults");
await page.goto(BASE + "/admin/settings/announcement");
await page.check("#sf-enabled");
await page.fill("#sf-text", "Town hall this Saturday in Newton");
await page.fill("#sf-linkLabel", "RSVP");
await page.fill("#sf-linkHref", "/events");
await page.click('button:has-text("Save changes")');
await page.locator("[role=status]", { hasText: "Saved" }).waitFor({ timeout: 15_000 });
const [announcement] = await sql`select value from site_settings where key = 'announcement'`;
ok(announcement && announcement.value.enabled === true && announcement.value.text === "Town hall this Saturday in Newton" && announcement.value.linkHref === "/events", "announcement section saved as validated JSON in site_settings");
await page.goto(BASE + "/admin/settings");
ok((await page.locator(".cms-card", { hasText: "Announcement bar" }).locator(".cms-badge--live").count()) === 1, "index shows the section as customized");

// A refused settings save keeps the section as typed (the server check, past the browser's own).
await page.goto(BASE + "/admin/settings/org");
await page.evaluate(() => document.querySelectorAll("form").forEach((f) => (f.noValidate = true)));
await page.fill("#sf-phone", "604 555 0100");
await page.fill("#sf-email", "not-an-email");
await page.click('button:has-text("Save changes")');
await page.locator(".cms-form [role=alert]").waitFor({ timeout: 15_000 });
ok((await page.inputValue("#sf-email")) === "not-an-email" && (await page.inputValue("#sf-phone")) === "604 555 0100", "a settings error keeps the section as typed");
ok((await sql`select count(*)::int c from site_settings where key = 'org'`)[0].c === 0, "and saves nothing");

await page.goto(BASE + "/admin/settings/hero");
const wordsBefore = await page.locator('input[id^="sf-words-"]').count();
await page.click('button:has-text("Add word")');
await page.fill(`#sf-words-${wordsBefore}`, "clean parks");
await page.click('button[aria-label="Move word 1 down"]');
await page.click('button:has-text("Save changes")');
await page.locator("[role=status]", { hasText: "Saved" }).waitFor({ timeout: 15_000 });
const [hero] = await sql`select value from site_settings where key = 'hero'`;
ok(hero && hero.value.words.length === wordsBefore + 1 && hero.value.words.at(-1) === "clean parks" && hero.value.words[1] === "Surrey", "list editor adds and reorders items; hero saved with every other default intact");
ok(hero.value.image.url === "/images/hero-park.jpg" && hero.value.primaryCta.label === "Become a member", "nested image and group values round-trip unchanged");
await page.click('button:has-text("Reset to defaults")');
await page.locator("[role=status]", { hasText: "Reset" }).waitFor({ timeout: 15_000 });
ok((await sql`select count(*)::int c from site_settings where key = 'hero'`)[0].c === 0, "reset removes the override row");

// ── Pages ─────────────────────────────────────────────────────────────────

await page.goto(BASE + "/admin/pages/new");
await page.fill("#title", "Volunteer handbook");
ok((await page.inputValue("#slug")) === "volunteer-handbook", "page slug follows the title");
await page.fill("#summary", "How we door-knock.");
await page.fill("#body", "## Welcome aboard\n\nThanks for **joining**.\n\n- Be kind\n- Be on time");
await page.check('input[name="published"]');
await page.click('button:has-text("Create page")');
await page.waitForURL(/\/admin\/pages\/[0-9a-f-]{36}\?saved=created/, { timeout: 20_000 });
r = await eventually(async () => {
  const x = await html("/volunteer-handbook");
  return x.status === 200 && x.text.includes("<h2>Welcome aboard</h2>") ? x : null;
});
ok(Boolean(r) && r.text.includes("<strong>joining</strong>") && r.text.includes("<li>Be kind</li>") && r.text.includes("Volunteer handbook"), "created page is served at /volunteer-handbook as rendered Markdown");
await page.uncheck('input[name="published"]');
await page.click('button:has-text("Save changes")');
await page.locator("[role=status]", { hasText: "draft" }).waitFor({ timeout: 15_000 });
r = await eventually(async () => ((await html("/volunteer-handbook")).status === 404 ? true : null));
ok(r === true, "unpublishing takes the page off the site");

await page.goto(BASE + "/admin/pages/new");
await page.fill("#title", "News");
await page.fill("#summary", "Kept summary");
await page.fill("#body", "Kept body");
await page.check('input[name="showInFooter"]');
await page.click('button:has-text("Create page")');
await page.locator("[role=alert]").waitFor({ timeout: 15_000 });
ok((await page.locator("#slug-error").textContent()).includes("already part of the site"), "a reserved address is refused");
ok(
  (await page.inputValue("#summary")) === "Kept summary" && (await page.inputValue("#body")) === "Kept body" && (await page.isChecked('input[name="showInFooter"]')) && !(await page.isChecked('input[name="published"]')),
  "and the page keeps what was typed, ticks included",
);

// ── Events, RSVPs and check-in ────────────────────────────────────────────

await page.goto(BASE + "/admin/content/events/new");
await page.fill("#title", "Door-knock in Newton");
await page.fill("#startsAt", pacificLocal(2, 10));
await page.fill("#endsAt", pacificLocal(2, 8));
await page.fill("#location", "Newton Recreation Centre");
await page.fill("#address", "13730 72 Ave, Surrey");
await page.selectOption("#neighbourhood", "Newton");
await page.fill("#capacity", "20");
await page.fill("#summary", "Meet at the front doors.");
await page.fill("#description", "Bring **water**.");
await page.click('button:has-text("Add event")');
await page.locator("#endsAt-error").waitFor({ timeout: 15_000 });
const typedEvent = {
  startsAt: await page.inputValue("#startsAt"),
  endsAt: await page.inputValue("#endsAt"),
  location: await page.inputValue("#location"),
  address: await page.inputValue("#address"),
  neighbourhood: await page.inputValue("#neighbourhood"),
  capacity: await page.inputValue("#capacity"),
  summary: await page.inputValue("#summary"),
  description: await page.inputValue("#description"),
};
ok(
  JSON.stringify(typedEvent) ===
    JSON.stringify({
      startsAt: pacificLocal(2, 10),
      endsAt: pacificLocal(2, 8),
      location: "Newton Recreation Centre",
      address: "13730 72 Ave, Surrey",
      neighbourhood: "Newton",
      capacity: "20",
      summary: "Meet at the front doors.",
      description: "Bring **water**.",
    }) && (await page.isChecked('input[name="published"]')),
  "an end before the start is refused and every field keeps what was typed: " + JSON.stringify(typedEvent),
);
await page.fill("#endsAt", pacificLocal(2, 12));
await page.click('button:has-text("Add event")');
await page.waitForURL(/\/admin\/content\/events\/[0-9a-f-]{36}\?saved=created/, { timeout: 20_000 });
const eventId = page.url().match(/events\/([0-9a-f-]{36})/)[1];
const [ev] = await sql`select slug, neighbourhood, capacity, published, ends_at > starts_at as ends_later, starts_at from events where id = ${eventId}`;
ok(ev && ev.slug === "door-knock-in-newton" && ev.neighbourhood === "Newton" && ev.capacity === 20 && ev.published && ev.ends_later, "event saved with slug, neighbourhood, capacity and end time");
const hourInSurrey = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", hour: "numeric", hourCycle: "h23" }).format(ev.starts_at));
ok(hourInSurrey === 10, `start time was read as Surrey time (${hourInSurrey}:00)`);

await page.fill("#location", "Edited venue (unsaved)");
await page.fill("#endsAt", pacificLocal(2, 9));
await page.click('button:has-text("Save changes")');
await page.locator("#endsAt-error").waitFor({ timeout: 15_000 });
ok(
  (await page.inputValue("#location")) === "Edited venue (unsaved)" && (await page.inputValue("#endsAt")) === pacificLocal(2, 9),
  "on the edit page, a refused save keeps the edit instead of reverting to the saved values",
);
ok((await sql`select location from events where id = ${eventId}`)[0].location === "Newton Recreation Centre", "and nothing was saved");

const rsvp = await post(`/api/events/${ev.slug}/rsvp`, { name: "Priya Sandhu", email: "priya.rsvp@example.com", guests: 2, newsletter: false, website: "" });
ok(rsvp.status === 200, "public RSVP accepted");
await page.goto(BASE + `/admin/content/events/${eventId}`);
const row = page.locator("tr", { hasText: "Priya Sandhu" });
ok((await row.count()) === 1 && (await row.textContent()).includes("priya.rsvp@example.com"), "RSVP is listed with guests on the event page");
const stats = async () => (await page.locator(".rsvp-counts .cms-stat").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
ok(JSON.stringify(await stats()) === JSON.stringify(["1 RSVPs", "2 extra guests", "0 checked in", "20 capacity"]), "counts show 1 RSVP, 2 guests, 0 checked in: " + JSON.stringify(await stats()));
await page.click('button[aria-label="Check in Priya Sandhu"]');
await page.locator('button[aria-label="Undo check-in for Priya Sandhu"]').waitFor({ timeout: 15_000 });
const [checked] = await sql`select checked_in_at from event_rsvps where email = 'priya.rsvp@example.com'`;
ok(checked?.checked_in_at instanceof Date, "check-in sets checkedInAt");
ok((await stats())[2] === "1 checked in", "checked-in count updates");
await page.click('button[aria-label="Undo check-in for Priya Sandhu"]');
await page.locator('button[aria-label="Check in Priya Sandhu"]').waitFor({ timeout: 15_000 });
ok((await sql`select checked_in_at from event_rsvps where email = 'priya.rsvp@example.com'`)[0].checked_in_at === null, "undo clears checkedInAt");

await page.fill("#walkin-name", "Marco Reyes");
await page.fill("#walkin-email", "marco.walkin@example.com");
await page.fill("#walkin-guests", "1");
await page.click('button:has-text("Add walk-in")');
await page.locator("tr", { hasText: "Marco Reyes" }).waitFor({ timeout: 15_000 });
ok((await page.inputValue("#walkin-name")) === "" && (await page.inputValue("#walkin-email")) === "" && (await page.inputValue("#walkin-guests")) === "0", "the walk-in form is ready for the next person");
const [walkIn] = await sql`select r.source, r.checked_in_at, p.first_name, p.last_name, p.source as person_source from event_rsvps r join people p on p.id = r.person_id where r.email = 'marco.walkin@example.com'`;
ok(walkIn && walkIn.source === "walk-in" && walkIn.checked_in_at && walkIn.first_name === "Marco" && walkIn.last_name === "Reyes" && walkIn.person_source === `event:${ev.slug}`, "walk-in creates the person, an RSVP and checks them in");
ok((await page.locator('button:has-text("Delete event")').count()) === 0 && (await page.locator('button:has-text("Unpublish")').count()) === 1, "an event with RSVPs offers Unpublish, not Delete");

// ── Campaigns ─────────────────────────────────────────────────────────────

await page.goto(BASE + "/admin/content/campaigns/new");
await page.selectOption("#kind", "pledge");
await page.fill("#title", "Save the Newton Wave Pool");
await page.fill("#body", "The pool is **closing**. Not on our watch.");
await page.fill("#statement", "I pledge to show up at council when the pool is on the agenda.");
await page.fill("#goal", "500");
await page.fill("#shareText", "I pledged to save the Newton Wave Pool. Will you?");
await page.fill("#targetEmails", "mayor@surrey.ca\nnot-an-email");
await page.click('button:has-text("Create campaign")');
await page.locator("#targetEmails-error").waitFor({ timeout: 15_000 });
ok(
  (await page.inputValue("#kind")) === "pledge" && (await page.inputValue("#statement")).startsWith("I pledge") && (await page.inputValue("#goal")) === "500" && (await page.inputValue("#shareText")).startsWith("I pledged") && (await page.inputValue("#targetEmails")) === "mayor@surrey.ca\nnot-an-email",
  "a bad email in the list keeps every campaign field as typed",
);
await page.fill("#targetEmails", "mayor@surrey.ca\nclerk@surrey.ca, Mayor@surrey.ca");
await page.click('button:has-text("Create campaign")');
await page.waitForURL(/\/admin\/content\/campaigns\/[0-9a-f-]{36}\?saved=created/, { timeout: 20_000 });
const [camp] = await sql`select slug, kind, goal, target_emails, active, statement from campaigns where title = 'Save the Newton Wave Pool'`;
ok(camp && camp.slug === "save-the-newton-wave-pool" && camp.kind === "pledge" && camp.goal === 500 && camp.active && camp.target_emails.length === 2 && camp.target_emails[0] === "mayor@surrey.ca", "campaign saved with kind, goal and a de-duplicated email list");
ok((await page.locator(".cms-stat").first().textContent()).includes("0 signatures of 500"), "edit page shows the signature count against the goal");
const campId = page.url().match(/campaigns\/([0-9a-f-]{36})/)[1];
// Before anyone signs, the address can still change.
await page.fill("#slug", "save-newton-pool");
await page.click('button:has-text("Save changes")');
await page.locator(".cms-form [role=status]", { hasText: "Saved" }).waitFor({ timeout: 15_000 });
ok((await sql`select slug from campaigns where id = ${campId}`)[0].slug === "save-newton-pool", "an unsigned campaign's address can change");
const [signer] = await sql`insert into people (email, first_name) values ('signer@example.com', 'Sam') returning id`;
await sql`insert into campaign_signatures (campaign, person_id, first_name, last_name, email, postal_code) values ('save-newton-pool', ${signer.id}, 'Sam', 'Signer', 'signer@example.com', 'V3W 1A1')`;
await page.goto(BASE + `/admin/content/campaigns/${campId}`);
ok(
  (await page.getAttribute("#slug", "readonly")) !== null && (await page.locator("#slug-hint").textContent()).includes("has signatures") && (await page.locator('button:has-text("Delete campaign")').count()) === 0,
  "once signed, the address is locked in the form and the campaign can't be deleted",
);
// A stale form (or a hand-made request) can't change it either.
await page.evaluate(() => document.querySelector("#slug").removeAttribute("readonly"));
await page.fill("#slug", "renamed-after-signing");
await page.click('button:has-text("Save changes")');
await page.locator("#slug-error").waitFor({ timeout: 15_000 });
ok(
  (await page.locator("#slug-error").textContent()).includes("has signatures") &&
    (await sql`select slug from campaigns where id = ${campId}`)[0].slug === "save-newton-pool" &&
    (await sql`select count(*)::int c from campaign_signatures where campaign = 'save-newton-pool'`)[0].c === 1,
  "renaming a signed campaign is refused, so its signatures stay attached",
);
const [fixed] = await sql`select id from campaigns where slug = 'stop-mccallum-pledge'`;
await page.goto(BASE + `/admin/content/campaigns/${fixed.id}`);
ok((await page.getAttribute("#slug", "readonly")) !== null && (await page.locator('button:has-text("Delete campaign")').count()) === 0, "seeded campaign keeps its slug and can't be deleted");
await page.goto(BASE + "/admin/content/campaigns");
ok((await page.locator("tr", { hasText: "SkyTrain" }).count()) === 1 && (await page.locator('a[href="/api/admin/export/signatures"]').count()) >= 1, "campaign list shows the seeded campaigns and the signatures export");

// ── Shop ──────────────────────────────────────────────────────────────────

await page.goto(BASE + "/admin/content/products/new");
await page.fill("#title", "Rally poster");
await page.fill("#price", "12.50");
await page.fill("#tileLabel", "Poster");
await page.fill("#price", "twelve");
await page.fill("#sortOrder", "7");
await page.uncheck('input[name="active"]');
await page.click('button:has-text("Add product")');
await page.locator("#price-error").waitFor({ timeout: 15_000 });
ok((await page.inputValue("#price")) === "twelve" && (await page.inputValue("#sortOrder")) === "7" && !(await page.isChecked('input[name="active"]')) && (await page.inputValue("#title")) === "Rally poster", "a bad price keeps the product as typed");
await page.fill("#price", "12.50");
await page.check('input[name="active"]');
await page.click('button:has-text("Add product")');
await page.waitForURL(/\/admin\/content\/products\/[0-9a-f-]{36}\?saved=created/, { timeout: 20_000 });
const [prod] = await sql`select slug, price_cents, active, tile_background from products where name = 'Rally poster'`;
ok(prod && prod.slug === "rally-poster" && prod.price_cents === 1250 && prod.active && /^#[0-9A-F]{6}$/.test(prod.tile_background), "product saved with the price in cents");
r = await eventually(async () => ((await html("/shop")).text.includes("Rally poster") ? true : null));
ok(r === true, "new product shows in the shop");

// ── Media library ─────────────────────────────────────────────────────────

await page.goto(BASE + "/admin/media");
const card = page.locator(".media-card", { hasText: "office.png" });
ok((await card.count()) === 1 && (await card.locator("img").getAttribute("alt")) === "Our new office", "media library lists the upload with its alt text");
await card.locator('input[name="alt"]').fill("Office front door");
await card.locator('button:has-text("Save alt text")').click();
await card.locator("[role=status]", { hasText: "Alt text saved" }).waitFor({ timeout: 15_000 });
ok((await sql`select alt from media where id = ${mediaRow.id}`)[0].alt === "Office front door", "alt text can be edited in the library");
const list = await fetch(BASE + "/api/admin/media?q=office", { headers: authed }).then((x) => x.json());
ok(Array.isArray(list) && list.length === 1 && list[0].url === uploadedUrl, "library API lists uploads for the picker");
const pdf = new FormData();
pdf.set("file", new Blob(["%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"], { type: "application/pdf" }), "platform.pdf");
pdf.set("alt", "Our platform");
res = await fetch(BASE + "/api/admin/media", { method: "POST", headers: authed, body: pdf });
ok(res.status === 201, "a PDF can go in the library");
const all = await fetch(BASE + "/api/admin/media", { headers: authed }).then((x) => x.json());
const imagesOnly = await fetch(BASE + "/api/admin/media?images=1", { headers: authed }).then((x) => x.json());
ok(all.some((m) => m.filename === "platform.pdf") && !imagesOnly.some((m) => m.filename === "platform.pdf") && imagesOnly.some((m) => m.filename === "office.png"), "the library API lists images only when asked");
await page.goto(BASE + "/admin/content/news/new");
await page.click('button:has-text("Choose from library")');
await page.locator(".media-pick").first().waitFor({ timeout: 15_000 });
const pickable = await page.locator(".media-pick-name").allTextContents();
ok(pickable.length >= 1 && !pickable.some((t) => t.includes("platform")) && pickable.some((t) => t.includes("Office front door")), "the image picker doesn't offer the PDF: " + JSON.stringify(pickable));
await page.keyboard.press("Escape");
const badType = new FormData();
badType.set("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
res = await fetch(BASE + "/api/admin/media", { method: "POST", headers: authed, body: badType });
ok(res.status === 400 && (await res.json()).error.includes("JPEG"), "unsupported file types are refused");

// ── Integrations ──────────────────────────────────────────────────────────

await page.goto(BASE + "/admin/integrations");
const cards = await page.locator(".int-card").allTextContents();
ok(cards.length >= 7 && cards.some((c) => c.includes("Stripe") && c.includes("Test")) && cards.some((c) => c.includes("Email") && c.includes("RESEND_API_KEY")), "integration cards show Stripe mode and name their variables");
await page.click('button:has-text("Send me a test email")');
await page.locator("[role=alert]", { hasText: "RESEND_API_KEY" }).waitFor({ timeout: 15_000 });
ok((await sql`select status from email_log where kind = 'test' and "to" = ${ADMIN_EMAIL}`)[0]?.status === "skipped", "test email is logged as skipped when email isn't configured");
ok((await page.locator('button:has-text("Send a test text")').count()) === 0, "test text button is hidden while SMS is unconfigured");

// ── Phones ────────────────────────────────────────────────────────────────

const mobile = await context.newPage();
await mobile.setViewportSize({ width: 360, height: 800 });
for (const p of ["/admin/content/news/new", "/admin/settings/hero", "/admin/content/events/" + eventId, "/admin/media"]) {
  await mobile.goto(BASE + p);
  ok((await mobile.evaluate(() => document.documentElement.scrollWidth)) <= 360, `${p} has no sideways scroll at 360px`);
}

// ── Home page modules ────────────────────────────────────────────────────
await page.goto(BASE + "/admin/home");
ok((await page.locator(".home-module").count()) === 14, "the home page editor lists the 14 built-in modules");
await page.getByLabel("Show Shop on the home page").uncheck();
await page.getByRole("button", { name: "Move Chip in up" }).click();
await page.getByRole("button", { name: "+ Add a text block" }).click();
await page.locator(".home-module").last().getByLabel("Heading", { exact: true }).fill("Spring town halls");
await page.locator(".home-module").last().getByLabel("Text", { exact: true }).fill("Come and ask us **anything**.");
await page.locator(".home-module").last().getByLabel("Button text (optional)").fill("See events");
await page.locator(".home-module").last().getByLabel("Button link").fill("/events");
await page.getByRole("button", { name: "Save the home page" }).click();
await page.locator('[role="status"]', { hasText: "Saved" }).waitFor();
const savedModules = (await sql`select value from site_settings where key = 'homeModules'`)[0]?.value?.modules ?? [];
ok(savedModules.length === 15 && savedModules.find((m) => m.kind === "shop")?.enabled === false && savedModules.at(-1)?.heading === "Spring town halls", "the module list is saved: shop hidden, a text block added at the end");
await page.goto(BASE + "/");
ok((await page.locator("#shop").count()) === 0, "a hidden module is gone from the home page");
const order = await page.evaluate(() => [document.querySelector("#donate"), document.querySelector("#stop")].map((el) => el?.getBoundingClientRect().top ?? -1));
ok(order[0] > 0 && order[1] > 0 && order[0] < order[1], "a module moved up shows earlier on the home page");
const block = page.locator(".custom-module", { hasText: "Spring town halls" });
ok((await block.count()) === 1 && (await block.locator("strong", { hasText: "anything" }).count()) === 1 && (await block.locator('a[href="/events"]', { hasText: "See events" }).count()) === 1, "the text block shows with its Markdown and button");
await page.goto(BASE + "/admin/home");
ok((await page.locator(".home-module").count()) === 15 && (await page.getByLabel("Show Shop on the home page").isChecked()) === false, "the editor reopens with what was saved");
// Leave the home page as the other suites expect it.
await sql`delete from site_settings where key = 'homeModules'`;

await browser.close();
await finish();
