// The supporter portal: passwordless sign-in, the dashboard, preferences and
// consent, data export and deletion requests, referral links, and the live
// counters. Routes are exercised with fetch; the /me pages in a real browser.
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { BASE, sql, ok, finish, post } from "./helpers.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const rawToken = () => randomBytes(32).toString("base64url");
const SMS_WORDING = "Yes, Imagine Surrey can text me about events and volunteering. Reply STOP at any time. Message and data rates may apply.";
const UPDATES_WORDING = "Yes, Imagine Surrey can email me news and ways to help. I can unsubscribe at any time.";

/** A one-time member-login token, inserted the way the site stores it (sha256 hex of the raw value). */
async function loginToken(email) {
  const raw = rawToken();
  await sql`insert into auth_tokens (purpose, email, token_hash, expires_at) values ('member-login', ${email}, ${sha256(raw)}, now() + interval '30 minutes')`;
  return raw;
}


/** Poll until fn() is truthy (work done after the response, in after()), or give up after ~5s. */
async function eventually(fn) {
  for (let i = 0; i < 50; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

/** POST a sign-in token the way the /me/verify page's button does. */
async function verifyPost(token, next, extraHeaders = {}) {
  const body = new URLSearchParams({ token });
  if (next !== undefined) body.set("next", next);
  return fetch(`${BASE}/api/me/verify`, { method: "POST", body, headers: { origin: BASE, ...extraHeaders }, redirect: "manual" });
}

/** Submit the preferences form and wait for the server action to answer. */
async function savePreferences(page) {
  await Promise.all([page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes("/me/preferences")), page.click('form.form-card button[type="submit"]')]);
  await page.waitForTimeout(150);
}

// ── A supporter with a bit of everything ──────────────────────────────────
const email = "portal@example.com";
const [person] = await sql`insert into people (email, first_name, last_name, postal_code, neighbourhood, referral_code, stripe_customer_id, stripe_customer_mode, contact_consent_at)
  values (${email}, 'Pat', 'Portal', 'V3W 1A1', 'Newton', 'PORTAL23', 'cus_portal', 'test', now()) returning id`;
await sql`insert into memberships (person_id, status, fee_cents, voting_eligible, starts_at, expires_at) values (${person.id}, 'active', 1000, true, now(), now() + interval '300 days')`;
await sql`insert into newsletter_subscribers (email, person_id, source, unsubscribe_token) values (${email}, ${person.id}, 'e2e', 'portal-e2e-newsletter-token')`;
await sql`insert into contributions (person_id, kind, frequency, slate, amount_cents, status, contributor_name, contributor_address, contributor_city, contributor_postal_code, eligibility_attested_at, paid_at)
  values (${person.id}, 'donation', 'one_time', 'council', 20000, 'succeeded', 'Pat Portal', '1 Main St', 'Surrey', 'V3W 1A1', now(), now())`;
await sql`insert into campaign_signatures (campaign, person_id, first_name, last_name, email, postal_code, neighbourhood) values ('stop-mccallum-pledge', ${person.id}, 'Pat', 'Portal', ${email}, 'V3W 1A1', 'Newton')`;
await sql`insert into people (email, first_name, referred_by_id) values ('friend@example.com', 'Sam', ${person.id})`;
const [event] = await sql`insert into events (slug, title, starts_at, location, summary) values ('portal-town-hall', 'Portal town hall', now() + interval '5 days', 'Newton Seniors Centre', 'Bring your questions.') returning id`;
await sql`insert into event_rsvps (event_id, person_id, name, email, guests) values (${event.id}, ${person.id}, 'Pat Portal', ${email}, 1)`;
const [task] = await sql`select id from volunteer_tasks order by sort_order limit 1`;
await sql`insert into shifts (person_id, date, slot, task_id, status) values (${person.id}, (current_date + 3)::date, 'morning', ${task?.id ?? null}, 'scheduled')`;
// Someone else's data, which must never show up in Pat's export.
const [other] = await sql`insert into people (email, first_name, last_name, phone) values ('other-portal@example.com', 'Olga', 'Other', '604-555-0000') returning id`;
await sql`insert into campaign_signatures (campaign, person_id, first_name, last_name, email, postal_code, neighbourhood) values ('stop-mccallum-pledge', ${other.id}, 'Olga', 'Other', 'other-portal@example.com', 'V3T 1A1', 'Whalley')`;

// ── Signed out ────────────────────────────────────────────────────────────
let r = await fetch(BASE + "/me", { redirect: "manual" });
ok([302, 303, 307].includes(r.status) && (r.headers.get("location") ?? "").includes("/me/login?next=%2Fme"), `signed-out /me redirects to /me/login (status ${r.status})`);
r = await fetch(BASE + "/me/preferences", { redirect: "manual" });
ok([302, 303, 307].includes(r.status) && (r.headers.get("location") ?? "").includes("/me/login"), "signed-out /me/preferences redirects to sign-in");
ok((await fetch(BASE + "/api/me/export")).status === 401, "export needs a session");
ok((await fetch(BASE + "/api/me/calendar.ics")).status === 401, "calendar needs a session");
r = await fetch(BASE + "/api/me/billing-portal", { method: "POST", redirect: "manual" });
ok([302, 303].includes(r.status) && (r.headers.get("location") ?? "").includes("/me/login"), "billing portal needs a session");

// ── Asking for a link ─────────────────────────────────────────────────────
r = await post("/api/me/login", { email: "unknown-portal@example.com" });
ok(r.status === 200 && r.body?.ok === true, "unknown email gets the same ok answer");
await new Promise((res) => setTimeout(res, 500));
ok((await sql`select count(*)::int c from auth_tokens where email = 'unknown-portal@example.com'`)[0].c === 0, "…and no token is created for it");
r = await post("/api/me/login", { email, website: "spam.example" });
ok(r.status === 200 && r.body?.ok === true, "honeypot submission gets ok");
ok((await sql`select count(*)::int c from auth_tokens where email = ${email}`)[0].c === 0, "…and creates nothing");
r = await post("/api/me/login", { email: "not-an-email" });
ok(r.status === 422 && r.body?.fields?.email, "a malformed address gets a field error");
r = await post("/api/me/login", { email: email.toUpperCase() });
ok(r.status === 200 && r.body?.ok === true, "known email gets the same ok answer as an unknown one");
const mail = await eventually(async () => {
  const rows = await sql`select status, html from email_log where "to" = ${email} and kind = 'member-magic-link'`;
  return rows.length ? rows : null;
});
const tokens = await sql`select purpose, expires_at > now() + interval '25 minutes' as fresh, expires_at < now() + interval '35 minutes' as short, data from auth_tokens where email = ${email}`;
ok(tokens.length === 1 && tokens[0].purpose === "member-login" && tokens[0].fresh && tokens[0].short, "known email (any case) gets a 30-minute member-login token, made after the response");
ok(mail?.length === 1 && mail[0].status === "skipped" && mail[0].html.includes("/me/verify?token="), "sign-in email logged (skipped: no email provider) with the verify page link");

// Five links an hour per address, whatever IP asks (post() uses a fresh IP each time).
const limited = "ratelimit-portal@example.com";
const answers = [];
for (let i = 0; i < 6; i++) answers.push((await post("/api/me/login", { email: limited })).status);
ok(answers.slice(0, 5).every((s) => s === 200) && answers[5] === 429, `the sixth request for one address within the hour is refused (${answers.join(",")})`);

// ── The link ──────────────────────────────────────────────────────────────
const raw = await loginToken(email);
// Opening the link (a mail scanner, a prefetch, another site's <img>) signs nobody in and keeps the token.
r = await fetch(`${BASE}/api/me/verify?token=${raw}&next=/me/preferences`, { redirect: "manual" });
const landing = new URL(r.headers.get("location") ?? "/", BASE);
ok(r.status === 303 && landing.pathname === "/me/verify" && landing.searchParams.get("token") === raw && landing.searchParams.get("next") === "/me/preferences" && !r.headers.get("set-cookie"), "GET on the old link forwards to the /me/verify page without signing in");
ok((await sql`select used_at from auth_tokens where token_hash = ${sha256(raw)}`)[0]?.used_at === null, "…and does not use up the token");
const verifyPage = await (await fetch(`${BASE}/me/verify?token=${raw}`)).text();
ok(verifyPage.includes('action="/api/me/verify"') && verifyPage.includes('method="post"') && verifyPage.includes(raw) && (await sql`select used_at from auth_tokens where token_hash = ${sha256(raw)}`)[0]?.used_at === null, "the /me/verify page shows a Sign in button and still does not use the token");
r = await verifyPost(raw, undefined, { origin: "https://evil.example" });
ok(r.status === 403 && !r.headers.get("set-cookie"), "a cross-site POST cannot sign anyone in");
r = await verifyPost(raw, undefined, { "sec-fetch-site": "cross-site" });
ok(r.status === 403 && !r.headers.get("set-cookie"), "…whatever the Origin header says, when the browser marks it cross-site");
r = await verifyPost(raw);
const setCookie = r.headers.get("set-cookie") ?? "";
ok(r.status === 303 && (r.headers.get("location") ?? "").endsWith("/me") && /(^|, )is_member=[^;]+;/.test(setCookie) && /httponly/i.test(setCookie) && /samesite=lax/i.test(setCookie), "the button's POST sets the is_member cookie and redirects to /me");
const cookie = (setCookie.match(/is_member=[^;]+/) ?? [""])[0];
r = await verifyPost(raw);
ok((r.headers.get("location") ?? "").includes("/me/login?error=expired") && !r.headers.get("set-cookie"), "the same token a second time fails");
r = await verifyPost("nonsense");
ok((r.headers.get("location") ?? "").includes("error=expired"), "an unknown token fails");
r = await verifyPost(await loginToken(email), "//evil.example");
ok((r.headers.get("location") ?? "").endsWith("/me"), "an unsafe next falls back to /me");
r = await verifyPost(await loginToken(email), "/me/preferences");
ok((r.headers.get("location") ?? "").endsWith("/me/preferences"), "a relative next is honoured");
ok((await sql`select count(*)::int c from auth_tokens where email = ${email} and used_at is null and expires_at > now()`)[0].c === 1, "only the unused token from the form remains");

// ── The dashboard over HTTP ───────────────────────────────────────────────
// React separates adjacent text nodes with <!-- --> in server HTML; drop them before looking for phrases.
const html = async (res) => (await res.text()).replace(/<!-- -->/g, "");
const me = await html(await fetch(BASE + "/me", { headers: { cookie } }));
ok(me.includes("Active member") && me.includes("You can vote at member meetings"), "membership status and voting eligibility shown");
ok(me.includes(`${BASE}/r/PORTAL23`) && me.includes("brought in: 1"), "personal referral link and the count of people brought in");
ok(me.includes("$200 given") && me.includes("$1,229.70 of $1,429.70 room left for"), "giving this year and room under the BC limit");
ok(me.includes("Manage monthly gift"), "billing button shown for a Stripe customer in the site's mode");
ok(me.includes("Portal town hall") && me.includes("calendar.google.com") && me.includes("Download calendar file"), "upcoming event with a calendar link");
ok(me.includes("Stop Doug McCallum and Mandeep Nagra"), "signed campaign listed by title");
ok(!me.includes("friend@example.com"), "referred people are a number, never names");
ok(me.includes("wa.me/") && me.includes("Copy link"), "share sheet with WhatsApp first");

r = await fetch(BASE + "/api/me/billing-portal", { method: "POST", headers: { cookie }, redirect: "manual" });
ok(r.status === 303 && (r.headers.get("location") ?? "").includes("billing=unavailable"), "billing portal failure comes back to /me with a message");
const unavailable = await html(await fetch(BASE + "/me?billing=unavailable", { headers: { cookie } }));
ok(unavailable.includes("couldn&#x27;t open the billing portal") || unavailable.includes("couldn't open the billing portal"), "…which the page shows");

r = await fetch(BASE + "/api/me/calendar.ics", { headers: { cookie } });
const ics = await r.text();
ok((r.headers.get("content-type") ?? "").startsWith("text/calendar") && ics.startsWith("BEGIN:VCALENDAR") && ics.includes("Portal town hall") && /UID:shift-/.test(ics) && /UID:event-/.test(ics), "calendar file lists the shift and the event");

r = await fetch(BASE + "/api/me/export", { headers: { cookie } });
const data = await r.json();
ok(r.status === 200 && (r.headers.get("content-disposition") ?? "").includes("attachment"), "export downloads as a file");
ok(data.profile?.email === email && data.memberships?.length === 1 && data.contributions?.length === 1 && data.signatures?.length === 1 && data.rsvps?.length === 1 && data.shifts?.length === 1 && Array.isArray(data.consentHistory) && Array.isArray(data.emails), "export holds this person's record, memberships, contributions, signatures, RSVPs, shifts, consent and emails");
ok(data.referrals?.peopleBroughtIn === 1 && data.contributions[0].amountCents === 20000, "export counts referrals and lists amounts");
const dump = JSON.stringify(data);
ok(!dump.includes("other-portal@example.com") && !dump.includes("Olga") && !dump.includes("friend@example.com") && !dump.includes("604-555-0000"), "export has nobody else's data");
ok(data.emails.length >= 1 && data.emails.every((e) => !("html" in e) && typeof e.subject === "string"), "emails are subjects and dates only, no bodies");

// ── Referral links ────────────────────────────────────────────────────────
r = await fetch(BASE + "/r/PORTAL23?to=/stats&source=whatsapp", { redirect: "manual" });
let track = r.headers.get("set-cookie") ?? "";
ok([302, 307].includes(r.status) && (r.headers.get("location") ?? "").endsWith("/stats"), "referral link redirects to the page asked for");
ok(/is_track=/.test(track) && decodeURIComponent((track.match(/is_track=([^;]+)/) ?? ["", ""])[1]).includes("ref=PORTAL23") && decodeURIComponent((track.match(/is_track=([^;]+)/) ?? ["", ""])[1]).includes("source=whatsapp"), "…and sets the tracking cookie with ref and source");
r = await fetch(BASE + "/r/portal23", { redirect: "manual" });
ok((r.headers.get("set-cookie") ?? "").includes("is_track=") && new URL(r.headers.get("location") ?? "", BASE).href === `${BASE}/`, "lower-case code works and goes home by default");
r = await fetch(BASE + "/r/PORTAL23?to=https://evil.example", { redirect: "manual" });
ok(new URL(r.headers.get("location") ?? "", BASE).href === `${BASE}/`, "an off-site `to` is ignored");
r = await fetch(BASE + "/r/NOPE2345", { redirect: "manual" });
ok([302, 307].includes(r.status) && new URL(r.headers.get("location") ?? "", BASE).href === `${BASE}/` && !r.headers.get("set-cookie"), "unknown code redirects home without a cookie");

// ── No public counters ────────────────────────────────────────────────────
// The numbers are in the admin only; the feed and the page are retired.
r = await fetch(BASE + "/api/stats");
ok(r.status === 404, "the public stats feed is gone");
r = await fetch(BASE + "/stats", { redirect: "manual" });
ok([301, 308].includes(r.status) && new URL(r.headers.get("location") ?? "", BASE).pathname === "/", `/stats redirects permanently to the home page (${r.status})`);

// ── In a browser ──────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on("dialog", (d) => d.accept());

await page.goto(BASE + "/me/login");
ok((await page.locator("h1").count()) === 1 && (await page.locator('label[for="member-email"]').count()) === 1, "login page: one h1, a labelled email field");
const honeypotBox = await page.locator('input[name="website"]').boundingBox();
ok(honeypotBox !== null && honeypotBox.x < 0, "honeypot sits off screen");
await page.fill("#member-email", "nobody-here@example.com");
await page.click('form.form-card button[type="submit"]');
await page.locator("#member-login-status").filter({ hasText: "If that address has an account" }).waitFor();
ok((await page.locator("#member-login-status").getAttribute("role")) === "status", "sent state announced in a status region");

await page.goto(`${BASE}/api/me/verify?token=${await loginToken(email)}`);
await page.waitForURL(/\/me\/verify\?/);
await page.click('button:has-text("Sign in")');
await page.waitForURL(/\/me$/);
ok((await page.locator("h1").count()) === 1 && (await page.locator("h1").textContent()).includes("Hi Pat"), "signed in through the link: /me greets the member");
ok((await page.locator("input.share-sheet__url").first().inputValue()).endsWith("/r/PORTAL23"), "referral link is in the share sheet");
ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "no sideways scroll on a phone");
ok((await page.locator('[role="meter"]').count()) === 1 && (await page.locator('[role="meter"]').getAttribute("aria-valuetext")).includes("room left"), "giving meter has an accessible value");

