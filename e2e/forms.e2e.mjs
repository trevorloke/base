// Public forms, petitions and pledges, the preference centre, the donate
// page and the shop, in a real browser and against the API. Run with
// `npm run e2e -- forms`.
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { BASE, sql, ok, finish, post } from "./helpers.mjs";

// The wording the consent ledger must record, verbatim (src/lib/consent-wording.ts).
const UPDATES_WORDING = "Yes, Imagine Surrey can email me news and ways to help. I can unsubscribe at any time.";
const SMS_WORDING = "Yes, Imagine Surrey can text me about events and volunteering. Reply STOP at any time. Message and data rates may apply.";
const SLUG = "skytrain-south-surrey";

const count = async (slug = SLUG) => (await sql`select count(distinct email)::int c from campaign_signatures where campaign = ${slug}`)[0].c;
const consentRows = async (email) => sql`select channel, purpose, action, wording, source from consent_events where email = ${email} order by created_at`;

// ── Seed ──────────────────────────────────────────────────────────────────
await sql`delete from campaign_signatures`;
await sql`delete from consent_events`;
await sql`insert into people (email, first_name, last_name, referral_code) values ('referrer@example.com', 'Rina', 'Referrer', 'REFTEST2') on conflict (email) do update set referral_code = excluded.referral_code`;
const referrer = (await sql`select id from people where email = 'referrer@example.com'`)[0];

const browser = await chromium.launch();
// Reduced motion: the sticky header shrinks on scroll, which moves targets under the pointer while scrolling.
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });

/** Navigate and wait for React to hydrate: the forms fill their hidden locale field in an effect, so it is a reliable signal. */
async function go(p, url) {
  await p.goto(url, { waitUntil: "load" });
  if (await p.locator("input[name=locale]").count()) await p.waitForFunction(() => document.querySelector("input[name=locale]")?.value === "en", null, { timeout: 15000 });
  else await p.waitForTimeout(300);
}

// ── /act ──────────────────────────────────────────────────────────────────
await go(page, BASE + "/act");
ok((await page.locator(".act-card").count()) === 2, "/act lists the two seeded campaigns");
const actText = await page.locator("main").textContent();
ok(actText.includes("Get SkyTrain to South Surrey") && actText.includes("Stop Doug McCallum and Mandeep Nagra"), "/act shows both campaign titles");
ok((await page.locator("main [role=progressbar], main .milestone").count()) === 0 && !/\d+ of [\d,]+ (signatures|pledges)/.test(actText), "/act shows no milestone bars or counts");

await go(page, BASE + `/act/${SLUG}`);
const start = await count();
ok((await page.locator("[role=progressbar], .milestone, .hood-list, .act-latest").count()) === 0, "no milestone bar, town-centre counts or latest-signers list");
ok(!/\bof 2,500\b|signatures so far|more to reach/.test(await page.locator("main").textContent()), "the page names no signature count or goal");
ok((await page.locator("h1").textContent()).includes("Get SkyTrain to South Surrey"), "campaign title rendered");
ok((await page.locator(".share-links a").count()) >= 4 && (await page.locator('.share-links a[href*="source%3Dshare-whatsapp"]').count()) === 1, "share links carry their channel source");
ok((await page.locator("#act-updates").isChecked()) === false && (await page.locator("#act-sms").isChecked()) === false, "consent ticks are never pre-checked");

// ── Sign without the updates tick ─────────────────────────────────────────
async function sign(email, { updates = false, sms = false, phone = "" } = {}) {
  await page.fill("#act-first", "Pat");
  await page.fill("#act-last", "Signer");
  await page.fill("#act-email", email);
  await page.fill("#act-postal", "v3w2a1");
  if (phone) await page.fill("#act-phone", phone);
  if (updates) await page.check("#act-updates");
  if (sms) await page.check("#act-sms");
  await page.locator('form:has(#act-first) button[type=submit]').click();
  await page.locator(".success-card").waitFor({ timeout: 15000 });
}

await page.fill("#act-postal", "v3w2a1");
ok((await page.inputValue("#act-postal")) === "V3W 2A1", "postal code upper-cases and inserts the space");
ok((await page.locator("#act-postal-preview").textContent()).includes("That’s Newton"), "postal code previews the town centre");

