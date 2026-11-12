// What the email senders (resend.js, sendgrid.js) share: the settings, the
// From address, the time limit, and the words for a call that failed.
export const env = (k) => String(process.env[k] || '').trim();
export const has = (k) => Boolean(env(k));
// A setting that takes several values while one is rolled to the next.
export const listOf = (k) => env(k).split(',').map((s) => s.trim()).filter(Boolean);

// One email's time limit (STARBASE_EMAIL_TIMEOUT_MS, 15 s): a sender that
// hasn't answered by then is given up on, so a hung connection never holds a
// send (or anything waiting on it) for long.
export const timeoutMs = () => Number(process.env.STARBASE_EMAIL_TIMEOUT_MS) || 15_000;
// A read for a screen (the domain's records, Check): 8 s, as every Check.
export const READ_MS = 8000;

// A From as typed — "Imagine Surrey <team@imaginesurrey.ca>", a quoted
// name ("Surrey, BC Media" <media@…>) or the address alone — as its name,
// its address and the address's domain.
export const parseFrom = (typed) => {
  const raw = String(typed ?? '').trim();
  const m = /^(.*)<([^<>]+)>$/.exec(raw);
  const email = (m ? m[2] : raw).trim();
  const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
  const domain = (/@([^@\s]+)$/.exec(email)?.[1] || '').toLowerCase().replace(/\.$/, '');
  return { raw, name, email, domain };
};
// MAIL_FROM: the campaign's own From, used by every email that names none.
export const mailFrom = () => parseFrom(env('MAIL_FROM'));

// What a send answers when the sender said no (the next try is a new send)…
export const refused = async (res) => ({
  sent: false, status: 'failed', detail: `email provider ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
});
// …and when it never answered: it may or may not have sent it (unknown).
export const noAnswer = (e) => {
  const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
  return {
    sent: false, status: 'failed', unknown: true,
    detail: timedOut ? `email provider didn't answer in ${Math.round(timeoutMs() / 1000)} s` : String(e?.message || e).slice(0, 200),
  };
};

// A call to a sender's own API (its domains, its webhooks) that failed.
// restricted: the key may only send, so there is nothing to read with it.
// Never a key in the words.
export class MailError extends Error {
  constructor(message, { status = null, restricted = false } = {}) {
    super(message);
    this.name = 'MailError';
    this.httpStatus = status;
    this.restricted = restricted;
  }
}

// One JSON call to a sender's API, 8 s at most. `refusal(res, body)` turns
// an answer that isn't a yes into a MailError in that sender's words.
export const apiCall = async (who, url, { method = 'GET', key, body, refusal }) => {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(READ_MS),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    // Why, when the network says so in a word (ECONNREFUSED, ENOTFOUND) —
    // never fetch's own "fetch failed".
    const code = [e?.cause?.code, e?.cause?.errors?.[0]?.code].find((c) => /^E[A-Z_]+$/.test(String(c || '')));
    throw new MailError(`${who} didn’t answer${timedOut ? ' in 8 s' : code ? ` (${code})` : ''}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw refusal(res, json);
  return json;
};

export const lower = (s) => String(s ?? '').trim().toLowerCase();
// When the sender says it happened, as an ISO time (null when it didn't say).
export const isoOf = (v) => {
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v || ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
