import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
/** Mirrors @starsign/schema Actor without a cross-package import (db stays a leaf). */
export type ActorJson = { type: "human" | "operator" | "mcp" | "system"; id: string };
const now = () => ts("created_at").notNull().defaultNow();

// ---------------------------------------------------------------- tenancy

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Brand profile: description, audience, topics of interest, tone notes. Grounds every model call. */
  profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: now(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: now(),
});

export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").$type<"owner" | "approver" | "editor" | "viewer">().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("members_ws_user").on(t.workspaceId, t.userId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** sha256 of the secret; the secret is shown once. */
    keyHash: text("key_hash").notNull().unique(),
    name: text("name").notNull(),
    /** "human" keys act as this user; "agent" keys act as an MCP/operator actor. */
    actorType: text("actor_type").$type<"human" | "mcp" | "operator">().notNull(),
    actorId: text("actor_id").notNull(),
    role: text("role").$type<"owner" | "approver" | "editor" | "viewer">(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: now(),
  },
  (t) => [index("api_keys_ws").on(t.workspaceId)],
);

// ---------------------------------------------------------------- accounts

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    network: text("network").notNull(),
    externalId: text("external_id").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    /** Which adapter publishes/reads for this account: "mock" | "bluesky" | "x" | "zernio" | ... */
    connector: text("connector").notNull(),
    /** AES-256-GCM ciphertext (base64) of the credential blob. Never stored in clear. */
    authCiphertext: text("auth_ciphertext"),
    status: text("status").$type<"active" | "reauth_required" | "disabled">().notNull().default("active"),
    /** Connector-specific non-secret config. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    lastIngestAt: ts("last_ingest_at"),
    createdAt: now(),
  },
  (t) => [uniqueIndex("social_accounts_ws_net_ext").on(t.workspaceId, t.network, t.externalId)],
);

// ---------------------------------------------------------------- policy

export const policies = pgTable(
  "policies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    version: integer("version").notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("policies_ws_version").on(t.workspaceId, t.version)],
);

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    policyVersion: integer("policy_version").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    verdict: text("verdict").notNull(),
    violations: jsonb("violations").$type<unknown[]>().notNull().default([]),
    actor: jsonb("actor").$type<ActorJson>().notNull(),
    createdAt: now(),
  },
  (t) => [index("policy_decisions_subject").on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------- content

export const posts = pgTable(
  "posts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    status: text("status").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    media: jsonb("media").$type<unknown[]>().notNull().default([]),
    scheduledAt: ts("scheduled_at"),
    publishedAt: ts("published_at"),
    actionClass: text("action_class").notNull().default("new_post"),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    trendTopicId: text("trend_topic_id"),
    trendStageAtCreation: text("trend_stage_at_creation"),
    trendForecastId: text("trend_forecast_id"),
    experimentId: text("experiment_id"),
    experimentArm: text("experiment_arm"),
    disclosure: jsonb("disclosure").$type<Record<string, unknown>>(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
    policyDecision: jsonb("policy_decision").$type<Record<string, unknown>>(),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("posts_ws_status").on(t.workspaceId, t.status), index("posts_ws_sched").on(t.workspaceId, t.scheduledAt)],
);

export const postVariants = pgTable(
  "post_variants",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull().references(() => posts.id),
    socialAccountId: text("social_account_id").notNull().references(() => socialAccounts.id),
    network: text("network").notNull(),
    text: text("text").notNull(),
    media: jsonb("media").$type<unknown[]>().notNull().default([]),
    thread: jsonb("thread").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("pending"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    publishedAt: ts("published_at"),
    error: text("error"),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (t) => [index("post_variants_post").on(t.postId), index("post_variants_account").on(t.socialAccountId)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull().references(() => posts.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    state: text("state").notNull(),
    requestedBy: jsonb("requested_by").$type<ActorJson>().notNull(),
    decidedBy: jsonb("decided_by").$type<ActorJson>(),
    decidedAt: ts("decided_at"),
    note: text("note"),
    createdAt: now(),
  },
  (t) => [index("approvals_post").on(t.postId), index("approvals_ws_state").on(t.workspaceId, t.state)],
);

/** The training signal: what a human changed in a draft before it went out. */
export const approvalDiffs = pgTable(
  "approval_diffs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    postId: text("post_id").notNull().references(() => posts.id),
    variantId: text("variant_id").references(() => postVariants.id),
    beforeText: text("before_text").notNull(),
    afterText: text("after_text").notNull(),
    /** Who wrote the before (operator/mcp/human) and who edited. */
    draftedBy: jsonb("drafted_by").$type<ActorJson>().notNull(),
    editedBy: jsonb("edited_by").$type<ActorJson>().notNull(),
    createdAt: now(),
  },
  (t) => [index("approval_diffs_ws").on(t.workspaceId)],
);

export const experiments = pgTable("experiments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  hypothesis: text("hypothesis").notNull(),
  status: text("status").$type<"draft" | "running" | "concluded">().notNull().default("draft"),
  arms: jsonb("arms").$type<{ key: string; description: string }[]>().notNull().default([]),
  primaryMetric: text("primary_metric").notNull().default("engagements"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: now(),
});

// ---------------------------------------------------------------- listening

export const streams = pgTable("streams", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  query: jsonb("query").$type<Record<string, unknown>>().notNull(),
  createdAt: now(),
});

