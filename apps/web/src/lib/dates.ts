const TZ = "America/Vancouver";

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ, month: "long", day: "numeric", year: "numeric" });
}

export function formatEventTime(d: Date): string {
  return d.toLocaleString("en-CA", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function dayAndMonth(d: Date): { day: string; mon: string } {
  return {
    day: d.toLocaleDateString("en-CA", { timeZone: TZ, day: "numeric" }),
    mon: d.toLocaleDateString("en-CA", { timeZone: TZ, month: "short" }).replace(".", ""),
  };
}

export function timeOnly(d: Date): string {
  return d.toLocaleTimeString("en-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

/** Midnight at the start of the current day in Surrey (Pacific time), as an instant. */
export function startOfPacificDay(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const [y, m, d] = [get("year"), get("month"), get("day")];
  const hourIn = (t: Date) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(t));
  // Local midnight is 07:00 UTC under PDT and 08:00 UTC under PST.
  for (const utcHour of [7, 8]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, utcHour));
    if (hourIn(candidate) === 0) return candidate;
  }
  return new Date(Date.UTC(y, m - 1, d, 8));
}
