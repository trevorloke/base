import { seriesSummary } from "../lib/tracker";

/**
 * Mentions per day as a small line with a soft area under it. Inline SVG, no chart library; the summary is the
 * accessible name and the hover title.
 */
export function DaySpark({ days, width = 96, height = 26, className }: { days: { day: string; n: number }[]; width?: number; height?: number; className?: string }) {
  const summary = seriesSummary(days);
  if (days.length < 2) {
    return (
      <span className={`dayspark dayspark-empty${className ? ` ${className}` : ""}`} style={{ width, height }} role="img" aria-label={summary}>
        no data
      </span>
    );
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  const pad = 2;
  const sx = (i: number) => pad + (i / (days.length - 1)) * (width - 2 * pad);
  const sy = (n: number) => height - pad - (n / max) * (height - 2 * pad);
  const f = (n: number) => n.toFixed(1);
  const line = days.map((d, i) => `${i ? "L" : "M"}${f(sx(i))},${f(sy(d.n))}`).join(" ");
  const area = `${line} L${f(sx(days.length - 1))},${height - pad} L${f(sx(0))},${height - pad} Z`;
  const last = days[days.length - 1]!;
  return (
    <svg className={`dayspark${className ? ` ${className}` : ""}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
      <title>{summary}</title>
      <path d={area} className="dayspark-area" />
      <path d={line} className="dayspark-line" fill="none" />
      <circle cx={sx(days.length - 1)} cy={sy(last.n)} r={2} className="dayspark-dot" />
    </svg>
  );
}