await sign("quiet@example.com");
ok((await page.locator(".success-card h3").textContent()).includes("Your name is on the petition"), "signing shows the success card");
ok(await page.evaluate(() => document.activeElement?.tagName === "H3" && document.activeElement.closest(".success-card") !== null), "focus moves to the success heading");
ok(!/You’re one of|people have signed|people who/.test(await page.locator(".success-card").textContent()), "the success card names no count");
ok((await count()) === start + 1, "signature stored");
ok((await consentRows("quiet@example.com")).length === 0, "no consent row without the updates tick");
ok((await sql`select contact_consent_at from people where email = 'quiet@example.com'`)[0].contact_consent_at === null, "contact_consent_at stays null without the tick");
ok((await sql`select count(*)::int c from newsletter_subscribers where email = 'quiet@example.com'`)[0].c === 0, "no newsletter subscription without the tick");
ok((await sql`select neighbourhood, source from campaign_signatures where email = 'quiet@example.com'`)[0].neighbourhood === "Newton", "neighbourhood derived server-side from the postal code");

// ── Sign with the updates and text ticks ──────────────────────────────────
await go(page, BASE + `/act/${SLUG}`);
await sign("keen@example.com", { updates: true, sms: true, phone: "604-555-0101" });
const keen = await consentRows("keen@example.com");
ok(keen.length === 2, `two consent rows with both ticks (${keen.length})`);
ok(keen[0]?.channel === "email" && keen[0]?.purpose === "updates" && keen[0]?.action === "grant" && keen[0]?.wording === UPDATES_WORDING && keen[0]?.source === `petition:${SLUG}`, "email consent row carries the exact wording and source");
ok(keen[1]?.channel === "sms" && keen[1]?.purpose === "sms" && keen[1]?.wording === SMS_WORDING, "sms consent row carries the exact wording");
const keenPerson = (await sql`select contact_consent_at, sms_consent_at from people where email = 'keen@example.com'`)[0];
ok(keenPerson.contact_consent_at !== null && keenPerson.sms_consent_at !== null, "contact_consent_at and sms_consent_at set from the ticks");
ok((await sql`select count(*)::int c from newsletter_subscribers where email = 'keen@example.com'`)[0].c === 1, "updates tick subscribes to the newsletter");

// ── Attribution: ?ref and ?source ─────────────────────────────────────────
await go(page, BASE + `/act/${SLUG}?ref=REFTEST2&source=whatsapp`);
await sign("shared@example.com");
const shared = (await sql`select s.source, p.referred_by_id, p.source as person_source from campaign_signatures s join people p on p.id = s.person_id where s.email = 'shared@example.com'`)[0];
ok(shared.source === `petition:${SLUG}/whatsapp`, `campaign_signatures.source stores the share source: ${shared.source}`);
ok(shared.referred_by_id === referrer.id, "people.referred_by_id credits the referral code");
ok(shared.person_source === `petition:${SLUG}/whatsapp`, "people.source records where they came from");

// ── Honeypot, unknown slug, double signing ────────────────────────────────
const before = await count();
let r = await post("/api/signatures", { campaign: SLUG, firstName: "Bot", lastName: "Bot", email: "bot@example.com", postalCode: "V3W 2A1", website: "spam.example" });
ok(r.status === 200 && r.body?.ok === true && (await count()) === before, "honeypot returns ok and inserts nothing");
await go(page, BASE + `/act/${SLUG}`);
await page.evaluate(() => {
  const el = document.querySelector('form:has(#act-first) input[name=website]');
  el.value = "http://spam.example";
});
await sign("bot-ui@example.com");
ok((await count()) === before && (await sql`select count(*)::int c from people where email = 'bot-ui@example.com'`)[0].c === 0, "honeypot filled in the browser: success shown, nothing stored");
r = await post("/api/signatures", { campaign: "no-such-campaign", firstName: "A", lastName: "B", email: "a@b.ca", postalCode: "V3W 2A1" });
ok(r.status === 404, "unknown slug → 404");
r = await post("/api/signatures", { campaign: "Bad Slug!", firstName: "A", lastName: "B", email: "a@b.ca", postalCode: "V3W 2A1" });
ok(r.status === 422, "malformed slug → 422");
await sql`update campaigns set active = false where slug = 'stop-mccallum-pledge'`;
r = await post("/api/signatures", { campaign: "stop-mccallum-pledge", firstName: "A", lastName: "B", email: "a@b.ca", postalCode: "V3W 2A1" });
ok(r.status === 404, "inactive campaign → 404");
await sql`update campaigns set active = true where slug = 'stop-mccallum-pledge'`;
r = await post("/api/signatures", { campaign: SLUG, firstName: "Pat", lastName: "Again", email: "quiet@example.com", postalCode: "V3W 2A1", updatesConsent: false });
ok(r.status === 200 && !("count" in r.body) && (await count()) === before, "a second signature with the same email does not double count, and the response carries no count");
ok(r.body.campaign?.slug === SLUG && r.body.campaign?.kind === "petition" && typeof r.body.campaign?.shareText === "string", "response carries the campaign summary");

