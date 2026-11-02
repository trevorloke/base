import { draftForTrend, pct, runPrompt, type BrandContext, type DraftForTrendVars, type Effort, type GatewayUsage, type ModelGateway } from "@meridian/ai";
import { validateVariant } from "@meridian/connectors";
import { CoreError, type Meridian } from "@meridian/core";
import { AUTONOMY_ORDER, type AutonomyLevel, type Network } from "@meridian/schema";
import { DAY_MS, HOUR_MS, STUDIO_ACTOR, WATCH_ACTOR, activeAccountsByNetwork, buildBrandContext, principalFor, type ActiveAccount } from "../context.ts";
import type { StewardClassifier } from "./steward.ts";

export interface WatchOptions {
  /** Forecast confidence below this is not a window. Default 0.5. */
  minConfidence?: number;
  /** Radar act-now score (confidence x stage weight x relevance) below this is not a window. Default 0.25. */
  minScore?: number;
  /** A topic alerted or acted on within this many hours is left alone. Default 48. */
  reactAfterHours?: number;
  /** Drafts per run; alerts are raised for every window regardless. Default 3. */
  maxDrafts?: number;
  effort?: Effort;
  /** Primed with the draft texts before the gate, so semantic red lines fire on the first evaluation. */
  classifier?: StewardClassifier;
  log?: (line: string) => void;
}

export interface WatchWindow {
  topicId: string;
  topic: string;
  stage: string;
  confidence: number;
  hoursToPeak: number | null;
  score: number;
  alertId: string | null;
  postId: string | null;
  postStatus: string | null;
  /** The autonomy dial said no (recorded, not thrown). */
  refused: string | null;
  /** Nothing wrong, just not drafted this run (cap, no account). */
  skipped: string | null;
  error: string | null;
  droppedVariants: string[];
}

export interface WatchSummary {
  runId: string;
  workspaceId: string;
  topicsForecasted: number;
  forecastErrors: number;
  windows: WatchWindow[];
  alertsRaised: number;
  postsCreated: number;
  refused: number;
  errors: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
}

type RecentTop = DraftForTrendVars["recentTopPosts"];

const toStringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The Watch operator: refresh every forecast, read the radar, and for each opening window raise an alert with its
 * evidence, then (if the autonomy dial allows) have the Studio draft for it through the single policy gate.
 * Everything lands in the ledger; the run row carries token and cost totals.
 */
