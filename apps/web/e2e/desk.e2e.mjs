// Base Ground ("the desk") and the human check, end to end: what the website
// forwards to the fake Base Ground in fake-stripe.mjs (and what it never does),
// engagement tags (RSVP, paid order, promise follow), portal edits, consent
// withdrawals both ways (to /in/v1/consent, which the fake answers 404 until
// it is switched on, and from Base Ground to /api/in/consent with the inbound
// key), retries, refusals and a wrong key through the admin, the treasurer's
// list of gifts to log at the desk, and the human check enforced by a second
// server started with the Turnstile keys.
//   ADMIN_EMAIL=admin@example.com npm run e2e -- desk
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { adminCookie, adminLogin, BASE, fakeSession, finish, ok, post, sessionIdFromUrl as sid, sql, STRIPE_BASE, stripeEvent } from "./helpers.mjs";

const KEY = process.env.BASE_GROUND_KEY ?? "sbk_e2eTestKey0123456789abcdefABCDEF";
const INBOUND_KEY = process.env.BASE_GROUND_INBOUND_KEY ?? "e2e-inbound-key-0123456789abcdefABCDEF";
const CONSENT = "/in/v1/consent";
const ALLOWED = new Set(["name", "first_name", "last_name", "email", "phone", "address", "unit", "city", "postal", "tags", "newsletter", "volunteer", "note", "source"]);

const baseGround = async () => (await fetch(`${STRIPE_BASE}/__base-ground`)).json();
const control = (what, body = {}) => fetch(`${STRIPE_BASE}/__base-ground/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until fn returns something truthy (or time runs out, returning the last value). */
async function until(fn, ms = 15_000) {
  const stop = Date.now() + ms;
  let v;
  while (Date.now() < stop) {
    v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return v;
}
const rowsFor = (email) => sql`select * from base_ground_outbox where payload->>'email' = ${email} order by created_at`;
const requestsFor = async (email) => (await baseGround()).filter((r) => r.path === "/in/v1/people" && r.body?.email === email);
const sentRow = (email) => until(async () => (await rowsFor(email)).find((r) => r.status === "sent"));
const onlyAllowed = (body) => Object.keys(body ?? {}).every((k) => ALLOWED.has(k));
const consentRows = (where) => sql`select * from base_ground_outbox where kind = 'consent' and ${where} order by created_at`;
const consentRequests = async () => (await baseGround()).filter((r) => r.path === CONSENT);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** Save /me/preferences from the keyboard (the site header's scroll animation can keep a mouse click waiting) and wait for the answer. */
async function savePortal(page) {
  const saved = page.waitForResponse((x) => x.request().method() === "POST" && x.url().includes("/me/preferences"));
  await page.locator('form.form-card button[type="submit"]').focus();
  await page.keyboard.press("Enter");
  await saved;
  await page.waitForTimeout(150);
}

/** POST to the inbound consent endpoint as Base Ground would. */
async function inbound(body, { key = INBOUND_KEY, idem = randomBytes(8).toString("hex"), base = BASE, raw } = {}) {
  const headers = { "content-type": "application/json", "x-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (idem !== null) headers["idempotency-key"] = idem;
  const res = await fetch(base + "/api/in/consent", { method: "POST", headers, body: raw ?? JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), idem };
}

// ── Before: what the other suites forwarded ───────────────────────────────
const leftover = await until(async () => Number((await sql`select count(*)::int as n from base_ground_outbox where status = 'pending' and endpoint = '/in/v1/people'`)[0].n) === 0, 10_000);
ok(leftover === true, "nothing the earlier suites forwarded is left waiting (every sign-up reached the fake Base Ground)");
const earlierConsent = await sql`select status, attempts, last_error from base_ground_outbox where endpoint = ${CONSENT}`;
ok(
  earlierConsent.length > 0 && earlierConsent.every((r) => r.status === "pending" && r.attempts === 0) && earlierConsent.some((r) => r.last_error?.startsWith("Not supported yet")),
  `the earlier suites' unsubscribes and STOPs wait, unfailed, while Base Ground has no consent endpoint (${earlierConsent.length})`,
);
await control("reset");

// ── A petition signature ──────────────────────────────────────────────────
const [petition] = await sql`select slug, title from campaigns where kind = 'petition' and active order by sort_order limit 1`;
let r = await post("/api/signatures", {
  campaign: petition.slug,
  firstName: "Desk",
  lastName: "Signer",
  email: "desk-signer@example.com",
  postalCode: "v3t1v8",
  phone: "604-555-0142",
  address: "13450 104 Ave",
  updatesConsent: true,
});
ok(r.status === 200, "a petition signature is accepted");
let row = await sentRow("desk-signer@example.com");
let req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
ok(Boolean(row && req), "the signature reaches Base Ground, and the outbox row is sent");
ok(req?.authorization === `Bearer ${KEY}` && /^application\/json/.test(req?.contentType ?? ""), "sent from the server with the Bearer website key, as JSON");
ok(req?.idempotencyKey === row?.id, "the Idempotency-Key is the outbox row id");
ok(
  JSON.stringify(req?.body) ===
    JSON.stringify({
      address: "13450 104 Ave",
      email: "desk-signer@example.com",
      first_name: "Desk",
      last_name: "Signer",
      newsletter: true,
      phone: "604-555-0142",
      postal: "V3T 1V8",
      source: `petition-${petition.slug}`,
      tags: [`Petition: ${petition.title}`.slice(0, 40).trim()],
    }),
  "the person's fields, the petition tag, the source and newsletter (consent recorded) are what Base Ground got",
);
const [signer] = await sql`select base_ground_person_id from people where email = 'desk-signer@example.com'`;
ok(Boolean(row?.base_ground_person_id) && signer?.base_ground_person_id === row.base_ground_person_id && req?.answer?.person_id === row.base_ground_person_id, "Base Ground's person id is kept on the outbox row and on the supporter");

