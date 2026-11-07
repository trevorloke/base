import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@starsign/db/test";
import { posts, postVariants, socialAccounts, workspaces, type DbHandle } from "@starsign/db";
import { ApprovalDiffs, EventStore, OutcomeScheduler, hashPayload } from "../src/index.ts";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await h.db.insert(workspaces).values({ id: "w1", slug: "acme", name: "Acme" });
});
afterAll(() => h.close());

const actor = { type: "system" as const, id: "test" };

describe("event store", () => {
  it("dedupes identical raw payloads by hash and keeps distinct ones", async () => {
    const es = new EventStore(h.db);
    const a = await es.appendRaw({ source: "x", kind: "post", workspaceId: "w1", externalId: "1", payload: { b: 2, a: 1 } });
    const b = await es.appendRaw({ source: "x", kind: "post", workspaceId: "w1", externalId: "1", payload: { a: 1, b: 2 } });
    const c = await es.appendRaw({ source: "x", kind: "post", workspaceId: "w1", externalId: "2", payload: { a: 1 } });
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(c.duplicate).toBe(false);
    expect(hashPayload({ a: [1, { z: 1, y: 2 }] })).toBe(hashPayload({ a: [1, { y: 2, z: 1 }] }));
  });

  it("appends and lists ledger events newest-first with filters", async () => {
    const es = new EventStore(h.db);
    await es.append({ workspaceId: "w1", type: "post.created", subjectType: "post", subjectId: "p1", actor, data: { n: 1 } });
    await es.append({ workspaceId: "w1", type: "post.scheduled", subjectType: "post", subjectId: "p1", actor, data: { n: 2 } });
    await es.append({ workspaceId: "w1", type: "post.created", subjectType: "post", subjectId: "p2", actor });
    const all = await es.list({ workspaceId: "w1" });
    expect(all.map((e) => e.subjectId)).toEqual(["p2", "p1", "p1"]);
    const created = await es.list({ workspaceId: "w1", types: ["post.created"] });
    expect(created).toHaveLength(2);
    const hist = await es.history("post", "p1");
    expect(hist.map((e) => e.type)).toEqual(["post.created", "post.scheduled"]);
    expect(hist[1]!.seq).toBeGreaterThan(hist[0]!.seq);
  });
});

describe("outcomes and diffs", () => {
  it("schedules six offsets per variant, captures due ones, and records diffs only when text changed", async () => {
    await h.db.insert(socialAccounts).values({ id: "a1", workspaceId: "w1", network: "bluesky", externalId: "did", handle: "acme", connector: "mock" });
    await h.db.insert(posts).values({ id: "p1", workspaceId: "w1", status: "published", body: "hi", createdBy: actor });
    await h.db.insert(postVariants).values({ id: "v1", postId: "p1", socialAccountId: "a1", network: "bluesky", text: "hi" });
    const es = new EventStore(h.db);
    const sched = new OutcomeScheduler(h.db, es);
    const publishedAt = new Date("2026-11-02T00:00:00Z");
    const ids = await sched.schedule({ workspaceId: "w1", postId: "p1", variantId: "v1", publishedAt, actor });
    expect(ids).toHaveLength(6);
    // idempotent
    await sched.schedule({ workspaceId: "w1", postId: "p1", variantId: "v1", publishedAt, actor });
    const due = await sched.due(new Date("2026-11-02T07:00:00Z"));
    expect(due.map((d) => d.offsetLabel)).toEqual(["1h", "6h"]);
    await sched.capture({ outcomeId: due[0]!.id, metrics: { impressions: 120 }, capturedAt: new Date(), actor });
    const left = await sched.due(new Date("2026-11-02T07:00:00Z"));
    expect(left.map((d) => d.offsetLabel)).toEqual(["6h"]);
    const captured = await es.list({ workspaceId: "w1", types: ["outcome.captured"] });
    expect(captured[0]?.data).toMatchObject({ offset: "1h", metrics: { impressions: 120 } });

    const diffs = new ApprovalDiffs(h.db);
    expect(await diffs.record({ workspaceId: "w1", postId: "p1", variantId: "v1", beforeText: "a", afterText: "a", draftedBy: actor, editedBy: actor })).toBeNull();
    expect(await diffs.record({ workspaceId: "w1", postId: "p1", variantId: "v1", beforeText: "a", afterText: "b", draftedBy: actor, editedBy: actor })).toMatch(/^diff_/);
  });
});
