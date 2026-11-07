/** [start, end) of the local calendar day containing `at`, in `timezone`, as UTC instants. */
export function localDayRange(at: Date, timezone: string): { start: Date; end: Date } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  const wallUtc = Date.UTC(y, m - 1, d, Number(p.hour) % 24, Number(p.minute), Number(p.second));
  const offsetMs = wallUtc - Math.floor(at.getTime() / 1000) * 1000;
  const start = new Date(Date.UTC(y, m - 1, d) - offsetMs);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export function localHour(at: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).formatToParts(at).find((x) => x.type === "hour")?.value;
  return Number(h ?? 0) % 24;
}
