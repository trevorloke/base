// Canvass + field constants — one shared vocabulary for server validation
// and web rendering.
//
// The rating scale is the campaign's own (shared/scale.js: the steps' words
// and the "Voting for?" list come from workspace settings.scale, edited on
// the manager's Rating scale screen). Validate and display through scale.js
// with the campaign's scale.

// in_person: a talk with someone you know, away from their door ("My people").
// left_lit: literature left at a door — a visit, not a conversation; the
// screens offer it at the door only (a phone left_lit is accepted by the enum
// but never offered).
// left_message: a voicemail or a message with whoever answered — the phone's
// "Left lit": a call that reached no one to talk to but left word. Offered on
// the phone only; in a phone bank it finishes the number (nobody gets a
// second voicemail from the next caller).
// mainstreet: met at an event, a bus loop, a market (ext/mainstreet, with the place).
// email: an email exchanged, logged by hand at the desk (they replied, or a
// coordinator wrote from their own mail): Talked, No answer or Refused only.
export const CHANNELS = ['door', 'phone', 'text', 'in_person', 'mainstreet', 'email'];
export const EMAIL_OUTCOMES = ['contacted', 'no_answer', 'refused'];
export const OUTCOMES = ['contacted', 'no_answer', 'refused', 'moved', 'inaccessible', 'left_lit', 'left_message'];

export const SIGN_KINDS = [
  { code: 'billboard', label: 'Billboard (4×8)' },
  { code: 'large',     label: 'Large sign (4×4)' },
  { code: 'lawn',      label: 'Lawn sign' },
  // In a window: the membership form offers lawn, window, 4×4 and 8×4.
  { code: 'window',    label: 'Window sign' },
];
export const SIGN_KIND_CODES = SIGN_KINDS.map((s) => s.code);
export const SIGN_STATUSES = ['requested', 'installed', 'removed'];

export const VOLUNTEER_ROLES = [
  { code: 'driver',              label: 'Driver' },
  { code: 'scrutineer',          label: 'Scrutineer', detail: 'Voting place' },
  // GOTV: carries the strike-off lists from the voting places to the office.
  { code: 'runner',              label: 'Runner' },
  { code: 'poll_greeter',        label: 'Poll greeter', detail: 'Voting place' },
  { code: 'doorknocking',        label: 'Doorknocking' },
  { code: 'mainstreeting',       label: 'Mainstreeting' },
  { code: 'phoning',             label: 'Phoning' },
  { code: 'data_entry',          label: 'Data entry' },
  { code: 'event_hosting',       label: 'Event hosting' },
  { code: 'zone_house_captain',  label: 'Zone house captain' },
  { code: 'highrise_captain',    label: 'Building captain', detail: 'Building (name or address)' },
  { code: 'food',                label: 'Food' },
  { code: 'translation',         label: 'Translation', detail: 'Language' },
  { code: 'burmashave',          label: 'Burmashave' },
  { code: 'community_committee', label: 'Community committee', detail: 'Community (a neighbourhood or group)' },
  { code: 'policy',              label: 'Policy' },
  { code: 'administration',      label: 'Administration' },
  { code: 'candidate_aide',      label: 'Candidate aide' },
  { code: 'social_media',        label: 'Social media team' },
  { code: 'photo_video',         label: 'Photography / videography' },
];
export const VOLUNTEER_ROLE_CODES = VOLUNTEER_ROLES.map((r) => r.code);

export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'x', 'tiktok', 'reddit', 'youtube', 'linkedin', 'bluesky', 'threads', 'other'];

// Tags are free-form; these seed the picker so the vocabulary stays consistent.
// do-not-call: no phone bank, no call through the campaign's number, never
// sent to the dialer — texts, email and the door are untouched.
export const SUGGESTED_TAGS = [
  'media', 'VIP', 'endorser', 'host', 'donor-prospect', 'lapsed',
  'newsletter', 'petition', 'youth', 'senior', 'business',
  'union', 'do-not-call', 'do-not-contact', 'influencer',
];
// Asked not to be phoned — do-not-call, or do-not-contact (no calls, no
// texts, no email): every Call a screen offers checks this first (a number
// that is only shown can still be read; it is never one tap to dial).
// A row with no tags (the crew board, the roster, a shift's page,
// Stewardship) carries the server's no_call instead (lib/reach.js noCallSql).
// A tag counts whatever its capitals, as every send reads it.
const lowTags = (p) => (Array.isArray(p?.tags) ? p.tags.map((t) => String(t).toLowerCase()) : []);
export const noCalls = (p) => p?.no_call === true || lowTags(p).includes('do-not-call') || lowTags(p).includes('do-not-contact');
// What a screen shows where the Call would be: do-not-contact is more than calls.
export const noCallsWord = (p) => (lowTags(p).includes('do-not-contact') ? 'Do not contact' : 'Do not call');

// Donor tiers, derived from real gifts — never self-declared.
// Named tiers are a campaign's own: the server passes its list (the highest
// first, each { key, yearCents, monthlyCents }: so much in the calendar
// year, or so much a month) and this file holds none. With no list a donor
// is 'monthly' or 'one-time'.
export const donorTier = ({ yearCents = 0, monthlyCents = 0 }, tiers = []) => {
  for (const t of tiers) if (yearCents >= t.yearCents || monthlyCents >= t.monthlyCents) return t.key;
  if (monthlyCents > 0) return 'monthly';
  if (yearCents > 0) return 'one-time';
  return null;
};

// The slates a contribution goes to. A contribution is to one slate; the
// annual limit is per contributor per slate (each slate is its own election —
// city council, school board — and LECFA's limit is per jurisdiction; verify
// with Elections BC). A gift that names no slate is to the first one. The
// server reads them from BASE_SLATES ("code:Label,code:Label"); the app
// takes the server's (me.org.slates) and keeps these as the fallback.
export const DEFAULT_SLATES = [
  { code: 'council', label: 'City council' },
  { code: 'school_board', label: 'School board' },
];
export const parseSlates = (text) => {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const [code, ...rest] = part.split(':');
    const c = String(code || '').trim().toLowerCase();
    const label = rest.join(':').trim();
    if (!/^[a-z0-9_]{1,30}$/.test(c) || out.some((x) => x.code === c)) continue;
    out.push({ code: c, label: label || c.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase()) });
  }
  return out.length ? out : null;
};
export const SLATES = parseSlates(globalThis.process?.env?.BASE_SLATES) || DEFAULT_SLATES;
export const SLATE_CODES = SLATES.map((s) => s.code);
export const DEFAULT_SLATE = SLATES[0].code;
export const slateLabel = (code, slates = SLATES) => slates.find((s) => s.code === (code || slates[0]?.code))?.label || String(code);

export const SHIFT_STATUSES = ['assigned', 'confirmed', 'declined', 'no_show', 'completed'];