r = await post("/api/signatures", { campaign: petition.slug, firstName: "Quiet", lastName: "Signer", email: "desk-quiet@example.com", postalCode: "V3W 2A1" });
row = await sentRow("desk-quiet@example.com");
req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
ok(r.status === 200 && req && req.body.newsletter === undefined && onlyAllowed(req.body), "without the email tick, newsletter is not sent");

// ── Newsletter, single opt-in (email isn't configured here) ───────────────
r = await post("/api/newsletter", { email: "Desk-News@Example.com", source: "home" });
row = await sentRow("desk-news@example.com");
req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
ok(r.body?.status === "subscribed" && row?.kind === "newsletter", "a newsletter sign-up is forwarded once it is subscribed");
ok(JSON.stringify(req?.body) === JSON.stringify({ email: "desk-news@example.com", newsletter: true, source: "newsletter-home" }), "with newsletter: true and the sign-up's source");
r = await post("/api/newsletter", { email: "desk-news@example.com", source: "home" });
await sleep(800);
ok((await rowsFor("desk-news@example.com")).length === 1, "signing up again while subscribed forwards nothing more");

// ── A volunteer shift ─────────────────────────────────────────────────────
const date = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
const [opening] = await sql`insert into shift_openings (date, slot, title, location, capacity, published) values (${date}, 'morning', 'Desk test canvass', 'Newton Library', 5, true) returning id`;
r = await post("/api/volunteer/signup", { openingId: opening.id, name: "Vol Desk", email: "desk-vol@example.com", postalCode: "V3W 2A1", phone: "604-555-0143" });
row = await sentRow("desk-vol@example.com");
req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
const longDate = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
ok(r.status === 200 && row?.kind === "volunteer-shift", "a shift sign-up is forwarded");
ok(
  req?.body?.volunteer === true && req.body.note === `Signed up for Desk test canvass, ${longDate}, 9 a.m.–12 p.m. at Newton Library` && req.body.source === "volunteer-shift" && req.body.newsletter === undefined && req.body.name === "Vol Desk",
  "with volunteer: true and the shift in the note (no newsletter without the tick)",
);

// ── Engagement tags: an RSVP, a paid order, a confirmed follow ────────────
// A tag on the person and nothing more. A donation is never sent.
const outboxCount = async () => (await sql`select count(*)::int as n from base_ground_outbox`)[0].n;
const [event] = await sql`insert into events (slug, title, starts_at, location, summary, published) values ('desk-e2e-meetup', 'Desk meetup', now() + interval '10 days', 'Hall', 'A meetup', true) returning id`;
r = await post("/api/events/desk-e2e-meetup/rsvp", { name: "Rae Rsvp", email: "desk-rsvp@example.com", guests: 1 });
ok(r.status === 200, "an RSVP is accepted");
row = await sentRow("desk-rsvp@example.com");
req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
ok(row?.kind === "rsvp" && JSON.stringify(req?.body) === JSON.stringify({ email: "desk-rsvp@example.com", name: "Rae Rsvp", source: "rsvp", tags: ["RSVP: Desk meetup"] }), "an RSVP goes as the tag “RSVP: Desk meetup”, with the name and email only (no guests)");
r = await post("/api/events/desk-e2e-meetup/rsvp", { name: "Rae Rsvp", email: "desk-rsvp@example.com", guests: 2 });
await sleep(800);
ok(r.status === 200 && (await rowsFor("desk-rsvp@example.com")).length === 1, "the same RSVP again sends nothing more");

