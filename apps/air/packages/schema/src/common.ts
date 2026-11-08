import { z } from "zod";

export const Id = z.string().min(1);
export const Timestamp = z.string().datetime({ offset: true });

/** Who caused something. Every ledger event, policy decision and post carries one. */
export const ActorType = z.enum(["human", "operator", "mcp", "system"]);
export type ActorType = z.infer<typeof ActorType>;

export const Actor = z.object({
  type: ActorType,
  /** user id, operator name (e.g. "watch"), mcp client id, or "system" */
  id: z.string().min(1),
});
export type Actor = z.infer<typeof Actor>;

export const Media = z.object({
  kind: z.enum(["image", "video", "gif", "document"]),
  url: z.string().url(),
  alt: z.string().optional(),
  mime: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  /** Size in bytes, when known (uploads always know). */
  bytes: z.number().int().nonnegative().optional(),
  /** base air media library id when the file was uploaded here. */
  assetId: z.string().optional(),
  /** C2PA manifest attached on export, when signed. */
  contentCredentials: z
    .object({ signed: z.boolean(), manifestUrl: z.string().url().optional() })
    .optional(),
});
export type Media = z.infer<typeof Media>;

/** Disclosure record: what was machine-assisted, kept with the post regardless of platform labels. */
export const Disclosure = z.object({
  aiAssisted: z.boolean(),
  /** e.g. ["text_drafted", "image_generated", "text_edited"] */
  aiContributions: z.array(z.string()).default([]),
  humanReviewed: z.boolean(),
  reviewedBy: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
});
export type Disclosure = z.infer<typeof Disclosure>;
