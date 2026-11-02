import { z } from "zod";
import { COMMON_RULES, renderBrandContext, renderJson, type BrandContext } from "./context.ts";
import { EvidenceOutput } from "./shared.ts";
import { definePrompt } from "./types.ts";

export type WriteBriefVars = {
  brand: BrandContext;
  period: { from: string; to: string; days: number; timezone: string };
  /** `MetricsService.summary` output: window, publishedByNetwork, measuredAt24h, totals, baseline, groups, top posts. */
  summary: Record<string, unknown>;
  /** `MetricsService.liftByStage` output. */
  liftByStage: unknown[];
  /** `ListeningService.counts` output: inbound items by network and kind. */
  feedCounts: unknown[];
  /** Top radar entries, trimmed (no curves). */
  radar: unknown[];
  /** Recent operator alerts. */
  alerts: unknown[];
  previousHeadline?: string | null;
};

export const WriteBriefOutput = z.object({
  headline: z.string().describe("One line a busy owner reads first: the week's most important fact, with its number"),
  markdown: z.string().describe("The full weekly brief in Markdown"),
  evidence: z.array(EvidenceOutput).describe("Every number or claim in the brief traced to an input"),
});
export type WriteBriefOutput = z.infer<typeof WriteBriefOutput>;

export const writeBrief = definePrompt<WriteBriefVars, WriteBriefOutput>({
  name: "writeBrief",
  version: "1.0.0",
  description: "The Analyst's weekly brief: forecast first, numbers from the ledger only, confidence flagged, evidence on every claim.",
  effort: "high",
  stream: true,
  system: (v) =>
    [
      `You are the Analyst operator for ${v.brand.workspace.name}. Once a week you read the brand's own ledger and write the brief its owner reads on Monday morning: what is next, what moved, what to decide.`,
      renderBrandContext(v.brand),
      COMMON_RULES,
      `Brief rules:
- Use only numbers that appear in the inputs, quoted exactly (round only when you say you rounded). If a figure is missing, write "not measured". Never estimate a number the inputs do not contain.
- Flag confidence everywhere it matters: fewer than 10 measured posts makes a comparison indicative, not conclusive; a lift against a baseline of 0 or a handful of posts is not a finding. Say which forecasts are confident (0.7+) and which are not.
- Forecast first, report second: lead with the radar and the open windows, then prove with what happened.
- Structure (Markdown headings): Headline · What is coming (radar, with confidence and windows) · What moved (totals, by network, by hour, by trend stage, by author) · What worked and what did not · Alerts and decisions waiting on a human · Experiments for next week (each with the metric that settles it) · Confidence notes (sample sizes, missing data, platform gating).
- Plain language, short paragraphs, small tables where they help. No praise, no filler, no recommendations without a number behind them.
- Every number and claim in the Markdown gets an evidence entry pointing at the input it came from.`,
    ].join("\n\n"),
  user: (v) =>
    [
      `Period: ${v.period.from} to ${v.period.to} (${v.period.days} days, ${v.period.timezone}).${v.previousHeadline ? ` Last brief's headline: "${v.previousHeadline}".` : " This is the first brief."}`,
      `Metrics summary (24h outcomes of what was published in the period):\n${renderJson(v.summary)}`,
      `Lift by trend stage (24h engagement vs the period baseline):\n${renderJson(v.liftByStage)}`,
      `Inbound feed counts (items by network and kind, since period start):\n${renderJson(v.feedCounts)}`,
      `Radar (top topics by act-now score; forecasts carry confidence 0..1):\n${renderJson(v.radar)}`,
      `Recent alerts:\n${renderJson(v.alerts)}`,
      "Write the brief: headline, Markdown, and the evidence list.",
    ].join("\n\n"),
  schema: WriteBriefOutput,
});