const donor = { firstName: "Desk", lastName: "Donor", email: "desk-donor@example.com", address: "10 King George Blvd", city: "Surrey", postalCode: "V3T 2W1", attestCitizenOrPR: true, attestBcResident: true, attestOwnFunds: true, newsletter: true };
const countBefore = await outboxCount();
r = await post("/api/donations/checkout", { ...donor, frequency: "one_time", tier: "standard", amountCents: 5000 });
ok(r.status === 200 && r.body?.url, "a donation checkout starts");
const donationSession = sid(r.body.url);
const [product] = await sql`select slug from products where active order by sort_order limit 1`;
r = await post("/api/shop/checkout", { items: [{ slug: product.slug, quantity: 2 }] });
ok(r.status === 200, "a shop checkout starts");
const orderSession = await fakeSession(sid(r.body.url));
// The donation is paid (the Stripe webhook), which must not forward it either.
const s = await fakeSession(donationSession);
let w = await stripeEvent("checkout.session.completed", { id: donationSession, object: "checkout.session", mode: s.mode, metadata: s.metadata, payment_status: "paid", payment_intent: `pi_${donationSession}`, customer: "cus_desk", amount_total: s.amount_total });
ok(w.status === 200, "the donation is paid");
await sleep(1500);
ok((await rowsFor("desk-donor@example.com")).length === 0 && (await requestsFor("desk-donor@example.com")).length === 0, "a donation (checkout and payment) sends nothing to Base Ground");
ok((await outboxCount()) === countBefore, "and neither does the shop checkout before it is paid: nothing was queued at all");

w = await stripeEvent("checkout.session.completed", {
  id: orderSession.id,
  object: "checkout.session",
  mode: orderSession.mode,
  metadata: orderSession.metadata,
  payment_status: "paid",
  payment_intent: `pi_${orderSession.id}`,
  amount_total: orderSession.amount_total,
  customer_details: { email: "Desk-Buyer@Example.com", name: "Bea Buyer", phone: "6045550155", address: { line1: "5 Fraser Hwy", city: "Surrey", postal_code: "V3S 1A1", country: "CA" } },
  shipping_details: { name: "Bea Buyer", address: { line1: "5 Fraser Hwy", city: "Surrey", postal_code: "V3S 1A1", country: "CA" } },
});
row = await sentRow("desk-buyer@example.com");
req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
ok(w.status === 200 && row?.kind === "order", "a paid order is forwarded after the webhook");
ok(JSON.stringify(req?.body) === JSON.stringify({ email: "desk-buyer@example.com", source: "shop", tags: ["Bought merch"] }), "as the “Bought merch” tag only: no total, items, address or payment");

const [promise] = await sql`select id, number from tracker_promises order by number limit 1`;
r = await post("/api/tracker/follow", { promiseId: promise.id, email: "desk-follow@example.com", consent: true });
row = await sentRow("desk-follow@example.com");
req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
ok(r.status === 200 && r.body?.status === "confirmed" && row?.kind === "follow", "a confirmed promise follow is forwarded (email isn't configured here, so it is confirmed at once)");
ok(JSON.stringify(req?.body) === JSON.stringify({ email: "desk-follow@example.com", source: "tracker", tags: [`Follows: promise ${promise.number}`] }), `as the tag “Follows: promise ${promise.number}”`);
r = await post("/api/tracker/follow", { promiseId: promise.id, email: "desk-follow@example.com", consent: true });
await sleep(800);
ok(r.status === 200 && (await rowsFor("desk-follow@example.com")).length === 1, "following the same promise again sends nothing more");
ok((await baseGround()).every((x) => !x.raw || !/amount|cents|fee|stripe|pi_|cs_test|total|quantity/i.test(x.raw)), "no request to Base Ground has ever carried money or a payment reference");

// ── Consent out: an unsubscribe, while Base Ground has no consent endpoint ───
r = await post("/api/newsletter", { email: "desk-unsub@example.com", source: "home" });
await sentRow("desk-unsub@example.com");
const [unsubToken] = await sql`select unsubscribe_token from newsletter_subscribers where email = 'desk-unsub@example.com'`;
let res = await fetch(BASE + "/api/newsletter/unsubscribe", { method: "POST", body: new URLSearchParams({ token: unsubToken.unsubscribe_token }), redirect: "manual" });
ok(res.status === 303, "the newsletter unsubscribe works");
let unsub = await until(async () => (await consentRows(sql`payload->>'email' = 'desk-unsub@example.com'`)).find((x) => x.last_error));
ok(
  unsub?.endpoint === CONSENT && unsub.payload.channel === "email" && unsub.payload.action === "withdraw" && unsub.payload.reason === "unsubscribe" && !Number.isNaN(Date.parse(unsub.payload.at)),
  "an unsubscribe is queued for /in/v1/consent: { email, channel: email, action: withdraw, reason: unsubscribe, at }",
);
const notFound = (await consentRequests()).find((x) => x.idempotencyKey === unsub?.id);
ok(notFound?.status === 404 && notFound.authorization === `Bearer ${KEY}`, "it was sent with the website key and the row id as Idempotency-Key, and the fake Base Ground answered 404");
ok(unsub?.status === "pending" && unsub.attempts === 0 && unsub.last_error.startsWith("Not supported yet") && new Date(unsub.next_attempt_at) > new Date(Date.now() + 5 * 3_600_000), "a 404 there keeps the row pending (not failed), uses no try, and waits 6 hours");
r = await post("/api/signatures", { campaign: petition.slug, firstName: "After", lastName: "Unsub", email: "desk-after-unsub@example.com", postalCode: "V3T 1V8" });
ok(Boolean(await sentRow("desk-after-unsub@example.com")), "sign-ups keep going to Base Ground meanwhile");

