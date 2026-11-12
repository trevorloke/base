// Outbound notifications — email + SMS behind provider-pluggable adapters.
// No SDKs: plain fetch against provider REST APIs, so there are zero new
// dependencies and a missing provider degrades to an honest 'queued' status:
// nothing was sent and nothing sends by itself. The message is kept, and once
// the provider is configured a person sends it — blast.resend ("Send now")
// for newsletters and press, shift.notify again ("Notify again") for shifts.
//
//   Email: a sender from lib/mail — Resend (RESEND_API_KEY, + optional
//          MAIL_FROM) or SendGrid (SENDGRID_API_KEY, MAIL_FROM); MAIL_PROVIDER
//          names one, otherwise whichever has its key
//   SMS:   set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM

import { DEFAULT_TZ } from './org.js';
import { fmtIn } from '@starbase/shared/dayparts';
import { whereWords } from '@starbase/shared/shiftkinds';
import { hoursOf } from '@starbase/shared/shifthours';
// One email through the sender in use, and whether there is one (lib/mail
// says what sendEmail takes and answers).
export { emailConfigured, sendEmail } from './mail/index.js';
export const textConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

export const sendText = async ({ to, body }) => {
  if (!textConfigured()) {
    return { sent: false, status: 'queued', detail: 'no SMS provider configured (set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM)' };
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const form = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body });
    // The same host and time limit as the texting module (ext/texting/twilio.js).
    const base = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
    const res = await fetch(`${base}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      return { sent: false, status: 'failed', detail: `sms provider ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { sent: true, status: 'sent' };
  } catch (e) {
    return { sent: false, status: 'failed', detail: String(e.message).slice(0, 200) };
  }
};

// Shift notification copy: time, place, instructions, link — one message,
// both channels.
// Times render in the campaign's zone, never the server's (a UTC host would
// otherwise tell Surrey volunteers the wrong hour) — on the shared clock
// (shared/dayparts.js), so a server with old time-zone rules says the same
// hour the screens do. A place nobody has named is a map link, never its
// coordinates as words (shared/shiftkinds.js).
// When someone is on a shift, in words — in their own hours when they said
// they can do only part of it (booking: { arrive_at, leave_at }; the shift's
// own span follows in brackets, unless `aside` is false), and "Drop in any
// time" on a drop-in shift:
//   Saturday, November 14 at 4:30 p.m. – 6:00 p.m. (your time; the shift runs 2:00 p.m. – 8:00 p.m.)
//   Drop in any time, Saturday, November 14, 4:00 p.m. – 8:00 p.m.
const LONG = { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const TIME = { hour: 'numeric', minute: '2-digit' };
export const shiftWhen = (shift, booking, tz = DEFAULT_TZ, { aside = true } = {}) => {
  const h = hoursOf(shift, booking);
  const span = (a, b) => fmtIn(a, tz, TIME) + (b ? ` – ${fmtIn(b, tz, TIME)}` : '');
  if (h.part) {
    return `${fmtIn(h.starts_at, tz, LONG)} – ${fmtIn(h.ends_at, tz, TIME)}`
      + (aside ? ` (your time; the shift runs ${span(shift.starts_at, shift.ends_at)})` : '');
  }
  if (shift.drop_in) {
    return `Drop in any time, ${fmtIn(shift.starts_at, tz, { weekday: 'long', month: 'long', day: 'numeric' })}, ${span(shift.starts_at, shift.ends_at)}`;
  }
  return fmtIn(shift.starts_at, tz, LONG) + (shift.ends_at ? ` – ${fmtIn(shift.ends_at, tz, TIME)}` : '');
};

// The same for a text's one short line: their own start ("Sat, Nov 14,
// 4:30 p.m."), or a drop-in shift's hours ("Sat, Nov 14, drop in 4–8 p.m.").
const SHORT = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const clockBits = (at, tz) => {
  const [, h, m, half] = fmtIn(at, tz, TIME).match(/^(\d+)(?::(\d\d))?\s*(.*)$/) || [];
  return { clock: m && m !== '00' ? `${h}:${m}` : h, half };
};
export const shortRange = (from, to, tz = DEFAULT_TZ) => {
  const a = clockBits(from, tz);
  if (!to) return `${a.clock} ${a.half}`;
  const b = clockBits(to, tz);
  return a.half === b.half ? `${a.clock}–${b.clock} ${b.half}` : `${a.clock} ${a.half}–${b.clock} ${b.half}`;
};
export const shiftWhenShort = (shift, booking, tz = DEFAULT_TZ) => {
  const h = hoursOf(shift, booking);
  if (!h.part && shift.drop_in) {
    return `${fmtIn(shift.starts_at, tz, { weekday: 'short', month: 'short', day: 'numeric' })}, drop in ${shortRange(shift.starts_at, shift.ends_at, tz)}`;
  }
  return fmtIn(h.starts_at, tz, SHORT);
};

// A shift.notify message to one person: `booking` their own hours, if any.
// The text (forText) leaves out the shift's span in brackets.
export const shiftMessage = (shift, workspaceName, timeZone = DEFAULT_TZ, booking = null, { forText = false } = {}) => {
  const lines = [
    `You're scheduled: ${shift.title}`,
    shiftWhen(shift, booking, timeZone, { aside: !forText }),

    shift.location ? `Where: ${whereWords(shift.location)}` : null,
    shift.instructions ? `Instructions: ${shift.instructions}` : null,
    shift.link ? `Details: ${shift.link}` : null,
    `— ${workspaceName}`,
  ].filter(Boolean);
  return lines.join('\n');
};

// The mail headers that give a mail app its own Unsubscribe button: one tap
// sends a POST to `url` (RFC 8058). Only for a full https/http address — a
// link without the campaign's address would go nowhere.
export const unsubscribeHeaders = (url) => (/^https?:\/\/[^/]/i.test(String(url || ''))
  ? { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  : undefined);
