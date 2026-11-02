// Fixture data for developing and screenshotting the room without the API (VITE_USE_FIXTURES=1).
// Everything here is plausible, deterministic, and relative to the moment the page loads.

import type {
  Account,
  Activity,
  ActivityKind,
  Alert,
  Approval,
  Brief,
  DecideInput,
  FeedQuery,
  Forecast,
  ForecastPoint,
  LedgerEvent,
  LiftByStage,
  Me,
  Network,
  Policy,
  Post,
  PostDetail,
  PostFull,
  PostSummary,
  RadarEntry,
  SeriesPoint,
  Stream,
  Summary,
  TopicDetail,
  TopicSeries,
  TrendStage,
  Variant,
  Violation,
  Workspace,
} from "../types";
import type { StreamHandlers } from "../api";
import { ApiError } from "../lib/errors";

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (hours: number) => iso(NOW - hours * HOUR);
const ahead = (hours: number) => iso(NOW + hours * HOUR);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const delay = <T,>(v: T, ms = 140) => new Promise<T>((resolve) => setTimeout(() => resolve(clone(v)), ms));

// --- Workspace, accounts, streams, policy -------------------------------

const workspace: Workspace = {
  id: "ws_northwind",
  slug: "northwind",
  name: "Northwind Coffee",
  profile: {
    description: "Specialty roaster in Portland with four cafés and a wholesale program.",
    audience: "People who care where their coffee comes from and don't want to be sold to.",
    topics: ["cold brew", "seasonal menu", "sourcing", "home brewing"],
    voice: { do: ["plain words", "specific numbers", "dry humor"], dont: ["hype", "exclamation marks", "trend-chasing"], examples: [] },
    competitors: ["Blue Bottle", "Stumptown", "Starbucks"],
  },
  settings: {},
  createdAt: ago(24 * 90),
};

const me: Me = { workspace, actor: { type: "human", id: "dev" }, role: "owner" };

const accounts: Account[] = [
  { id: "acc_x", network: "x", externalId: "1842", handle: "northwindcoffee", displayName: "Northwind Coffee", connector: "x_api", status: "active", hasCredentials: true, lastIngestAt: ago(0.1), config: {} },
  { id: "acc_bsky", network: "bluesky", externalId: "did:plc:nw", handle: "northwind.coffee", displayName: "Northwind Coffee", connector: "bluesky", status: "active", hasCredentials: true, lastIngestAt: ago(0.2), config: {} },
  { id: "acc_ig", network: "instagram", externalId: "17841", handle: "northwindcoffee", displayName: "Northwind Coffee", connector: "zernio", status: "reauth_required", hasCredentials: true, lastIngestAt: ago(9), config: {} },
];

const streams: Stream[] = [
  { id: "st_brand", name: "Brand mentions", query: { keywords: ["northwind", "northwind coffee"], authors: [], networks: [], kinds: [] }, createdAt: ago(24 * 60) },
  { id: "st_comp", name: "Competitor watch", query: { keywords: ["blue bottle", "stumptown", "starbucks"], authors: [], networks: [], kinds: [] }, createdAt: ago(24 * 40) },
  { id: "st_psl", name: "Pumpkin spice", query: { keywords: ["pumpkin spice", "psl"], authors: [], networks: [], kinds: [] }, createdAt: ago(24 * 3) },
];

const policy: Policy = {
  version: 3,
  autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" },
  requireApprovalForEditors: true,
  redLines: [
    { id: "rl_comp", kind: "no_competitor_mention", description: "Never name a competitor in our own posts or replies", severity: "require_approval", competitors: ["Blue Bottle", "Stumptown", "Starbucks"] },
    { id: "rl_health", kind: "forbidden_claim", description: "No health, energy or weight-loss claims about coffee", severity: "block", patterns: ["(cures?|heals?|burns? fat|weight loss|detox)"] },
    { id: "rl_guarantee", kind: "forbidden_phrase", description: "Never promise guaranteed results", severity: "block", phrases: ["guaranteed", "guarantee"] },
    { id: "rl_quiet", kind: "quiet_hours", description: "Nothing goes out between 10pm and 7am Pacific", severity: "require_approval", timezone: "America/Los_Angeles", startHour: 22, endHour: 7, days: [] },
    { id: "rl_disclose", kind: "required_disclosure", description: "AI-assisted posts carry #AIassisted", severity: "warn", requiredText: "#AIassisted", when: "ai_assisted" },
  ],
  competitors: ["Blue Bottle", "Stumptown", "Starbucks"],
  timezone: "America/Los_Angeles",
};

// --- Curves ------------------------------------------------------------
// tau is a position on one timeline: 0 = 48h ago, 1 = now, 1.5 = 24h ahead. Shapes return a 0..1 level.

type Shape = (tau: number) => number;
const bump =
  (peak: number, sigma: number, base: number, amp: number): Shape =>
  (tau) =>
    base + amp * Math.exp(-((tau - peak) ** 2) / (2 * sigma * sigma));

