import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGateway } from "@base-air/ai";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, SecretBox, BaseAir } from "@base-air/core";
import type { DbHandle } from "@base-air/db";
import { createTestDb } from "@base-air/db/test";
import { runScout } from "../src/index.ts";

let h: DbHandle;
let m: BaseAir;
let wsId: string;
const now = () => new Date("2026-11-02T18:00:00Z");

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now });
  wsId = (await m.workspaces.create({ slug: "acme", name: "Acme Outdoor", timezone: "UTC", profile: { description: "outdoor gear" } }, { type: "human", id: "u1" })).id;
  await m.trends.createTopic({ workspaceId: wsId, name: "Microspikes vs. crampons", keywords: ["microspikes"] });
});
afterAll(() => h.close());

describe("scout", () => {
  it("does nothing without signals", async () => {
    const gw = new FakeGateway({});
    const s = await runScout(m, gw, wsId);
    expect(s.signals).toBe(0);
    expect(gw.calls).toHaveLength(0);
  });

  it("turns trending terms into relevant, new topics only, and records why", async () => {
    await m.sources.pull([
      {
        name: "google_trends_rss",
        configured: true,
        granularityMs: 3_600_000,
        async trending(req) {
          return [
            { term: "first snow vancouver", value: 20000, url: null, observedAt: req.now.toISOString(), region: "US", context: ["Snow on the North Shore"] },
            { term: "microspikes", value: 2000, url: null, observedAt: req.now.toISOString(), region: "US" },
            { term: "celebrity wedding", value: 900000, url: null, observedAt: req.now.toISOString(), region: "US" },
          ];
        },
      },
    ]);
    const gw = new FakeGateway({
      clusterSignals: () => ({
        topics: [
          { name: "First snow in Vancouver", keywords: ["first snow vancouver", "north shore snow"], relevance: 0.92, why: "trail conditions are core" },
          { name: "Winter traction", keywords: ["microspikes"], relevance: 0.9, why: "already a topic" },
          { name: "Celebrity wedding", keywords: ["celebrity wedding"], relevance: 0.05, why: "off brand" },
        ],
      }),
    });
    const s = await runScout(m, gw, wsId);
    expect(s.signals).toBe(3);
    expect(s.created.map((c) => c.name)).toEqual(["First snow in Vancouver"]);
    expect(s.skipped.map((x) => x.reason)).toEqual(["already tracked", "relevance 0.05 below 0.6"]);
    expect(gw.calls[0]!.user).toContain("first snow vancouver — Snow on the North Shore [google_trends_rss]");
    const created = await m.events.list({ workspaceId: wsId, types: ["trend.topic_created"] });
    expect(created[0]).toMatchObject({ actor: { type: "operator", id: "scout" }, data: { why: "trail conditions are core" } });
    const runs = await m.ops.runs(wsId);
    expect(runs[0]).toMatchObject({ operator: "scout", status: "succeeded" });
  });
});
