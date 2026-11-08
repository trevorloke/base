/** A fake Base Air API: an injectable `fetch` that records calls and answers from a route table. No network. */
import { vi } from "vitest";
import type { PolicyDecision } from "@base-air/schema";
import type { Alert, BrandContext, Brief, Post, PostDetail, PostVariant, RadarEntry } from "../src/types.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export interface Captured {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface Route {
  method?: string;
  path: string | RegExp;
  status?: number;
  /** JSON payload (also `null`). */
  body?: unknown;
  /** Compute the JSON payload from the captured request. */
  respond?: (req: Captured) => unknown;
  /** Send this raw text instead of JSON. */
  raw?: string;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function fakeApi(routes: Route[]) {
  const calls: Captured[] = [];
  const impl = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const captured: Captured = { method, url, headers, body };
    calls.push(captured);
    const route = routes.find((r) => (r.method ?? "GET").toUpperCase() === method && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)));
    if (!route) return jsonResponse(404, { error: { code: "not_found", message: `no fake route for ${method} ${url.pathname}` } });
    if (route.raw !== undefined) return new Response(route.raw, { status: route.status ?? 200, headers: { "content-type": "text/plain" } });
    if (route.status === 204) return new Response(null, { status: 204 });
    const payload = route.respond ? route.respond(captured) : route.body;
    return jsonResponse(route.status ?? 200, payload ?? null);
  };
  const fetch = vi.fn(impl);
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    last(): Captured {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("no request was made");
      return c;
    },
  };
}

export function failingFetch(message = "fetch failed"): typeof globalThis.fetch {
  const impl = async (): Promise<Response> => {
    throw new TypeError(message, { cause: new Error("connect ECONNREFUSED 127.0.0.1:4000") });
  };
  return impl as unknown as typeof globalThis.fetch;
}

/** Text of the i-th content block of a tool result. */
export function textOf(res: { content: unknown[] }, i = 0): string {
  const c = res.content[i] as { type?: string; text?: unknown } | undefined;
  if (!c || c.type !== "text" || typeof c.text !== "string") throw new Error(`content[${i}] is not a text block: ${JSON.stringify(c)}`);
  return c.text;
}

// ---- fixtures ---------------------------------------------------------------------------------

export const NOW = new Date("2026-11-02T17:00:00.000Z");

export const radar: RadarEntry[] = [
  {
    topic: { id: "top_1", workspaceId: "ws_1", name: "Vancouver snow day", keywords: ["snow", "yvr"], relevance: 0.8 },
    forecast: {
      id: "fc_1",
      stage: "rising",
      confidence: 0.724,
      velocity: 0.31,
      hoursToPeak: 5.25,
      computedAt: "2026-11-02T16:00:00.000Z",
      sources: ["google_trends", "bluesky_firehose"],
      sourceAgreement: 0.9,
      curve: [{ at: "2026-11-02T17:00:00.000Z", value: 10, lo: 8, hi: 12 }],
    },
    actedOn: 2,
    score: 0.58,
    window: "act within 3h",
  },
  {
    topic: { id: "top_2", workspaceId: null, name: "Budget season", keywords: ["budget"], relevance: null },
    forecast: { id: "fc_2", stage: "peaking", confidence: 0.5, velocity: 0, hoursToPeak: null, computedAt: "2026-11-02T16:00:00.000Z", sources: ["news"], sourceAgreement: null, curve: [] },
    actedOn: 0,
    score: 0.25,
    window: "late; only if you add something",
  },
  { topic: { id: "top_3", workspaceId: "ws_1", name: "Quiet topic", keywords: [], relevance: 0.2 }, forecast: null, actedOn: 0, score: 0, window: null },
];

export function post(overrides: Partial<Post> = {}): Post {
  return {
    id: "pst_1",
    workspaceId: "ws_1",
    status: "pending_approval",
    title: null,
    body: "Snow day",
    media: [],
    scheduledAt: null,
    publishedAt: null,
    actionClass: "new_post",
    createdBy: { type: "mcp", id: "claude" },
    trendTopicId: null,
    trendStageAtCreation: null,
    trendForecastId: null,
    experimentId: null,
    experimentArm: null,
    disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "mcp-client" },
    evidence: [],
    policyDecision: null,
    createdAt: "2026-11-02T17:00:00.000Z",
    updatedAt: "2026-11-02T17:00:00.000Z",
    ...overrides,
  };
}

