// A 12-point trend line drawn as inline SVG, no library. The line is the
// quiet grey of a stat tile's trend; the current period is marked in navy.
// Every point carries a native tooltip and the numbers are also in a
// visually-hidden table, so the figure never depends on sight or hover.

export type SparkPoint = { label: string; value: number };

const WIDTH = 280;
const HEIGHT = 64;
const PAD = 6;

/** Pixel coordinates for the values, oldest first, with the baseline at the bottom. */
export function sparklinePoints(values: number[], width = WIDTH, height = HEIGHT, pad = PAD): { x: number; y: number }[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 0);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;
  return values.map((v, i) => ({
    x: Math.round((pad + i * step) * 10) / 10,
    y: Math.round((pad + innerH - (max > 0 ? (Math.max(v, 0) / max) * innerH : 0)) * 10) / 10,
  }));
}

export function sparklinePath(values: number[], width = WIDTH, height = HEIGHT): string {
  return sparklinePoints(values, width, height)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`)
    .join(" ");
}

export function Sparkline({
  id,
  label,
  points,
  format = (v) => String(v),
  unit,
}: {
  id: string;
  label: string;
  points: SparkPoint[];
  format?: (value: number) => string;
  /** Column heading for the values in the hidden table, e.g. "People". */
  unit: string;
}) {
  const values = points.map((p) => p.value);
  const coords = sparklinePoints(values);
  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  const path = sparklinePath(values);
  const area = coords.length ? `${path} L${coords[coords.length - 1].x} ${HEIGHT - PAD} L${coords[0].x} ${HEIGHT - PAD} Z` : "";
  const delta = last && previous ? last.value - previous.value : null;
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <figure className="trend" aria-labelledby={`${id}-label`}>
      <figcaption>
        <span className="trend__label" id={`${id}-label`}>
          {label}
        </span>
        <span className="trend__value">{last ? format(last.value) : "—"}</span>
        <span className="trend__delta">
          this week{delta !== null ? ` · ${delta >= 0 ? "+" : "−"}${format(Math.abs(delta))} vs last week` : ""}
        </span>
      </figcaption>
      <svg className="sparkline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`} focusable="false">
        <title id={`${id}-title`}>{label}, last {points.length} weeks</title>
        <desc id={`${id}-desc`}>
          {format(total)} {unit.toLowerCase()} in total over {points.length} weeks; {last ? format(last.value) : "none"} this week.
        </desc>
        {area && <path className="sparkline__area" d={area} />}
        {path && <path className="sparkline__line" d={path} />}
        {coords.map((c, i) => (
          <circle key={points[i].label} className={i === coords.length - 1 ? "sparkline__last" : "sparkline__point"} cx={c.x} cy={c.y} r={i === coords.length - 1 ? 4 : 7}>
            <title>
              Week of {points[i].label}: {format(points[i].value)}
            </title>
          </circle>
        ))}
      </svg>
      <table className="visually-hidden">
        <caption>{label} by week</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">{unit}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              <td>{format(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
