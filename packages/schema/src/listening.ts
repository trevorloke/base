import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { Network } from "./networks.ts";

export const ActivityKind = z.enum([
  "own_post",
  "reply",
  "mention",
  "comment",
  "dm",
  "repost",
  "quote",
  "like",
  "follow",
]);
export type ActivityKind = z.infer<typeof ActivityKind>;

/** A normalized inbound item from any network. Raw payload is kept separately, immutably. */
export const ActivityInput = z.object({
  network: Network,
  kind: ActivityKind,
  externalId: z.string(),
  authorHandle: z.string().nullable(),
  authorName: z.string().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  parentExternalId: z.string().nullable(),
  occurredAt: Timestamp,
  raw: z.unknown(),
});
export type ActivityInput = z.infer<typeof ActivityInput>;

export const Activity = ActivityInput.omit({ raw: true }).extend({
  id: Id,
  workspaceId: Id,
  socialAccountId: Id.nullable(),
  ingestedAt: Timestamp,
  sentiment: z.number().min(-1).max(1).nullable(),
  matchedStreams: z.array(Id),
  rawEventId: Id.nullable(),
});
export type Activity = z.infer<typeof Activity>;

/** A saved search: keywords, accounts, networks. The live feed is a set of these plus own accounts. */
export const StreamQuery = z.object({
  keywords: z.array(z.string()).default([]),
  /** Match any of these author handles. */
  authors: z.array(z.string()).default([]),
  networks: z.array(Network).default([]),
  kinds: z.array(ActivityKind).default([]),
});
export type StreamQuery = z.infer<typeof StreamQuery>;
