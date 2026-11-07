import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { postOutcomes, trendActions, trendForecasts, trendPoints, trendTopics } from "@starsign/db";
import { forecastTopic, toForecastRecord, type SourceSeries } from "@starsign/forecast";
import { newId } from "@starsign/ledger";
import { TrendPointInput, type Actor, type TrendSource, type TrendStage } from "@starsign/schema";
import { SYSTEM, type CoreContext, type Principal } from "../context.ts";
import { CoreError } from "../errors.ts";

const STAGE_WEIGHT: Record<TrendStage, number> = { rising: 1, peaking: 0.7, plateau: 0.4, fading: 0.15, dormant: 0.05 };

/** A post's 24h outcome is the sum over its variants (one post, several networks). Null when nothing is captured yet. */
function sumOutcomes(bags: (Record<string, number> | null)[]): Record<string, number> | null {
  const present = bags.filter((b): b is Record<string, number> => !!b);
  if (present.length === 0) return null;
  const out: Record<string, number> = {};
  for (const b of present) for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Plain words for the strategist. Null when there is nothing to act on. */
export function windowText(stage: TrendStage | null, hoursToPeak: number | null): string | null {
  if (stage === "rising") {
    if (hoursToPeak === null) return "act now; still accelerating";
    if (hoursToPeak <= 6) return `act now; peak in ~${hoursToPeak}h`;
    return `act within ~${Math.round(hoursToPeak / 2)}h`;
  }
  if (stage === "peaking") return "late; only with something new to add";
  if (stage === "plateau") return "steady; no rush";
  return null;
}

export class TrendService {
  constructor(private readonly ctx: CoreContext) {}

  async createTopic(input: { workspaceId: string | null; name: string; keywords: string[]; relevance?: number; actor?: Actor; why?: string }) {
    const [row] = await this.ctx.db
      .insert(trendTopics)
      .values({ id: newId("top"), workspaceId: input.workspaceId, name: input.name, keywords: input.keywords, relevance: input.relevance ?? null })
      .returning();
    await this.ctx.events.append({
      workspaceId: input.workspaceId ?? "global",
      type: "trend.topic_created",
      subjectType: "trend_topic",
      subjectId: row!.id,
      actor: input.actor ?? SYSTEM,
      data: { name: input.name, keywords: input.keywords, relevance: input.relevance ?? null, why: input.why ?? null },
    });
    return row!;
  }

  /** Every topic in every workspace plus global ones. For the system's samplers, never for a principal. */
  async allTopics() {
    return this.ctx.db.select().from(trendTopics).orderBy(trendTopics.createdAt);
  }

  /** A topic by id. With a workspaceId, only that workspace's topics and global ones are visible. */
  async getTopic(topicId: string, workspaceId?: string) {
    const [row] = await this.ctx.db.select().from(trendTopics).where(eq(trendTopics.id, topicId)).limit(1);
    if (!row || (workspaceId !== undefined && row.workspaceId !== null && row.workspaceId !== workspaceId)) throw new CoreError("not_found", `topic ${topicId}`);
    return row;
  }

  /** Writes to a topic require owning it. Global topics are written by the system (workers), never by a principal. */
  private async ownedTopic(p: Principal, topicId: string) {
    const topic = await this.getTopic(topicId, p.workspaceId);
    if (topic.workspaceId !== p.workspaceId) throw new CoreError("forbidden", "global topics are maintained by the system");
    if (p.actor.type === "human" && p.role === "viewer") throw new CoreError("forbidden", "viewers cannot change topics");
    return topic;
  }

  /** Workspace topics plus global ones. */
  async listTopics(workspaceId: string) {
    return this.ctx.db
      .select()
      .from(trendTopics)
      .where(or(eq(trendTopics.workspaceId, workspaceId), isNull(trendTopics.workspaceId)))
      .orderBy(trendTopics.name);
  }

  async setRelevance(p: Principal, topicId: string, relevance: number) {
    await this.ownedTopic(p, topicId);
    await this.ctx.db.update(trendTopics).set({ relevance: Math.max(0, Math.min(1, relevance)) }).where(eq(trendTopics.id, topicId));
  }

  /** Record observations. With a principal, every topic must belong to that workspace; without one, the system is writing. */
  async recordPoints(rawPoints: unknown[], principal?: Principal): Promise<number> {
    const pts = rawPoints.map((p) => TrendPointInput.parse(p));
    if (pts.length === 0) return 0;
    const actor = principal?.actor ?? SYSTEM;
    const actorWorkspaceId = principal?.workspaceId;
    if (principal) for (const id of new Set(pts.map((p) => p.topicId))) await this.ownedTopic(principal, id);
    await this.ctx.db.insert(trendPoints).values(pts.map((p) => ({ topicId: p.topicId, source: p.source, region: p.region, value: p.value, observedAt: new Date(p.observedAt) })));
    const byTopic = new Map<string, number>();
    for (const p of pts) byTopic.set(p.topicId, (byTopic.get(p.topicId) ?? 0) + 1);
    for (const [topicId, n] of byTopic) {
      const topic = await this.getTopic(topicId);
      await this.ctx.events.append({
        workspaceId: topic.workspaceId ?? actorWorkspaceId ?? "global",
        type: "trend.points_recorded",
        subjectType: "trend_topic",
        subjectId: topicId,
        actor,
        data: { count: n, sources: [...new Set(pts.filter((p) => p.topicId === topicId).map((p) => p.source))] },
      });
    }
    return pts.length;
  }

  async points(topicId: string, since: Date) {
    return this.ctx.db
      .select()
      .from(trendPoints)
      .where(and(eq(trendPoints.topicId, topicId), gte(trendPoints.observedAt, since)))
      .orderBy(trendPoints.observedAt);
  }

  /** Recompute the forecast for a topic from its last `lookbackDays` of points. Persists and returns it. */
  async computeForecast(topicId: string, opts: { lookbackDays?: number; horizonHours?: number; stepMs?: number } = {}, principal?: Principal) {
    const topic = principal ? await this.ownedTopic(principal, topicId) : await this.getTopic(topicId);
    const now = this.ctx.now();
    const since = new Date(now.getTime() - (opts.lookbackDays ?? 14) * 86_400_000);
    const pts = await this.points(topicId, since);
    const bySource = new Map<TrendSource, SourceSeries>();
    for (const p of pts) {
      const s = bySource.get(p.source as TrendSource) ?? { source: p.source as TrendSource, points: [] };
      s.points.push({ t: p.observedAt.getTime(), v: p.value });
      bySource.set(p.source as TrendSource, s);
    }
    const stepMs = opts.stepMs ?? 3_600_000;
    const result = forecastTopic([...bySource.values()], { now: now.getTime(), stepMs, horizonSteps: Math.round(((opts.horizonHours ?? 72) * 3_600_000) / stepMs) });
    const rec = toForecastRecord(topicId, result, now);
    const id = newId("fc");
    await this.ctx.db.insert(trendForecasts).values({
      id,
      topicId,
      computedAt: now,
      stage: rec.stage,
      confidence: rec.confidence,
      velocity: rec.velocity,
      acceleration: rec.acceleration,
      hoursToPeak: rec.hoursToPeak,
      horizonHours: rec.horizonHours,
      curve: rec.curve,
      modelVersion: rec.modelVersion,
      sourceAgreement: rec.sourceAgreement,
      sources: rec.sources,
    });
    await this.ctx.events.append({
      workspaceId: topic.workspaceId ?? "global",
      type: "trend.forecast_computed",
      subjectType: "trend_topic",
      subjectId: topicId,
      actor: SYSTEM,
      data: { forecastId: id, stage: rec.stage, confidence: rec.confidence, hoursToPeak: rec.hoursToPeak, sources: rec.sources },
    });
    this.ctx.emitter.emit("forecast", { topicId, workspaceId: topic.workspaceId, stage: rec.stage, confidence: rec.confidence });
    return { id, ...rec, combined: result.combined };
  }

  async latestForecast(topicId: string) {
    const [row] = await this.ctx.db.select().from(trendForecasts).where(eq(trendForecasts.topicId, topicId)).orderBy(desc(trendForecasts.computedAt)).limit(1);
    return row ?? null;
  }

  /**
   * The radar: every topic visible to the workspace with its latest forecast, scored for "act now".
   * score = confidence x stage weight x relevance (unknown relevance counts as 0.5).
   */
  async radar(workspaceId: string) {
    // Relevance 0 means someone stopped following it (an archived tracker name): off the radar, history kept.
    const topics = (await this.listTopics(workspaceId)).filter((t) => t.relevance !== 0);
    if (topics.length === 0) return [];
    const ids = topics.map((t) => t.id);
    const forecasts = await this.ctx.db
      .select()
      .from(trendForecasts)
      .where(inArray(trendForecasts.topicId, ids))
      .orderBy(desc(trendForecasts.computedAt));
    const latest = new Map<string, (typeof forecasts)[number]>();
    for (const f of forecasts) if (!latest.has(f.topicId)) latest.set(f.topicId, f);
    const actions = await this.ctx.db
      .select({ topicId: trendActions.topicId, n: sql<number>`count(*)` })
      .from(trendActions)
      .where(and(eq(trendActions.workspaceId, workspaceId), inArray(trendActions.topicId, ids)))
      .groupBy(trendActions.topicId);
    const acted = new Map(actions.map((a) => [a.topicId, Number(a.n)]));
    return topics
      .map((t) => {
        const f = latest.get(t.id) ?? null;
        const relevance = t.relevance ?? 0.5;
        const score = f ? f.confidence * STAGE_WEIGHT[f.stage as TrendStage] * relevance : 0;
        return {
          topic: t,
          forecast: f
            ? { id: f.id, stage: f.stage as TrendStage, confidence: f.confidence, velocity: f.velocity, hoursToPeak: f.hoursToPeak, computedAt: f.computedAt, sources: f.sources, sourceAgreement: f.sourceAgreement, curve: f.curve }
            : null,
          actedOn: acted.get(t.id) ?? 0,
          score,
          window: windowText(f ? (f.stage as TrendStage) : null, f?.hoursToPeak ?? null),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** Everything about one topic: points per source, forecast, and the workspace's actions with their 24h outcomes. */
  async detail(workspaceId: string, topicId: string, lookbackDays = 14) {
    const topic = await this.getTopic(topicId, workspaceId);
    const since = new Date(this.ctx.now().getTime() - lookbackDays * 86_400_000);
    const pts = await this.points(topicId, since);
    const forecast = await this.latestForecast(topicId);
    const acts = await this.ctx.db.select().from(trendActions).where(and(eq(trendActions.topicId, topicId), eq(trendActions.workspaceId, workspaceId))).orderBy(desc(trendActions.createdAt));
    const outcomes = acts.length
      ? await this.ctx.db
          .select({ postId: postOutcomes.postId, metrics: postOutcomes.metrics, offset: postOutcomes.offsetLabel })
          .from(postOutcomes)
          .where(and(inArray(postOutcomes.postId, acts.map((a) => a.postId)), eq(postOutcomes.offsetLabel, "24h"), eq(postOutcomes.status, "captured")))
      : [];
    return {
      topic,
      forecast,
      series: Object.entries(
        pts.reduce<Record<string, { t: string; v: number }[]>>((acc, p) => {
          (acc[p.source] ??= []).push({ t: p.observedAt.toISOString(), v: p.value });
          return acc;
        }, {}),
      ).map(([source, points]) => ({ source, points })),
      actions: acts.map((a) => ({ ...a, outcome24h: sumOutcomes(outcomes.filter((o) => o.postId === a.postId).map((o) => o.metrics)) })),
    };
  }
}
