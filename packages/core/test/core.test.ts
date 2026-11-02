import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@meridian/db/test";
import type { DbHandle } from "@meridian/db";
import { ConnectorRegistry, MockConnector } from "@meridian/connectors";
import { randomBytes } from "node:crypto";
import { CoreError, InMemoryScheduler, Meridian, RetryablePublishError, SecretBox, type Principal } from "../src/index.ts";

let h: DbHandle;
let m: Meridian;
let mock: MockConnector;
let sched: InMemoryScheduler;
let clock = Date.parse("2026-11-02T17:00:00Z"); // 09:00 Vancouver
const now = () => new Date(clock);

let owner: Principal;
let editor: Principal;
let operator: Principal;
let acctX: string;
let acctBsky: string;

beforeAll(async () => {
  h = await createTestDb();
  mock = new MockConnector();
  mock.now = now;
  sched = new InMemoryScheduler();
  m = new Meridian({ handle: h, connectors: new ConnectorRegistry().register(mock), scheduler: sched, secrets: new SecretBox(randomBytes(32)), now });
  const ws = await m.workspaces.create({ slug: "Acme Co", name: "Acme", timezone: "America/Vancouver" }, { type: "human", id: "u_owner" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u_owner" }, role: "owner" };
  editor = { workspaceId: ws.id, actor: { type: "human", id: "u_editor" }, role: "editor" };
  operator = { workspaceId: ws.id, actor: { type: "operator", id: "studio" } };
  acctX = (await m.accounts.connect(owner, { network: "x", externalId: "123", handle: "acme", connector: "mock", auth: { token: "secret-token" } })).id;
  acctBsky = (await m.accounts.connect(owner, { network: "bluesky", externalId: "did:plc:1", handle: "acme.bsky.social", connector: "mock" })).id;
  await m.policy.update(owner, {
    autonomy: { new_post: "schedule_with_approval", reply: "autopost", dm: "suggest", repost: "draft", campaign: "suggest" },
    requireApprovalForEditors: true,
    redLines: [
      { id: "p1", kind: "forbidden_phrase", description: "No guarantees", severity: "block", phrases: ["guaranteed"] },
      { id: "k1", kind: "no_competitor_mention", description: "No competitors", severity: "require_approval", competitors: ["Hootsuite"] },
      { id: "q1", kind: "quiet_hours", description: "Quiet overnight", severity: "require_approval", timezone: "America/Vancouver", startHour: 22, endHour: 6, days: [] },
    ],
    timezone: "America/Vancouver",
  });
});
afterAll(() => h.close());

describe("workspace and keys", () => {
  it("stores credentials encrypted and authenticates api keys", async () => {
    const accounts = await m.accounts.list(owner.workspaceId);
    expect(accounts.find((a) => a.id === acctX)).toMatchObject({ hasCredentials: true });
    expect(JSON.stringify(accounts)).not.toContain("secret-token");
    const { secret } = await m.workspaces.createApiKey({ workspaceId: owner.workspaceId, name: "cli", actorType: "human", actorId: "u_owner", role: "owner" });
    const p = await m.workspaces.authenticate(secret);
    expect(p).toMatchObject({ workspaceId: owner.workspaceId, actor: { type: "human", id: "u_owner" }, role: "owner" });
    expect(await m.workspaces.authenticate("mer_nope")).toBeNull();
    expect((await m.policy.getActive(owner.workspaceId)).version).toBe(2);
  });
});

describe("the gate", () => {
  it("owner schedules directly; the scheduler is armed; the ledger records it", async () => {
    const at = new Date(clock + 3_600_000);
    const r = await m.posts.create(owner, {
      body: "Our Monday update",
      variants: [
        { socialAccountId: acctX, text: "Our Monday update" },
        { socialAccountId: acctBsky, text: "Our Monday update, for Bluesky" },
      ],
      scheduledAt: at.toISOString(),
    });
    expect(r.post.status).toBe("scheduled");
    expect(sched.jobs.get(r.post.id)?.getTime()).toBe(at.getTime());
    const hist = await m.events.history("post", r.post.id);
    expect(hist.map((e) => e.type)).toEqual(["post.created", "post.scheduled"]);
  });

  it("editor lands in pending approval; operator too; viewer-level autonomy is refused", async () => {
    const e = await m.posts.create(editor, { body: "hi", variants: [{ socialAccountId: acctX, text: "hi" }] });
    expect(e.post.status).toBe("pending_approval");
    expect(e.approvals[0]?.state).toBe("requested");
    const o = await m.posts.create(operator, { body: "op", variants: [{ socialAccountId: acctX, text: "op" }], scheduledAt: new Date(clock + 7_200_000).toISOString() });
    expect(o.post.status).toBe("pending_approval");
    await expect(m.posts.create(operator, { body: "dm", actionClass: "dm", variants: [{ socialAccountId: acctX, text: "dm" }] })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("red lines block even the owner, and the block is in the ledger", async () => {
    const r = await m.posts.create(owner, { body: "x", variants: [{ socialAccountId: acctX, text: "Results guaranteed" }] });
    expect(r.post.status).toBe("blocked");
    const blocked = await m.events.list({ workspaceId: owner.workspaceId, types: ["policy.blocked"], subjectId: r.post.id });
    expect(blocked).toHaveLength(1);
  });

  it("validation rejects over-limit variants before anything is stored", async () => {
    await expect(m.posts.create(owner, { body: "x", variants: [{ socialAccountId: acctX, text: "a".repeat(300) }] })).rejects.toMatchObject({ code: "invalid" });
  });

  it("autopost autonomy lets an operator schedule a reply directly", async () => {
    const r = await m.posts.create(operator, { body: "thanks", actionClass: "reply", variants: [{ socialAccountId: acctBsky, text: "thanks!" }], scheduledAt: now().toISOString() });
    expect(r.post.status).toBe("scheduled");
  });
});

describe("approvals", () => {
  it("records diffs, re-checks red lines on edits, and arms the scheduler on approve", async () => {
    const at = new Date(clock + 3_600_000);
    const r = await m.posts.create(operator, { body: "draft", variants: [{ socialAccountId: acctX, text: "Better than everyone" }], scheduledAt: at.toISOString() });
    const vid = r.variants[0]!.id;
    await expect(m.approvals.decide(operator, r.post.id, { decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.approvals.decide(editor, r.post.id, { decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    // an edit that crosses a red line cannot be approved
    await expect(m.approvals.decide(owner, r.post.id, { decision: "approve", edits: { [vid]: "Results guaranteed" } })).rejects.toMatchObject({ code: "policy_blocked" });
    const d = await m.approvals.decide(owner, r.post.id, { decision: "approve", note: "tightened", edits: { [vid]: "Better than ever" } });
    expect(d.post.status).toBe("scheduled");
    expect(d.variants[0]?.text).toBe("Better than ever");
    expect(sched.jobs.has(r.post.id)).toBe(true);
    const exp = await m.exports.workspace(owner);
    expect(exp.approvalDiffs.some((x) => x.postId === r.post.id && x.afterText === "Better than ever")).toBe(true);
  });

  it("reject cancels; request_changes returns to draft", async () => {
    const a = await m.posts.create(editor, { body: "a", variants: [{ socialAccountId: acctX, text: "a" }] });
    expect((await m.approvals.decide(owner, a.post.id, { decision: "reject" })).post.status).toBe("cancelled");
    const b = await m.posts.create(editor, { body: "b", variants: [{ socialAccountId: acctX, text: "b" }] });
    expect((await m.approvals.decide(owner, b.post.id, { decision: "request_changes", note: "shorter" })).post.status).toBe("draft");
  });
});

describe("publishing and outcomes", () => {
  it("publishes idempotently, schedules outcomes, retries transient failures without double-posting", async () => {
    const r = await m.posts.create(owner, {
      body: "launch",
      variants: [
        { socialAccountId: acctX, text: "launch on x" },
        { socialAccountId: acctBsky, text: "launch on bsky" },
      ],
      scheduledAt: now().toISOString(),
    });
    mock.failNext = { kind: "rate_limit", retryable: true }; // first variant fails once
    await expect(m.publishing.publishPost(r.post.id)).rejects.toBeInstanceOf(RetryablePublishError);
    let d = await m.posts.get(owner.workspaceId, r.post.id);
    expect(d.post.status).toBe("publishing");
    expect(d.variants.filter((v) => v.status === "published")).toHaveLength(1);
    const res = await m.publishing.publishPost(r.post.id);
    expect(res).toMatchObject({ status: "published", published: 2 });
    d = await m.posts.get(owner.workspaceId, r.post.id);
    expect(mock.posts.filter((p) => p.text.startsWith("launch"))).toHaveLength(2);
    expect(d.variants.every((v) => v.externalId)).toBe(true);

    // outcomes: six per variant, captured as the clock advances
    clock += 61 * 60_000;
    let cap = await m.metrics.captureDueOutcomes();
    expect(cap.captured).toBeGreaterThanOrEqual(2);
    clock += 24 * 3_600_000;
    cap = await m.metrics.captureDueOutcomes();
    expect(cap.captured).toBeGreaterThanOrEqual(4);
    const latest = await m.metrics.latest("post_variant", d.variants[0]!.externalId!);
    expect(latest.impressions).toBeGreaterThan(0);
    const summary = await m.metrics.summary(owner.workspaceId, new Date(clock - 3 * 86_400_000), now(), "America/Vancouver");
    expect(summary.measuredAt24h).toBeGreaterThanOrEqual(2);
    expect(summary.byNetwork.map((b) => b.key).sort()).toEqual(["bluesky", "x"]);
    expect(summary.top[0]?.engagements).toBeGreaterThan(0);
  });

  it("non-retryable failures mark the variant failed and the post partially published", async () => {
    const r = await m.posts.create(owner, {
      body: "p",
      variants: [
        { socialAccountId: acctX, text: "p on x" },
        { socialAccountId: acctBsky, text: "p on bsky" },
      ],
      scheduledAt: now().toISOString(),
    });
    mock.failNext = { kind: "rejected", retryable: false };
    const res = await m.publishing.publishPost(r.post.id);
    expect(res).toMatchObject({ status: "partially_published", published: 1, failed: 1 });
  });
});

describe("listening", () => {
  it("ingests raw-first, dedupes, matches streams, and serves the feed", async () => {
    const s = await m.listening.createStream(owner, { name: "Competitors", query: { keywords: ["Hootsuite", "Sprinklr"] } });
    const items = [
      { network: "x", kind: "mention", externalId: "m1", authorHandle: "fan", authorName: "A Fan", text: "Love what @acme is doing, way better than Hootsuite", url: null, parentExternalId: null, occurredAt: now().toISOString(), raw: { id: "m1" } },
      { network: "x", kind: "reply", externalId: "m2", authorHandle: "critic", authorName: null, text: "meh", url: null, parentExternalId: "123", occurredAt: now().toISOString(), raw: { id: "m2" } },
    ];
    mock.enqueueActivity(acctX, items as never);
    const first = await m.listening.ingestAccount(acctX);
    expect(first).toEqual({ ingested: 2, duplicates: 0 });
    mock.enqueueActivity(acctX, items as never);
    const again = await m.listening.ingestItems(owner.workspaceId, acctX, items);
    expect(again).toEqual({ ingested: 0, duplicates: 2 });
    const matched = await m.listening.feed(owner.workspaceId, { streamId: s.id });
    expect(matched.map((a) => a.externalId)).toEqual(["m1"]);
    const all = await m.listening.feed(owner.workspaceId, { networks: ["x"] });
    expect(all).toHaveLength(2);
    const exp = await m.exports.workspace(owner);
    expect(exp.rawEvents.filter((r) => r.kind.startsWith("activity.")).length).toBe(2);
  });
});

describe("trends", () => {
  it("records points, forecasts with a band, scores the radar, and joins actions to outcomes", async () => {
    const topic = await m.trends.createTopic({ workspaceId: owner.workspaceId, name: "Four-day week", keywords: ["four-day week", "4-day week"], relevance: 0.9 });
    const quiet = await m.trends.createTopic({ workspaceId: null, name: "Background noise", keywords: ["noise"] });
    const pts: unknown[] = [];
    for (let i = 72; i >= 1; i--) {
      const t = new Date(clock - i * 3_600_000).toISOString();
      pts.push({ topicId: topic.id, source: "google_trends", value: 20 + (72 - i) * 1.5, observedAt: t });
      pts.push({ topicId: topic.id, source: "wikipedia_pageviews", value: 200 + (72 - i) * 14, observedAt: t });
      pts.push({ topicId: quiet.id, source: "google_trends", value: 10, observedAt: t });
    }
    await m.trends.recordPoints(pts);
    const f = await m.trends.computeForecast(topic.id);
    expect(f.stage).toBe("rising");
    expect(f.confidence).toBeGreaterThan(0.6);
    expect(f.curve.length).toBe(72);
    expect(f.sources.sort()).toEqual(["google_trends", "wikipedia_pageviews"]);
    await m.trends.computeForecast(quiet.id);
    const radar = await m.trends.radar(owner.workspaceId);
    expect(radar[0]?.topic.id).toBe(topic.id);
    expect(radar[0]?.window).toMatch(/act/);
    expect(radar[1]?.forecast?.stage).toBe("dormant");

    const r = await m.posts.create(owner, {
      body: "Our take on the four-day week",
      variants: [{ socialAccountId: acctBsky, text: "Our take on the four-day week" }],
      scheduledAt: now().toISOString(),
      trendTopicId: topic.id,
    });
    expect(r.post.trendTopicId).toBe(topic.id);
    const detail = await m.trends.detail(owner.workspaceId, topic.id);
    expect(detail.actions[0]).toMatchObject({ postId: r.post.id, stageAtAction: "rising", forecastId: f.id });
    const events = await m.events.list({ workspaceId: owner.workspaceId, types: ["trend.action_recorded"] });
    expect(events[0]?.data).toMatchObject({ topicId: topic.id, stage: "rising" });
  });
});

describe("errors", () => {
  it("maps to http statuses", () => {
    expect(new CoreError("not_found", "x").httpStatus).toBe(404);
    expect(new CoreError("policy_blocked", "x").httpStatus).toBe(422);
  });
});