// ── No public count endpoint; the print sheet ────────────────────────────
ok((await fetch(BASE + `/api/campaigns/${SLUG}/count`)).status === 404, "the public count endpoint is gone");
await go(page, BASE + `/act/${SLUG}/print`);
ok((await page.locator(".sheet-row").count()) === 12, "print sheet has 12 signature rows");
const sheet = await page.locator(".sheet").textContent();
ok(sheet.includes("Get SkyTrain to South Surrey") && sheet.includes(`/act/${SLUG}`) && sheet.includes(UPDATES_WORDING), "print sheet shows the title, URL and consent sentence");
ok((await fetch(BASE + "/act/no-such-campaign")).status === 404, "unknown campaign page → 404");
const og = await fetch(BASE + `/act/${SLUG}/opengraph-image`);
ok(og.status === 200 && (og.headers.get("content-type") ?? "").includes("image/png"), "share image renders as PNG");

// ── Preference centre ─────────────────────────────────────────────────────
await sql`insert into people (email, first_name, phone) values ('pref@example.com', 'Preet', '604-555-0199') on conflict (email) do update set phone = excluded.phone`;
const raw = randomBytes(24).toString("base64url");
const hash = createHash("sha256").update(raw).digest("hex");
await sql`insert into auth_tokens (purpose, email, token_hash, expires_at) values ('preferences', 'pref@example.com', ${hash}, now() + interval '1 hour')`;
await go(page, BASE + "/preferences");
ok((await page.locator("#pref-request-email").count()) === 1, "/preferences without a token shows the 'send me a link' form");
r = await post("/api/preferences/request", { email: "nobody@example.com" });
ok(r.status === 200 && r.body.ok === true, "link request answers ok for an unknown address");
r = await post("/api/preferences/request", { email: "pref@example.com" });
ok(r.status === 200 && r.body.ok === true, "link request answers ok for a known address");
await new Promise((res) => setTimeout(res, 800));
ok((await sql`select count(*)::int c from email_log where "to" = 'pref@example.com' and kind = 'preferences-link'`)[0].c === 1, "link request logs the email");

await go(page, BASE + `/preferences?token=${raw}`);
ok((await page.locator("#pref-sms").count()) === 1 && (await page.locator("#pref-sms").isChecked()) === false, "/preferences?token= shows the form with the current state");
ok((await sql`select used_at from auth_tokens where token_hash = ${hash}`)[0].used_at === null, "viewing the page does not consume the token");
await page.check("#pref-sms");
await page.locator('form:has(#pref-sms) button[type=submit]').click();
await page.locator(".prefs-saved").waitFor({ timeout: 15000 });
const prefRows = await consentRows("pref@example.com");
ok(prefRows.length === 1 && prefRows[0].channel === "sms" && prefRows[0].action === "grant" && prefRows[0].wording === SMS_WORDING && prefRows[0].source === "preferences", "saving with sms ticked writes the consent row");
ok((await sql`select sms_consent_at from people where email = 'pref@example.com'`)[0].sms_consent_at !== null, "sms_consent_at set");
ok((await sql`select used_at from auth_tokens where token_hash = ${hash}`)[0].used_at !== null, "the token is consumed by the save");
const newToken = await page.inputValue('form:has(#pref-sms) input[name=token]');
ok(newToken && newToken !== raw, "the response carries a new token");
await page.uncheck("#pref-sms");
await page.selectOption("#pref-locale", "pa");
await page.fill("#pref-postal", "v3s1a1");
await page.locator('form:has(#pref-sms) button[type=submit]').click();
await page.waitForTimeout(1200);
const prefPerson = (await sql`select sms_consent_at, locale, postal_code, neighbourhood from people where email = 'pref@example.com'`)[0];
ok(prefPerson.sms_consent_at === null && prefPerson.locale === "pa" && prefPerson.postal_code === "V3S 1A1" && prefPerson.neighbourhood === "Cloverdale", "second save works with the new token: withdraws sms, stores locale and postal code");
ok((await consentRows("pref@example.com")).length === 2, "withdrawal recorded in the ledger");
r = await post("/api/preferences", { token: raw, updates: true });
ok(r.status === 410, "a spent token is refused");

