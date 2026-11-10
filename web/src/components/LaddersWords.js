// Ladders — the words a step is shown in. An email or a follow-up stores
// {{first_name}} / {{campaign}} (what the server fills in); every field and
// line on screen shows "[first name]" / "[campaign]" instead, and what's
// typed as those words is stored as the codes underneath. Plain JS (no JSX)
// so the server's tests can check it against the server's own fill-in.
// The words, buttons and the won't-fill-in check: FillWords.js.
import { fillWords } from './FillWords.js';

const words = fillWords([
  { key: 'first_name', word: '[first name]', button: '+ First name', typed: /\[\s*first[\s_-]*name\s*\]/gi, hint: /name/i },
  { key: 'campaign', word: '[campaign]', button: '+ Campaign', typed: /\[\s*campaign\s*\]/gi, hint: /camp/i, rank: 1 },
]);
export const { FILLS, toWords, toCodes, unfilled } = words;

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const waitWords = (s) => plural(Number(s.n) || 0, s.unit === 'hours' ? 'hour' : 'day');

// "Send to a web address": one small message about the person to another
// tool (a Zapier or Make catch hook, a Slack channel, the campaign's own).
export const HOOK_STEP = 'Send to a web address';

// One step as one line: "Wait 1 day", "Email · Thanks, [first name]",
// "Text · Hi [first name], thanks for…" (a long text is cut short).
const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const stepLine = (s) => {
  if (!s) return '';
  if (s.kind === 'wait') return `Wait ${waitWords(s)}`;
  if (s.kind === 'email') return `Email · ${toWords(s.subject)}`;
  if (s.kind === 'text') return `Text · ${short(toWords(s.body).replace(/\s+/g, ' '))}`;
  if (s.kind === 'tag') return `Tag · ${s.tag}`;
  if (s.kind === 'untag') return `Remove tag · ${s.tag}`;
  if (s.kind === 'followup') return `Follow-up · ${toWords(s.text)}`;
  if (s.kind === 'webhook') return `${HOOK_STEP} · ${s.label}`;
  return 'Stop';
};

// Under an email card: who it can reach, and how many said yes so far.
export const emailWho = (n) => `Goes only to people who said yes to email · ${
  Number.isFinite(n) ? `${plural(n, 'person', 'people')} said yes` : '…'}`;

// Under a text card: the texting rules it follows (ext/texting).
export const textWho = 'Inside your texting hours · never to anyone who replied STOP or asked to stop · “Reply STOP to opt out” is added';

// A text must say who it's from: [campaign] or the campaign's name (the
// server checks the same: ladders/shape.js textProblem).
export const textNamesCampaign = (body, campaign) => /\{\{\s*campaign\s*\}\}/i.test(String(body || ''))
  || (Boolean(String(campaign || '').trim()) && String(body || '').toLowerCase().includes(String(campaign).trim().toLowerCase()));

// Under a "Send to a web address" card: where it goes — the site's name
// only, the rest of an address can be a key — and what it never carries
// (the server decides: ladders/webhook.js).
const hostOf = (url) => { try { return new URL(String(url || '')).host; } catch { return ''; } };
export const hookWho = (s) => `${hostOf(s?.url) ? `To ${hostOf(s.url)} · ` : ''}email only if they said yes, mobile never after STOP · no ratings, notes or money`;

// What a "Send to a web address" step still needs before it can be saved,
// or null. The server checks the same and more (where the address points).
export const hookMissing = (s) => {
  const url = String(s?.url || '').trim();
  if (!url) return 'Add the web address';
  if (!/^https:\/\//i.test(url)) return 'The address must start with https://';
  if (!hostOf(url)) return 'That isn’t a web address';
  if (!String(s?.label || '').trim()) return 'Add a label';
  return null;
};

// What one "Send to a web address" log entry says: "Zapier: Sent · 200",
// "Zapier: Failed · 500 after 3 tries" (the answer's number, or why there
// was none).
const HOOK_WHY = {
  timeout: 'no answer', unreachable: 'couldn’t connect', not_found: 'address not found',
  private: 'the address points inside a private network', bad_address: 'the address can’t be used',
};
export const hookLogLine = (e) => {
  const to = e.label || 'Web address';
  const what = e.status || HOOK_WHY[e.why] || 'no answer';
  if (e.result === 'sent') return `${to}: Sent · ${e.status}`;
  if (e.result === 'sending') return `${to}: Sending`;
  if (e.result === 'unsure') return `${to}: Not sure it went`;
  if (e.result === 'skipped') return `${to}: Skipped — do not contact`;
  if (e.reason === 'refused') return `${to}: Not sent — ${what}`;
  if (e.reason === 'will_retry') return `${to}: Didn’t go (${what}) — trying again`;
  return `${to}: Failed · ${what} after ${plural(e.tries || 1, 'try', 'tries')}`;
};
