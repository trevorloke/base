// Fixture data for developing and screenshotting the room without the API (VITE_USE_FIXTURES=1).
// Everything here is plausible, deterministic, and relative to the moment the page loads.

import type {
  AcceptInviteInput,
  Account,
  AccountMetrics,
  Activity,
  ActivityKind,
  AdaptInput,
  AdaptResult,
  AdaptedVariant,
  Alert,
  Approval,
  Brief,
  ConnectCredentialsInput,
  ConnectStartInput,
  Connector,
  InviteCreated,
  InviteInfo,
  MediaAsset,
  Member,
  ModerateAction,
  NetworkCapabilities,
  ReplyInput,
  Role,
  Session,
  SessionWorkspace,
  SignupInput,
  CreatePostInput,
  DecideInput,
  Discovery,
  FeedQuery,
  Forecast,
  ForecastPoint,
  LedgerEvent,
  LiftByStage,
  Me,
  Network,
  OAuthStart,
  Policy,
  PolicyCheckInput,
  PolicyDecision,
  Post,
  PostStatus,
  PostDetail,
  PostFull,
  PostSummary,
  RadarEntry,
  SeriesPoint,
  Stream,
  Summary,
  TopicDetail,
  TopicSeries,
  TrendSource,
  TrendStage,
  Variant,
  Violation,
  Workspace,
} from "../types";
import type { StreamHandlers } from "../api";
import { ApiError } from "../lib/errors";
import { NETWORK_THREADS, networkLabel, truncate } from "../lib/format";
import { weekStartMs } from "../lib/tz";

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

const acct = (id: string, network: Network, handle: string, displayName: string, connector: string, status: Account["status"], ingestedHoursAgo: number | null, externalId = id): Account => ({
  id,
  network,
  externalId,
  handle,
  displayName,
  connector,
  status,
  hasCredentials: status !== "disabled",
  lastIngestAt: ingestedHoursAgo === null ? null : ago(ingestedHoursAgo),
  config: {},
});

