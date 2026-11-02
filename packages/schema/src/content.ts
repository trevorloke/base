import { z } from "zod";
import { Actor, Disclosure, Id, Media, Timestamp } from "./common.ts";
import { Network } from "./networks.ts";

export const PostStatus = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "failed",
  "cancelled",
  "blocked",
]);
export type PostStatus = z.infer<typeof PostStatus>;

export const VariantStatus = z.enum(["pending", "publishing", "published", "failed", "skipped"]);
export type VariantStatus = z.infer<typeof VariantStatus>;

export const TrendStage = z.enum(["dormant", "rising", "peaking", "plateau", "fading"]);
export type TrendStage = z.infer<typeof TrendStage>;

/** What a caller supplies to create a post. One idea, N channel variants. */
export const PostVariantInput = z.object({
  socialAccountId: Id,
  text: z.string(),
  media: z.array(Media).default([]),
  /** For threads/carousels: additional segments after the first. */
  thread: z.array(z.string()).default([]),
});
export type PostVariantInput = z.infer<typeof PostVariantInput>;

export const CreatePostInput = z.object({
  title: z.string().max(200).optional(),
  /** Base idea / canonical text. Variants adapt it per network. */
  body: z.string(),
  media: z.array(Media).default([]),
  variants: z.array(PostVariantInput).min(1),
  scheduledAt: Timestamp.optional(),
  actionClass: z.enum(["new_post", "reply", "dm", "repost", "campaign"]).default("new_post"),
  /** Trend context at creation time. This is the join nobody else has. */
  trendTopicId: Id.optional(),
  trendStageAtCreation: TrendStage.optional(),
  trendForecastId: Id.optional(),
  experimentId: Id.optional(),
  /** Variant label inside an experiment, e.g. "hook_a". */
  experimentArm: z.string().optional(),
  disclosure: Disclosure.optional(),
  /** Free-form evidence the creator attaches (operator rationale, links to ledger). */
  evidence: z.array(z.object({ kind: z.string(), ref: z.string(), note: z.string().optional() })).default([]),
  /** Flags that red lines may key on. */
  flags: z.object({ paid: z.boolean().default(false) }).default({ paid: false }),
});
export type CreatePostInput = z.infer<typeof CreatePostInput>;
export type CreatePostInputRaw = z.input<typeof CreatePostInput>;

export const Post = z.object({
  id: Id,
  workspaceId: Id,
  status: PostStatus,
  title: z.string().nullable(),
  body: z.string(),
  media: z.array(Media),
  scheduledAt: Timestamp.nullable(),
  publishedAt: Timestamp.nullable(),
  actionClass: z.string(),
  createdBy: Actor,
  trendTopicId: Id.nullable(),
  trendStageAtCreation: TrendStage.nullable(),
  trendForecastId: Id.nullable(),
  experimentId: Id.nullable(),
  experimentArm: z.string().nullable(),
  disclosure: Disclosure.nullable(),
  evidence: z.array(z.object({ kind: z.string(), ref: z.string(), note: z.string().optional() })),
  policyDecision: z.unknown().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Post = z.infer<typeof Post>;

export const PostVariant = z.object({
  id: Id,
  postId: Id,
  socialAccountId: Id,
  network: Network,
  text: z.string(),
  media: z.array(Media),
  thread: z.array(z.string()),
  status: VariantStatus,
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  publishedAt: Timestamp.nullable(),
  error: z.string().nullable(),
  attemptCount: z.number().int(),
});
export type PostVariant = z.infer<typeof PostVariant>;

export const ApprovalState = z.enum(["requested", "approved", "rejected", "changes_requested"]);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const ApprovalDecisionInput = z.object({
  decision: z.enum(["approve", "reject", "request_changes"]),
  note: z.string().optional(),
  /** Edited variant texts, keyed by variant id. Diffs are recorded as training signal. */
  edits: z.record(z.string(), z.string()).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;
