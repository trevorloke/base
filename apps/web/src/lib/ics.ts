// Calendar files (.ics) and "add to calendar" links for events and shifts.
// Pure functions, usable on server and client.
import { clientProfile } from "@/seeds/client";

export type IcsEvent = {
  /** Stable per event, e.g. `event-<id>@imaginesurrey.ca`, so updates replace rather than duplicate. */
  uid: string;
  title: string;
  start: Date;
  end?: Date;
  location?: string;
  description?: string;
  url?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");

function utc(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 line folding: lines longer than 75 octets continue with a leading space. */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > 75) {
      out.push(current);
      current = " ";
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n");
}

export function icsCalendar(events: IcsEvent[], calendarName = clientProfile.orgName): string {
  const now = utc(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${clientProfile.orgName.replace(/[/\r\n]/g, " ")}//Website//EN`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeText(calendarName)}`];
  for (const e of events) {
    const end = e.end ?? new Date(e.start.getTime() + 2 * 3600_000);
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${now}`, `DTSTART:${utc(e.start)}`, `DTEND:${utc(end)}`, `SUMMARY:${escapeText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl(e: IcsEvent): string {
  const end = e.end ?? new Date(e.start.getTime() + 2 * 3600_000);
  const params = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${utc(e.start)}/${utc(end)}` });
  if (e.location) params.set("location", e.location);
  if (e.description || e.url) params.set("details", [e.description, e.url].filter(Boolean).join("\n\n"));
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Shift windows in Pacific time for the three slots. */
export const SLOT_HOURS: Record<"morning" | "afternoon" | "evening", { start: number; end: number }> = {
  morning: { start: 9, end: 12 },
  afternoon: { start: 13, end: 16 },
  evening: { start: 17, end: 20 },
};

/** A Date for a Pacific-time wall clock on a YYYY-MM-DD date. */
export function pacificDate(isoDate: string, hour: number, minute = 0): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Find the UTC offset in effect on that date in Vancouver (PST -8 or PDT -7).
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", timeZoneName: "shortOffset" }).formatToParts(probe);
  const match = /GMT([+-]\d+)/.exec(parts.find((p) => p.type === "timeZoneName")?.value ?? "");
  const offset = match ? Number(match[1]) : -8;
  return new Date(Date.UTC(y, m - 1, d, hour - offset, minute));
}
