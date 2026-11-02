import type { TrendForecast, TrendSource, TrendStage } from "@starsign/schema";
import { fitHolt, holtForecast } from "./holt.ts";
import { classifyStage, kinematics, stepsToPeak, type StageParams } from "./stage.ts";
import { quantile, resample, type Point } from "./series.ts";

export const MODEL_VERSION = "holt-damped+kinematics/0.1";

export interface SourceSeries {
  source: TrendSource;
  points: Point[];
  /** Relative weight, default 1. */
  weight?: number;
}

export interface ForecastOptions {
  stepMs?: number;
  horizonSteps?: number;
  now?: number;
  stageParams?: StageParams;
  /** Minimum buckets of history required for a confident stage. */
  minHistory?: number;
}

export interface ForecastResult {
  stage: TrendStage;
  confidence: number;
  velocity: number;
  acceleration: number;
  hoursToPeak: number | null;
  curve: { at: string; value: number; lo: number; hi: number }[];
  sourceAgreement: number | null;
  sources: TrendSource[];
  /** The combined series actually used. */
  combined: Point[];
  modelVersion: string;
  horizonHours: number;
}

/** Scale each source to its own recent baseline so they can be averaged. */
function normalizeSeries(points: Point[]): Point[] {
  if (points.length === 0) return [];
  const vals = points.map((p) => p.v);
  const med = quantile(vals, 0.5);
  const scale = Math.max(Math.abs(med), quantile(vals, 0.9) * 0.1, 1e-9);
  return points.map((p) => ({ t: p.t, v: p.v / scale }));
}

/** Combine several sources on a shared grid into one normalized series plus an agreement score. */
export function combineSources(series: SourceSeries[], stepMs: number, now: number): { combined: Point[]; agreement: number | null } {
  const usable = series.filter((s) => s.points.length >= 2);
  if (usable.length === 0) return { combined: [], agreement: null };
  const from = Math.min(...usable.map((s) => Math.min(...s.points.map((p) => p.t))));
  const grids = usable.map((s) => ({
    w: s.weight ?? 1,
    g: normalizeSeries(resample(s.points, stepMs, { from, to: now })),
  }));
  const len = Math.max(...grids.map((x) => x.g.length));
  const combined: Point[] = [];
  for (let i = 0; i < len; i++) {
    let s = 0;
    let w = 0;
    let t = 0;
    for (const { w: wt, g } of grids) {
      const p = g[i];
      if (!p) continue;
      s += wt * p.v;
      w += wt;
      t = p.t;
    }
    combined.push({ t, v: w ? s / w : 0 });
  }
  let agreement: number | null = null;
  if (grids.length >= 2) {
    // Agreement = how similar each source's recent relative velocity is, pairwise, 0..1.
    // Equal velocities -> 1; opposite -> 0; one flat while another moves -> 0.
    const vels = grids.map(({ g }) => kinematics(g.map((p) => p.v)).velocity);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < vels.length; i++) {
      for (let j = i + 1; j < vels.length; j++) {
        const a = vels[i]!;
        const b = vels[j]!;
        const denom = Math.abs(a) + Math.abs(b);
        sum += denom < 1e-6 ? 1 : 1 - Math.abs(a - b) / denom;
        n++;
      }
    }
    agreement = n ? clamp01(sum / n) : null;
  }
  return { combined, agreement };
}

/**
 * Forecast a topic from one or more sources.
 * Deterministic: same input, same output. Always emits a band.
 */
export function forecastTopic(series: SourceSeries[], opts: ForecastOptions = {}): ForecastResult {
  const stepMs = opts.stepMs ?? 3_600_000;
  const horizon = opts.horizonSteps ?? 72;
  const now = opts.now ?? Date.now();
  const minHistory = opts.minHistory ?? 24;
  const { combined, agreement } = combineSources(series, stepMs, now);
  const sources = [...new Set(series.filter((s) => s.points.length >= 2).map((s) => s.source))];
  const horizonHours = Math.round((horizon * stepMs) / 3_600_000);

  if (combined.length < 3) {
    return {
      stage: "dormant",
      confidence: 0,
      velocity: 0,
      acceleration: 0,
      hoursToPeak: null,
      curve: [],
      sourceAgreement: agreement,
      sources,
      combined,
      modelVersion: MODEL_VERSION,
      horizonHours,
    };
  }

  const y = combined.map((p) => p.v);
  const k = kinematics(y);
  const stage = classifyStage(k, opts.stageParams);
  const fit = fitHolt(y);

  // Residual spread scaled by sqrt(h): the honest band. Floor it so thin data never looks precise.
  const absRes = fit.residuals.map(Math.abs);
  const spread = Math.max(quantile(absRes, 0.8), Math.abs(k.level) * 0.05, 1e-6);
  const lastT = combined[combined.length - 1]!.t;
  const curve: ForecastResult["curve"] = [];
  for (let h = 1; h <= horizon; h++) {
    const value = Math.max(0, holtForecast(fit, h));
    const band = spread * Math.sqrt(h) * 1.28; // ~80% band under roughly symmetric residuals
    curve.push({
      at: new Date(lastT + h * stepMs).toISOString(),
      value,
      lo: Math.max(0, value - band),
      hi: value + band,
    });
  }
  // Time to peak comes from the deceleration, not from the smoother: if the rise is still accelerating,
  // the peak is not in sight and we say so (null) rather than pretend.
  const steps = stage === "rising" || stage === "peaking" ? stepsToPeak(k) : null;
  const hoursToPeak = steps === null ? null : Math.max(1, Math.round(Math.min(steps, horizon) * (stepMs / 3_600_000)));

  // Confidence: data density, residual noise relative to level, source agreement.
  // Density gates everything: with little history, nothing else can make us confident.
  const density = Math.min(1, combined.length / minHistory);
  const noise = Math.min(1, spread / Math.max(Math.abs(k.level), 1e-9));
  const agreementTerm = agreement ?? 0.5; // single source: unknown, not good
  const confidence = clamp01(Math.pow(density, 0.7) * (0.6 * (1 - noise) + 0.4 * agreementTerm));

  return {
    stage,
    confidence,
    velocity: k.velocity,
    acceleration: k.acceleration,
    hoursToPeak,
    curve,
    sourceAgreement: agreement,
    sources,
    combined,
    modelVersion: MODEL_VERSION,
    horizonHours,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Convenience: shape a result into the schema object (minus ids), for persistence. */
export function toForecastRecord(topicId: string, r: ForecastResult, computedAt = new Date()): Omit<TrendForecast, "id"> {
  return {
    topicId,
    computedAt: computedAt.toISOString(),
    stage: r.stage,
    confidence: r.confidence,
    velocity: r.velocity,
    acceleration: r.acceleration,
    hoursToPeak: r.hoursToPeak,
    horizonHours: r.horizonHours,
    curve: r.curve,
    modelVersion: r.modelVersion,
    sourceAgreement: r.sourceAgreement,
    sources: r.sources,
  };
}
