/** Hour-of-day and weekday for an instant in an IANA zone, without a date library. */
export function localHourAndDay(at: Date, timezone: string): { hour: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(at);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  const dayPart = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(hourPart) % 24;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = Math.max(0, days.indexOf(dayPart));
  return { hour, day };
}

/** Is `hour` inside [start, end) with wrap-around across midnight when start > end. */
export function hourInWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
