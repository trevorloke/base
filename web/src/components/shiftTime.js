// A shift's day and hours in words, on the campaign's clock (workspace
// settings.tz; shared/dayparts.js) — never the device's. A laptop on Toronto
// time, a phone abroad, the week screen and the emails all say the same hour.
// Used by the Shifts list, a shift's page, the roster, the crew board and
// Today.
import { addDays, clockOf, dayOf, fmtIn, safeZone, spanWords } from '@starbase/shared/dayparts';

export const zoneOf = (me) => safeZone(me?.workspace?.settings?.tz);

// "Sat, Nov 14" · "Saturday, November 14" · "Nov 14"
export const shortDay = (iso, tz) => fmtIn(iso, tz, { weekday: 'short', month: 'short', day: 'numeric' });
export const longDay = (iso, tz) => fmtIn(iso, tz, { weekday: 'long', month: 'long', day: 'numeric' });
export const monthDay = (iso, tz) => fmtIn(iso, tz, { month: 'short', day: 'numeric' });
// "Today", "Tomorrow", else the day — by the campaign's calendar. `long`:
// "Saturday, November 14" (a heading) rather than "Sat, Nov 14".
export const dayName = (iso, tz, { long = false } = {}) => {
  const day = dayOf(iso, tz);
  const today = dayOf(new Date(), tz);
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  return long ? longDay(iso, tz) : shortDay(iso, tz);
};
// "6:30 am"
export const clockText = (iso, tz) => spanWords(clockOf(iso, tz));
// "6:30–8:30 am", "10 am" with no end; past midnight the way the week board
// says it, "8 pm–1 am next day" (ending at midnight is that evening's); a
// span of more than a day keeps its end's date: "10 am – Tue, Nov 17, 2 pm".
export const timeRange = (starts, ends, tz) => {
  if (!ends) return clockText(starts, tz);
  const from = dayOf(starts, tz);
  const to = dayOf(new Date(Date.parse(ends) - 60e3).toISOString(), tz);
  if (to <= from) return spanWords(clockOf(starts, tz), clockOf(ends, tz));
  if (to === addDays(from, 1)) return `${spanWords(clockOf(starts, tz), clockOf(ends, tz))} next day`;
  return `${clockText(starts, tz)} – ${shortDay(ends, tz)}, ${clockText(ends, tz)}`;
};
// "Sat, Nov 14, 6:30 a.m." — a shift on one of Today's lines.
export const whenText = (iso, tz) => fmtIn(iso, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// "Nov 14, 6:30 a.m." — when a notice went.
export const stampText = (iso, tz) => (iso ? fmtIn(iso, tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

// Two shifts at once: a shift with no end counts as an hour.
const span = (s) => {
  const a = new Date(s.starts_at).getTime();
  const b = s.ends_at ? new Date(s.ends_at).getTime() : a + 3600e3;
  return [a, Math.max(b, a + 1)];
};
export const overlaps = (x, y) => { const [a1, b1] = span(x); const [a2, b2] = span(y); return a1 < b2 && a2 < b1; };