await page.goto(BASE + "/me/preferences");
ok((await page.locator("h1").count()) === 1 && (await page.locator('option[lang="pa"]').textContent()) === "ਪੰਜਾਬੀ", "preferences: one h1, languages in their own script");
await page.fill("#pref-phone", "604-555-0199");
await page.fill("#pref-postal", "v3t 1v8");
await page.check('input[name="sms"]');
await savePreferences(page);
await page.locator('[role="status"].alert').waitFor();
let consent = await sql`select channel, purpose, action, wording, source, ip, user_agent from consent_events where person_id = ${person.id} order by created_at desc limit 1`;
let row = (await sql`select sms_consent_at, phone, postal_code, neighbourhood from people where id = ${person.id}`)[0];
ok(consent[0]?.channel === "sms" && consent[0].purpose === "sms" && consent[0].action === "grant" && consent[0].wording === SMS_WORDING && consent[0].source === "preferences" && consent[0].user_agent, "ticking Text me writes a consent grant with the exact wording");
ok(row.sms_consent_at !== null && row.phone === "604-555-0199" && row.postal_code === "V3T 1V8" && row.neighbourhood === "Whalley", "…sets sms_consent_at and saves the details with the town centre");
ok((await page.locator('[role="status"].alert').textContent()).includes("Whalley"), "the saved message names the town centre");
ok((await sql`select count(*)::int c from consent_events where person_id = ${person.id}`)[0].c === 1, "an unchanged email tick writes nothing");