// ── A membership, once paid ───────────────────────────────────────────────
const member = { firstName: "Mem", lastName: "Desk", email: "desk-member@example.com", phone: "604-555-0144", address: "20 Fraser Hwy", city: "Surrey", postalCode: "V3S 1A1", neighbourhood: "Cloverdale", birthdate: "1985-01-02", citizenshipStatus: "Citizen", gender: "", languages: ["English"], student: false, campus: "", issue: "Safer streets", interestVolunteer: true, interestLawnSign: true, updatesConsent: true, consent: true, website: "" };
r = await post("/api/membership", member);
ok(r.status === 200 && r.body?.status === "checkout", "a membership goes to checkout");
await sleep(500);
ok((await rowsFor("desk-member@example.com")).length === 0, "nothing is forwarded before the membership is paid");
const ms = await fakeSession(sid(r.body.url));
w = await stripeEvent("checkout.session.completed", { id: ms.id, object: "checkout.session", mode: ms.mode, metadata: ms.metadata, payment_status: "paid", payment_intent: `pi_${ms.id}`, customer: "cus_member", amount_total: ms.amount_total });
row = await sentRow("desk-member@example.com");
req = row && (await baseGround()).find((x) => x.idempotencyKey === row.id);
ok(w.status === 200 && row?.kind === "membership", "an active membership is forwarded after the webhook");
ok(
  JSON.stringify(req?.body) ===
    JSON.stringify({
      address: "20 Fraser Hwy",
      city: "Surrey",
      email: "desk-member@example.com",
      name: "Mem Desk",
      newsletter: true,
      note: "Wants to volunteer. Asked for a lawn sign",
      phone: "604-555-0144",
      postal: "V3S 1A1",
      source: "membership",
      tags: ["Member (joined online)"],
      volunteer: true,
    }),
  "from the member snapshot: volunteering, the lawn sign in the note, the updates tick, and no fee",
);

// ── Browser: the admin ────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await adminLogin(page);

// Base Ground down (503): the row waits with a backoff; "Send now" delivers it with the same key.
await control("fail", { status: 503, times: 1, path: "/in/v1/people" });
r = await post("/api/signatures", { campaign: petition.slug, firstName: "Retry", lastName: "Later", email: "desk-retry@example.com", postalCode: "V3T 1V8" });
row = await until(async () => (await rowsFor("desk-retry@example.com")).find((x) => x.attempts === 1));
ok(r.status === 200, "the visitor's signature succeeds while Base Ground is down");
ok(row?.status === "pending" && row.next_attempt_at && new Date(row.next_attempt_at) > new Date() && /^503/.test(row.last_error ?? ""), "a 503 leaves the row pending, with a next attempt time and the error");
await page.goto(BASE + "/admin/integrations");
await page.getByRole("button", { name: /^Send now/ }).click();
await page.locator("[role=status]", { hasText: "sent" }).first().waitFor({ timeout: 20_000 });
const retried = await sentRow("desk-retry@example.com");
const both = await requestsFor("desk-retry@example.com");
ok(retried && both.length === 2 && both[0].status === 503 && both[1].status === 200 && both[0].idempotencyKey === retried.id && both[1].idempotencyKey === retried.id && both[0].raw === both[1].raw, "\"Send now\" delivers it with the same Idempotency-Key and body");

// Base Ground refuses (400): failed with the message; Retry in the outbox page sends it again.
await control("fail", { status: 400, times: 1, path: "/in/v1/people" });
r = await post("/api/signatures", { campaign: petition.slug, firstName: "Refused", lastName: "Once", email: "desk-refused@example.com", postalCode: "V3T 1V8" });
row = await until(async () => (await rowsFor("desk-refused@example.com")).find((x) => x.status === "failed"));
ok(row?.last_error === "400: simulated 400" && row.attempts === 1, "a 400 marks the row failed, with Base Ground's message");
const dash = await (await fetch(BASE + "/admin", { headers: { cookie: await adminCookie() } })).text();
ok(dash.replace(/<!--.*?-->/g, "").includes("sign-ups Base Ground refused"), "the dashboard flags sign-ups Base Ground refused");
await page.goto(BASE + "/admin/integrations/base-ground?status=failed");
const failedRow = page.locator(`tr[data-outbox="${row?.id}"]`);
ok((await failedRow.count()) === 1 && (await failedRow.textContent()).includes("400: simulated 400"), "the outbox page lists the failed row with its error");
await failedRow.getByRole("button", { name: "Retry" }).click();
// Once sent it leaves this "failed" list.
row = await until(async () => (await rowsFor("desk-refused@example.com")).find((x) => x.status === "sent"), 20_000);
await page.waitForFunction((id) => !document.querySelector(`tr[data-outbox="${id}"]`), row?.id, { timeout: 15_000 }).catch(() => {});
row = (await rowsFor("desk-refused@example.com"))[0];
ok(row.status === "sent" && (await requestsFor("desk-refused@example.com")).length === 2, "Retry sends it again, and it goes");
const audited = await sql`select action from audit_log where action in ('integrations.base-ground-retry', 'integrations.base-ground-send')`;
ok(audited.length >= 2, "Send now and Retry are in the audit log");

