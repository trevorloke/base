import { describe, expect, it } from "vitest";
import { BaseAirClient } from "../src/client.ts";
import { formatRadar, pct } from "../src/format.ts";
import { MCP_MODEL_LABEL, handlers, type ToolContext } from "../src/tools.ts";
import { NOW, alerts, blockedDecision, blockedDetail, brief, context, failingFetch, fakeApi, pendingDetail, post, radar, textOf, variant } from "./helpers.ts";

const ctx = (api: ReturnType<typeof fakeApi>): ToolContext => ({
  client: new BaseAirClient({ baseUrl: "http://api.test", apiKey: "air_t", fetch: api.fetch }),
  now: () => NOW,
});

const DISCLOSURE = { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: MCP_MODEL_LABEL };

describe("get_radar", () => {
  it("formats confidence as a percentage, hours to peak, window and acted-on count, then the raw JSON", async () => {
    const api = fakeApi([{ path: "/v1/trends/radar", body: radar }]);
    const res = await handlers.get_radar(ctx(api));
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(2);
    const text = textOf(res, 0);
    expect(text).toMatch(/Vancouver snow day\s+top_1\s+rising\s+72%\s+5\.3h\s+act within 3h\s+2/);
    expect(text).toMatch(/Budget season\s+top_2\s+peaking\s+50%\s+—\s+late; only if you add something\s+0/);
    expect(text).toMatch(/Quiet topic\s+top_3\s+no forecast\s+—/);
    expect(text).not.toContain("0.724");
    expect(text).toContain("trendTopicId");
    expect(JSON.parse(textOf(res, 1))).toEqual(radar);
  });

  it("says when the radar is empty", async () => {
    const res = await handlers.get_radar(ctx(fakeApi([{ path: "/v1/trends/radar", body: [] }])));
    expect(textOf(res)).toContain("radar is empty");
    expect(JSON.parse(textOf(res, 1))).toEqual([]);
  });

  it("pct rounds and tolerates missing values", () => {
    expect(pct(0.724)).toBe("72%");
    expect(pct(1)).toBe("100%");
    expect(pct(0.005)).toBe("1%");
    expect(pct(null)).toBe("—");
    expect(formatRadar(radar)).toContain("Confidence");
  });
});