// ── Donate: custom amount ─────────────────────────────────────────────────
await go(page, BASE + "/donate");
ok((await page.locator('.toggle button[aria-pressed="true"]').textContent()) === "One-time", "one-time is the default frequency");
const custom = page.locator("#amount-custom");
await custom.fill("abc");
ok((await page.locator("#amount-custom-error").textContent()).includes("amount in dollars"), "non-number custom amount shows an error");
await custom.fill("2");
ok((await page.locator("#amount-custom-error").textContent()).includes("smallest"), "custom amount below the minimum shows an error");
await custom.fill("99999");
ok((await page.locator("#amount-custom-error").textContent()).includes("most you can give"), "custom amount above the limit shows an error");
await custom.fill("35");
ok((await page.locator("#amount-custom-error").count()) === 0 && (await page.locator('form button[type=submit]').textContent()).includes("Donate $35"), "a valid custom amount updates the button");
ok((await page.locator('.amount[aria-pressed="true"]').count()) === 0, "typing a custom amount clears the preset selection");
await page.locator(".amount", { hasText: "$50" }).click();
ok((await custom.inputValue()) === "" && (await page.locator('.amount[aria-pressed="true"]').textContent()) === "$50", "picking a preset clears the custom box");
await custom.fill("abc");
await page.locator('form button[type=submit]').click();
ok(await page.evaluate(() => document.activeElement?.classList.contains("error-summary")), "submitting with an invalid amount focuses the error summary");
ok((await page.locator('.error-summary a[href="#amount-custom"]').count()) === 1, "the summary links to the amount box");
ok((await page.locator("#d-newsletter").isChecked()) === false, "donate newsletter tick is not pre-checked");

// ── Membership: empty submit, error summary, keyboard ─────────────────────
await go(page, BASE + "/#join");
const memberForm = page.locator("form:has(#m-first)");
await memberForm.locator('button[type=submit]').click();
await memberForm.locator(".error-summary").waitFor({ timeout: 10000 });
ok(await page.evaluate(() => document.activeElement?.classList.contains("error-summary") && document.activeElement.getAttribute("role") === "alert"), "empty membership submit puts focus on the role=alert error summary");
const summaryLinks = await memberForm.locator(".error-summary li a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
const items = await memberForm.locator(".error-summary li").count();
ok(items > 0 && summaryLinks.length === items, `every field error is linked (${items})`);
ok(await page.evaluate((hrefs) => hrefs.every((h) => document.querySelector(h) !== null), summaryLinks), "every summary link points at an existing field");
await memberForm.locator(".error-summary li a").first().click();
ok(await page.evaluate(() => document.activeElement?.id === "m-first"), "activating a summary link moves focus to the field");
ok(await page.evaluate(() => document.getElementById("m-first")?.getAttribute("aria-invalid") === "true" && document.getElementById("m-first")?.getAttribute("aria-describedby") === "m-first-error"), "invalid fields are wired with aria-invalid and aria-describedby");
ok((await page.locator("#m-updates").isChecked()) === false && (await page.locator("#m-sms").isChecked()) === false, "membership consent ticks are not pre-checked");
await page.keyboard.press("Tab");
ok(await page.evaluate(() => document.activeElement?.id === "m-last"), "keyboard moves on from the focused field");
const langBoxes = memberForm.locator('input[name=languages]');
for (let i = 0; i < 6; i++) await langBoxes.nth(i).check();
ok((await langBoxes.nth(6).isDisabled()) === true, "a seventh language cannot be chosen");

// Membership API accepts the superset body (the payments route owns the rest).
r = await post("/api/membership", {
  firstName: "Asha", lastName: "Singh", email: "asha-forms@example.com", phone: "604-555-0100", address: "13450 104 Ave", city: "Surrey", postalCode: "V3T 1V8", neighbourhood: "Whalley",
  birthdate: "1990-04-12", citizenshipStatus: "Citizen", gender: "", languages: ["English", "Punjabi"], student: false, campus: "", issue: "", interestVolunteer: false, interestLawnSign: false,
  consent: true, updatesConsent: true, smsConsent: true, source: "whatsapp", ref: "REFTEST2", locale: "pa", website: "",
});
ok(r.status === 200 && r.body.status === "checkout", "membership route accepts updatesConsent, smsConsent, source, ref and locale");

// ── Newsletter: pending message via a mocked API ──────────────────────────
await page.route("**/api/newsletter", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "pending" }) }));
await page.fill("#nl-email", "news-forms@example.com");
await page.locator("form.newsletter-form button[type=submit]").click();
await page.locator("form.newsletter-form, [role=status]").first().waitFor();
await page.waitForTimeout(500);
ok((await page.locator("#newsletter").textContent()).includes("Check your inbox to confirm your subscription"), "newsletter form shows the pending message");
await page.unroute("**/api/newsletter");

