import { describe, expect, it, vi } from "vitest";
import { BlueskyConnector, IdempotencyCache, MockConnector, XConnector, ZernioConnector, createDefaultRegistry } from "../src/index.ts";

describe("createDefaultRegistry", () => {
  it("always registers the native adapters and the mock, and resolves real adapters before the mock", () => {
    const reg = createDefaultRegistry({});
    expect(reg.list().map((c) => c.name)).toEqual(["bluesky", "x", "mock"]);
    expect(reg.get("bluesky")).toBeInstanceOf(BlueskyConnector);
    expect(reg.get("x")).toBeInstanceOf(XConnector);
    expect(reg.get("mock")).toBeInstanceOf(MockConnector);
    expect(reg.get("zernio")).toBeUndefined();
    // Unknown connector name: the real adapter for the network wins; networks nobody serves fall to the mock.
    expect(reg.resolve("legacy", "x").name).toBe("x");
    expect(reg.resolve("legacy", "bluesky").name).toBe("bluesky");
    expect(reg.resolve("legacy", "tiktok").name).toBe("mock");
    expect(reg.resolve("mock", "x").name).toBe("mock");
  });

  it("adds Zernio only when ZERNIO_API_KEY is set", () => {
    const reg = createDefaultRegistry({ ZERNIO_API_KEY: "zk", X_CLIENT_ID: "cid", X_CLIENT_SECRET: "sec" });
    expect(reg.list().map((c) => c.name)).toEqual(["bluesky", "x", "zernio", "mock"]);
    expect(reg.get("zernio")).toBeInstanceOf(ZernioConnector);
    expect(reg.resolve("legacy", "tiktok").name).toBe("zernio");
    expect(reg.get("x")?.capabilities("x")).toMatchObject({ meteredReads: true });
    expect(reg.get("zernio")?.capabilities("tiktok")).toMatchObject({ meteredReads: false });
  });
});

describe("IdempotencyCache", () => {
  it("runs work once per key, coalesces concurrent calls and forgets failures", async () => {
    const cache = new IdempotencyCache<string>();
    const work = vi.fn(async () => "r1");
    const [a, b] = await Promise.all([cache.run("k", work), cache.run("k", work)]);
    expect(a).toBe("r1");
    expect(b).toBe("r1");
    expect(await cache.run("k", work)).toBe("r1");
    expect(work).toHaveBeenCalledTimes(1);
    expect(cache.peek("k")).toBe("r1");

    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(cache.run("f", failing)).rejects.toThrow("boom");
    expect(cache.peek("f")).toBeUndefined();
    await expect(cache.run("f", failing)).rejects.toThrow("boom");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry past maxEntries", async () => {
    const cache = new IdempotencyCache<number>(2);
    await cache.run("a", async () => 1);
    await cache.run("b", async () => 2);
    await cache.run("c", async () => 3);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBe(2);
    expect(cache.peek("c")).toBe(3);
  });
});