const SHAPES: Record<TrendStage, Shape> = {
  rising: bump(1.25, 0.2, 0.08, 0.82),
  peaking: bump(1.03, 0.28, 0.1, 0.78),
  plateau: (tau) => 0.55 + 0.03 * Math.sin(tau * 14),
  fading: bump(0.55, 0.26, 0.08, 0.7),
  dormant: (tau) => 0.07 + 0.015 * Math.sin(tau * 9),
};

const noise = (tau: number, seed: number) => 0.025 * Math.sin(tau * 31 + seed) + 0.015 * Math.sin(tau * 73 + seed * 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function forecastCurve(stage: TrendStage, confidence: number, seed: number): ForecastPoint[] {
  const shape = SHAPES[stage];
  const points: ForecastPoint[] = [];
  for (let i = 0; i <= 12; i++) {
    const hours = i * 2;
    const tau = 1 + hours / 48;
    const value = 100 * clamp01(shape(tau) + noise(tau, seed));
    const width = 100 * (0.05 + (1 - confidence) * 0.3) * (0.35 + (0.65 * i) / 12);
    points.push({
      at: ahead(hours),
      value: round1(value),
      lo: round1(Math.max(0, value - width * 0.9)),
      hi: round1(value + width * 1.1),
    });
  }
  return points;
}

function historySeries(stage: TrendStage, sources: { source: string; scale: number }[], seed: number): TopicSeries[] {
  const shape = SHAPES[stage];
  return sources.map(({ source, scale }, idx) => {
    const points: SeriesPoint[] = [];
    for (let i = 0; i < 48; i++) {
      const tau = i / 47;
      const lagged = tau - 0.02 * idx;
      const level = clamp01(shape(lagged) + noise(tau, seed + idx * 7) * (1 + idx * 0.5));
      points.push({ t: ago(47 - i), v: round1(level * scale) });
    }
    return { source, points };
  });
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// --- Topics --------------------------------------------------------------

interface TopicSpec {
  id: string;
  name: string;
  keywords: string[];
  relevance: number;
  stage: TrendStage;
  confidence: number;
  velocity: number;
  hoursToPeak: number | null;
  sources: { source: string; scale: number }[];
  agreement: number | null;
  actedOn: number;
  score: number;
  window: string | null;
  seed: number;
}

const TOPICS: TopicSpec[] = [
  {
    id: "tp_psl",
    name: "Pumpkin spice backlash",
    keywords: ["pumpkin spice", "psl", "too early"],
    relevance: 0.86,
    stage: "rising",
    confidence: 0.78,
    velocity: 0.14,
    hoursToPeak: 6,
    sources: [
      { source: "google_trends", scale: 100 },
      { source: "bluesky_firehose", scale: 420 },
      { source: "own_feed", scale: 40 },
    ],
    agreement: 0.81,
    actedOn: 1,
    score: 0.91,
    window: "act within 6h",
    seed: 1,
  },
  {
    id: "tp_coldbrew",
    name: "Cold brew at home",
    keywords: ["cold brew", "cold brew ratio", "home cold brew"],
    relevance: 0.79,
    stage: "peaking",
    confidence: 0.66,
    velocity: 0.03,
    hoursToPeak: 1.4,
    sources: [
      { source: "google_trends", scale: 100 },
      { source: "youtube_trending", scale: 60 },
      { source: "reddit", scale: 180 },
    ],
    agreement: 0.7,
    actedOn: 2,
    score: 0.74,
    window: "act within 2h",
    seed: 2,
  },
  {
    id: "tp_oatmilk",
    name: "Oat milk shortage",
    keywords: ["oat milk", "oatly shortage"],
    relevance: 0.58,
    stage: "plateau",
    confidence: 0.52,
    velocity: 0,
    hoursToPeak: null,
    sources: [
      { source: "news", scale: 30 },
      { source: "x", scale: 250 },
    ],
    agreement: 0.55,
    actedOn: 0,
    score: 0.48,
    window: null,
    seed: 3,
  },
  {
    id: "tp_dirtychai",
    name: "Dirty chai",
    keywords: ["dirty chai", "chai latte espresso"],
    relevance: 0.64,
    stage: "fading",
    confidence: 0.61,
    velocity: -0.09,
    hoursToPeak: null,
    sources: [
      { source: "tiktok_creative_center", scale: 100 },
      { source: "bluesky_firehose", scale: 300 },
    ],
    agreement: 0.64,
    actedOn: 3,
    score: 0.33,
    window: "window closing",
    seed: 4,
  },
  {
    id: "tp_coffeeday",
    name: "World Coffee Day",
    keywords: ["world coffee day", "international coffee day"],
    relevance: 0.4,
    stage: "dormant",
    confidence: 0.28,
    velocity: 0,
    hoursToPeak: null,
    sources: [{ source: "wikipedia_pageviews", scale: 900 }],
    agreement: null,
    actedOn: 0,
    score: 0.09,
    window: null,
    seed: 5,
  },
];

function forecastOf(t: TopicSpec): Forecast {
  return {
    id: `fc_${t.id}`,
    stage: t.stage,
    confidence: t.confidence,
    velocity: t.velocity,
    hoursToPeak: t.hoursToPeak,
    computedAt: ago(0.25),
    sources: t.sources.map((s) => s.source),
    sourceAgreement: t.agreement,
    curve: forecastCurve(t.stage, t.confidence, t.seed),
  };
}

const radar: RadarEntry[] = TOPICS.map((t) => ({
  topic: { id: t.id, workspaceId: workspace.id, name: t.name, keywords: t.keywords, relevance: t.relevance, createdAt: ago(24 * 20) },
  forecast: forecastOf(t),
  actedOn: t.actedOn,
  score: t.score,
  window: t.window,
}));

// --- Posts ---------------------------------------------------------------

function variant(
  id: string,
  postId: string,
  accountId: string,
  network: Network,
  text: string,
  extra: Partial<Variant> = {},
): Variant {
  return {
    id,
    postId,
    socialAccountId: accountId,
    network,
    text,
    media: [],
    thread: [],
    status: "pending",
    externalId: null,
    externalUrl: null,
    publishedAt: null,
    error: null,
    attemptCount: 0,
    ...extra,
  };
}

const basePost: Pick<Post, "workspaceId" | "media" | "publishedAt" | "experimentId" | "experimentArm" | "trendForecastId"> = {
  workspaceId: workspace.id,
  media: [],
  publishedAt: null,
  experimentId: null,
  experimentArm: null,
  trendForecastId: null,
};

const queueSeed: PostSummary[] = [
  {
    post: {
      ...basePost,
      id: "p_psl",
      status: "pending_approval",
      title: "Pumpkin spice, but honest",
      body: "We don't do pumpkin spice. We do a maple-cardamom cortado for exactly six weeks, and then it's gone. Fall doesn't need a syrup.",
      scheduledAt: ahead(3),
      actionClass: "new_post",
      createdBy: { type: "operator", id: "watch" },
      trendTopicId: "tp_psl",
      trendStageAtCreation: "rising",
      trendForecastId: "fc_tp_psl",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "claude-opus-5-5", promptVersion: "watch/3" },
      evidence: [
        { kind: "forecast", ref: "Pumpkin spice backlash · rising", note: "78% confidence, peak in ~6h, 3 sources agree" },
        { kind: "mentions", ref: "https://bsky.app/search?q=pumpkin+spice+too+early", note: "41 mentions in the last 3h; 68% are 'too early' complaints" },
        { kind: "past_post", ref: "https://x.com/northwindcoffee/status/1710000000000000001", note: "Last year's 'no PSL' post did 2.4x our baseline" },
      ],
      policyDecision: { verdict: "require_approval", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 },
      createdAt: ago(1.5),
      updatedAt: ago(1.5),
    },
    variants: [
      variant("v_psl_x", "p_psl", "acc_x", "x", "We don't do pumpkin spice. We do a maple-cardamom cortado for exactly six weeks, then it's gone. Fall doesn't need a syrup. #AIassisted"),
      variant("v_psl_bsky", "p_psl", "acc_bsky", "bluesky", "Not doing pumpkin spice this year either. Maple-cardamom cortado, six weeks, then gone. Fall doesn't need a syrup. #AIassisted"),
    ],
  },
  {
    post: {
      ...basePost,
      id: "p_reply_mara",
      status: "pending_approval",
      title: null,
      body: "Reply to @mara.k about which beans to use for cold brew.",
      scheduledAt: null,
      actionClass: "reply",
      createdBy: { type: "mcp", id: "claude-desktop" },
      trendTopicId: "tp_coldbrew",
      trendStageAtCreation: "peaking",
      trendForecastId: "fc_tp_coldbrew",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "claude-opus-5-5" },
      evidence: [
        { kind: "activity", ref: "https://bsky.app/profile/mara.k/post/3l5k2", note: "@mara.k asked which beans we'd recommend for cold brew" },
        { kind: "forecast", ref: "Cold brew at home · peaking", note: "66% confidence, peak in ~1h" },
      ],
      policyDecision: {
        verdict: "require_approval",
        violations: [{ redLineId: "rl_comp", kind: "no_competitor_mention", severity: "require_approval", message: "Names a competitor: Blue Bottle", matches: ["Blue Bottle"] }],
        autonomy: "draft",
        policyVersion: 3,
      },
      createdAt: ago(0.3),
      updatedAt: ago(0.3),
    },
    variants: [
      variant("v_mara_bsky", "p_reply_mara", "acc_bsky", "bluesky", "@mara.k the Ethiopian (Guji) is the one — 1:8 ratio, 16h in the fridge. If you want something closer to Blue Bottle's, our Brazil blend is the nearest thing."),
      variant("v_mara_x", "p_reply_mara", "acc_x", "x", "The Ethiopian Guji, 1:8, 16 hours in the fridge. Closer to Blue Bottle's style? Try the Brazil blend."),
    ],
  },
  {
    post: {
      ...basePost,
      id: "p_menu",
      status: "pending_approval",
      title: "Fall menu goes live Thursday",
      body: "Thursday: the fall menu. Maple-cardamom cortado, brown butter oat latte, and the Guji is back on espresso.",
      scheduledAt: ahead(30),
      actionClass: "new_post",
      createdBy: { type: "human", id: "marta" },
      trendTopicId: null,
      trendStageAtCreation: null,
      disclosure: { aiAssisted: false, aiContributions: [], humanReviewed: true, reviewedBy: "marta" },
      evidence: [{ kind: "calendar", ref: "Fall menu launch · Thursday 7am", note: "Menu goes live at all four cafés" }],
      policyDecision: { verdict: "require_approval", violations: [], policyVersion: 3 },
      createdAt: ago(5),
      updatedAt: ago(5),
    },
    variants: [
      variant("v_menu_x", "p_menu", "acc_x", "x", "Thursday: the fall menu. Maple-cardamom cortado, brown butter oat latte, and the Guji is back on espresso."),
      variant("v_menu_bsky", "p_menu", "acc_bsky", "bluesky", "Thursday: the fall menu. Maple-cardamom cortado, brown butter oat latte, and the Guji is back on espresso. Come early; the cortado runs out by 10."),
      variant("v_menu_ig", "p_menu", "acc_ig", "instagram", "Fall menu, Thursday. Maple-cardamom cortado. Brown butter oat latte. Guji back on espresso. All four cafés, 7am.", {
        media: [{ kind: "image", url: "https://images.northwind.coffee/fall-menu.jpg", alt: "Three drinks on a walnut counter" }],
      }),
    ],
  },
];

