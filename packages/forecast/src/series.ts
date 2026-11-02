export interface Point {
  /** epoch ms */
  t: number;
  v: number;
}

/** Bucket irregular observations onto a fixed step (ms), averaging within a bucket, interpolating gaps. */
export function resample(points: Point[], stepMs: number, opts: { from?: number; to?: number } = {}): Point[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const from = Math.floor((opts.from ?? sorted[0]!.t) / stepMs) * stepMs;
  const to = Math.floor((opts.to ?? sorted[sorted.length - 1]!.t) / stepMs) * stepMs;
  const sums = new Map<number, { s: number; n: number }>();
  for (const p of sorted) {
    const b = Math.floor(p.t / stepMs) * stepMs;
    if (b < from || b > to) continue;
    const e = sums.get(b) ?? { s: 0, n: 0 };
    e.s += p.v;
    e.n += 1;
    sums.set(b, e);
  }
  const out: Point[] = [];
  for (let t = from; t <= to; t += stepMs) {
    const e = sums.get(t);
    out.push({ t, v: e ? e.s / e.n : Number.NaN });
  }
  // linear interpolation of NaN gaps; carry at edges
  let lastIdx = -1;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i]!.v)) {
      if (lastIdx >= 0 && i - lastIdx > 1) {
        const a = out[lastIdx]!.v;
        const b = out[i]!.v;
        for (let k = lastIdx + 1; k < i; k++) out[k]!.v = a + ((b - a) * (k - lastIdx)) / (i - lastIdx);
      } else if (lastIdx < 0) {
        for (let k = 0; k < i; k++) out[k]!.v = out[i]!.v;
      }
      lastIdx = i;
    }
  }
  if (lastIdx >= 0) for (let k = lastIdx + 1; k < out.length; k++) out[k]!.v = out[lastIdx]!.v;
  return out;
}

/** Exponentially weighted moving average. alpha in (0,1]; higher = less smoothing. */
export function ewma(values: number[], alpha: number): number[] {
  const out: number[] = [];
  let s = values[0] ?? 0;
  for (const v of values) {
    s = alpha * v + (1 - alpha) * s;
    out.push(s);
  }
  return out;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Pearson correlation of two equal-length arrays; 0 when degenerate. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}