// Northwind's accounts. The feed, posts and calendar below reference these ids.
const accounts: Account[] = [
  acct("acc_x", "x", "northwindcoffee", "Northwind Coffee", "x", "active", 0.1, "1842"),
  acct("acc_bsky", "bluesky", "northwind.coffee", "Northwind Coffee", "bluesky", "active", 0.2, "did:plc:nw"),
  acct("acc_ig", "instagram", "northwindcoffee", "Northwind Coffee", "meta", "reauth_required", 9, "17841"),
  acct("acc_fb", "facebook", "northwindcoffeepdx", "Northwind Coffee", "meta", "active", 0.4),
  acct("acc_yt", "youtube", "northwindroasters", "Northwind Roasters", "youtube", "active", 1.5),
  acct("acc_tt", "tiktok", "northwind.coffee", "Northwind Coffee", "tiktok", "active", 0.8),
  acct("acc_masto", "mastodon", "northwind@mastodon.social", "Northwind Coffee", "mastodon", "active", 0.6),
  acct("acc_li", "linkedin", "northwind-coffee-roasters", "Northwind Coffee Roasters", "linkedin", "disabled", null),
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
  if (post.status === "failed" && post.scheduledAt) {
    out.push(ev("post.publish_started", post.id, sys, post.scheduledAt));
    for (const v of variants) out.push(ev("variant.failed", post.id, sys, post.scheduledAt, { network: v.network, error: v.error, attempt: v.attemptCount }));
    out.push(ev("post.failed", post.id, sys, post.scheduledAt, { status: post.status }));
  }
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
    network === "x"
      ? `https://x.com/${handle}/status/${id}`
      : network === "bluesky"
        ? `https://bsky.app/profile/${handle}/post/${id}`
        : network === "instagram"
          ? `https://www.instagram.com/p/${id}/`
          : network === "youtube"
            ? `https://www.youtube.com/watch?v=${id}`
            : network === "facebook"
              ? `https://www.facebook.com/${id}`
              : network === "tiktok"
                ? `https://www.tiktok.com/@${handle}/video/${id}`
                : null;
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
  act("a13", "facebook", "comment", "linda.park", "Linda Park", "Are you open on Thanksgiving morning? Want to grab beans for the family.", 0.55, ["st_brand"], 0.3),
  act("a14", "youtube", "comment", "brewnerd42", "brewnerd42", "What grind setting on a Baratza for the 1:8 cold brew in this video?", 1.6, ["st_brand"], 0.4),
  act("a15", "tiktok", "comment", "jules.sips", "jules", "the latte art at 0:12 😮", 2.2, ["st_brand"], 0.8),
  act("a16", "mastodon", "mention", "kav@hachyderm.io", "Kavya", "@northwind@mastodon.social do you publish your green coffee prices? would love to see more roasters do that", 3.4, ["st_brand"], 0.5),
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

Evidence: [lift by stage](https://starsign.local/metrics/lift) · [ledger export](https://starsign.local/export)
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

// --- Calendar (two weeks from this Monday, workspace time) ------------------

const DAY = 24 * HOUR;
const WEEK_START = weekStartMs(NOW, policy.timezone);
const CAL_STATUSES: PostStatus[] = ["pending_approval", "approved", "scheduled", "publishing", "published", "partially_published", "failed"];

/** A slot this week that has already happened: spread over the time since Monday, or last week early on Monday. */
function pastSlot(fraction: number): number {
  const since = NOW - WEEK_START;
  return since > 3 * HOUR ? WEEK_START + since * fraction : NOW - (6 + 30 * (1 - fraction)) * HOUR;
}

function calPost(
  id: string,
  title: string,
  body: string,
  ms: number,
  status: PostStatus,
  targets: [string, Network, string?][],
  extra: Partial<Post> = {},
): PostSummary {
  // A seeded "future" slot that has already passed by the time the page loads simply went out.
  const effective: PostStatus = ms < NOW && !["published", "failed", "partially_published"].includes(status) ? "published" : status;
  const wentOut = effective === "published" || effective === "partially_published";
  return {
    post: {
      ...basePost,
      id,
      status: effective,
      title,
      body,
      scheduledAt: iso(ms),
      publishedAt: wentOut ? iso(ms) : null,
      actionClass: "new_post",
      createdBy: { type: "human", id: "marta" },
      trendTopicId: null,
      trendStageAtCreation: null,
      disclosure: { aiAssisted: false, aiContributions: [], humanReviewed: true, reviewedBy: "marta" },
      evidence: [],
      policyDecision: { verdict: effective === "pending_approval" ? "require_approval" : "allow", violations: [], policyVersion: 3 },
      createdAt: iso(ms - 2 * DAY),
      updatedAt: iso(ms - 2 * DAY),
      ...extra,
    },
    variants: targets.map(([accountId, network, text], i) =>
      variant(`${id}_v${i}`, id, accountId, network, text ?? body, {
        status: effective === "failed" ? "failed" : wentOut ? (effective === "partially_published" && network === "instagram" ? "failed" : "published") : "pending",
        error: effective === "failed" || (effective === "partially_published" && network === "instagram") ? IG_ERROR : null,
        attemptCount: effective === "failed" ? 3 : wentOut ? 1 : 0,
        publishedAt: wentOut && !(effective === "partially_published" && network === "instagram") ? iso(ms) : null,
        externalUrl: wentOut && network !== "instagram" ? (network === "x" ? `https://x.com/northwindcoffee/status/${id}` : `https://bsky.app/profile/northwind.coffee/post/${id}`) : null,
        media: network === "instagram" ? [{ kind: "image", url: `https://images.northwind.coffee/${id}.jpg`, alt: title }] : [],
      }),
    ),
  };
}

const slot = (day: number, hour: number) => WEEK_START + day * DAY + hour * HOUR;
const XB: [string, Network][] = [
  ["acc_x", "x"],
  ["acc_bsky", "bluesky"],
];

const calendarSeed: PostSummary[] = [
  calPost("p_cal_open", "Doors at 7", "Doors at 7 at all four cafés. The Guji is on batch brew until it runs out.", pastSlot(0.35), "published", XB),
  calPost("p_cal_pour", "The pour", "Forty seconds, one pour, no notes.", pastSlot(0.75), "failed", [["acc_ig", "instagram"]]),
  calPost("p_cal_guji", "The Guji is back", "The Guji is back on espresso. Bright, a little floral, gone in three weeks.", slot(1, 9.5), "scheduled", XB),
  calPost("p_cal_latte", "Latte art Thursday", "Every Thursday our baristas pour whatever you ask for. Within reason.", slot(3, 15), "pending_approval", [["acc_ig", "instagram"], ["acc_bsky", "bluesky"]]),
  calPost("p_cal_sat", "Saturday cuppings", "Saturday cupping at the Pearl, 10am. Free, twelve seats, bring questions.", slot(5, 8), "scheduled", [...XB, ["acc_ig", "instagram"]]),
  calPost("p_cal_roast", "Roast day", "Roast day. If you smell burnt sugar on Division, that's us.", slot(7, 10), "scheduled", XB),
  calPost("p_cal_wholesale", "Wholesale, plainly", "We roast for 31 cafés now. If you run one and want to taste, write to us.", slot(9, 11), "pending_approval", [["acc_x", "x"]]),
  calPost("p_cal_beans", "Bean subscription", "The subscription now ships every two weeks, not every month. Same beans, fresher.", slot(10, 9), "approved", XB),
  calPost("p_cal_fri", "Friday pastries", "Friday: cardamom buns at the Alberta café. They go by 9.", slot(11, 7.5), "scheduled", [...XB, ["acc_ig", "instagram"]]),
];

const cap = (kinds: string[], o: Partial<NetworkCapabilities> = {}): NetworkCapabilities => ({
  publish: true,
  reply: true,
  moderate: true,
  accountMetrics: true,
  webhooks: false,
  video: true,
  kinds,
  ...o,
});

// Every network, in mixed states: some set up and connected, some set up and waiting, some not set up here.
const connectorsSeed: Connector[] = [
  { name: "x", networks: ["x"], configured: true, connect: "oauth", inputs: [], capabilities: { x: cap(["post", "poll"]) } },
  {
    name: "bluesky",
    networks: ["bluesky"],
    configured: true,
    connect: "app_password",
    inputs: [
      { key: "identifier", label: "Handle", placeholder: "yourbrand.bsky.social" },
      { key: "appPassword", label: "App password", placeholder: "xxxx-xxxx-xxxx-xxxx" },
    ],
    capabilities: { bluesky: cap(["post"]) },
  },
  {
    name: "meta",
    networks: ["facebook", "instagram"],
    configured: true,
    connect: "oauth",
    inputs: [],
    capabilities: {
      facebook: cap(["post", "link", "reel", "story"], { webhooks: true }),
      instagram: cap(["post", "carousel", "reel", "story"], { webhooks: true }),
    },
  },
  { name: "threads", networks: ["threads"], configured: true, connect: "oauth", inputs: [], capabilities: { threads: cap(["post", "carousel"]) } },
  { name: "linkedin", networks: ["linkedin"], configured: true, connect: "oauth", inputs: [], capabilities: { linkedin: cap(["post", "link", "carousel"]) } },
  { name: "tiktok", networks: ["tiktok"], configured: true, connect: "oauth", inputs: [], capabilities: { tiktok: cap(["video", "carousel"], { reply: false, moderate: false }) } },
  { name: "youtube", networks: ["youtube"], configured: true, connect: "oauth", inputs: [], capabilities: { youtube: cap(["video", "short"]) } },
  { name: "pinterest", networks: ["pinterest"], configured: false, connect: "oauth", inputs: [], capabilities: { pinterest: cap(["pin"], { reply: false, moderate: false }) } },
  {
    name: "mastodon",
    networks: ["mastodon"],
    configured: true,
    connect: "oauth",
    inputs: [{ key: "instance", label: "Your server", placeholder: "mastodon.social" }],
    capabilities: { mastodon: cap(["post", "poll"], { webhooks: true }) },
  },
  { name: "reddit", networks: ["reddit"], configured: false, connect: "oauth", inputs: [], capabilities: { reddit: cap(["post", "link"]) } },
  { name: "google_business", networks: ["google_business"], configured: false, connect: "oauth", inputs: [], capabilities: { google_business: cap(["post"], { reply: true, moderate: false, video: false }) } },
  {
    name: "telegram",
    networks: ["telegram"],
    configured: true,
    connect: "bot_token",
    inputs: [
      { key: "botToken", label: "Bot token", placeholder: "123456789:AA…" },
      { key: "chatId", label: "Channel", placeholder: "@yourchannel" },
    ],
    capabilities: { telegram: cap(["post", "poll"], { reply: true, moderate: true, accountMetrics: true }) },
  },
  {
    name: "discord",
    networks: ["discord"],
    configured: true,
    connect: "webhook_url",
    inputs: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…" }],
    capabilities: { discord: cap(["post"], { reply: false, moderate: false, accountMetrics: false }) },
  },
];

const sourcesSeed: TrendSource[] = [
  { name: "google_trends", kind: "both", configured: true, lastRunAt: ago(0.3), lastError: null, pointsLast24h: 288 },
  { name: "bluesky_firehose", kind: "both", configured: true, lastRunAt: ago(0.1), lastError: null, pointsLast24h: 1_420 },
  { name: "wikipedia_pageviews", kind: "sample", configured: true, lastRunAt: ago(7), lastError: null, pointsLast24h: 24 },
  { name: "youtube_trending", kind: "trending", configured: true, lastRunAt: ago(5), lastError: "quota exceeded for today", pointsLast24h: 60 },
  { name: "tiktok_creative_center", kind: "trending", configured: false, lastRunAt: null, lastError: null, pointsLast24h: 0 },
];

const discoveriesSeed: Discovery[] = [
  { term: "pumpkin spice too early", source: "google_trends", value: 100, url: null, observedAt: ago(0.4), region: "US-OR" },
  { term: "cold brew ratio", source: "google_trends", value: 64, url: null, observedAt: ago(0.4), region: "US" },
  { term: "oat milk shortage", source: "bluesky_firehose", value: 212, url: "https://bsky.app/search?q=oat+milk+shortage", observedAt: ago(1.1), region: null },
  { term: "world coffee day", source: "wikipedia_pageviews", value: 880, url: "https://en.wikipedia.org/wiki/International_Coffee_Day", observedAt: ago(7), region: null },
];

// --- Red lines, dry run --------------------------------------------------

const NEEDS_APPROVAL: { id: string; kind: string; re: RegExp; message: (m: string) => string }[] = [
  { id: "rl_comp", kind: "no_competitor_mention", re: /\b(MEC|Blue Bottle|Stumptown|Starbucks)\b/g, message: (m) => `Names a competitor: ${m}` },
];

function checkPolicy(input: PolicyCheckInput): PolicyDecision {
  const found = new Map<string, { redLineId: string; kind: string; severity: "block" | "require_approval"; message: string; matches: Set<string> }>();
  const add = (redLineId: string, kind: string, severity: "block" | "require_approval", message: string, match: string | null) => {
    const key = `${redLineId}|${message}`;
    const v = found.get(key) ?? { redLineId, kind, severity, message, matches: new Set<string>() };
    if (match) v.matches.add(match);
    found.set(key, v);
  };
  for (const v of input.variants) {
    for (const rule of BLOCKING) for (const m of v.text.match(rule.re) ?? []) add(rule.id, rule.kind, "block", rule.message, m);
    for (const rule of NEEDS_APPROVAL) for (const m of v.text.match(rule.re) ?? []) add(rule.id, rule.kind, "require_approval", rule.message(m), m);
  }
  // Quiet hours are about when something goes out; a draft with no time isn't going anywhere.
  const hour = input.scheduledAt
    ? Number(new Intl.DateTimeFormat("en-US", { timeZone: policy.timezone, hour: "numeric", hourCycle: "h23" }).format(new Date(input.scheduledAt)))
    : 12;
  if (hour >= 22 || hour < 7) add("rl_quiet", "quiet_hours", "require_approval", "Falls inside quiet hours (10pm–7am Pacific)", null);
  const violations: Violation[] = [...found.values()].map((v) => ({ ...v, matches: [...v.matches] }));
  const verdict = violations.some((v) => v.severity === "block") ? "block" : violations.length ? "require_approval" : "allow";
  return { verdict, violations, policyVersion: policy.version };
}

// --- Compose, adapted per network -----------------------------------------

function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
}

/** Pack sentences into segments under `max`; whatever doesn't fit continues as a thread. */
function packThread(text: string, max: number): { text: string; thread: string[] } {
  const segs: string[] = [];
  let cur = "";
  for (const sentence of sentences(text)) {
    const next = cur ? `${cur} ${sentence}` : sentence;
    if (next.length <= max) cur = next;
    else {
      if (cur) segs.push(cur);
      cur = truncate(sentence, max);
    }
  }
  if (cur) segs.push(cur);
  return { text: segs[0] ?? "", thread: segs.slice(1) };
}

function adaptFor(network: Network, body: string): AdaptedVariant {
  const plain = body.replace(/\s+/g, " ").trim();
  switch (network) {
    case "x": {
      const tight = plain.replace(/\band\b/g, "&").replace(/\bwe are\b/gi, "we're");
      return { network, ...packThread(tight, 270) };
    }
    case "bluesky":
      return { network, ...packThread(plain, 290) };
    case "threads":
    case "mastodon":
      return { network, ...packThread(plain, 480) };
    case "instagram":
      return { network, text: `${sentences(plain).join("\n\n")}\n\n#northwindcoffee #portlandcoffee`, thread: [] };
    case "linkedin":
      return { network, text: `${plain}\n\nNorthwind Coffee roasts in Portland for four cafés and 31 wholesale partners.`, thread: [] };
    default:
      return { network, text: plain, thread: [] };
  }
}

// --- Mutable state (the fixture "server") ----------------------------------

const state = {
  queue: clone(queueSeed),
  decided: [] as PostSummary[],
  feed: clone(feedSeed),
  alerts: clone(alertsSeed),
  liveIndex: 0,
  calendar: clone(calendarSeed),
  created: [] as PostSummary[],
  createdSeq: 0,
};

function allPosts(): PostSummary[] {
  return [...state.queue, ...state.decided, ...published, ...state.calendar, ...state.created];
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

// --- People, sign-in, teams (v1.2) ----------------------------------------
// The fixture "server" keeps who is signed in, which workspace is current, and each workspace's accounts in
// localStorage, standing in for the session cookie. That way a sign-in or an OAuth round trip (which reloads
// the page) behaves like the real thing. Sign in with any email; the password "wrong" fails.

interface FxUser {
  id: string;
  email: string;
  name: string;
}

interface FxWorkspace {
  id: string;
  slug: string;
  name: string;
  role: Role;
  createdAt: string;
}

interface FxStore {
  signedIn: boolean;
  user: FxUser;
  currentWorkspaceId: string;
  workspaces: FxWorkspace[];
  accounts: Record<string, Account[]>;
  members: Member[];
}

const FX_STORE_KEY = "starsign.fixtures.v2";

function seedStore(): FxStore {
  return {
    signedIn: false,
    user: { id: "usr_maya", email: "maya@northwind.coffee", name: "Maya Chen" },
    currentWorkspaceId: workspace.id,
    workspaces: [
      { id: workspace.id, slug: workspace.slug, name: workspace.name, role: "owner", createdAt: workspace.createdAt },
      { id: "ws_alder", slug: "alder-pine", name: "Alder & Pine Bakery", role: "owner", createdAt: ago(24 * 30) },
      { id: "ws_harbor", slug: "harbor-books", name: "Harbor Books", role: "editor", createdAt: ago(24 * 12) },
    ],
    accounts: {
      [workspace.id]: clone(accounts),
      ws_alder: [acct("acc_alder_ig", "instagram", "alderandpine", "Alder & Pine", "meta", "active", 2), acct("acc_alder_fb", "facebook", "alderandpinebakery", "Alder & Pine Bakery", "meta", "active", 2)],
      ws_harbor: [acct("acc_harbor_bsky", "bluesky", "harborbooks.bsky.social", "Harbor Books", "bluesky", "active", 3)],
    },
    members: [
      { id: "mem_maya", userId: "usr_maya", email: "maya@northwind.coffee", name: "Maya Chen", role: "owner", createdAt: ago(24 * 90) },
      { id: "mem_dev", userId: "usr_dev", email: "dev@northwind.coffee", name: "Dev Patel", role: "approver", createdAt: ago(24 * 60) },
      { id: "mem_sam", userId: "usr_sam", email: "sam@northwind.coffee", name: "Sam Okafor", role: "editor", createdAt: ago(24 * 21) },
      { id: "mem_rita", userId: "usr_rita", email: "rita@quillagency.com", name: "Rita Alvarez", role: "viewer", createdAt: ago(24 * 4) },
    ],
  };
}

function loadStore(): FxStore {
  try {
    const raw = localStorage.getItem(FX_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as FxStore;
      if (parsed && parsed.user && Array.isArray(parsed.workspaces) && parsed.accounts) return parsed;
    }
  } catch {
    // fall through to a fresh seed
  }
  return seedStore();
}

const store: FxStore = loadStore();

function save(): void {
  try {
    localStorage.setItem(FX_STORE_KEY, JSON.stringify(store));
  } catch {
    // private window: fixture state lasts for this page load
  }
}

function currentWs(): FxWorkspace {
  return store.workspaces.find((w) => w.id === store.currentWorkspaceId) ?? store.workspaces[0]!;
}

function currentAccounts(): Account[] {
  const id = currentWs().id;
  store.accounts[id] ??= [];
  return store.accounts[id]!;
}

function currentMe(): Me {
  const w = currentWs();
  const ws: Workspace = w.id === workspace.id ? workspace : { ...workspace, id: w.id, slug: w.slug, name: w.name, profile: {}, createdAt: w.createdAt };
  return { workspace: ws, actor: { type: "human", id: store.signedIn ? store.user.name.split(" ")[0]!.toLowerCase() : "dev" }, role: w.role };
}

function sessionOf(): Session {
  const workspaces: SessionWorkspace[] = store.workspaces.map((w) => ({ id: w.id, slug: w.slug, name: w.name, role: w.role }));
  return clone({ user: store.user, workspaces, currentWorkspaceId: currentWs().id });
}

function requireSession(): void {
  if (!store.signedIn) throw new ApiError(401, "unauthorized", "Sign in first.");
}

function requireOwner(): void {
  requireSession();
  if (currentWs().role !== "owner") throw new ApiError(403, "forbidden", "Only an owner can change the team.");
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";

const INVITES: Record<string, InviteInfo> = {
  demo: { workspaceName: "Northwind Coffee", email: "jordan@northwind.coffee", role: "editor", expiresAt: ahead(24 * 6), userExists: false },
  member: { workspaceName: "Harbor Books", email: "maya@northwind.coffee", role: "approver", expiresAt: ahead(24 * 3), userExists: true },
};

function peopleApi() {
  return {
    session: async (): Promise<Session> => {
      await delay(null, 120);
      // The real server could say whether it takes sign-ups; fixtures say yes so every screen is reachable.
      if (!store.signedIn) throw new ApiError(401, "unauthorized", "not signed in", { signupAllowed: true });
      return sessionOf();
    },

    login: async (email: string, password: string): Promise<Session> => {
      await delay(null, 450);
      if (/^locked@/i.test(email.trim())) throw new ApiError(429, "rate_limited", "too many attempts");
      if (!email.includes("@") || !password || password === "wrong") throw new ApiError(401, "unauthorized", "That email and password don't match.");
      store.signedIn = true;
      if (email.trim().toLowerCase() !== store.user.email) {
        const local = email.split("@")[0] ?? "you";
        store.user = { ...store.user, email: email.trim().toLowerCase(), name: local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) };
      }
      save();
      return sessionOf();
    },

    signup: async (input: SignupInput): Promise<Session> => {
      await delay(null, 600);
      if (input.password.length < 10) throw new ApiError(400, "invalid", "Use at least 10 characters for the password.");
      const id = `ws_${slugify(input.workspaceName).replace(/-/g, "_")}`;
      store.signedIn = true;
      store.user = { id: "usr_new", email: input.email.trim().toLowerCase(), name: input.name.trim() };
      if (!store.workspaces.some((w) => w.id === id)) {
        store.workspaces.unshift({ id, slug: slugify(input.workspaceName), name: input.workspaceName.trim(), role: "owner", createdAt: iso(Date.now()) });
      }
      store.currentWorkspaceId = id;
      store.members = [{ id: "mem_new", userId: "usr_new", email: store.user.email, name: store.user.name, role: "owner", createdAt: iso(Date.now()) }];
      save();
      return sessionOf();
    },

    logout: async (): Promise<void> => {
      await delay(null, 150);
      store.signedIn = false;
      save();
    },

    switchWorkspace: async (workspaceId: string): Promise<Session> => {
      await delay(null, 220);
      requireSession();
      if (!store.workspaces.some((w) => w.id === workspaceId)) throw new ApiError(403, "forbidden", "You aren't a member of that workspace.");
      store.currentWorkspaceId = workspaceId;
      save();
      return sessionOf();
    },

    forgot: async (_email: string): Promise<void> => {
      await delay(null, 400);
    },

    reset: async (token: string, password: string): Promise<void> => {
      await delay(null, 400);
      if (token === "expired") throw new ApiError(400, "invalid", "This reset link has expired. Ask for a new one.");
      if (password.length < 10) throw new ApiError(400, "invalid", "Use at least 10 characters for the password.");
    },

    createWorkspace: async (name: string): Promise<Workspace> => {
      await delay(null, 350);
      requireSession();
      const clean = name.trim();
      if (!clean) throw new ApiError(400, "invalid", "Give the workspace a name.");
      let slug = slugify(clean);
      while (store.workspaces.some((w) => w.slug === slug)) slug = `${slug}-2`;
      const w: FxWorkspace = { id: `ws_${slug.replace(/-/g, "_")}`, slug, name: clean, role: "owner", createdAt: iso(Date.now()) };
      store.workspaces.push(w);
      store.accounts[w.id] = [];
      save();
      return clone({ ...workspace, id: w.id, slug, name: clean, profile: {}, createdAt: w.createdAt });
    },

    members: async (): Promise<Member[]> => {
      await delay(null, 160);
      requireSession();
      const mine = store.members.find((m) => m.email === store.user.email);
      if (!mine) store.members.unshift({ id: "mem_self", userId: store.user.id, email: store.user.email, name: store.user.name, role: currentWs().role, createdAt: ago(24 * 90) });
      return clone(store.members);
    },

    setMemberRole: async (id: string, role: Role): Promise<Member> => {
      await delay(null, 300);
      requireOwner();
      const m = store.members.find((x) => x.id === id);
      if (!m) throw new ApiError(404, "not_found", "That person isn't on the team anymore.");
      const owners = store.members.filter((x) => x.role === "owner");
      if (m.role === "owner" && role !== "owner" && owners.length <= 1) {
        throw new ApiError(409, "conflict", "A workspace needs at least one owner. Make someone else an owner first.");
      }
      m.role = role;
      save();
      return clone(m);
    },

    removeMember: async (id: string): Promise<void> => {
      await delay(null, 300);
      requireOwner();
      const idx = store.members.findIndex((x) => x.id === id);
      const m = store.members[idx];
      if (!m) throw new ApiError(404, "not_found", "That person isn't on the team anymore.");
      if (m.role === "owner" && store.members.filter((x) => x.role === "owner").length <= 1) {
        throw new ApiError(409, "conflict", "You can't remove the last owner.");
      }
      store.members.splice(idx, 1);
      save();
    },

    invite: async (email: string, role: Role): Promise<InviteCreated> => {
      await delay(null, 450);
      requireOwner();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) throw new ApiError(400, "invalid", "That doesn't look like an email address.");
      if (store.members.some((m) => m.email === email.trim().toLowerCase())) throw new ApiError(409, "conflict", "They're already on the team.");
      const token = `inv${Math.random().toString(36).slice(2, 10)}`;
      INVITES[token] = { workspaceName: currentWs().name, email: email.trim().toLowerCase(), role, expiresAt: ahead(24 * 7), userExists: false };
      // Pretend email is configured for company addresses only, so both outcomes show up.
      return { inviteUrl: `${window.location.origin}/?invite=${token}`, expiresAt: ahead(24 * 7), emailed: !/gmail\.com$/i.test(email) };
    },

    inviteInfo: async (token: string): Promise<InviteInfo> => {
      await delay(null, 250);
      const info = INVITES[token];
      if (!info) throw new ApiError(404, "not_found", "invite not found");
      return clone(info);
    },

    acceptInvite: async (input: AcceptInviteInput): Promise<Session> => {
      await delay(null, 500);
      const info = INVITES[input.token];
      if (!info) throw new ApiError(404, "not_found", "This invite has expired or was already used.");
      if (!store.signedIn) {
        if (info.userExists) {
          if (!input.password || input.password === "wrong") throw new ApiError(401, "unauthorized", "That password doesn't match the account for this email.");
          store.user = { ...store.user, email: info.email };
        } else {
          if (!input.name?.trim() || !input.password) throw new ApiError(400, "invalid", "Add your name and a password to join.");
          if (input.password.length < 10) throw new ApiError(400, "invalid", "Use at least 10 characters for the password.");
          store.user = { id: "usr_invited", email: info.email, name: input.name.trim() };
        }
      }
      store.signedIn = true;
      const existing = store.workspaces.find((w) => w.name === info.workspaceName);
      if (existing) store.currentWorkspaceId = existing.id;
      else {
        const slug = slugify(info.workspaceName);
        store.workspaces.push({ id: `ws_${slug}`, slug, name: info.workspaceName, role: info.role, createdAt: iso(Date.now()) });
        store.currentWorkspaceId = `ws_${slug}`;
      }
      delete INVITES[input.token];
      save();
      return sessionOf();
    },
  };
}

// --- Integrations (v1.2) -----------------------------------------------------

const FOLLOWERS: Record<string, number> = {
  acc_x: 18_420,
  acc_bsky: 3_912,
  acc_ig: 41_300,
  acc_fb: 12_870,
  acc_yt: 6_240,
  acc_tt: 22_150,
  acc_masto: 1_184,
  acc_alder_ig: 8_710,
  acc_alder_fb: 2_302,
  acc_harbor_bsky: 940,
};

/** Who an OAuth round trip "finds" behind one login, per connector. */
const OAUTH_FINDS: Record<string, { network: Network; handle: string; name: string }[]> = {
  meta: [
    { network: "facebook", handle: "northwindpearl", name: "Northwind Coffee · Pearl" },
    { network: "facebook", handle: "northwindalberta", name: "Northwind Coffee · Alberta" },
    { network: "instagram", handle: "northwindwholesale", name: "Northwind Wholesale" },
  ],
  threads: [{ network: "threads", handle: "northwindcoffee", name: "Northwind Coffee" }],
  linkedin: [
    { network: "linkedin", handle: "maya-chen", name: "Maya Chen" },
    { network: "linkedin", handle: "northwind-coffee-roasters", name: "Northwind Coffee Roasters" },
  ],
  x: [{ network: "x", handle: "northwindwholesale", name: "Northwind Wholesale" }],
  tiktok: [{ network: "tiktok", handle: "northwind.coffee", name: "Northwind Coffee" }],
  youtube: [{ network: "youtube", handle: "northwindroasters", name: "Northwind Roasters" }],
};

/** A small SVG "photo" so library thumbnails render offline. */
function svgThumb(label: string, a: string, b: string, w = 1080, h = 1350): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.68}" cy="${h * 0.36}" r="${Math.min(w, h) * 0.22}" fill="rgba(255,255,255,0.18)"/><text x="${w * 0.08}" y="${h * 0.9}" font-family="Inter, sans-serif" font-size="${Math.round(w / 14)}" fill="rgba(255,255,255,0.92)">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function asset(id: string, kind: MediaAsset["kind"], mime: string, url: string, name: string, extra: Partial<MediaAsset> = {}, hoursAgo = 24): MediaAsset {
  const a: MediaAsset = {
    id,
    url,
    kind,
    mime,
    bytes: extra.bytes ?? 1_200_000,
    width: extra.width ?? null,
    height: extra.height ?? null,
    durationSeconds: extra.durationSeconds ?? null,
    originalName: name,
    alt: extra.alt ?? null,
    createdAt: ago(hoursAgo),
    media: { kind, url, mime },
  };
  a.media = {
    kind,
    url,
    mime,
    bytes: a.bytes,
    assetId: id,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    ...(a.durationSeconds ? { durationSeconds: a.durationSeconds } : {}),
    ...(a.alt ? { alt: a.alt } : {}),
  };
  return a;
}