const IG_ERROR = "Instagram via Zernio: the account's token expired and the post was refused (401 unauthorized). Reconnect the account and retry.";

const published: PostSummary[] = [
  {
    post: {
      ...basePost,
      id: "p_ratio",
      status: "partially_published",
      title: "Cold brew ratio card",
      body: "1:8 coffee to water, coarse grind, 16 hours in the fridge. Dilute to taste. That's the whole recipe.",
      scheduledAt: ago(28),
      publishedAt: ago(28),
      actionClass: "new_post",
      createdBy: { type: "operator", id: "watch" },
      trendTopicId: "tp_coldbrew",
      trendStageAtCreation: "rising",
      trendForecastId: "fc_tp_coldbrew_prev",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted", "text_edited"], humanReviewed: true, reviewedBy: "marta", model: "claude-opus-5-5" },
      evidence: [{ kind: "forecast", ref: "Cold brew at home · rising", note: "71% confidence at the time, peak in ~30h" }],
      policyDecision: { verdict: "require_approval", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 },
      createdAt: ago(30.5),
      updatedAt: ago(28),
    },
    variants: [
      variant("v_ratio_x", "p_ratio", "acc_x", "x", "Cold brew, the whole recipe: 1:8 coffee to water, coarse grind, 16 hours in the fridge. Dilute to taste. #AIassisted", {
        status: "published",
        externalId: "1842000000000000002",
        externalUrl: "https://x.com/northwindcoffee/status/1842000000000000002",
        publishedAt: ago(28),
        attemptCount: 1,
      }),
      variant("v_ratio_bsky", "p_ratio", "acc_bsky", "bluesky", "Cold brew, the whole recipe: 1:8, coarse grind, 16 hours in the fridge. Dilute to taste. #AIassisted", {
        status: "published",
        externalId: "3l7m",
        externalUrl: "https://bsky.app/profile/northwind.coffee/post/3l7m",
        publishedAt: ago(28),
        attemptCount: 1,
      }),
      variant("v_ratio_ig", "p_ratio", "acc_ig", "instagram", "1:8. Coarse. 16 hours in the fridge. Dilute to taste. #AIassisted", {
        status: "failed",
        error: IG_ERROR,
        attemptCount: 3,
        media: [{ kind: "image", url: "https://images.northwind.coffee/ratio-card.jpg", alt: "Ratio card" }],
      }),
    ],
  },
  publishedSimple("p_chai_iced", "Dirty chai, iced", "Dirty chai, iced: double shot over masala chai concentrate, oat milk, lots of ice.", "tp_dirtychai", "rising", 70),
  publishedSimple("p_chai_explained", "Dirty chai, explained", "A dirty chai is a chai latte with a shot of espresso in it. Ours uses our own masala concentrate.", "tp_dirtychai", "peaking", 40),
  publishedSimple("p_chai_ratio", "Dirty chai: the ratio", "Dirty chai at home: 1 shot, 120ml chai concentrate, 120ml milk. Don't overthink it.", "tp_dirtychai", "fading", 20),
];