export function variant(overrides: Partial<PostVariant> = {}): PostVariant {
  return {
    id: "var_1",
    postId: "pst_1",
    socialAccountId: "acc_x",
    options: {},
    replyToExternalId: null,
    network: "x",
    text: "Snow day",
    media: [],
    thread: [],
    status: "pending",
    externalId: null,
    externalUrl: null,
    publishedAt: null,
    error: null,
    attemptCount: 0,
    ...overrides,
  };
}

export const blockedDecision: PolicyDecision = {
  verdict: "block",
  violations: [
    { redLineId: "p1", kind: "forbidden_phrase", severity: "block", message: "Forbidden phrase", matches: ["guaranteed"] },
    { redLineId: "k1", kind: "no_competitor_mention", severity: "require_approval", message: "Mentions a competitor", matches: ["Hootsuite"] },
  ],
  autonomy: "schedule_with_approval",
  policyVersion: 3,
};

export const blockedDetail: PostDetail = {
  post: post({ id: "pst_blocked", status: "blocked", body: "Results guaranteed, unlike Hootsuite", policyDecision: blockedDecision }),
  variants: [variant({ id: "var_b", postId: "pst_blocked", text: "Results guaranteed, unlike Hootsuite" })],
  approvals: [],
};

export const pendingDetail: PostDetail = {
  post: post({
    id: "pst_pending",
    status: "pending_approval",
    title: "Snow day WFH",
    scheduledAt: "2026-11-03T16:00:00.000Z",
    policyDecision: { verdict: "allow", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 },
  }),
  variants: [variant({ id: "var_p", postId: "pst_pending", text: "Snow day in Vancouver: the team is working from home. Here is what that looks like." })],
  approvals: [{ id: "apr_1", postId: "pst_pending", state: "requested", requestedBy: { type: "mcp", id: "claude" }, decidedBy: null, decidedAt: null, note: null, createdAt: "2026-11-02T17:00:00.000Z" }],
};

export const context: BrandContext = {
  workspace: {
    name: "Acme",
    profile: {
      description: "Acme makes snow tires for city drivers.",
      audience: "Urban commuters in Canada",
      topics: ["winter driving", "road safety"],
      voice: { do: ["be direct", "use numbers"], dont: ["no hype", "no exclamation marks"] },
      competitors: ["Hootsuite"],
    },
  },
  policy: {
    autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" },
    redLines: [
      { id: "p1", kind: "forbidden_phrase", description: "No guarantees", severity: "block" },
      { id: "q1", kind: "quiet_hours", description: "Quiet overnight", severity: "require_approval" },
    ],
    timezone: "America/Vancouver",
  },
  accounts: [
    { id: "acc_x", network: "x", externalId: "123", handle: "acme", displayName: "Acme", connector: "x", status: "active", hasCredentials: true, lastIngestAt: null, config: {} },
    { id: "acc_b", network: "bluesky", externalId: "did:plc:1", handle: "acme.bsky.social", displayName: null, connector: "bluesky", status: "reauth_required", hasCredentials: true, lastIngestAt: null, config: {} },
  ],
  recentTop: [{ postId: "pst_9", variantId: "var_9", network: "x", text: "Winter tires: when to switch", impressions: 1000, engagements: 50, lift: 1.4 }],
  voiceExamples: [{ before: "We are thrilled to announce our new tires!", after: "New today: a tire built for slush." }],
  activeTopics: radar.slice(0, 1),
};

export const alerts: Alert[] = [
  { id: "alr_1", kind: "mention_spike", severity: "urgent", title: "Mentions up 5x", body: "Mostly about the recall rumour.", evidence: null, topicId: null, acknowledgedAt: null, createdAt: "2026-11-02T16:30:00.000Z" },
];

export const brief: Brief = {
  id: "brf_1",
  periodStart: "2026-10-26T00:00:00.000Z",
  periodEnd: "2026-11-02T00:00:00.000Z",
  contentMd: "# Week in review\n\nSnow day drove 40% of engagement.",
  evidence: null,
  runId: null,
  createdAt: "2026-11-02T06:00:00.000Z",
};
