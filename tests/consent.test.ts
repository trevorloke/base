import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

vi.mock("server-only", () => ({}));
const { grantAllowed, recordConsent } = await import("@/lib/server/consent");

describe("grantAllowed", () => {
  it("lets anyone grant when nothing was withdrawn", () => {
    expect(grantAllowed(undefined, false)).toBe(true);
    expect(grantAllowed(null, false)).toBe(true);
    expect(grantAllowed("grant", false)).toBe(true);
  });
  it("refuses an unverified grant after a withdrawal", () => {
    expect(grantAllowed("withdraw", false)).toBe(false);
  });
  it("lets a verified request reverse a withdrawal", () => {
    expect(grantAllowed("withdraw", true)).toBe(true);
  });
});

// Runs against a real, migrated database when TEST_DATABASE_URL names one
// whose name ends in _test or _e2e (e.g. the e2e database after a run).
const url = process.env.TEST_DATABASE_URL;
const usable = Boolean(url && /(_e2e|_test)$/.test(new URL(url).pathname));

describe.skipIf(!usable)("recordConsent (database)", () => {
  const client = usable ? postgres(url!, { max: 1, onnotice: () => {} }) : null;
  const db = client ? drizzle(client, { schema }) : null;
  const email = `consent-${Date.now()}@example.com`;
  let personId = "";

  beforeAll(async () => {
    const [p] = await db!.insert(schema.people).values({ email }).returning({ id: schema.people.id });
    personId = p.id;
    await db!.insert(schema.newsletterSubscribers).values({ email, personId, source: "test", unsubscribeToken: `tok-${Date.now()}` });
  });
  afterAll(async () => {
    await db!.delete(schema.consentEvents).where(eq(schema.consentEvents.email, email));
    await db!.delete(schema.newsletterSubscribers).where(eq(schema.newsletterSubscribers.email, email));
    await db!.delete(schema.people).where(eq(schema.people.id, personId));
    await client!.end();
  });

  const person = async () => (await db!.select().from(schema.people).where(eq(schema.people.id, personId)))[0];
  const events = async () => db!.select().from(schema.consentEvents).where(eq(schema.consentEvents.personId, personId));
  const base = { email, channel: "email" as const, purpose: "updates" as const, source: "test" };

  it("grants and sets contactConsentAt", async () => {
    expect(await recordConsent(db!, { ...base, personId, action: "grant" })).toBe(true);
    expect((await person()).contactConsentAt).not.toBeNull();
    expect(await events()).toHaveLength(1);
  });

  it("an updates withdrawal clears the column and unsubscribes the newsletter row", async () => {
    expect(await recordConsent(db!, { ...base, personId, action: "withdraw" })).toBe(true);
    expect((await person()).contactConsentAt).toBeNull();
    const [sub] = await db!.select().from(schema.newsletterSubscribers).where(eq(schema.newsletterSubscribers.email, email));
    expect(sub.status).toBe("unsubscribed");
    expect(sub.unsubscribedAt).not.toBeNull();
  });

  it("an unverified grant after a withdrawal writes nothing", async () => {
    expect(await recordConsent(db!, { ...base, personId, action: "grant" })).toBe(false);
    expect((await person()).contactConsentAt).toBeNull();
    expect(await events()).toHaveLength(2);
  });

  it("an unverified grant by email alone is refused the same way", async () => {
    expect(await recordConsent(db!, { ...base, email: email.toUpperCase(), personId: null, action: "grant" })).toBe(false);
  });

  it("a verified grant reverses the withdrawal", async () => {
    expect(await recordConsent(db!, { ...base, personId, action: "grant", verified: true })).toBe(true);
    expect((await person()).contactConsentAt).not.toBeNull();
    expect(await events()).toHaveLength(3);
  });

  it("applies the same rule to texts", async () => {
    const sms = { email, personId, channel: "sms" as const, purpose: "sms" as const };
    expect(await recordConsent(db!, { ...sms, action: "withdraw" })).toBe(true);
    expect(await recordConsent(db!, { ...sms, action: "grant" })).toBe(false);
    expect((await person()).smsConsentAt).toBeNull();
    expect(await recordConsent(db!, { ...sms, action: "grant", verified: true })).toBe(true);
    expect((await person()).smsConsentAt).not.toBeNull();
  });
});
