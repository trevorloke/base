import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@meridian/db/test";
import type { DbHandle } from "@meridian/db";
import { ConnectorRegistry, MockConnector } from "@meridian/connectors";
import { InMemoryScheduler, Meridian, SecretBox } from "@meridian/core";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let app: ReturnType<typeof createApp>;
let m: Meridian;
let ownerKey: string;
let agentKey: string;
let acctId: string;
const H = { "content-type": "application/json" };
const auth = (k: string) => ({ ...H, authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  h = await createTestDb();
  m = new Meridian({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  ownerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "o", actorType: "human", actorId: "u1", role: "owner" })).secret;
  agentKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "a", actorType: "mcp", actorId: "claude" })).secret;
  acctId = (await m.accounts.connect({ workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" }, { network: "bluesky", externalId: "did:1", handle: "acme.bsky.social", connector: "mock" })).id;
  app = createApp(m, { devWorkspace: "acme" });
});
afterAll(() => h.close());

describe("api", () => {
  it("health is open; v1 needs a key unless dev workspace is set", async () => {
    expect((await app.request("/api/health")).status).toBe(200);
    const bad = await app.request("/v1/me", { headers: { authorization: "Bearer mer_nope" } });
    expect(bad.status).toBe(401);
    const dev = await app.request("/v1/me");
    expect(dev.status).toBe(200);
    expect((await json(dev)).actor).toEqual({ type: "human", id: "dev" });
    const me = await json(await app.request("/v1/me", { headers: auth(agentKey) }));
    expect(me.actor).toEqual({ type: "mcp", id: "claude" });
  });

  it("agent creates a post that lands in the queue; owner approves it; it schedules", async () => {
    const res = await app.request("/v1/posts", {
      method: "POST",
      headers: auth(agentKey),
      body: JSON.stringify({ body: "hello", variants: [{ socialAccountId: acctId, text: "hello from an agent" }], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }),
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created.post.status).toBe("pending_approval");
    const queue = await json(await app.request("/v1/posts/queue", { headers: auth(ownerKey) }));
    expect(queue.map((q: { post: { id: string } }) => q.post.id)).toContain(created.post.id);

    const denied = await app.request(`/v1/posts/${created.post.id}/decide`, { method: "POST", headers: auth(agentKey), body: JSON.stringify({ decision: "approve" }) });
    expect(denied.status).toBe(403);
    const ok = await app.request(`/v1/posts/${created.post.id}/decide`, { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ decision: "approve", edits: { [created.variants[0].id]: "hello, edited by a human" } }) });
    expect(ok.status).toBe(200);
    const detail = await json(await app.request(`/v1/posts/${created.post.id}`, { headers: auth(ownerKey) }));
    expect(detail.post.status).toBe("scheduled");
    expect(detail.variants[0].text).toBe("hello, edited by a human");
    expect(detail.history.map((e: { type: string }) => e.type)).toContain("post.approval_decided");
  });

  it("policy check is a dry run and red lines block creation", async () => {
    await app.request("/v1/policy", {
      method: "PUT",
      headers: auth(ownerKey),
      body: JSON.stringify({ autonomy: { new_post: "draft", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" }, redLines: [{ id: "g", kind: "forbidden_phrase", description: "No guarantees", severity: "block", phrases: ["guaranteed"] }] }),
    });
    const check = await json(await app.request("/v1/policy/check", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ variants: [{ network: "bluesky", text: "guaranteed results" }] }) }));
    expect(check.verdict).toBe("block");
    expect(check.wouldLand).toBe("blocked");
    const created = await json(await app.request("/v1/posts", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ body: "x", variants: [{ socialAccountId: acctId, text: "guaranteed results" }] }) }));
    expect(created.post.status).toBe("blocked");
    expect(created.post.policyDecision.violations).toHaveLength(1);
  });

  it("feed import, streams, radar, context and export work end to end", async () => {
    await app.request("/v1/streams", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ name: "Support", query: { keywords: ["warranty"] } }) });
    const imp = await json(await app.request("/v1/ingest/items", {
      method: "POST",
      headers: auth(ownerKey),
      body: JSON.stringify({ accountId: null, items: [{ network: "bluesky", kind: "mention", externalId: "e1", authorHandle: "a", authorName: null, text: "warranty question", url: null, parentExternalId: null, occurredAt: new Date().toISOString(), raw: {} }] }),
    }));
    expect(imp.ingested).toBe(1);
    const feed = await json(await app.request("/v1/feed?kinds=mention", { headers: auth(ownerKey) }));
    expect(feed[0].matchedStreams).toHaveLength(1);

    const topic = await json(await app.request("/v1/trends/topics", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ name: "T", keywords: ["t"], relevance: 0.9 }) }));
    const points = Array.from({ length: 48 }, (_, i) => ({ topicId: topic.id, source: "google_trends", value: 10 + i * 2, observedAt: new Date(Date.now() - (48 - i) * 3_600_000).toISOString() }));
    await app.request("/v1/trends/points", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ points }) });
    const fc = await json(await app.request(`/v1/trends/topics/${topic.id}/forecast`, { method: "POST", headers: auth(ownerKey) }));
    expect(fc.stage).toBe("rising");
    const radar = await json(await app.request("/v1/trends/radar", { headers: auth(ownerKey) }));
    expect(radar[0].topic.id).toBe(topic.id);
    expect(radar[0].forecast.curve.length).toBeGreaterThan(0);

    const ctx = await json(await app.request("/v1/context", { headers: auth(agentKey) }));
    expect(ctx.policy.redLines[0].kind).toBe("forbidden_phrase");
    expect(ctx.voiceExamples[0]).toMatchObject({ after: "hello, edited by a human" });
    const exp = await app.request("/v1/export", { headers: auth(ownerKey) });
    expect(exp.headers.get("content-disposition")).toMatch(/attachment/);
    const body = await json(exp);
    expect(body.ledgerEvents.length).toBeGreaterThan(5);
    expect(body.socialAccounts[0].hasCredentials).toBe(false);
  });

  it("404 and validation errors are shaped", async () => {
    const nf = await app.request("/v1/posts/pst_nope", { headers: auth(ownerKey) });
    expect(nf.status).toBe(404);
    expect((await json(nf)).error.code).toBe("not_found");
    const bad = await app.request("/v1/posts", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ variants: [] }) });
    expect(bad.status).toBe(400);
  });
});
