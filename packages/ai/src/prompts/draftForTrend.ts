import { z } from "zod";
import type { Network, TrendStage } from "@meridian/schema";
import { COMMON_RULES, pct, renderBrandContext, renderNetworkLimits, type BrandContext } from "./context.ts";
import { VariantOutput } from "./shared.ts";
import { definePrompt } from "./types.ts";

export type DraftForTrendVars = {
  brand: BrandContext;
  topic: { id?: string; name: string; keywords: string[] };
  forecast: {
    id?: string;
    stage: TrendStage;
    /** 0..1 */
    confidence: number;
    hoursToPeak: number | null;
    sources: string[];
    velocity?: number | null;
    sourceAgreement?: number | null;
    /** The radar's own phrasing of the window, e.g. "act within 9h". */
    window?: string | null;
  };
  networks: Network[];
  /** The brand's best recent posts (24h engagement), for voice and length calibration, not for topics. */
  recentTopPosts: { postId?: string; network: string; text: string; engagements: number; impressions?: number }[];
};

export const DraftForTrendOutput = z.object({
  angle: z.string().describe("One sentence: the brand's specific take on the topic and why it is the brand's to say"),
  rationale: z.string().describe("Why now and why this angle, quoting the forecast numbers you were given; name the uncertainty"),
  variants: z.array(VariantOutput).min(1).describe("Exactly one variant per listed network"),
  disclosure: z.object({
    aiAssisted: z.literal(true),
    aiContributions: z.array(z.string()).min(1).describe('What the model did, e.g. ["text_drafted"]'),
  }),
});
export type DraftForTrendOutput = z.infer<typeof DraftForTrendOutput>;

export const draftForTrend = definePrompt<DraftForTrendVars, DraftForTrendOutput>({
  name: "draftForTrend",
  version: "1.0.0",
  description: "Given a rising topic and its forecast, draft on-voice variants for the approval queue, with rationale and disclosure.",
  effort: "medium",
  system: (v) =>
    [
      `You are the Studio operator for ${v.brand.workspace.name}. The Watch operator found a window: a topic forecast to rise. You draft on-voice content for it. A human reviews everything you write in the approval queue; nothing publishes on its own.`,
      renderBrandContext(v.brand),
      COMMON_RULES,
      `Drafting rules:
- Decide the angle first: the brand's genuine, specific take. If the brand has no credible connection to the topic, say so in the rationale and still return the most honest, modest draft you can; the humans decide.
- Exactly one variant per listed network, within the hard limits with headroom (aim under 90%); threads only where supported and truly needed.
- Do not claim results, partnerships, prices, events or facts that are not in your inputs. No competitor names where the red lines forbid them.
- Learn from the recent top posts' style and length, not their topics.
- The rationale must quote the forecast's confidence and hours-to-peak and say how much to trust them.
- The disclosure must mark the draft as AI-assisted with "text_drafted" among its contributions.`,
    ].join("\n\n"),
  user: (v) => {
    const f = v.forecast;
    const forecastLines = [
      `- stage: ${f.stage}`,
      `- confidence: ${pct(f.confidence)} (${f.confidence.toFixed(2)})`,
      `- estimated hours to peak: ${f.hoursToPeak === null ? "unknown" : Math.round(f.hoursToPeak)}`,
      `- sources: ${f.sources.length ? f.sources.join(", ") : "none"}${f.sourceAgreement !== null && f.sourceAgreement !== undefined ? ` (agreement ${f.sourceAgreement.toFixed(2)})` : ""}`,
      f.velocity !== null && f.velocity !== undefined ? `- velocity: ${f.velocity.toFixed(3)} per hour, relative to level` : null,
      f.window ? `- window: ${f.window}` : null,
      f.id ? `- forecast id: ${f.id}` : null,
    ].filter((s): s is string => s !== null);
    const top = v.recentTopPosts.length
      ? v.recentTopPosts.map((p) => `- [${p.network}] ${p.engagements} engagements${p.impressions !== undefined ? ` / ${p.impressions} impressions` : ""} at 24h: "${p.text}"`).join("\n")
      : "- none measured yet";
    return [
      `Topic: ${v.topic.name}${v.topic.id ? ` (id ${v.topic.id})` : ""}\nKeywords: ${v.topic.keywords.join(", ") || "none"}`,
      `Forecast:\n${forecastLines.join("\n")}`,
      `Networks to draft for and their limits:\n${renderNetworkLimits(v.networks)}`,
      `Recent top posts (for voice and length calibration):\n${top}`,
      "Return the angle, the rationale, one variant per network, and the disclosure.",
    ].join("\n\n");
  },
  schema: DraftForTrendOutput,
});
