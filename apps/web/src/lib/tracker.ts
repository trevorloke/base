import type { Entity, EntityRelation, EntityReportRow } from "../types";
import type { PillTone } from "../components/Pill";
import { formatDateShort } from "./time";
import { dayKey } from "./tz";

// The tracker's shared helpers: periods, day series, the family tree of organisations and their people.

export type TrackerPeriod = "24h" | "7d" | "30d";

export const PERIODS: { id: TrackerPeriod; label: string; days: number; long: string }[] = [
  { id: "24h", label: "24h", days: 1, long: "the last 24 hours" },
  { id: "7d", label: "7d", days: 7, long: "the last 7 days" },
  { id: "30d", label: "30d", days: 30, long: "the last 30 days" },
];

export function periodOf(id: TrackerPeriod) {
  return PERIODS.find((p) => p.id === id) ?? PERIODS[1]!;
}

const PERIOD_STORAGE = "starsign.trackerPeriod";

export function readTrackerPeriod(): TrackerPeriod {
  try {
    const v = localStorage.getItem(PERIOD_STORAGE);
    return v === "24h" || v === "7d" || v === "30d" ? v : "7d";
  } catch {
    return "7d";
  }
}

export function rememberTrackerPeriod(p: TrackerPeriod): void {
  try {
    localStorage.setItem(PERIOD_STORAGE, p);
  } catch {
    // fine: lasts for this page load
  }
}

/** Relations are colour-coded quietly: a tinted pill, never a loud fill. */
export const RELATION_TONE: Record<EntityRelation, PillTone> = {
  own: "accent",
  client: "good",
  prospect: "info",
  competitor: "warn",
  opponent: "bad",
  watch: "neutral",
};

/**
 * The report lists only days with mentions. Fill every day from `fromIso` to `toIso` (in the workspace's time zone)
 * with zeros, so a quiet day reads as a dip and not as a gap. At least `minDays` points.
 */
export function fillDays(byDay: { day: string; n: number }[], fromIso: string, toIso: string, tz: string, minDays = 7): { day: string; n: number }[] {
  const to = Date.parse(toIso);
  let from = Date.parse(fromIso);
  if (!Number.isFinite(to) || !Number.isFinite(from)) return byDay;
  from = Math.min(from, to - (minDays - 1) * 86_400_000);
  const counts = new Map(byDay.map((d) => [d.day, d.n]));
  const keys: string[] = [];
  for (let t = from; t <= to + 1; t += 3_600_000 * 6) {
    const k = dayKey(t, tz);
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  const last = dayKey(to, tz);
  if (keys[keys.length - 1] !== last) keys.push(last);
  return keys.slice(-Math.max(minDays, Math.round((to - from) / 86_400_000))).map((day) => ({ day, n: counts.get(day) ?? 0 }));
}

/** "YYYY-MM-DD" read at midday UTC, so the label never slips a day in the viewer's time zone. */
export function dayLabel(day: string): string {
  return formatDateShort(`${day}T12:00:00Z`);
}

/** "412 mentions from Oct 31 to Nov 6, most on Nov 5 (88)". */
export function seriesSummary(days: { day: string; n: number }[]): string {
  if (!days.length) return "No mentions yet";
  const total = days.reduce((n, d) => n + d.n, 0);
  const peak = days.reduce((best, d) => (d.n > best.n ? d : best), days[0]!);
  const span = `from ${dayLabel(days[0]!.day)} to ${dayLabel(days[days.length - 1]!.day)}`;
  if (!total) return `No mentions ${span}`;
  return `${total.toLocaleString()} ${total === 1 ? "mention" : "mentions"} ${span}, most on ${dayLabel(peak.day)} (${peak.n.toLocaleString()})`;
}

export interface TreeRow<T> {
  row: T;
  depth: number;
  /** How many belong to it directly. */
  people: number;
}

/**
 * Top-level entities (organisations and unattached people), each followed by what belongs to it, indented. An entity
 * whose parent is missing from the list (archived) is shown at the top level, like the report counts it.
 */
export function familyTree<T extends Pick<EntityReportRow, "id" | "parentId" | "name" | "mentions" | "familyMentions">>(rows: T[]): TreeRow<T>[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<string, T[]>();
  const top: T[] = [];
  for (const r of rows) {
    if (r.parentId && byId.has(r.parentId) && r.parentId !== r.id) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
    else top.push(r);
  }
  const order = (a: T, b: T) => b.familyMentions - a.familyMentions || b.mentions - a.mentions || a.name.localeCompare(b.name);
  const out: TreeRow<T>[] = [];
  const seen = new Set<string>();
  const walk = (r: T, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const children = (kids.get(r.id) ?? []).slice().sort(order);
    out.push({ row: r, depth, people: children.length });
    for (const c of children) walk(c, depth + 1);
  };
  for (const r of top.slice().sort(order)) walk(r, 0);
  // Anything left (a cycle the server should have refused) still shows, at the top level.
  for (const r of rows) if (!seen.has(r.id)) walk(r, 0);
  return out;
}

/** The entity and everything that belongs to it, at any depth. */
export function descendantsOf(all: Pick<Entity, "id" | "parentId">[], rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of all) {
      if (e.parentId && out.has(e.parentId) && !out.has(e.id)) {
        out.add(e.id);
        grew = true;
      }
    }
  }
  return out;
}

/** -1..1 → a word; null when nothing was scored. */
export function toneWord(sentiment: number | null): string | null {
  if (sentiment === null || !Number.isFinite(sentiment)) return null;
  if (sentiment >= 0.25) return "Mostly positive";
  if (sentiment <= -0.25) return "Mostly negative";
  return "Mixed";
}