export async function runWatch(m: Meridian, gw: ModelGateway, workspaceId: string, opts: WatchOptions = {}): Promise<WatchSummary> {
  const minConfidence = opts.minConfidence ?? 0.5;
  const minScore = opts.minScore ?? 0.25;
  const reactAfterMs = (opts.reactAfterHours ?? 48) * HOUR_MS;
  const maxDrafts = opts.maxDrafts ?? 3;
  const log = opts.log ?? (() => {});

  const runId = await m.ops.startRun(workspaceId, "watch");
  const summary: WatchSummary = {
    runId,
    workspaceId,
    topicsForecasted: 0,
    forecastErrors: 0,
    windows: [],
    alertsRaised: 0,
    postsCreated: 0,
    refused: 0,
    errors: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
  };
  const addUsage = (u: GatewayUsage) => {
    summary.usage.inputTokens += u.inputTokens;
    summary.usage.outputTokens += u.outputTokens;
    summary.usage.costUsd += u.costUsd;
    summary.usage.calls += 1;
  };

  try {
    // 1. Fresh forecasts for every topic the workspace can see (its own and the global ones).
    for (const topic of await m.trends.listTopics(workspaceId)) {
      try {
        await m.trends.computeForecast(topic.id);
        summary.topicsForecasted++;
      } catch (e) {
        summary.forecastErrors++;
        log(`[watch] forecast failed for "${topic.name}": ${(e as Error).message}`);
      }
    }

    // 2. The radar, already scored for "act now", highest first.
    const radar = await m.trends.radar(workspaceId);
    const policy = await m.policy.getActive(workspaceId);
    const now = m.ctx.now();
    const autonomy: AutonomyLevel = policy.autonomy.new_post ?? "suggest";
    const mayDraft = AUTONOMY_ORDER.indexOf(autonomy) >= AUTONOMY_ORDER.indexOf("draft");

    let accounts: ActiveAccount[] | null = null;
    let brand: BrandContext | null = null;
    let recentTop: RecentTop | null = null;
    let drafts = 0;

    for (const entry of radar) {
      const f = entry.forecast;
      if (!f || f.stage !== "rising" || f.confidence < minConfidence || entry.score < minScore) continue;
      if (await handledRecently(m, workspaceId, entry.topic.id, now, reactAfterMs)) continue;

      const w: WatchWindow = {
        topicId: entry.topic.id,
        topic: entry.topic.name,
        stage: f.stage,
        confidence: f.confidence,
        hoursToPeak: f.hoursToPeak,
        score: entry.score,
        alertId: null,
        postId: null,
        postStatus: null,
        refused: null,
        skipped: null,
        error: null,
        droppedVariants: [],
      };
      summary.windows.push(w);

      // 3. The alert, with the evidence behind it: forecast id, sources, hours to peak.
      const sources = toStringList(f.sources);
      const peak = f.hoursToPeak === null ? null : Math.round(f.hoursToPeak);
      const evidence = [
        { kind: "forecast", ref: f.id, note: `stage ${f.stage}, confidence ${pct(f.confidence)}, computed ${f.computedAt.toISOString()}` },
        { kind: "sources", ref: sources.join(",") || "none", note: `${sources.length} source(s), agreement ${f.sourceAgreement === null ? "n/a" : f.sourceAgreement.toFixed(2)}` },
        { kind: "hours_to_peak", ref: peak === null ? "unknown" : String(peak), note: peak === null ? "no peak estimate yet" : `estimated ~${peak}h to peak; an estimate, the band widens with thin data` },
      ];
      const alert = await m.ops.raiseAlert(workspaceId, WATCH_ACTOR, {
        kind: "trend_window",
        severity: peak !== null && peak <= 12 ? "urgent" : "attention",
        title: `Window opening: ${entry.topic.name}`,
        body: [
          `"${entry.topic.name}" is rising with ${pct(f.confidence)} confidence from ${sources.length} source(s)${sources.length ? ` (${sources.join(", ")})` : ""}.`,
          peak === null ? "No peak estimate yet." : `Estimated peak in ~${peak}h; treat it as an estimate.`,
          entry.window ? `Radar: ${entry.window}.` : null,
          `Act-now score ${entry.score.toFixed(2)} (confidence x stage x relevance ${entry.topic.relevance ?? "unknown, counted as 0.5"}).`,
        ]
          .filter((s): s is string => s !== null)
          .join(" "),
        evidence,
        topicId: entry.topic.id,
      });
      w.alertId = alert.id;
      summary.alertsRaised++;

      // 4. The draft, if the dial allows the Studio to create anything at all.
      if (!mayDraft) {
        w.refused = `autonomy for new_post is "${autonomy}": the Studio may only suggest, so no draft was created`;
        summary.refused++;
        continue;
      }
      if (drafts >= maxDrafts) {
        w.skipped = `draft cap (${maxDrafts}) reached this run`;
        continue;
      }
      accounts ??= await activeAccountsByNetwork(m, workspaceId, policy);
      if (accounts.length === 0) {
        w.skipped = "no active account to draft for";
        continue;
      }
      brand ??= await buildBrandContext(m, workspaceId, { policy, networks: accounts.map((a) => a.network) });
      recentTop ??= await recentTopPosts(m, workspaceId, now, policy.timezone);

      try {
        const vars: DraftForTrendVars = {
          brand,
          topic: { id: entry.topic.id, name: entry.topic.name, keywords: toStringList(entry.topic.keywords) },
          forecast: { id: f.id, stage: f.stage, confidence: f.confidence, hoursToPeak: f.hoursToPeak, sources, velocity: f.velocity, sourceAgreement: f.sourceAgreement, window: entry.window },
          networks: accounts.map((a) => a.network),
          recentTopPosts: recentTop,
        };
        const res = await runPrompt(gw, draftForTrend, vars, opts.effort);
        addUsage(res.usage);

        const { variants, dropped } = toVariants(res.output.variants, accounts);
        w.droppedVariants = dropped;
        if (variants.length === 0) {
          w.error = `the draft had no variant that fits a connected network: ${dropped.join("; ")}`;
          summary.errors++;
          continue;
        }
        // Semantic red lines consult a synchronous cache; fill it now so the gate's first look is informed.
        if (opts.classifier) await opts.classifier.prime(variants.map((v) => [v.text, ...v.thread].join("\n")), policy.redLines);

        const created = await m.posts.create(principalFor(workspaceId, STUDIO_ACTOR), {
          title: `Trend window: ${entry.topic.name}`.slice(0, 200),
          body: res.output.angle,
          variants,
          actionClass: "new_post",
          trendTopicId: entry.topic.id,
          trendStageAtCreation: f.stage,
          trendForecastId: f.id,
          disclosure: {
            aiAssisted: true,
            aiContributions: [...new Set([...res.output.disclosure.aiContributions, "text_drafted"])],
            humanReviewed: false,
            model: res.usage.model,
            promptVersion: res.usage.promptVersion,
          },
          evidence: [
            ...evidence,
            { kind: "alert", ref: alert.id, note: alert.title },
            { kind: "rationale", ref: res.usage.promptVersion, note: res.output.rationale },
            ...recentTop.slice(0, 3).map((p) => ({ kind: "post", ref: p.postId ?? "unknown", note: `${p.network}: ${p.engagements} engagements at 24h, used for voice calibration` })),
          ],
        });
        w.postId = created.post.id;
        w.postStatus = created.post.status;
        summary.postsCreated++;
        drafts++;
        log(`[watch] drafted ${created.post.id} (${created.post.status}) for "${entry.topic.name}"`);
      } catch (e) {
        if (e instanceof CoreError && e.code === "forbidden") {
          w.refused = e.message;
          summary.refused++;
        } else {
          w.error = (e as Error).message;
          summary.errors++;
          log(`[watch] draft failed for "${entry.topic.name}": ${(e as Error).message}`);
        }
      }
    }

    await m.ops.finishRun(runId, { status: "succeeded", summary: describe(summary), inputTokens: summary.usage.inputTokens, outputTokens: summary.usage.outputTokens, costUsd: summary.usage.costUsd });
    return summary;
  } catch (e) {
    await m.ops.finishRun(runId, { status: "failed", error: (e as Error).message, summary: describe(summary), inputTokens: summary.usage.inputTokens, outputTokens: summary.usage.outputTokens, costUsd: summary.usage.costUsd });
    throw e;
  }
}

