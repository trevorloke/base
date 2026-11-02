import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGateway, defaultFakeHandlers, type DraftForTrendVars } from "@meridian/ai";
import { ConnectorRegistry, MockConnector } from "@meridian/connectors";
import { InMemoryScheduler, Meridian, SecretBox, type Principal } from "@meridian/core";
import type { DbHandle } from "@meridian/db";
import { createTestDb } from "@meridian/db/test";
import { runAnalyst, runWatch } from "../src/index.ts";

let h: DbHandle;
let m: Meridian;
let gw: FakeGateway;
const clock = Date.parse("2026-11-02T17:00:00Z"); // Monday 09:00 in Vancouver
const now = () => new Date(clock);

interface Seeded {
  owner: Principal;
  topicId: string;
}
let acme: Seeded;
let quiet: Seeded;

const FAKE_BRIEF = { headline: "3 posts measured at 24h, 0 trend windows acted on", markdown: "# Fake brief\n\nQuoting only what the ledger said.", evidence: [{ kind: "metrics_summary", ref: "2026-10-26..2026-11-02", note: "3 posts measured at 24h" }] };

/** A workspace with one x and one bluesky account and a topic rising for 72 hours on two sources. */
async function seed(slug: string, policy: Record<string, unknown>): Promise<Seeded> {
  const ws = await m.workspaces.create(
    {
      slug,
      name: `${slug} Inc`,
      timezone: "America/Vancouver",
      profile: { description: "Scheduling software for small teams", audience: "Ops leads", topics: ["four-day week"], voice: { do: ["Be specific"], dont: ["No hype"], examples: ["We shipped the thing."] } },
    },
    { type: "human", id: "u_owner" },
  );
  const owner: Principal = { workspaceId: ws.id, actor: { type: "human", id: "u_owner" }, role: "owner" };
  await m.accounts.connect(owner, { network: "x", externalId: `${slug}-x`, handle: `${slug}`, connector: "mock" });
  await m.accounts.connect(owner, { network: "bluesky", externalId: `did:plc:${slug}`, handle: `${slug}.bsky.social`, connector: "mock" });
  await m.policy.update(owner, {
    requireApprovalForEditors: true,
    redLines: [
      { id: "p1", kind: "forbidden_phrase", description: "No guarantees", severity: "block", phrases: ["guaranteed"] },
      { id: "k1", kind: "no_competitor_mention", description: "No competitors", severity: "require_approval", competitors: ["Hootsuite"] },
    ],
    timezone: "America/Vancouver",
    ...policy,
  });
  const topic = await m.trends.createTopic({ workspaceId: ws.id, name: `Four-day week (${slug})`, keywords: ["four-day week", "4-day week"], relevance: 0.9 });
  const pts: unknown[] = [];
  for (let i = 72; i >= 1; i--) {
    const t = new Date(clock - i * 3_600_000).toISOString();
    pts.push({ topicId: topic.id, source: "google_trends", value: 20 + (72 - i) * 1.5, observedAt: t });
    pts.push({ topicId: topic.id, source: "wikipedia_pageviews", value: 200 + (72 - i) * 14, observedAt: t });
  }
  await m.trends.recordPoints(pts);
  return { owner, topicId: topic.id };
}