// A wrong key (401): rows stay pending without burning attempts, and the card says so.
await control("key", { key: "sbk_revokedKey0123456789abcdefghijkl" });
r = await post("/api/signatures", { campaign: petition.slug, firstName: "Wrong", lastName: "Key", email: "desk-key@example.com", postalCode: "V3T 1V8" });
row = await until(async () => (await rowsFor("desk-key@example.com")).find((x) => x.last_error));
ok(r.status === 200 && row?.status === "pending" && row.attempts === 0 && /^401/.test(row.last_error), "a 401 leaves the row pending with no attempt counted");
await page.goto(BASE + "/admin/integrations");
const card = page.locator("section[aria-label='Base Ground (the desk)']");
const cardText = await card.textContent();
ok(cardText.includes("401") && cardText.includes("Check the key") && cardText.includes("problem"), "the integrations card shows the key problem");
await card.getByRole("button", { name: "Test connection" }).click();
await card.locator("[role=alert]").first().waitFor({ timeout: 15_000 });
ok((await card.locator("[role=alert]").first().textContent()).includes("401"), "Test connection reports the refused key");
await control("key", { key: KEY });
await card.getByRole("button", { name: "Test connection" }).click();
await card.locator("[role=status]", { hasText: "Connected to Imagine Surrey (test)" }).first().waitFor({ timeout: 15_000 });
ok(true, "Test connection names the campaign and the key once the key works");
ok(cardText.includes("waiting: not supported yet"), "the card shows unsubscribes waiting because Base Ground doesn't take them yet");
await card.getByRole("button", { name: /^Send now/ }).click();
await card.locator("[role=status]", { hasText: "sent" }).first().waitFor({ timeout: 20_000 });
ok((await rowsFor("desk-key@example.com"))[0].status === "sent", "with the key fixed, Send now delivers what was waiting");

// The supporter's profile shows the Base Ground id and what was sent.
const [keyPerson] = await sql`select id, base_ground_person_id from people where email = 'desk-key@example.com'`;
await page.goto(`${BASE}/admin/people/${keyPerson.id}`);
const profile = await page.locator("main, body").first().textContent();
ok(Boolean(keyPerson.base_ground_person_id) && profile.includes(keyPerson.base_ground_person_id) && profile.includes("Sent to Base Ground"), "the profile shows the Base Ground id and the person's outbox rows");

// ── Consent out, once Base Ground has the endpoint ──────────────────────────
await page.goto(BASE + "/admin/integrations/base-ground?kind=consent");
ok((await page.locator("[role=note]", { hasText: "doesn't take consent changes yet" }).count()) === 1, "the outbox page explains why unsubscribes are waiting");
const unsubRow = page.locator(`tr[data-outbox="${unsub?.id}"]`);
ok((await unsubRow.getAttribute("data-status")) === "pending" && (await unsubRow.textContent()).includes("Not supported yet"), "and lists the unsubscribe as waiting, not failed");
await control("consent", { supported: true });
await page.goto(BASE + "/admin/integrations");
await page.locator("section[aria-label='Base Ground (the desk)']").getByRole("button", { name: /^Send now/ }).click();
await page.locator("[role=status]", { hasText: "sent" }).first().waitFor({ timeout: 20_000 });
unsub = await until(async () => (await consentRows(sql`id = ${unsub.id}`)).find((x) => x.status === "sent"));
const accepted = (await consentRequests()).filter((x) => x.idempotencyKey === unsub?.id);
ok(Boolean(unsub) && accepted.length === 2 && accepted[1].status === 200 && accepted[0].raw === accepted[1].raw, "once Base Ground has /in/v1/consent, Send now delivers it, with the same key and body");
ok(
  JSON.stringify(accepted[1]?.body) === JSON.stringify({ action: "withdraw", at: unsub?.payload.at, channel: "email", email: "desk-unsub@example.com", reason: "unsubscribe" }),
  "Base Ground got exactly { action, at, channel, email, reason }",
);
ok((await sql`select count(*)::int as n from base_ground_outbox where endpoint = ${CONSENT} and status <> 'sent'`)[0].n === 0, "every waiting unsubscribe and STOP from the earlier suites went too");

// A text STOP: the number, channel sms, reason stop.
await sql`insert into people (email, first_name, phone, sms_consent_at) values ('desk-stop@example.com', 'Stop', '604-555-0177', now())`;
res = await fetch(BASE + "/api/sms/inbound", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: "+16045550177", To: "+16045550000", Body: "STOP", MessageSid: `SMdesk${Date.now()}` }) });
const stopRow = await until(async () => (await consentRows(sql`payload->>'phone' = '+16045550177'`)).find((x) => x.status === "sent"));
ok(res.status === 200 && stopRow?.payload.channel === "sms" && stopRow.payload.reason === "stop" && stopRow.payload.email === undefined, "a text STOP goes to Base Ground with the number");