export const activities = pgTable(
  "activities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    socialAccountId: text("social_account_id").references(() => socialAccounts.id),
    network: text("network").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    authorHandle: text("author_handle"),
    authorName: text("author_name"),
    text: text("text"),
    url: text("url"),
    parentExternalId: text("parent_external_id"),
    occurredAt: ts("occurred_at").notNull(),
    ingestedAt: ts("ingested_at").notNull().defaultNow(),
    sentiment: doublePrecision("sentiment"),
    matchedStreams: jsonb("matched_streams").$type<string[]>().notNull().default([]),
    rawEventId: text("raw_event_id"),
  },
  (t) => [
    uniqueIndex("activities_ws_net_ext").on(t.workspaceId, t.network, t.externalId),
    index("activities_ws_time").on(t.workspaceId, t.occurredAt),
  ],
);

// ---------------------------------------------------------------- measurement

/** Time series. Hypertable when TimescaleDB is present; plain indexed table otherwise. No PK by design. */
export const metrics = pgTable(
  "metrics",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    observedAt: ts("observed_at").notNull(),
    source: text("source").notNull(),
  },
  (t) => [index("metrics_entity_time").on(t.entityType, t.entityId, t.metric, t.observedAt)],
);

export const postOutcomes = pgTable(
  "post_outcomes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    postId: text("post_id").notNull().references(() => posts.id),
    variantId: text("variant_id").notNull().references(() => postVariants.id),
    offsetLabel: text("offset_label").notNull(),
    dueAt: ts("due_at").notNull(),
    capturedAt: ts("captured_at"),
    metrics: jsonb("metrics").$type<Record<string, number>>(),
    status: text("status").$type<"due" | "captured" | "skipped">().notNull().default("due"),
  },
  (t) => [uniqueIndex("post_outcomes_variant_offset").on(t.variantId, t.offsetLabel), index("post_outcomes_due").on(t.status, t.dueAt)],
);

// ---------------------------------------------------------------- trends

export const trendTopics = pgTable(
  "trend_topics",
  {
    id: text("id").primaryKey(),
    /** null = global topic shared across workspaces */
    workspaceId: text("workspace_id").references(() => workspaces.id),
    name: text("name").notNull(),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    relevance: doublePrecision("relevance"),
    createdAt: now(),
  },
  (t) => [index("trend_topics_ws").on(t.workspaceId)],
);

export const trendPoints = pgTable(
  "trend_points",
  {
    topicId: text("topic_id").notNull().references(() => trendTopics.id),
    source: text("source").notNull(),
    region: text("region").notNull().default("global"),
    value: doublePrecision("value").notNull(),
    observedAt: ts("observed_at").notNull(),
  },
  (t) => [index("trend_points_topic_time").on(t.topicId, t.source, t.observedAt)],
);

export const trendForecasts = pgTable(
  "trend_forecasts",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id").notNull().references(() => trendTopics.id),
    computedAt: ts("computed_at").notNull().defaultNow(),
    stage: text("stage").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    velocity: doublePrecision("velocity").notNull(),
    acceleration: doublePrecision("acceleration").notNull(),
    hoursToPeak: doublePrecision("hours_to_peak"),
    horizonHours: integer("horizon_hours").notNull(),
    curve: jsonb("curve").$type<unknown[]>().notNull(),
    modelVersion: text("model_version").notNull(),
    sourceAgreement: doublePrecision("source_agreement"),
    sources: jsonb("sources").$type<string[]>().notNull().default([]),
  },
  (t) => [index("trend_forecasts_topic_time").on(t.topicId, t.computedAt)],
);

/** The join nobody else has: which post rode which topic, at what stage, against which forecast. */
export const trendActions = pgTable(
  "trend_actions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    postId: text("post_id").notNull().references(() => posts.id),
    topicId: text("topic_id").notNull().references(() => trendTopics.id),
    stageAtAction: text("stage_at_action").notNull(),
    forecastId: text("forecast_id"),
    createdAt: now(),
  },
  (t) => [index("trend_actions_topic").on(t.topicId), index("trend_actions_ws").on(t.workspaceId)],
);

// ---------------------------------------------------------------- embeddings (pgvector)

export const embeddings = pgTable(
  "embeddings",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.entityType, t.entityId, t.model] })],
);

// ---------------------------------------------------------------- event store (append-only)

export const rawEvents = pgTable(
  "raw_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    workspaceId: text("workspace_id"),
    externalId: text("external_id"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
    /** sha256 of canonical payload; lets ingestion skip exact duplicates. */
    hash: text("hash").notNull(),
  },
  (t) => [index("raw_events_source_time").on(t.source, t.receivedAt), index("raw_events_hash").on(t.hash)],
);

export const ledgerEvents = pgTable(
  "ledger_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
    type: text("type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    actor: jsonb("actor").$type<ActorJson>().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [index("ledger_ws_time").on(t.workspaceId, t.occurredAt), index("ledger_subject").on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------- operators

export const operatorRuns = pgTable(
  "operator_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    operator: text("operator").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull().default("running"),
    summary: text("summary"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("operator_runs_ws").on(t.workspaceId, t.startedAt)],
);

export const briefs = pgTable("briefs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  periodStart: ts("period_start").notNull(),
  periodEnd: ts("period_end").notNull(),
  contentMd: text("content_md").notNull(),
  evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
  runId: text("run_id"),
  createdAt: now(),
});

export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull(),
    severity: text("severity").$type<"info" | "attention" | "urgent">().notNull().default("attention"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
    topicId: text("topic_id"),
    acknowledgedAt: ts("acknowledged_at"),
    createdAt: now(),
  },
  (t) => [index("alerts_ws").on(t.workspaceId, t.createdAt)],
);

/** Pending OAuth authorizations (PKCE). The verifier is encrypted; rows expire after ten minutes. */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  connector: text("connector").notNull(),
  network: text("network").notNull(),
  verifierCiphertext: text("verifier_ciphertext").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  actor: jsonb("actor").$type<ActorJson>().notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: now(),
});

export const schemaMigrations = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  appliedAt: ts("applied_at").notNull().default(sql`now()`),
});