const mediaLibrary: MediaAsset[] = [
  asset("med_pour", "image", "image/jpeg", svgThumb("The pour", "#6b3f1d", "#d9a066"), "pour.jpg", { width: 1080, height: 1350, bytes: 2_400_000, alt: "A barista pouring a rosetta into a flat white" }, 20),
  asset("med_pearl", "image", "image/jpeg", svgThumb("Pearl café", "#24414f", "#8fb3a8", 1600, 1067), "pearl-cafe.jpg", { width: 1600, height: 1067, bytes: 3_100_000, alt: "Morning light in the Pearl café" }, 52),
  asset("med_roast", "video", "video/mp4", svgThumb("Roast day", "#3d1f12", "#c2562b", 1080, 1920), "roast-day.mp4", { width: 1080, height: 1920, durationSeconds: 42, bytes: 48_000_000 }, 75),
  asset("med_menu", "document", "application/pdf", "", "wholesale-menu-fall.pdf", { bytes: 860_000 }, 120),
];

function kindOfFile(file: File): MediaAsset["kind"] | null {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "document";
  if (file.type === "image/gif") return "gif";
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) return "image";
  if (/^video\/(mp4|quicktime|webm)$/.test(file.type) || /\.(mp4|mov|webm)$/i.test(file.name)) return "video";
  return null;
}

function probeImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function probeVideo(url: string): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => resolve(null);
    v.src = url;
  });
}

/** Simulated upload: progress ticks over a second or two, then the file joins this tab's library. */
export function fixtureUpload(file: File, onProgress: (p: number) => void, alt?: string): { done: Promise<MediaAsset>; abort: () => void } {
  let timer: number | null = null;
  let rejectFn: ((e: unknown) => void) | null = null;
  const done = new Promise<MediaAsset>((resolve, reject) => {
    rejectFn = reject;
    const kind = kindOfFile(file);
    if (!kind) {
      window.setTimeout(() => reject(new ApiError(400, "invalid", "unsupported file: upload JPEG, PNG, GIF, WebP, MP4, MOV, WebM or PDF")), 300);
      return;
    }
    const cap = kind === "video" ? 1024e6 : kind === "document" ? 100e6 : 30e6;
    if (file.size > cap) {
      window.setTimeout(() => reject(new ApiError(400, "invalid", `file is ${Math.round(file.size / 1e6)}MB; the limit for ${kind} is ${Math.round(cap / 1e6)}MB`)), 300);
      return;
    }
    const total = Math.min(2600, 700 + file.size / 4000);
    const started = Date.now();
    timer = window.setInterval(async () => {
      const p = Math.min(1, (Date.now() - started) / total);
      onProgress(p);
      if (p < 1) return;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      const url = URL.createObjectURL(file);
      let width: number | null = null;
      let height: number | null = null;
      let durationSeconds: number | null = null;
      if (kind === "image" || kind === "gif") {
        const d = await probeImage(url);
        width = d?.width ?? null;
        height = d?.height ?? null;
      } else if (kind === "video") {
        const d = await probeVideo(url);
        width = d?.width || null;
        height = d?.height || null;
        durationSeconds = d && Number.isFinite(d.duration) ? Math.round(d.duration * 10) / 10 : null;
      }
      state.createdSeq += 1;
      const a = asset(`med_up_${state.createdSeq}`, kind, file.type || "application/octet-stream", url, file.name, { width, height, durationSeconds, bytes: file.size, alt: alt ?? null }, 0);
      mediaLibrary.unshift(a);
      resolve(clone(a));
    }, 90);
  });
  return {
    done,
    abort: () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      rejectFn?.(new ApiError(0, "aborted", "Upload cancelled."));
    },
  };
}

