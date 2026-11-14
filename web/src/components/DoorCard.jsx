// DoorCard — the drawer for one door. Rating first: the selected person's
// name, the big rating buttons, then one row of quiet "no conversation"
// outcomes. Everything else (note, call/text with a one-tap "log this call",
// channel, sign request, add a person, profile) sits under "More". Several
// people at one door → simple tabs at the top. The map decides where it sits
// (bottom sheet on phones, right panel on desktop).
// With the campaign's Twilio number connected, More's Call and Text open the
// person's card on Calls (the campaign's number, the STOP line, the Inbox,
// quiet hours) — never the phone's own dialler or Messages; Text is gone for
// anyone who opted out of texts.
// Also exports AddDoorForm — person.create for a tapped spot that has no door
// yet (desk only) — and, for the walk list's door: SignAsk (the "Wants a
// sign?" row), AddPersonInline and signCancelOffered.
//
// "+ Person at this door" is person.addAtDoor: name and phone only; the
// server copies the door's address and pin from someone already there. Every
// role may use it — a volunteer at a door inside a turf they walk (canAddHere).
//
// Offline: every write here goes through the outbox (src/offline.js) — knocks
// (logContact), a new person or door (person.addAtDoor / person.create, on an
// id made here, so they can be knocked at once), sign requests and their
// Undo — so a tap with no signal is saved on the phone and sent later, in
// order, exactly once.
// The card shows it straight away (queued.js has the words, shared with the
// walk list, Calls and the profile); a person or sign not sent yet says
// "Not sent yet" (the map lays the outbox over its doors), and so does a
// person whose knock is still on the phone ("Saved offline" with no signal).
//
// A sign request's toast offers Undo only when the server has sign.cancel
// (GET /api/actions): it takes the request back — off every list and count —
// so "Lawn sign cancelled" is true. Never "taken down": it never went up. A
// request still on the phone is simply taken off it ("Lawn sign cancelled");
// one that may already have gone sends its cancel after it ("Undo saved…").
//
// Contacts are append-only: after a tap the toast offers "Change", which
// puts focus back on the rating row — the next tap logs the correction.
//
// A note typed after the rating (knock, rate, jot) is never lost: closing
// the card (✕, another pin, the empty map, leaving the screen) or switching
// to another person at the door sends it on its own — the same path as
// "Save note" — and the toast says "Note saved".
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet, ApiError } from '../api.js';
import { holdNote, logContact, queueAction, undoQueued, useOutbox } from '../offline.js';
import { isOffline, queuedChip, queuedSaid, queuedText } from './queued.js';
import { SIGN_KINDS, noCalls, noCallsWord } from '@starbase/shared/canvass';
import { directionsUrl } from '@starbase/shared/maps';
import RatingButtons, { More, OutcomeButtons, OUTCOME_LABEL, PersonTabs, focusRating, ratingText, useScale } from './RatingButtons.jsx';
import { IKnowThem, KnowMeChip } from './RelationshipsBits.jsx';
import QuickDetails from './QuickDetails.jsx';
import SurveyQuestions, { answersSaid, answersTail, answersWord, useSurvey } from './SurveyQuestions.jsx';
import { VotedRow } from './Voted.jsx';
import { LIT, OUTCOMES } from './RatingButtons.jsx';
import RequestAsk from './RequestAsk.jsx';
import AddressField, { lookupAddress } from './AddressField.jsx';
import { useOnline } from './NoSignal.jsx';
import { callsCard, noTexts, textingOn, useTextingStatus } from './TextingCard.jsx';
import '../pages/map.css';
import ScriptLine from './ScriptLine.jsx';

// "Wants a sign?" — one tap files a request (Undo is on the toast). A kind
// this door already has (requested or up) isn't offered again.
const SIGN_BUTTONS = [
  { code: 'lawn', label: 'Lawn sign' },
  { code: 'large', label: 'Large sign' },
  { code: 'billboard', label: 'Billboard' },
  { code: 'window', label: 'Window' },
];
export const SIGN_LABEL = Object.fromEntries(SIGN_KINDS.map((s) => [s.code, s.label]));
// "To put up" is a neutral ochre chip (fk-wait), never the brand yellow.
const SIGN_CHIP = { installed: 'chip-ok', requested: 'fk-wait' };
// The Signs screen's words, everywhere a sign shows.
const SIGN_STATUS = { requested: 'To put up', installed: 'Up', removed: 'Taken down' };
// Channel for the rating + outcome taps. Door by default on the map; tapping
// Call / Text switches it so the rating that follows is logged as that call.
// "How you reached them: At the door · Phone call · Text" at the bottom of
// More sets it by hand (kept away from the Call / Text buttons, which dial).
const CHANNEL_BUTTONS = [
  { code: 'door', label: 'At the door' },
  { code: 'phone', label: 'Phone call' },
  { code: 'text', label: 'Text' },
];
const CHANNEL_CHIP = { phone: 'By phone', text: 'By text' };