function publishedSimple(id: string, title: string, body: string, topicId: string, stage: TrendStage, hoursAgo: number): PostSummary {
  return {
    post: {
      ...basePost,
      id,
      status: "published",
      title,
      body,
      scheduledAt: ago(hoursAgo),
      publishedAt: ago(hoursAgo),
      actionClass: "new_post",
      createdBy: { type: "operator", id: "watch" },
      trendTopicId: topicId,
      trendStageAtCreation: stage,
      trendForecastId: `fc_${topicId}_${hoursAgo}`,
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: true, reviewedBy: "dev", model: "claude-opus-5-5" },
      evidence: [{ kind: "forecast", ref: `Dirty chai · ${stage}`, note: "Operator proposal" }],
      policyDecision: { verdict: "require_approval", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 },
      createdAt: ago(hoursAgo + 2),
      updatedAt: ago(hoursAgo),
    },
    variants: [
      variant(`${id}_x`, id, "acc_x", "x", `${body} #AIassisted`, { status: "published", externalId: `${hoursAgo}001`, externalUrl: `https://x.com/northwindcoffee/status/18420000000000${hoursAgo}1`, publishedAt: ago(hoursAgo), attemptCount: 1 }),
      variant(`${id}_bsky`, id, "acc_bsky", "bluesky", `${body} #AIassisted`, { status: "published", externalId: `3l${hoursAgo}`, externalUrl: `https://bsky.app/profile/northwind.coffee/post/3l${hoursAgo}`, publishedAt: ago(hoursAgo), attemptCount: 1 }),
    ],
  };
}

