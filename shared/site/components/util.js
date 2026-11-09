// Small pure helpers for the website's components: how money and dates
// read, paragraphs, the share links. No React, no DOM, no Node — the server
// renderer, the browser islands and the tests all import this. (Where a
// link goes is links.js, server side.)

export const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
export const arr = (v) => (Array.isArray(v) ? v : []);
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// ── Island props: JSON safe inside <script type="application/json"> ──
export const jsonForScript = (v) => JSON.stringify(v ?? null).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// ── Money (no Intl: the server and the browser must print it the same) ──
export const thousands = (n) => String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function money(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  const c = n % 100;
  return `$${thousands(Math.floor(n / 100))}${c ? `.${String(c).padStart(2, '0')}` : ''}`;
}
// "25", "25.50", "$1,000" → cents, or null.
export function parseDollars(text) {
  const s = str(text).replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// ── Dates (worked out on the server; islands get the words, not the dates) ──
export const DEFAULT_TIME_ZONE = 'America/Vancouver';
const validZone = (tz) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
};
export function when(startIso, endIso, timeZone = DEFAULT_TIME_ZONE) {
  const start = new Date(str(startIso));
  if (!str(startIso) || Number.isNaN(start.getTime())) return null;
  const tz = validZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const f = (o, d = start) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(d);
  const end = endIso ? new Date(str(endIso)) : null;
  const sameDay = end && !Number.isNaN(end.getTime()) && f({ year: 'numeric', month: 'numeric', day: 'numeric' }, end) === f({ year: 'numeric', month: 'numeric', day: 'numeric' });
  const time = sameDay
    ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).formatRange(start, end)
    : f({ hour: 'numeric', minute: '2-digit' });
  return {
    iso: start.toISOString(),
    day: f({ day: 'numeric' }),
    mon: f({ month: 'short' }).replace(/\.$/, ''),
    date: f({ weekday: 'long', month: 'long', day: 'numeric' }),
    short: f({ weekday: 'short', month: 'short', day: 'numeric' }),
    time,
  };
}
export function dateOnly(iso, timeZone = DEFAULT_TIME_ZONE) {
  const d = new Date(str(iso));
  if (!str(iso) || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: validZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

// ── Text ──
// A paragraph field ("textarea"): blank lines make paragraphs.
export const paragraphs = (text) => str(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

// "Ada Example" → "AE"; placeholders such as "[Name to confirm]" get none.
export function initials(name) {
  const n = str(name).trim();
  if (!/^\p{L}[\p{L}'’.-]*(\s+\p{L}[\p{L}'’.-]*)*$/u.test(n)) return '';
  const words = n.split(/\s+/);
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

// ── A form's tracking: the referral code and the share tag ──
// Only ever in the shape the server takes (server/ext/site/forms.js: a code
// of 6–16 letters and digits; a tag of up to 60 of a–z, 0–9 and : _ . -),
// so an odd or long one in a link never stops anyone signing: a tag is cut
// to 60, anything else is left out (a real referral is credited from its
// cookie anyway).
const REF_RE = /^[a-z0-9]{6,16}$/i;
const SOURCE_RE = /^[a-z0-9][a-z0-9:_.-]{0,59}$/i;
export const cleanRef = (v) => { const s = str(v).trim(); return REF_RE.test(s) ? s : ''; };
export const cleanSource = (v) => { const s = str(v).trim().slice(0, 60); return SOURCE_RE.test(s) ? s : ''; };
// What a page's address adds: ?ref= and ?source=, cleaned.
export function trackFrom(search) {
  let q;
  try { q = new URLSearchParams(str(search)); } catch { return { ref: '', source: '' }; }
  return { ref: cleanRef(q.get('ref')), source: cleanSource(q.get('source')) };
}

// ── Sharing ──
// Each channel's link carries ?source=share-<channel>, so a sign-up that
// comes from it is credited to where it was shared. WhatsApp first: it is
// what relational organizing in Surrey runs on.
export const SHARE_CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'sms', label: 'Text' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'x', label: 'X' },
  { key: 'email', label: 'Email' },
  { key: 'copy', label: 'Copy link' },
];
export function withSource(url, source) {
  const [front, hash] = str(url).split('#');
  const [path, query = ''] = front.split('?');
  const kept = query.split('&').filter((p) => p && !/^source=/.test(p));
  if (source) kept.push(`source=${encodeURIComponent(source)}`);
  return `${path}${kept.length ? `?${kept.join('&')}` : ''}${hash !== undefined ? `#${hash}` : ''}`;
}
export function shareLinks({ url, text, subject }) {
  const tagged = (k) => withSource(url, `share-${k}`);
  const msg = (k) => `${str(text)} ${tagged(k)}`.trim();
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(msg('whatsapp'))}`,
    sms: `sms:?&body=${encodeURIComponent(msg('sms'))}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(tagged('facebook'))}`,
    x: `https://x.com/intent/tweet?text=${encodeURIComponent(str(text))}&url=${encodeURIComponent(tagged('x'))}`,
    email: `mailto:?subject=${encodeURIComponent(str(subject || text))}&body=${encodeURIComponent(msg('email'))}`,
    copy: tagged('copy'),
  };
}
