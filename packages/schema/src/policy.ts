import { z } from "zod";

/**
 * Autonomy: how far an operator (or an MCP-connected agent) may go without a human, per class of action.
 *   suggest                 -> may only surface ideas; nothing is created
 *   draft                   -> may create drafts; a human must schedule
 *   schedule_with_approval  -> may schedule; nothing publishes until approved
 *   autopost                -> may publish directly (still subject to red lines)
 */
export const AutonomyLevel = z.enum(["suggest", "draft", "schedule_with_approval", "autopost"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const ActionClass = z.enum(["new_post", "reply", "dm", "repost", "campaign"]);
export type ActionClass = z.infer<typeof ActionClass>;

export const AUTONOMY_ORDER: AutonomyLevel[] = ["suggest", "draft", "schedule_with_approval", "autopost"];

export const RedLineSeverity = z.enum(["block", "require_approval", "warn"]);
export type RedLineSeverity = z.infer<typeof RedLineSeverity>;

/**
 * A red line is a declared constraint a brand never crosses. Enforced on every output, from every actor.
 * Declaring one is a credibility contract; the system holds it even when a human is tempted.
 */
export const RedLine = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("forbidden_phrase"),
    description: z.string(),
    severity: RedLineSeverity,
    /** Case-insensitive, word-boundary matched. */
    phrases: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("forbidden_topic"),
    description: z.string(),
    severity: RedLineSeverity,
    /** Keywords that indicate the topic; semantic classifier may extend this. */
    keywords: z.array(z.string().min(1)).min(1),
    /** When true, the semantic classifier is consulted even if no keyword matches. */
    semantic: z.boolean().default(false),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("forbidden_claim"),
    description: z.string(),
    severity: RedLineSeverity,
    /** Regexes (without flags) describing claim shapes, e.g. "guarantee[sd]? .* results". */
    patterns: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("no_competitor_mention"),
    description: z.string(),
    severity: RedLineSeverity,
    competitors: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("quiet_hours"),
    description: z.string(),
    severity: RedLineSeverity,
    /** IANA zone the hours are expressed in. */
    timezone: z.string(),
    /** Inclusive start hour, exclusive end hour, 0-23. start > end wraps midnight. */
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
    /** 0 = Sunday ... 6 = Saturday. Empty = every day. */
    days: z.array(z.number().int().min(0).max(6)).default([]),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("required_disclosure"),
    description: z.string(),
    severity: RedLineSeverity,
    /** Text (or hashtag) that must appear when the condition holds. */
    requiredText: z.string().min(1),
    /** "ai_assisted" -> when the post is machine-assisted; "always" -> every post; "paid" -> when flagged paid. */
    when: z.enum(["ai_assisted", "always", "paid"]),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("max_posts_per_day"),
    description: z.string(),
    severity: RedLineSeverity,
    limit: z.number().int().positive(),
    /** Restrict to networks; empty = all. */
    networks: z.array(z.string()).default([]),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("network_restriction"),
    description: z.string(),
    severity: RedLineSeverity,
    /** Networks this workspace never posts to. */
    networks: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("custom_regex"),
    description: z.string(),
    severity: RedLineSeverity,
    pattern: z.string().min(1),
    flags: z.string().default("i"),
  }),
]);
export type RedLine = z.infer<typeof RedLine>;

export const SpendCaps = z.object({
  /** Monthly ceiling on metered X API reads, in USD. 0 disables X reads. */
  xReadsUsdMonthly: z.number().nonnegative().default(50),
  /** Monthly ceiling on model spend for this workspace, in USD. */
  modelUsdMonthly: z.number().nonnegative().default(100),
});
export type SpendCaps = z.infer<typeof SpendCaps>;

export const DisclosurePolicy = z.object({
  /** Always attach the internal disclosure record (never off; here for explicitness). */
  recordAlways: z.literal(true).default(true),
  /** Sign exported media with C2PA when the pipeline supports it. */
  signMedia: z.boolean().default(true),
  /** Append a visible disclosure to AI-assisted posts, e.g. "#AIassisted". Empty = none. */
  visibleTextForAi: z.string().default(""),
});

export const Policy = z.object({
  version: z.number().int().positive(),
  autonomy: z.record(ActionClass, AutonomyLevel),
  /** Humans with the editor role still need an approver when true. Owners/approvers never do. */
  requireApprovalForEditors: z.boolean().default(true),
  redLines: z.array(RedLine).default([]),
  spendCaps: SpendCaps.default({ xReadsUsdMonthly: 50, modelUsdMonthly: 100 }),
  disclosure: DisclosurePolicy.default({ recordAlways: true, signMedia: true, visibleTextForAi: "" }),
  /** Competitor set used by analytics and the no_competitor_mention red line. */
  competitors: z.array(z.string()).default([]),
  timezone: z.string().default("UTC"),
});
export type Policy = z.infer<typeof Policy>;

/** A conservative default for a brand on day one. Trust is earned through the ledger; the dial moves later. */
export const DEFAULT_POLICY: Policy = Policy.parse({
  version: 1,
  autonomy: {
    new_post: "schedule_with_approval",
    reply: "draft",
    dm: "suggest",
    repost: "draft",
    campaign: "suggest",
  },
  requireApprovalForEditors: true,
  redLines: [],
  competitors: [],
  timezone: "UTC",
});

export const PolicyVerdict = z.enum(["allow", "require_approval", "block"]);
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;

export const Violation = z.object({
  redLineId: z.string(),
  kind: z.string(),
  severity: RedLineSeverity,
  message: z.string(),
  /** The offending span(s), when text-based. */
  matches: z.array(z.string()).default([]),
});
export type Violation = z.infer<typeof Violation>;

export const PolicyDecision = z.object({
  verdict: PolicyVerdict,
  violations: z.array(Violation),
  /** Autonomy that applied to the actor for this action, when relevant. */
  autonomy: AutonomyLevel.optional(),
  policyVersion: z.number().int(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;
