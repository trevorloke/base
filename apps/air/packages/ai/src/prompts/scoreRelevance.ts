import { z } from "zod";
import { COMMON_RULES, renderBrandContext, type BrandContext } from "./context.ts";
import { definePrompt } from "./types.ts";

export type ScoreRelevanceVars = {
  brand: BrandContext;
  topic: { id?: string; name: string; keywords: string[] };
  /** Optional raw signals or headlines behind the topic. */
  signals?: string[];
};

export const ScoreRelevanceOutput = z.object({
  relevance: z.number().min(0).max(1).describe("0..1: how much this topic is the brand's to speak on"),
  why: z.string().describe("The connection (or lack of one) between the topic and the brand's profile, audience and voice"),
});
export type ScoreRelevanceOutput = z.infer<typeof ScoreRelevanceOutput>;

export const scoreRelevance = definePrompt<ScoreRelevanceVars, ScoreRelevanceOutput>({
  name: "scoreRelevance",
  version: "1.0.0",
  description: "How relevant is a radar topic to this brand? Feeds the radar's act-now score.",
  effort: "low",
  system: (v) =>
    [
      `You are the Watch operator for ${v.brand.workspace.name}. You score how much a trending topic is this brand's to speak on, so the radar ranks windows the brand can credibly use.`,
      renderBrandContext(v.brand),
      COMMON_RULES,
      `Scoring rules:
- 0.9+: squarely the brand's territory (its products, audience's daily concerns, declared topics). 0.5: adjacent, usable with a specific angle. Under 0.2: not the brand's business; chasing it would read as noise.
- A topic the red lines forbid scores 0 regardless of fit, and the reason must say which red line.
- Be calibrated and specific: name the profile facts you relied on.`,
    ].join("\n\n"),
  user: (v) =>
    [
      `Topic: ${v.topic.name}${v.topic.id ? ` (id ${v.topic.id})` : ""}\nKeywords: ${v.topic.keywords.join(", ") || "none"}`,
      v.signals?.length ? `Signals behind it:\n${v.signals.map((s) => `- ${s}`).join("\n")}` : null,
      "Return the relevance and why.",
    ]
      .filter((s): s is string => s !== null)
      .join("\n\n"),
  schema: ScoreRelevanceOutput,
});
