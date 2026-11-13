// Calendar entries — one builder for the server (the file links, a
// person's calendar link, shift emails, the website's events.ics) and the
// screens (the Google and Outlook links). Pure: no clock but `now`, no
// network.
//
// An event: { uid, title, start, end, allDay?, where?, geo?, details?, url? }
//   start, end   ISO instants; or 'YYYY-MM-DD' days with allDay (end is the
//                day after the last, as calendars count)
//   where        place words; geo { lat, lng } when it has a pin
//
// The format (RFC 5545): CRLF line ends, lines folded at 75 octets (never
// inside a character), text values escaped. Every timed event is written in
// UTC with no time zone: a calendar app whose copy of the time-zone rules
// still has B.C. falling back on Nov 1, 2026 would put a 6:30 am shift at
// 5:30 if it were written as Vancouver time, but a UTC moment is the same
// moment everywhere. Days (voting days, filing dates) have no time and no
// zone. No alarms: Google drops them from calendar links, and reminders are
// the person's own choice.
import { addDays, fmtIn, wallClock, CAMPAIGN_TZ } from './dayparts.js';
import { shiftKind, whereWords, pinPoint } from './shiftkinds.js';
import { hoursOf } from './shifthours.js';

const CRLF = '\r\n';
const enc = new TextEncoder();
const pad = (n) => String(n).padStart(2, '0');

// A content line cut into lines of at most 75 octets, each further line
// starting with a space — cut only between characters.
export const fold = (line) => {
  const out = [];
  let cur = '';
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const room = out.length ? 74 : 75; // a further line spends one on its space
    if (size + n > room) { out.push(cur); cur = ''; size = 0; }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
};
// A TEXT value: backslash, semicolon, comma and new lines escaped.
export const escText = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n');

const isDayStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
// 2026-11-16T13:30:00.000Z → 20261116T133000Z
const utcStamp = (when) => new Date(when).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
const dayStamp = (day) => String(day).replace(/-/g, '');
const endOf = (e) => e.end || (e.allDay ? addDays(e.start, 1) : e.start);

// e.stamp: when this entry last changed, where the caller knows it — a
// calendar keeps the copy with the later DTSTAMP.
export const icsEvent = (e, { now = new Date() } = {}) => {
  const lines = ['BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utcStamp(e.stamp || now)}`, `SUMMARY:${escText(e.title)}`];
  if (e.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dayStamp(e.start)}`, `DTEND;VALUE=DATE:${dayStamp(endOf(e))}`);
  } else {
    lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(endOf(e))}`);
  }
  if (e.where) lines.push(`LOCATION:${escText(e.where)}`);
  if (e.geo && Number.isFinite(Number(e.geo.lat)) && Number.isFinite(Number(e.geo.lng))) {
    lines.push(`GEO:${Number(e.geo.lat)};${Number(e.geo.lng)}`);
  }
  if (e.details) lines.push(`DESCRIPTION:${escText(e.details)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  lines.push('STATUS:CONFIRMED', 'END:VEVENT');
  return lines.map(fold).join(CRLF) + CRLF;
};

// A whole calendar. refresh: a calendar link (subscription), which asks to
// be checked hourly — Apple and Outlook on a computer may; Google doesn't.
export const icsCalendar = ({ name, events = [], refresh = false, now = new Date() }) => {
  const head = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//base.win//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(name)}`,
    ...(refresh ? ['REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'] : [])];
  return head.map(fold).join(CRLF) + CRLF + events.map((e) => icsEvent(e, { now })).join('') + `END:VCALENDAR${CRLF}`;
};

// ── Links that add one event ──
const q = (pairs) => pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const linkDetails = (e) => [e.details, e.url && !String(e.details || '').includes(e.url) ? e.url : null].filter(Boolean).join('\n');

export const googleLink = (e) => {
  const dates = e.allDay ? `${dayStamp(e.start)}/${dayStamp(endOf(e))}` : `${utcStamp(e.start)}/${utcStamp(endOf(e))}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&${q([['text', e.title]])}&dates=${dates}&${q([['details', linkDetails(e)], ['location', e.where]])}`.replace(/&$/, '');
};

