// Types mirroring docs/API.md (Starsign HTTP API v1). Kept hand-written so the web app
// has no build-time dependency on the server packages.

export type Network =
  | "x"
  | "bluesky"
  | "threads"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "mastodon";

export type ActorType = "human" | "operator" | "mcp" | "system";
export interface Actor {
  type: ActorType;
  id: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  profile: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface Me {
  workspace: Workspace;
  actor: Actor;
  role: string | null;
}

export interface Account {
  id: string;
  network: Network;
  externalId: string;
  handle: string;
  displayName: string | null;
  connector: string;
  status: "active" | "reauth_required" | "disabled";
  hasCredentials: boolean;
  lastIngestAt: string | null;
  config: Record<string, unknown>;
}

// --- Policy -------------------------------------------------------------

export type AutonomyLevel = "suggest" | "draft" | "schedule_with_approval" | "autopost";
export type ActionClass = "new_post" | "reply" | "dm" | "repost" | "campaign";
export type RedLineSeverity = "block" | "require_approval" | "warn";

export interface RedLine {
  id: string;
  kind: string;
  description: string;
  severity: RedLineSeverity;
  [extra: string]: unknown;
}

export interface Policy {
  version: number;
  autonomy: Partial<Record<ActionClass, AutonomyLevel>>;
  requireApprovalForEditors: boolean;
  redLines: RedLine[];
  competitors: string[];
  timezone: string;
}

export interface Violation {
  redLineId: string;
  kind: string;
  severity: RedLineSeverity;
  message: string;
  matches: string[];
}

export interface PolicyDecision {
  verdict: "allow" | "require_approval" | "block";
  violations: Violation[];
  autonomy?: AutonomyLevel;
  policyVersion: number;
}

// --- Posts --------------------------------------------------------------

export type PostStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "partially_published"
  | "failed"
  | "cancelled"
  | "blocked";

export type VariantStatus = "pending" | "publishing" | "published" | "failed" | "skipped";
export type TrendStage = "dormant" | "rising" | "peaking" | "plateau" | "fading";

export interface Media {
  kind: "image" | "video" | "gif" | "document";
  url: string;
  alt?: string;
}

export interface Disclosure {
  aiAssisted: boolean;
  aiContributions?: string[];
  humanReviewed: boolean;
  reviewedBy?: string;
  model?: string;
  promptVersion?: string;
}

export interface Evidence {
  kind: string;
  ref: string;
  note?: string;
}

export interface Post {
  id: string;
  workspaceId: string;
  status: PostStatus;
  title: string | null;
  body: string;
  media: Media[];
  scheduledAt: string | null;
  publishedAt: string | null;
  actionClass: ActionClass | string;
  createdBy: Actor;
  trendTopicId: string | null;
  trendStageAtCreation: TrendStage | null;
  trendForecastId: string | null;
  experimentId: string | null;
  experimentArm: string | null;
  disclosure: Disclosure | null;
  evidence: Evidence[];
  policyDecision: PolicyDecision | null;
  createdAt: string;
  updatedAt: string;
}

export interface Variant {
  id: string;
  postId: string;
  socialAccountId: string;
  network: Network;
  text: string;
  media: Media[];
  thread: string[];
  status: VariantStatus;
  externalId: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  error: string | null;
  attemptCount: number;
}

export interface Approval {
  id: string;
  postId: string;
  state: "requested" | "approved" | "rejected" | "changes_requested";
  requestedBy: Actor | null;
  decidedBy: Actor | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface PostSummary {
  post: Post;
  variants: Variant[];
}

export interface PostDetail extends PostSummary {
  approvals: Approval[];
}

export interface PostFull extends PostDetail {
  history: LedgerEvent[];
}

export interface DecideInput {
  decision: "approve" | "reject" | "request_changes";
  note?: string;
  edits?: Record<string, string>;
}

export interface LedgerEvent {
  id: string;
  seq: number;
  workspaceId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  actor: Actor;
  data: Record<string, unknown>;
  occurredAt: string;
}

// --- Listening ----------------------------------------------------------

export type ActivityKind =
  | "own_post"
  | "reply"
  | "mention"
  | "comment"
  | "dm"
  | "repost"
  | "quote"
  | "like"
  | "follow";

export interface Activity {
  id: string;
  workspaceId: string;
  socialAccountId: string | null;
  network: Network;
  kind: ActivityKind;
  externalId: string;
  authorHandle: string | null;
  authorName: string | null;
  text: string | null;
  url: string | null;
  parentExternalId: string | null;
  occurredAt: string;
  ingestedAt: string;
  sentiment: number | null;
  matchedStreams: string[];
  rawEventId: string | null;
}

export interface Stream {
  id: string;
  name: string;
  query: { keywords: string[]; authors: string[]; networks: Network[]; kinds: ActivityKind[] };
  createdAt: string;
}

export interface FeedQuery {
  stream?: string;
  networks?: Network[];
  kinds?: ActivityKind[];
  account?: string;
  since?: string;
  before?: string;
  limit?: number;
  q?: string;
}

// --- Measurement --------------------------------------------------------

export interface Group {
  key: string;
  posts: number;
  impressions: number;
  engagements: number;
  avgEngagements: number;
}

export interface TopPost {
  postId: string;
  variantId: string;
  network: Network;
  text: string;
  impressions: number;
  engagements: number;
  lift: number;
}

export interface Summary {
  window: { from: string; to: string };
  publishedByNetwork: { network: Network; posts: number }[];
  measuredAt24h: number;
  totals: { impressions: number; engagements: number };
  baselineEngagements24h: number;
  byNetwork: Group[];
  byHour: Group[];
  byTrendStage: Group[];
  byAuthor: Group[];
  byExperiment: Group[];
  top: TopPost[];
}

export interface LiftByStage {
  stage: TrendStage;
  posts: number;
  avgEngagements: number;
  lift: number;
}

// --- Trends -------------------------------------------------------------

export interface ForecastPoint {
  at: string;
  value: number;
  lo: number;
  hi: number;
}

export interface Forecast {
  id: string;
  stage: TrendStage;
  /** 0..1 */
  confidence: number;
  velocity: number;
  hoursToPeak: number | null;
  computedAt: string;
  sources: string[];
  sourceAgreement: number | null;
  curve: ForecastPoint[];
}

export interface Topic {
  id: string;
  workspaceId: string | null;
  name: string;
  keywords: string[];
  relevance: number | null;
  createdAt?: string;
}

export interface RadarEntry {
  topic: Topic;
  forecast: Forecast | null;
  actedOn: number;
  score: number;
  window: string | null;
}

export interface SeriesPoint {
  t: string;
  v: number;
}

export interface TopicSeries {
  source: string;
  points: SeriesPoint[];
}

export interface TopicAction {
  postId: string;
  stageAtAction: TrendStage | null;
  forecastId: string | null;
  createdAt: string;
  outcome24h: Record<string, unknown> | null;
}

export interface TopicDetail {
  topic: Topic;
  forecast: Forecast | null;
  series: TopicSeries[];
  actions: TopicAction[];
}

// --- Operators' output --------------------------------------------------

export type AlertSeverity = "info" | "attention" | "urgent";

export interface Alert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string | null;
  evidence: unknown;
  topicId: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface Brief {
  id: string;
  periodStart: string;
  periodEnd: string;
  contentMd: string;
  evidence: unknown;
  runId: string | null;
  createdAt: string;
}

// --- Live stream (SSE) --------------------------------------------------

export type FeedEvent =
  | { type: "activity"; data: { workspaceId: string; id: string; network: Network; kind: ActivityKind; matchedStreams: string[] } }
  | { type: "post"; data: { workspaceId: string; postId: string; status: PostStatus } }
  | { type: "alert"; data: { workspaceId: string; id: string; title: string; severity: AlertSeverity } }
  | { type: "forecast"; data: { topicId: string; stage: TrendStage; confidence: number } };

export type LiveStatus = "live" | "connecting" | "off";

// --- Compose, calendar, connect (v1.1) -----------------------------------

export type ConnectMethod = "app_password" | "oauth" | "api_key" | "none";

/** GET /v1/connectors: which networks this deployment can connect, and how. */
export interface Connector {
  name: string;
  networks: Network[];
  configured: boolean;
  connect: ConnectMethod;
}

export interface ConnectBlueskyInput {
  identifier: string;
  appPassword: string;
  service?: string;
}

/** POST /v1/accounts/connect/x/start: where to send the person's browser to authorize X. */
export interface OAuthStart {
  authorizeUrl: string;
  expiresAt: string;
}

export interface AdaptInput {
  body: string;
  networks: Network[];
  topicId?: string;
}

export interface AdaptedVariant {
  network: Network;
  text: string;
  thread: string[];
}

export interface AdaptResult {
  variants: AdaptedVariant[];
  /** The contract leaves the shape open; the room accepts a sentence or a list of them. */
  notes: string | string[] | null;
  usage: { costUsd: number; model: string };
}

export interface PolicyCheckInput {
  variants: { network: Network; text: string }[];
  scheduledAt?: string;
  actionClass?: ActionClass;
  disclosure?: Disclosure;
}

export interface CreateVariantInput {
  socialAccountId: string;
  text: string;
  media?: Media[];
  thread?: string[];
}

export interface CreatePostInput {
  title?: string;
  body: string;
  media?: Media[];
  variants: CreateVariantInput[];
  scheduledAt?: string;
  actionClass?: ActionClass;
  trendTopicId?: string;
  trendStageAtCreation?: TrendStage;
  trendForecastId?: string;
  experimentId?: string;
  experimentArm?: string;
  disclosure?: Disclosure;
  evidence?: Evidence[];
  flags?: { paid?: boolean };
}

/** One per-variant problem from a 400 on POST /v1/posts (`details` is a list of these). */
export interface VariantIssue {
  code: string;
  message: string;
  segment?: number;
  socialAccountId?: string;
  network?: string;
}

/** GET /v1/sources: the trend sources this deployment pulls from. */
export interface TrendSource {
  name: string;
  kind: "sample" | "trending" | "both";
  configured: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  pointsLast24h: number;
}

/** GET /v1/trends/discoveries: raw "trending now" terms the scout saw. */
export interface Discovery {
  term: string;
  source: string;
  value: number | null;
  url: string | null;
  observedAt: string;
  region: string | null;
}

/** What the composer starts from when it opens from a topic. */
export interface ComposePrefill {
  body?: string;
  topicId?: string;
  topicName?: string;
  stage?: TrendStage;
  forecastId?: string;
}
