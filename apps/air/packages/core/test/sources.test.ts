import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import type { SourceAdapter } from "@base-air/sources";
import { InMemoryScheduler, SecretBox, BaseAir, type Principal } from "../src/index.ts";

let h: DbHandle;
let m: BaseAir;
let clock = Date.parse("2026-11-02T18:30:00Z");
const now = () => new Date(clock);
const H = 3_600_000;
let owner: Principal;
let topicId: string;

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
  topicId = (await m.trends.createTopic({ workspaceId: ws.id, name: "First snow", keywords: ["first snow", "microspikes"] })).id;
});
afterAll(() => h.close());

function sampler(calls: { keywords: string[]; since: Date }[]): SourceAdapter {
  return {
    name: "hacker_news",
    configured: true,
    granularityMs: H,
    async sample(req) {
      calls.push({ keywords: req.keywords, since: req.since });
      return [1, 2, 3].map((i) => ({ observedAt: new Date(req.now.getTime() - (4 - i) * H).toISOString(), value: i * 10 }));
    },
  };
}

describe("sources", () => {
  it("samples every topic, respects granularity, stores trending raw, and survives a failing source", async () => {
    const calls: { keywords: string[]; since: Date }[] = [];
    const trending: SourceAdapter = {
      name: "google_trends_rss",
      configured: true,
      granularityMs: H,
      async trending(req) {
        return [{ term: "first snow", value: 20000, url: null, observedAt: req.now.toISOString(), region: "US", context: ["Snow hits"] }];
      },
    };
    const broken: SourceAdapter = { name: "wikipedia_pageviews", configured: true, granularityMs: H, async sample() { throw new Error("HTTP 503"); } };
    const unconfigured: SourceAdapter = { name: "youtube_trending", configured: false, granularityMs: H, async trending() { throw new Error("must not be called"); } };

    const r1 = await m.sources.pull([sampler(calls), trending, broken, unconfigured]);
    expect(r1.find((r) => r.source === "hacker_news")).toMatchObject({ topics: 1, points: 3, error: null });
    expect(r1.find((r) => r.source === "google_trends_rss")).toMatchObject({ trending: 1 });
    expect(r1.find((r) => r.source === "wikipedia_pageviews")?.error).toMatch(/503/);
    expect(r1.find((r) => r.source === "youtube_trending")).toBeUndefined();
    expect(calls[0]!.keywords).toEqual(["first snow", "microspikes"]);
    expect(now().getTime() - calls[0]!.since.getTime()).toBe(7 * 24 * H);

    // within granularity of the last point: skipped; an hour later: resumes from the last point
    await m.sources.pull([sampler(calls)]);
    expect(calls).toHaveLength(1);
    clock += 2 * H;
    await m.sources.pull([sampler(calls)]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.since.toISOString()).toBe(new Date(clock - 2 * H - H).toISOString());

    const disc = await m.sources.discoveries();
    expect(disc[0]).toMatchObject({ term: "first snow", source: "google_trends_rss", context: ["Snow hits"] });
    // the same item in the same hour is stored once
    await m.sources.pull([trending]);
    expect((await m.sources.discoveries()).filter((d) => d.term === "first snow")).toHaveLength(1);

    const status = await m.sources.status([sampler([]), trending, broken, unconfigured]);
    expect(status.find((s) => s.name === "hacker_news")).toMatchObject({ kind: "sample", configured: true, lastError: null });
    expect(status.find((s) => s.name === "hacker_news")!.pointsLast24h).toBeGreaterThan(0);
    expect(status.find((s) => s.name === "wikipedia_pageviews")!.lastError).toMatch(/503/);
    expect(status.find((s) => s.name === "youtube_trending")).toMatchObject({ configured: false, lastRunAt: null });
    expect(status.find((s) => s.name === "own_feed")).toMatchObject({ configured: true });
  });

  it("counts the brand's own feed per complete hour, zeros included, keywords matched safely", async () => {
    const base = Math.floor(clock / H) * H;
    const item = (id: string, text: string, hoursAgo: number, kind = "mention") => ({ network: "x", kind, externalId: id, authorHandle: "a", authorName: null, text, url: null, parentExternalId: null, occurredAt: new Date(base - hoursAgo * H + 60_000).toISOString(), raw: {} });
    await m.listening.ingestItems(owner.workspaceId, null, [
      item("f1", "first snow on the shore", 3),
      item("f2", "need MICROSPIKES now", 3),
      item("f3", "unrelated", 2),
      item("f4", "first snow again", 1),
      item("f5", "our own first snow post", 1, "own_post"),
      item("f6", "100% first snow", 1),
    ]);
    const res = await m.sources.pull([]);
    expect(res.find((r) => r.source === "own_feed")).toMatchObject({ topics: 1, error: null });
    const pts = (await m.trends.points(topicId, new Date(base - 4 * H))).filter((p) => p.source === "own_feed");
    const byHour = Object.fromEntries(pts.map((p) => [(base - p.observedAt.getTime()) / H, p.value]));
    expect(byHour[3]).toBe(2);
    expect(byHour[2]).toBe(0);
    expect(byHour[1]).toBe(2); // own posts excluded
  });

  it("keyword patterns cannot inject SQL", async () => {
    const t = await m.trends.createTopic({ workspaceId: owner.workspaceId, name: "Quote", keywords: ["it's'); DROP TABLE activities; --", "50%_off"] });
    const res = await m.sources.pull([]);
    expect(res.find((r) => r.source === "own_feed")?.error).toBeNull();
    expect((await m.listening.feed(owner.workspaceId)).length).toBeGreaterThan(0);
    expect(t.id).toMatch(/^top_/);
  });
});

describe("calendar and brand context", () => {
  it("returns committed posts in the window by publish-or-schedule time", async () => {
    const acc = (await m.accounts.connect(owner, { network: "bluesky", externalId: "did:1", handle: "acme.bsky.social", connector: "mock" })).id;
    const at = (h: number) => new Date(clock + h * H).toISOString();
    const a = await m.posts.create(owner, { body: "a", variants: [{ socialAccountId: acc, text: "a" }], scheduledAt: at(5) });
    const b = await m.posts.create(owner, { body: "b", variants: [{ socialAccountId: acc, text: "b" }], scheduledAt: at(2) });
    await m.posts.create(owner, { body: "draft", variants: [{ socialAccountId: acc, text: "draft" }] });
    await m.posts.create(owner, { body: "far", variants: [{ socialAccountId: acc, text: "far" }], scheduledAt: at(24 * 30) });
    const cal = await m.posts.calendar(owner.workspaceId, now(), new Date(clock + 7 * 24 * H));
    expect(cal.map((c) => c.post.id)).toEqual([b.post.id, a.post.id]);
    expect(cal[0]!.variants).toHaveLength(1);

    const ctx = await m.brand.context(owner.workspaceId);
    expect(ctx.workspace.name).toBe("Acme");
    expect(ctx.networks).toEqual(["bluesky"]);
  });
});
