// Pure helpers for the volunteer shift calendar, shared by server and client.

export const SLOTS = [
  { id: "morning", label: "Morning", hours: "9 a.m.–12 p.m." },
  { id: "afternoon", label: "Afternoon", hours: "1–4 p.m." },
  { id: "evening", label: "Evening", hours: "5–8 p.m." },
] as const;
export type Slot = (typeof SLOTS)[number]["id"];

// Brand colours first, then distinct, print-friendly ones.
export const TASK_PALETTE = [
  "#003979", // navy
  "#EF2023", // red
  "#FFF100", // yellow
  "#1B8A4B", // green
  "#7B3FA0", // purple
  "#F28C28", // orange
  "#0E9AA7", // teal
  "#C2185B", // magenta
  "#6D4C41", // brown
  "#7F8CA6", // grey
] as const;

export const DEFAULT_TASKS = [
  { name: "Door-knocking", color: "#003979" },
  { name: "Phone bank", color: "#EF2023" },
  { name: "Events", color: "#FFF100" },
  { name: "Office", color: "#1B8A4B" },
  { name: "Lawn signs", color: "#7B3FA0" },
];

export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** Dark or white text, whichever reads better on the background. */
export function textColorFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast against white vs. against our ink colour (#0F1E33, luminance ≈ 0.013).
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.063 ? "#FFFFFF" : "#0F1E33";
}

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Dates are plain YYYY-MM-DD strings; arithmetic runs in UTC so time zones can't shift a day. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Sunday that starts the week containing this date. */
export function weekStart(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return addDays(isoDate, -day);
}

export function weekDays(sunday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(sunday, i));
}

/** Today's date in Surrey. */
export function todayInSurrey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(now);
}

export function formatDay(isoDate: string): { weekday: string; date: string } {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return {
    weekday: d.toLocaleDateString("en-CA", { weekday: "short", timeZone: "UTC" }),
    date: d.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" }),
  };
}

export function formatWeekRange(sunday: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", {
      month: "long",
      day: "numeric",
      ...(withYear && { year: "numeric" }),
      timeZone: "UTC",
    });
  return `${fmt(sunday, false)} – ${fmt(addDays(sunday, 6), true)}`;
}

export const SLOT_BY_ID: Record<Slot, (typeof SLOTS)[number]> = Object.fromEntries(SLOTS.map((s) => [s.id, s])) as Record<Slot, (typeof SLOTS)[number]>;

export function slotLabel(slot: Slot): string {
  const s = SLOT_BY_ID[slot];
  return `${s.label} (${s.hours})`;
}

// What happened on a shift. "cancelled" exists in the database for volunteers
// who pull out; the board offers the four an organizer sets.
export const SHIFT_STATUSES = [
  { id: "scheduled", label: "Scheduled" },
  { id: "confirmed", label: "Confirmed" },
  { id: "attended", label: "Attended" },
  { id: "no_show", label: "No show" },
] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number]["id"] | "cancelled";

export const STATUS_LABELS: Record<ShiftStatus, string> = { scheduled: "Scheduled", confirmed: "Confirmed", attended: "Attended", no_show: "No show", cancelled: "Cancelled" };

/** Spots left on an opening: capacity minus the people signed up, never below zero. */
export function spotsLeft(capacity: number, signedUp: number): number {
  return Math.max(0, capacity - Math.max(0, signedUp));
}

export function isFull(capacity: number | null | undefined, signedUp: number): boolean {
  return capacity != null && spotsLeft(capacity, signedUp) === 0;
}

/** "Saturday, November 7" for a YYYY-MM-DD date. */
export function formatLongDate(isoDate: string, withYear = false): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", ...(withYear && { year: "numeric" }), timeZone: "UTC" });
}

/** Group dated items by the Sunday that starts their week, earliest week first. */
export function groupByWeek<T extends { date: string }>(items: T[]): { sunday: string; label: string; items: T[] }[] {
  const weeks = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const sunday = weekStart(item.date);
    weeks.set(sunday, [...(weeks.get(sunday) ?? []), item]);
  }
  return [...weeks.entries()].map(([sunday, list]) => ({ sunday, label: formatWeekRange(sunday), items: list }));
}

/** The next Saturday strictly after a date (a week ahead when the date is itself a Saturday). */
export function nextSaturday(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return addDays(isoDate, ((6 - day + 6) % 7) + 1);
}

/** What the sign-up API returns and the form shows after a successful sign-up. */
export type SignupConfirmation = {
  openingId: string;
  title: string;
  date: string;
  dateLabel: string;
  slot: Slot;
  slotLabel: string;
  location: string;
  neighbourhood: string | null;
  googleUrl: string;
  icsUrl: string;
  /** The volunteer page with the signer's referral code, for the share buttons. */
  shareUrl: string;
  spotsLeft: number;
};

/** A published opening as the public site shows it. Plain data: it is served from the cache as JSON. */
export type PublicOpening = {
  id: string;
  date: string;
  slot: Slot;
  title: string;
  location: string;
  neighbourhood: string | null;
  notes: string;
  capacity: number;
  taskId: string | null;
  taskName: string | null;
  taskColor: string | null;
  signedUp: number;
  spotsLeft: number;
};
