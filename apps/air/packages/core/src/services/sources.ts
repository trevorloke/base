import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { ledgerEvents, rawEvents, rowsOf, trendPoints } from "@base-air/db";
import type { SourceAdapter, TrendingItem } from "@base-air/sources";
import type { TrendSource } from "@base-air/schema";
import { SYSTEM, type CoreContext } from "../context.ts";
import type { TrendService } from "./trends.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface PullResult {
  source: string;
  topics: number;
  points: number;
  trending: number;
  error: string | null;
}

export interface SourceStatus {
  name: string;
  kind: "sample" | "trending" | "both";
  configured: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  pointsLast24h: number;
}

/**
 * Pulls attention from the outside world into the radar. Every topic is sampled from every configured source
 * that can sample (Google Trends, Wikipedia, Hacker News, Bluesky search, the brand's own feed); every source that
 * lists "trending now" terms is stored raw for the Scout to cluster. Each run is recorded so the room can say
 * which sources are healthy.
 */
export class SourcesService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly trends: TrendService,
  ) {}

  async pull(adapters: SourceAdapter[], opts: { lookbackDays?: number; region?: string } = {}): Promise<PullResult[]> {
    const now = this.ctx.now();
    const lookback = (opts.lookbackDays ?? 7) * DAY;
    const topics = await this.trends.allTopics();
    const results: PullResult[] = [];

    for (const a of adapters) {
      if (!a.configured) continue;
      const r: PullResult = { source: a.name, topics: 0, points: 0, trending: 0, error: null };
      try {
        if (a.sample) {
          for (const t of topics) {
            if (t.keywords.length === 0) continue;
            const last = await this.lastPointAt(t.id, a.name);
            // Nothing new exists until a period completes after the last point we hold.
            const lastCompleteStart = Math.floor(now.getTime() / a.granularityMs) * a.granularityMs - a.granularityMs;
            if (last && last.getTime() >= lastCompleteStart) continue;
            const since = last ?? new Date(now.getTime() - lookback);
            const pts = await a.sample({ keywords: t.keywords, since, now, region: opts.region });
            if (pts.length) {
              await this.trends.recordPoints(pts.map((p) => ({ topicId: t.id, source: a.name, value: p.value, observedAt: p.observedAt, region: p.region ?? "global" })));
              r.points += pts.length;
            }
            r.topics++;
          }
        }
        if (a.trending) {
          const items = await a.trending({ now, region: opts.region });
          for (const it of items) await this.storeTrending(a.name, it, now);
          r.trending = items.length;
        }
      } catch (e) {
        r.error = (e as Error).message;
      }
      await this.record(r);
      results.push(r);
    }

    results.push(await this.pullOwnFeed(topics, now, lookback));
    return results;
  }

  /** The brand's own feed is a source too: mentions/replies/comments matching a topic's keywords, per hour. */
  private async pullOwnFeed(topics: Awaited<ReturnType<TrendService["allTopics"]>>, now: Date, lookback: number): Promise<PullResult> {
    const r: PullResult = { source: "own_feed", topics: 0, points: 0, trending: 0, error: null };
    try {
      for (const t of topics) {
        if (!t.workspaceId || t.keywords.length === 0) continue;
        // Own-feed points are a derivation of the feed, so the trailing day is recomputed every run:
        // a mention ingested late still lands in the hour it happened.
        const last = await this.lastPointAt(t.id, "own_feed");
        const since = last ? new Date(Math.max(now.getTime() - lookback, last.getTime() - DAY)) : new Date(now.getTime() - lookback);
        const end = new Date(Math.floor(now.getTime() / HOUR) * HOUR); // complete hours only
        const patterns = t.keywords.map((k) => `%${k.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
        const rows = rowsOf<{ hour: Date | string; n: number | string }>(
          await this.ctx.db.execute(sql`
            SELECT date_trunc('hour', occurred_at) AS hour, count(*) AS n
            FROM activities
            WHERE workspace_id = ${t.workspaceId}
              AND occurred_at > ${since} AND occurred_at < ${end}
              AND kind <> 'own_post'
              AND (${sql.join(patterns.map((p) => sql`text ILIKE ${p}`), sql` OR `)})
            GROUP BY 1 ORDER BY 1`),
        );
        // Hours with no mentions are real zeros, not gaps: fill them so the forecaster sees quiet as quiet.
        const counts = new Map(rows.map((x) => [new Date(x.hour).getTime(), Number(x.n)]));
        const startHour = Math.ceil(since.getTime() / HOUR) * HOUR;
        const pts = [];
        for (let h = startHour; h < end.getTime(); h += HOUR) pts.push({ topicId: t.id, source: "own_feed", value: counts.get(h) ?? 0, observedAt: new Date(h).toISOString() });
        if (pts.length) {
          await this.ctx.db
            .delete(trendPoints)
            .where(and(eq(trendPoints.topicId, t.id), eq(trendPoints.source, "own_feed"), gte(trendPoints.observedAt, new Date(startHour))));
          await this.trends.recordPoints(pts);
          r.points += pts.length;
        }
        r.topics++;
      }
    } catch (e) {
      r.error = (e as Error).message;
    }
    await this.record(r);
    return r;
  }

  private async lastPointAt(topicId: string, source: string): Promise<Date | null> {
    const [row] = await this.ctx.db
      .select({ at: trendPoints.observedAt })
      .from(trendPoints)
      .where(and(eq(trendPoints.topicId, topicId), eq(trendPoints.source, source)))
      .orderBy(desc(trendPoints.observedAt))
      .limit(1);
    return row?.at ?? null;
  }

  private async storeTrending(source: TrendSource, it: TrendingItem, now: Date) {
    const hour = new Date(Math.floor(now.getTime() / HOUR) * HOUR).toISOString();
    // One raw row per term per source per region per hour; the store dedupes identical payloads.
    await this.ctx.events.appendRaw({ source: `trending:${source}`, kind: "trending", workspaceId: null, externalId: `${it.region}:${it.term}:${hour}`, payload: { ...it, source, hour } });
  }

  private async record(r: PullResult) {
    await this.ctx.events.append({ workspaceId: "global", type: "source.pulled", subjectType: "source", subjectId: r.source, actor: SYSTEM, data: { ...r } });
  }

  /** Health of each source: last run, last error, points recorded in the last 24 hours. */
  async status(adapters: SourceAdapter[]): Promise<SourceStatus[]> {
    const since = new Date(this.ctx.now().getTime() - DAY);
    const counts = await this.ctx.db
      .select({ source: trendPoints.source, n: sql<number>`count(*)` })
      .from(trendPoints)
      .where(gte(trendPoints.observedAt, since))
      .groupBy(trendPoints.source);
    const byName = new Map(counts.map((c) => [c.source, Number(c.n)]));
    const entries: { name: string; kind: SourceStatus["kind"]; configured: boolean }[] = [
      ...adapters.map((a) => ({ name: a.name, kind: (a.sample && a.trending ? "both" : a.sample ? "sample" : "trending") as SourceStatus["kind"], configured: a.configured })),
      { name: "own_feed", kind: "sample", configured: true },
    ];
    const out: SourceStatus[] = [];
    for (const e of entries) {
      const [last] = await this.ctx.db
        .select()
        .from(ledgerEvents)
        .where(and(eq(ledgerEvents.type, "source.pulled"), eq(ledgerEvents.subjectId, e.name)))
        .orderBy(desc(ledgerEvents.seq))
        .limit(1);
      out.push({
        ...e,
        lastRunAt: last?.occurredAt.toISOString() ?? null,
        lastError: (last?.data.error as string | null | undefined) ?? null,
        pointsLast24h: byName.get(e.name) ?? 0,
      });
    }
    return out;
  }

  /** "Trending now" terms seen recently, newest first. */
  async discoveries(opts: { limit?: number; sinceHours?: number } = {}): Promise<(TrendingItem & { source: string })[]> {
    const since = new Date(this.ctx.now().getTime() - (opts.sinceHours ?? 24) * HOUR);
    const rows = await this.ctx.db
      .select({ payload: rawEvents.payload })
      .from(rawEvents)
      .where(and(eq(rawEvents.kind, "trending"), gt(rawEvents.receivedAt, since)))
      .orderBy(desc(rawEvents.seq))
      .limit(2000);
    // A term that keeps trending is observed every hour; show it once, newest sighting first.
    const seen = new Set<string>();
    const out: (TrendingItem & { source: string })[] = [];
    for (const r of rows) {
      const it = r.payload as TrendingItem & { source: string };
      const key = `${it.source}|${it.region}|${it.term.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
      if (out.length >= Math.min(opts.limit ?? 50, 500)) break;
    }
    return out;
  }
}