describe("create_post", () => {
  it("states plainly that a post was blocked and lists every violation with its matches", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 201, body: blockedDetail }]);
    const res = await handlers.create_post(ctx(api), {
      body: "Results guaranteed, unlike Hootsuite",
      variants: [{ socialAccountId: "acc_x", text: "Results guaranteed, unlike Hootsuite" }],
      aiAssisted: true,
    });
    expect(res.isError).toBeUndefined();
    const text = textOf(res, 0);
    expect(text).toContain("Post pst_blocked");
    expect(text).toContain("status: blocked");
    expect(text).toContain("BLOCKED by the brand's red lines");
    expect(text).toContain("will never publish");
    expect(text).toContain("Red-line violations (2)");
    expect(text).toContain('[hard stop] Forbidden phrase — red line "p1" (forbidden_phrase); matched: "guaranteed"');
    expect(text).toContain('[needs a human] Mentions a competitor — red line "k1" (no_competitor_mention); matched: "Hootsuite"');
    expect(JSON.parse(textOf(res, 1))).toEqual(blockedDetail);
  });

  it("states plainly that a post landed in the approval queue, and sends the AI disclosure and defaults", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 201, body: pendingDetail }]);
    const res = await handlers.create_post(ctx(api), {
      body: "Snow day in Vancouver",
      variants: [{ socialAccountId: "acc_x", text: "Snow day in Vancouver: the team is working from home." }],
      aiAssisted: true,
    });
    expect(res.isError).toBeUndefined();
    const text = textOf(res, 0);
    expect(text).toContain("Created.");
    expect(text).toContain('Post pst_pending "Snow day WFH"');
    expect(text).toContain("status: pending_approval");
    expect(text).toContain("landed in the approval queue");
    expect(text).toContain("human must approve it in the Base Air app");
    expect(text).toContain("publishes at 2026-11-03T16:00:00Z");
    expect(text).toContain("Approvals: requested.");
    expect(text).not.toContain("violations");

    expect(api.last().method).toBe("POST");
    expect(api.last().headers.authorization).toBe("Bearer air_t");
    expect(api.last().body).toEqual({
      body: "Snow day in Vancouver",
      variants: [{ socialAccountId: "acc_x", text: "Snow day in Vancouver: the team is working from home.", thread: [] }],
      actionClass: "new_post",
      evidence: [],
      disclosure: DISCLOSURE,
    });
  });

  it("passes title, schedule, action class, trend context, evidence and threads through", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 201, body: pendingDetail }]);
    await handlers.create_post(ctx(api), {
      title: "Snow day",
      body: "Snow day",
      variants: [{ socialAccountId: "acc_x", text: "Part one", thread: ["Part two", "Part three"] }],
      scheduledAt: "2026-11-03T16:00:00.000Z",
      actionClass: "reply",
      trendTopicId: "top_1",
      trendStageAtCreation: "rising",
      trendForecastId: "fc_1",
      evidence: [{ kind: "activity", ref: "act_1", note: "asked by a customer" }],
      aiAssisted: false,
    });
    expect(api.last().body).toEqual({
      title: "Snow day",
      body: "Snow day",
      variants: [{ socialAccountId: "acc_x", text: "Part one", thread: ["Part two", "Part three"] }],
      scheduledAt: "2026-11-03T16:00:00.000Z",
      actionClass: "reply",
      trendTopicId: "top_1",
      trendStageAtCreation: "rising",
      trendForecastId: "fc_1",
      evidence: [{ kind: "activity", ref: "act_1", note: "asked by a customer" }],
      disclosure: { aiAssisted: false, aiContributions: [], humanReviewed: false, model: MCP_MODEL_LABEL },
    });
  });

  it("describes drafts and scheduled posts in their own words", async () => {
    const draft = { ...pendingDetail, post: post({ id: "pst_d", status: "draft" }), approvals: [] };
    const scheduled = { ...pendingDetail, post: post({ id: "pst_s", status: "scheduled", scheduledAt: "2026-11-03T16:00:00.000Z" }), approvals: [] };
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 201, respond: (req) => ((req.body as { body: string }).body === "draft" ? draft : scheduled) }]);
    const d = await handlers.create_post(ctx(api), { body: "draft", variants: [{ socialAccountId: "acc_x", text: "draft" }], aiAssisted: true });
    expect(textOf(d)).toContain("status: draft. It is saved as a draft");
    expect(textOf(d)).toContain("human must schedule it");
    const s = await handlers.create_post(ctx(api), { body: "sched", variants: [{ socialAccountId: "acc_x", text: "sched" }], aiAssisted: true });
    expect(textOf(s)).toContain("status: scheduled");
    expect(textOf(s)).toContain("Scheduled for 2026-11-03T16:00:00Z");
  });

  it("turns an autonomy refusal (403) into an isError result carrying the API message, never a throw", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 403, body: { error: { code: "forbidden", message: "autonomy for dm is suggest: the actor may not create", details: { autonomy: "suggest" } } } }]);
    const res = await handlers.create_post(ctx(api), { body: "dm", actionClass: "dm", variants: [{ socialAccountId: "acc_x", text: "dm" }], aiAssisted: true });
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    expect(textOf(res)).toContain("403 (forbidden)");
    expect(textOf(res)).toContain("autonomy for dm is suggest");
    expect(textOf(res)).toContain('"autonomy": "suggest"');
  });

  it("turns an unreachable API into an isError result", async () => {
    const c: ToolContext = { client: new BaseAirClient({ baseUrl: "http://api.test", apiKey: "air_t", fetch: failingFetch() }), now: () => NOW };
    const res = await handlers.create_post(c, { body: "x", variants: [{ socialAccountId: "acc_x", text: "x" }], aiAssisted: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("unreachable");
    expect(textOf(res)).toContain("http://api.test");
  });
});

describe("check_policy", () => {
  it("passes variants, scheduledAt and actionClass through with the same disclosure create_post records", async () => {
    const decision = { verdict: "require_approval", violations: [blockedDecision.violations[1]], autonomy: "draft", policyVersion: 3 };
    const api = fakeApi([{ method: "POST", path: "/v1/policy/check", body: decision }]);
    const res = await handlers.check_policy(ctx(api), {
      variants: [
        { network: "x", text: "Hello Hootsuite" },
        { network: "bluesky", text: "Hello again" },
      ],
      scheduledAt: "2026-11-03T02:00:00.000Z",
      actionClass: "reply",
      aiAssisted: true,
    });
    expect(api.last().method).toBe("POST");
    expect(api.last().url.pathname).toBe("/v1/policy/check");
    expect(api.last().body).toEqual({
      variants: [
        { network: "x", text: "Hello Hootsuite" },
        { network: "bluesky", text: "Hello again" },
      ],
      scheduledAt: "2026-11-03T02:00:00.000Z",
      actionClass: "reply",
      disclosure: DISCLOSURE,
    });
    expect(res.isError).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain("Verdict: require_approval");
    expect(text).toContain("human must approve");
    expect(text).toContain("Mentions a competitor");
    expect(text).toContain("Policy version 3");
    expect(JSON.parse(textOf(res, 1))).toEqual(decision);
  });

  it("omits optional fields it was not given and explains a block", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/policy/check", body: blockedDecision }]);
    const res = await handlers.check_policy(ctx(api), { variants: [{ network: "x", text: "Results guaranteed" }], aiAssisted: false });
    expect(api.last().body).toEqual({ variants: [{ network: "x", text: "Results guaranteed" }], disclosure: { aiAssisted: false, aiContributions: [], humanReviewed: false, model: MCP_MODEL_LABEL } });
    expect(textOf(res)).toContain("Verdict: block");
    expect(textOf(res)).toContain("would be BLOCKED");
    expect(textOf(res)).toContain("Violations (2)");
  });

  it("explains an allow verdict together with the autonomy that still applies", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/policy/check", body: { verdict: "allow", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 } }]);
    const res = await handlers.check_policy(ctx(api), { variants: [{ network: "x", text: "Fine" }], aiAssisted: true });
    expect(textOf(res)).toContain("Verdict: allow. No red lines crossed.");
    expect(textOf(res)).toContain("expect a human in the loop");
  });
});

