// Promise statuses and the pure helpers shared by the public tracker, the
// admin, the feeds, the JSON API and the share images. Nothing here touches
// the database, so it runs on the server and in the browser alike.
import * as neighbourhoodModule from "./neighbourhoods";
import { todayInSurrey } from "./shifts";

export const PROMISE_STATUSES = [
  { id: "not_started", label: "Not started", color: "#E3E7EF", text: "#0F1E33" },
  { id: "in_progress", label: "In progress", color: "#FFF100", text: "#003979" },
  { id: "partly_kept", label: "Partly kept", color: "#F28C28", text: "#0F1E33" },
  // Fills with white text are ≥ 4.5:1 at 13px bold.
  { id: "kept", label: "Kept", color: "#157A41", text: "#FFFFFF" },
  { id: "broken", label: "Broken", color: "#D81B1E", text: "#FFFFFF" },
] as const;

export type PromiseStatus = (typeof PROMISE_STATUSES)[number]["id"];

export const STATUS_BY_ID = Object.fromEntries(PROMISE_STATUSES.map((s) => [s.id, s])) as Record<
  PromiseStatus,
  (typeof PROMISE_STATUSES)[number]
>;

export const STATUS_IDS = PROMISE_STATUSES.map((s) => s.id) as [PromiseStatus, ...PromiseStatus[]];

export function isPromiseStatus(value: unknown): value is PromiseStatus {
  return typeof value === "string" && (STATUS_IDS as string[]).includes(value);
}

export function countByStatus(statuses: PromiseStatus[]): Record<PromiseStatus, number> {
  const counts = Object.fromEntries(PROMISE_STATUSES.map((s) => [s.id, 0])) as Record<PromiseStatus, number>;
  for (const s of statuses) counts[s] += 1;
  return counts;
}

/** Kept, partly kept and broken are final scores: the countdown stops. */
export function isSettled(status: PromiseStatus): boolean {
  return status === "kept" || status === "partly_kept" || status === "broken";
}

// ── Calendar dates ─────────────────────────────────────────────────────────
// Promise dates are plain YYYY-MM-DD strings. Arithmetic runs on UTC
// midnights so no time zone can shift a day; "today" is taken in Surrey.

const DAY_MS = 86_400_000;

function utcMidnight(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from one calendar date to another; negative when `to` is earlier. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((utcMidnight(toIso) - utcMidnight(fromIso)) / DAY_MS);
}