export const OFFLINE_MSG = 'Needs signal — try again';
const SIGNED_OUT_MSG = 'Signed out — sign in, then try again';
// fetch() rejects with a TypeError (not an ApiError) when there's no network.
const offlineError = (err) => isOffline() || !(err instanceof ApiError);
// What to tell the canvasser when the server says no.
const refusalMsg = (err, fallback) => {
  if (offlineError(err)) return OFFLINE_MSG;
  if (err.status === 401) return SIGNED_OUT_MSG;
  return err.message || fallback;
};

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// GET /api/actions lists what this sign-in may do (same key as Shifts/Team).
const ACTIONS_QUERY = { queryKey: ['actions'], queryFn: () => apiGet('/actions'), staleTime: 5 * 60_000 };
const hasAction = (data, name) => Array.isArray(data?.actions) && data.actions.includes(name);
// Whether a sign request's Undo can really take it back (sign.cancel).
export const signCancelOffered = (queryClient) => queryClient.fetchQuery(ACTIONS_QUERY)
  .then((d) => hasAction(d, 'sign.cancel')).catch(() => false);
// Drop any extension ("604-555-0101 ext 2", "x2", "#2") before stripping to
// digits, or it gets glued onto the number and dials the wrong line.
const dialable = (phone) => String(phone || '').replace(/\s*(?:ext\.?|x|#).*$/i, '').replace(/[^\d+]/g, '');
// rated_at is a timestamptz (ISO, UTC) — show the canvasser's local date,
// not the UTC one (an evening knock in Surrey is already "tomorrow" in UTC).
const localDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
};
const telHref = (phone) => `tel:${dialable(phone)}`;
const smsHref = (phone, body) => `sms:${dialable(phone)}?&body=${encodeURIComponent(body)}`;
const isDnc = (p) => Array.isArray(p?.tags) && p.tags.some((t) => String(t).toLowerCase() === 'do-not-contact');

export function doorTitle(door) {
  if (!door?.address) return 'Unaddressed pin';
  return door.unit ? `${door.unit} – ${door.address}` : door.address;
}

// Optimistic edits to the map's ['doors'] cache so pins and the card react
// before the refetch lands. fn gets the cached { persons, signs, unlocated }.
// Any in-flight doors fetch started before this write would land with the
// old data and undo the patch, so cancel it; the post-write invalidate
// refetches anyway.
export function patchDoors(queryClient, fn) {
  queryClient.cancelQueries({ queryKey: ['doors'] });
  queryClient.setQueryData(['doors'], (d) => (d ? fn(d) : d));
}

// The shape /api/map/doors returns for a person, from a person.create result.
const doorPerson = (p, fallback = {}) => ({
  id: p.id,
  name: p.name,
  phone: p.phone ?? null,
  email: p.email ?? null,
  address: p.address ?? fallback.address ?? null,
  house_number: p.house_number ?? fallback.house_number ?? null,
  unit: p.unit ?? fallback.unit ?? null,
  lat: p.lat ?? fallback.lat,
  lng: p.lng ?? fallback.lng,
  rating: null,
  rated_at: null,
  tags: p.tags || [],
});

// Everything that can change when a door is touched. ['person'] as a prefix,
// not just ['person', id]: every profile also lists its household (name +
// rating), so rating or adding someone here changes their housemates' pages.
// ['turfs'] / ['turf', id]: turf stats (doors done, rated) and the walk
// list's done ticks come from contacts and ratings, and a new door lands in
// whichever turf it falls inside.
// Only mounted queries refetch; the rest are just marked stale.
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['doors', 'persons', 'person', 'signs', 'contacts', 'brief', 'turfs', 'turf']) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

// "Mary Anne" + "Example" → "Mary Anne Example": the whole name every screen reads.
export const joinName = (f) => [f.first, f.last].map((x) => String(x || '').trim()).filter(Boolean).join(' ');

