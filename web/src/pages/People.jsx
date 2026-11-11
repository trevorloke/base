// People — search, one Filter sheet, and the list (rows on phones, a compact
// table on desks). Calls (mode="calls", the /calls tab): one person at a
// time — Call or Text, then one tap logs the answer and the next person comes
// up. Filters live in the URL (?q=&tag=&rating=&role=&has=) so any list is
// shareable; People's "More" opens the same filters as a call or text list.
// Rating filters are bands (?rating=1,2 · 3 · 4,4D,… · unrated) or one code
// (?rating=4B, "Voting for…"); the server takes the same value. The bands and
// "Voting for…" come from the campaign's scale (those off the list too).
// People is a desk screen: volunteers' /people opens Calls.
// Shared widgets + helpers are exported from here for Person.jsx.
// Ratings always render with the shared RatingChip / ratingSay words.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams, useLocation, Link, Navigate, useOutletContext } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { VOLUNTEER_ROLES, SUGGESTED_TAGS } from '@starbase/shared/canvass';
import { bandOf, codesInBand, offTail, ratingByCode } from '@starbase/shared/scale';
import RatingButtons, { RatingChip, ratingSay, ratingText, useScale } from '../components/RatingButtons.jsx';
import { queueAction } from '../offline.js';
import SurveyQuestions, { answersSaid, answersTail, useSurvey } from '../components/SurveyQuestions.jsx';
import { queuedText } from '../components/queued.js';
import { phoneCopy, showingCopy, useKeepCopy } from '../components/OfflineCache.js';
import { ApiError, apiGet, action, noAnswer } from '../api.js';
import { noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import { keptCopy, keptPartial } from '../components/KeptCopies.js';
import { FieldFilterChip, FieldFilterGroups } from '../components/FieldsBits.jsx';
import QuickDetails from '../components/QuickDetails.jsx';
import './people.css';
import {
  TextingCallButton, TextingRepliesLink, noTexts, textingOn, useTextingStatus, useTextQueue, useTextingPerson,
} from '../components/TextingCard.jsx';
import { MyPeopleLink } from '../components/RelationshipsBits.jsx';
import { VotedRow } from '../components/Voted.jsx';
import AddressField, { lookupAddress } from '../components/AddressField.jsx';
import { CUT_KEYS, CutGroups, addCuts, cutChips, useTurfs, useWebDid } from '../components/FieldCuts.jsx';
import ScriptLine, { useScripts } from '../components/ScriptLine.jsx';
import NameFields from '../components/NameFields.jsx';
import {
  LOADING, RULE_KEYS, RuleGroups, SnapshotForm, Unavailable, fmt, ruleChips, rulesPicked, useAudienceChoices, useListNames,
} from '../components/AudienceBits.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Shared widgets + helpers (also used by Person.jsx)
// ─────────────────────────────────────────────────────────────────────────────

// person.create / person.update / volunteer.* / gift.* are desk-only on the
// server (403 for volunteers); contact.log, person.locate, sign.* are open.
export const DESK_ROLES = ['manager', 'treasurer', 'staff'];
export const canDesk = (me) => DESK_ROLES.includes(me?.role);

// Every query that shows person-derived data on another screen. Prefixes:
// ['person'] is every profile (households list housemates' names + ratings,
// and Money/Map/Signs share the same key), ['persons'] every list, search and
// picker, ['doors'] the map pins + unlocated count, ['signs'] the sign board,
// ['contacts'] the contact feed, ['brief'] Today, ['blasts'] the Outreach
// press audience (media-tagged people with an email), ['shift'] shift detail
// assignee names/phones. Only mounted queries refetch; the rest go stale.
export const PERSON_KEYS = ['person', 'persons', 'doors', 'signs', 'contacts', 'brief', 'blasts', 'shift'];
export const invalidatePersonData = (queryClient) =>
  Promise.all(PERSON_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));

// Server: tags = z.array(z.string().trim().min(1).max(40)).max(50)
export const TAG_MAX_LEN = 40;
export const TAG_MAX_COUNT = 50;

// Drop any extension ("604-555-0101 ext 2", "x2", "#2") before stripping to
// digits, or it gets glued onto the number and dials the wrong line.
const dialable = (phone) => String(phone || '').replace(/\s*(?:ext\.?|x|#).*$/i, '').replace(/[^\d+]/g, '');
export const telHref = (phone) => `tel:${dialable(phone)}`;
export const smsHref = (phone, body) => `sms:${dialable(phone)}${body ? `?&body=${encodeURIComponent(body)}` : ''}`;

export const fmtWhen = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
export const fmtDay = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
};
// One-line facts: "Oct 19" this year, "Oct 19, 2025" before.
export const fmtShort = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-CA', thisYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
};

// Tags read as words: "donor-prospect" → "Donor prospect", "media" → "Media";
// all-caps tags ("VIP") stay. Display only — the stored tag never changes.
export const tagWord = (t) => {
  const s = String(t ?? '').trim();
  if (!s || s === s.toUpperCase()) return s;
  const w = s.replace(/[-_]+/g, ' ').replace(/\s*:\s*/g, ': ').replace(/\s+/g, ' ').trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

// A past rating in words, the same words as the buttons: "Lean yes",
// "Undecided", "Opposed", "Opposed · Locke" (the campaign's scale).
export const ratingLine = (scale, code) => {
  const r = ratingByCode(scale, code);
  if (!r) return '';
  return r.band === 'opposed' && r.code !== '4' ? `${scale.steps[3].word} · ${r.name}${offTail(r)}` : r.word;
};

// A rating where there's room for its meaning: the chip plus the button's
// word in small text — "1 Strong yes", "3 Undecided". "4 · Locke" already
// says who, so it stays a chip.
export function RatingTag({ code }) {
  const scale = useScale();
  const r = ratingByCode(scale, code);
  if (!r) return null;
  const named = r.band === 'opposed' && r.code !== '4';
  return (
    <span className="pp-rtag">
      <RatingChip code={code} who />
      {!named && <span className="pp-rtag__word" aria-hidden="true">{ratingSay(scale, code)}</span>}
    </span>
  );
}

// No signal and nothing cached (components/NoSignal.jsx; Person, Inbox and
// a thread read it from here too).
export { noSignal };

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
export const isDnc = (p) => Array.isArray(p?.tags) && p.tags.includes('do-not-contact');
export const streetLine = (p) => [p.unit ? `${p.unit} –` : null, p.address].filter(Boolean).join(' ');
// The opening line of a text: "Hi Aisha, it's Trevor with Imagine Surrey."
export const textBody = (p, me) =>
  `Hi ${firstName(p.name)}, it's ${firstName(me?.user?.name)} with ${me?.workspace?.name || 'the campaign'}.`;

// Phones get rows, desks get the table. Same breakpoint as the tab bar.
const PHONE_MQ = '(max-width: 720px)';
const subscribeMq = (cb) => {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const m = window.matchMedia(PHONE_MQ);
  m.addEventListener?.('change', cb);
  return () => m.removeEventListener?.('change', cb);
};
const readMq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_MQ).matches : false);
export const useIsPhone = () => useSyncExternalStore(subscribeMq, readMq, () => false);

