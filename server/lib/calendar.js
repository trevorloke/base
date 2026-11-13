// The calendar pieces the server's emails and reads share (shared/ics.js
// builds the bytes): where a shift opens in the app, a file's name, and the
// .ics a shift email carries.
import { icsCalendar, shiftEvent } from '@starbase/shared/ics';
import { basePath } from './mount.js';

// A shift in the app: the desk's or the field app's copy, under a client's
// path (/field, /desk) or at the server's root (/, /admin). null with no
// address to put in front.
export const shiftAppLink = (publicUrl, { desk = false, id }) => {
  const at = String(publicUrl || '').replace(/\/+$/, '');
  if (!at || !id) return null;
  const app = basePath() ? (desk ? '/desk' : '/field') : (desk ? '/admin' : '');
  return `${at}${app}/shifts/${id}`;
};
// The address emails and jobs use: only the configured one (no request).
export const configuredUrl = () => String(process.env.STARBASE_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;

// "Burma Shave — King George Blvd & 88 Ave" → burma-shave-king-george-blvd-88-ave.ics
export const icsFileName = (title) => `${String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'calendar'}.ics`;

export const ICS_TYPE = 'text/calendar; charset=utf-8';
const ATTACH_TYPE = 'text/calendar; method=PUBLISH; charset=utf-8';
export const CAL_LINE = 'Add to your calendar: open the attached file.';

// An email's words with the calendar line just before its sign-off
// ("— <campaign name>"), with the same gap the lines above it have.
export const withCalendarLine = (text) => {
  const s = String(text);
  const i = s.lastIndexOf('\n— ');
  if (i < 0) return `${s}\n${CAL_LINE}`;
  const double = s.slice(0, i).endsWith('\n');
  const at = double ? i - 1 : i;
  return `${s.slice(0, at)}${double ? '\n\n' : '\n'}${CAL_LINE}${s.slice(at)}`;
};

// The file a shift email carries: the person's own shifts, with their own
// hours (rows carry arrive_at / leave_at, null before SH), instructions and
// all — the reader is the person themselves.
// The same message must be the same bytes when it is sent again under its
// idempotency key (the email service refuses a key with other words), so
// each entry's DTSTAMP is fixed, not the clock: when that shift or that
// booking last changed (changedAt), so a file sent after a move always
// stamps later than the one before it and the calendar takes the new time.
// Without it (no event yet), the first shift's start, as before.
const stampOf = (rows) => new Date(Math.min(...rows.map((s) => new Date(s.starts_at).getTime())));
export const changedAt = async (q, ws, rows) => {
  const ids = [...new Set(rows.flatMap((s) => [s.id, s.assignment_id]).filter(Boolean))];
  if (!ids.length) return rows;
  const at = new Map((await q.query(
    `select entity_id, max(server_ts) as at from events
      where workspace_id = $1 and entity_type in ('shift', 'shift_assignment') and entity_id = any($2::uuid[])
      group by entity_id`,
    [ws, ids],
  )).rows.map((r) => [r.entity_id, new Date(r.at).getTime()]));
  return rows.map((s) => {
    const t = Math.max(at.get(s.id) || 0, at.get(s.assignment_id) || 0);
    return t ? { ...s, changed_at: new Date(t) } : s;
  });
};
export const shiftsAttachment = (rows, { tz, name, filename = 'shifts.ics' }) => ({
  filename,
  content: Buffer.from(icsCalendar({
    name,
    now: stampOf(rows),
    events: rows.map((s) => ({
      ...shiftEvent(s, {
        tz,
        appUrl: shiftAppLink(configuredUrl(), { id: s.id }),
        booking: { arrive_at: s.arrive_at ?? null, leave_at: s.leave_at ?? null },
      }),
      ...(s.changed_at ? { stamp: s.changed_at } : {}),
    })),
  }), 'utf8').toString('base64'),
  content_type: ATTACH_TYPE,
});
