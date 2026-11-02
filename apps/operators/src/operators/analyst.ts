import { runPrompt, writeBrief, type Effort, type GatewayUsage, type ModelGateway, type WriteBriefVars } from "@starsign/ai";
import type { Starsign } from "@starsign/core";
import { ANALYST_ACTOR, DAY_MS, buildBrandContext } from "../context.ts";

export interface AnalystOptions {
  /** Default 7. */
  periodDays?: number;
  /** Default "high": the brief is the one output worth the extra thinking. */
  effort?: Effort;
  log?: (line: string) => void;
}

export interface AnalystResult {
  runId: string;
  briefId: string;
  headline: string;
  periodStart: Date;
  periodEnd: Date;
  evidenceCount: number;
  usage: GatewayUsage;
}

/**
 * The Analyst operator: gather the period's ledger (24h outcomes, lift by trend stage, inbound counts, the radar,
 * recent alerts), have the model write the weekly brief from those numbers only, and save it with its evidence.
 */
export async function runAnalyst(m: Starsign, gw: ModelGateway, workspaceId: string, opts: AnalystOptions = {}): Promise<AnalystResult> {
  const periodDays = opts.periodDays ?? 7;
  const log = opts.log ?? (() => {});
  const runId = await m.ops.startRun(workspaceId, "analyst");
  try {
    const to = m.ctx.now();
    const from = new Date(to.getTime() - periodDays * DAY_MS);
    const policy = await m.policy.getActive(workspaceId);
    const brand = await buildBrandContext(m, workspaceId, { policy });
    const summary = await m.metrics.summary(workspaceId, from, to, policy.timezone);
    const liftByStage = await m.metrics.liftByStage(workspaceId, from, to);
    const feedCounts = await m.listening.counts(workspaceId, from);
    const radar = await m.trends.radar(workspaceId);
    const alerts = await m.ops.alerts(workspaceId, { limit: 20 });
    const [previous] = await m.ops.briefs(workspaceId, 1);

    const vars: WriteBriefVars = {
      brand,
      period: { from: from.toISOString(), to: to.toISOString(), days: periodDays, timezone: policy.timezone },
      summary: summary as unknown as Record<string, unknown>,
      liftByStage,
      feedCounts,
      radar: radar.slice(0, 10).map((e) => ({
        topic: { id: e.topic.id, name: e.topic.name, keywords: e.topic.keywords, relevance: e.topic.relevance },
        forecast: e.forecast
          ? { id: e.forecast.id, stage: e.forecast.stage, confidence: e.forecast.confidence, hoursToPeak: e.forecast.hoursToPeak, sources: e.forecast.sources, sourceAgreement: e.forecast.sourceAgreement, computedAt: e.forecast.computedAt.toISOString() }
          : null,
        actedOn: e.actedOn,
        score: e.score,
        window: e.window,
      })),
      alerts: alerts.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, title: a.title, body: a.body, topicId: a.topicId, acknowledged: a.acknowledgedAt !== null, createdAt: a.createdAt.toISOString() })),
      previousHeadline: previous ? firstLine(previous.contentMd) : null,
    };

    const res = await runPrompt(gw, writeBrief, vars, opts.effort ?? "high");

    const published = summary.publishedByNetwork.reduce((a, p) => a + p.posts, 0);
    const inbound = feedCounts.reduce((a, c) => a + c.n, 0);
    const inputs = {
      kind: "inputs",
      ref: `${from.toISOString()}..${to.toISOString()}`,
      note: `${summary.measuredAt24h} post(s) measured at 24h; ${published} published; ${inbound} inbound item(s); ${radar.length} topic(s) on the radar; ${alerts.length} alert(s) considered; written by ${res.usage.model} with ${res.usage.promptVersion}`,
    };
    const brief = await m.ops.saveBrief(workspaceId, ANALYST_ACTOR, {
      periodStart: from,
      periodEnd: to,
      contentMd: res.output.markdown,
      evidence: [...res.output.evidence, inputs],
      runId,
    });
    await m.ops.finishRun(runId, {
      status: "succeeded",
      summary: `brief ${brief.id}: ${res.output.headline}`,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: res.usage.costUsd,
    });
    log(`[analyst] brief ${brief.id} saved for ${workspaceId}: ${res.output.headline}`);
    return { runId, briefId: brief.id, headline: res.output.headline, periodStart: from, periodEnd: to, evidenceCount: res.output.evidence.length + 1, usage: res.usage };
  } catch (e) {
    await m.ops.finishRun(runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}

function firstLine(md: string): string {
  const line = md.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.replace(/^#+\s*/, "").trim();
}
