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
// A step kind this page has no words for: a colleague added one a newer
// base.win knows, in a tab left open from before it. Said, never guessed at.
export const UNKNOWN_STEP = 'A step this page doesn’t know — reload';
// The step kinds this page has words for, sent with every save of a
// ladder's steps (`knows`). A page that doesn't name a kind is told to
// reload before it saves a Stop over a step of that kind, or takes it away
// (the server: ladders/actions.js misread) — the page from before "Send to
// a web address" showed one as a Stop.
export const KNOWN_STEPS = ['wait', 'email', 'text', 'tag', 'untag', 'followup', 'stop', 'webhook'];

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
  if (s.kind === 'stop') return 'Stop';
  return UNKNOWN_STEP;
};

// A step as it is saved: trimmed, and nothing but its own fields. A kind
// this page doesn't know is handed back exactly as it is — never saved as
// a Stop, which would end the ladder there for everyone after.
export const cleanStep = (s) => {
  if (s.kind === 'wait') return { kind: 'wait', n: Math.max(1, Math.round(Number(s.n))), unit: s.unit };
  if (s.kind === 'email') return { kind: 'email', subject: s.subject.trim(), body: s.body.trim() };
  if (s.kind === 'text') return { kind: 'text', body: s.body.trim() };
  if (s.kind === 'tag' || s.kind === 'untag') return { kind: s.kind, tag: s.tag.trim() };
  if (s.kind === 'followup') return { kind: 'followup', text: s.text.trim() };
  if (s.kind === 'webhook') return { kind: 'webhook', url: s.url.trim(), label: s.label.trim() };
  if (s.kind === 'stop') return { kind: 'stop' };
  return s;
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
// (the server decides: ladders/webhook.js). Whose email and mobile go
// along is said once, under the step's fields.
const hostOf = (url) => { try { return new URL(String(url || '')).host; } catch { return ''; } };
export const hookWho = (s) => (hostOf(s?.url) ? `To ${hostOf(s.url)} · no ratings, notes or money` : 'No ratings, notes or money');

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
// was none). hookSaid is the same without the label: what "Send a test"
// answers.
const HOOK_WHY = {
  timeout: 'no answer', unreachable: 'couldn’t connect', not_found: 'address not found',
  not_answering: 'the address isn’t answering',
  private: 'the address points inside a private network', bad_address: 'the address can’t be used',
};
export const hookSaid = (e) => {
  const what = e.status || HOOK_WHY[e.why] || 'no answer';
  if (e.result === 'sent') return `Sent · ${e.status}`;
  if (e.result === 'sending') return 'Sending';
  // Left alone while it isn't answering: no call made, no try used up.
  if (e.result === 'waiting') return `Waiting — ${HOOK_WHY.not_answering}`;
  if (e.result === 'unsure') return 'Not sure it went';
  if (e.result === 'skipped') return 'Skipped — do not contact';
  if (e.reason === 'redirect') return `Answered with a redirect (${e.status}) — not followed`;
  if (e.reason === 'refused') return `Not sent — ${what}`;
  if (e.reason === 'will_retry') return `Didn’t go (${what}) — trying again`;
  return `Failed · ${what}${e.tries > 1 ? ` after ${plural(e.tries, 'try', 'tries')}` : ''}`;
};
export const hookLogLine = (e) => `${e.label || 'Web address'}: ${hookSaid(e)}`;

// What a finished person's row adds when a web address never got them — it
// didn't take the message (after its tries, or refused), answered with a
// redirect, or wasn't sent to at all (do not contact) — or null.
export const hookRowNote = (log) => {
  const e = (log || []).find((x) => x.kind === 'webhook' && (x.result === 'skipped' || (x.result === 'failed' && x.reason !== 'will_retry')));
  if (!e) return null;
  const to = e.label || 'the web address';
  if (e.result === 'skipped') return `not sent to ${to} (do not contact)`;
  return e.reason === 'redirect' ? `${to} answered with a redirect` : `not sent to ${to}`;
};
