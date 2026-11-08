import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { metrics, postOutcomes, posts, postVariants, rowsOf, socialAccounts, trendActions } from "@base-air/db";
import { MetricInput, type Network } from "@base-air/schema";
import type { CoreContext } from "../context.ts";
import { SYSTEM } from "../context.ts";
import { localHour } from "../time.ts";
import type { AccountService } from "./accounts.ts";
import type { PolicyService } from "./policy.ts";
import { LinkService } from "./links.ts";

/** Price of one post object returned by a metered read (X pay-per-use). */
export const METERED_READ_PRICE_USD = 0.005;

function readsUsed(connector: unknown): number {
  const v = (connector as { readsUsed?: unknown }).readsUsed;
  return typeof v === "number" ? v : 0;
}

/** Measurement: owned time series plus the outcome snapshots that make the ledger comparable across posts. */
export class MetricsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly accounts: AccountService,
    private readonly policy: PolicyService,
    private readonly links?: LinkService,
  ) {}

  /** Month-to-date metered read spend for a workspace, from the ledger. */
  async meteredSpendThisMonth(workspaceId: string, now = this.ctx.now()): Promise<number> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rows = rowsOf<{ total: string | number | null }>(
      await this.ctx.db.execute(
        sql`SELECT COALESCE(SUM((data->>'value')::double precision), 0) AS total FROM ledger_events WHERE workspace_id = ${workspaceId} AND type = 'metric.observed' AND data->>'metric' = 'metered_read_cost_usd' AND occurred_at >= ${monthStart}`,
      ),
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** Record the cost of metered reads so caps can be enforced. */
  async recordMeteredReads(workspaceId: string, accountId: string, network: string, reads: number): Promise<number> {
    const cost = reads * METERED_READ_PRICE_USD;
    if (cost <= 0) return 0;
    await this.ctx.events.append({
      workspaceId,
      type: "metric.observed",
      subjectType: "social_account",
      subjectId: accountId,
      actor: SYSTEM,
      data: { metric: "metered_read_cost_usd", value: cost, reads, network },
    });
    return cost;
  }

  /** Whether a metered connector may read for this workspace right now. */
  async underMeteredCap(workspaceId: string): Promise<boolean> {
    const policy = await this.policy.getActive(workspaceId);
    return (await this.meteredSpendThisMonth(workspaceId)) < policy.spendCaps.xReadsUsdMonthly;
  }

  async record(inputs: unknown[]): Promise<number> {
    const rows = inputs.map((i) => MetricInput.parse(i));
    if (rows.length === 0) return 0;
    await this.ctx.db.insert(metrics).values(
      rows.map((r) => ({ entityType: r.entityType, entityId: r.entityId, metric: r.metric, value: r.value, observedAt: new Date(r.observedAt), source: r.source })),
    );
    return rows.length;
  }

  /** Capture every due outcome snapshot. Groups by account so one connector call covers many variants. */
  async captureDueOutcomes(now = this.ctx.now()): Promise<{ captured: number; skipped: number }> {
    const due = await this.ctx.outcomes.due(now);
    if (due.length === 0) return { captured: 0, skipped: 0 };
    const variantIds = [...new Set(due.map((d) => d.variantId))];
    const variants = await this.ctx.db.select().from(postVariants).where(inArray(postVariants.id, variantIds));
    const byVariant = new Map(variants.map((v) => [v.id, v]));
    const accountIds = [...new Set(variants.map((v) => v.socialAccountId))];
    const accounts = accountIds.length ? await this.ctx.db.select().from(socialAccounts).where(inArray(socialAccounts.id, accountIds)) : [];
    const byAccount = new Map(accounts.map((a) => [a.id, a]));

    // Accounts whose network reports no post metrics: their outcomes are Base Air's own numbers alone.
    const ownedOnly = new Set<string>();
    // One fetch per account.
    const fetched = new Map<string, Record<string, number>>(); // externalId -> metric -> value
    for (const account of accounts) {
      const ext = variants.filter((v) => v.socialAccountId === account.id && v.externalId).map((v) => v.externalId!);
      if (ext.length === 0 || account.status !== "active") continue;
      try {
        const connector = this.ctx.connectors.resolve(account.connector, account.network as Network);
        const caps = connector.capabilities(account.network as Network);
        if (!caps.fetchMetrics) {
          ownedOnly.add(account.id);
          continue;
        }
        if (caps.meteredReads && !(await this.underMeteredCap(account.workspaceId))) {
          console.warn(`[metrics] ${account.handle}: metered reads paused, monthly cap reached`);
          continue;
        }
        const before = readsUsed(connector);
        const got = await this.accounts.withFreshAuth(account, connector, (ref) => connector.fetchMetrics(ref, ext));
        if (caps.meteredReads) await this.recordMeteredReads(account.workspaceId, account.id, account.network, readsUsed(connector) - before);
        await this.record(got);
        for (const m of got) {
          const bag = fetched.get(m.entityId) ?? {};
          bag[m.metric] = m.value;
          fetched.set(m.entityId, bag);
        }
      } catch (e) {
        console.error(`[metrics] fetch failed for ${account.handle}:`, (e as Error).message);
      }
    }

    let captured = 0;
    let skipped = 0;
    for (const o of due) {
      const v = byVariant.get(o.variantId);
      const bag = v?.externalId ? fetched.get(v.externalId) : undefined;
      // Owned numbers (tracked clicks, conversions) up to the offset's due time, merged over the network's.
      const owned = this.links && v ? LinkService.outcomeMetrics((await this.links.statsByVariant([v.id], o.dueAt)).get(v.id)) : {};
      const hasOwned = Object.keys(owned).length > 0;
      const late = now.getTime() - o.dueAt.getTime() > 48 * 3_600_000;
      if (bag) {
        await this.ctx.outcomes.capture({ outcomeId: o.id, metrics: { ...bag, ...owned }, capturedAt: now, actor: SYSTEM });
        captured++;
      } else if (hasOwned && v?.externalId && (late || ownedOnly.has(v.socialAccountId))) {
        await this.ctx.outcomes.capture({ outcomeId: o.id, metrics: owned, capturedAt: now, actor: SYSTEM });
        captured++;
      } else if (late || !v?.externalId || !byAccount.get(v.socialAccountId)) {
        await this.ctx.outcomes.skip(o.id);
        skipped++;
      }
    }
    return { captured, skipped };
  }

  /** Account-level metrics (followers, reach) for every active account whose connector reports them. */
  async captureAccountMetrics(): Promise<{ accounts: number; metrics: number }> {
    const rows = await this.ctx.db.select().from(socialAccounts).where(eq(socialAccounts.status, "active"));
    let accounts = 0;
    let metrics = 0;
    for (const account of rows) {
      try {
        const connector = this.ctx.connectors.resolve(account.connector, account.network as Network);
        const caps = connector.capabilities(account.network as Network);
        if (!connector.fetchAccountMetrics || !caps.accountMetrics) continue;
        if (caps.meteredReads && !(await this.underMeteredCap(account.workspaceId))) continue;
        const got = await this.accounts.withFreshAuth(account, connector, (ref) => connector.fetchAccountMetrics!(ref));
        metrics += await this.record(got.map((g) => ({ ...g, entityType: "social_account", entityId: account.id })));
        accounts++;
      } catch (e) {
        console.error(`[metrics] account metrics for ${account.handle}:`, (e as Error).message);
      }
    }
    return { accounts, metrics };
  }

  async series(entityType: string, entityId: string, metric: string, from: Date, to: Date) {
    return this.ctx.db
      .select({ value: metrics.value, observedAt: metrics.observedAt, source: metrics.source })
      .from(metrics)
      .where(and(eq(metrics.entityType, entityType), eq(metrics.entityId, entityId), eq(metrics.metric, metric), gte(metrics.observedAt, from), lte(metrics.observedAt, to)))
      .orderBy(metrics.observedAt);
  }

  async latest(entityType: string, entityId: string): Promise<Record<string, number>> {
    const rows = await this.ctx.db
      .select()
      .from(metrics)
      .where(and(eq(metrics.entityType, entityType), eq(metrics.entityId, entityId)))
      .orderBy(desc(metrics.observedAt))
      .limit(200);
    const out: Record<string, number> = {};
    for (const r of rows) if (!(r.metric in out)) out[r.metric] = r.value;
    return out;
  }

  /** Outcomes at one offset for every published variant in a window. The comparable unit of the ledger. */
  async outcomesAt(workspaceId: string, offset: string, from: Date, to: Date) {
    return this.ctx.db
      .select({
        postId: postOutcomes.postId,
        variantId: postOutcomes.variantId,
        metrics: postOutcomes.metrics,
        network: postVariants.network,
        publishedAt: postVariants.publishedAt,
        text: postVariants.text,
        trendTopicId: posts.trendTopicId,
        trendStage: posts.trendStageAtCreation,
        createdBy: posts.createdBy,
        experimentId: posts.experimentId,
        experimentArm: posts.experimentArm,
      })
      .from(postOutcomes)
      .innerJoin(postVariants, eq(postVariants.id, postOutcomes.variantId))
      .innerJoin(posts, eq(posts.id, postOutcomes.postId))
      .where(and(eq(postOutcomes.workspaceId, workspaceId), eq(postOutcomes.offsetLabel, offset), eq(postOutcomes.status, "captured"), gte(postVariants.publishedAt, from), lte(postVariants.publishedAt, to)));
  }

  /**
   * The weekly numbers: what went out, what it did at 24h, by network, by hour, by trend stage, by author type.
   * Feeds the Analyst's brief and the dashboard. Deterministic given the ledger.
   */
  async summary(workspaceId: string, from: Date, to: Date, timezone = "UTC") {
    const rows = await this.outcomesAt(workspaceId, "24h", from, to);
    const eng = (m: Record<string, number> | null) => m?.engagements ?? (m?.likes ?? 0) + (m?.replies ?? 0) + (m?.reposts ?? 0);
    const imp = (m: Record<string, number> | null) => m?.impressions ?? 0;

    const group = <K extends string>(key: (r: (typeof rows)[number]) => K | null) => {
      const acc = new Map<K, { posts: number; impressions: number; engagements: number }>();
      for (const r of rows) {
        const k = key(r);
        if (k === null) continue;
        const g = acc.get(k) ?? { posts: 0, impressions: 0, engagements: 0 };
        g.posts++;
        g.impressions += imp(r.metrics);
        g.engagements += eng(r.metrics);
        acc.set(k, g);
      }
      return [...acc.entries()].map(([k, g]) => ({ key: k, ...g, avgEngagements: g.posts ? g.engagements / g.posts : 0 })).sort((a, b) => b.avgEngagements - a.avgEngagements);
    };

    const published = await this.ctx.db
      .select({ network: postVariants.network, n: sql<number>`count(*)` })
      .from(postVariants)
      .innerJoin(posts, eq(posts.id, postVariants.postId))
      .where(and(eq(posts.workspaceId, workspaceId), eq(postVariants.status, "published"), gte(postVariants.publishedAt, from), lte(postVariants.publishedAt, to)))
      .groupBy(postVariants.network);

    const total = rows.reduce((a, r) => ({ impressions: a.impressions + imp(r.metrics), engagements: a.engagements + eng(r.metrics) }), { impressions: 0, engagements: 0 });
    const baseline = rows.length ? total.engagements / rows.length : 0;

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      publishedByNetwork: published.map((p) => ({ network: p.network, posts: Number(p.n) })),
      measuredAt24h: rows.length,
      totals: total,
      baselineEngagements24h: baseline,
      byNetwork: group((r) => r.network),
      byHour: group((r) => (r.publishedAt ? String(localHour(r.publishedAt, timezone)).padStart(2, "0") : null)),
      byTrendStage: group((r) => r.trendStage ?? (r.trendTopicId ? "unknown" : "no_trend")),
      byAuthor: group((r) => (r.createdBy as { type: string }).type),
      byExperiment: group((r) => (r.experimentId ? `${r.experimentId}:${r.experimentArm ?? "?"}` : null)),
      top: rows
        .map((r) => ({ postId: r.postId, variantId: r.variantId, network: r.network, text: r.text.slice(0, 140), impressions: imp(r.metrics), engagements: eng(r.metrics), lift: baseline ? eng(r.metrics) / baseline : null }))
        .sort((a, b) => b.engagements - a.engagements)
        .slice(0, 10),
    };
  }

  /** Lift by trend stage: when this workspace acted on a topic at a stage, how did 24h engagement compare to its baseline? */
  async liftByStage(workspaceId: string, from: Date, to: Date) {
    const s = await this.summary(workspaceId, from, to);
    return s.byTrendStage.map((g) => ({ stage: g.key, posts: g.posts, avgEngagements: g.avgEngagements, lift: s.baselineEngagements24h ? g.avgEngagements / s.baselineEngagements24h : null }));
  }

  async actionsForTopic(topicId: string) {
    return this.ctx.db.select().from(trendActions).where(eq(trendActions.topicId, topicId)).orderBy(desc(trendActions.createdAt));
  }
}