// Outlook.com (a personal account); a work account takes the file.
const outlookTime = (when) => new Date(when).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const outlookLink = (e) => {
  const times = e.allDay
    ? [['startdt', e.start], ['enddt', endOf(e)], ['allday', 'true']]
    : [['startdt', outlookTime(e.start)], ['enddt', outlookTime(endOf(e))]];
  return `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&${q([['subject', e.title], ...times, ['body', linkDetails(e)], ['location', e.where]])}`;
};

// ── The things base.win puts in calendars ──
// A clock time the way the notices say it: "6:30", "6"; and its half: "a.m.".
const clockOf = (when, tz) => {
  const { hour, minute } = wallClock(when, tz);
  return { words: `${hour % 12 || 12}${minute ? `:${pad(minute)}` : ''}`, half: hour < 12 ? 'a.m.' : 'p.m.' };
};
// "6:30 – 8:30 a.m.", "11 a.m. – 1 p.m.", "6:30 a.m." with no end.
const spanOf = (start, end, tz) => {
  const a = clockOf(start, tz);
  if (!end) return `${a.words} ${a.half}`;
  const b = clockOf(end, tz);
  return a.half === b.half ? `${a.words} – ${b.words} ${b.half}` : `${a.words} ${a.half} – ${b.words} ${b.half}`;
};
const DAY_WORDS = { weekday: 'long', month: 'long', day: 'numeric' };
// "Monday, November 16, 6:30 – 8:30 a.m." — and the end's day too when the
// shift runs past midnight.
export const whenWords = (start, end, tz = CAMPAIGN_TZ) => {
  const day = fmtIn(start, tz, DAY_WORDS);
  if (end && wallClock(end, tz).day !== wallClock(start, tz).day) {
    const a = clockOf(start, tz);
    const b = clockOf(end, tz);
    return `${day}, ${a.words} ${a.half} – ${fmtIn(end, tz, DAY_WORDS)}, ${b.words} ${b.half}`;
  }
  return `${day}, ${spanOf(start, end, tz)}`;
};

const DEFAULT_MINUTES = 120;
// A shift's pin: its saved place's, else the words' own.
const geoOf = (shift) => {
  const lat = shift.lat ?? shift.place_lat;
  const lng = shift.lng ?? shift.place_lng;
  if (lat != null && lng != null) return { lat: Number(lat), lng: Number(lng) };
  return pinPoint(shift.location);
};

// A shift as an event. booking: the person's own { arrive_at, leave_at }
// (SH), so their entry carries their own hours. private (the default): the
// file a person opens and the file in their own email, which carry the
// desk's instructions and Details link; false for a calendar link, which
// lives in another company's calendar and may be forwarded — instructions
// can hold a door code or a phone number. Never anyone else on the shift,
// a phone, an email, the limit or the count.
// appUrl: the shift in the app, left out when there is no address for it.
export const shiftEvent = (shift, { tz = CAMPAIGN_TZ, appUrl = null, booking = null, private: own = true } = {}) => {
  const h = hoursOf(shift, booking);
  const noEnd = !h.ends_at;
  const minutes = shiftKind(shift.kind)?.minutes || DEFAULT_MINUTES;
  const end = h.ends_at ? new Date(h.ends_at).toISOString() : new Date(new Date(h.starts_at).getTime() + minutes * 60_000).toISOString();
  const where = shift.location ? whereWords(shift.location) : '';
  const details = [
    h.part ? `Your part: ${spanOf(h.starts_at, h.ends_at, tz)} of a ${spanOf(shift.starts_at, shift.ends_at, tz)} shift` : null,
    whenWords(h.starts_at, noEnd ? null : end, tz),
    shift.drop_in === true || shift.drop_in === 'true' ? 'Drop in any time' : null,
    noEnd ? 'No end time set' : null,
    where ? `Where: ${where}` : null,
    own && shift.instructions ? `Instructions: ${shift.instructions}` : null,
    own && shift.link ? `Details: ${shift.link}` : null,
    appUrl ? `Open in base.win: ${appUrl}` : null,
  ].filter(Boolean).join('\n');
  return {
    uid: `shift-${shift.id}@base.win`,
    title: shift.title,
    start: new Date(h.starts_at).toISOString(),
    end,
    where,
    geo: geoOf(shift),
    details,
    url: appUrl || null,
  };
};

// A day with no time: a voting day, a filing date.
export const dayEvent = ({ uid, title, day, details = null, url = null }) => (isDayStr(day)
  ? { uid, title, start: day, end: addDays(day, 1), allDay: true, details, url }
  : null);