await page.uncheck('input[name="sms"]');
await page.uncheck('input[name="updates"]');
await savePreferences(page);
await page.locator('[role="status"].alert').waitFor();
consent = await sql`select channel, action, wording from consent_events where person_id = ${person.id} order by created_at desc limit 2`;
row = (await sql`select sms_consent_at, contact_consent_at from people where id = ${person.id}`)[0];
ok(consent.length === 2 && consent.every((c) => c.action === "withdraw") && consent.some((c) => c.channel === "sms" && c.wording === SMS_WORDING) && consent.some((c) => c.channel === "email" && c.wording === UPDATES_WORDING), "unticking writes a withdrawal for each channel");
ok(row.sms_consent_at === null && row.contact_consent_at === null, "…and clears both consent timestamps");

// React resets the form after a save: the boxes must show what was saved, not the props the page loaded with.
ok(!(await page.isChecked('input[name="updates"]')) && !(await page.isChecked('input[name="sms"]')), "after saving, unticked boxes stay unticked");
const before = (await sql`select count(*)::int c from consent_events where person_id = ${person.id}`)[0].c;
await page.selectOption("#pref-locale", "pa");
await savePreferences(page);
await page.locator('[role="status"].alert').waitFor();
ok((await sql`select count(*)::int c from consent_events where person_id = ${person.id}`)[0].c === before, "changing only the language writes no consent event");
ok((await sql`select contact_consent_at, locale from people where id = ${person.id}`)[0].contact_consent_at === null && !(await page.isChecked('input[name="updates"]')), "…and the email tick is not re-granted");
ok((await sql`select status from newsletter_subscribers where email = ${email}`)[0]?.status === "unsubscribed", "withdrawing email updates also stops the newsletter");
await page.reload();
ok(!(await page.isChecked('input[name="updates"]')) && (await page.locator("#pref-locale").inputValue()) === "pa", "a reload shows the saved choices");

