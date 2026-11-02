import type { ForecastPoint, SeriesPoint, TrendStage } from "../types";

export interface SparklineProps {
  /** Forecast curve: the value line plus the lo/hi band. */
  forecast: ForecastPoint[];
  /** Observed points drawn before the forecast, in a neutral color. */
  history?: SeriesPoint[];
  /** Picks the stage color token when `color` is not given. */
  stage?: TrendStage;
  color?: string;
  /** Confidence under 40%: the band gets a dashed outline instead of a solid fill. */
  thin?: boolean;
  width?: number;
  height?: number;
  /** Vertical marker where observation ends and the forecast begins. */
  showNow?: boolean;
  className?: string;
  title?: string;
}

interface XY {
  x: number;
  v: number;
}

/** Inline SVG. Time on x, value on y; the band is one closed path (hi forward, lo back). */
export function Sparkline({
  forecast,
  history = [],
  stage,
  color,
  thin = false,
  width = 120,
  height = 40,
  showNow = false,
  className,
  title,
}: SparklineProps) {
  const stroke = color ?? (stage ? `var(--stage-${stage})` : "var(--fg-muted)");
  const fc = forecast.map((p) => ({ x: Date.parse(p.at), v: p.value, lo: p.lo, hi: p.hi })).filter((p) => Number.isFinite(p.x));
  const hs: XY[] = history.map((p) => ({ x: Date.parse(p.t), v: p.v })).filter((p) => Number.isFinite(p.x));

  const xs = [...fc.map((p) => p.x), ...hs.map((p) => p.x)];
  const ys = [...fc.flatMap((p) => [p.lo, p.hi, p.v]), ...hs.map((p) => p.v)];
  if (xs.length < 2) {
    return (
      <div className={`spark spark-empty${className ? ` ${className}` : ""}`} style={{ width, height }}>
        no data
      </div>
    );
  }

  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const padX = 1;
  const padY = 2;
  const sx = (x: number) => (x1 === x0 ? width / 2 : padX + ((x - x0) / (x1 - x0)) * (width - 2 * padX));
  const sy = (y: number) => (y1 === y0 ? height / 2 : height - padY - ((y - y0) / (y1 - y0)) * (height - 2 * padY));
  const f = (n: number) => n.toFixed(1);
  const line = (pts: XY[]) => pts.map((p, i) => `${i ? "L" : "M"}${f(sx(p.x))},${f(sy(p.v))}`).join(" ");

  const band =
    fc.length >= 2
      ? `${fc.map((p, i) => `${i ? "L" : "M"}${f(sx(p.x))},${f(sy(p.hi))}`).join(" ")} ${[...fc]
          .reverse()
          .map((p) => `L${f(sx(p.x))},${f(sy(p.lo))}`)
          .join(" ")} Z`
      : "";
  const first = fc[0];
  const nowX = first ? sx(first.x) : null;

  return (
    <svg
      className={`spark${className ? ` ${className}` : ""}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title ?? "forecast"}
    >
      {band ? (
        <path
          d={band}
          style={{
            fill: stroke,
            fillOpacity: thin ? 0.07 : 0.16,
            stroke: thin ? stroke : "none",
            strokeOpacity: 0.6,
            strokeWidth: 1,
            strokeDasharray: thin ? "3 3" : undefined,
          }}
        />
      ) : null}
      {hs.length >= 2 ? <path d={line(hs)} fill="none" style={{ stroke: "var(--fg-muted)", strokeWidth: 1.25, strokeLinejoin: "round" }} /> : null}
      {showNow && nowX !== null ? (
        <line x1={nowX} x2={nowX} y1={0} y2={height} style={{ stroke: "var(--border-strong)", strokeWidth: 1, strokeDasharray: "2 3" }} />
      ) : null}
      {fc.length >= 2 ? (
        <path d={line(fc)} fill="none" style={{ stroke, strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round" }} />
      ) : null}
    </svg>
  );
}
