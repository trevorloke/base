// What a ladder is made of: the triggers that start one, the steps it runs,
// the goal that takes someone off, the zod contracts for them, and the
// words the screens use for them.
import { z } from 'zod';
import { isWebValue } from '../webdid/words.js';

// What starts a ladder. `ref` narrows one of them: a tag (required); what
// was done on the website (required: a kind — "petition" — or one petition
// or pledge, "campaign:<id>"; ext/webdid/words.js); a survey (optional: any
// survey without one).
//   newsletter      joined the newsletter list
//   donation        their first gift
//   gift            any gift
//   tag             got a tag
//   rating          rated 1 or 2 (door, phone, text)
//   web             a website action (SITE.md: the site_action event)
//   shift_booked    put on a shift, or booked themselves (again after
//                   "Can't make it" or a no-show counts)
//   shift_attended  checked in on a shift ("Here")
//   shift_no_show   marked a no-show
//   member          a membership: joined or renewed (paper or online)
//   survey          answered a survey's question at the door or on a call
export const TRIGGERS = {
  newsletter: { label: 'Joined the newsletter' },
  donation:   { label: 'First donation' },
  gift:       { label: 'Gave (any gift)' },
  tag:        { label: 'Got a tag', ref: 'tag', refRequired: true },
  rating:     { label: 'Rated 1 or 2' },
  web:        { label: 'Did something on the website', ref: 'web', refRequired: true },
  shift_booked: { label: 'Booked a shift' },
  shift_attended: { label: 'Came to a shift' },
  shift_no_show: { label: 'Didn’t show up for a shift' },
  member:     { label: 'Became a member (or renewed)' },
  survey:     { label: 'Answered a survey', ref: 'survey' },
};
export const TRIGGER_KINDS = Object.keys(TRIGGERS);

// A goal: the thing the ladder is for. As soon as the person does it, they
// come off the ladder ("Reached the goal") — whatever step they're on, the
// ladder on or off. Someone who has already voted is never put on a ladder
// whose goal is voting; the others count from when they were put on it.
export const GOALS = {
  shift_attended: { label: 'Came to a shift' },
  gift: { label: 'Gave' },
  member: { label: 'Became a member' },
  voted: { label: 'Voted' },
};
export const GOAL_KINDS = Object.keys(GOALS);

// What a step does. Waits are in hours or days; emails and texts carry
// {{first_name}} and {{campaign}}; a follow-up is a task for staff. A text
// goes through the campaign's texting (ext/texting): inside its hours,
// never to a number that replied STOP, "Reply STOP to opt out" on each.
export const STEP_KINDS = ['wait', 'email', 'text', 'tag', 'untag', 'followup', 'stop'];
export const MAX_STEPS = 20;
export const WAIT_UNITS = { hours: 3600_000, days: 86_400_000 };
// A text's own words; the opt-out line is added after them, inside the
// texting module's 1,000.
export const TEXT_MAX = 900;

const tagName = z.string().trim().min(1).max(40);
export const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), n: z.number().int().min(1).max(365), unit: z.enum(['hours', 'days']) }),
  z.object({
    kind: z.literal('email'),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
  }),
  z.object({ kind: z.literal('text'), body: z.string().trim().min(1).max(TEXT_MAX) }),
  z.object({ kind: z.literal('tag'), tag: tagName }),
  z.object({ kind: z.literal('untag'), tag: tagName }),
  z.object({ kind: z.literal('followup'), text: z.string().trim().min(1).max(300) }),
  z.object({ kind: z.literal('stop') }),
]);
export const stepsSchema = z.array(stepSchema).max(MAX_STEPS);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const triggerSchema = z.object({
  kind: z.enum(TRIGGER_KINDS),
  ref: z.string().trim().max(120).nullish(),
}).superRefine((t, ctx) => {
  const need = { tag: 'pick a tag', web: 'pick what they did on the website' };
  if (TRIGGERS[t.kind].refRequired && !t.ref) ctx.addIssue({ code: 'custom', message: need[t.kind] || 'pick one', path: ['ref'] });
  if (t.kind === 'web' && t.ref && !isWebValue(t.ref)) ctx.addIssue({ code: 'custom', message: 'not something done on the website', path: ['ref'] });
  if (t.kind === 'survey' && t.ref && !UUID_RE.test(t.ref)) ctx.addIssue({ code: 'custom', message: 'not a survey', path: ['ref'] });
});
export const goalSchema = z.enum(GOAL_KINDS);

export const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

export const tagsOf = (p) => {
  const t = parseJson(p?.tags, []);
  return Array.isArray(t) ? t.map(String) : [];
};
export const sameTag = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
export const DNC_TAG = 'do-not-contact';
export const isDnc = (p) => tagsOf(p).some((t) => sameTag(t, DNC_TAG));
// A ladder email's unsubscribe from someone who was never on the newsletter
// list: no list row is made for them, the person is flagged instead.
export const NO_EMAIL_TAG = 'do-not-email';
export const noEmail = (p) => tagsOf(p).some((t) => sameTag(t, NO_EMAIL_TAG));
// A number that replied STOP is tagged so (ext/texting); the desk can too.
export const NO_TEXT_TAG = 'do-not-text';
export const noText = (p) => tagsOf(p).some((t) => sameTag(t, NO_TEXT_TAG));

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

// {{first_name}} and {{campaign}}, spaces inside the braces allowed.
export const fillIn = (text, { person, campaign }) => String(text || '')
  .replace(/\{\{\s*first_name\s*\}\}/gi, firstName(person?.name))
  .replace(/\{\{\s*campaign\s*\}\}/gi, campaign || '');

export const waitMs = (s) => (Number(s.n) || 0) * (WAIT_UNITS[s.unit] || WAIT_UNITS.days);

// A text must say who it's from (the texting module's first-text rule, on
// every automatic text): the campaign's name, or {{campaign}}. Anything in
// {{…}} other than first_name and campaign would go out as typed. The
// reason it can't be saved, or null.
const namesIt = (body, campaign) => /\{\{\s*campaign\s*\}\}/i.test(body)
  || (String(campaign || '').trim() && String(body).toLowerCase().includes(String(campaign).trim().toLowerCase()));
export const textProblem = (body, campaign) => {
  if (/\{\{[^}]*\}\}/.test(fillIn(body, { person: { name: 'Sam' }, campaign: campaign || 'x' }))) {
    return 'only [first name] and [campaign] fill in';
  }
  if (!namesIt(body, campaign)) return `say it's ${campaign || 'the campaign'} in the text`;
  return null;
};

// Hard rules for a ladder that is about to run: at least one step that does
// something (a ladder of nothing but waits would just hold people).
export const runnable = (steps) => steps.some((s) => s.kind !== 'wait' && s.kind !== 'stop');
