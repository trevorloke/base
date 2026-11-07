// Pure helpers shared by the admin content forms (client) and their server
// actions. No database, no request state, so they can be unit tested.

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;

/** "Town hall in Newton!" → "town-hall-in-newton". Empty input gives "". */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const PACIFIC = "America/Vancouver";

/** The UTC offset (hours, negative west of Greenwich) in effect in Surrey at an instant. */
export function pacificOffsetHours(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC, timeZoneName: "shortOffset" }).formatToParts(d);
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(parts.find((p) => p.type === "timeZoneName")?.value ?? "");
  if (!m) return -8;
  const hours = Number(m[1]);
  return m[2] ? hours + Math.sign(hours) * (Number(m[2]) / 60) : hours;
}

/** "2026-11-05T19:00" typed in Surrey → the right instant. */
export function pacificLocalToDate(local: string): Date {
  const asUtc = new Date(`${local}:00Z`);
  // Take the offset in effect at that wall-clock time: check the first guess
  // again so a time shortly after a DST change lands on the right side of it.
  let guess = new Date(asUtc.getTime() - pacificOffsetHours(asUtc) * 3600_000);
  const offset = pacificOffsetHours(guess);
  const second = new Date(asUtc.getTime() - offset * 3600_000);
  if (second.getTime() !== guess.getTime()) guess = second;
  return guess;
}

/** An instant → "YYYY-MM-DDTHH:mm" in Surrey time, for datetime-local inputs. */
export function dateToPacificLocal(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** "12.50" → 1250 cents; anything that is not a positive dollar amount with at most two decimals → null. */
export function dollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return cents > 0 ? cents : null;
}

export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email addresses typed one per line (or separated by commas): trimmed, lower-cased, de-duplicated. */
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) invalid.push(e);
    else if (!emails.includes(e)) emails.push(e);
  }
  return { emails, invalid };
}

export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export type PublishStatus = "draft" | "scheduled" | "published";

/** A post's status from its publish date: null is a draft, a future date is scheduled. */
export function publishStatus(publishedAt: Date | string | null | undefined, now: Date = new Date()): PublishStatus {
  if (!publishedAt) return "draft";
  const at = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  return at.getTime() > now.getTime() ? "scheduled" : "published";
}

/** "titlePrefix" → "Title prefix"; a few abbreviations stay upper case. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  const upper = new Set(["cta", "ctas", "url", "seo", "id"]);
  return words
    .map((w, i) => (upper.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Relative admin URLs for each kind of content. */
export const ADMIN_PATHS = {
  news: "/admin/content/news",
  events: "/admin/content/events",
  products: "/admin/content/products",
  campaigns: "/admin/content/campaigns",
  pages: "/admin/pages",
  media: "/admin/media",
  settings: "/admin/settings",
  integrations: "/admin/integrations",
} as const;
