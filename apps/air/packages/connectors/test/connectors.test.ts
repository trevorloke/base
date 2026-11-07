import { describe, expect, it } from "vitest";
import { ConnectorRegistry, MockConnector, validateVariant, xWeightedLength, graphemeLength } from "../src/index.ts";

describe("validation", () => {
  it("counts X urls as 23 and CJK as 2", () => {
    expect(xWeightedLength("hi https://example.com/very/long/path/that/goes/on")).toBe(3 + 23);
    expect(xWeightedLength("日本")).toBe(4);
  });
  it("counts graphemes for Bluesky", () => {
    expect(graphemeLength("👩‍👩‍👧‍👦a")).toBe(2);
  });
  it("flags limits per network", () => {
    expect(validateVariant("x", "a".repeat(281), [], [])).toMatchObject([{ code: "too_long" }]);
    expect(validateVariant("instagram", "caption", [], [])).toMatchObject([{ code: "media_required" }]);
    expect(validateVariant("linkedin", "hi", [], ["more"])).toMatchObject([{ code: "thread_unsupported" }]);
    expect(validateVariant("bluesky", "", [], [])).toMatchObject([{ code: "empty" }]);
    expect(validateVariant("bluesky", "fine", [], [])).toEqual([]);
  });
});

describe("mock connector", () => {
  const acct = { id: "a1", workspaceId: "w", network: "bluesky" as const, externalId: "did:1", handle: "acme.bsky.social", auth: null, config: {} };

  it("publishes idempotently and grows metrics with age", async () => {
    const c = new MockConnector();
    let t = Date.parse("2026-11-02T00:00:00Z");
    c.now = () => new Date(t);
    const r1 = await c.publish(acct, { variantId: "v1", text: "hello", media: [], thread: [], idempotencyKey: "k1" });
    const r2 = await c.publish(acct, { variantId: "v1", text: "hello", media: [], thread: [], idempotencyKey: "k1" });
    expect(r1.externalId).toBe(r2.externalId);
    const m0 = await c.fetchMetrics(acct, [r1.externalId]);
    t += 24 * 3_600_000;
    const m1 = await c.fetchMetrics(acct, [r1.externalId]);
    const imp = (ms: typeof m0) => ms.find((m) => m.metric === "impressions")!.value;
    expect(imp(m1)).toBeGreaterThan(imp(m0));
  });

  it("injects failures and resolves via registry", async () => {
    const c = new MockConnector();
    c.failNext = { kind: "rate_limit", retryable: true };
    await expect(c.publish(acct, { variantId: "v", text: "x", media: [], thread: [], idempotencyKey: "k" })).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    const reg = new ConnectorRegistry().register(c);
    expect(reg.resolve("mock", "x").name).toBe("mock");
    expect(() => reg.resolve("missing", "tiktok")).toThrow(/not configured/);
  });
});
