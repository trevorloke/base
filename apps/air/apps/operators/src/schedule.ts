import { gatewayTranslator, type ModelGateway } from "@base-air/ai";
import type { BaseAir } from "@base-air/core";
import { runAnalyst, type AnalystOptions } from "./operators/analyst.ts";
import { runScout, type ScoutOptions } from "./operators/scout.ts";
import { runWatch, type WatchOptions } from "./operators/watch.ts";

export interface ServeOptions {
  /** How often each workspace gets a Watch run. Default 30 minutes. */
  watchEveryMs?: number;
  /** How often the loop wakes to check what is due. Default 60 seconds. */
  tickMs?: number;
  /** Local weekday for the brief (0 = Sunday). Default 1, Monday. */
  analystWeekday?: number;
  /** Local hour from which the brief may run on that day. Default 8. */
  analystHour?: number;
  watch?: WatchOptions;
  analyst?: AnalystOptions;
  scout?: ScoutOptions;
  /** How often the Scout clusters trending terms into new topics (default 2h). 0 disables it. */
  scoutEveryMs?: number;
  /** How often waiting messages are translated into each workspace's language (default 5 minutes). 0 disables it. */
  translateEveryMs?: number;
  log?: (line: string) => void;
}

export interface ServeState {
  lastWatchAt: Map<string, number>;
  lastScoutAt?: Map<string, number>;
  lastTranslateAt?: Map<string, number>;
  /** When the weekly brief last failed per workspace; it is not retried for six hours (a failed brief is a 64k-token call). */
  lastAnalystFailAt?: Map<string, number>;
}

const ANALYST_RETRY_MS = 6 * 60 * 60_000;