const OUTCOMES: Record<string, Record<string, unknown> | null> = {
  p_ratio: { impressions: 18400, engagements: 612, lift: 2.3 },
  p_chai_iced: { impressions: 14200, engagements: 540, lift: 2.0 },
  p_chai_explained: { impressions: 9100, engagements: 203, lift: 0.8 },
  p_chai_ratio: null,
  p_psl: null,
  p_reply_mara: null,
};

// --- Ledger history ------------------------------------------------------

let seq = 1000;
function ev(type: string, subjectId: string, actor: LedgerEvent["actor"], occurredAt: string, data: Record<string, unknown> = {}): LedgerEvent {
  seq += 1;
  return { id: `le_${seq}`, seq, workspaceId: workspace.id, type, subjectType: "post", subjectId, actor, data, occurredAt };
}

function historyFor(item: PostSummary): LedgerEvent[] {
  const { post, variants } = item;
  const sys = { type: "system" as const, id: "system" };
  const out: LedgerEvent[] = [
    ev("post.created", post.id, post.createdBy, post.createdAt, { actionClass: post.actionClass }),
    ev("policy.evaluated", post.id, sys, post.createdAt, { verdict: post.policyDecision?.verdict ?? "allow", violations: post.policyDecision?.violations.length ?? 0 }),
  ];
  if (post.status === "pending_approval") {
    out.push(ev("post.approval_requested", post.id, post.createdBy, post.createdAt));
    return out;
  }
  const approvedAt = iso(Date.parse(post.createdAt) + 1.5 * HOUR);
  out.push(ev("post.approval_requested", post.id, post.createdBy, post.createdAt));
  out.push(ev("post.approval_decided", post.id, { type: "human", id: post.disclosure?.reviewedBy ?? "dev" }, approvedAt, { decision: "approve", edits: post.id === "p_ratio" ? 1 : 0 }));
  if (post.scheduledAt) out.push(ev("post.scheduled", post.id, sys, approvedAt, { at: post.scheduledAt }));
  if (post.publishedAt) {
    out.push(ev("post.publish_started", post.id, sys, post.publishedAt));
    for (const v of variants) {
      if (v.status === "published") out.push(ev("variant.published", post.id, sys, v.publishedAt ?? post.publishedAt, { network: v.network, externalUrl: v.externalUrl }));
      if (v.status === "failed") out.push(ev("variant.failed", post.id, sys, post.publishedAt, { network: v.network, error: v.error, attempt: v.attemptCount }));
    }
    out.push(ev(post.status === "partially_published" ? "post.failed" : "post.published", post.id, sys, post.publishedAt, { status: post.status }));
    const outcome = OUTCOMES[post.id];
    if (outcome) out.push(ev("outcome.captured", post.id, sys, iso(Date.parse(post.publishedAt) + 24 * HOUR), { offset: "24h", ...outcome }));
  }
  return out;
}

function approvalsFor(item: PostSummary): Approval[] {
  const { post } = item;
  const requested: Approval = {
    id: `ap_${post.id}`,
    postId: post.id,
    state: "requested",
    requestedBy: post.createdBy,
    decidedBy: null,
    decidedAt: null,
    note: null,
    createdAt: post.createdAt,
  };
  if (post.status === "pending_approval") return [requested];
  return [{ ...requested, state: "approved", decidedBy: { type: "human", id: post.disclosure?.reviewedBy ?? "dev" }, decidedAt: iso(Date.parse(post.createdAt) + 1.5 * HOUR) }];
}