// The preference centre (a token link): unticking both.
await sql`insert into people (email, first_name, phone, contact_consent_at, sms_consent_at) values ('desk-pref@example.com', 'Pref', '604-555-0178', now(), now())`;
const prefRaw = randomBytes(24).toString("base64url");
await sql`insert into auth_tokens (purpose, email, token_hash, expires_at) values ('preferences', 'desk-pref@example.com', ${sha256(prefRaw)}, now() + interval '1 hour')`;
r = await post("/api/preferences", { token: prefRaw, updates: false, sms: false });
const prefRows = await until(async () => {
  const rows = await consentRows(sql`payload->>'email' = 'desk-pref@example.com'`);
  return rows.length === 2 && rows.every((x) => x.status === "sent") ? rows : null;
});
ok(r.status === 200 && Boolean(prefRows), "the preference centre's withdrawals both go");
ok(prefRows?.some((x) => x.payload.channel === "email" && x.payload.reason === "preference") && prefRows?.some((x) => x.payload.channel === "sms" && x.payload.phone === "+16045550178" && x.payload.reason === "preference"), "one per channel, reason preference, the text one with the number");

// The supporter portal: a new phone and address, and unticking email updates.
const [member2] = await sql`insert into people (email, first_name, last_name, phone, postal_code, contact_consent_at) values ('desk-portal@example.com', 'Port', 'Al', null, 'V3W 1A1', now()) returning id`;
const loginRaw = randomBytes(32).toString("base64url");
await sql`insert into auth_tokens (purpose, email, token_hash, expires_at) values ('member-login', 'desk-portal@example.com', ${sha256(loginRaw)}, now() + interval '30 minutes')`;
const memberPage = await (await browser.newContext()).newPage();
await memberPage.goto(`${BASE}/api/me/verify?token=${loginRaw}`);
await memberPage.waitForURL(/\/me\/verify\?/);
await memberPage.click('button:has-text("Sign in")');
await memberPage.waitForURL(/\/me$/);
await memberPage.goto(BASE + "/me/preferences");
await memberPage.fill("#pref-phone", "604-555-0179");
await memberPage.fill("#pref-address", "77 Portal Way");
await memberPage.uncheck('input[name="updates"]');
await savePortal(memberPage);
await memberPage.locator('[role="status"].alert').waitFor();
const portalRow = await until(async () => (await rowsFor("desk-portal@example.com")).find((x) => x.kind === "portal" && x.status === "sent"));
req = portalRow && (await baseGround()).find((x) => x.idempotencyKey === portalRow.id);
ok(
  JSON.stringify(req?.body) === JSON.stringify({ address: "77 Portal Way", email: "desk-portal@example.com", first_name: "Port", last_name: "Al", phone: "604-555-0179", postal: "V3W 1A1", source: "portal" }),
  "a portal edit sends the person's details, source portal (Base Ground fills blanks only)",
);
const portalWithdraw = await until(async () => (await consentRows(sql`payload->>'email' = 'desk-portal@example.com'`)).find((x) => x.status === "sent"));
ok(portalWithdraw?.payload.channel === "email" && portalWithdraw.payload.reason === "preference", "unticking email updates at /me goes to Base Ground as a withdrawal");
const portalCount = (await rowsFor("desk-portal@example.com")).length;
await memberPage.selectOption("#pref-locale", "pa");
await savePortal(memberPage);
await sleep(800);
ok((await rowsFor("desk-portal@example.com")).length === portalCount && (await consentRows(sql`payload->>'email' = 'desk-portal@example.com'`)).length === 1, "saving again with only the language changed sends nothing");
await memberPage.context().close();

// A deletion (anonymize): Base Ground is told, then the address leaves the row.
const [doomed] = await sql`insert into people (email, first_name, phone, contact_consent_at) values ('desk-delete@example.com', 'Del', '604-555-0180', now()) returning id`;
await page.goto(`${BASE}/admin/people/${doomed.id}`);
await page.locator('input[name="confirm"]').check();
page.once("dialog", (d) => d.accept());
await page.locator('button:has-text("Anonymize this supporter")').focus();
await page.keyboard.press("Enter");
await page.locator('[role="status"]', { hasText: "Personal details were removed" }).waitFor();
const deletionRows = await until(async () => {
  const rows = await sql`select * from base_ground_outbox where kind = 'consent' and person_id = ${doomed.id}`;
  return rows.length === 2 && rows.every((x) => x.status === "sent") ? rows : null;
});
ok(Boolean(deletionRows) && deletionRows.every((x) => x.payload.reason === "deletion") && deletionRows.some((x) => x.payload.channel === "sms"), "an anonymized supporter's email and texts are withdrawn in Base Ground (reason deletion)");
const deletionSent = (await consentRequests()).filter((x) => deletionRows?.some((d) => d.id === x.idempotencyKey));
ok(deletionSent.some((x) => x.body?.email === "desk-delete@example.com") && deletionSent.some((x) => x.body?.phone === "+16045550180"), "Base Ground got the address and the number to stop");
ok(deletionRows?.every((x) => !JSON.stringify(x.payload).includes("desk-delete@example.com") && !JSON.stringify(x.payload).includes("555-0180") && !JSON.stringify(x.payload).includes("5550180")), "and once sent they are removed from the rows here");