/** Calendar parts of an instant in a zone. The weekday comes from the local calendar date, not the formatter's label. */
export function localParts(at: Date, timezone: string): { year: number; month: number; day: number; hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  return { year, month, day, hour: Number(p.hour) % 24, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** ISO-8601 week of the local date, e.g. "2026-W45". */
export function isoWeekKey(at: Date, timezone: string): string {
  const { year, month, day } = localParts(at, timezone);
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNr = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNr + 3); // the Thursday of this week decides the ISO year
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * "Weekly, Monday 08:00 in the workspace's timezone" without a cron library: due when the local weekday and hour
 * have arrived and no brief whose period ends in the current ISO week exists yet. Idempotent across ticks and restarts.
 */
export function analystDue(now: Date, timezone: string, latestBriefPeriodEnd: Date | null, opts: { weekday?: number; hour?: number } = {}): boolean {
  const { weekday, hour } = localParts(now, timezone);
  if (weekday !== (opts.weekday ?? 1) || hour < (opts.hour ?? 8)) return false;
  return latestBriefPeriodEnd === null || isoWeekKey(latestBriefPeriodEnd, timezone) !== isoWeekKey(now, timezone);
}

export interface TickResult {
  watched: string[];
  scouted?: string[];
  briefed: string[];
  translated?: { workspace: string; count: number }[];
  /** Workspaces skipped because their monthly model spend cap is reached. */
  capped: string[];
  errors: string[];
}

/** One pass over every workspace: Watch when its interval has elapsed, Analyst when the weekly brief is due. */
export async function tick(m: BaseAir, gw: ModelGateway, state: ServeState, opts: ServeOptions = {}): Promise<TickResult> {
  const watchEveryMs = opts.watchEveryMs ?? 30 * 60_000;
  const result: TickResult = { watched: [], briefed: [], capped: [], errors: [] };
  const now = m.ctx.now();
  for (const ws of await m.workspaces.list()) {
    // The policy's model spend cap is the brand's money; nothing runs past it.
    try {
      const policy = await m.policy.getActive(ws.id);
      const spent = await m.ops.modelSpendThisMonth(ws.id, now);
      if (spent >= policy.spendCaps.modelUsdMonthly) {
        result.capped.push(ws.slug);
        continue;
      }
    } catch (e) {
      result.errors.push(`${ws.slug}: spend check: ${(e as Error).message}`);
      continue;
    }
    // Scout before Watch so a topic found this tick is forecast in the same pass.
    const scoutEveryMs = opts.scoutEveryMs ?? 2 * 60 * 60_000;
    const lastScout = (state.lastScoutAt ??= new Map()).get(ws.id);
    if (scoutEveryMs > 0 && (lastScout === undefined || now.getTime() - lastScout >= scoutEveryMs)) {
      state.lastScoutAt.set(ws.id, now.getTime());
      try {
        const s = await runScout(m, gw, ws.id, { log: opts.log, ...opts.scout });
        if (s.created.length) (result.scouted ??= []).push(ws.slug);
      } catch (e) {
        result.errors.push(`${ws.slug}: scout: ${(e as Error).message}`);
      }
    }
    // Translation: small, frequent batches so a message in another language is readable within minutes.
    const translateEveryMs = opts.translateEveryMs ?? 5 * 60_000;
    const lastTranslate = (state.lastTranslateAt ??= new Map()).get(ws.id);
    if (translateEveryMs > 0 && (lastTranslate === undefined || now.getTime() - lastTranslate >= translateEveryMs)) {
      state.lastTranslateAt.set(ws.id, now.getTime());
      try {
        const t = await m.translations.translateWorkspace(ws.id, gatewayTranslator(gw));
        if (t.translated) (result.translated ??= []).push({ workspace: ws.slug, count: t.translated });
      } catch (e) {
        result.errors.push(`${ws.slug}: translate: ${(e as Error).message}`);
      }
    }
    const last = state.lastWatchAt.get(ws.id);
    if (last === undefined || now.getTime() - last >= watchEveryMs) {
      state.lastWatchAt.set(ws.id, now.getTime());
      try {
        await runWatch(m, gw, ws.id, { log: opts.log, ...opts.watch });
        result.watched.push(ws.slug);
      } catch (e) {
        result.errors.push(`${ws.slug}: watch: ${(e as Error).message}`);
      }
    }
    try {
      const policy = await m.policy.getActive(ws.id);
      const [latest] = await m.ops.briefs(ws.id, 1);
      const failedAt = state.lastAnalystFailAt?.get(ws.id);
      const coolingDown = failedAt !== undefined && now.getTime() - failedAt < ANALYST_RETRY_MS;
      if (!coolingDown && analystDue(now, policy.timezone, latest?.periodEnd ?? null, { weekday: opts.analystWeekday, hour: opts.analystHour })) {
        await runAnalyst(m, gw, ws.id, { log: opts.log, ...opts.analyst });
        result.briefed.push(ws.slug);
      }
    } catch (e) {
      (state.lastAnalystFailAt ??= new Map()).set(ws.id, now.getTime());
      result.errors.push(`${ws.slug}: analyst: ${(e as Error).message}`);
    }
  }
  return result;
}

export interface ServeHandle {
  state: ServeState;
  stop(): void;
}

/** The long-running loop: tick, sleep, repeat. One process serves every workspace. */
export function serve(m: BaseAir, gw: ModelGateway, opts: ServeOptions = {}): ServeHandle {
  const tickMs = opts.tickMs ?? 60_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  const state: ServeState = { lastWatchAt: new Map() };
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async () => {
    if (stopped) return;
    try {
      const r = await tick(m, gw, state, { ...opts, log });
      if (r.watched.length || r.briefed.length || r.capped.length || r.errors.length) {
        log(`[operators] tick: watched=[${r.watched.join(",")}] briefed=[${r.briefed.join(",")}]${r.capped.length ? ` capped=[${r.capped.join(",")}]` : ""}${r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ""}`);
      }
    } catch (e) {
      log(`[operators] tick failed: ${(e as Error).message}`);
    }
    if (!stopped) timer = setTimeout(loop, tickMs);
  };
  void loop();
  return {
    state,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
