import { z } from "zod";
import { Actor, Id, Timestamp } from "./common.ts";

/**
 * Starsign Open Event Schema v0.
 *
 * Two append-only logs:
 *  - raw_events:    every payload received from any source, verbatim. Never updated, never deleted.
 *  - ledger_events: every domain fact Starsign asserts (a post was created, a policy blocked something,
 *                   an operator acted, an outcome was captured). Derived tables are rebuildable from these.
 */
export const RawEventInput = z.object({
  source: z.string().min(1),
  kind: z.string().min(1),
  workspaceId: Id.nullable(),
  externalId: z.string().nullable(),
  payload: z.unknown(),
  receivedAt: Timestamp.optional(),
});
export type RawEventInput = z.input<typeof RawEventInput>;

export const LedgerEventType = z.enum([
  "workspace.created",
  "account.connected",
  "account.disconnected",
  "policy.updated",
  "policy.evaluated",
  "policy.blocked",
  "post.created",
  "post.updated",
  "post.approval_requested",
  "post.approval_decided",
  "post.scheduled",
  "post.publish_started",
  "variant.published",
  "variant.failed",
  "post.published",
  "post.failed",
  "post.cancelled",
  "activity.ingested",
  "metric.observed",
  "outcome.scheduled",
  "outcome.captured",
  "trend.points_recorded",
  "trend.forecast_computed",
  "trend.action_recorded",
  "operator.run_started",
  "operator.run_finished",
  "operator.proposal",
  "operator.alert",
  "brief.written",
  "export.requested",
]);
export type LedgerEventType = z.infer<typeof LedgerEventType>;

export const LedgerEventInput = z.object({
  workspaceId: Id,
  type: LedgerEventType,
  subjectType: z.string().min(1),
  subjectId: Id,
  actor: Actor,
  data: z.record(z.string(), z.unknown()).default({}),
  occurredAt: Timestamp.optional(),
});
export type LedgerEventInput = z.input<typeof LedgerEventInput>;

export const LedgerEvent = LedgerEventInput.extend({
  id: Id,
  occurredAt: Timestamp,
  seq: z.number().int(),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

export const SCHEMA_VERSION = "0.1.0";