// ── RSVP: superset body ───────────────────────────────────────────────────
await sql`insert into events (slug, title, starts_at, location, summary) values ('forms-town-hall', 'Forms town hall', now() + interval '10 days', 'Newton Seniors Centre', 'Bring your questions.') on conflict do nothing`;
r = await post("/api/events/forms-town-hall/rsvp", { name: "Raj Patel", email: "raj-forms@example.com", guests: 1, newsletter: false, phone: "604-555-0102", postalCode: "V3W 2A1", smsConsent: true, source: "event-email", ref: "", website: "" });
ok(r.status === 200, "RSVP route accepts the superset body");
await go(page, BASE + "/events/forms-town-hall");
await page.fill("#r-name", "Dee Keyboard");
await page.fill("#r-email", "dee@example.com");
await page.locator("form:has(#r-name) button[type=submit]").click();
await page.locator(".success-card").waitFor({ timeout: 15000 });
ok(await page.evaluate(() => document.activeElement?.closest(".success-card") !== null), "RSVP success moves focus to the confirmation");

// ── Shop: labelled quantities, live total, cart dialog ────────────────────
await go(page, BASE + "/shop");
await page.locator('button[aria-label="Add one Stop Doug lawn sign"]').click();
await page.locator('button[aria-label="Add one Stop Doug lawn sign"]').click();
ok((await page.locator("#qty-stop-doug-lawn-sign").inputValue()) === "2", "quantity input is labelled and reflects the buttons");
// The announcement is set in an effect after the render, so wait for it rather than reading at once.
const announced = await page.locator('[aria-live="polite"]', { hasText: "2 items in your cart, total $40" }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
ok(announced, "cart total is announced");
await page.locator("button", { hasText: "View cart" }).click();
await page.locator("dialog[open]").waitFor();
ok((await page.locator("dialog[open]").getAttribute("aria-modal")) === "true" && (await page.locator("dialog[open] .cart-line").count()) === 1, "cart drawer opens as a modal dialog");
ok(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), "focus moves into the dialog");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
ok((await page.locator("dialog[open]").count()) === 0, "Escape closes the drawer");
ok(await page.evaluate(() => document.activeElement?.textContent === "View cart"), "focus returns to the opener");
const small = await page.evaluate(() => Array.from(document.querySelectorAll(".qty-btn, .btn, .check input")).filter((el) => el.getBoundingClientRect().height < 24 && el.getBoundingClientRect().height > 0).length);
ok(small === 0, "every control is at least 24px tall");

// ── Phone width: no horizontal scroll on the campaign page ────────────────
const mobile = await browser.newPage({ viewport: { width: 360, height: 780 }, reducedMotion: "reduce" });
await go(mobile, BASE + `/act/${SLUG}`);
ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= 360), "campaign page has no horizontal scroll at 360px");
await go(mobile, BASE + "/donate");
ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= 360), "donate page has no horizontal scroll at 360px");

await browser.close();
await finish();