function integrationsApi() {
  return {
    connectStart: async (connector: string, input: ConnectStartInput): Promise<OAuthStart> => {
      await delay(null, 350);
      const c = connectorsSeed.find((k) => k.name === connector);
      if (!c) throw new ApiError(404, "not_found", "No such connector.");
      if (!c.configured) throw new ApiError(503, "unavailable", `${networkLabel(c.networks[0] ?? connector)} isn't set up on this server`);
      if (c.inputs?.length) {
        for (const field of c.inputs) {
          if (!input.inputs?.[field.key]?.trim()) throw new ApiError(400, "invalid", `${field.label} is required`, { reason: `Enter ${field.label.toLowerCase()} first.` });
        }
      }
      // Fixture mode round-trips locally: the "network" sends the browser straight back as if it had said yes.
      const server = input.inputs?.instance?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (server === "fail.example") return { authorizeUrl: `/?connect_error=access_denied&connector=${encodeURIComponent(connector)}`, expiresAt: ahead(0.2) };
      const finds =
        OAUTH_FINDS[connector] ??
        (connector === "mastodon"
          ? [{ network: "mastodon" as Network, handle: `northwind@${server || "mastodon.social"}`, name: "Northwind Coffee" }]
          : [{ network: (input.network ?? c.networks[0]!) as Network, handle: "northwindcoffee", name: "Northwind Coffee" }]);
      const list = currentAccounts();
      const added: string[] = [];
      for (const f of finds) {
        if (input.network && f.network !== input.network && connector !== "meta") continue;
        const existing = list.find((a) => a.network === f.network && a.handle === f.handle);
        if (existing) {
          existing.status = "active";
          existing.hasCredentials = true;
        } else {
          state.createdSeq += 1;
          list.push(acct(`acc_${f.network}_${Date.now().toString(36)}_${state.createdSeq}`, f.network, f.handle, f.name, connector, "active", null));
        }
        added.push(f.handle);
      }
      save();
      return { authorizeUrl: `/?connected=${encodeURIComponent(connector)}&handle=${encodeURIComponent(added.join(","))}&count=${added.length}`, expiresAt: ahead(0.2) };
    },

    connectCredentials: async (connector: string, input: ConnectCredentialsInput): Promise<Account[]> => {
      await delay(null, 600);
      const c = connectorsSeed.find((k) => k.name === connector);
      if (!c) throw new ApiError(404, "not_found", "No such connector.");
      for (const field of c.inputs ?? []) {
        if (!input.inputs[field.key]?.trim()) throw new ApiError(400, "invalid", "connect failed", { reason: `Enter ${field.label.toLowerCase()}.` });
      }
      const values = Object.values(input.inputs).map((v) => v.trim());
      if (values.includes("fail")) {
        const reason =
          connector === "bluesky"
            ? "Bluesky said the handle or app password is wrong."
            : connector === "telegram"
              ? "Telegram didn't accept that bot token, or the bot isn't an admin of that channel."
              : "Discord didn't accept that webhook URL.";
        throw new ApiError(400, "invalid", "connect failed", { reason });
      }
      let handle: string;
      let name: string | null = null;
      if (connector === "bluesky") {
        const h = (input.inputs.identifier ?? "").replace(/^@/, "");
        handle = h.includes(".") ? h : `${h}.bsky.social`;
      } else if (connector === "telegram") {
        handle = (input.inputs.chatId ?? "channel").replace(/^@/, "");
        name = "Northwind Coffee updates";
      } else {
        handle = "northwind-community";
        name = "#announcements";
      }
      const list = currentAccounts();
      if (list.some((a) => a.network === input.network && a.handle === handle && a.status === "active")) {
        throw new ApiError(409, "conflict", `That ${networkLabel(input.network)} account is already connected.`);
      }
      const existing = list.find((a) => a.network === input.network && a.handle === handle);
      if (existing) {
        existing.status = "active";
        existing.hasCredentials = true;
        save();
        return clone([existing]);
      }
      state.createdSeq += 1;
      const a = acct(`acc_${input.network}_${Date.now().toString(36)}_${state.createdSeq}`, input.network, handle, name ?? handle, connector, "active", null);
      list.push(a);
      save();
      return clone([a]);
    },

    accountMetrics: async (id: string, _metric: string): Promise<AccountMetrics> => {
      await delay(null, 200 + (id.length % 5) * 60);
      const latest = FOLLOWERS[id];
      if (latest === undefined) return { latest: {}, series: [] };
      const series = Array.from({ length: 30 }, (_, i) => ({ value: Math.round(latest * (0.93 + (0.07 * i) / 29)), observedAt: ago(24 * (29 - i)) }));
      return { latest: { followers_total: latest }, series };
    },

    media: async (): Promise<MediaAsset[]> => delay(mediaLibrary, 180),

    deleteMedia: async (id: string): Promise<void> => {
      await delay(null, 200);
      const idx = mediaLibrary.findIndex((m) => m.id === id);
      if (idx < 0) throw new ApiError(404, "not_found", "No such file.");
      mediaLibrary.splice(idx, 1);
    },

    reply: async (activityId: string, input: ReplyInput): Promise<PostDetail> => {
      await delay(null, 520);
      const item = state.feed.find((a) => a.id === activityId);
      if (!item) throw new ApiError(404, "not_found", "That item is gone.");
      const account = currentAccounts().find((a) => a.id === item.socialAccountId);
      if (!account) throw new ApiError(400, "invalid", "That item didn't come in through a connected account.");
      if (account.status !== "active") throw new ApiError(409, "conflict", `@${account.handle} needs reconnecting before it can reply.`);
      const decision = checkPolicy({ variants: [{ network: account.network, text: input.text }] });
      // Replies from people go out unless a red line says otherwise; a long reply goes to an approver in fixtures.
      const verdict = decision.verdict === "allow" && input.text.length > 240 ? "require_approval" : decision.verdict;
      const status: PostStatus = verdict === "block" ? "blocked" : verdict === "require_approval" ? "pending_approval" : "scheduled";
      state.createdSeq += 1;
      const id = `p_reply_${state.createdSeq}`;
      const now = iso(Date.now());
      const post: Post = {
        ...basePost,
        id,
        status,
        title: null,
        body: input.text,
        media: [],
        scheduledAt: status === "scheduled" ? now : null,
        actionClass: "reply",
        createdBy: currentMe().actor,
        trendTopicId: null,
        trendStageAtCreation: null,
        trendForecastId: null,
        disclosure: { aiAssisted: !!input.aiAssisted, humanReviewed: true },
        evidence: [{ kind: "activity", ref: activityId }],
        policyDecision: { ...decision, verdict },
        createdAt: now,
        updatedAt: now,
      };
      const item2: PostSummary = { post, variants: [variant(`${id}_v0`, id, account.id, account.network, input.text, { status: status === "blocked" ? "skipped" : "pending" })] };
      if (status === "pending_approval") state.queue.push(item2);
      else state.created.push(item2);
      return clone({ post, variants: item2.variants, approvals: approvalsFor(item2) });
    },

    moderate: async (activityId: string, action: ModerateAction): Promise<{ ok: boolean; action: ModerateAction }> => {
      await delay(null, 320);
      const idx = state.feed.findIndex((a) => a.id === activityId);
      if (idx < 0) throw new ApiError(404, "not_found", "That item is gone.");
      if (action === "delete") {
        if (currentWs().role !== "owner" && currentWs().role !== "approver") throw new ApiError(403, "forbidden", "Only owners and approvers can delete comments.");
        state.feed.splice(idx, 1);
      }
      return { ok: true, action };
    },
  };
}

