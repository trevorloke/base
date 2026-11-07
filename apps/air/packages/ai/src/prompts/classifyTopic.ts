import { z } from "zod";
import { renderBrandContext, type BrandContext } from "./context.ts";
import { definePrompt } from "./types.ts";

export type ClassifyTopicVars = {
  /** The outgoing text under review (post body plus thread segments). */
  text: string;
  /** The red line's keywords: signals, not the whole definition. */
  keywords: string[];
  /** The red line's description of the forbidden topic. */
  description: string;
  brand?: BrandContext;
};

export const ClassifyTopicOutput = z.object({
  likelihood: z.number().min(0).max(1).describe("0..1 likelihood that the text is about the topic, including indirect, implied or euphemistic references"),
  reason: z.string().describe("The span or implication that drove the score, or why it is clearly unrelated"),
});
export type ClassifyTopicOutput = z.infer<typeof ClassifyTopicOutput>;

export const classifyTopic = definePrompt<ClassifyTopicVars, ClassifyTopicOutput>({
  name: "classifyTopic",
  version: "1.0.0",
  description: "Steward check: does this outgoing text touch a forbidden topic, by meaning and not only by keyword?",
  effort: "low",
  system: (v) =>
    [
      `You are the Steward operator${v.brand ? ` for ${v.brand.workspace.name}` : ""}. You judge whether a piece of outgoing text touches a topic the brand has declared off-limits. Keyword matching already ran; your job is meaning: indirect references, euphemisms, implications, jokes, and context that make the text about the topic without naming it.`,
      v.brand ? renderBrandContext(v.brand) : null,
      `Scoring rules:
- 0.9+: the text is plainly about the topic. 0.5–0.8: it refers to or leans on the topic. 0.1–0.4: a passing or ambiguous touch. Under 0.1: unrelated.
- Judge the text as a reader on that network would, not as a lawyer. Shared vocabulary alone is not a hit.
- Be calibrated: the score is compared against a threshold (typically 0.7) that blocks or holds the post.`,
    ]
      .filter((s): s is string => s !== null)
      .join("\n\n"),
  user: (v) =>
    [
      `Forbidden topic: ${v.description}\nSignals: ${v.keywords.join(", ") || "none"}`,
      `Text under review:\n"""\n${v.text}\n"""`,
      "Return the likelihood and the reason.",
    ].join("\n\n"),
  schema: ClassifyTopicOutput,
});
