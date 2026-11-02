import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@starsign/db/test";
import type { DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, Starsign, SecretBox } from "@starsign/core";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let app: ReturnType<typeof createApp>;
let m: Starsign;
let ownerKey: string;
let agentKey: string;
let acctId: string;
const H = { "content-type": "application/json" };
const auth = (k: string) => ({ ...H, authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
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
    const bad = await app.request("/v1/me", { headers: { authorization: "Bearer star_nope" } });
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

describe("review regressions", () => {
  it("agent keys never pass role gates: accounts, profile, global topics, keys", async () => {
    expect((await app.request("/v1/accounts", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ network: "x", externalId: "9", handle: "h", connector: "mock" }) })).status).toBe(403);
    expect((await app.request(`/v1/accounts/${acctId}`, { method: "DELETE", headers: auth(agentKey) })).status).toBe(403);
    expect((await app.request("/v1/workspace/profile", { method: "PATCH", headers: auth(agentKey), body: JSON.stringify({ profile: { description: "pwned" } }) })).status).toBe(403);
    expect((await app.request("/v1/trends/topics", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ name: "G", keywords: ["g"], global: true }) })).status).toBe(403);
    expect((await app.request("/v1/keys", { headers: auth(agentKey) })).status).toBe(403);
    const keys = await json(await app.request("/v1/keys", { headers: auth(ownerKey) }));
    expect(keys.some((k: { keyHash?: string }) => "keyHash" in k)).toBe(false);
  });

  it("schedule requires a time; malformed JSON is a 400; cancel is denied to agents on others' posts", async () => {
    const created = await json(await app.request("/v1/posts", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ body: "d", variants: [{ socialAccountId: acctId, text: "draft" }] }) }));
    expect((await app.request(`/v1/posts/${created.post.id}/schedule`, { method: "POST", headers: auth(ownerKey), body: JSON.stringify({}) })).status).toBe(400);
    expect((await app.request(`/v1/posts/${created.post.id}/schedule`, { method: "POST", headers: auth(ownerKey), body: "{not json" })).status).toBe(400);
    expect((await app.request(`/v1/posts/${created.post.id}/cancel`, { method: "POST", headers: auth(agentKey) })).status).toBe(403);
    expect((await app.request(`/v1/posts/${created.post.id}/cancel`, { method: "POST", headers: auth(ownerKey) })).status).toBe(200);
  });

  it("a blocked approval edit is not persisted and the 422 carries violations", async () => {
    const created = await json(await app.request("/v1/posts", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ body: "ok", variants: [{ socialAccountId: acctId, text: "clean text" }] }) }));
    const vid = created.variants[0].id;
    const res = await app.request(`/v1/posts/${created.post.id}/decide`, { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ decision: "approve", edits: { [vid]: "guaranteed win" } }) });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.details.violations[0].redLineId).toBe("g");
    const after = await json(await app.request(`/v1/posts/${created.post.id}`, { headers: auth(ownerKey) }));
    expect(after.variants[0].text).toBe("clean text");
    expect(after.post.status).toBe("pending_approval");
    const ctx = await json(await app.request("/v1/context", { headers: auth(ownerKey) }));
    expect(ctx.voiceExamples.some((v: { after: string }) => v.after === "guaranteed win")).toBe(false);
  });

  it("metrics series and topics are workspace-scoped; stream tokens are single use", async () => {
    const other = await m.workspaces.create({ slug: "other", name: "Other", timezone: "UTC" }, { type: "human", id: "u9" });
    const otherTopic = await m.trends.createTopic({ workspaceId: other.id, name: "theirs", keywords: ["t"] });
    expect((await app.request(`/v1/trends/topics/${otherTopic.id}`, { headers: auth(ownerKey) })).status).toBe(404);
    expect((await app.request("/v1/trends/points", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ points: [{ topicId: otherTopic.id, source: "manual", value: 1, observedAt: new Date().toISOString() }] }) })).status).toBe(404);
    expect((await app.request("/v1/metrics/series?entityType=post_variant&entityId=nope&metric=impressions", { headers: auth(ownerKey) })).status).toBe(404);
    expect((await app.request(`/v1/metrics/series?entityType=workspace&entityId=${other.id}&metric=impressions`, { headers: auth(ownerKey) })).status).toBe(404);

    // A strict app (no dev workspace): the API key is never accepted in a URL, tokens are single use.
    const strict = createApp(m);
    expect((await strict.request("/v1/feed/stream?key=" + encodeURIComponent(ownerKey))).status).toBe(401);
    const tok = await json(await strict.request("/v1/feed/stream-token", { method: "POST", headers: auth(ownerKey) }));
    expect(tok.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const first = await strict.request(`/v1/feed/stream?token=${tok.token}`);
    expect(first.status).toBe(200);
    expect((await strict.request(`/v1/feed/stream?token=${tok.token}`)).status).toBe(401);
  });
});