describe("time windows use the injected clock", () => {
  it("search_feed turns sinceHours into an ISO since and forwards the filters", async () => {
    const api = fakeApi([{ path: "/v1/feed", body: [] }]);
    const res = await handlers.search_feed(ctx(api), { q: "snow", networks: ["x", "bluesky"], kinds: ["mention"], streamId: "str_1", sinceHours: 6, limit: 25 });
    const q = api.last().url.searchParams;
    expect(q.get("since")).toBe("2026-11-02T11:00:00.000Z");
    expect(q.get("q")).toBe("snow");
    expect(q.get("networks")).toBe("x,bluesky");
    expect(q.get("kinds")).toBe("mention");
    expect(q.get("stream")).toBe("str_1");
    expect(q.get("limit")).toBe("25");
    expect(textOf(res)).toBe("No activity matched.");
  });

  it("get_metrics_summary and get_lift_by_stage compute from/to from days", async () => {
    const summary = { window: {}, publishedByNetwork: [{ network: "x", posts: 3 }], measuredAt24h: 3, totals: { impressions: 1200, engagements: 60 }, baselineEngagements24h: 20, byNetwork: [{ key: "x", posts: 3, impressions: 1200, engagements: 60, avgEngagements: 20 }], byHour: [], byTrendStage: [{ key: "rising", posts: 1, impressions: 800, engagements: 40, avgEngagements: 40 }], byAuthor: [], byExperiment: [], top: [] };
    const api = fakeApi([
      { path: "/v1/metrics/summary", body: summary },
      { path: "/v1/metrics/lift-by-stage", body: [{ stage: "rising", posts: 1, avgEngagements: 40, lift: 2 }] },
    ]);
    const s = await handlers.get_metrics_summary(ctx(api), { days: 7 });
    expect(api.last().url.searchParams.get("from")).toBe("2026-10-26T17:00:00.000Z");
    expect(api.last().url.searchParams.get("to")).toBe("2026-11-02T17:00:00.000Z");
    expect(textOf(s)).toContain("last 7 days");
    expect(textOf(s)).toContain("1,200 impressions, 60 engagements");
    expect(textOf(s)).toMatch(/rising\s+1\s+800\s+40\s+40\s+2\.00x/);

    const l = await handlers.get_lift_by_stage(ctx(api), { days: 30 });
    expect(api.last().url.searchParams.get("from")).toBe("2026-10-03T17:00:00.000Z");
    expect(textOf(l)).toMatch(/rising\s+1\s+40\s+2\.00x/);
  });
});