export const fixtureApi = {
  me: () => delay(currentMe()),
  policy: () => delay(policy),
  accounts: () => delay(currentAccounts()),
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

  // --- Compose, calendar, connect (v1.1) ---

  connectors: () => delay(connectorsSeed),

  deleteAccount: async (id: string): Promise<void> => {
    await delay(null, 260);
    const list = currentAccounts();
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new ApiError(404, "not_found", "No such account.");
    list.splice(idx, 1);
    save();
  },

  adapt: async (input: AdaptInput): Promise<AdaptResult> => {
    if (!input.body.trim()) throw new ApiError(400, "invalid", "Write the idea first.");
    const networks = [...new Set(input.networks)];
    const variants = networks.map((n) => adaptFor(n, input.body));
    const threaded = variants.filter((v) => v.thread.length && NETWORK_THREADS.has(v.network));
    const notes = [
      "Kept the voice plain: no exclamation marks, no hype.",
      threaded.length ? `Split into a thread where it ran long.` : null,
      networks.includes("instagram") ? "Instagram gets line breaks and two tags; it still needs an image." : null,
    ].filter((x): x is string => !!x);
    return delay({ variants, notes, usage: { costUsd: 0.0042, model: "claude-opus-5-5" } }, 700);
  },

  policyCheck: async (input: PolicyCheckInput): Promise<PolicyDecision> => delay(checkPolicy(input), 120),

  createPost: async (input: CreatePostInput): Promise<PostDetail> => {
    await delay(null, 380);
    const issues: { code: string; message: string; socialAccountId: string; network: string }[] = [];
    const targets = input.variants.map((v) => {
      const account = currentAccounts().find((a) => a.id === v.socialAccountId);
      if (!account) throw new ApiError(404, "not_found", "One of those accounts is gone.");
      if (account.status === "disabled") throw new ApiError(409, "conflict", `account ${account.handle} is disabled`);
      if (["instagram", "tiktok", "pinterest", "youtube"].includes(account.network) && !(v.media ?? []).length) {
        issues.push({ code: "media_required", message: `${account.network} requires at least one media item`, socialAccountId: account.id, network: account.network });
      }
      const o = v.options ?? {};
      if (["youtube", "reddit", "pinterest"].includes(account.network) && !o.title?.trim()) {
        issues.push({ code: "title_required", message: `${account.network} requires a title`, socialAccountId: account.id, network: account.network });
      }
      if (account.network === "reddit" && !o.subreddit) issues.push({ code: "subreddit_required", message: "reddit requires a subreddit", socialAccountId: account.id, network: account.network });
      if (account.network === "pinterest" && !o.boardId) issues.push({ code: "board_required", message: "pinterest requires a board", socialAccountId: account.id, network: account.network });
      if (account.network === "tiktok" && !o.privacy) issues.push({ code: "privacy_required", message: "tiktok requires a privacy level", socialAccountId: account.id, network: account.network });
      return { v, account };
    });
    if (issues.length) throw new ApiError(400, "invalid", "variant validation failed", issues);

    const decision = checkPolicy({
      variants: targets.map(({ v, account }) => ({ network: account.network, text: [v.text, ...(v.thread ?? [])].join("\n") })),
      scheduledAt: input.scheduledAt,
    });
    const status: PostStatus =
      decision.verdict === "block" ? "blocked" : decision.verdict === "require_approval" ? "pending_approval" : input.scheduledAt ? "scheduled" : "draft";
    state.createdSeq += 1;
    const id = `p_new_${state.createdSeq}`;
    const now = iso(Date.now());
    const item: PostSummary = {
      post: {
        ...basePost,
        id,
        status,
        title: input.title ?? null,
        body: input.body,
        media: input.media ?? [],
        scheduledAt: input.scheduledAt ?? null,
        actionClass: input.actionClass ?? "new_post",
        createdBy: me.actor,
        trendTopicId: input.trendTopicId ?? null,
        trendStageAtCreation: input.trendStageAtCreation ?? null,
        trendForecastId: input.trendForecastId ?? null,
        disclosure: input.disclosure ?? null,
        evidence: input.evidence ?? [],
        policyDecision: decision,
        createdAt: now,
        updatedAt: now,
      },
      variants: targets.map(({ v, account }, i) =>
        variant(`${id}_v${i}`, id, account.id, account.network, v.text, { media: v.media ?? [], thread: v.thread ?? [], status: status === "blocked" ? "skipped" : "pending" }),
      ),
    };
    if (status === "pending_approval") state.queue.push(item);
    else state.created.push(item);
    return clone({ post: item.post, variants: item.variants, approvals: approvalsFor(item) });
  },

  calendar: async (from: string, to: string): Promise<PostSummary[]> => {
    const lo = from ? Date.parse(from) : WEEK_START;
    const hi = to ? Date.parse(to) : WEEK_START + 14 * DAY;
    const seen = new Set<string>();
    const timeOf = (p: Post) => Date.parse(p.publishedAt ?? p.scheduledAt ?? "");
    const items = allPosts().filter((p) => {
      if (seen.has(p.post.id)) return false;
      seen.add(p.post.id);
      const t = timeOf(p.post);
      return CAL_STATUSES.includes(p.post.status) && Number.isFinite(t) && t >= lo && t < hi;
    });
    return delay(items.sort((a, b) => timeOf(a.post) - timeOf(b.post)));
  },

  sources: () => delay(sourcesSeed),
  discoveries: (limit: number) => delay(discoveriesSeed.slice(0, limit)),

  ...peopleApi(),
  ...integrationsApi(),
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
