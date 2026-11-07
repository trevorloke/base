import { keyDates, termEnd, termStart } from "@/content/tracker";

const DAY = 86_400_000;
const t = (iso: string) => new Date(`${iso}T12:00:00Z`).getTime();
const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The term on one line: each key date placed in proportion, today marked. */
export function KeyDates({ today }: { today: string }) {
  const start = t(termStart);
  const span = t(termEnd) - start;
  const pct = (iso: string) => Math.min(100, Math.max(0, ((t(iso) - start) / span) * 100));
  const years = [2027, 2028, 2029, 2030];
  const next = keyDates.find((d) => (d.end ?? d.start) >= today);
  const daysTo = next ? Math.ceil((t(next.start) - t(today)) / DAY) : 0;

  return (
    <div className="key-dates">
      {next && (
        <p className="key-next">
          <span className="eyebrow">Next up</span>
          <strong>{next.label}</strong>{" "}
          {daysTo > 0 ? `in ${daysTo} day${daysTo === 1 ? "" : "s"}` : next.end && today <= next.end ? "now" : "today"}
          <span className="key-next-date">{next.end ? `${fmt(next.start)} to ${fmt(next.end)}` : fmt(next.start)}</span>
        </p>
      )}
      <ol className="timeline" aria-label="Key dates in the Safe Surrey term">
        <li className="timeline-axis" aria-hidden="true">
          {years.map((y) => (
            <span key={y} style={{ left: `${pct(`${y}-01-01`)}%` }}>
              {y}
            </span>
          ))}
          {today >= termStart && today <= termEnd && <span className="timeline-today" style={{ left: `${pct(today)}%` }} title="Today" />}
        </li>
        {keyDates.map((d) => {
          const past = (d.end ?? d.start) < today;
          return (
            <li key={d.label} className={`timeline-row ${d.hard ? "is-hard" : ""} ${past ? "is-past" : ""}`}>
              <span className="timeline-label">
                {d.label}
                {d.note && <span className="timeline-note">{d.note}</span>}
              </span>
              <span className="timeline-track">
                <span
                  className={d.end ? "timeline-range" : "timeline-point"}
                  style={d.end ? { left: `${pct(d.start)}%`, width: `max(10px, ${pct(d.end) - pct(d.start)}%)` } : { left: `${pct(d.start)}%` }}
                />
                <span className="timeline-date" style={pct(d.start) > 65 ? { right: `${100 - pct(d.start) + 2}%` } : { left: `calc(${pct(d.end ?? d.start)}% + 16px)` }}>
                  {d.end ? `${fmt(d.start)} to ${fmt(d.end)}` : fmt(d.start)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
