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
// otherwise tell Surrey volunteers the wrong hour).
export const shiftMessage = (shift, workspaceName, timeZone = DEFAULT_TZ) => {
  const when = new Date(shift.starts_at).toLocaleString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
  });
  const lines = [
    `You're scheduled: ${shift.title}`,
    when + (shift.ends_at ? ` – ${new Date(shift.ends_at).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone })}` : ''),
    shift.location ? `Where: ${shift.location}` : null,
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