beforeAll(async () => {
  h = await createTestDb();
  const mock = new MockConnector();
  mock.now = now;
  m = new Meridian({ handle: h, connectors: new ConnectorRegistry().register(mock), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now });
  gw = new FakeGateway(defaultFakeHandlers());
  gw.on("draftForTrend", (vars) => {
    const v = vars as DraftForTrendVars;
    return {
      angle: `${v.topic.name}: what our own data says`,
      rationale: `Rising at ${Math.round(v.forecast.confidence * 100)}% confidence; treat the ${v.forecast.hoursToPeak ?? "?"}h-to-peak as an estimate.`,
      variants: v.networks.map((n) => ({ network: n, text: `Four-day week on ${n}: here is what our scheduling data says.`, thread: [] })),
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"] },
    };
  });
  gw.on("writeBrief", () => FAKE_BRIEF);

  acme = await seed("acme", { autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" } });
  quiet = await seed("quiet", { autonomy: { new_post: "suggest", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" } });
  // A global topic nobody cares about: flat, so dormant, so never a window.
  const noise = await m.trends.createTopic({ workspaceId: null, name: "Background noise", keywords: ["noise"] });
  await m.trends.recordPoints(Array.from({ length: 72 }, (_, i) => ({ topicId: noise.id, source: "google_trends", value: 10, observedAt: new Date(clock - (72 - i) * 3_600_000).toISOString() })));
});
afterAll(() => h.close());

describe("Watch", () => {
  it("forecasts, raises one alert for the rising window and lands one Studio draft in the approval queue", async () => {
    const summary = await runWatch(m, gw, acme.owner.workspaceId);
    expect(summary).toMatchObject({ topicsForecasted: 2, forecastErrors: 0, alertsRaised: 1, postsCreated: 1, refused: 0, errors: 0 });
    expect(summary.windows).toHaveLength(1);
    const w = summary.windows[0]!;
    expect(w).toMatchObject({ topicId: acme.topicId, stage: "rising", postStatus: "pending_approval" });
    expect(w.confidence).toBeGreaterThanOrEqual(0.5);
    expect(summary.usage.calls).toBe(1);
    expect(summary.usage.inputTokens).toBeGreaterThan(0);
    expect(summary.usage.costUsd).toBeGreaterThan(0);

    const pending = await m.posts.list(acme.owner.workspaceId, { status: ["pending_approval"] });
    expect(pending).toHaveLength(1);
    const post = pending[0]!.post;
    expect(post.id).toBe(w.postId);
    expect(post.trendTopicId).toBe(acme.topicId);
    expect(post.trendStageAtCreation).toBe("rising");
    expect(post.trendForecastId).toBeTruthy();
    expect(post.createdBy).toEqual({ type: "operator", id: "studio" });
    const postEvidence = post.evidence as { kind: string; ref: string }[];
    expect(postEvidence.length).toBeGreaterThan(0);
    expect(postEvidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["forecast", "sources", "hours_to_peak", "alert", "rationale"]));
    expect(postEvidence.find((e) => e.kind === "forecast")?.ref).toBe(post.trendForecastId);
    expect(post.disclosure).toMatchObject({ aiAssisted: true, humanReviewed: false, model: "fake", promptVersion: "draftForTrend@1.0.0" });
    expect(post.disclosure?.aiContributions).toContain("text_drafted");
    expect(pending[0]!.variants.map((v) => v.network).sort()).toEqual(["bluesky", "x"]);

    const alerts = await m.ops.alerts(acme.owner.workspaceId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "trend_window", topicId: acme.topicId });
    expect(alerts[0]!.id).toBe(w.alertId);
    const evidence = alerts[0]!.evidence as { kind: string; ref: string }[];
    expect(evidence.map((e) => e.kind)).toEqual(["forecast", "sources", "hours_to_peak"]);
    expect(evidence[0]!.ref).toBe(post.trendForecastId);
    expect(evidence[1]!.ref.split(",").sort()).toEqual(["google_trends", "wikipedia_pageviews"]);

    const detail = await m.trends.detail(acme.owner.workspaceId, acme.topicId);
    expect(detail.actions[0]).toMatchObject({ postId: post.id, stageAtAction: "rising", forecastId: post.trendForecastId });

    const runs = await m.ops.runs(acme.owner.workspaceId);
    expect(runs[0]).toMatchObject({ id: summary.runId, operator: "watch", status: "succeeded" });
    expect(runs[0]!.inputTokens).toBeGreaterThan(0);
    expect(runs[0]!.costUsd).toBeGreaterThan(0);
    expect(runs[0]!.summary).toContain("1 draft(s) [pending_approval]");

    const call = gw.callsFor("draftForTrend").at(-1)!;
    expect(call.system).toContain("acme Inc");
    expect(call.system).toContain("guaranteed");
    expect(call.system).toContain("Hootsuite");
    expect(call.user).toContain("google_trends");
    const history = await m.events.history("post", post.id);
    expect(history.map((e) => e.type)).toEqual(["post.created", "trend.action_recorded", "post.approval_requested"]);
  });

  it("leaves a window alone once it has been alerted or acted on within 48h", async () => {
    const before = gw.callsFor("draftForTrend").length;
    const again = await runWatch(m, gw, acme.owner.workspaceId);
    expect(again).toMatchObject({ alertsRaised: 0, postsCreated: 0, refused: 0, errors: 0 });
    expect(again.windows).toHaveLength(0);
    expect(gw.callsFor("draftForTrend")).toHaveLength(before);
    expect(await m.ops.alerts(acme.owner.workspaceId)).toHaveLength(1);
    expect(await m.posts.list(acme.owner.workspaceId)).toHaveLength(1);
  });

  it("with autonomy 'suggest' raises the alert, calls no model, creates no post, and records the refusal", async () => {
    const before = gw.callsFor("draftForTrend").length;
    const summary = await runWatch(m, gw, quiet.owner.workspaceId);
    expect(summary).toMatchObject({ alertsRaised: 1, postsCreated: 0, refused: 1, errors: 0 });
    expect(summary.windows[0]).toMatchObject({ topicId: quiet.topicId, postId: null });
    expect(summary.windows[0]!.refused).toMatch(/autonomy for new_post is "suggest"/);
    expect(gw.callsFor("draftForTrend")).toHaveLength(before);
    expect(await m.posts.list(quiet.owner.workspaceId)).toHaveLength(0);
    expect(await m.ops.alerts(quiet.owner.workspaceId)).toHaveLength(1);
    const runs = await m.ops.runs(quiet.owner.workspaceId);
    expect(runs[0]).toMatchObject({ operator: "watch", status: "succeeded" });
    expect(runs[0]!.summary).toContain("1 refused by autonomy");
  });

  it("records the gate's refusal in the summary instead of failing when the dial drops after the model drafted", async () => {
    // "draft" lets the Studio create; the gate itself decides the landing status.
    const ws = await m.workspaces.create({ slug: "drafty", name: "Drafty", timezone: "UTC" }, { type: "human", id: "u" });
    const owner: Principal = { workspaceId: ws.id, actor: { type: "human", id: "u" }, role: "owner" };
    await m.accounts.connect(owner, { network: "x", externalId: "d-x", handle: "drafty", connector: "mock" });
    await m.policy.update(owner, { autonomy: { new_post: "draft", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" }, redLines: [], timezone: "UTC" });
    const topic = await m.trends.createTopic({ workspaceId: ws.id, name: "Rising thing", keywords: ["rising"], relevance: 1 });
    await m.trends.recordPoints(Array.from({ length: 72 }, (_, i) => ({ topicId: topic.id, source: "reddit", value: 5 + i * 2, observedAt: new Date(clock - (72 - i) * 3_600_000).toISOString() })));
    const summary = await runWatch(m, gw, ws.id);
    expect(summary.alertsRaised).toBe(1);
    expect(summary.postsCreated + summary.refused).toBe(1);
    if (summary.postsCreated) expect(summary.windows[0]!.postStatus).toBe("pending_approval");
  });
});

describe("Analyst", () => {
  it("writes the weekly brief from the ledger at high effort and saves it with its evidence", async () => {
    const result = await runAnalyst(m, gw, acme.owner.workspaceId, { periodDays: 7 });
    expect(result.headline).toBe(FAKE_BRIEF.headline);
    expect(result.periodEnd.getTime()).toBe(clock);
    expect(result.periodStart.getTime()).toBe(clock - 7 * 86_400_000);
    expect(result.usage.promptVersion).toBe("writeBrief@1.0.0");

    const [brief] = await m.ops.briefs(acme.owner.workspaceId);
    expect(brief).toBeDefined();
    expect(brief!.id).toBe(result.briefId);
    expect(brief!.contentMd).toBe(FAKE_BRIEF.markdown);
    expect(brief!.runId).toBe(result.runId);
    expect(brief!.evidence).toEqual(expect.arrayContaining([FAKE_BRIEF.evidence[0]]));
    const inputs = (brief!.evidence as { kind: string; note: string }[]).find((e) => e.kind === "inputs");
    expect(inputs?.note).toContain("1 alert(s) considered");
    expect(inputs?.note).toContain("writeBrief@1.0.0");

    const call = gw.callsFor("writeBrief").at(-1)!;
    expect(call.effort).toBe("high");
    expect(call.user).toContain("Four-day week (acme)");
    expect(call.user).toContain("Window opening");
    expect((call.vars.radar as unknown[]).length).toBeGreaterThan(0);

    const runs = await m.ops.runs(acme.owner.workspaceId);
    const run = runs.find((r) => r.id === result.runId)!;
    expect(run).toMatchObject({ operator: "analyst", status: "succeeded" });
    expect(run.inputTokens).toBe(result.usage.inputTokens);
    expect(run.costUsd).toBeCloseTo(result.usage.costUsd, 9);
    const events = await m.events.list({ workspaceId: acme.owner.workspaceId, types: ["brief.written"] });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toEqual({ type: "operator", id: "analyst" });
  });

  it("marks the run failed and rethrows when the gateway fails", async () => {
    const broken = new FakeGateway({ writeBrief: () => ({ headline: 1 }) });
    await expect(runAnalyst(m, broken, quiet.owner.workspaceId)).rejects.toThrow();
    // run rows share one startedAt under the fixed test clock, so select by operator rather than by order
    const run = (await m.ops.runs(quiet.owner.workspaceId)).find((r) => r.operator === "analyst")!;
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toBeTruthy();
  });
});
