import { z } from "zod";

/** Every network Meridian can observe or publish to. Open protocols first-class. */
export const Network = z.enum([
  "x",
  "bluesky",
  "threads",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "pinterest",
  "mastodon",
]);
export type Network = z.infer<typeof Network>;

/** Hard publishing limits per network. Soft limits (engagement cliffs) live in the ledger, learned. */
export interface NetworkLimits {
  /** Max characters (graphemes for Bluesky) in a primary text body. */
  maxText: number;
  /** Max media attachments on one post. */
  maxMedia: number;
  /** Networks that cannot publish text-only posts. */
  requiresMedia: boolean;
  /** Whether the network supports native threads/carousels. */
  supportsThread: boolean;
  /** Approx. max video seconds for an organic post, if relevant. */
  maxVideoSeconds?: number;
}

export const NETWORK_LIMITS: Record<Network, NetworkLimits> = {
  x: { maxText: 280, maxMedia: 4, requiresMedia: false, supportsThread: true, maxVideoSeconds: 140 },
  bluesky: { maxText: 300, maxMedia: 4, requiresMedia: false, supportsThread: true, maxVideoSeconds: 180 },
  threads: { maxText: 500, maxMedia: 20, requiresMedia: false, supportsThread: true, maxVideoSeconds: 300 },
  instagram: { maxText: 2200, maxMedia: 10, requiresMedia: true, supportsThread: true, maxVideoSeconds: 900 },
  facebook: { maxText: 63206, maxMedia: 10, requiresMedia: false, supportsThread: false },
  linkedin: { maxText: 3000, maxMedia: 20, requiresMedia: false, supportsThread: false, maxVideoSeconds: 900 },
  tiktok: { maxText: 4000, maxMedia: 35, requiresMedia: true, supportsThread: false, maxVideoSeconds: 600 },
  youtube: { maxText: 5000, maxMedia: 1, requiresMedia: true, supportsThread: false },
  pinterest: { maxText: 500, maxMedia: 1, requiresMedia: true, supportsThread: false },
  mastodon: { maxText: 500, maxMedia: 4, requiresMedia: false, supportsThread: true },
};
