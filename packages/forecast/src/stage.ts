import type { TrendStage } from "@meridian/schema";
import { ewma, mean } from "./series.ts";

export interface Kinematics {
  level: number;
  baseline: number;
  /** Relative change per step over the most recent window (fraction of scale). */
  velocity: number;
  /** Relative change per step over the window before that. */
  previousVelocity: number;
  /** velocity - previousVelocity */
  acceleration: number;
  /** level relative to baseline; >1 means elevated */
  lift: number;
  /** window (steps) the velocities were measured over */
  window: number;
}

/**
 * Velocity and acceleration of a smoothed series, normalized by scale (max of current level and baseline)
 * so topics of different size compare. Deterministic.
 */
export const DEFAULT_WINDOW = 6;

export function kinematics(values: number[], opts: { smoothAlpha?: number; window?: number } = {}): Kinematics {
  const alpha = opts.smoothAlpha ?? 0.4;
  const w = Math.max(2, opts.window ?? DEFAULT_WINDOW);
  const s = ewma(values, alpha);
  const n = s.length;
  const level = s[n - 1] ?? 0;
  const baselineSlice = s.slice(0, Math.max(1, Math.floor(n * 0.5)));
  const baseline = Math.max(1e-9, mean(baselineSlice));
  const scale = Math.max(Math.abs(level), baseline, 1e-9);
  const back = (k: number) => s[Math.max(0, n - 1 - k)] ?? level;
  const velocity = (level - back(w)) / w / scale;
  const previousVelocity = (back(w) - back(2 * w)) / w / scale;
  return { level, baseline, velocity, previousVelocity, acceleration: velocity - previousVelocity, lift: level / baseline, window: w };
}

/**
 * Steps until velocity reaches zero if the current deceleration continues; null when not decelerating
 * (peak not in sight) or not rising. Acceleration is the change in velocity across one window.
 */
export function stepsToPeak(k: Kinematics): number | null {
  if (k.velocity <= 0) return null;
  // Noise produces small spurious decelerations on straight rises; require a real drop in velocity (>15% per window).
  if (k.acceleration >= -0.15 * k.velocity) return null;
  return (k.velocity * k.window) / -k.acceleration;
}

export interface StageParams {
  /** Relative velocity per step above which a topic is rising (0.01 = 1%/step, ~27%/day at hourly steps). */
  riseThreshold: number;
  /** Relative velocity below which it is fading. */
  fadeThreshold: number;
  /** Lift below which a still topic is dormant rather than plateaued. */
  dormantLift: number;
  /** If current velocity falls below this fraction of the previous window's, a rise is "peaking". */
  decelerationRatio: number;
}

export const DEFAULT_STAGE_PARAMS: StageParams = {
  riseThreshold: 0.01,
  fadeThreshold: -0.01,
  dormantLift: 1.15,
  decelerationRatio: 0.5,
};

export function classifyStage(k: Kinematics, p: StageParams = DEFAULT_STAGE_PARAMS): TrendStage {
  const still = Math.abs(k.velocity) < p.riseThreshold;
  if (still && k.lift < p.dormantLift) return "dormant";
  if (k.velocity >= p.riseThreshold) {
    const decelerating = k.previousVelocity > 0 && k.velocity < p.decelerationRatio * k.previousVelocity;
    return decelerating ? "peaking" : "rising";
  }
  if (k.velocity <= p.fadeThreshold) return "fading";
  // Still and elevated: just turned over -> peaking; otherwise a plateau.
  return k.previousVelocity >= p.riseThreshold ? "peaking" : "plateau";
}
