// A tiny HTML builder: html`…${value}…` escapes every value except one
// made by raw() or another html`` (arrays are joined). No templates engine,
// no inline style or script (the CSP allows neither).
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const part = (v) => {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
};
export const html = (strings, ...values) => raw(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ''), ''));

// Numbers with separators (1,204).
export const num = (n) => Number(n || 0).toLocaleString('en-CA');

// Times on the console are the owner's: Vancouver.
const TZ = 'America/Vancouver';
const fmt = (opts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...opts });
const lower = (s) => s.replace(/\b(AM|PM|a\.m\.|p\.m\.)/gi, (m) => (/^a/i.test(m) ? 'am' : 'pm'));
export const clock = (d) => lower(fmt({ hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d)));
export const dayClock = (d) => `${fmt({ month: 'short', day: 'numeric' }).format(new Date(d))}, ${clock(d)}`;
export const ago = (d, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${num(m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${num(h)} h ago`;
  return dayClock(d);
};
