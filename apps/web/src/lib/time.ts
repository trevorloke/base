const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "just now", "3m ago", "2h ago", "3d ago", "in 6h"; dates older than two weeks print as "Oct 12". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const d = parse(iso);
  if (!d) return "";
  const diff = now - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  if (abs < 45_000) return future ? "in a moment" : "just now";
  let s: string;
  if (abs < HOUR) s = `${Math.round(abs / MIN)}m`;
  else if (abs < DAY) s = `${Math.round(abs / HOUR)}h`;
  else if (abs < 14 * DAY) s = `${Math.round(abs / DAY)}d`;
  else return shortDate.format(d);
  return future ? `in ${s}` : `${s} ago`;
}

export function formatDateShort(iso: string): string {
  const d = parse(iso);
  return d ? shortDate.format(d) : "";
}

export function formatClock(iso: string): string {
  const d = parse(iso);
  return d ? clock.format(d) : "";
}

/**
 * "Nov 6, 9:30 AM". With `tz` (the workspace's policy timezone) the time reads where the brand lives, like the
 * calendar and the compose picker, and names the zone when it is not this browser's own.
 */
export function formatDateTime(iso: string, tz?: string, showZone = true): string {
  const d = parse(iso);
  if (!d) return "";
  if (!tz) return dateTime.format(d);
  try {
    const own = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, ...(showZone && tz !== own ? { timeZoneName: "short" } : {}) }).format(d);
  } catch {
    return dateTime.format(d);
  }
}

/** "Oct 27 – Nov 2" */
export function formatRange(fromIso: string, toIso: string): string {
  const a = formatDateShort(fromIso);
  const b = formatDateShort(toIso);
  if (!a || !b) return a || b;
  return `${a} – ${b}`;
}

/** Hours as a rough human span: "<1h", "~6h", "~2d". Estimates stay visibly rough. */
export function hoursLabel(h: number): string {
  if (!Number.isFinite(h)) return "";
  if (h < 1) return "<1h";
  if (h < 48) return `~${Math.round(h)}h`;
  return `~${Math.round(h / 24)}d`;
}

export function isoDaysAgo(days: number, now: number = Date.now()): string {
  return new Date(now - days * DAY).toISOString();
}

export function isoNow(): string {
  return new Date().toISOString();
}