// --- Feed ----------------------------------------------------------------

function act(
  id: string,
  network: Network,
  kind: ActivityKind,
  handle: string,
  name: string,
  text: string,
  hoursAgo: number,
  matched: string[],
  sentiment: number | null = null,
): Activity {
  const accountId = accounts.find((a) => a.network === network)?.id ?? null;
  const url =
    network === "x" ? `https://x.com/${handle}/status/${id}` : network === "bluesky" ? `https://bsky.app/profile/${handle}/post/${id}` : `https://www.instagram.com/p/${id}/`;
  return {
    id,
    workspaceId: workspace.id,
    socialAccountId: accountId,
    network,
    kind,
    externalId: id,
    authorHandle: handle,
    authorName: name,
    text,
    url,
    parentExternalId: null,
    occurredAt: ago(hoursAgo),
    ingestedAt: ago(Math.max(0, hoursAgo - 0.02)),
    sentiment,
    matchedStreams: matched,
    rawEventId: null,
  };
}

const feedSeed: Activity[] = [
  act("a01", "x", "mention", "latte_lauren", "Lauren", "is it just me or is @northwindcoffee the only one not doing pumpkin spice yet?? respect", 0.07, ["st_brand", "st_psl"], 0.6),
  act("a02", "bluesky", "reply", "mara.k", "Mara K.", "which beans do you recommend for cold brew? the ethiopian?", 0.18, ["st_brand"], 0.3),
  act("a03", "instagram", "comment", "dan.espresso", "Dan", "that pour. no notes.", 0.3, ["st_brand"], 0.8),
  act("a04", "x", "quote", "coffeewire", "Coffee Wire", "Northwind says the quiet part out loud about PSL season", 0.43, ["st_brand", "st_psl"], 0.4),
  act("a05", "x", "dm", "wholesale_jo", "Jo Ramirez", "Hi — interested in wholesale pricing for 3 cafés in Portland. Who should I talk to?", 0.68, [], 0.2),
  act("a06", "bluesky", "mention", "oat.enjoyer", "oat enjoyer", "oat milk shortage is hitting @northwind.coffee too, they're out at the Pearl location", 1.0, ["st_brand"], -0.3),
  act("a07", "x", "mention", "stumptown_fan", "pdx coffee guy", "stumptown vs northwind cold brew — fight", 1.3, ["st_comp", "st_brand"], 0.1),
  act("a08", "instagram", "comment", "kate.reads", "Kate", "do you ship beans to Canada?", 2.0, ["st_brand"], 0.2),
  act("a09", "bluesky", "reply", "pdx.morning", "PDX Morning", "the dirty chai is so good, bring it back for winter", 2.5, ["st_brand"], 0.7),
  act("a10", "x", "reply", "m_torres", "M. Torres", "@northwindcoffee your app logged me out again. third time this week.", 3.0, ["st_brand"], -0.6),
  act("a11", "instagram", "mention", "pdxfoodie", "PDX Foodie", "best cold brew in town is northwindcoffee, no notes", 4.0, ["st_brand"], 0.9),
  act("a12", "x", "mention", "beanwatch", "Bean Watch", "Blue Bottle just dropped a pumpkin cold foam. @northwindcoffee your move", 5.0, ["st_comp", "st_psl"], 0.0),
];

const LIVE_LINES: { network: Network; kind: ActivityKind; handle: string; name: string; text: string; matched: string[] }[] = [
  { network: "x", kind: "mention", handle: "fallhater", "name": "Sam", text: "@northwindcoffee are you doing anything for fall or is it just the cortado", matched: ["st_brand", "st_psl"] },
  { network: "bluesky", kind: "mention", handle: "cortado.club", name: "cortado club", text: "ok the maple-cardamom cortado at @northwind.coffee is actually good", matched: ["st_brand"] },
  { network: "instagram", kind: "comment", handle: "early.riser", name: "Early Riser", text: "please open earlier on weekends 🙏", matched: ["st_brand"] },
  { network: "x", kind: "reply", handle: "pslforever", name: "PSL forever", text: "@northwindcoffee boring take. pumpkin spice is fine.", matched: ["st_brand", "st_psl"] },
];

// --- Alerts, brief, metrics ------------------------------------------------

const alertsSeed: Alert[] = [
  {
    id: "al_psl",
    kind: "trend_window",
    severity: "urgent",
    title: "Pumpkin spice backlash is rising fast",
    body: "Three sources agree. Peak in about 6 hours; the proposal in your queue rides it.",
    evidence: [{ kind: "forecast", ref: "fc_tp_psl" }],
    topicId: "tp_psl",
    acknowledgedAt: null,
    createdAt: ago(0.35),
  },
  {
    id: "al_ig",
    kind: "connector",
    severity: "attention",
    title: "Instagram needs re-authorization",
    body: "The Instagram token expired 9 hours ago. Instagram variants will fail until someone reconnects the account.",
    evidence: [{ kind: "account", ref: "acc_ig" }],
    topicId: null,
    acknowledgedAt: null,
    createdAt: ago(3),
  },
];

