/**
 * Holt's linear trend with damping (additive). Robust, interpretable, cheap.
 * We fit alpha/beta by a small grid search on one-step-ahead squared error, phi fixed per call.
 */
export interface HoltFit {
  alpha: number;
  beta: number;
  phi: number;
  level: number;
  trend: number;
  /** one-step-ahead residuals (actual - forecast) */
  residuals: number[];
  sse: number;
}

export function fitHolt(y: number[], phi = 0.9): HoltFit {
  if (y.length < 3) {
    const level = y[y.length - 1] ?? 0;
    return { alpha: 0.5, beta: 0.1, phi, level, trend: 0, residuals: [], sse: 0 };
  }
  let best: HoltFit | null = null;
  const alphas = [0.2, 0.35, 0.5, 0.65, 0.8];
  const betas = [0.05, 0.1, 0.2, 0.35];
  for (const alpha of alphas) {
    for (const beta of betas) {
      const fit = runHolt(y, alpha, beta, phi);
      if (!best || fit.sse < best.sse) best = fit;
    }
  }
  return best!;
}

export function runHolt(y: number[], alpha: number, beta: number, phi: number): HoltFit {
  let level = y[0]!;
  let trend = y[1]! - y[0]!;
  const residuals: number[] = [];
  let sse = 0;
  for (let i = 1; i < y.length; i++) {
    const forecast = level + phi * trend;
    const r = y[i]! - forecast;
    residuals.push(r);
    sse += r * r;
    const newLevel = alpha * y[i]! + (1 - alpha) * (level + phi * trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * phi * trend;
    level = newLevel;
    trend = newTrend;
  }
  return { alpha, beta, phi, level, trend, residuals, sse };
}

/** h-step-ahead point forecast with damped trend. */
export function holtForecast(fit: HoltFit, h: number): number {
  let damp = 0;
  for (let i = 1; i <= h; i++) damp += fit.phi ** i;
  return fit.level + damp * fit.trend;
}
