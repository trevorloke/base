// Wall-clock time in the workspace's policy timezone. The calendar groups by the workspace's days,
// and a scheduled time means "9:30 where the brand lives", not where this browser happens to be.

const DAY = 86_400_000;

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const validity = new Map<string, boolean>();
/** The given zone if this browser knows it, otherwise the browser's own. */
export function safeTz(tz: string | null | undefined): string {
  if (!tz) return browserTz();
  let ok = validity.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    validity.set(tz, ok);
  }
  return ok ? tz : browserTz();
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions, locale: string | undefined = undefined): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${tz}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz });
    fmtCache.set(key, f);
  }
  return f;
}

export interface Wall {
  y: number;
  /** 1–12 */
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function wallParts(ms: number, tz: string): Wall {
  const parts = fmt(tz, { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }, "en-US").formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const h = n("hour");
  return { y: n("year"), m: n("month"), d: n("day"), h: h === 24 ? 0 : h, mi: n("minute"), s: n("second") };
}

function offsetMs(ms: number, tz: string): number {
  const w = wallParts(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time in `tz` → the instant. */
export function wallToMs(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(ms, tz);
  if (second !== ms) ms = second;
  return ms;
}

/** Monday 00:00 of the week containing `ms`, in `tz`. */
export function weekStartMs(ms: number, tz: string): number {
  const w = wallParts(ms, tz);
  const dow = new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
  const base = new Date(Date.UTC(w.y, w.m - 1, w.d - ((dow + 6) % 7)));
  return wallToMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, tz);
}

/** Calendar days later at the same wall time (DST-safe). */
export function addDays(ms: number, days: number, tz: string): number {
  const w = wallParts(ms, tz);
  const base = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
  return wallToMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), w.h, w.mi, tz);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-02" in `tz`. */
export function dayKey(ms: number, tz: string): string {
  const w = wallParts(ms, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** The value a `<input type="datetime-local">` shows for an instant, in `tz`. */
export function toLocalInput(ms: number, tz: string): string {
  const w = wallParts(ms, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** A `datetime-local` value read as wall time in `tz` → the instant, or null. */
export function fromLocalInput(value: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return wallToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
}

/** "Pacific Time" where the browser knows the generic name; otherwise "Los Angeles". */
export function tzName(tz: string): string {
  try {
    const part = fmt(tz, { timeZoneName: "longGeneric" } as Intl.DateTimeFormatOptions)
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    if (part) return part;
  } catch {
    // older engines: fall through
  }
  return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}

/** "9:30 AM" in `tz`. */
export function clockIn(ms: number | string, tz: string): string {
  return fmt(tz, { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

/** "Tue 9:30 AM" in `tz`. */
export function dayClockIn(ms: number | string, tz: string): string {
  return fmt(tz, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

/** "Mon", "2" for a day column head. */
export function dayHeadIn(ms: number, tz: string): { weekday: string; day: string; long: string } {
  const d = new Date(ms);
  return {
    weekday: fmt(tz, { weekday: "short" }).format(d),
    day: fmt(tz, { day: "numeric" }).format(d),
    long: fmt(tz, { weekday: "long", month: "short", day: "numeric" }).format(d),
  };
}

/** "Nov 2 – Nov 15" for [from, to). */
export function rangeIn(fromMs: number, toMs: number, tz: string): string {
  const f = fmt(tz, { month: "short", day: "numeric" });
  return `${f.format(new Date(fromMs))} – ${f.format(new Date(toMs - DAY / 2))}`;
}
