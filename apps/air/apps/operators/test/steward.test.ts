import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGateway, defaultFakeHandlers, type ClassifyTopicVars } from "@base-air/ai";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox, type Principal } from "@base-air/core";
import type { DbHandle } from "@base-air/db";
import { createTestDb } from "@base-air/db/test";
import type { RedLine } from "@base-air/schema";
import { makeClassifier, stewardClassifier } from "../src/index.ts";

const politics: RedLine = { id: "t1", kind: "forbidden_topic", description: "No politics", severity: "block", keywords: ["ballot"], semantic: true };

/** A fake Steward judgment: "polling station" is about the ballot even though the keyword is absent. */
function semanticGateway() {
  const gw = new FakeGateway(defaultFakeHandlers());
  gw.on("classifyTopic", (vars) => {
    const v = vars as ClassifyTopicVars;
    return v.text.toLowerCase().includes("polling station") ? { likelihood: 0.95, reason: "polling station implies the election" } : { likelihood: 0.02, reason: "unrelated" };
  });
  return gw;
}

describe("stewardClassifier", () => {
  it("returns 0 on a cold cache, fills asynchronously, then answers from the cache", async () => {
    const gw = semanticGateway();
    const s = stewardClassifier(gw);
    expect(s.classify("Lines at the polling station this morning", politics.keywords, politics.description)).toBe(0);
    expect(s.inflight).toBe(1);
    // the same text asked twice while in flight schedules one model call
    expect(s.classify("Lines at the polling station this morning", politics.keywords, politics.description)).toBe(0);
    await s.settle();
    expect(s.inflight).toBe(0);
    expect(s.size).toBe(1);
    expect(gw.callsFor("classifyTopic")).toHaveLength(1);
    expect(s.classify("Lines at the polling station this morning", politics.keywords, politics.description)).toBe(0.95);
    expect(gw.callsFor("classifyTopic")[0]!.effort).toBe("low");
  });

  it("prime() fills the cache against every semantic red line so the first evaluation is informed", async () => {
    const gw = semanticGateway();
    const s = stewardClassifier(gw);
    const keywordOnly: RedLine = { id: "t2", kind: "forbidden_topic", description: "No crypto", severity: "block", keywords: ["bitcoin"], semantic: false };
    await s.prime(["Lines at the polling station this morning", "Our Friday notes"], [politics, keywordOnly]);
    expect(gw.callsFor("classifyTopic")).toHaveLength(2); // two texts x one semantic line; the keyword-only line is skipped
    expect(s.classify("Lines at the polling station this morning", politics.keywords, politics.description)).toBe(0.95);
    expect(s.classify("Our Friday notes", politics.keywords, politics.description)).toBe(0.02);
    expect(s.inflight).toBe(0);
  });

  it("swallows gateway failures (reporting them) and clamps scores into 0..1", async () => {
    const errors: string[] = [];
    const failing = new FakeGateway({ classifyTopic: () => ({ likelihood: 0.5, reason: "r" }) });
    const s = stewardClassifier(failing, { onError: (e) => errors.push(e.message) });
    failing.on("classifyTopic", () => {
      throw new Error("boom");
    });
    expect(s.classify("x", ["k"], "d")).toBe(0);
    await s.settle();
    expect(errors).toEqual(["boom"]);
    expect(s.size).toBe(0);
    expect(typeof makeClassifier(failing)).toBe("function");
  });
});

describe("Steward wired into the gate", () => {
  let h: DbHandle;
  let m: BaseAir;
  let owner: Principal;
  let acct: string;
  const gw = semanticGateway();
  const steward = stewardClassifier(gw);

  beforeAll(async () => {
    h = await createTestDb();
    m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), classifyTopic: steward.classify });
    const ws = await m.workspaces.create({ slug: "civic", name: "Civic", timezone: "UTC" }, { type: "human", id: "u" });
    owner = { workspaceId: ws.id, actor: { type: "human", id: "u" }, role: "owner" };
    acct = (await m.accounts.connect(owner, { network: "x", externalId: "1", handle: "civic", connector: "mock" })).id;
    await m.policy.update(owner, { autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" }, redLines: [politics], timezone: "UTC" });
  });
  afterAll(() => h.close());

  it("a semantic red line misses on the first, cold evaluation and fires once the text is primed", async () => {
    const text = "Lines at the polling station this morning";
    const cold = await m.posts.create(owner, { body: text, variants: [{ socialAccountId: acct, text }] });
    expect(cold.post.status).toBe("draft"); // documented caveat: the cache was cold, the gate saw 0
    await steward.settle();
    const warm = await m.posts.create(owner, { body: text, variants: [{ socialAccountId: acct, text }] });
    expect(warm.post.status).toBe("blocked");
    expect((warm.post.policyDecision as { violations: { redLineId: string; message: string }[] }).violations[0]).toMatchObject({ redLineId: "t1" });

    const primed = "Polling station turnout looked high";
    await steward.prime([primed], [politics]);
    const first = await m.posts.create(owner, { body: primed, variants: [{ socialAccountId: acct, text: primed }] });
    expect(first.post.status).toBe("blocked");
    const fine = await m.posts.create(owner, { body: "Our Friday notes", variants: [{ socialAccountId: acct, text: "Our Friday notes" }] });
    expect(fine.post.status).toBe("draft");
  });
});