/** A topic this workspace acted on, or was alerted about, within the window is left alone. */
async function handledRecently(m: Meridian, workspaceId: string, topicId: string, now: Date, withinMs: number): Promise<boolean> {
  const actions = (await m.metrics.actionsForTopic(topicId)).filter((a) => a.workspaceId === workspaceId);
  const alerts = (await m.ops.alerts(workspaceId, { limit: 200 })).filter((a) => a.kind === "trend_window" && a.topicId === topicId);
  const stamps = [...actions.map((a) => a.createdAt.getTime()), ...alerts.map((a) => a.createdAt.getTime())];
  if (stamps.length === 0) return false;
  // Rows are stamped by the database clock; a stamp "in the future" relative to the service clock is still recent.
  return now.getTime() - Math.max(...stamps) < withinMs;
}

async function recentTopPosts(m: Meridian, workspaceId: string, now: Date, timezone: string): Promise<RecentTop> {
  const s = await m.metrics.summary(workspaceId, new Date(now.getTime() - 14 * DAY_MS), now, timezone);
  return s.top.map((p) => ({ postId: p.postId, network: p.network, text: p.text, engagements: p.engagements, impressions: p.impressions }));
}

/** Keep one valid variant per connected network; explain every drop so the summary can show it. */
function toVariants(outVariants: { network: Network; text: string; thread: string[] }[], accounts: ActiveAccount[]) {
  const variants: { socialAccountId: string; text: string; thread: string[] }[] = [];
  const dropped: string[] = [];
  const used = new Set<string>();
  for (const v of outVariants) {
    const account = accounts.find((a) => a.network === v.network);
    if (!account) {
      dropped.push(`${v.network}: no connected account`);
      continue;
    }
    if (used.has(v.network)) {
      dropped.push(`${v.network}: duplicate variant`);
      continue;
    }
    const issues = validateVariant(v.network, v.text, [], v.thread);
    if (issues.length) {
      dropped.push(`${v.network}: ${issues.map((i) => i.message).join(", ")}`);
      continue;
    }
    used.add(v.network);
    variants.push({ socialAccountId: account.id, text: v.text, thread: v.thread });
  }
  return { variants, dropped };
}

function describe(s: WatchSummary): string {
  const statuses = s.windows.filter((w) => w.postStatus).map((w) => w.postStatus);
  return [
    `${s.topicsForecasted} topic(s) forecast${s.forecastErrors ? ` (${s.forecastErrors} failed)` : ""}`,
    `${s.windows.length} window(s)`,
    `${s.alertsRaised} alert(s)`,
    `${s.postsCreated} draft(s)${statuses.length ? ` [${statuses.join(", ")}]` : ""}`,
    `${s.refused} refused by autonomy`,
    `${s.errors} error(s)`,
    `${s.usage.calls} model call(s), $${s.usage.costUsd.toFixed(4)}`,
  ].join(" · ");
}