export function formatIsoDate(iso: string, style: "long" | "short" = "long"): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { month: style, day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The UTC offset Surrey is on at an instant, in hours (-8 in winter, -7 in summer). */
export function pacificOffsetHours(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", timeZoneName: "shortOffset" }).formatToParts(at);
  const m = /GMT([+-]\d+)/.exec(parts.find((p) => p.type === "timeZoneName")?.value ?? "");
  return m ? Number(m[1]) : -8;
}

/** Noon in Surrey on a calendar date, as an instant, for feed timestamps. */
export function noonInSurrey(iso: string): Date {
  const guess = new Date(`${iso}T12:00:00Z`);
  return new Date(guess.getTime() - pacificOffsetHours(guess) * 3600_000);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type DueKind = "due" | "due_today" | "overdue" | "waiting";
export type DueInfo = { kind: DueKind; days: number; label: string };
export type DueInput = { status: PromiseStatus; targetDate: string | null; promisedOn: string | null; hasRecord: boolean };

/**
 * The countdown or flag for a promise on a calendar date (today in Surrey).
 * A promise with a deadline counts down to it and then counts the days
 * overdue; one with no deadline and no record yet shows how long it has
 * waited. Final scores show nothing: the record speaks.
 */
export function dueInfo(p: DueInput, today: string): DueInfo | null {
  if (isSettled(p.status)) return null;
  if (p.targetDate) {
    const days = daysBetween(today, p.targetDate);
    if (days > 0) return { kind: "due", days, label: `Due in ${plural(days, "day")}` };
    if (days === 0) return { kind: "due_today", days: 0, label: "Due today" };
    return { kind: "overdue", days: -days, label: `${plural(-days, "day")} overdue` };
  }
  if (p.promisedOn && !p.hasRecord) {
    const days = daysBetween(p.promisedOn, today);
    if (days < 0) return null;
    return { kind: "waiting", days, label: days === 0 ? "Promised today, no record yet" : `Promised ${plural(days, "day")} ago, no record yet` };
  }
  return null;
}

/** `dueInfo` for an instant: the calendar date is the one in Surrey at that moment. */
export function dueInfoAt(p: DueInput, now: Date = new Date()): DueInfo | null {
  return dueInfo(p, todayInSurrey(now));
}

// ── Neighbourhoods ─────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

/**
 * The neighbourhood page for a town centre. Uses NEIGHBOURHOOD_SLUGS from
 * src/lib/neighbourhoods.ts when that map exists, else a slug of the name.
 */
export function neighbourhoodHref(name: string): string {
  // Looked up by a computed key so the bundler does not flag the export as missing while it does not exist.
  const exportName = ["NEIGHBOURHOOD", "SLUGS"].join("_");
  const slugs = (neighbourhoodModule as Record<string, unknown>)[exportName] as Record<string, string> | undefined;
  return `/neighbourhoods/${slugs?.[name] ?? slugify(name)}`;
}

// ── Summary ────────────────────────────────────────────────────────────────

export type TrackerSummary = { total: number; counts: Record<PromiseStatus, number>; lastUpdated: string | null };

/** Counts by status and the date of the newest update across all promises. */
export function summarize(promises: { status: PromiseStatus; updates: { date: string }[] }[]): TrackerSummary {
  let lastUpdated: string | null = null;
  for (const p of promises) for (const u of p.updates) if (!lastUpdated || u.date > lastUpdated) lastUpdated = u.date;
  return { total: promises.length, counts: countByStatus(promises.map((p) => p.status)), lastUpdated };
}

// ── RSS ────────────────────────────────────────────────────────────────────

/** Escape text for an XML element or attribute, dropping characters XML 1.0 forbids. */
export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type RssItem = { title: string; link: string; guid: string; pubDate: Date; description: string; category?: string };

export function buildRss(o: { title: string; link: string; description: string; selfUrl: string; items: RssItem[]; lastBuildDate: Date; language?: string }): string {
  const items = o.items
    .map(
      (i) =>
        `    <item>\n      <title>${escapeXml(i.title)}</title>\n      <link>${escapeXml(i.link)}</link>\n      <guid isPermaLink="false">${escapeXml(i.guid)}</guid>\n      <pubDate>${i.pubDate.toUTCString()}</pubDate>\n${
          i.category ? `      <category>${escapeXml(i.category)}</category>\n` : ""
        }      <description>${escapeXml(i.description)}</description>\n    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(o.title)}</title>
    <link>${escapeXml(o.link)}</link>
    <description>${escapeXml(o.description)}</description>
    <language>${escapeXml(o.language ?? "en-ca")}</language>
    <lastBuildDate>${o.lastBuildDate.toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(o.selfUrl)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

// ── Public shapes ──────────────────────────────────────────────────────────
// What the tracker pages, feeds and JSON API are built from. Dates are
// strings so the shapes survive the data cache unchanged.

export type TrackerSource = { label: string; url?: string };

export type PublicUpdate = { id: string; date: string; status: PromiseStatus | null; note: string; url: string | null; createdAt: string };

export type PublicPromiseRecord = {
  id: string;
  number: number;
  title: string;
  specifics: string;
  area: string;
  status: PromiseStatus;
  statusChangedAt: string | null;
  sources: TrackerSource[];
  testKept: string | null;
  testPartly: string | null;
  testBroken: string | null;
  testRecord: string | null;
  promisedOn: string | null;
  targetDate: string | null;
  neighbourhoods: string[];
  updates: PublicUpdate[];
};

export function promisePath(number: number): string {
  return `/tracker/${number}`;
}

/** The JSON API's list item for a promise. */
export function promiseToJson(p: PublicPromiseRecord, siteUrl: string, total: number) {
  const latest = p.updates[0];
  return {
    number: p.number,
    total,
    title: p.title,
    area: p.area,
    status: p.status,
    statusLabel: STATUS_BY_ID[p.status].label,
    statusChangedAt: p.statusChangedAt,
    promisedOn: p.promisedOn,
    targetDate: p.targetDate,
    neighbourhoods: p.neighbourhoods,
    sources: p.sources,
    latestUpdate: latest ? { date: latest.date, status: latest.status, note: latest.note, url: latest.url } : null,
    url: `${siteUrl}${promisePath(p.number)}`,
  };
}

/** The JSON API's full record for one promise. */
export function promiseRecordToJson(p: PublicPromiseRecord, siteUrl: string, total: number) {
  return {
    ...promiseToJson(p, siteUrl, total),
    specifics: p.specifics,
    deliveryTest: p.testKept ? { kept: p.testKept, partlyKept: p.testPartly, broken: p.testBroken, record: p.testRecord } : null,
    updates: p.updates.map((u) => ({ id: u.id, date: u.date, status: u.status, note: u.note, url: u.url })),
    shareImage: `${siteUrl}${promisePath(p.number)}/opengraph-image`,
  };
}

/** The scoreboard the widget and /api/promises/summary show. */
export function summaryToJson(summary: TrackerSummary, siteUrl: string) {
  return {
    total: summary.total,
    counts: summary.counts,
    statuses: PROMISE_STATUSES.map((s) => ({ id: s.id, label: s.label, color: s.color, count: summary.counts[s.id] })),
    lastUpdated: summary.lastUpdated,
    trackerUrl: `${siteUrl}/tracker`,
  };
}

export function shareTextFor(p: { number: number; title: string; status: PromiseStatus }, total: number): string {
  return `Promise ${p.number} of ${total}: "${p.title}" is ${STATUS_BY_ID[p.status].label.toLowerCase()} on the Safe Surrey promise tracker.`;
}
