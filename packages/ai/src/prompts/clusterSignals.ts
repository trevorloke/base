import { z } from "zod";
import { COMMON_RULES, renderBrandContext, type BrandContext } from "./context.ts";
import { definePrompt } from "./types.ts";

export type ClusterSignalsVars = {
  /** Optional: with a brand, relevance is scored against it; without one, relevance reflects general newsworthiness. */
  brand?: BrandContext;
  /** Raw strings: search queries, headlines, post snippets, hashtags. */
  signals: string[];
  maxTopics?: number;
};

export const ClusterSignalsOutput = z.object({
  topics: z.array(
    z.object({
      name: z.string().describe("Short, specific topic name a person would recognise"),
      keywords: z.array(z.string()).min(1).describe("Terms that identify the topic in text; include the signals that formed it"),
      relevance: z.number().min(0).max(1).describe("0..1 relevance to the brand (or newsworthiness when no brand is given)"),
      why: z.string().describe("Why these signals belong together and why the relevance score, citing the signals"),
    }),
  ),
});
export type ClusterSignalsOutput = z.infer<typeof ClusterSignalsOutput>;

export const clusterSignals = definePrompt<ClusterSignalsVars, ClusterSignalsOutput>({
  name: "clusterSignals",
  version: "1.0.0",
  description: "Cluster raw attention signals into a few coherent topics worth tracking, each with keywords and a relevance score.",
  effort: "medium",
  system: (v) =>
    [
      `You are the Watch operator${v.brand ? ` for ${v.brand.workspace.name}` : ""}. You turn raw attention signals into a short list of coherent topics the radar should track.`,
      v.brand ? renderBrandContext(v.brand) : "No brand context was given: score relevance as general newsworthiness for a marketing team.",
      COMMON_RULES,
      `Clustering rules:
- Merge signals that are the same story told differently; keep apart signals that merely share a word.
- Prefer fewer, sharper topics. Drop noise rather than inventing a topic for it.
- Keywords must be usable for matching text: concrete terms, names and phrases, not abstractions.
- Relevance is a calibrated 0..1: 0.9+ means squarely the brand's territory, 0.5 means adjacent, under 0.2 means ignore.`,
    ].join("\n\n"),
  user: (v) =>
    [
      `Signals (${v.signals.length}):\n${v.signals.map((s) => `- ${s}`).join("\n") || "- none"}`,
      `Return at most ${v.maxTopics ?? 8} topics.`,
    ].join("\n\n"),
  schema: ClusterSignalsOutput,
});
