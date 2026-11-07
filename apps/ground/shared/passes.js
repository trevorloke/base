// Passes — a sweep over every turf (server/ext/passes). One rule for the
// server's walk lists and turf counts AND for the phone's overlay of knocks
// still in its outbox, so a door reads the same with signal and without.
//
// A pass has a purpose (what for), a universe (who to knock) and a try rule
// (how many not-homes before a door is given up). While one is open, "doors
// left" means doors in the universe not yet finished IN THIS PASS: a "No
// answer" keeps the door on the list ("Try again · 1 of 2") until the tries
// run out; a talk, a refusal, moved or no access finishes it. With no pass
// open a door is done once anyone there was ever knocked — the rule the walk
// lists always had.
//
//   KINDS / WHO               the choices, with their words
//   TERMINAL                  outcomes that finish a door in any pass
//   inUniverse(person, pass)  is this person someone the pass wants knocked
//   inPass(door, pass)        a door is listed when anyone there is in the universe
//   doorState(door, pass)     'open' · 'again' · 'done'
//   passLine(pass)            "Persuasion · All doors · 2 tries"
//
// Each person carries pass_tries (this pass's door contacts that count as
// tries) and pass_last_outcome (their latest door contact in this pass, any
// outcome) — from the server's walk list (routes/api.js loadLocated) or the
// phone's overlay (components/PassBits.jsx overlayPass).
import { bandOf } from './scale.js';

export const KINDS = [
  { code: 'persuasion', label: 'Persuasion', word: 'Talk to voters' },
  { code: 'gotv', label: 'Get out the vote' },
  { code: 'lit', label: 'Lit drop' },
  { code: 'id', label: 'Find out who’s who' },
];
export const WHO = [
  { code: 'all', label: 'All doors' },
  { code: 'unrated', label: 'Not rated yet' },
  { code: 'undecided', label: 'Undecided or not rated' },
  { code: 'support', label: 'Yes (1–2)' },
  { code: 'not_opposed', label: 'Everyone but opposed' },
];
export const KIND_CODES = KINDS.map((k) => k.code);
export const WHO_CODES = WHO.map((w) => w.code);
export const TRIES_MAX = 5;

export const TERMINAL = ['contacted', 'refused', 'moved', 'inaccessible'];
// A lit drop (outcome 'left_lit', from ext/litdrop) is a not-home that left
// something at the door: in a lit-drop pass it finishes the door; in any
// other pass it counts as a try like a No answer, so a door where canvassers
// keep leaving lit is given up when its tries run out.

// voted_at: a column another feature adds; undefined here. Someone who has
// voted is never on a get-out-the-vote list.
export const inUniverse = (person, pass) => {
  if (!pass) return true;
  if (pass.kind === 'gotv' && person.voted_at) return false;
  const band = bandOf(person.rating);
  switch (pass.who) {
    case 'all': return true;
    case 'unrated': return person.rating == null;
    case 'undecided': return person.rating == null || band === 'undecided';
    case 'support': return band === 'support';
    case 'not_opposed': return band !== 'opposed';
    default: return true;
  }
};

export const inPass = (door, pass) => !pass || door.persons.some((p) => inUniverse(p, pass));

// 'done' | 'again' | 'open'. Without a pass: the old rule (anyone knocked).
// With one: nobody visited yet → open; in a lit-drop pass any visit finishes
// the door; a terminal outcome for anyone there finishes it; so does anyone's
// tries running out; otherwise it comes back ('again').
export const doorState = (door, pass) => {
  if (!pass) return door.persons.some((p) => p.door_knocked) ? 'done' : 'open';
  const ps = door.persons;
  const any = ps.some((p) => p.pass_last_outcome != null);
  if (!any) return 'open';
  if (pass.kind === 'lit') return 'done';
  if (ps.some((p) => TERMINAL.includes(p.pass_last_outcome))) return 'done';
  if (ps.some((p) => (p.pass_tries || 0) >= pass.tries)) return 'done';
  return 'again';
};

export const kindLabel = (code) => KINDS.find((k) => k.code === code)?.label || String(code ?? '');
export const whoLabel = (code) => WHO.find((w) => w.code === code)?.label || String(code ?? '');

export const passLine = (pass) => (pass
  ? `${kindLabel(pass.kind)} · ${whoLabel(pass.who)} · ${pass.tries} ${pass.tries === 1 ? 'try' : 'tries'}`
  : 'No pass open');