// ── Consent in: withdrawals made in Base Ground ──────────────────────────────
await sql`insert into people (email, first_name, phone, contact_consent_at, sms_consent_at) values ('desk-in@example.com', 'Inna', '(604) 555-0181', now(), now())`;
await sql`insert into newsletter_subscribers (email, status, source, unsubscribe_token, confirmed_at) values ('desk-in@example.com', 'subscribed', 'e2e', 'desk-in-token', now())`;
const outboxBefore = await outboxCount();
const at = new Date().toISOString();
let i = await inbound({ email: "desk-in@example.com", channel: "email", action: "withdraw", reason: "unsubscribe", at }, { key: null });
ok(i.status === 401, "without the key: 401");
i = await inbound({ email: "desk-in@example.com", channel: "email", action: "withdraw", reason: "unsubscribe", at }, { key: "wrong-key" });
ok(i.status === 401 && /valid key/.test(i.body?.error), "with a wrong key: 401");
i = await inbound({ email: "desk-in@example.com", channel: "email", action: "withdraw", reason: "unsubscribe", at }, { idem: null });
ok(i.status === 400 && /Idempotency-Key/.test(i.body?.error), "without an Idempotency-Key: 400");
i = await inbound({ email: "desk-in@example.com", channel: "email", action: "withdraw", reason: "unsubscribe", at, rating: 5 });
ok(i.status === 400 && /rating/.test(i.body?.error), "a field outside the shape: 400, naming it");
const withdraw = { email: "desk-in@example.com", channel: "email", action: "withdraw", reason: "unsubscribe", at };
i = await inbound(withdraw, { idem: "sb-desk-in-1" });
const inPerson = async () => (await sql`select contact_consent_at, sms_consent_at from people where email = 'desk-in@example.com'`)[0];
ok(i.status === 200 && i.body?.ok === true && i.body.applied === 1, "a withdrawal with the key is applied");
ok((await inPerson()).contact_consent_at === null && (await sql`select status from newsletter_subscribers where email = 'desk-in@example.com'`)[0].status === "unsubscribed", "email consent is cleared and the address unsubscribed");
const ledger = await sql`select * from consent_events where email = 'desk-in@example.com' and action = 'withdraw'`;
ok(ledger.length === 1 && ledger[0].source === "base-ground" && ledger[0].channel === "email" && ledger[0].wording.includes("unsubscribe"), "it is in the consent ledger with source base-ground");
await sleep(800);
ok((await outboxCount()) === outboxBefore, "and nothing is sent back to Base Ground (no echo)");
i = await inbound(withdraw, { idem: "sb-desk-in-1" });
ok(i.status === 200 && i.body?.replayed === true && (await sql`select count(*)::int as n from consent_events where email = 'desk-in@example.com'`)[0].n === 1, "the same Idempotency-Key and body replays the answer and records nothing twice");
i = await inbound({ ...withdraw, reason: "preference" }, { idem: "sb-desk-in-1" });
ok(i.status === 409, "the same Idempotency-Key with another body: 409");
i = await inbound({ phone: "+16045550181", channel: "sms", action: "withdraw", reason: "stop", at });
ok(i.status === 200 && i.body?.applied === 1 && (await inPerson()).sms_consent_at === null, "a text STOP made in Base Ground clears SMS consent for the number, whatever its format here");
await sql`update people set contact_consent_at = null where email = 'desk-in@example.com'`;
i = await inbound({ email: "desk-in@example.com", channel: "email", action: "grant", reason: "preference", at });
ok(i.status === 200 && i.body?.applied === 0 && (await inPerson()).contact_consent_at === null, "a grant from Base Ground is answered but never applied");
i = await inbound({ email: "desk-in-new@example.com", channel: "email", action: "withdraw", reason: "deletion", at });
ok(i.status === 200 && i.body?.applied === 0 && (await sql`select count(*)::int as n from consent_events where email = 'desk-in-new@example.com' and source = 'base-ground'`)[0].n === 1, "an address the website doesn't have is still kept in the ledger, so a public form can't sign it up again");
ok((await sql`select count(*)::int as n from audit_log where entity = 'base-ground-consent'`)[0].n === 4, "every call applied or answered is in the audit log, without the address");
ok((await sql`select count(*)::int as n from audit_log where entity = 'base-ground-consent' and details::text like '%desk-in%'`)[0].n === 0, "(the audit entries hold no address)");
ok((await outboxCount()) === outboxBefore, "none of it is echoed back to Base Ground");