function PersonFields({ idPrefix, form, set, focusName = true }) {
  const [more, setMore] = useState(false);
  return (
    <>
      <div className="form-row door-names">
        <div className="field">
          <label htmlFor={`${idPrefix}-first`}>First name</label>
          <input id={`${idPrefix}-first`} className="input" autoFocus={focusName} maxLength={150} autoComplete="off" value={form.first} onChange={set('first')} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-last`}>Last name</label>
          <input id={`${idPrefix}-last`} className="input" maxLength={150} autoComplete="off" value={form.last} onChange={set('last')} />
        </div>
      </div>
      {more || form.phone ? (
        <div className="field">
          <label htmlFor={`${idPrefix}-phone`}>Phone</label>
          <input id={`${idPrefix}-phone`} className="input" type="tel" inputMode="tel" maxLength={40} autoComplete="off" autoFocus={more && !form.phone} value={form.phone} onChange={set('phone')} />
        </div>
      ) : (
        <button type="button" className="door-form__more disclose disclose--inline" aria-expanded={false} onClick={() => setMore(true)}>Phone</button>
      )}
    </>
  );
}

// "Wants a sign?" — the door's signs as chips, then one button per kind the
// door doesn't have yet (requested or up). onAsk(kind) files the request.
export function SignAsk({ signs = [], disabled = false, onAsk, idPrefix = 'door' }) {
  const have = new Set(signs.filter((s) => s.status !== 'removed').map((s) => s.kind));
  const offer = SIGN_BUTTONS.filter((s) => !have.has(s.code));
  const labelId = `${idPrefix}-sign-label`;
  return (
    <div className="door-more__sec">
      <span className="door-more__label" id={labelId}>{offer.length ? 'Wants a sign?' : 'Signs'}</span>
      {signs.length > 0 && (
        <div className="door-signs-have">
          {signs.map((s) => (
            <span key={s.id} className={`chip ${s.pending ? 'fk-wait' : SIGN_CHIP[s.status] || ''}`} title={SIGN_LABEL[s.kind]}>
              {SIGN_LABEL[s.kind]} · {s.pending ? 'Not sent yet' : SIGN_STATUS[s.status] || s.status}
            </span>
          ))}
        </div>
      )}
      {offer.length > 0 && (
        <div className="door-sign-btns" role="group" aria-labelledby={labelId}>
          {offer.map((s) => (
            <button
              key={s.code} type="button" className="btn door-act" disabled={disabled}
              title={`Request a ${SIGN_LABEL[s.code].toLowerCase()}`}
              aria-label={`Request a ${SIGN_LABEL[s.code].toLowerCase()}`}
              onClick={() => onAsk(s.code)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline "add person at this door": name (+ phone). person.addAtDoor — the
// server gives them the door's address, unit and pin, copied from someone
// already there (one the server has, when there is one: an item still on the
// phone is sent first anyway). onDone(id, person): person is null while it
// waits on the phone. toastQueued: how the screen says "saved on the phone".
export function AddPersonInline({ door, onDone, onCancel, toast, toastQueued = toast }) {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  const [form, setForm] = useState({ first: '', last: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!joinName(form)) { setError('Add a name'); return; }
    setBusy(true);
    setError(null);
    try {
      // Through the outbox: no signal, it's saved here and the door shows it
      // (meta.door: where the server will put them).
      const name = joinName(form);
      const housemate = door.persons.find((p) => !p.pending) || door.persons[0];
      const r = await queueAction('person.addAtDoor', {
        housemate_id: housemate.id,
        name,
        first_name: form.first.trim() || undefined,
        last_name: form.last.trim() || undefined,
        phone: form.phone.trim() || undefined,
      }, { who: name, door: { address: door.address ?? null, unit: door.unit ?? null, lat: door.lat, lng: door.lng } });
      if (r.queued) { toastQueued(queuedText(r, name)); onDone(r.client_id, null); return; }
      const res = r.result;
      toast(`Added ${res.person.name}`);
      patchDoors(queryClient, (d) => ({
        ...d,
        persons: [...d.persons.filter((p) => p.id !== res.person.id), doorPerson(res.person, door)],
      }));
      refresh();
      onDone(res.person.id, res.person);
    } catch (err) {
      const msg = refusalMsg(err, 'Not saved — try again');
      setError(msg);
      if (offlineError(err)) toast(msg);
      setBusy(false);
    }
  };

  return (
    <form className="door-form door-form--inline" onSubmit={submit} aria-label="Add a person at this door">
      <PersonFields idPrefix="dp" form={form} set={set} />
      {error && <p className="error">{error}</p>}
      <div className="door-form__actions">
        <button type="submit" className="btn door-act" disabled={busy}>Save person</button>
        <button type="button" className="btn btn-quiet door-act" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// A brand-new door: its address first. Picking one of the doors the box
// offers (AddressField) fills it in and drops the pin there, and the map
// goes to it (onPlace); a tap on the map drops or moves the pin by hand
// (latlng). A typed address nobody picked is looked up when it's saved;
// with no signal, the pin is a tap.
const TAP_MAP = 'Couldn’t find that door on the map — tap the map where it is';
export function AddDoorForm({ latlng, onPlace, onDone, onCancel, toast, allowGoogle = false }) {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  const online = useOnline();
  const [form, setForm] = useState({ first: '', last: '', address: '', unit: '', phone: '', city: '', postal: '' });
  const [pinFrom, setPinFrom] = useState(null); // 'address' once a pick placed it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  // A tap on the map answers "tap the map" (and a pin already there means
  // it's never asked).
  useEffect(() => { if (latlng) setError((e) => (e === TAP_MAP ? null : e)); }, [latlng]);
  const shownError = error === TAP_MAP && latlng ? null : error;
  const typeAddress = (v) => {
    setForm((f) => ({ ...f, address: v, city: '', postal: '' }));
    // The pin came from the address they're now changing: it goes with it.
    if (pinFrom === 'address') { setPinFrom(null); onPlace?.(null); }
  };
  const picked = (s) => {
    setForm((f) => ({ ...f, address: s.address, unit: s.unit || f.unit, city: s.city || '', postal: s.postal || '' }));
    // Google's words the B.C. service couldn't place: the door needs a tap
    // (unless it has one already).
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) {
      if (!latlng) setError(TAP_MAP);
      return;
    }
    setPinFrom('address');
    setError(null);
    onPlace?.({ lat: s.lat, lng: s.lng });
  };

  const submit = async (e) => {
    e.preventDefault();
    // Whitespace passes `required`; the server trims names (→ 400) and a
    // blank address would make an unaddressed pin, not a door.
    if (!joinName(form) || !form.address.trim()) { setError('Add a name and address'); return; }
    setBusy(true);
    setError(null);
    let at = latlng;
    let { city, postal } = form;
    if (!at) {
      const found = online ? await lookupAddress(form.address) : null;
      if (!found) {
        setError(online ? 'Couldn’t find that address — pick one from the list, or tap the map where the door is' : 'No signal — tap the map where the door is');
        setBusy(false);
        return;
      }
      at = { lat: found.lat, lng: found.lng };
      city = city || found.city || '';
      postal = postal || found.postal || '';
      onPlace?.(at);
    }
    try {
      const name = joinName(form);
      const r = await queueAction('person.create', {
        name,
        first_name: form.first.trim() || undefined,
        last_name: form.last.trim() || undefined,
        address: form.address.trim(),
        unit: form.unit.trim() || undefined,
        city: city || undefined,
        postal: postal || undefined,
        phone: form.phone.trim() || undefined,
        lat: at.lat,
        lng: at.lng,
      }, { who: name });
      if (r.queued) { toast(queuedText(r, name)); onDone(r.client_id); return; }
      const res = r.result;
      toast(`Added ${res.person.name}`);
      patchDoors(queryClient, (d) => ({
        ...d,
        persons: [...d.persons.filter((p) => p.id !== res.person.id), doorPerson(res.person, at)],
      }));
      refresh();
      onDone(res.person.id);
    } catch (err) {
      const msg = refusalMsg(err, 'Not saved — try again');
      setError(msg);
      if (offlineError(err)) toast(msg);
      setBusy(false);
    }
  };

  return (
    <form className="door-card door-form" onSubmit={submit} aria-label="New door">
      <header className="mapsheet-head">
        <h2 className="mapsheet-title">New door</h2>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onCancel} aria-label="Close">✕</button>
      </header>
      <div className="door-form__body">
        <div className="form-row">
          <div style={{ flex: '3 1 200px' }}>
            <AddressField id="nd-address" value={form.address} onChange={typeAddress} onPick={picked} placed={Boolean(latlng)} required autoFocus
              allowGoogle={allowGoogle}
              placedText="Pinned on the map — tap the map to move it"
              hint={online ? 'Pick it from the list, or tap the map where it is' : 'tap the map where the door is'} />
          </div>
          <div className="field" style={{ flex: '1 1 80px' }}>
            <label htmlFor="nd-unit">Unit</label>
            <input id="nd-unit" className="input" maxLength={40} autoComplete="off" value={form.unit} onChange={set('unit')} />
          </div>
        </div>
        <PersonFields idPrefix="nd" form={form} set={set} focusName={false} />
        {shownError && <p className="error">{shownError}</p>}
        <div className="door-form__actions">
          <button type="submit" className="btn btn-primary door-act" disabled={busy}>Add door</button>
          <button type="button" className="btn btn-quiet door-act" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </form>
  );
}

// "Directions": the phone's Google Maps, from where it is to a place (a quiet
// link; no key, nothing from base.win goes to Google but the place).
export function Directions({ to, words, mode, className = 'btn btn-quiet door-act' }) {
  const href = directionsUrl(to, { mode });
  if (!href) return null;
  return (
    <a className={`${className} directions`} href={href} target="_blank" rel="noopener noreferrer"
      aria-label={`Directions to ${words || to.address || 'this place'} in Google Maps`}>Directions</a>
  );
}

// Mount with key={door.key} so per-door state (optimistic ratings, pending
// call log, note) resets naturally when the user moves to another door.
// canAddHere: "+ Person at this door" (desk: anywhere; a volunteer: a door in a turf they walk).
export default function DoorCard({ door, selectedId, onSelect, onClose, toast, me, canCreate = true, canAddHere = canCreate }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  // The profile's back link reads this: "← Map", back to this door (the URL
  // carries ?person=, so the card opens again).
  const fromHere = { from: { to: `${location.pathname}${location.search}`, label: 'Map' } };
  const refresh = useRefresh();
  const rateRef = useRef(null);
  const [local, setLocal] = useState({});     // optimistic ratings by person id
  const [pending, setPending] = useState(null); // { id, channel } after a tel:/sms: tap
  const [channel, setChannel] = useState('door');
  const [note, setNoteState] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [more, setMore] = useState(false);
  // true / false, or null while nobody knows: then the Calls card, never a guess.
  const on = textingOn(useTextingStatus(me));
  // Whether Undo on a sign request can really cancel it (sign.cancel).
  useEffect(() => { queryClient.prefetchQuery(ACTIONS_QUERY); }, [queryClient]);

  const persons = door.persons;
  const sel = persons.find((p) => p.id === selectedId) || persons[0];
  // A knock on them still on this phone: the rating shown isn't on the server yet.
  const outbox = useOutbox();
  const knockWaiting = Boolean(sel) && outbox.items.some((i) => i.state === 'pending' && i.name === 'contact.log' && i.input?.person_id === sel.id);
  const waitChip = sel?.pending ? 'Not sent yet' : knockWaiting ? queuedChip() : null;
  const ratingOf = (p) => (p.id in local ? local[p.id] : p.rating);
  const noteText = note.trim();
  const multi = persons.length > 1;
  // The active door survey's questions for the selected person (answers ride along with the next tap).
  const survey = useSurvey({ context: 'door', personId: sel?.id, lat: door.lat, lng: door.lng });
  const scale = useScale();

  // The note lives in a ref too, so closing the card (unmount) can still send
  // it. A note that goes out with a tap is cleared at once (and put back if
  // the server refuses), so it can never be sent twice.
  const noteRef = useRef('');
  const setNote = (v) => { noteRef.current = v; setNoteState(v); };
  const latest = useRef(null);
  useLayoutEffect(() => { latest.current = { sel, channel, toast, refresh, multi, survey }; });
  const sendNote = async (person, via, text, { toast: say, refresh: reload, multi: many, survey: asked }) => {
    const who = many ? `${firstName(person.name)} · ` : '';
    // After "Save answers" the note joins that same knock.
    const visitOf = asked?.visitOf(via);
    try {
      const r = await logContact({ person_id: person.id, channel: via, outcome: 'contacted', note: text, visit_of: visitOf }, { who: person.name });
      asked?.logged(r, { channel: via, outcome: 'contacted', visitOf });
      say(r.queued ? `${who}${queuedText(r, 'Note')}` : `${who}Note saved`);
      if (!r.queued) reload();
    } catch (err) {
      say(refusalMsg(err, 'Note not saved — try again'));
    }
  };
  // Card closed with a note still in the box: send it on its own. Sign-out
  // sends it first (holdNote), while the card is still open and it's theirs.
  const sendLeft = () => {
    const text = noteRef.current.trim();
    const ctx = latest.current;
    if (!text || !ctx?.sel) return null;
    noteRef.current = '';
    return sendNote(ctx.sel, ctx.channel, text, ctx);
  };
  useEffect(() => holdNote(() => { const sent = sendLeft(); if (sent) setNoteState(''); return sent; }), []);
  useEffect(() => () => { sendLeft(); }, []);
  // Another person at the door: their note is theirs, so send it first.
  const pickPerson = (id) => {
    const text = noteRef.current.trim();
    if (text && sel && id !== sel.id) {
      setNote('');
      sendNote(sel, channel, text, { toast, refresh, multi, survey });
    }
    onSelect(id);
  };

  // Optimistic rating on the card and on the pin (via the doors cache).
  const setRating = (person, code, ratedAt) => {
    setLocal((l) => ({ ...l, [person.id]: code }));
    patchDoors(queryClient, (d) => ({
      ...d,
      persons: d.persons.map((p) => (p.id === person.id ? { ...p, rating: code, rated_at: ratedAt } : p)),
    }));
  };

  // A tel:/sms: tap: remember it (for the one-tap log) and switch the channel.
  const startReach = (p, via) => {
    setPending({ id: p.id, channel: via });
    setChannel(via);
    if (sel?.id !== p.id) onSelect(p.id);
  };
  const backToDoor = () => { setPending(null); setChannel('door'); };

  const log = async (person, via, outcome, rating = null) => {
    if (busy) return;
    setBusy(true);
    const prev = { code: ratingOf(person), at: person.rated_at ?? null };
    if (rating) setRating(person, rating, new Date().toISOString());
    const sentNote = noteRef.current.trim();
    if (sentNote) setNote('');
    const answers = outcome === 'contacted' && person.id === sel?.id ? survey.take() : [];
    // After "Save answers" this tap finishes that same knock (one per visit).
    const visitOf = person.id === sel?.id ? survey.visitOf(via) : undefined;
    try {
      // The outbox: sends now when there's signal, saves on the phone when
      // there isn't (and replays exactly once — the server dedupes on its id).
      const r = await logContact({
        person_id: person.id,
        channel: via,
        outcome,
        rating: rating || undefined,
        note: sentNote || undefined,
        answers: answers.length ? answers : undefined,
        visit_of: visitOf,
      }, { who: person.name });
      if (person.id === sel?.id) survey.logged(r, { channel: via, outcome, rating, answers, visitOf });
      if (pending) backToDoor(); // the call/text is logged — the next tap is back at the door
      // Append-only: "Change" brings the rating row back; the next tap logs the fix.
      const change = { label: 'Change', onClick: () => focusRating(rateRef.current) };
      if (r.queued) {
        // Keep the optimistic rating; Shell refreshes everything once the
        // outbox sends. Refetching now would only pause (offline) or fail.
        const saidQ = rating ? `Rated ${ratingText(scale, rating)}`
          : outcome !== 'contacted' ? OUTCOME_LABEL[outcome]
            : sentNote ? 'Note' : ({ phone: 'Call', text: 'Text' })[via] || null;
        toast(`${multi ? `${firstName(person.name)} · ` : ''}${queuedSaid(r, saidQ, answers.length ? answersWord(answers.length) : null)}`, change);
        return;
      }
      const who = multi ? `${firstName(person.name)} · ` : '';
      const what = rating
        ? `Rated ${ratingText(scale, rating)}`
        : outcome === 'contacted'
          ? (via === 'door' ? 'Note saved' : via === 'phone' ? 'Call logged' : 'Text logged')
          : `${OUTCOME_LABEL[outcome]}${via !== 'door' ? ` (${via})` : ''}`;
      const only = answers.length && !rating && !sentNote && via === 'door';
      toast(`${who}${only ? answersSaid(answers, r.result) : `${what}${answersTail(answers, r.result)}`}`, change);
      refresh();
    } catch (err) {
      // Only a refusal lands here (bad input, no permission) — network
      // trouble is queued above, never thrown.
      survey.restore(answers);
      if (rating) setRating(person, prev.code, prev.at);
      if (sentNote && !noteRef.current) setNote(sentNote);
      toast(refusalMsg(err, 'Not saved — try again'));
    } finally {
      setBusy(false);
    }
  };

  const placeSign = async (kind) => {
    if (!sel || busy) return;
    setBusy(true);
    try {
      // Through the outbox (client_id: a replay is the same request).
      const r = await queueAction('sign.place', {
        person_id: sel.id,
        kind,
        lat: door.lat,
        lng: door.lng,
        address: door.address || undefined,
      }, { who: sel.name });
      if (r.queued) {
        // The map shows it from the outbox ("Not sent yet"); Undo takes it back.
        toast(queuedText(r, SIGN_LABEL[kind]), { label: 'Undo', onClick: () => undoQueuedSign(r.client_id, kind) });
        return;
      }
      const res = r.result;
      const sign = res?.sign;
      // Undo only where the server can truly take it back; never by filing
      // the request as "taken down".
      const canCancel = await signCancelOffered(queryClient);
      toast(`${SIGN_LABEL[kind]} requested`, sign?.id && canCancel ? { label: 'Undo', onClick: () => undoSign(sign) } : null);
      if (sign?.id) {
        patchDoors(queryClient, (d) => ({
          ...d,
          signs: [...(d.signs || []).filter((s) => s.id !== sign.id), { ...sign, lat: door.lat, lng: door.lng }],
        }));
      }
      refresh();
    } catch (err) {
      toast(refusalMsg(err, 'Not saved — try again'));
    } finally {
      setBusy(false);
    }
  };

  // The toast's Undo: sign.cancel takes the request back — gone from the map,
  // the sign crew's list, Today and every count. A sign already put up is
  // refused (409) and the toast says so. Runs after the card closed too.
  const undoSign = async (sign) => {
    const label = SIGN_LABEL[sign.kind] || 'Sign';
    const drop = () => patchDoors(queryClient, (d) => ({ ...d, signs: (d.signs || []).filter((s) => s.id !== sign.id) }));
    try {
      // No signal: the cancel waits on the phone (the map hides the sign meanwhile).
      const r = await queueAction('sign.cancel', { id: sign.id }, { who: sel?.name });
      if (r.queued) { toast(queuedText(r, 'Undo')); return; }
      drop();
      toast(`${label} cancelled`);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Already gone (a second Undo, or cancelled elsewhere).
        drop();
        toast(`${label} already cancelled`);
        refresh();
        return;
      }
      toast(refusalMsg(err, 'Not undone — try again'));
    }
  };
  // Undo on a request still on the phone: take it off the phone, or — if it
  // may already have gone — send its cancel after it.
  const undoQueuedSign = (cid, kind) => {
    const label = SIGN_LABEL[kind] || 'Sign';
    const u = undoQueued(cid);
    if (u === 'removed') toast(`${label} cancelled`);
    else if (u === 'queued') toast(queuedText({}, 'Undo'));
    else if (u?.sent?.sign?.id) undoSign(u.sent.sign);
    else toast(`${label} already sent`);
  };

  const smsBody = (p) =>
    `Hi ${firstName(p.name)}, it's ${me?.user?.name || 'a volunteer'} with ${me?.workspace?.name || 'the campaign'}.`;

  const dnc = isDnc(sel);
  const moreId = `door-more-${sel?.id || 'none'}`;

  return (
    <aside className="door-card" aria-label={`Door: ${doorTitle(door)}`}>
      <header className="mapsheet-head">
        <div className="door-head">
          <h2 className="mapsheet-title door-head__name">
            {multi ? doorTitle(door) : sel?.name}
            {!multi && dnc && <span className="chip chip-danger door-dnc">Do not contact</span>}
            {!multi && waitChip && <span className="chip fk-wait door-dnc">{waitChip}</span>}
          </h2>
          {!multi && <span className="door-head__addr">{doorTitle(door)}</span>}
        </div>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close door card">✕</button>
      </header>

      {sel && (
        <section className="door-rate" ref={rateRef} aria-label={`Rate ${sel.name}`}>
          <PersonTabs persons={persons} value={sel.id} onPick={pickPerson} ratingOf={ratingOf} />
          {multi && dnc && <p className="door-dnc-line"><span className="chip chip-danger">Do not contact</span> {firstName(sel.name)}</p>}
          {multi && waitChip && <p className="door-dnc-line"><span className="chip fk-wait">{waitChip}</span> {firstName(sel.name)}</p>}
          <KnowMeChip person={sel} me={me} />
          {channel !== 'door' && (
            <p className="door-via">
              <span className="chip fk-wait">{CHANNEL_CHIP[channel]}</span>
              <button type="button" className="fk-link" onClick={backToDoor}>At the door instead</button>
            </p>
          )}
          {!dnc && <ScriptLine context={channel === 'door' ? 'door' : 'phone'} person={sel} />}
          <RatingButtons
            key={sel.id}
            value={ratingOf(sel)}
            disabled={busy}
            onPick={(code) => log(sel, channel, 'contacted', code)}
          />
          <VotedRow person={sel} source={channel === 'phone' ? 'phone' : 'door'} toast={(text, o) => toast(text, o?.act || null)} onMarked={refresh} />
          <OutcomeButtons items={channel === 'door' ? [...OUTCOMES, LIT] : OUTCOMES} disabled={busy} onPick={(code) => log(sel, channel, code)} />
          <SurveyQuestions key={`questions-${sel.id}`} survey={survey} disabled={busy} onSave={() => log(sel, channel, 'contacted')} />
        </section>
      )}

      {sel && (
        <More id={moreId} open={more} onToggle={() => setMore((m) => !m)}>
          <div className="field door-note">
            <label htmlFor="door-note" className="fk-sr">Note</label>
            <textarea
              id="door-note"
              className="input"
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onFocus={() => toast(null)}
              placeholder="Note"
            />
            {noteText && (
              <button type="button" className="btn door-act door-note__only" disabled={busy} onClick={() => log(sel, channel, 'contacted')}>
                Save note
              </button>
            )}
          </div>

          <div className="door-more__row">
            {sel.phone ? (
              <>
                {noCalls(sel) ? <span className="chip chip-danger">{noCallsWord(sel)}</span> : on.voice === false
                  ? <a className="btn door-act" href={telHref(sel.phone)} onClick={() => startReach(sel, 'phone')}>Call</a>
                  : <Link className="btn door-act" to={callsCard(sel, 'phone')}>Call</Link>}
                {!noTexts(sel) && (on.sms === false
                  ? <a className="btn door-act" href={smsHref(sel.phone, smsBody(sel))} onClick={() => startReach(sel, 'text')}>Text</a>
                  : <Link className="btn door-act" to={callsCard(sel, 'text')}>Text</Link>)}
              </>
            ) : null}
            {/* One look with Call and Text, in the same row. */}
            <Directions to={{ lat: door.lat, lng: door.lng, address: door.address, city: sel.city }} words={doorTitle(door)} mode="walking" className="btn door-act" />
            {sel.phone ? <span className="door-more__phone mono">{sel.phone}</span> : <span className="muted door-more__phone">No phone</span>}
          </div>
          {!sel.pending && (
            <QuickDetails key={`qd-${sel.id}`} person={sel} me={me} toast={toast}
              onSaved={(next) => {
                patchDoors(queryClient, (d) => ({ ...d, persons: d.persons.map((p) => (p.id === next.id ? { ...p, name: next.name, phone: next.phone, email: next.email ?? p.email } : p)) }));
                refresh();
              }} />
          )}
          {!sel.pending && <RequestAsk person={sel} toast={toast} />}
          {pending?.id === sel.id && (
            <div className="door-loglink" role="group" aria-label={`Log this ${pending.channel === 'phone' ? 'call' : 'text'}`}>
              <span className="door-loglink__label">Log this {pending.channel === 'phone' ? 'call' : 'text'}</span>
              <button type="button" className="btn door-act" disabled={busy} onClick={() => log(sel, pending.channel, 'contacted')}>Reached</button>
              <button type="button" className="btn door-act" disabled={busy} onClick={() => log(sel, pending.channel, 'no_answer')}>No answer</button>
              <button type="button" className="btn btn-quiet door-act" onClick={backToDoor}>Skip</button>
            </div>
          )}

          <SignAsk signs={door.signs} disabled={busy} onAsk={placeSign} />

          {canAddHere && door.address && (
            adding ? (
              <AddPersonInline
                door={door}
                toast={toast}
                onCancel={() => setAdding(false)}
                onDone={(id) => { setAdding(false); pickPerson(id); }}
              />
            ) : (
              <button type="button" className="btn door-act door-add-btn" onClick={() => setAdding(true)}>
                + Person at this door
              </button>
            )
          )}

          <div className="door-more__sec">
            <span className="door-more__label" id="door-channel-label">How you reached them</span>
            <div className="door-channel" role="radiogroup" aria-labelledby="door-channel-label">
              {CHANNEL_BUTTONS.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  role="radio"
                  aria-checked={channel === c.code}
                  className={`door-channel__btn${channel === c.code ? ' is-on' : ''}`}
                  onClick={() => setChannel(c.code)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <IKnowThem key={`know-${sel.id}`} person={sel} me={me} />

          <div className="door-more__foot">
            {!sel.pending && <Link className="btn btn-quiet door-act" to={`/people/${sel.id}`} state={fromHere}>Profile</Link>}
            {sel.rated_at && <span className="muted mono door-more__when">Rated {localDate(sel.rated_at)}</span>}
          </div>
        </More>
      )}
    </aside>
  );
}