await page.check('input[name="sms"]');
await page.fill("#pref-phone", "");
await savePreferences(page);
await page.locator('[role="alert"].alert').waitFor();
ok((await page.locator('[role="alert"].alert').textContent()).includes("phone"), "texts without a phone number are refused with a field error");
ok((await sql`select sms_consent_at from people where id = ${person.id}`)[0].sms_consent_at === null, "…and nothing was recorded");

await page.goto(BASE + "/me/data");
ok((await page.locator("h1").count()) === 1, "your data: one h1");
await page.click('button:has-text("Ask us to delete my account")');
await page.waitForURL(/requested=1/);
const tagged = (await sql`select tags from people where id = ${person.id}`)[0].tags;
const note = await sql`select body, author_id from person_notes where person_id = ${person.id}`;
const office = await sql`select "to", status from email_log where kind = 'deletion-request'`;
ok(tagged.includes("deletion-requested") && note.length === 1 && note[0].body.startsWith("Deletion requested by the supporter via /me on") && note[0].author_id === null, "delete request tags the record and leaves a note");
ok(office.length === 1 && office[0].to.includes("@"), "…and emails the office");
ok((await page.locator('[role="status"]').textContent()).includes("confirm within 30 days"), "…and promises confirmation within 30 days");
await page.goto(BASE + "/me/data");
ok((await page.locator('button:has-text("Ask us to delete my account")').count()) === 0 && (await page.locator('[role="status"]').textContent()).includes("30 days"), "a second visit shows the request as received, with no way to send a second one");

await page.goto(BASE + "/me");
await page.click('button:has-text("Sign out")');
await page.waitForURL(`${BASE}/`);
await page.goto(BASE + "/me");
await page.waitForURL(/\/me\/login/);
ok(page.url().includes("/me/login"), "sign out clears the session");

await page.goto(BASE + "/stats");
ok(new URL(page.url()).pathname === "/" && (await page.locator(".counter, .stats-table").count()) === 0, "the retired /stats page lands on the home page, with no counters");
await browser.close();

await finish();