describe("read tools", () => {
  it("get_brand_context renders autonomy and red lines in plain language, accounts with ids, and voice examples", async () => {
    const api = fakeApi([{ path: "/v1/context", body: context }]);
    const res = await handlers.get_brand_context(ctx(api));
    const text = textOf(res);
    expect(text).toContain("# Acme");
    expect(text).toContain("Acme makes snow tires");
    expect(text).toContain("new_post: schedule with approval: you may propose and schedule, but nothing publishes until a human approves");
    expect(text).toContain("dm: suggest only");
    expect(text).toContain("[hard stop] No guarantees (forbidden_phrase, id p1)");
    expect(text).toContain("[needs a human] Quiet overnight (quiet_hours, id q1)");
    expect(text).toContain("x @acme (Acme): id acc_x, active");
    expect(text).toContain("bluesky @acme.bsky.social: id acc_b, reauth_required — do not target this account");
    expect(text).toContain('before: "We are thrilled to announce our new tires!"');
    expect(text).toContain('after:  "New today: a tire built for slush."');
    expect(text).toMatch(/Vancouver snow day\s+top_1\s+rising\s+72%/);
    expect(text).toContain("check_policy");
    expect(JSON.parse(textOf(res, 1))).toEqual(context);
  });

  it("get_queue, get_post, list_posts, list_alerts, get_latest_brief, get_ledger, get_policy", async () => {
    const history = [{ id: "evt_1", seq: 7, workspaceId: "ws_1", type: "post.created", subjectType: "post", subjectId: "pst_pending", actor: { type: "mcp", id: "claude" }, data: { status: "pending_approval" }, occurredAt: "2026-11-02T17:00:00.000Z" }];
    const policy = { version: 3, autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" }, requireApprovalForEditors: true, redLines: [{ id: "p1", kind: "forbidden_phrase", description: "No guarantees", severity: "block", phrases: ["guaranteed"] }, { id: "q1", kind: "quiet_hours", description: "Quiet overnight", severity: "require_approval", timezone: "America/Vancouver", startHour: 22, endHour: 6, days: [] }], spendCaps: { xReadsUsdMonthly: 50, modelUsdMonthly: 100 }, disclosure: { recordAlways: true, signMedia: true, visibleTextForAi: "#AIassisted" }, competitors: ["Hootsuite"], timezone: "America/Vancouver" };
    const api = fakeApi([
      { path: "/v1/posts/queue", body: [{ post: pendingDetail.post, variants: pendingDetail.variants }] },
      { path: "/v1/posts/pst_pending", body: { ...pendingDetail, history } },
      { path: "/v1/posts", body: [{ post: blockedDetail.post, variants: blockedDetail.variants }] },
      { path: "/v1/alerts", body: alerts },
      { path: "/v1/briefs/latest", body: brief },
      { path: "/v1/ledger", body: history },
      { path: "/v1/policy", body: policy },
    ]);
    const c = ctx(api);

    const queue = await handlers.get_queue(c);
    expect(textOf(queue)).toContain("1 post waiting on a human");
    expect(textOf(queue)).toContain("pst_pending [pending_approval] x by mcp:claude");

    const detail = await handlers.get_post(c, { postId: "pst_pending" });
    expect(textOf(detail)).toContain("History (1 ledger event)");
    expect(textOf(detail)).toContain("#7 2026-11-02T17:00:00Z post.created by mcp:claude");

    const list = await handlers.list_posts(c, { status: ["blocked"], limit: 20 });
    expect(api.last().url.searchParams.get("status")).toBe("blocked");
    expect(textOf(list)).toContain("pst_blocked [blocked]");

    const al = await handlers.list_alerts(c, { unacknowledgedOnly: true, limit: 50 });
    expect(api.last().url.searchParams.get("unacknowledged")).toBe("1");
    expect(textOf(al)).toContain("[URGENT] Mentions up 5x");
    expect(textOf(al)).toContain("recall rumour");

    const b = await handlers.get_latest_brief(c);
    expect(textOf(b)).toContain("# Week in review");

    const led = await handlers.get_ledger(c, { types: ["post.created"], subjectType: "post", subjectId: "pst_pending", limit: 50 });
    expect(api.last().url.searchParams.get("types")).toBe("post.created");
    expect(textOf(led)).toContain("#7 2026-11-02T17:00:00Z post.created post/pst_pending by mcp:claude");

    const pol = await handlers.get_policy(c);
    expect(textOf(pol)).toContain("Policy v3 (timezone America/Vancouver)");
    expect(textOf(pol)).toContain('[hard stop] No guarantees — forbidden_phrase: phrases: "guaranteed" (id p1)');
    expect(textOf(pol)).toContain("no publishing 22:00–06:00 America/Vancouver every day");
    expect(textOf(pol)).toContain('visible text "#AIassisted"');
  });

  it("schedule_post and cancel_post lead with what happened", async () => {
    const scheduled = { ...pendingDetail, post: post({ id: "pst_pending", status: "scheduled", scheduledAt: "2026-11-03T16:00:00.000Z" }) };
    const cancelled = { ...pendingDetail, post: post({ id: "pst_pending", status: "cancelled" }), variants: [variant({ status: "skipped" })] };
    const api = fakeApi([
      { method: "POST", path: "/v1/posts/pst_pending/schedule", body: scheduled },
      { method: "POST", path: "/v1/posts/pst_pending/cancel", body: cancelled },
    ]);
    const s = await handlers.schedule_post(ctx(api), { postId: "pst_pending", at: "2026-11-03T16:00:00.000Z" });
    expect(api.last().body).toEqual({ at: "2026-11-03T16:00:00.000Z" });
    expect(textOf(s)).toContain("Schedule requested. Post pst_pending — status: scheduled");
    const x = await handlers.cancel_post(ctx(api), { postId: "pst_pending" });
    expect(textOf(x)).toContain("Cancelled. Post pst_pending — status: cancelled. It is cancelled and will not publish.");
  });
});