// ── Gifts to log at the desk ──────────────────────────────────────────────
const [gift] = await sql`select id, desk_logged_at from contributions where stripe_checkout_session_id = ${donationSession}`;
const cookie = await adminCookie();
const dashboard = (await (await fetch(BASE + "/admin", { headers: { cookie } })).text()).replace(/<!--.*?-->/g, "");
ok(dashboard.includes("online gifts to log at the desk"), "the dashboard counts online gifts to log at the desk");
let csv = await (await fetch(BASE + "/api/admin/desk-gifts", { headers: { cookie } })).text();
const header = "Contributor name,Address,City,Postal code,Email,Amount,Net of refunds,Slate,Kind,Paid (Pacific),Stripe reference,Flags,Website id";
ok(csv.split("\r\n")[0] === header, "the CSV has the expected header");
const csvLine = csv.split("\r\n").find((l) => l.includes(gift.id)) ?? "";
ok(csvLine.startsWith("Desk Donor,10 King George Blvd,Surrey,V3T 2W1,desk-donor@example.com,50.00,50.00,City council,Donation,") && csvLine.includes(`pi_${donationSession}`), "the CSV row has what Log a gift asks for");
await page.goto(BASE + "/admin/desk-gifts");
const giftRow = page.locator(`tr[data-gift="${gift.id}"]`);
ok((await giftRow.count()) === 1 && (await giftRow.textContent()).includes("Desk Donor") && (await giftRow.textContent()).includes("$50"), "the paid donation is listed to log at the desk");
await giftRow.getByRole("button", { name: /Mark logged/ }).click();
await page.locator("[role=status]", { hasText: "Marked 1 gift" }).first().waitFor({ timeout: 15_000 });
await page.waitForFunction((id) => !document.querySelector(`tr[data-gift="${id}"]`), gift.id, { timeout: 15_000 });
const [logged] = await sql`select c.desk_logged_at, a.email from contributions c left join admin_users a on a.id = c.desk_logged_by where c.id = ${gift.id}`;
ok(logged.desk_logged_at && logged.email === (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase(), "Mark logged records when and by whom, and the row leaves the list");
csv = await (await fetch(BASE + "/api/admin/desk-gifts", { headers: { cookie } })).text();
ok(!csv.includes(gift.id), "a logged gift leaves the CSV too");
await browser.close();

// ── The human check, enforced (a second server with the Turnstile keys) ───
const root = path.resolve(import.meta.dirname, "..");
const humanPort = Number(process.env.E2E_HUMAN_PORT ?? Number(process.env.E2E_PORT ?? 3100) + 1);
const HUMAN = `http://localhost:${humanPort}`;
const server = spawn("npx", ["next", "start", "-p", String(humanPort)], {
  cwd: root,
  // Also without BASE_GROUND_INBOUND_KEY, to check the inbound endpoint refuses everything then.
  env: { ...process.env, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x-e2e-site-key", TURNSTILE_SECRET_KEY: "e2e-turnstile-secret", TURNSTILE_VERIFY_URL: `${STRIPE_BASE}/turnstile/siteverify`, NEXT_PUBLIC_SITE_URL: HUMAN, BASE_GROUND_INBOUND_KEY: "" },
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stopServer);
const up = await until(async () => {
  try {
    return (await fetch(HUMAN + "/api/promises")).status < 500;
  } catch {
    return false;
  }
}, 60_000);
ok(up === true, "a second server starts with the human check on");
const sign = async (headers) => {
  const res = await fetch(HUMAN + "/api/signatures", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers },
    body: JSON.stringify({ campaign: petition.slug, firstName: "Human", lastName: "Check", email: "desk-human@example.com", postalCode: "V3T 1V8" }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
let h = await sign({});
ok(h.status === 400 && h.body?.error === "Please complete the check that you're a person, then try again." && Boolean(h.body?.fields?.human), "without a token: 400, with a human field error");
h = await sign({ "x-human-token": "bad-token" });
ok(h.status === 400 && Boolean(h.body?.fields?.human), "with a bad token: 400");
ok((await sql`select count(*)::int as n from campaign_signatures where email = 'desk-human@example.com'`)[0].n === 0, "nothing was signed without a good token");
h = await sign({ "x-human-token": "ok-token" });
ok(h.status === 200 && h.body?.ok === true, "with a good token: 200");
const verifyCalls = (await (await fetch(`${STRIPE_BASE}/__log`)).json()).filter((c) => c.path === "/turnstile/siteverify");
ok(verifyCalls.some((c) => c.params.response === "ok-token" && /^10\.88\./.test(c.params.remoteip ?? "")), "the server checked the token with the visitor's IP");
const bot = await fetch(HUMAN + "/api/newsletter", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.89.1.1" }, body: JSON.stringify({ email: "bot@example.com", website: "spam.example" }) });
ok(bot.status === 200 && (await bot.json()).ok === true, "the honeypot still answers a bot with a fake success first");
const donate = await fetch(HUMAN + "/api/donations/checkout", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.89.1.2" }, body: JSON.stringify({ ...donor, email: "desk-human-donor@example.com", frequency: "one_time", tier: "standard", amountCents: 1000 }) });
ok(donate.status === 200, "the donation checkout doesn't ask for the human check (Stripe screens payments)");
const off = await inbound({ email: "desk-in@example.com", channel: "email", action: "withdraw", reason: "unsubscribe", at: new Date().toISOString() }, { base: HUMAN });
ok(off.status === 503 && /BASE_GROUND_INBOUND_KEY/.test(off.body?.error), "without BASE_GROUND_INBOUND_KEY the inbound endpoint refuses every call (503), even with a key");
stopServer();

await finish();
