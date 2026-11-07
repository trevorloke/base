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
  /** A message in a group chat, channel or server the account is part of (Discord, Telegram, WhatsApp, LINE, WeChat). */
  "message",
]);
export type ActivityKind = z.infer<typeof ActivityKind>;

export const Conversation = z.object({
  /** The platform's id for the chat (group id, channel id, chat id). */
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  type: z.enum(["group", "channel", "direct"]),
});
export type Conversation = z.infer<typeof Conversation>;

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
  /** Where a chat message was said: the group, channel or server channel, or a direct conversation. */
  conversation: Conversation.optional(),
  /** Language the connector already knows (e.g. from the platform); otherwise base air detects it at ingest. */
  lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional(),
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
  lang: z.string().nullable(),
  translation: z.string().nullable(),
  translationLang: z.string().nullable(),
});
export type Activity = z.infer<typeof Activity>;

/** A saved search: keywords, accounts, networks. The live feed is a set of these plus own accounts. */
export const StreamQuery = z.object({
  keywords: z.array(z.string()).default([]),
  /** Match any of these author handles. */
  authors: z.array(z.string()).default([]),
  networks: z.array(Network).default([]),
  kinds: z.array(ActivityKind).default([]),
  /** Only these languages (ISO 639-1). Empty: every language, including unknown. */
  languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).default([]),
  /** The keywords as people write them in other languages (lang → terms), usually filled by "expand to languages". */
  translations: z.record(z.string(), z.array(z.string())).default({}),
});
export type StreamQuery = z.infer<typeof StreamQuery>;
