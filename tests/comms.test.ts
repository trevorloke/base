import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, like } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// These modules are server-only; in tests the guard is a no-op and site
// settings come from the code defaults.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/settings", async () => {
  const { defaultSettings } = await import("@/lib/settings");
  return { getSettings: async () => defaultSettings() };
});

import * as schema from "@/lib/db/schema";
import { classifyInbound, smsSegments, twiml, twilioSignature, twilioSignatureMatches } from "@/lib/email/inbound-sms";
import { donationThanksEmail, membershipWelcomeEmail, promiseStatusEmail, rsvpEmail, shiftConfirmationEmail, shiftWindow, signatureEmail, STOP_LINE } from "@/lib/email/notifications";

const ctx = { siteUrl: "https://imaginesurrey.ca", orgName: "Imagine Surrey", orgEmail: "hello@imaginesurrey.ca" };

describe("inbound text keywords", () => {
  it("recognises every opt-out word, whatever the case or punctuation", () => {
    for (const w of ["STOP", "stop", "Stop.", "STOPALL", "stop all", "unsubscribe", "CANCEL", "End", "quit!"]) expect(classifyInbound(w).kind).toBe("stop");
  });
  it("recognises opt-in, help, join and language words", () => {
    expect(classifyInbound("start").kind).toBe("start");
    expect(classifyInbound("UNSTOP").kind).toBe("start");
    expect(classifyInbound("yes").kind).toBe("start");
    expect(classifyInbound("Help").kind).toBe("help");
    expect(classifyInbound("JOIN").kind).toBe("join");
    expect(classifyInbound("punjabi")).toEqual({ kind: "language", locale: "pa", language: "Punjabi" });
    expect(classifyInbound("Chinese")).toEqual({ kind: "language", locale: "zh-Hans", language: "Chinese" });
    expect(classifyInbound("TAGALOG")).toEqual({ kind: "language", locale: "tl", language: "Tagalog" });
    expect(classifyInbound("hindi")).toEqual({ kind: "language", locale: "hi", language: "Hindi" });
  });
  it("treats anything else as a message", () => {
    expect(classifyInbound("When is the next meeting?").kind).toBe("other");
    expect(classifyInbound("").kind).toBe("other");
  });
});

