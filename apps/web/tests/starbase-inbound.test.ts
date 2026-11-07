// Withdrawals made in Starbase, applied here (POST /api/in/consent): the key
// check, the body Starbase may send, and phone matching. The database part
// is covered end to end in e2e/desk.e2e.mjs.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { bearerMatches, inboundConsentSchema, phoneDigits, schemaError } = await import("@/lib/server/starbase-inbound");

const KEY = "sbin_0123456789abcdefghijklmnopqrstuv";

describe("the inbound key", () => {
  it("accepts only Authorization: Bearer <the key>", () => {
    expect(bearerMatches(`Bearer ${KEY}`, KEY)).toBe(true);
    expect(bearerMatches(`bearer ${KEY}`, KEY)).toBe(true);
    expect(bearerMatches(`Bearer ${KEY}x`, KEY)).toBe(false);
    expect(bearerMatches(`Bearer ${KEY.slice(0, -1)}`, KEY)).toBe(false);
    expect(bearerMatches(KEY, KEY)).toBe(false);
    expect(bearerMatches("Basic abc", KEY)).toBe(false);
    expect(bearerMatches(null, KEY)).toBe(false);
  });

  it("refuses everything when no key is configured", () => {
    expect(bearerMatches("Bearer ", undefined)).toBe(false);
    expect(bearerMatches("Bearer anything", "")).toBe(false);
    expect(bearerMatches(undefined, undefined)).toBe(false);
  });
});

describe("the body Starbase sends", () => {
  const at = "2026-11-07T10:30:00-08:00";

  it("takes { email?, phone?, channel, action, reason, at }", () => {
    const ok = inboundConsentSchema.safeParse({ email: " Pat@Example.com ", channel: "email", action: "withdraw", reason: "unsubscribe", at });
    expect(ok.success && ok.data).toEqual({ email: "pat@example.com", channel: "email", action: "withdraw", reason: "unsubscribe", at });
    expect(inboundConsentSchema.safeParse({ phone: "+16045550101", channel: "sms", action: "withdraw", reason: "stop", at: "2026-11-07T18:30:00Z" }).success).toBe(true);
    // A grant is a valid body (it is answered, not applied).
    expect(inboundConsentSchema.safeParse({ email: "a@b.ca", channel: "email", action: "grant", reason: "preference", at }).success).toBe(true);
  });

  it("refuses anything else, naming the field", () => {
    const bad = (body: unknown) => {
      const r = inboundConsentSchema.safeParse(body);
      return r.success ? null : schemaError(r.error);
    };
    expect(bad({ channel: "email", action: "withdraw", reason: "unsubscribe", at })).toMatch(/email or a phone/);
    expect(bad({ email: "a@b.ca", channel: "fax", action: "withdraw", reason: "unsubscribe", at })).toMatch(/^channel: /);
    expect(bad({ email: "a@b.ca", channel: "email", action: "delete", reason: "unsubscribe", at })).toMatch(/^action: /);
    expect(bad({ email: "a@b.ca", channel: "email", action: "withdraw", reason: "whim", at })).toMatch(/^reason: /);
    expect(bad({ email: "a@b.ca", channel: "email", action: "withdraw", reason: "stop", at: "yesterday" })).toMatch(/^at: /);
    expect(bad({ email: "not-an-email", channel: "email", action: "withdraw", reason: "stop", at })).toMatch(/^email: /);
    expect(bad({ email: "a@b.ca", channel: "email", action: "withdraw", reason: "stop", at, rating: 5 })).toMatch(/rating/);
  });
});

describe("matching a phone", () => {
  it("reads the ten digits of any Canadian format", () => {
    expect(phoneDigits("+1 (604) 555-0101")).toBe("6045550101");
    expect(phoneDigits("604.555.0101")).toBe("6045550101");
    expect(phoneDigits("16045550101")).toBe("6045550101");
    expect(phoneDigits("555-0101")).toBeNull();
    expect(phoneDigits(null)).toBeNull();
  });
});