// Line icons (24×24, stroke = currentColor).
const ICONS = {
  phone: <path d="M6.5 3.5h3l1.6 4.3-2.1 1.4a10.5 10.5 0 0 0 5.8 5.8l1.4-2.1 4.3 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.6a2 2 0 0 1 2-2.1z" />,
  text: <path d="M4 5h16v11H10l-5 4v-4H4z" />,
  email: <><rect x="3.5" y="5.5" width="17" height="13" rx="1.5" /><path d="m4 7 8 6 8-6" /></>,
  map: <><path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
  filter: <path d="M4 7h16M7 12h10M10 17h4" />,
  more: <><circle cx="5.5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18.5" cy="12" r="1.4" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  next: <path d="M5 12h13M13 6l6 6-6 6" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 15v4.5h16V15" /></>,
};
export function Icon({ name, size = 20 }) {
  return (
    <svg className="pp-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

// Run an action with busy/error state; `onDone` gets the result (invalidate here).
// meta: { who } names a knock in the shell's "saved on this phone" list.
// needsSignal: these controls write straight to the server, so with no
// signal they're off (busy) and say "Needs signal".
// Knocks and a profile's tags always go through the offline outbox (saved,
// sent once).
const OUTBOX = ['contact.log', 'person.tag', 'person.details'];
export function useAction(onDone, { needsSignal = false } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const online = useOnline();
  const off = needsSignal && !online;
  const run = async (name, input, meta) => {
    setBusy(true);
    setError(null);
    try {
      const res = OUTBOX.includes(name) ? await queueAction(name, input, meta) : await action(name, input);
      await onDone?.(res, name, input);
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy: busy || off, error: error || (off ? 'Needs signal' : null), clearError: () => setError(null) };
}

// Tag chips with × remove, a type-to-add input (Enter / comma), and suggested chips.
// One onChange per commit (a pasted "a, b" is one save, not two racing ones),
// enforcing the server's 40-char / 50-tag limits client-side.
export function TagEditor({ tags = [], onChange, suggestions = SUGGESTED_TAGS, autoFocus, disabled, inputId }) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState(null);
  const inputRef = useRef(null);
  const refocus = useRef(false);
  // Person.jsx saves on every change and disables the input meanwhile, which
  // drops focus; put it back so you can keep typing tags.
  useEffect(() => {
    if (!disabled && refocus.current) {
      refocus.current = false;
      inputRef.current?.focus();
    }
  }, [disabled]);

  // Returns the pieces that could not be added (kept in the draft to fix).
  const addAll = (pieces) => {
    const next = [...tags];
    const rejected = [];
    let msg = null;
    for (const piece of pieces) {
      const clean = String(piece || '').trim();
      if (!clean || next.includes(clean)) continue;
      if (clean.length > TAG_MAX_LEN) { rejected.push(clean); msg = `Tags are ${TAG_MAX_LEN} characters max.`; continue; }
      if (next.length >= TAG_MAX_COUNT) { rejected.push(clean); msg = `${TAG_MAX_COUNT} tags max.`; continue; }
      next.push(clean);
    }
    setNote(msg);
    if (next.length !== tags.length) onChange(next);
    return rejected;
  };
  const add = (t) => addAll([t]);
  const remove = (t) => { setNote(null); onChange(tags.filter((x) => x !== t)); };
  const commitDraft = (keepFocus) => {
    const rejected = addAll(draft.split(','));
    setDraft(rejected.join(', '));
    if (keepFocus) refocus.current = true;
  };
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitDraft(true); }
    else if (e.key === 'Backspace' && !draft && tags.length) { refocus.current = true; remove(tags[tags.length - 1]); }
  };
  const left = suggestions.filter((s) => !tags.includes(s));
  return (
    <div className="tag-editor">
      {tags.length > 0 && (
        <div className="row">
          <span className="tag-chips">
            {tags.map((t) => (
              <span key={t} className="chip removable" title={t}>
                {tagWord(t)}
                <button type="button" className="chip-x" aria-label={`Remove tag ${tagWord(t)}`} disabled={disabled} onClick={() => remove(t)}>×</button>
              </span>
            ))}
          </span>
        </div>
      )}
      <div className="row">
        <input
          ref={inputRef}
          id={inputId}
          className="input"
          placeholder="Add a tag"
          value={draft}
          autoFocus={autoFocus}
          disabled={disabled}
          enterKeyHint="done"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && commitDraft(false)}
          aria-label="Add a tag"
        />
        {note && <span className="hint" role="status">{note}</span>}
      </div>
      {left.length > 0 && (
        <div className="row">
          {left.map((s) => (
            <button key={s} type="button" className="chip-btn" disabled={disabled} onClick={() => add(s)}>+ {tagWord(s)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TagChips({ tags }) {
  if (!tags || tags.length === 0) return <span className="muted">—</span>;
  return (
    <span className="tag-chips">
      {tags.map((t) => <span key={t} className="chip">{tagWord(t)}</span>)}
    </span>
  );
}

// A disclosure panel that closes on Escape, an outside tap, or a new screen.
function useDismiss(open, setOpen, wrapRef, btnRef) {
  const location = useLocation();
  useEffect(() => { setOpen(false); }, [location.pathname, location.search, setOpen]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen, wrapRef, btnRef]);
}

// "More" menu: a quiet button and a short list of links.
export function MoreMenu({ items, label = 'More' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const firstRef = useRef(null);
  useDismiss(open, setOpen, wrapRef, btnRef);
  useEffect(() => { if (open) firstRef.current?.focus(); }, [open]);
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="pp-menu" ref={wrapRef}>
      <button type="button" ref={btnRef} className="btn pp-btn" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((v) => !v)}>
        <Icon name="more" /> {label}
      </button>
      {open && (
        <div className="pp-menu__panel" id={id}>
          {shown.map((it, i) => (
            <Link key={it.to} ref={i === 0 ? firstRef : undefined} className="pp-menu__item" to={it.to} state={it.state}>
              {it.icon && <Icon name={it.icon} />}
              {it.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters: read from / write to the URL
// ─────────────────────────────────────────────────────────────────────────────
const HAS_LABEL = { phone: 'Has phone', email: 'Has email', location: 'On map', instagram: 'Has Instagram', x: 'Has X', tiktok: 'Has TikTok', reddit: 'Has Reddit' };
// field: <field id>:<value> (profile fields); the field cuts (FieldCuts.jsx);
// what they gave, joined, answered and came to, another list, added since
// (AudienceBits.jsx RULE_KEYS — the desk's: for a volunteer they match nobody).
const FILTER_KEYS = ['q', 'tag', 'rating', 'role', 'field', ...CUT_KEYS, ...RULE_KEYS];
const MORE_KEYS = [...CUT_KEYS, ...RULE_KEYS];
const addRules = (qs, f) => { for (const k of RULE_KEYS) if (f[k]) qs.set(k, f[k]); return qs; };
// The server didn't answer (no signal, or it's down behind its proxy) —
// not the same as an answer that says something went wrong.
const noReply = (err) => !(err instanceof ApiError) || [0, 502, 503, 504].includes(err.status);
const noSignalNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// Rating filter: three bands + Unrated on the first look; who an opposed
// voter backs ("Voting for…") under More. The value goes to the server as is.
// A band is every code of the campaign's scale in it, those off the list too.
const BAND_LABEL = { support: 'Support', undecided: 'Undecided', opposed: 'Opposed' };
export const ratingBands = (scale) => [
  ...Object.entries(BAND_LABEL).map(([band, label]) => ({ value: codesInBand(scale, band).join(','), label, band })),
  { value: 'unrated', label: 'Unrated', band: 'none' },
];
// A comma list of one band's codes (an older link of a band, say) is that band.
const bandOfList = (v) => {
  const codes = String(v || '').split(',');
  if (v === 'unrated') return 'none';
  const b = bandOf(codes[0]);
  return b && codes.every((c) => bandOf(c) === b) ? b : null;
};
// The band a rating filter stands for — or null for one code ("Voting for
// Locke", "Rated 2 · Lean yes").
const filterBand = (scale, v) => ratingBands(scale).find((b) => b.value === v)?.band || (/,|^unrated$/.test(v) ? bandOfList(v) : null);
// What the server (or the kept list) is asked: a band is every code in it
// NOW — an older link of the band (a bookmark, the way back from a profile,
// the Call list carried from it) still reaches a candidate added since.
const ratingQuery = (scale, v) => {
  const band = v ? filterBand(scale, v) : null;
  return band && band !== 'none' ? codesInBand(scale, band).join(',') : v;
};
// "Support", "Voting for Locke", "Rated 2 · Lean yes" (an old one-code link).
const ratingFilterLabel = (scale, v) => {
  const band = filterBand(scale, v);
  if (band) return BAND_LABEL[band] || 'Unrated';
  const r = ratingByCode(scale, v);
  if (r?.name) return `Voting for ${r.name}${offTail(r)}`;
  return r ? `Rated ${v} · ${r.word}` : v;
};
const ratingFilterBand = (v) => bandOfList(v) || 'none';

function useFilters() {
  const [params, setParams] = useSearchParams();
  const f = {
    q: params.get('q') || '',
    tag: params.get('tag') || '',
    rating: params.get('rating') || '',
    role: params.get('role') || '',
    has: params.get('has') || '',
    field: params.get('field') || '',
    ...Object.fromEntries(MORE_KEYS.map((k) => [k, params.get(k) || ''])),
  };
  // Patch the URL in place; empty values drop the key.
  const update = (patch, { replace = true } = {}) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '' || v === false) next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace });
  };
  return { params, f, update };
}

// The same filters, carried to another screen (People → Calls).
const carry = (f, extra = {}) => {
  const out = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k]) out.set(k, f[k]);
  for (const [k, v] of Object.entries(extra)) if (v) out.set(k, v);
  const s = out.toString();
  return s ? `?${s}` : '';
};

// Active filters as removable chips (search lives in its own box). The
// desk's lists and survey questions name their chips; a volunteer's Calls
// never asks for them.
function FilterChips({ f, update, keys = ['rating', 'tag', 'role', 'has'], extra = null, desk = true }) {
  const scale = useScale();
  const turfs = useTurfs();
  const web = useWebDid();
  const asked = desk && RULE_KEYS.some((k) => f[k]);
  const lists = useListNames(asked && Boolean(f.list || f.notlist)).data?.lists;
  const choices = useAudienceChoices(asked && Boolean(f.answer)).data;
  const roleLabel = VOLUNTEER_ROLES.find((r) => r.code === f.role)?.label || f.role;
  const chips = [
    keys.includes('rating') && f.rating && {
      key: 'rating',
      label: <><span className="pp-dot" data-band={ratingFilterBand(f.rating)} aria-hidden="true" />{ratingFilterLabel(scale, f.rating)}</>,
      name: ratingFilterLabel(scale, f.rating),
    },
    keys.includes('tag') && f.tag && { key: 'tag', label: tagWord(f.tag), name: `tag ${tagWord(f.tag)}` },
    keys.includes('role') && f.role && { key: 'role', label: roleLabel, name: roleLabel },
    keys.includes('has') && f.has && HAS_LABEL[f.has] && { key: 'has', label: HAS_LABEL[f.has], name: HAS_LABEL[f.has] },
    keys.includes('q') && f.q && { key: 'q', label: `“${f.q}”`, name: `search ${f.q}` },
    ...cutChips(f, turfs, web).map((c) => ({ ...c, name: c.label })),
    ...ruleChips(f, lists, choices).map((c) => ({ ...c, name: c.label })),
  ].filter(Boolean);
  if (!chips.length && !extra) return null;
  return (
    <div className="pp-chips" aria-label="Filters">
      {chips.map((c) => (
        <button key={c.key} type="button" className="pp-fchip" aria-label={`Remove filter: ${c.name}`}
          onClick={() => update({ [c.key]: null })}>
          {c.label}<Icon name="x" size={14} />
        </button>
      ))}
      {extra}
    </div>
  );
}

function FilterSheet({ f, update, tagOptions, onClose, phone }) {
  const scale = useScale();
  const turfs = useTurfs();
  // "Voting for…": the list's candidates, then anyone taken off it.
  const who = [...scale.candidates.filter((c) => !c.off), ...scale.candidates.filter((c) => c.off)];
  const titleId = useId();
  const titleRef = useRef(null);
  const sheetRef = useRef(null);
  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      // On phones the sheet is modal: Tab cycles inside it.
      if (e.key !== 'Tab' || !phone || !sheetRef.current) return;
      const els = [...sheetRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')];
      if (!els.length) return;
      const firstEl = els[0];
      const lastEl = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === titleRef.current)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, phone]);
  const anyPicked = Boolean(f.rating || f.tag || f.role || f.has || f.field || MORE_KEYS.some((k) => f[k]));
  // Who they vote for and volunteer roles are the long lists: one tap away,
  // open if one is picked. Tags in use sit on the first level.
  const whoPicked = who.some((c) => c.code === f.rating);
  const cutsPicked = CUT_KEYS.filter((k) => f[k]).length + rulesPicked(f);
  const [moreOpen, setMoreOpen] = useState(Boolean(f.role || whoPicked || f.field || cutsPicked));
  const morePicked = [whoPicked, f.role, f.field].filter(Boolean).length + cutsPicked;
  const moreId = useId();
  // on: a band's chip is on for an older link of that band too.
  const chip = (key, value, label, band, on = f[key] === value) => (
    <button key={value} type="button" className={`chip-btn pp-pick${on ? ' on' : ''}`}
      aria-pressed={on} onClick={() => update({ [key]: on ? null : value })}>
      {band && <span className="pp-dot" data-band={band} aria-hidden="true" />}
      {label}
    </button>
  );
  const pickedBand = f.rating ? filterBand(scale, f.rating) : null;
  return (
    <>
      {phone && <div className="pp-scrim" onClick={onClose} aria-hidden="true" />}
      <section ref={sheetRef} className={`pp-sheet${phone ? ' is-phone' : ''}`} role="dialog" aria-modal={phone || undefined} aria-labelledby={titleId}>
        <div className="pp-sheet__head">
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>Filter</h2>
          {anyPicked && (
            <button type="button" className="btn btn-quiet pp-btn"
              onClick={() => update({ rating: null, tag: null, role: null, has: null, field: null, ...Object.fromEntries(MORE_KEYS.map((k) => [k, null])) })}>
              Clear
            </button>
          )}
          <button type="button" className="btn pp-btn" onClick={onClose}>Done</button>
        </div>
        <div className="pp-sheet__body">
          <fieldset className="pp-group">
            <legend className="eyebrow">Rating</legend>
            <div className="pp-group__opts">
              {ratingBands(scale).map((b) => chip('rating', b.value, b.label, b.band, pickedBand === b.band))}
            </div>
          </fieldset>
          <fieldset className="pp-group">
            <legend className="eyebrow">Has</legend>
            <div className="pp-group__opts">
              {chip('has', 'phone', 'Phone')}
              {chip('has', 'email', 'Email')}
              {chip('has', 'location', 'Map pin')}
              {chip('has', 'instagram', 'Instagram')}
              {chip('has', 'x', 'X')}
              {chip('has', 'tiktok', 'TikTok')}
              {chip('has', 'reddit', 'Reddit')}
            </div>
          </fieldset>
          {tagOptions.length > 0 && (
            <fieldset className="pp-group">
              <legend className="eyebrow">Tag</legend>
              <div className="pp-group__opts">{tagOptions.map((t) => chip('tag', t, tagWord(t)))}</div>
            </fieldset>
          )}
          <button type="button" className="pp-morefilters disclose disclose--inline" aria-expanded={moreOpen} aria-controls={moreId}
            onClick={() => setMoreOpen((v) => !v)}>
            More filters
            {!moreOpen && morePicked ? <span className="pp-badge">{morePicked}</span> : null}
          </button>
          {moreOpen && (
            <div className="pp-sheet__more" id={moreId}>
              <fieldset className="pp-group">
                <legend className="eyebrow">Voting for…</legend>
                <div className="pp-group__opts">{who.map((c) => chip('rating', c.code, `${c.name}${offTail(c)}`, 'opposed'))}</div>
              </fieldset>
              <fieldset className="pp-group">
                <legend className="eyebrow">Volunteer role</legend>
                <div className="pp-group__opts">{VOLUNTEER_ROLES.map((r) => chip('role', r.code, r.label))}</div>
              </fieldset>
              <FieldFilterGroups chip={chip} />
              <CutGroups chip={chip} f={f} update={update} turfs={turfs} />
              <RuleGroups chip={chip} f={f} update={update} />
            </div>
          )}
        </div>
      </section>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add person (inline, ?new=1)
// ─────────────────────────────────────────────────────────────────────────────
const emptyPerson = (me) => ({ name: '', first: '', middle: '', last: '', kind: 'person', email: '', phone: '', address: '', unit: '', city: me?.org?.city || 'Surrey', postal: '' });

function AddPersonForm({ onClose, me }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState(() => emptyPerson(me));
  const [pin, setPin] = useState(null); // { lat, lng } from a picked address
  const [tags, setTags] = useState([]);
  const [more, setMore] = useState(false);
  const act = useAction(undefined, { needsSignal: true });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const opt = (v) => (v && v.trim() ? v.trim() : undefined);

  const submit = async (e) => {
    e.preventDefault();
    const isOrg = form.kind === 'org';
    const whole = isOrg ? form.name.trim() : [form.first, form.middle, form.last].map((x) => x.trim()).filter(Boolean).join(' ');
    if (!whole) return;
    // A typed address nobody picked: the first door that matches it, if the
    // service knows it (the server looks again when it can't).
    let at = pin;
    let { city, postal } = form;
    if (!at && form.address.trim()) {
      const found = await lookupAddress(form.address);
      if (found) { at = { lat: found.lat, lng: found.lng }; city = found.city || city; postal = postal || found.postal || ''; }
    }
    const res = await act.run('person.create', {
      name: whole,
      ...(isOrg ? {} : { first_name: form.first.trim() || undefined, middle_name: form.middle.trim() || undefined, last_name: form.last.trim() || undefined }),
      kind: form.kind,
      email: opt(form.email),
      phone: opt(form.phone),
      address: opt(form.address),
      unit: opt(form.unit),
      city: opt(city),
      postal: opt(postal),
      ...(at ? { lat: at.lat, lng: at.lng } : {}),
      tags,
    });
    if (!res?.person?.id) return;
    // A new address bumps the map's unlocated count and joins a household; a
    // media tag + email joins the press audience.
    invalidatePersonData(queryClient);
    navigate(`/people/${res.person.id}`);
  };

  return (
    <form className="card inline-form pp-add" onSubmit={submit}>
      <h2>Add person</h2>
      {form.kind === 'org' ? (
        <div className="field">
          <label htmlFor="np-name">Name</label>
          <input id="np-name" className="input" required autoFocus maxLength={300} value={form.name} onChange={set('name')} />
        </div>
      ) : (
        <NameFields id="np" form={form} setForm={setForm} autoFocus />
      )}
      <div className="form-row">
        <div className="field">
          <label htmlFor="np-phone">Phone</label>
          <input id="np-phone" className="input mono" type="tel" inputMode="tel" maxLength={40} value={form.phone} onChange={set('phone')} />
        </div>
        <div className="field">
          <label htmlFor="np-email">Email</label>
          <input id="np-email" className="input" type="email" maxLength={320} value={form.email} onChange={set('email')} />
        </div>
      </div>
      <AddressField id="np-address" value={form.address} placed={Boolean(pin)}
        onChange={(v) => { setForm((f) => ({ ...f, address: v })); setPin(null); }}
        onPick={(a) => { setForm((f) => ({ ...f, address: a.address, unit: a.unit || f.unit, city: a.city || f.city, postal: a.postal || f.postal })); setPin({ lat: a.lat, lng: a.lng }); }}
        hint={form.address.trim() ? 'Found on the map when you save' : null} />
      <button type="button" className="pp-moredetails disclose disclose--inline" aria-expanded={more} onClick={() => setMore((v) => !v)}>
        More details
      </button>
      {more && (
        <>
          <div className="form-row">
            <div className="field" style={{ flex: '0 1 90px' }}>
              <label htmlFor="np-unit">Unit</label>
              <input id="np-unit" className="input" maxLength={40} value={form.unit} onChange={set('unit')} />
            </div>
            <div className="field">
              <label htmlFor="np-city">City</label>
              <input id="np-city" className="input" maxLength={120} value={form.city} onChange={set('city')} />
            </div>
            <div className="field" style={{ flex: '0 1 120px' }}>
              <label htmlFor="np-postal">Postal</label>
              <input id="np-postal" className="input mono" maxLength={20} value={form.postal} onChange={set('postal')} placeholder="V3T 1V8" />
            </div>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label htmlFor="np-kind">Kind</label>
            <select id="np-kind" className="input" value={form.kind} onChange={set('kind')}>
              <option value="person">Person</option>
              <option value="org">Organization</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="np-tags">Tags</label>
            <TagEditor inputId="np-tags" tags={tags} onChange={setTags} />
          </div>
        </>
      )}
      {act.error && <p className="error">{act.error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary pp-btn" disabled={act.busy}>Save person</button>
        <button type="button" className="btn btn-quiet pp-btn" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// People list
// ─────────────────────────────────────────────────────────────────────────────
const PAGE = 25;
const LIMIT = 300;

// Tags worth a glance in a row: never 'sample' (Today already says so), at most two.
const HIDDEN_TAGS = new Set(['sample']);
const rowTags = (tags) => {
  const shown = (tags || []).filter((t) => !HIDDEN_TAGS.has(t)).map(tagWord);
  return shown.length > 2 ? `${shown.slice(0, 2).join(' · ')} +${shown.length - 2}` : shown.join(' · ');
};

// /people is the desk's list. Volunteers work from the walk list, the map and
// Calls, so their /people (and old ?bank= links) opens Calls with the same filters.
function PeopleScreen() {
  const { me } = useOutletContext() ?? {};
  const [params] = useSearchParams();
  if (canDesk(me)) return <PeopleList />;
  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || '']));
  const text = params.get('bank') === 'text' || params.get('channel') === 'text';
  const phone = params.get('bank') === 'phone' || params.get('channel') === 'phone';
  return <Navigate replace to={`/calls${carry(f, { channel: text ? 'text' : phone ? 'phone' : null })}`} />;
}

function PeopleList() {
  const navigate = useNavigate();
  const { me } = useOutletContext() ?? {};
  const desk = canDesk(me); // person.create is desk-only
  const phone = useIsPhone();
  const online = useOnline();
  const { params, f, update } = useFilters();
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtn = useRef(null);
  const [page, setPage] = useState({ key: '', n: PAGE });
  const showNew = params.get('new') === '1' && desk;

  const scale = useScale();
  const qs = new URLSearchParams({ q: f.q, limit: String(LIMIT) });
  if (f.tag) qs.set('tag', f.tag);
  if (f.rating) qs.set('rating', ratingQuery(scale, f.rating));
  if (f.role) qs.set('role', f.role);
  if (f.has) qs.set('has', f.has);
  if (f.field) qs.set('field', f.field);
  addCuts(qs, f);
  addRules(qs, f);
  const qsKey = qs.toString();

  const persons = useQuery({
    queryKey: ['persons', 'list', qsKey],
    queryFn: () => apiGet(`/persons?${qs}`),
    placeholderData: keepPreviousData,
  });
  // The real total, asked for apart from the names: counting a city's file
  // takes longer than reading its first names, and never holds them up.
  const countQs = new URLSearchParams(qs);
  countQs.delete('limit');
  const total = useQuery({
    queryKey: ['persons', 'count', countQs.toString()], queryFn: () => apiGet(`/persons/count?${countQs}`), meta: { side: true }, retry: 1,
  });
  const rows = persons.data?.persons ?? [];
  // The last filter's people while this one's load: dimmed, and never counted as this one's.
  const stale = persons.isPlaceholderData;
  const n = page.key === qsKey ? page.n : PAGE;
  const shown = rows.slice(0, n);

  // Tags in use: every tag seen in a result on this visit (so picking one
  // doesn't hide the others), suggested ones first. Unused tags match no one.
  const seenRef = useRef(new Set());
  for (const p of rows) for (const t of p.tags || []) seenRef.current.add(t);
  if (f.tag) seenRef.current.add(f.tag);
  const seen = seenRef.current;
  const tagOptions = [
    ...SUGGESTED_TAGS.filter((t) => seen.has(t)),
    ...[...seen].filter((t) => !SUGGESTED_TAGS.includes(t)).sort((a, b) => tagWord(a).localeCompare(tagWord(b))),
  ];

  const picked = [f.rating, f.tag, f.role, f.has, f.field, ...MORE_KEYS.map((k) => f[k])].filter(Boolean).length;
  const anyFilter = Boolean(picked || f.q);
  const closeFilter = useCallback(() => { setFilterOpen(false); filterBtn.current?.focus(); }, []);

  // A number dials from your own phone only when calls through the campaign are off.
  const ownDialler = textingOn(useTextingStatus(me)).voice === false;

  // Old phone/text bank links (?bank=phone|text) now open Calls.
  const bank = params.get('bank');
  if (bank === 'phone' || bank === 'text') {
    return <Navigate replace to={`/calls${carry(f, { channel: bank === 'text' ? 'text' : 'phone' })}`} />;
  }

  // No signal — or only the last filter's list, held while this one waits
  // for signal (one the kept list can't answer, like a profile field): never
  // under this filter's chips.
  const offline = noSignal(persons) || (persons.isPlaceholderData && persons.fetchStatus === 'paused');
  // Searched with no signal over a kept list the server had cut off: there may be more.
  const partial = keptPartial(persons.data);
  // The count: the server's total, Loading…, or Unavailable. With no answer
  // at all (no signal, or the server down) it can only be what's on screen —
  // at once when the names themselves are a kept copy, not after the count
  // has tried twice.
  const fromCopy = keptCopy(persons.data);
  // The names came fresh again after a count that got no answer: count again.
  const namesAt = persons.dataUpdatedAt;
  useEffect(() => {
    if (total.isError && persons.isSuccess && !fromCopy && !persons.isPlaceholderData) total.refetch();
  }, [namesAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const plain = (k) => (k === 1 ? 'person' : 'people');
  // (A screen loaded with no signal at all never hears an "offline" event:
  // the browser's own word counts too.)
  const count = total.data ? <><strong className="mono">{fmt(total.data.total)}</strong> {plain(total.data.total)}</>
    : total.isError && !noReply(total.error) ? <Unavailable onRetry={() => total.refetch()} />
      : (noSignalNow() || total.fetchStatus === 'paused' || total.isError || fromCopy) && persons.data && !stale
        ? <><strong className="mono">{rows.length >= LIMIT ? `${fmt(LIMIT)}+` : fmt(rows.length)}</strong> {plain(rows.length)}{partial ? ' in the kept list' : ''}</>
        : LOADING;
  // No list at all (no answer, nothing kept): no count, no empty table — the error line says it.
  const failed = persons.isError && !persons.data;
  // The filter as it stands, for a list (Save as a list, or as they are now).
  const asFilter = Object.fromEntries(Object.entries(f).filter(([k, v]) => v && ['q', 'tag', 'rating', 'role', 'has', 'field', ...MORE_KEYS].includes(k)));
  // The profile's back link returns to this list, filters and all.
  const back = { from: { to: `/people${carry(f, { has: f.has })}`, label: 'People' } };

  return (
    <>
      <div className="page-head pp-head">
        <h1>People</h1>
        <div className="head-actions">
          <MoreMenu
            items={[
              { to: `/calls${carry(f, { channel: 'phone' })}`, label: 'Call list', icon: 'phone' },
              { to: `/calls${carry(f, { channel: 'text' })}`, label: 'Text list', icon: 'text' },
              { to: '/inbox', label: 'Inbox', icon: 'text', state: { from: { to: '/people', label: 'People' } } },
              desk && { to: '/banks', label: 'Phone banks', icon: 'phone' },
              desk && { to: '/people/import', label: 'Import', icon: 'upload' },
              desk && { to: '/data', label: 'Import & export' },
              desk && { to: '/surveys', label: 'Surveys' },
              desk && { to: '/people/connected', label: 'Most connected' },
              desk && { to: '/people/duplicates', label: 'Duplicates' },
              desk && { to: '/people/membership-form', label: 'Enter a membership form' },
              me?.role === 'manager' && { to: '/people/fields', label: 'Profile fields' },
            ]}
          />
          {desk && !showNew && (
            <button type="button" className="btn btn-primary pp-btn" disabled={!online} onClick={() => update({ new: '1' }, { replace: false })}>
              Add person
            </button>
          )}
        </div>
      </div>
      {desk && !showNew && !online && <NeedsSignalLine>Adding people needs signal</NeedsSignalLine>}

      {showNew && <AddPersonForm me={me} onClose={() => update({ new: null })} />}

      <div className="pp-bar">
        <label className="pp-search">
          <Icon name="search" />
          <span className="pp-sr">Search people</span>
          <input
            className="input" type="search" placeholder="Search"
            value={f.q} onChange={(e) => update({ q: e.target.value })}
          />
        </label>
        <button type="button" ref={filterBtn} className={`btn pp-btn pp-filterbtn${picked ? ' is-on' : ''}`}
          aria-expanded={filterOpen} onClick={() => setFilterOpen((v) => !v)}>
          <Icon name="filter" /> Filter{picked ? <span className="pp-badge">{picked}</span> : null}
        </button>
      </div>

      {filterOpen && <FilterSheet f={f} update={update} tagOptions={tagOptions} onClose={closeFilter} phone={phone} />}

      <FilterChips f={f} update={update}
        extra={f.field ? <FieldFilterChip value={f.field} onRemove={() => update({ field: null })} /> : null} />

      {!offline && !failed && (
        <div className="pp-count">
          {/* Only the count is read out as it changes, never the form beside it. */}
          <span aria-live="polite">{count}</span>
          {desk && anyFilter && !partial && ' '}
          {desk && anyFilter && !partial && (
            <Link className="pp-savelist" to={`/lists/new?${new URLSearchParams(asFilter)}`}>
              Save as a list
            </Link>
          )}
          {desk && anyFilter && !partial && (
            <SnapshotForm link input={{ filter: Object.fromEntries(countQs) }} count={total.data?.total ?? null} defaultName="People" />
          )}
        </div>
      )}

      {/* A load that got no answer says so; one the server answered with an error is Unavailable. */}
      {persons.isError && !offline && (
        <p className="error" role="alert">
          {noReply(persons.error) ? <>No answer — check your signal · <button type="button" className="btn au-retry" onClick={() => persons.refetch()}>Try again</button></>
            : <Unavailable onRetry={() => persons.refetch()} />}
        </p>
      )}

      {offline ? (
        <p className="pp-offline" role="status">No signal — the list loads when you’re back online.</p>
      ) : failed ? null : rows.length === 0 && !persons.isLoading && !persons.isError && !stale ? (
        <div className="pp-empty">
          <p>{partial ? 'No one in the kept list matches.' : anyFilter ? 'No one matches.' : 'No people yet.'}</p>
          {anyFilter ? (
            <button type="button" className="btn pp-btn" onClick={() => update({ q: null, tag: null, rating: null, role: null, has: null, field: null, ...Object.fromEntries(MORE_KEYS.map((k) => [k, null])) })}>
              Clear filters
            </button>
          ) : desk && !showNew ? (
            <Link className="btn pp-btn" to="/people/import">Import a list</Link>
          ) : null}
        </div>
      ) : phone ? (
        <ul className={`pp-list${stale ? ' au-stale' : ''}`} aria-busy={stale || undefined}>
          {shown.map((p) => (
            <li key={p.id}>
              <Link className="pp-row" to={`/people/${p.id}`} state={back}>
                <span className="pp-row__main">
                  <span className="pp-row__name">{p.name}</span>
                  <span className="pp-row__fact">{p.phone || streetLine(p) || p.email || ''}</span>
                </span>
                {p.rating && <RatingChip code={p.rating} who />}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <table className={`table pp-table${stale ? ' au-stale' : ''}`} aria-busy={stale || undefined}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Rating</th>
              <th>Phone</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const second = rowTags(p.tags);
              return (
                <tr key={p.id} className="rowlink" onClick={() => navigate(`/people/${p.id}`, { state: back })}>
                  <td className="pp-table__name">
                    <Link to={`/people/${p.id}`} state={back} onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                    {p.kind === 'org' && <> <span className="chip chip-ghost">org</span></>}
                    {second && <span className="pp-table__second">{second}</span>}
                  </td>
                  <td>{p.rating && <RatingTag code={p.rating} />}</td>
                  <td>
                    {!p.phone ? <span className="muted">—</span>
                      : ownDialler ? <a className="tel" href={telHref(p.phone)} onClick={(e) => e.stopPropagation()}>{p.phone}</a>
                        : <span className="tel">{p.phone}</span>}
                  </td>
                  <td>{streetLine(p) || <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {rows.length > n && (
        <div className="pp-more">
          <button type="button" className="btn pp-btn" onClick={() => setPage({ key: qsKey, n: n + PAGE })}>
            Show more
          </button>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calls — one person at a time
// ─────────────────────────────────────────────────────────────────────────────
// Who has been called or texted in this sitting (this tab only), so the queue
// moves on and a reload doesn't start over. A convenience: never required.
const DONE_KEY = 'starbase.calls.done';
const readDone = () => {
  try { return JSON.parse(sessionStorage.getItem(DONE_KEY) || '{}') || {}; } catch { return {}; }
};
const writeDone = (map) => {
  try { sessionStorage.setItem(DONE_KEY, JSON.stringify(map)); } catch { /* private mode: memory only */ }
};
// Phone or Text: the last one you used, per sign-in on this phone (Calls
// opens on it). A convenience: a link that names one (?channel=) wins.
const channelKey = (me) => `starbase.calls.channel:${me?.workspace?.id || ''}:${me?.user?.id || ''}`;
const readChannel = (me) => {
  try { return localStorage.getItem(channelKey(me)) === 'text' ? 'text' : 'phone'; } catch { return 'phone'; }
};
const saveChannel = (me, c) => {
  try { localStorage.setItem(channelKey(me), c); } catch { /* private mode: not remembered */ }
};
const OUTCOME_WORD = { no_answer: 'No answer', refused: 'Refused', left_message: 'Left message' };
const outcomeWord = (outcome, channel) => (outcome === 'no_answer' && channel === 'text' ? 'No reply' : OUTCOME_WORD[outcome] || outcome);
// When a phone bank's number comes back: "6:00 p.m.", "tomorrow 10:00 a.m.", "Fri 10:00 a.m.".
const backWord = (iso) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date())) / 86_400_000);
  return days <= 0 ? time : days === 1 ? `tomorrow ${time}` : `${d.toLocaleDateString('en-CA', { weekday: 'short' })} ${time}`;
};
// "Call back…": in an hour, this evening at 6, tomorrow at 10 — on the caller's phone's clock.
const CALLBACKS = [
  ['In an hour', () => new Date(Date.now() + 3600_000)],
  ['This evening', () => { const d = new Date(); if (d.getHours() >= 17) d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return d; }],
  ['Tomorrow morning', () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; }],
];

// Who comes up first: never rated, then rated longest ago, so anyone rated
// today (by you or another caller) goes to the back. Ties are shuffled per
// caller — stable for you, different for the next caller — so two people
// working the same list don't start on the same name.
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  // Final mix, so the caller part of the key moves the whole order.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
};
const ratedTime = (p) => {
  const t = p.rated_at ? Date.parse(p.rated_at) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};
const callOrder = (list, seed) => list
  .map((p) => ({ p, t: ratedTime(p), h: hash(`${seed}:${p.id}`) }))
  .sort((a, b) => (a.t === b.t ? a.h - b.h : a.t - b.t))
  .map((x) => x.p);

// "Your call lists · 2" when numbers are handed to you; the desk's way to the banks.
function CallListsLink({ desk }) {
  const q = useQuery({ queryKey: ['banks', 'mine'], queryFn: () => apiGet('/banks/mine'), staleTime: 30_000, retry: false });
  const n = q.data?.banks?.length || 0;
  if (!n && !desk) return null;
  return (
    <p className="cl-lists">
      <Link to="/banks">{n ? <>Your call lists <strong className="mono">{n}</strong></> : 'Phone banks'}</Link>
      {n > 0 && desk && <> · <Link to="/banks">Phone banks</Link></>}
    </p>
  );
}

function CallsScreen() {
  useScripts(); // read with the list, so the phone script is kept for later
  const { me } = useOutletContext() ?? {};
  const location = useLocation();
  const desk = canDesk(me);
  const queryClient = useQueryClient();
  const scale = useScale();
  const { params, f, update } = useFilters();
  // contact.log's channel is an enum — never pass a hand-edited value through.
  const asked = params.get('channel');
  const channel = asked === 'text' ? 'text' : asked === 'phone' ? 'phone' : readChannel(me);
  useEffect(() => { if (asked === 'text' || asked === 'phone') saveChannel(me, asked); }, [asked, me]);
  const noun = channel === 'text' ? 'text' : 'call';
  // Texts through the campaign's number: the Text list leaves out whoever
  // someone else is texting, and whoever you texted until they reply (or a
  // day goes by); whoever replied to you comes first.
  const texting = useTextingStatus(me);
  const smsOn = channel === 'text' && Boolean(texting.data?.sms);
  const textQueue = useTextQueue(me, smsOn);
  const away = textQueue.data?.away;
  const replied = textQueue.data?.replied;
  const [textedHere, setTextedHere] = useState(() => new Set()); // sent from this card, this sitting
  const [sentId, setSentId] = useState(null); // the card just sent: "✓ Sent" and Next, nothing else

  // A phone bank (?bank=): the numbers handed to you that are left, in the
  // bank's order; a logged call crosses one off on the server.
  const bankId = /^[0-9a-f-]{36}$/i.test(params.get('bank') || '') ? params.get('bank') : null;
  // reach: only who the one place (server lib/reach.js) says may be called —
  // or texted — so the list, its count and every send agree. A list (?list=)
  // is one more filter: the desk's lists; a volunteer's match nobody.
  const qs = new URLSearchParams({ q: f.q, limit: String(LIMIT), has: 'phone', reach: channel === 'text' ? 'text' : 'call' });
  if (f.tag) qs.set('tag', f.tag);
  if (f.rating) qs.set('rating', ratingQuery(scale, f.rating));
  if (f.role) qs.set('role', f.role);
  if (f.field) qs.set('field', f.field);
  addCuts(qs, f);
  addRules(qs, f);
  const listKey = qs.toString();
  // A long list comes in parts, by name: the next part loads as the one on
  // screen runs low, so Calls never stops at its first 300. ends[i] is where
  // part i ended once the next was asked for: asked again, part i stops
  // there (?until=), so someone new on the list never pushes anyone out.
  const [parts, setParts] = useState({ key: listKey, ends: [] });
  const ends = parts.key === listKey ? parts.ends : [];
  const endsRef = useRef(ends);
  endsRef.current = ends;
  const partUrl = (i) => {
    const p = new URLSearchParams(listKey);
    const end = endsRef.current[i];
    if (i > 0) p.set('after', endsRef.current[i - 1]);
    if (end) { p.set('until', end); p.set('limit', '2000'); }
    return `/persons?${p}`;
  };
  // The list is kept on this phone, so losing signal mid-list loses nothing.
  const copyName = bankId ? `bank:${bankId}` : `calls:${qs}`;
  const persons = useQuery({
    queryKey: bankId ? ['banks', bankId, 'mine'] : ['persons', 'list', listKey],
    queryFn: () => (bankId ? apiGet(`/banks/${bankId}/mine`) : apiGet(partUrl(0))),
    placeholderData: keepPreviousData,
    ...phoneCopy(me, copyName),
  });
  // The parts after the first, each read once: a part already called
  // through is never asked for again.
  const later = useQueries({
    queries: (bankId ? [] : ends).map((end, i) => ({
      queryKey: ['calls', 'part', listKey, end], queryFn: () => apiGet(partUrl(i + 1)), staleTime: Infinity, retry: 1,
    })),
  });
  const bank = bankId ? persons.data?.bank : null;
  const [scriptOpen, setScriptOpen] = useState(false);
  useKeepCopy(me, copyName, persons);
  const listCopy = showingCopy(persons);
  const seed = me?.user?.id || '';
  // Every part loaded, once each. (One stamp for the parts: a hook's list of
  // dependencies must keep its length, and the parts grow.)
  const laterStamp = later.map((r) => r.dataUpdatedAt || 0).join(',');
  const list = useMemo(() => {
    if (!persons.data?.persons) return undefined;
    const seen = new Set();
    return [persons.data.persons, ...later.map((r) => r.data?.persons ?? [])].flat().filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
  }, [persons.data, laterStamp]); // eslint-disable-line react-hooks/exhaustive-deps
  // The newest part: are there more after it, and where it ends.
  const last = ends.length ? later[ends.length - 1] : persons;
  const lastRows = ends.length ? last?.data?.persons : persons.data?.persons;
  const more = !bankId && Boolean(last?.data?.more) && !persons.isPlaceholderData;
  // How many in all, for a list longer than what's loaded (the same rule, counted).
  const countQs = new URLSearchParams(listKey);
  countQs.delete('limit');
  const total = useQuery({
    queryKey: ['persons', 'count', countQs.toString()], queryFn: () => apiGet(`/persons/count?${countQs}`), enabled: more, meta: { side: true }, retry: 1,
  });
  // Text mode also skips anyone who opted out of texts (replied STOP).
  const reachable = useMemo(
    () => (list ?? []).filter((p) => p.phone && !isDnc(p) && !(channel === 'text' && noTexts(p))),
    [list, channel],
  );
  const rows = useMemo(() => {
    const ok = reachable;
    if (bankId) return ok; // a phone bank keeps its own order
    if (!smsOn) return callOrder(ok, seed);
    const awaySet = new Set(away ?? []);
    const repliedSet = new Set(replied ?? []);
    const open = callOrder(ok.filter((p) => repliedSet.has(p.id) || (!awaySet.has(p.id) && !textedHere.has(p.id))), seed);
    return [...open.filter((p) => repliedSet.has(p.id)), ...open.filter((p) => !repliedSet.has(p.id))];
  }, [reachable, seed, smsOn, away, replied, textedHere, bankId]);
  const offline = noSignal(persons) || (persons.isPlaceholderData && persons.fetchStatus === 'paused');

  const [done, setDone] = useState(readDone);
  const [currentId, setCurrentId] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const [toast, setToast] = useState(null); // { text, person }
  // The rating tapped for each person in this sitting: the buttons start blank
  // and only show a check for what you picked (e.g. after "Change").
  const [picked, setPicked] = useState({});
  // "Change" brings a person back even when their new rating took them out
  // of a filtered list (Calls for Undecided, then they said Lean yes).
  const [held, setHeld] = useState(null);
  const toastTimer = useRef(null);
  const cardRef = useRef(null);
  // After a tap the next person's card is a fresh element (no button looks
  // pressed). If focus was on the card, it moves to the new card.
  const refocus = useRef(false);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const markDone = (id, entry) => setDone((d) => { const next = { ...d }; if (entry) next[id] = entry; else delete next[id]; writeDone(next); return next; });

  // Not awaited: the next person should be tappable while the list refetches.
  // A rating moves the map pin colour and the housemates' household lists.
  const act = useAction(() => { invalidatePersonData(queryClient); });

  const queue = rows.filter((p) => !done[p.id]);
  const current = queue.find((p) => p.id === currentId) || (held?.id === currentId ? held : null) || queue[0] || null;
  const at = current ? queue.indexOf(current) : -1; // -1: a held person outside the list
  const calledHere = rows.length - queue.length;
  const mine = (current && picked[current.id]) || null;
  // The newest part is on its way (or didn't come); the list on screen runs
  // low: the next part is asked for, starting after the last name loaded.
  const pending = !bankId && ends.length > 0 && !last?.data;
  useEffect(() => {
    if (!more || !lastRows?.length || queue.length >= 20) return;
    const end = lastRows.at(-1).id;
    setParts((p) => {
      const cur = p.key === listKey ? p.ends : [];
      return cur.length === ends.length && !cur.includes(end) ? { key: listKey, ends: [...cur, end] } : p;
    });
  }, [more, lastRows, queue.length, listKey, ends.length]);
  // How many are left: the ones loaded and not done yet, and everyone not
  // loaded yet (the server's count, by the same rule) — or Loading….
  const notLoaded = more || pending;
  const toCall = notLoaded ? (total.data ? queue.length + Math.max(0, total.data.total - (list?.length ?? 0)) : null) : queue.length;
  // The card stays on whoever is up (a reply arriving doesn't swap it).
  useEffect(() => { if (current && current.id !== currentId) setCurrentId(current.id); }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opened from a profile or the door card (?person=): that person's card,
  // even when the list would leave them out for now.
  const wantId = params.get('person');
  const wanted = useRef(null);
  useEffect(() => {
    if (!wantId || wanted.current === wantId || !list) return;
    const p = list.find((x) => x.id === wantId);
    if (!p) return;
    wanted.current = wantId;
    if (!p.phone || isDnc(p) || (channel === 'text' && noTexts(p))) return;
    setHeld(p);
    setCurrentId(p.id);
  }, [wantId, list, channel]);
  // Through the campaign's number, "No reply" is true only once you texted
  // them and they haven't answered (a later visit — never right after Send).
  // Just sent, or someone else is texting them: nothing to log here, only Next.
  const txPerson = useTextingPerson(current?.id, smsOn);
  const txCard = smsOn ? txPerson.data : null;
  const showNoReply = !smsOn || txCard?.conversation?.last?.direction === 'out';
  const justSent = Boolean(current && sentId === current.id);
  const nothingToLog = justSent || Boolean(txCard?.in_touch);
  // The active calls survey's questions for this person (answers go with the next tap).
  const survey = useSurvey({ context: 'calls', personId: current?.id, lat: current?.lat, lng: current?.lng });
  const after = (i) => (i < 0 ? queue[0] || null : queue.length > 1 ? queue[(i + 1) % queue.length] : null);
  const upNext = at < 0 ? queue : queue.slice(at + 1).concat(queue.slice(0, at));

  // Their own note (from the volunteer form): the card shows its first line.
  // GET /persons carries it on every row, so no fetch per card; only a list
  // without the field (an older server) falls back to the profile (same cache
  // as the profile screen).
  const noteInList = current ? current.note !== undefined : true;
  const profile = useQuery({
    queryKey: ['person', current?.id],
    queryFn: () => apiGet(`/persons/${current.id}`),
    enabled: Boolean(current?.id) && !noteInList,
    staleTime: 60_000,
  });
  const theirNote = String((noteInList
    ? current?.note
    : profile.data?.person?.id === current?.id ? profile.data?.person?.note : '') || '').trim();

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    cardRef.current?.focus({ preventScroll: true });
  }, [current?.id]);
  const focusInCard = () => Boolean(cardRef.current?.contains(document.activeElement));

  const showToast = (text, person, act = null) => {
    setToast({ text, person, act });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  const log = async (outcome, rating) => {
    const p = current;
    if (!p) return;
    const inCard = focusInCard(); // read before the buttons disable for the save
    const answers = outcome === 'contacted' ? survey.take() : [];
    // After "Save answers" (then Change), the tap finishes that same contact.
    const visitOf = survey.visitOf(channel);
    const res = await act.run('contact.log', {
      person_id: p.id, channel, outcome, rating: rating || undefined, answers: answers.length ? answers : undefined, visit_of: visitOf,
    }, { who: p.name });
    if (!res) { survey.restore(answers); return; }
    survey.logged(res, { channel, outcome, rating, answers, visitOf });
    const next = after(at);
    refocus.current = inCard;
    markDone(p.id, { rating: rating || null, outcome, queued: !!res.queued });
    if (rating) setPicked((m) => ({ ...m, [p.id]: rating }));
    setHeld(null);
    setCurrentId(next?.id ?? null);
    const back = res.result?.bank?.back_at;
    const what = rating ? `Rated ${ratingText(scale, rating)}${answersTail(answers, res.result)}`
      : answers.length ? answersSaid(answers, res.result)
        : `${outcomeWord(outcome, channel)}${back ? ` — back on your list ${backWord(back)}` : ''}`;
    if (back) queryClient.invalidateQueries({ queryKey: ['banks', bankId, 'mine'] });
    // Not reached yet: the same words as the door card ("Saved on this phone — sends soon").
    showToast(`${firstName(p.name)} · ${what}${res.queued ? ` · ${queuedText(res)}` : ''}`, p);
  };
  const skip = () => { const next = after(at); if (next) { refocus.current = focusInCard(); setCurrentId(next.id); } };
  // A phone bank's "Call back…": off the list until then, back by itself.
  const [callbackOpen, setCallbackOpen] = useState(false);
  const callBack = async (when) => {
    const p = current;
    if (!p || !bankId) return;
    const res = await act.run('bank.callback', { id: bankId, person_id: p.id, at: when().toISOString() });
    if (!res) return;
    setCallbackOpen(false);
    const next = after(at);
    setCurrentId(next?.id ?? null);
    queryClient.invalidateQueries({ queryKey: ['banks', bankId, 'mine'] });
    showToast(`${firstName(p.name)} · back on your list ${backWord(res.back_at ?? res.result?.back_at)}`, p);
  };
  // Sent from the card: it says so and offers Next; they leave the list
  // until they reply.
  const onSent = (p) => {
    setTextedHere((s) => new Set(s).add(p.id));
    setSentId(p.id);
    setHeld(p);
    setCurrentId(p.id);
  };
  const onNext = () => {
    const p = current;
    const next = after(at);
    refocus.current = focusInCard();
    setSentId(null);
    setHeld(null);
    setCurrentId(next && next.id !== p?.id ? next.id : null);
  };
  const change = () => {
    const p = toast?.person;
    setToast(null);
    clearTimeout(toastTimer.current);
    if (!p) return;
    markDone(p.id, null);
    setHeld(p);
    refocus.current = true;
    setCurrentId(p.id);
    cardRef.current?.scrollIntoView?.({ block: 'start' });
  };
  const startOver = () => {
    const next = { ...done };
    for (const p of rows) delete next[p.id];
    writeDone(next);
    setDone(next);
    setCurrentId(null);
  };
  const setChannel = (c) => {
    saveChannel(me, c === 'text' ? 'text' : 'phone');
    setSentId(null);
    update({ channel: c === 'text' ? 'text' : null, person: null });
  };

  const filterChips = <FilterChips f={f} update={update} keys={['rating', 'tag', 'role', 'q']} desk={desk}
    extra={f.field ? <FieldFilterChip value={f.field} desk={desk} onRemove={() => update({ field: null })} /> : null} />;

  return (
    <div className="cl-page">
      <div className="page-head cl-head">
        <h1>{bank ? bank.name : channel === 'text' ? 'Texts' : 'Calls'}</h1>
        {!bankId && <div className="cl-toggle" role="group" aria-label="Call or text">
          <button type="button" aria-pressed={channel === 'phone'} onClick={() => setChannel('phone')}>
            <Icon name="phone" size={18} /> Phone
          </button>
          <button type="button" aria-pressed={channel === 'text'} onClick={() => setChannel('text')}>
            <Icon name="text" size={18} /> Text
          </button>
        </div>}
      </div>

      {bankId ? (
        <div className="cl-bank">
          <p className="cl-bank__line">
            <Link to={desk ? '/banks' : '/banks'}>← {desk ? 'Phone banks' : 'Your call lists'}</Link>
            {bank && <span className="muted"> · {bank.done} of {bank.total} done</span>}
            {bank?.later > 0 && <span className="muted"> · {bank.later} to call back{bank.next_at ? ` (next ${backWord(bank.next_at)})` : ''}</span>}
          </p>
          {bank?.script && (
            <>
              <button type="button" className="btn btn-quiet disclose disclose--inline" aria-expanded={scriptOpen} onClick={() => setScriptOpen((v) => !v)}>Script</button>
              {scriptOpen && <pre className="cl-bank__script">{bank.script}</pre>}
            </>
          )}
        </div>
      ) : (
        <>
          {filterChips}
          <CallListsLink desk={desk} />
          <MyPeopleLink me={me} />
          <TextingRepliesLink me={me} />
        </>
      )}

      {listCopy && !offline && <p className="cl-copy"><span className="chip obx-copy">Offline copy</span></p>}
      {persons.isError && !offline && !listCopy && <p className="error">{noAnswer(persons.error) ? 'No answer — check your signal' : persons.error.message}</p>}

      {offline ? (
        <p className="pp-offline" role="status">No signal — your list loads when you’re back online.</p>
      ) : persons.isLoading || (channel === 'text' && texting.isLoading) || (smsOn && textQueue.isLoading) ? (
        <p className="muted">Loading…</p>
      ) : persons.isError && !list && !current ? null : !current && pending && (last?.isError || last?.fetchStatus === 'paused') ? (
        // The next part didn't come: say so, and offer it again.
        <p className="error" role="alert">
          {noReply(last.error)
            ? <>{noSignalNow() ? 'No signal' : 'No answer'} — the rest of your list loads when you’re back online · <button type="button" className="btn au-retry" onClick={() => last.refetch()}>Try again</button></>
            : <Unavailable onRetry={() => last.refetch()} />}
        </p>
      ) : !current && (pending || more) ? (
        <p className="muted" role="status">{LOADING}</p>
      ) : rows.length === 0 && !current ? (
        <div className="pp-empty">
          {/* Everyone here has a text from the campaign: replies come to the Inbox. */}
          <p>{bankId ? (bank?.total ? 'All done — every number on your list is called.' : 'No numbers on your list.') : reachable.length > 0 ? `No one left to ${noun}.` : `No one to ${noun} yet.`}</p>
          {bankId ? <Link className="btn pp-btn" to="/banks">{desk ? 'Phone banks' : 'Your call lists'}</Link> : desk && <Link className="btn pp-btn" to="/people">Go to People</Link>}
        </div>
      ) : !current ? (
        <div className="pp-empty cl-alldone">
          <p className="cl-big"><strong className="mono">{fmt(calledHere)}</strong> done</p>
          <button type="button" className="btn pp-btn" onClick={startOver}>Start over</button>
        </div>
      ) : (
        <>
          <div className="cl-progress">
            <span>
              {toCall != null ? <><strong className="mono">{fmt(toCall)}</strong> to {noun}</>
                : noSignalNow() || total.fetchStatus === 'paused' ? <><strong className="mono">{fmt(queue.length)}</strong> to {noun} · more when you’re back online</>
                  : total.isError ? <Unavailable onRetry={() => total.refetch()} /> : LOADING}
            </span>
            <div className="cl-bar" role="progressbar" aria-label={`${fmt(calledHere)} of ${fmt(calledHere + (toCall ?? queue.length))} done`}
              aria-valuemin={0} aria-valuemax={calledHere + (toCall ?? queue.length)} aria-valuenow={calledHere}>
              <div className="cl-bar__fill" style={{ width: `${calledHere + (toCall ?? queue.length) ? Math.round((calledHere / (calledHere + (toCall ?? queue.length))) * 100) : 0}%` }} />
            </div>
          </div>

          {/* Keyed per person: a new card for each, so nothing carries over. */}
          <section key={current.id} className="card cl-card" ref={cardRef} tabIndex={-1} aria-label={`${current.name}`}>
            <div className="cl-who">
              <div className="cl-who__main">
                <Link className="cl-name" to={`/people/${current.id}`}
                  state={{ from: { to: `${location.pathname}${location.search}`, label: channel === 'text' ? 'Texts' : 'Calls' } }}>
                  {current.name}
                </Link>
                <span className="cl-phone mono">{current.phone}</span>
                {streetLine(current) && <span className="cl-addr">{streetLine(current)}</span>}
                {current.rating && !mine && (
                  <span className="cl-last">
                    Last time: {ratingLine(scale, current.rating)}{current.rated_at ? ` · ${fmtShort(current.rated_at)}` : ''}
                  </span>
                )}
                {theirNote && (
                  <span className="cl-note" title={theirNote}>
                    <span className="pp-sr">Their note: </span>“{theirNote.split('\n')[0]}”
                  </span>
                )}
                <QuickDetails key={`qd-${current.id}`} person={current} me={me} toast={(m) => showToast(m, current)}
                  onSaved={(next) => {
                    const patch = (d) => (d?.persons ? { ...d, persons: d.persons.map((p) => (p.id === next.id ? { ...p, ...next } : p)) } : d);
                    queryClient.setQueryData(bankId ? ['banks', bankId, 'mine'] : ['persons', 'list', listKey], patch);
                    if (!bankId) for (const end of ends) queryClient.setQueryData(['calls', 'part', listKey, end], patch);
                    if (held?.id === next.id) setHeld({ ...held, ...next });
                    invalidatePersonData(queryClient);
                  }} />
              </div>
            </div>

            {/* Through the campaign's Twilio number when connected; else the phone's own apps. */}
            <TextingCallButton person={current} me={me} channel={channel} onSent={onSent} onNext={onNext}>
              {channel === 'text' ? (
                <a className="btn cl-call" href={smsHref(current.phone, textBody(current, me))}>
                  <Icon name="text" size={22} /> Text {firstName(current.name)}
                </a>
              ) : (
                <a className="btn cl-call" href={telHref(current.phone)}>
                  <Icon name="phone" size={22} /> Call {firstName(current.name)}
                </a>
              )}
            </TextingCallButton>

            {/* Just texted (or someone else is): nothing to rate yet — the card offers Next. */}
            {!nothingToLog && (
              <>
                {/* A phone bank's own script sits at the top; otherwise the campaign's. */}
                {!bank?.script && <ScriptLine context="phone" person={current} />}
                <div className="cl-rate">
                  <RatingButtons value={mine} onPick={(code) => log('contacted', code)} disabled={act.busy} />
                </div>
                <VotedRow person={current} source="phone" toast={(text, o) => showToast(text, null, o?.act || null)} onMarked={() => { invalidatePersonData(queryClient); if (bankId) queryClient.invalidateQueries({ queryKey: ['banks', bankId, 'mine'] }); }} />

                <div className="cl-outcomes">
                  {showNoReply && (
                    <button type="button" className="cl-out" disabled={act.busy} onClick={() => log('no_answer')}>
                      {channel === 'text' ? 'No reply' : 'No answer'}
                    </button>
                  )}
                  {channel === 'phone' && (
                    <button type="button" className="cl-out" disabled={act.busy} onClick={() => log('left_message')}>Left message</button>
                  )}
                  <button type="button" className="cl-out" disabled={act.busy} onClick={() => log('refused')}>Refused</button>
                  {bankId && channel === 'phone' && (
                    <button type="button" className="cl-out" aria-expanded={callbackOpen} disabled={act.busy} onClick={() => setCallbackOpen((v) => !v)}>Call back…</button>
                  )}
                  <button type="button" className="cl-out cl-skip" disabled={act.busy || !after(at)} onClick={skip}>
                    Skip <Icon name="next" size={18} />
                  </button>
                </div>
                {callbackOpen && bankId && (
                  <div className="cl-callback" role="group" aria-label="Call back">
                    {CALLBACKS.map(([label, when]) => (
                      <button key={label} type="button" className="btn ops-tap" disabled={act.busy} onClick={() => callBack(when)}>{label}</button>
                    ))}
                  </div>
                )}
                <SurveyQuestions survey={survey} disabled={act.busy} onSave={() => log('contacted')} />
              </>
            )}
            {act.error && <p className="error" role="alert">{act.error}</p>}
          </section>

          {upNext.length > 0 && (
            <div className="cl-next">
              <button type="button" className="cl-next__btn disclose" aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)}>
                Up next
              </button>
              {listOpen && (
                <ul className="cl-next__list">
                  {upNext.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => { refocus.current = true; setCurrentId(p.id); setListOpen(false); cardRef.current?.scrollIntoView?.({ block: 'start' }); }}>
                        <span>{p.name}</span>
                        {p.rating && <RatingChip code={p.rating} who />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {toast && (
        <div className="toast cl-toast" role="status">
          <span>{toast.text}</span>
          {(toast.act || toast.person) && (
            <button type="button" className="btn cl-toast__btn" onClick={toast.act ? () => { setToast(null); clearTimeout(toastTimer.current); toast.act.onClick(); } : change}>{toast.act?.label || 'Change'}</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────
export default function People({ mode }) {
  return mode === 'calls' ? <CallsScreen /> : <PeopleScreen />;
}