describe("Twilio signatures", () => {
  // The worked example from Twilio's security documentation.
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  it("matches the documented example", () => {
    expect(twilioSignature(token, url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
  it("accepts a signature for any candidate URL and rejects the rest", () => {
    const sig = twilioSignature(token, url, params);
    expect(twilioSignatureMatches(token, sig, ["https://other.example/x", url], params)).toBe(true);
    expect(twilioSignatureMatches(token, sig, ["https://other.example/x"], params)).toBe(false);
    expect(twilioSignatureMatches("wrong", sig, [url], params)).toBe(false);
    expect(twilioSignatureMatches(token, null, [url], params)).toBe(false);
  });
  it("writes TwiML with the reply escaped", () => {
    expect(twiml("Tom & Jerry <3")).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Tom &amp; Jerry &lt;3</Message></Response>');
    expect(twiml(null)).toContain("<Response></Response>");
  });
});

describe("text segments", () => {
  it("counts GSM and unicode segments", () => {
    expect(smsSegments("a".repeat(160))).toEqual({ characters: 160, segments: 1, unicode: false });
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("😀" + "a".repeat(70)).segments).toBe(2);
    expect(smsSegments("").segments).toBe(0);
  });
});

describe("one-click unsubscribe header", () => {
  it("points mail clients at the API route that accepts the token", async () => {
    const { oneClickUrl } = await import("@/lib/server/email");
    expect(oneClickUrl("https://imaginesurrey.ca/newsletter/unsubscribe?token=abc")).toBe("https://imaginesurrey.ca/api/newsletter/unsubscribe?token=abc");
    expect(oneClickUrl("https://imaginesurrey.ca/other?token=abc")).toBe("https://imaginesurrey.ca/other?token=abc");
  });
});

describe("transactional email builders", () => {
  const event = { id: "e1", slug: "town-hall", title: "Newton town hall", startsAt: new Date("2026-11-12T03:00:00Z"), endsAt: null, location: "Newton Seniors Centre", address: "13775 70 Ave", summary: "Bring your questions." };

  it("builds an RSVP confirmation with a calendar file, a Google link and share links", () => {
    const out = rsvpEmail(ctx, { name: "Raj Patel", guests: 2, event, referralCode: "ABCD2345" });
    expect(out.subject).toBe("You're in: Newton town hall");
    expect(out.attachments?.[0].filename).toBe("town-hall.ics");
    const ics = Buffer.from(out.attachments![0].content, "base64").toString("utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:Newton town hall");
    expect(ics).toContain("UID:event-e1@imaginesurrey.ca");
    expect(out.html).toContain("calendar.google.com/calendar/render");
    expect(out.html).toContain("wa.me");
    expect(out.html).toContain("ref=ABCD2345");
    expect(out.html).toContain("with 2 guests");
    expect(out.html).not.toContain("Unsubscribe</a>");
  });

  it("builds a signature thank-you with a council mailto only when there are target emails", () => {
    const campaign = { slug: "skytrain-south-surrey", title: "Get SkyTrain to South Surrey", kind: "petition" as const, shareText: "I signed:", statement: "Keep the promise.", targetEmails: ["mayor@surrey.ca", "council@surrey.ca"] };
    const out = signatureEmail(ctx, { firstName: "Raj", lastName: "P", campaign, referralCode: "ABCD2345" });
    expect(out.html).toContain("mailto:mayor@surrey.ca,council@surrey.ca?subject=");
    expect(out.html).toContain("https://imaginesurrey.ca/act/skytrain-south-surrey?ref=ABCD2345");
    expect(out.html).toContain("https://imaginesurrey.ca/?ref=ABCD2345#join");
    expect(out.html).toContain("/donate");
    const none = signatureEmail(ctx, { firstName: "Raj", campaign: { ...campaign, targetEmails: [] }, referralCode: "ABCD2345" });
    expect(none.html).not.toContain("mailto:mayor");
  });

  it("thanks donors per slate and upsells monthly only to one-time gifts", () => {
    const once = donationThanksEmail(ctx, { firstName: "Asha", frequency: "one_time", amounts: { council: 5000, school_board: 2500 } });
    expect(once.html).toContain("$50 to the city council slate and $25 to the school board slate");
    expect(once.html).toContain("/donate?frequency=monthly");
    expect(once.html).toContain("aren't tax deductible");
    const monthly = donationThanksEmail(ctx, { firstName: "Asha", frequency: "monthly", amounts: { council: 11900 } });
    expect(monthly.html).toContain("$119 a month");
    expect(monthly.html).not.toContain("frequency=monthly");
    expect(monthly.html).toContain("mailto:hello@imaginesurrey.ca");
  });

  it("welcomes members with the expiry, the portal, a referral link and a texts invitation", () => {
    const out = membershipWelcomeEmail(ctx, { firstName: "Asha", expiresAt: new Date("2027-11-02T20:00:00Z"), votingEligible: false, referralCode: "ABCD2345" });
    expect(out.subject).toBe("Welcome to Imagine Surrey, Asha!");
    expect(out.html).toContain("November 2, 2027");
    expect(out.html).toContain("https://imaginesurrey.ca/me");
    expect(out.html).toContain("ref=ABCD2345");
    expect(out.html).toContain("outside Surrey");
    expect(out.html).toContain("Reply STOP");
  });

  it("gives shifts a Pacific-time window and a calendar file", () => {
    const w = shiftWindow({ date: "2026-11-07", slot: "morning" });
    expect(w.start.toISOString()).toBe("2026-11-07T16:00:00.000Z"); // 9 a.m. on BC's permanent UTC-7
    expect(w.end.toISOString()).toBe("2026-11-07T19:00:00.000Z");
    const out = shiftConfirmationEmail(ctx, { firstName: "Priya", shift: { id: "s1", date: "2026-11-07", slot: "morning", title: "Door-knocking", location: "Newton", notes: null } });
    expect(out.attachments?.[0].filename).toBe("shift.ics");
    expect(out.html).toContain("Saturday, November 7");
  });

  it("tells followers about a promise and how to stop", () => {
    const out = promiseStatusEmail(ctx, { promise: { number: 3, title: "Build the pool" }, previous: "in_progress", next: "kept", note: "Opened today.", unfollowUrl: "https://imaginesurrey.ca/api/newsletter/unfollow?token=t" });
    expect(out.subject).toBe("Promise #3 is now kept");
    expect(out.html).toContain("https://imaginesurrey.ca/tracker#promise-3");
    expect(out.html).toContain("Opened today.");
    expect(out.text).toContain("Stop following this promise: https://imaginesurrey.ca/api/newsletter/unfollow?token=t");
  });
});

// ── Against a database ────────────────────────────────────────────────────
// Set TEST_DATABASE_URL (or DATABASE_URL to a database named *_e2e or *_test)
// to run these. They create and remove their own rows.
const dbUrl = process.env.TEST_DATABASE_URL ?? (process.env.DATABASE_URL && /(_e2e|_test)\b/.test(new URL(process.env.DATABASE_URL).pathname) ? process.env.DATABASE_URL : undefined);

describe.skipIf(!dbUrl)("with a database", () => {
  const client = postgres(dbUrl ?? "postgres://invalid", { max: 2, onnotice: () => {} });
  const db = drizzle(client, { schema });
  const run = randomBytes(4).toString("hex");
  const email = (name: string) => `${name}-${run}@comms-test.example`;
  const tag = `comms-test-${run}`;
  let personId = "";
  let eventId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl;
    process.env.NEXT_PUBLIC_SITE_URL ??= "http://localhost:3000";
    const [p] = await db
      .insert(schema.people)
      .values({ email: email("sukh"), firstName: "Sukh", lastName: "Gill", phone: "604-555-0199", neighbourhood: "Newton", contactConsentAt: new Date(), smsConsentAt: new Date(), tags: [tag] })
      .returning();
    personId = p.id;
    const [e] = await db
      .insert(schema.events)
      .values({ slug: `comms-test-${run}`, title: "Test town hall", startsAt: new Date(Date.now() + 10 * 86_400_000), location: "Newton Seniors Centre", summary: "A test." })
      .returning();
    eventId = e.id;
  });

  afterAll(async () => {
    await db.delete(schema.emailLog).where(like(schema.emailLog.to, `%-${run}@comms-test.example`));
    await db.delete(schema.emailLog).where(eq(schema.emailLog.personId, personId));
    await db.delete(schema.smsLog).where(eq(schema.smsLog.personId, personId));
    await db.delete(schema.emailCampaigns).where(like(schema.emailCampaigns.subject, `%${run}%`));
    await db.delete(schema.newsletterSubscribers).where(like(schema.newsletterSubscribers.email, `%-${run}@comms-test.example`));
    await db.delete(schema.consentEvents).where(like(schema.consentEvents.email, `%-${run}@comms-test.example`));
    await db.delete(schema.events).where(eq(schema.events.id, eventId));
    await db.delete(schema.shifts).where(eq(schema.shifts.personId, personId));
    await db.delete(schema.people).where(like(schema.people.email, `%-${run}@comms-test.example`));
    await client.end();
  });

  it("subscribes at once without an email key, and never flips an unsubscribed address back", async () => {
    const { subscribe, unsubscribeByToken } = await import("@/lib/server/newsletter");
    expect(await subscribe(db, email("news"), "home")).toBe("subscribed");
    const row = await db.query.newsletterSubscribers.findFirst({ where: eq(schema.newsletterSubscribers.email, email("news")) });
    expect(row?.status).toBe("subscribed");
    expect(row?.confirmedAt).toBeTruthy();
    expect(await subscribe(db, email("news"), "again")).toBe("subscribed");
    expect(await unsubscribeByToken(db, row!.unsubscribeToken)).toBe(true);
    expect(await subscribe(db, email("news"), "home")).toBe("unsubscribed");
    expect((await db.query.newsletterSubscribers.findFirst({ where: eq(schema.newsletterSubscribers.email, email("news")) }))?.status).toBe("unsubscribed");
  });

  it("confirms a pending address once, records consent, and honours only links sent after an unsubscribe", async () => {
    const { confirmSubscription, unsubscribeByToken } = await import("@/lib/server/newsletter");
    const { createToken } = await import("@/lib/server/tokens");
    const [p] = await db.insert(schema.people).values({ email: email("confirm") }).returning();
    await db.insert(schema.newsletterSubscribers).values({ email: email("confirm"), personId: p.id, status: "pending", source: "test", unsubscribeToken: `tok-confirm-${run}` }); // a pending row
    const raw = await createToken(db, "newsletter-confirm", email("confirm"), { ttlMinutes: 60, data: { personId: p.id, source: "test", issuedAt: new Date().toISOString() } });
    expect(await confirmSubscription(db, raw)).toBe("subscribed");
    expect(await confirmSubscription(db, raw)).toBe("invalid"); // used
    const row = await db.query.newsletterSubscribers.findFirst({ where: eq(schema.newsletterSubscribers.email, email("confirm")) });
    expect(row?.status).toBe("subscribed");
    expect(row?.confirmedAt).toBeTruthy();
    expect((await db.query.people.findFirst({ where: eq(schema.people.id, p.id) }))?.contactConsentAt).toBeTruthy();
    const grants = await db.select().from(schema.consentEvents).where(and(eq(schema.consentEvents.personId, p.id), eq(schema.consentEvents.action, "grant")));
    expect(grants.map((g) => [g.channel, g.purpose, g.source])).toEqual([["email", "newsletter", "newsletter-confirm"]]);

    // A link sent before the unsubscribe changes nothing.
    const stale = await createToken(db, "newsletter-confirm", email("confirm"), { ttlMinutes: 60, data: { issuedAt: new Date(Date.now() - 60_000).toISOString() } });
    expect(await unsubscribeByToken(db, row!.unsubscribeToken)).toBe(true);
    expect((await db.query.people.findFirst({ where: eq(schema.people.id, p.id) }))?.contactConsentAt).toBeNull();
    const [withdrawal] = await db.select().from(schema.consentEvents).where(and(eq(schema.consentEvents.personId, p.id), eq(schema.consentEvents.action, "withdraw")));
    expect([withdrawal?.channel, withdrawal?.purpose, withdrawal?.source]).toEqual(["email", "updates", "unsubscribe"]);
    expect(await confirmSubscription(db, stale)).toBe("unsubscribed");
    expect((await db.query.newsletterSubscribers.findFirst({ where: eq(schema.newsletterSubscribers.email, email("confirm")) }))?.status).toBe("unsubscribed");

    // A link sent after it (the person asked again) is their own click back.
    const fresh = await createToken(db, "newsletter-confirm", email("confirm"), { ttlMinutes: 60, data: { issuedAt: new Date(Date.now() + 1000).toISOString() } });
    expect(await confirmSubscription(db, fresh)).toBe("subscribed");
    expect((await db.query.newsletterSubscribers.findFirst({ where: eq(schema.newsletterSubscribers.email, email("confirm")) }))?.status).toBe("subscribed");
    expect(await confirmSubscription(db, "not-a-token")).toBe("invalid");
  });

  it("with email configured: new addresses wait as pending, and an unsubscribed one stays unsubscribed until a fresh link is clicked", async () => {
    const { subscribe, unsubscribeByToken } = await import("@/lib/server/newsletter");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.RESEND_API_KEY = "re_test_key";
    try {
      expect(await subscribe(db, email("double"), "home")).toBe("pending");
      const row = await db.query.newsletterSubscribers.findFirst({ where: eq(schema.newsletterSubscribers.email, email("double")) });
      expect(row?.status).toBe("pending");
      expect((await db.query.people.findFirst({ where: eq(schema.people.email, email("double")) }))?.contactConsentAt).toBeNull();
      const sent = await db.select().from(schema.emailLog).where(and(eq(schema.emailLog.to, email("double")), eq(schema.emailLog.kind, "newsletter-confirm")));
      expect(sent).toHaveLength(1);
      expect(sent[0].html).toContain("/api/newsletter/confirm?token=");

      expect(await unsubscribeByToken(db, row!.unsubscribeToken)).toBe(true);
      expect(await subscribe(db, email("double"), "petition:test")).toBe("pending");
      expect((await db.query.newsletterSubscribers.findFirst({ where: eq(schema.newsletterSubscribers.email, email("double")) }))?.status).toBe("unsubscribed");
      expect(await db.select().from(schema.emailLog).where(and(eq(schema.emailLog.to, email("double")), eq(schema.emailLog.kind, "newsletter-confirm")))).toHaveLength(2);
    } finally {
      delete process.env.RESEND_API_KEY;
      vi.unstubAllGlobals();
    }
  });

  it("records contact consent on single opt-in", async () => {
    const { subscribe } = await import("@/lib/server/newsletter");
    expect(await subscribe(db, email("single"), "home", undefined, { ip: "203.0.113.9" })).toBe("subscribed");
    const [grant] = await db.select().from(schema.consentEvents).where(eq(schema.consentEvents.email, email("single")));
    expect([grant?.purpose, grant?.action, grant?.source, grant?.ip]).toEqual(["newsletter", "grant", "newsletter:home", "203.0.113.9"]);
    expect((await db.query.people.findFirst({ where: eq(schema.people.email, email("single")) }))?.contactConsentAt).toBeTruthy();
  });

  it("sends transactional emails without an unsubscribe link, and promise updates only to confirmed followers", async () => {
    const { notifyMembershipActive, notifyPromiseStatusChanged } = await import("@/lib/server/notifications");
    const [m] = await db.insert(schema.memberships).values({ personId, status: "active", feeCents: 1000, votingEligible: true, startsAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000) }).returning();
    await notifyMembershipActive(db, { membershipId: m.id });
    const [welcome] = await db.select().from(schema.emailLog).where(and(eq(schema.emailLog.personId, personId), eq(schema.emailLog.kind, "membership-welcome")));
    expect(welcome?.html).toContain("/me");
    expect(welcome?.html).not.toContain("Unsubscribe</a>");
    await db.delete(schema.emailLog).where(eq(schema.emailLog.id, welcome.id));
    await db.delete(schema.memberships).where(eq(schema.memberships.id, m.id));

    const [promise] = await db.insert(schema.trackerPromises).values({ number: 9000 + Math.floor(Math.random() * 999), title: `Test promise ${run}`, area: "Test" }).returning();
    await db.insert(schema.promiseFollows).values([
      { promiseId: promise.id, email: email("follower"), token: `f1-${run}`, confirmedAt: new Date() },
      { promiseId: promise.id, email: email("unconfirmed"), token: `f2-${run}` },
    ]);
    await notifyPromiseStatusChanged(db, { promiseId: promise.id, previous: "not_started", next: "kept" });
    const rows = await db.select().from(schema.emailLog).where(eq(schema.emailLog.kind, "promise-update"));
    const mine = rows.filter((r) => r.to.endsWith(`-${run}@comms-test.example`));
    expect(mine.map((r) => r.to)).toEqual([email("follower")]);
    expect(mine[0].html).toContain(`/api/newsletter/unfollow?token=f1-${run}`);
    expect(mine[0].html).toContain(`/tracker#promise-${promise.number}`);
    await db.delete(schema.trackerPromises).where(eq(schema.trackerPromises.id, promise.id));
  });

  it("notifyRsvp logs an RSVP email with the calendar file noted", async () => {
    const { notifyRsvp } = await import("@/lib/server/notifications");
    const [rsvp] = await db.insert(schema.eventRsvps).values({ eventId, personId, name: "Sukh Gill", email: email("sukh"), guests: 1 }).returning();
    await notifyRsvp(db, { rsvpId: rsvp.id });
    const [log] = await db.select().from(schema.emailLog).where(and(eq(schema.emailLog.personId, personId), eq(schema.emailLog.kind, "rsvp")));
    expect(log).toBeTruthy();
    expect(log.status).toBe("skipped");
    expect(log.subject).toBe("You're in: Test town hall");
    expect(log.text).toContain(`Attachments: comms-test-${run}.ics`);
    expect(log.html).toContain("calendar.google.com");
    expect((await db.query.people.findFirst({ where: eq(schema.people.id, personId) }))?.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    await notifyRsvp(db, { rsvpId: "00000000-0000-0000-0000-000000000000" }); // unknown ids never throw
  });

  it("sends day-before reminders once, by email and text, for RSVPs and shifts", async () => {
    const { sendReminders } = await import("@/lib/server/comms");
    const { addDays, todayInSurrey } = await import("@/lib/shifts");
    await db.update(schema.events).set({ startsAt: new Date(Date.now() + 24 * 3600_000) }).where(eq(schema.events.id, eventId));
    await db.insert(schema.shifts).values({ personId, date: addDays(todayInSurrey(), 1), slot: "evening", status: "confirmed" });
    const first = await sendReminders(db);
    expect(first.events).toBe(1);
    expect(first.shifts).toBe(1);
    expect(first.texts).toBe(2);
    const rsvp = await db.query.eventRsvps.findFirst({ where: eq(schema.eventRsvps.personId, personId) });
    expect(rsvp?.reminderSentAt).toBeTruthy();
    const kinds = (await db.select({ kind: schema.emailLog.kind }).from(schema.emailLog).where(eq(schema.emailLog.personId, personId))).map((r) => r.kind).sort();
    expect(kinds).toEqual(["event-reminder", "rsvp", "shift-reminder"]);
    const texts = await db.select().from(schema.smsLog).where(eq(schema.smsLog.personId, personId));
    expect(texts.map((t) => t.kind).sort()).toEqual(["event-reminder", "shift-reminder"]);
    expect(texts.every((t) => t.body.endsWith(STOP_LINE) && t.status === "skipped")).toBe(true);
    const second = await sendReminders(db);
    expect(second.events + second.shifts).toBe(0);
  });

  it("handles STOP, START and language keywords by phone number", async () => {
    const { handleInboundSms } = await import("@/lib/server/comms");
    const stop = await handleInboundSms(db, ctx, { from: "+1 (604) 555-0199", body: "Stop" });
    expect(stop.intent.kind).toBe("stop");
    expect((await db.query.people.findFirst({ where: eq(schema.people.id, personId) }))?.smsConsentAt).toBeNull();
    await handleInboundSms(db, ctx, { from: "+16045550199", body: "START" });
    expect((await db.query.people.findFirst({ where: eq(schema.people.id, personId) }))?.smsConsentAt).toBeTruthy();
    const lang = await handleInboundSms(db, ctx, { from: "6045550199", body: "punjabi" });
    expect(lang.reply).toContain("Punjabi");
    expect((await db.query.people.findFirst({ where: eq(schema.people.id, personId) }))?.locale).toBe("pa");
    const help = await handleInboundSms(db, { ...ctx, orgPhone: "604-555-1234" }, { from: "+16045550199", body: "help" });
    expect(help.reply).toContain(ctx.orgEmail);
    expect(help.reply).toContain("604-555-1234");
    const inbound = await db.select().from(schema.smsLog).where(and(eq(schema.smsLog.personId, personId), like(schema.smsLog.kind, "inbound-%")));
    expect(inbound.map((r) => r.kind).sort()).toEqual(["inbound-help", "inbound-language", "inbound-start", "inbound-stop"]);
  });
});
