import { clusterSignals, runPrompt, type ModelGateway } from "@base-air/ai";
import type { BaseAir } from "@base-air/core";
import type { Actor } from "@base-air/schema";
import { buildBrandContext } from "../context.ts";

export const SCOUT_ACTOR: Actor = { type: "operator", id: "scout" };

export interface ScoutOptions {
  /** How far back to read "trending now" discoveries. */
  sinceHours?: number;
  /** Topics below this relevance to the brand are not tracked. */
  minRelevance?: number;
  /** At most this many new topics per run, so the radar never floods. */
  maxNewTopics?: number;
  log?: (line: string) => void;
}

export interface ScoutSummary {
  runId: string;
  signals: number;
  proposed: number;
  created: { id: string; name: string; relevance: number }[];
  skipped: { name: string; reason: string }[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The Scout turns what the outside world says is trending (Google Trends, Wikipedia, Hacker News, YouTube) into
 * topics this brand should track, scored against the brand's own profile. It never posts; it only widens the radar.
 */
export async function runScout(m: BaseAir, gw: ModelGateway, workspaceId: string, opts: ScoutOptions = {}): Promise<ScoutSummary> {
  const log = opts.log ?? (() => {});
  const minRelevance = opts.minRelevance ?? 0.6;
  const maxNew = opts.maxNewTopics ?? 3;
  const runId = await m.ops.startRun(workspaceId, "scout");
  const summary: ScoutSummary = { runId, signals: 0, proposed: 0, created: [], skipped: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  try {
    const discoveries = await m.sources.discoveries({ sinceHours: opts.sinceHours ?? 6, limit: 300 });
    const seen = new Set<string>();
    const signals: string[] = [];
    for (const d of discoveries) {
      const key = norm(d.term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      signals.push(d.context?.length ? `${d.term} — ${d.context.slice(0, 2).join(" / ")} [${d.source}]` : `${d.term} [${d.source}]`);
    }
    summary.signals = signals.length;
    if (signals.length === 0) {
      await m.ops.finishRun(runId, { status: "succeeded", summary: "no new trending signals" });
      return summary;
    }

    const existing = await m.trends.listTopics(workspaceId);
    const known = new Set(existing.flatMap((t) => [norm(t.name), ...t.keywords.map(norm)]));
    const brand = await buildBrandContext(m, workspaceId);
    const res = await runPrompt(gw, clusterSignals, { brand, signals: signals.slice(0, 150), maxTopics: 8 });
    summary.usage = { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd };
    summary.proposed = res.output.topics.length;

    for (const t of [...res.output.topics].sort((a, b) => b.relevance - a.relevance)) {
      if (summary.created.length >= maxNew) {
        summary.skipped.push({ name: t.name, reason: "run cap reached" });
        continue;
      }
      if (t.relevance < minRelevance) {
        summary.skipped.push({ name: t.name, reason: `relevance ${t.relevance.toFixed(2)} below ${minRelevance}` });
        continue;
      }
      if ([t.name, ...t.keywords].some((k) => known.has(norm(k)))) {
        summary.skipped.push({ name: t.name, reason: "already tracked" });
        continue;
      }
      const topic = await m.trends.createTopic({ workspaceId, name: t.name, keywords: t.keywords.slice(0, 8), relevance: t.relevance, actor: SCOUT_ACTOR, why: t.why });
      for (const k of [t.name, ...t.keywords]) known.add(norm(k));
      summary.created.push({ id: topic.id, name: topic.name, relevance: t.relevance });
      log(`[scout] tracking "${topic.name}" (relevance ${t.relevance.toFixed(2)})`);
    }
    await m.ops.finishRun(runId, {
      status: "succeeded",
      summary: `${summary.signals} signals, ${summary.proposed} candidate topics, ${summary.created.length} now tracked`,
      inputTokens: summary.usage.inputTokens,
      outputTokens: summary.usage.outputTokens,
      costUsd: summary.usage.costUsd,
    });
    return summary;
  } catch (e) {
    await m.ops.finishRun(runId, { status: "failed", error: (e as Error).message, inputTokens: summary.usage.inputTokens, outputTokens: summary.usage.outputTokens, costUsd: summary.usage.costUsd });
    throw e;
  }
}
