import { z } from "zod";
import { Network } from "@starsign/schema";

/** One per-network variant. Thread segments are extra posts after the first; empty on networks without threads. */
export const VariantOutput = z.object({
  network: Network,
  text: z.string().describe("Primary post text, within the network's hard limit with headroom"),
  thread: z.array(z.string()).describe("Further segments when the idea truly needs a thread; otherwise empty. Always empty on networks without threads"),
});
export type VariantOutput = z.infer<typeof VariantOutput>;

/** A claim traced to an input: the same shape the ledger stores on posts and briefs. */
export const EvidenceOutput = z.object({
  kind: z.string().describe("What the reference is: forecast | metrics_summary | lift_by_stage | feed_counts | radar | alert | post | source"),
  ref: z.string().describe("The id, key or window the claim rests on"),
  note: z.string().describe("What the reference shows, with the number quoted"),
});
export type EvidenceOutput = z.infer<typeof EvidenceOutput>;