describe("compose, calendar, connect, sources", () => {
  it("compose/adapt answers 503 without a model and adapts per network with one", async () => {
    expect((await app.request("/v1/compose/adapt", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ body: "idea", networks: ["bluesky"] }) })).status).toBe(503);
    const { FakeGateway, defaultFakeHandlers } = await import("@starsign/ai");
    const withAi = createApp(m, { gateway: new FakeGateway(defaultFakeHandlers()) });
    const res = await withAi.request("/v1/compose/adapt", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ body: "First snow on the North Shore: spikes on.", networks: ["bluesky", "x", "x"] }) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.variants.map((v: { network: string }) => v.network).sort()).toEqual(["bluesky", "x"]);
    expect(typeof body.usage.costUsd).toBe("number");
    expect((await withAi.request("/v1/compose/adapt", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ body: "x", networks: ["myspace"] }) })).status).toBe(400);
  });

  it("calendar defaults to this week and rejects huge windows", async () => {
    const res = await app.request("/v1/calendar", { headers: auth(ownerKey) });
    expect(res.status).toBe(200);
    expect(Array.isArray(await json(res))).toBe(true);
    expect((await app.request("/v1/calendar?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z", { headers: auth(ownerKey) })).status).toBe(400);
  });

  it("connects Bluesky by verifying the app password, and refuses agents and bad passwords", async () => {
    const { BlueskyConnector } = await import("@starsign/connectors");
    const fakeAgent = () => {
      const agent: { session?: { did: string; handle: string }; login: (o: { identifier: string; password: string }) => Promise<void> } = {
        async login(o) {
          if (o.password !== "good-pass") throw Object.assign(new Error("Invalid identifier or password"), { status: 401, error: "AuthenticationRequired" });
          agent.session = { did: "did:plc:verified", handle: "acme.bsky.social" };
        },
      };
      return agent;
    };
    m.ctx.connectors.register(new BlueskyConnector({ agentFactory: fakeAgent as never }));
    const ok = await app.request("/v1/accounts/connect/bluesky", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ identifier: "@acme.bsky.social", appPassword: "good-pass" }) });
    expect(ok.status).toBe(201);
    const acct = await json(ok);
    expect(acct).toMatchObject({ network: "bluesky", externalId: "did:plc:verified", handle: "acme.bsky.social", connector: "bluesky", hasCredentials: true });
    const bad = await app.request("/v1/accounts/connect/bluesky", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ identifier: "acme.bsky.social", appPassword: "nope" }) });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.details.reason).toMatch(/not accepted/);
    expect((await app.request("/v1/accounts/connect/bluesky", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ identifier: "a", appPassword: "good-pass" }) })).status).toBe(403);
    const connectors = await json(await app.request("/v1/connectors", { headers: auth(ownerKey) }));
    expect(connectors.find((c: { name: string }) => c.name === "bluesky")).toMatchObject({ connect: "app_password" });
    expect(connectors.find((c: { name: string }) => c.name === "mock")).toBeUndefined();
  });

  it("reports sources and discoveries", async () => {
    const withSources = createApp(m, { sources: [{ name: "hacker_news", configured: true, granularityMs: 3_600_000, sample: async () => [] }] });
    const s = await json(await withSources.request("/v1/sources", { headers: auth(ownerKey) }));
    expect(s.map((x: { name: string }) => x.name)).toEqual(["hacker_news", "own_feed"]);
    expect(Array.isArray(await json(await withSources.request("/v1/trends/discoveries", { headers: auth(ownerKey) })))).toBe(true);
  });
});