const brief: Brief = {
  id: "br_w44",
  periodStart: ago(24 * 6.6),
  periodEnd: ago(2),
  runId: "run_brief_44",
  evidence: null,
  createdAt: ago(2),
  contentMd: `# The week in attention

**38 posts went out**: 21 on X, 12 on Bluesky, 5 on Instagram. Engagement ran **1.6x** the 30-day baseline.

## What moved
- **Cold brew at home** peaked Thursday. The ratio card rode the rise and did 2.3x baseline — the best post of the week.
- **Dirty chai** faded faster than forecast (we said ~36h, it took 20h). Two posts landed after the peak and did 0.8x.
- Oat milk shortage mentions are flat but negative. Nobody is asking us to fix it; they're asking whether we have it.

## What we did
- 3 proposals approved, 1 rejected (the "quiet luxury" angle — off voice).
- The approver edited 2 of 3 operator drafts; edits shortened them by about 30%.

## What's next
- Pumpkin spice backlash is rising with a ~6h window. One proposal is waiting on you.
- Instagram needs reconnecting; 1 queued variant will fail until it is.

Evidence: [lift by stage](https://meridian.local/metrics/lift) · [ledger export](https://meridian.local/export)
`,
};

const summary: Summary = {
  window: { from: ago(24 * 7), to: iso(NOW) },
  publishedByNetwork: [
    { network: "x", posts: 21 },
    { network: "bluesky", posts: 12 },
    { network: "instagram", posts: 5 },
  ],
  measuredAt24h: 36,
  totals: { impressions: 412_000, engagements: 9_800 },
  baselineEngagements24h: 160,
  byNetwork: [
    { key: "x", posts: 21, impressions: 260_000, engagements: 5_900, avgEngagements: 281 },
    { key: "bluesky", posts: 12, impressions: 98_000, engagements: 2_700, avgEngagements: 225 },
    { key: "instagram", posts: 5, impressions: 54_000, engagements: 1_200, avgEngagements: 240 },
  ],
  byHour: [],
  byTrendStage: [
    { key: "rising", posts: 6, impressions: 140_000, engagements: 3_000, avgEngagements: 500 },
    { key: "peaking", posts: 9, impressions: 120_000, engagements: 2_600, avgEngagements: 289 },
    { key: "plateau", posts: 14, impressions: 110_000, engagements: 2_250, avgEngagements: 161 },
    { key: "fading", posts: 5, impressions: 30_000, engagements: 560, avgEngagements: 112 },
    { key: "dormant", posts: 4, impressions: 12_000, engagements: 580, avgEngagements: 145 },
  ],
  byAuthor: [],
  byExperiment: [],
  top: [{ postId: "p_ratio", variantId: "v_ratio_x", network: "x", text: "Cold brew, the whole recipe…", impressions: 18_400, engagements: 612, lift: 2.3 }],
};

const liftByStage: LiftByStage[] = [
  { stage: "rising", posts: 6, avgEngagements: 500, lift: 3.1 },
  { stage: "peaking", posts: 9, avgEngagements: 289, lift: 1.8 },
  { stage: "plateau", posts: 14, avgEngagements: 161, lift: 1.0 },
  { stage: "fading", posts: 5, avgEngagements: 112, lift: 0.7 },
  { stage: "dormant", posts: 4, avgEngagements: 145, lift: 0.9 },
];

// --- Mutable state (the fixture "server") ----------------------------------

const state = {
  queue: clone(queueSeed),
  decided: [] as PostSummary[],
  feed: clone(feedSeed),
  alerts: clone(alertsSeed),
  liveIndex: 0,
};

function allPosts(): PostSummary[] {
  return [...state.queue, ...state.decided, ...published];
}

function topicActions(topicId: string): TopicDetail["actions"] {
  return allPosts()
    .filter((p) => p.post.trendTopicId === topicId)
    .sort((a, b) => Date.parse(b.post.createdAt) - Date.parse(a.post.createdAt))
    .map((p) => ({
      postId: p.post.id,
      stageAtAction: p.post.trendStageAtCreation,
      forecastId: p.post.trendForecastId,
      createdAt: p.post.createdAt,
      outcome24h: OUTCOMES[p.post.id] ?? null,
    }));
}

const BLOCKING: { id: string; kind: string; re: RegExp; message: string }[] = [
  { id: "rl_guarantee", kind: "forbidden_phrase", re: /\bguarantee[sd]?\b/gi, message: "Promises guaranteed results" },
  { id: "rl_health", kind: "forbidden_claim", re: /\b(cures?|heals?|burns? fat|weight loss|detox)\b/gi, message: "Makes a health claim about coffee" },
];

