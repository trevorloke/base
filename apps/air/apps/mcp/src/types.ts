/**
 * Shapes of the base air HTTP API v1 as documented in docs/API.md.
 * Where `@base-air/schema` already defines the shape (posts, variants, activities, ledger events,
 * policy, policy decisions) we reuse it; the rest is declared here against the contract.
 */
import type {
  ActionClass,
  Activity,
  AutonomyLevel,
  CreatePostInputRaw,
  Disclosure,
  LedgerEvent,
  Policy,
  PolicyDecision,
  Post,
  PostVariant,
  RedLineSeverity,
  TrendStage,
} from "@base-air/schema";

export type { Activity, LedgerEvent, Policy, PolicyDecision, Post, PostVariant } from "@base-air/schema";

/** `{ error: { code, message, details } }` as every non-2xx response carries it. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface Actor {
  type: string;
  id: string;
}

/** Free-form brand profile; these keys are conventional (see `PATCH /v1/workspace/profile`). */
export interface BrandProfile {
  description?: string;
  audience?: string;
  topics?: string[];
  voice?: { do?: string[]; dont?: string[]; examples?: string[] };
  competitors?: string[];
  [key: string]: unknown;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  profile: BrandProfile;
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
  network: string;
  externalId: string;
  handle: string;
  displayName: string | null;
  connector: string;
  status: "active" | "reauth_required" | "disabled";
  hasCredentials: boolean;
  lastIngestAt: string | null;
  config: Record<string, unknown>;
}

export interface Approval {
  id: string;
  postId: string;
  state: "requested" | "approved" | "rejected" | "changes_requested";
  requestedBy: unknown;
  decidedBy: unknown;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface PostSummary {
  post: Post;
  variants: PostVariant[];
}

export interface PostDetail extends PostSummary {
  approvals: Approval[];
}

export interface PostWithHistory extends PostDetail {
  history: LedgerEvent[];
}

export interface RadarTopic {
  id: string;
  workspaceId: string | null;
  name: string;
  keywords: string[];
  relevance: number | null;
  createdAt?: string;
}

export interface RadarForecast {
  id: string;
  stage: TrendStage;
  /** 0..1 */
  confidence: number;
  velocity: number;
  hoursToPeak: number | null;
  computedAt: string;
  sources: string[];
  sourceAgreement: number | null;
  curve: { at: string; value: number; lo: number; hi: number }[];
}

export interface RadarEntry {
  topic: RadarTopic;
  forecast: RadarForecast | null;
  /** How many posts the brand already created against this topic. */
  actedOn: number;
  score: number;
  /** Plain-language acting window, e.g. "act within 6h"; null when there is nothing to act on. */
  window: string | null;
}

export interface TopicDetail {
  topic: RadarTopic;
  forecast: RadarForecast | null;
  series: { source: string; points: { t: string; v: number }[] }[];
  actions: {
    postId: string;
    stageAtAction: string | null;
    forecastId: string | null;
    createdAt: string;
    outcome24h: Record<string, unknown> | null;
  }[];
}

export interface MetricsGroup {
  key: string;
  posts: number;
  impressions: number;
  engagements: number;
  avgEngagements: number;
}

export interface TopPost {
  postId: string;
  variantId: string;
  network: string;
  text: string;
  impressions: number;
  engagements: number;
  /** Engagements relative to the 24h baseline (1.0 = baseline); null without a baseline. */
  lift: number | null;
}

export interface MetricsSummary {
  window: Record<string, unknown>;
  publishedByNetwork: { network: string; posts: number }[];
  measuredAt24h: number;
  totals: { impressions: number; engagements: number };
  baselineEngagements24h: number | null;
  byNetwork: MetricsGroup[];
  byHour: MetricsGroup[];
  byTrendStage: MetricsGroup[];
  byAuthor: MetricsGroup[];
  byExperiment: MetricsGroup[];
  top: TopPost[];
}

export interface LiftByStage {
  stage: string;
  posts: number;
  avgEngagements: number;
  lift: number | null;
}

export interface Alert {
  id: string;
  kind: string;
  severity: "info" | "attention" | "urgent";
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

export interface RedLineSummary {
  id: string;
  kind: string;
  description: string;
  severity: RedLineSeverity;
}

/** `GET /v1/context`: everything an agent needs before it drafts. */
export interface BrandContext {
  workspace: { name: string; profile: BrandProfile };
  policy: {
    autonomy: Partial<Record<ActionClass, AutonomyLevel>>;
    redLines: RedLineSummary[];
    timezone: string;
  };
  accounts: Account[];
  recentTop: TopPost[];
  /** Last 20 approval diffs: what a human changed before approving. */
  voiceExamples: { before: string; after: string }[];
  activeTopics: RadarEntry[];
}

export interface FeedQuery {
  q?: string;
  networks?: string[];
  kinds?: string[];
  stream?: string;
  account?: string;
  since?: string;
  before?: string;
  limit?: number;
}

export interface ListPostsQuery {
  status?: string[];
  limit?: number;
}

export interface LedgerQuery {
  types?: string[];
  subjectType?: string;
  subjectId?: string;
  afterSeq?: number;
  limit?: number;
}

export interface AlertsQuery {
  unacknowledgedOnly?: boolean;
  limit?: number;
}

export interface DateRange {
  from: Date | string;
  to: Date | string;
}

export interface PolicyCheckInput {
  variants: { network: string; text: string }[];
  scheduledAt?: string;
  actionClass?: ActionClass;
  disclosure?: Disclosure;
}

/** Body of `POST /v1/posts` (the schema's input type, i.e. before defaults are applied). */
export type CreatePostBody = CreatePostInputRaw;
