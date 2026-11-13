// What Google said when it refused, in plain words, with the setup step that
// fixes it (GOING-LIVE.md §5, Recipe B). Used by the map's tiles
// (lib/gtiles.js) and Google's address suggestions (lib/places.js).
//
// googleTrouble(httpStatus, body) → { code, plain, said, step }
//   body: Map Tiles' { error: { message, details: [{ reason }] } }, or
//   Geocoding's { status, error_message }, or plain text.
//   said: Google's own words, `key=` values scrubbed, at most 300
//   characters — but a Google Cloud console link in them is always kept
//   whole (an "API not enabled" message ends with the link that fixes it).
//   Shown as plain text, never as HTML.
//
// The ErrorInfo reason decides first, then an HTTP 429, then words in the
// message; the first row that matches wins.
export const TROUBLES = [
  { code: 'key-invalid', reasons: ['API_KEY_INVALID'], words: ['key not valid', 'provided api key is invalid'],
    plain: 'Google doesn’t recognise this key. Copy it again from Google Cloud → Credentials.', step: 'Recipe B step 6' },
  { code: 'referrer', reasons: ['API_KEY_HTTP_REFERRER_BLOCKED'], words: ['referer restrictions', 'requests from referer'],
    plain: 'This key only works from websites. The server needs a key without a website restriction.', step: 'Recipe B step 4' },
  { code: 'ip', reasons: ['API_KEY_IP_ADDRESS_BLOCKED'], words: ['not authorized to use this api key', 'ip address restriction'],
    plain: 'This key doesn’t allow this server’s address. Remove the IP-address restriction.', step: 'Recipe B step 4' },
  { code: 'api-blocked', reasons: ['API_KEY_SERVICE_BLOCKED'], words: ['are blocked'],
    plain: 'This key is limited to other Google services. Add Map Tiles API and Places API (New) to it.', step: 'Recipe B step 4' },
  { code: 'api-off', reasons: ['SERVICE_DISABLED'], words: ['has not been used in project', 'not authorized to use this api', 'is disabled'],
    plain: 'This Google service isn’t turned on for the key’s project. Enable it under APIs & Services.', step: 'Recipe B step 3' },
  { code: 'billing', reasons: ['BILLING_DISABLED'], words: ['billing'],
    plain: 'Billing isn’t turned on for this Google Cloud project.', step: 'Recipe B step 2' },
  { code: 'quota', reasons: ['RESOURCE_EXHAUSTED', 'OVER_QUERY_LIMIT', 'quotaExceeded', 'rateLimitExceeded'], words: ['resource_exhausted', 'over_query_limit', 'quota'],
    plain: 'Google’s usage limit is used up. Raise it in Google Cloud, or wait.', step: 'Recipe B step 5' },
  { code: 'session', reasons: ['expired'], words: ['session'],
    plain: 'The map’s Google session ended. It renews by itself.', step: null },
];

const CONSOLE_LINK = /https?:\/\/console\.(?:cloud|developers)\.google\.com\/[^\s"'<>]*/gi;
const MAX = 300;

// Google's text, at most 300 characters, console links kept whole.
const cut = (text) => {
  if (text.length <= MAX) return text;
  let out = text.slice(0, MAX).trimEnd();
  for (const link of text.match(CONSOLE_LINK) || []) {
    if (!out.includes(link)) {
      // A link the cut broke in two: drop the broken half, keep it whole.
      const broken = out.lastIndexOf(link.slice(0, 20));
      if (broken >= 0) out = out.slice(0, broken).trimEnd();
      out = `${out}… ${link}`;
    }
  }
  return out.includes('…') ? out : `${out}…`;
};

export const scrub = (text) => String(text ?? '').replace(/([?&]?\bkey=)[^&\s"']+/gi, '$1…');

const parse = (body) => {
  if (body && typeof body === 'object') return body;
  try { return JSON.parse(String(body ?? '')); } catch { return { text: String(body ?? '') }; }
};

export const googleTrouble = (status, body) => {
  const b = parse(body);
  const err = b.error && typeof b.error === 'object' ? b.error : null;
  const reasons = (err?.details || []).map((d) => d?.reason).filter(Boolean);
  if (Array.isArray(err?.errors)) reasons.push(...err.errors.map((e) => e?.reason).filter(Boolean));
  if (err?.status) reasons.push(err.status);
  if (b.status && typeof b.status === 'string') reasons.push(b.status);
  const said = cut(scrub(err ? err.message || err.status || ''
    : b.status && typeof b.status === 'string' ? `${b.status}${b.error_message ? `: ${b.error_message}` : ''}`
      : b.text || '').trim());
  const words = said.toLowerCase();
  const row = TROUBLES.find((t) => t.reasons.some((r) => reasons.includes(r)))
    || (Number(status) === 429 ? TROUBLES.find((t) => t.code === 'quota') : null)
    || TROUBLES.find((t) => t.words.some((w) => words.includes(w)));
  if (!row) {
    const what = Number(status) && Number(status) !== 200 ? status : (typeof b.status === 'string' && b.status) || status;
    return { code: 'other', plain: `Google refused (${what}).`, said, step: null };
  }
  let plain = row.plain;
  if (row.code === 'ip') {
    const ip = said.match(/from IP address ([0-9a-f.:]+[0-9a-f])/i) || said.match(/IP address of the call \(([0-9a-f.:]+)\)/i);
    if (ip) plain += ` This server reached Google from ${ip[1]}.`;
  }
  return { code: row.code, plain, said, step: row.step };
};