export const fixtureApi = {
  me: () => delay(me),
  policy: () => delay(policy),
  accounts: () => delay(accounts),
  streams: () => delay(streams),

  queue: () => delay(state.queue),

  post: async (id: string): Promise<PostFull> => {
    const found = allPosts().find((p) => p.post.id === id);
    if (!found) throw new ApiError(404, "not_found", "No such post.");
    return delay({ ...found, approvals: approvalsFor(found), history: historyFor(found) });
  },

  decide: async (id: string, input: DecideInput): Promise<PostDetail> => {
    await delay(null, 320);
    const idx = state.queue.findIndex((q) => q.post.id === id);
    const item = state.queue[idx];
    if (!item) throw new ApiError(404, "not_found", "That post isn't waiting anymore.");

    if (input.decision === "approve") {
      // Approving re-runs the red lines over the edited text, like the real gate does.
      const violations: Violation[] = [];
      for (const v of item.variants) {
        const text = input.edits?.[v.id] ?? v.text;
        for (const rule of BLOCKING) {
          const matches = text.match(rule.re);
          if (matches) violations.push({ redLineId: rule.id, kind: rule.kind, severity: "block", message: rule.message, matches });
        }
      }
      if (violations.length) {
        throw new ApiError(422, "policy_blocked", "The edit crosses a red line.", { verdict: "block", violations, policyVersion: 3 });
      }
      for (const v of item.variants) {
        const edited = input.edits?.[v.id];
        if (edited !== undefined) v.text = edited;
      }
      item.post.status = item.post.scheduledAt ? "scheduled" : "approved";
    } else if (input.decision === "reject") {
      item.post.status = "cancelled";
    } else {
      item.post.status = "draft";
    }
    item.post.updatedAt = iso(Date.now());
    state.queue.splice(idx, 1);
    state.decided.push(item);
    const approval: Approval = {
      id: `ap_${id}_d`,
      postId: id,
      state: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested",
      requestedBy: item.post.createdBy,
      decidedBy: me.actor,
      decidedAt: iso(Date.now()),
      note: input.note ?? null,
      createdAt: item.post.createdAt,
    };
    return clone({ post: item.post, variants: item.variants, approvals: [approval] });
  },

  radar: () => delay(radar),

  topic: async (id: string): Promise<TopicDetail> => {
    const spec = TOPICS.find((t) => t.id === id);
    const entry = radar.find((r) => r.topic.id === id);
    if (!spec || !entry) throw new ApiError(404, "not_found", "No such topic.");
    return delay({
      topic: entry.topic,
      forecast: entry.forecast,
      series: historySeries(spec.stage, spec.sources, spec.seed),
      actions: topicActions(id),
    });
  },

  feed: async (q: FeedQuery = {}): Promise<Activity[]> => {
    let items = state.feed.slice().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    if (q.kinds?.length) items = items.filter((a) => q.kinds!.includes(a.kind));
    if (q.networks?.length) items = items.filter((a) => q.networks!.includes(a.network));
    if (q.stream) items = items.filter((a) => a.matchedStreams.includes(q.stream!));
    if (q.since) items = items.filter((a) => Date.parse(a.occurredAt) > Date.parse(q.since!));
    if (q.before) items = items.filter((a) => Date.parse(a.occurredAt) < Date.parse(q.before!));
    if (q.q) items = items.filter((a) => (a.text ?? "").toLowerCase().includes(q.q!.toLowerCase()));
    return delay(items.slice(0, q.limit ?? 100));
  },

  summary: (_from: string, _to: string) => delay(summary),
  liftByStage: (_from: string, _to: string) => delay(liftByStage),

  alerts: () => delay(state.alerts.filter((a) => !a.acknowledgedAt)),
  ackAlert: async (id: string): Promise<void> => {
    await delay(null, 160);
    const a = state.alerts.find((x) => x.id === id);
    if (!a) throw new ApiError(404, "not_found", "No such alert.");
    a.acknowledgedAt = iso(Date.now());
  },

  latestBrief: () => delay(brief),
};

/** A pretend live stream: one new mention arrives every 40 seconds. */
export function openFixtureStream(h: StreamHandlers): () => void {
  h.onStatus("live");
  const timer = window.setInterval(() => {
    const line = LIVE_LINES[state.liveIndex % LIVE_LINES.length];
    state.liveIndex += 1;
    if (!line) return;
    const id = `live_${state.liveIndex}`;
    const a = act(id, line.network, line.kind, line.handle, line.name, line.text, 0, line.matched, 0.2);
    state.feed.unshift(a);
    h.onEvent({ type: "activity", data: { workspaceId: workspace.id, id, network: a.network, kind: a.kind, matchedStreams: a.matchedStreams } });
  }, 40_000);
  return () => {
    window.clearInterval(timer);
    h.onStatus("off");
  };
}
