// What base.win sends Google Calendar, and how its answers are read. One
// mapping from a calendar entry (shared/ics.js) to Google's event body, the
// ids base.win chooses (Google's base32hex: digits and a–v only), and the
// calendar's own body.
//
//   GOOGLE_CALENDAR_API_BASE   a test address (server/test/fake-google.js);
//                              ignored in production
import { createHash } from 'node:crypto';
import { canonical } from '../../lib/events.js';
import { testBase } from '../../lib/google/config.js';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const calBase = () => testBase('GOOGLE_CALENDAR_API_BASE') || CALENDAR_API;

export const ID_RE = /^[0-9a-v]{5,1024}$/;
const ymd = (day) => String(day).replace(/-/g, '');
// shift-<uuid>@base.win → bs<32 hex>; vote-<day>@base.win → bv<yyyymmdd>;
// filing-<slot>-<day>@base.win → bf<slot><yyyymmdd>.
export const eventIdOf = (uid) => {
  let m = /^shift-([0-9a-f-]{36})@base\.win$/i.exec(uid);
  if (m) return { id: `bs${m[1].replace(/-/g, '').toLowerCase()}`, kind: 'shift' };
  m = /^vote-(\d{4}-\d{2}-\d{2})@base\.win$/.exec(uid);
  if (m) return { id: `bv${ymd(m[1])}`, kind: 'vote' };
  m = /^filing-(\d+)-(\d{4}-\d{2}-\d{2})@base\.win$/.exec(uid);
  if (m) return { id: `bf${m[1]}${ymd(m[2])}`, kind: 'filing' };
  return null;
};

// No attendees, no conference, no reminders, no recurrence: times in UTC,
// as shared/ics.js writes them, so any server's time zone sends the same.
export const toGoogle = (e, id) => ({
  id,
  status: 'confirmed',
  summary: e.title,
  description: e.details || '',
  ...(e.where ? { location: e.where } : {}),
  start: e.allDay ? { date: e.start } : { dateTime: e.start },
  end: e.allDay ? { date: e.end } : { dateTime: e.end },
});

export const calBody = (name, tz) => ({
  summary: `${name} — my shifts (base.win)`,
  timeZone: tz,
  description: 'Kept up to date by base.win.',
});

export const hashOf = (body) => createHash('sha256').update(canonical(body)).digest('hex');

// Google's reason code only — never its message.
export const reasonOf = (body) => body?.error?.errors?.[0]?.reason
  || (Array.isArray(body?.error?.details) ? body.error.details.find((d) => d?.reason)?.reason : null) || null;
export const SCOPE_REASONS = ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'authError'];

// The UTC instant of a wall-clock time in a time zone ('2030-10-19', '03:17').
const offsetMs = (t, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - t;
};
export const wallToUtc = (day, hm, tz) => {
  const guess = Date.parse(`${day}T${hm}:00Z`);
  const first = guess - offsetMs(guess, tz);
  return new Date(guess - offsetMs(first, tz));
};
export const dayIn = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
export const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
