// Person profile. Top: name, rating, donor tier (desk), and Call · Text ·
// Email (desk) · Map. With the campaign's Twilio number connected, Call and
// Text open their card on Calls (the campaign's number, the STOP line, the
// Inbox, quiet hours) — never the phone's own dialler or Messages; Text is
// gone for anyone who opted out of texts. Then the rating card (one tap logs a contact; Call/Text
// set how it is logged, remembered per person for this tab so it survives a
// trip to the dialer). Everything else sits in sections that open on a tap —
// Details (their own note + edit live here), Tags, Roles, Signs, Shifts, Gifts
// and History (open by default). Volunteers see only what a door needs: Details
// (open), the rating card, one "Last contact" line and Signs. Their back link
// returns to wherever they came from (walk list, map, Calls).
import AddressField, { lookupAddress, pinOf } from '../components/AddressField.jsx';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams, useOutletContext, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VOLUNTEER_ROLES, SUGGESTED_TAGS,
  SIGN_KINDS, SIGN_STATUSES, DONOR_TIERS,
} from '@starbase/shared/canvass';
import { ratingByCode } from '@starbase/shared/scale';
import { SLATES as FALLBACK_SLATES, slateLabel } from '@starbase/shared/canvass';
import { placeLabel } from '@starbase/shared/shiftkinds';
import { whenText, zoneOf } from '../components/shiftTime.js';
import RatingButtons, { OUTCOMES, OutcomeButtons, RatingChip, focusRating, ratingSay, ratingText, useScale } from '../components/RatingButtons.jsx';
import SurveyQuestions, { PersonAnswers, answersTail, usePersonAnswers, useSurvey } from '../components/SurveyQuestions.jsx';
import { apiGet, fmtMoney, fmtDate, noAnswer } from '../api.js';
import { EngagementChip, PersonLadders, usePersonLadders } from '../components/LaddersBits.jsx';
import { queuedText, useThisDevice } from '../components/queued.js';
import { PersonFields, filledCount, usePersonFields } from '../components/FieldsBits.jsx';
import { useOutbox, applyOutboxToProfile, pendingAbout, logContact, holdNote } from '../offline.js';
import { useOnline } from '../components/NoSignal.jsx';
import {
  TagEditor, Icon, useAction, fmtShort, telHref, smsHref, textBody,
  canDesk, invalidatePersonData, isDnc, noCalls, tagWord, noSignal,
} from './People.jsx';
import QuickDetails from '../components/QuickDetails.jsx';
import './people.css';
import {
  TextingPersonLink, callsCard, noTexts, textingOn, useTextingPerson, useTextingStatus,
} from '../components/TextingCard.jsx';
import { IKnowThem, KnowMeChip, KnowsNudge, PersonKnows, ProfileKeyTies, usePersonKnows } from '../components/RelationshipsBits.jsx';
import NameFields from '../components/NameFields.jsx';
import VoterNumber from '../components/VoterNumber.jsx';
import SocialsBlock, { SocialsTyped } from '../components/SocialsBlock.jsx';
import { PersonTimeline, timelineCount, usePersonTimeline } from '../components/PersonTimeline.jsx';
import EmailSheet, { gmailNotReadyLine, gmailReady, takeDraft, useGmail, useToast } from '../components/EmailSheet.jsx';
import { useGoogleReturn } from '../components/GoogleConnect.jsx';
import { googleWords } from '../components/google.js';

const TIER_LABEL = {
  superstar: DONOR_TIERS.superstar.label,
  star: DONOR_TIERS.star.label,
  monthly: 'Monthly donor',
  'one-time': 'Donor',
};
// Ink, not yellow: the brand yellow is only ever the screen's one primary button.
const TIER_CLASS = { superstar: 'chip pf-tier pf-tier--super', star: 'chip pf-tier', monthly: 'chip chip-ok', 'one-time': 'chip' };

const OUTCOME_LABEL = {
  contacted: 'Talked', no_answer: 'No answer', refused: 'Refused', moved: 'Moved', inaccessible: 'No access',
  left_lit: 'Left lit',
  left_message: 'Left message',
};
const CHANNEL_LABEL = { door: 'Door', phone: 'Phone', text: 'Text', in_person: 'In person', mainstreet: 'Mainstreeting', email: 'Email' };
// Email is logged at the desk only, and only as Talked, No answer or Refused
// (an email reaches no door: Moved and No access aren't its to say).
const EMAIL_OUTCOMES = OUTCOMES.filter((o) => o.code === 'no_answer' || o.code === 'refused');
// "Rated 2 · Lean yes", "Rated 4 · Locke" or "No answer" — the field's own words.
const contactWord = (scale, c) => (c.rating ? `Rated ${ratingText(scale, c.rating)}` : OUTCOME_LABEL[c.outcome] || c.outcome);

// How this person is being reached (Door · Phone · Text), per person, kept for
// this tab: a phone may reload the page after the dialer or messages app.
// Until one is picked: Door — except at a desk computer (no dialer), for
// someone with a phone and no door on the map, where it is a phone call.
const CHANNEL_KEY = 'starbase.person.channel';
const readChannels = () => {
  try { return JSON.parse(sessionStorage.getItem(CHANNEL_KEY) || '{}') || {}; } catch { return {}; }
};
const atDeskComputer = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: hover) and (pointer: fine)').matches);
const firstChannel = (person) => (atDeskComputer() && person?.phone && (person.lat == null || person.lng == null) ? 'phone' : 'door');
function useChannel(personId) {
  const [chans, setChans] = useState(readChannels);
  const saved = CHANNEL_LABEL[chans[personId]] ? chans[personId] : null;
  const setChannel = (c) => setChans((m) => {
    const next = { ...m, [personId]: c };
    try { sessionStorage.setItem(CHANNEL_KEY, JSON.stringify(next)); } catch { /* private mode: memory only */ }
    return next;
  });
  return [saved, setChannel];
}
const STATUS_CHIP = {
  assigned: 'chip', confirmed: 'chip chip-ok', declined: 'chip chip-danger', no_show: 'chip chip-danger', completed: 'chip',
  requested: 'chip chip-warn', installed: 'chip chip-ok', removed: 'chip chip-ghost',
};
// The Signs screen's words, for the chip and the switch.
const SIGN_STATUS_WORD = { requested: 'To put up', installed: 'Up', removed: 'Taken down' };
// A request that never went up is taken back (sign.cancel), not "taken down".
const SIGN_CANCEL = 'cancel';
// Most-asked first, like the door card.
const SIGN_ORDER = ['lawn', 'window', 'large', 'billboard'];
const SIGN_SHORT = { lawn: 'Lawn', window: 'Window', large: 'Large', billboard: 'Billboard' };
const SIGN_BUTTONS = [...SIGN_KINDS].sort((a, b) => SIGN_ORDER.indexOf(a.code) - SIGN_ORDER.indexOf(b.code));

// ─────────────────────────────────────────────────────────────────────────────
// A section that opens on a tap. Closed sections aren't rendered at all.
// ─────────────────────────────────────────────────────────────────────────────
function Section({ title, count, open, onToggle, children }) {
  const id = useId();
  // Its own address on the page ("pf-gifts"): History's entries lead here.
  return (
    <section className="pf-sec" id={`pf-${String(title).toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      <h2 style={{ margin: 0, fontSize: 'inherit' }}>
        <button type="button" className="pf-sec__btn disclose" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className="pf-sec__title">{title}</span>
          {count != null && count !== '' && <span className="pf-sec__count">{count}</span>}
        </button>
      </h2>
      {open && <div className="pf-sec__body" id={id}>{children}</div>}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Back: to the screen that opened this profile. People and Calls say who they
// are (router state); the door card and walk list just go back in history.
// Desks fall back to People; volunteers, who have no People list, to Today.
// ─────────────────────────────────────────────────────────────────────────────
function BackLink({ desk, className = 'eyebrow pf-back' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;
  const inApp = location.key !== 'default'; // opened from another Starbase screen
  if (from?.to) {
    return inApp
      ? <button type="button" className={className} onClick={() => navigate(-1)}>← {from.label || 'Back'}</button>
      : <Link to={from.to} className={className}>← {from.label || 'Back'}</Link>;
  }
  if (desk) return <Link to="/people" className={className}>← People</Link>;
  return inApp
    ? <button type="button" className={className} onClick={() => navigate(-1)}>← Back</button>
    : <Link to="/" className={className}>← Today</Link>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header: name, rating, donor tier, Call · Text · Email · Map
// ─────────────────────────────────────────────────────────────────────────────
function Header({ person, donor, me, desk, onLog, onEmail, contacted, level, onEdit, keyLine = null }) {
  const texting = useTextingStatus(me);
  // true / false, or null while nobody knows (no signal, nothing kept): then
  // the Calls card, which says so — never a guess at the phone's own apps.
  const on = textingOn(texting);
  const txPerson = useTextingPerson(person.id, Boolean(on.sms && person.phone));
  const canText = Boolean(person.phone) && !noTexts(person) && !txPerson.data?.opted_out;
  const scale = useScale();
  const r = ratingByCode(scale, person.rating);
  const named = r?.band === 'opposed' && r.code !== '4'; // "4 · Locke" says it all
  // The date of the rating only when no contact says it below.
  const when = contacted ? '' : fmtShort(person.rated_at);
  const email = desk && person.email; // volunteers phone and knock; email is desk work
  // Why they can't be emailed one to one (the server's reach rule; desk only).
  const emailWhy = desk ? person.email_why || null : null;
  const dnc = emailWhy === 'do_not_contact' || isDnc(person);
  const emailTile = Boolean(email) && !emailWhy && !dnc;
  // Gmail decides the tile before anything opens: ready → the sheet; else the
  // phone's own mail app, which presets "Reached by: Email".
  const gmail = useGmail(emailTile);
  const viaGmail = emailTile && gmailReady(gmail.data);
  const gmailLine = emailTile ? gmailNotReadyLine(gmail.data) : null;
  const tiles = Boolean(person.phone || emailTile);
  const located = person.lat != null && person.lng != null;
  // The donor tier chip already says Donor: the level chip never repeats it
  // ("Donor · Volunteer" → "Volunteer"; just "Donor" → no level chip).
  const tierShown = Boolean(donor?.tier && TIER_LABEL[donor.tier]);
  const shownLevel = level && tierShown && level.code === 'doer'
    ? { ...level, label: level.label.split(' · ').filter((w) => w !== 'Donor').join(' · ') }
    : level;
  return (
    <header className="pf-head">
      <BackLink desk={desk} />
      <div className="pf-title">
        <h1>
          {person.name}
          {person.kind === 'org' && <> <span className="chip chip-ghost">org</span></>}
        </h1>
        {desk && <button type="button" className="btn btn-quiet pp-btn pf-edit" onClick={onEdit}>Edit</button>}
      </div>
      <div className="pf-meta">
        {r && <RatingChip code={person.rating} who />}
        {(!r || !named || when) && (
          <span className="pf-word">
            {r ? <>{!named && ratingSay(scale, person.rating)}{when && <span className="pf-when">{named ? '' : ' · '}{when}</span>}</> : 'Not rated'}
          </span>
        )}
        {dnc && <span className="chip chip-danger">Do not contact</span>}
        {!dnc && noCalls(person) && <span className="chip chip-danger">Do not call</span>}
        {!dnc && emailWhy === 'do_not_email' && <span className="chip chip-danger">Do not email</span>}
        {!dnc && emailWhy === 'suppressed' && (
          <span className="chip chip-warn" title="The address bounced or reported spam — fix it under Edit">Email bounced</span>
        )}
        {desk && shownLevel?.label && <EngagementChip level={shownLevel} />}
        {/* In your own circle (My people on this phone): every role. */}
        <KnowMeChip person={person} me={me} />
        {/* donor is null for volunteers (the server hides money from them) */}
        {tierShown && (
          <span className={TIER_CLASS[donor.tier]} title={`${fmtMoney(donor.yearCents)} this year${Number(donor.monthlyCents) ? ` · ${fmtMoney(donor.monthlyCents)}/mo` : ''}`}>
            {TIER_LABEL[donor.tier]}
          </span>
        )}
      </div>
      {/* The ties that matter, at once (desk): "Knows Sofia Petrova Friend · Close · 2 more". */}
      {keyLine}
      {(tiles || person.address) && (
        <div className={`pf-acts${tiles ? '' : ' pf-acts--quiet'}`}>
          {person.phone && !noCalls(person) && (on.voice === false ? (
            <a className="btn pf-act" href={telHref(person.phone)} onClick={() => onLog('phone')}>
              <Icon name="phone" /> Call
            </a>
          ) : (
            <Link className="btn pf-act" to={callsCard(person, 'phone')}>
              <Icon name="phone" /> Call
            </Link>
          ))}
          {canText && (on.sms === false ? (
            <a className="btn pf-act" href={smsHref(person.phone, textBody(person, me))} onClick={() => onLog('text')}>
              <Icon name="text" /> Text
            </a>
          ) : (
            <Link className="btn pf-act" to={callsCard(person, 'text')}>
              <Icon name="text" /> Text
            </Link>
          ))}
          {emailTile && (viaGmail ? (
            <button type="button" className="btn pf-act" onClick={onEmail}>
              <Icon name="email" /> Email
            </button>
          ) : (
            <a className="btn pf-act" href={`mailto:${person.email}`} onClick={() => onLog('email')}>
              <Icon name="email" /> Email
            </a>
          ))}
          {person.address && (
            // Map selects ?person=<id>, and offers to place a pin when there is none
            // (person.locate is open to volunteers too). With no Call or Text
            // it's a quiet link, so the rating card stays the first big thing.
            <Link className={tiles ? 'btn pf-act' : 'btn btn-quiet pp-btn pf-maplink'} to={`/map?person=${person.id}`}
              title={located ? 'On the map' : 'No pin yet — place one on the map'}>
              <Icon name="map" /> {tiles ? 'Map' : located ? 'On the map' : 'Place on map'}
            </Link>
          )}
        </div>
      )}
      {gmailLine && <p className="gm-tileline">{gmailLine}</p>}
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rating card: big rating buttons + outcomes → contact.log. The channel is set
// by the Call / Text tiles (else Door); the manual switch sits under the note.
// ─────────────────────────────────────────────────────────────────────────────
function RatingCard({ person, refresh, channel, setChannel, cardRef, desk }) {
  const [note, setNoteState] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  // The note lives in a ref too, so leaving the profile can still send it
  // (as the door card does): a note that goes out with a tap is cleared at
  // once (and put back if it isn't saved), so it's never sent twice.
  const noteRef = useRef('');
  const setNote = (v) => { noteRef.current = v; setNoteState(v); };
  const latest = useRef(null);
  useLayoutEffect(() => { latest.current = { person, channel, refresh }; });
  const sendLeft = () => {
    const text = noteRef.current.trim();
    const ctx = latest.current;
    if (!text || !ctx?.person) return null;
    noteRef.current = '';
    // Through the outbox: with no signal it waits on this device.
    return logContact({ person_id: ctx.person.id, channel: ctx.channel, outcome: 'contacted', note: text }, { who: ctx.person.name })
      .then((r) => { if (!r.queued) ctx.refresh?.(); })
      .catch(() => { /* refused: nothing else to say on a screen that's gone */ });
  };
  // Sign-out sends it first (holdNote), while it's still theirs.
  useEffect(() => holdNote(() => { const sent = sendLeft(); if (sent) { setNoteState(''); setNoteOpen(false); } return sent; }), []);
  useEffect(() => () => { sendLeft(); }, []);
  // { text, what, queued }: the line under the buttons. A knock still in the
  // outbox says so, and the line turns to "✓ Sent" once the outbox empties.
  const [said, setSaid] = useState(null);
  const status = said?.text || '';
  const reachId = useId();
  const act = useAction(refresh);
  const outbox = useOutbox();
  const scale = useScale();
  useEffect(() => {
    if (!said?.queued || outbox.pending > 0 || outbox.flushing) return;
    setSaid(outbox.lastError
      ? { text: outbox.lastError, what: said.what, queued: false }
      : { text: `✓ Sent · ${said.what}`, what: said.what, queued: false });
  }, [said, outbox.pending, outbox.flushing, outbox.lastError]);
  // Contacts are kept as they were logged: "Change" (as on the field toasts)
  // brings you back to the rating row, and the next tap logs the fix.
  const change = () => { setSaid(null); focusRating(cardRef.current); };
  // The active survey's questions (door, or calls when reached by phone/text).
  const survey = useSurvey({ context: channel === 'door' ? 'door' : 'calls', personId: person.id, lat: person.lat, lng: person.lng });
  // Logged all the same (it happened), with the reason they shouldn't have been emailed in view.
  const emailWarn = person.email_why === 'do_not_contact' || isDnc(person) ? 'Do not contact'
    : person.email_why === 'do_not_email' ? 'Do not email' : null;

  const log = async (outcome, rating) => {
    const answers = outcome === 'contacted' ? survey.take() : [];
    // After "Save answers" the next tap finishes that same contact.
    const visitOf = survey.visitOf(channel);
    const sentNote = noteRef.current.trim();
    if (sentNote) noteRef.current = '';
    const res = await act.run('contact.log', {
      person_id: person.id, channel, outcome, rating: rating || undefined, note: sentNote || undefined,
      answers: answers.length ? answers : undefined, visit_of: visitOf,
    }, { who: person.name });
    if (!res) { survey.restore(answers); if (sentNote) setNote(note); }
    if (res) {
      survey.logged(res, { channel, outcome, rating, answers, visitOf });
      setNote('');
      setNoteOpen(false);
      // Not reached yet: the door card's words ("Saved on this phone — sends soon").
      const what = `${CHANNEL_LABEL[channel]} · ${contactWord(scale, { rating, outcome })}${answersTail(answers, res.result)}`;
      setSaid({ text: res.queued ? `${queuedText(res)} · ${what}` : `✓ ${what}`, what, queued: Boolean(res.queued) });
    }
  };

  return (
    <section className="card pf-rate" ref={cardRef} aria-label="Rate">
      <RatingButtons value={person.rating} onPick={(code) => log('contacted', code)} disabled={act.busy} />
      <OutcomeButtons items={channel === 'email' ? EMAIL_OUTCOMES : OUTCOMES} onPick={(o) => log(o)} disabled={act.busy} />
      {channel === 'email' && emailWarn && <p className="gm-warn"><span className="chip chip-danger">{emailWarn}</span></p>}
      <SurveyQuestions key={`questions-${person.id}`} survey={survey} disabled={act.busy} onSave={() => log('contacted')} />
      <div className="pf-rate__foot">
        {noteOpen ? (
          <div className="field pf-note">
            <label htmlFor="contact-note">Note — saved with your next tap</label>
            <input id="contact-note" className="input" autoFocus maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Wants a lawn sign" />
          </div>
        ) : (
          <button type="button" className="btn btn-quiet pp-btn pf-note-btn" onClick={() => setNoteOpen(true)}>+ Add a note</button>
        )}
        <div className="pf-reach">
          <span className="eyebrow" id={reachId}>Reached by</span>
          <div className="channel-toggle pf-channel" role="group" aria-labelledby={reachId}>
            {(desk ? ['door', 'phone', 'text', 'email'] : ['door', 'phone', 'text']).map((c) => (
              <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>{CHANNEL_LABEL[c]}</button>
            ))}
          </div>
        </div>
      </div>
      {act.error ? <p className="error" role="alert">{act.error}</p> : (
        <div className="pf-status-row">
          <p className="pf-status" role="status">{status}</p>
          {status && <button type="button" className="btn btn-quiet pp-btn pf-change" onClick={change}>Change</button>}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Details: contact lines, socials, household, and Edit
// ─────────────────────────────────────────────────────────────────────────────
// The whole form at once, opened from the header's Edit or Details' "Edit
// details" (focus: the field to start in). Only what changed is sent, so a
// change someone else made meanwhile to another field stands. The address is
// one line with the doors it matches under it (AddressField): a pick moves
// the pin with the save; a new address nobody picked is looked up when it's
// saved, and the server keeps looking if it can't be found yet.
const EDIT_KEYS = ['kind', 'phone', 'email', 'address', 'unit', 'city', 'postal'];
// A record from before the parts were kept: the first word is the first
// name, the last the last name (as the server splits, ext/names).
const splitName = (name) => {
  const w = String(name || '').trim().replace(/\s+/g, ' ').split(' ');
  return w.length > 1 ? [w[0], w.slice(1, -1).join(' '), w[w.length - 1]] : [w[0] || '', '', ''];
};
function EditDetailsForm({ person, refresh, onClose, focus = 'name' }) {
  const [first0, middle0, last0] = person.first_name != null || person.last_name != null || person.middle_name != null
    ? [person.first_name || '', person.middle_name || '', person.last_name || ''] : splitName(person.name);
  const start = {
    name: person.name || '', first: first0, middle: middle0, last: last0, kind: person.kind || 'person', phone: person.phone || '', email: person.email || '',
    address: person.address || '', unit: person.unit || '', city: person.city || '', postal: person.postal || '',
  };
  const [form, setForm] = useState(start);
  const [pin, setPin] = useState(null); // { lat, lng } from a picked address
  const act = useAction(refresh, { needsSignal: true });
  const formRef = useRef(null);
  useEffect(() => { formRef.current?.scrollIntoView?.({ block: 'nearest' }); }, []);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const v = (s) => (s && s.trim() ? s.trim() : null);
  const moved = v(form.address) !== v(start.address) || v(form.unit) !== v(start.unit);
  const located = person.lat != null && person.lng != null;

  const submit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of EDIT_KEYS) {
      const next = k === 'kind' ? form[k].trim() : v(form[k]);
      const was = k === 'kind' ? start[k].trim() : v(start[k]);
      if (next !== was) patch[k] = next;
    }
    // Names: a person's first and last (the whole follows on the server); an
    // organization's one name.
    if (form.kind === 'org') {
      if (form.name.trim() !== start.name.trim() || patch.kind) patch.name = form.name.trim() || [form.first, form.middle, form.last].map((x) => x.trim()).filter(Boolean).join(' ');
    } else if (form.first.trim() !== start.first.trim() || form.middle.trim() !== start.middle.trim() || form.last.trim() !== start.last.trim() || patch.kind) {
      if (!form.first.trim() && !form.middle.trim() && !form.last.trim()) return;
      patch.first_name = form.first.trim() || null;
      patch.middle_name = form.middle.trim() || null;
      patch.last_name = form.last.trim() || null;
    }
    if (!Object.keys(patch).length) { onClose(); return; }
    if ('address' in patch) patch.house_number = null; // the number is read off the line
    let at = moved ? pin : null;
    if (moved && !at && patch.address) {
      const found = await lookupAddress(form.address);
      if (found) at = { lat: found.lat, lng: found.lng };
    }
    if (at) Object.assign(patch, { lat: at.lat, lng: at.lng });
    const res = await act.run('person.update', { id: person.id, ...patch });
    if (!res) return;
    onClose(moved && patch.address && !at ? 'Saved — finding the new address on the map' : 'Saved');
  };

  const addrHint = !moved ? null
    : !form.address.trim() ? 'No address: the pin comes off the map'
      : located ? 'The pin moves to the new address when you save' : 'Found on the map when you save';

  const kindField = (
    <div className="field" style={{ flex: '0 1 150px' }}>
      <label htmlFor="ed-kind">Kind</label>
      <select id="ed-kind" className="input" value={form.kind} onChange={set('kind')}>
        <option value="person">Person</option>
        <option value="org">Organization</option>
      </select>
    </div>
  );
  return (
    <form className="inline-form pf-edit-form" onSubmit={submit} ref={formRef} aria-label="Edit details">
      {form.kind === 'org' ? (
        <div className="form-row">
          <div className="field">
            <label htmlFor="ed-name">Name</label>
            <input id="ed-name" className="input" required maxLength={300} autoFocus={focus === 'name'} value={form.name} onChange={set('name')} />
          </div>
          {kindField}
        </div>
      ) : (
        <>
          <NameFields id="ed" form={form} setForm={setForm} autoFocus={focus === 'name'} />
          <div className="form-row">{kindField}</div>
        </>
      )}
      <div className="form-row">
        <div className="field">
          <label htmlFor="ed-phone">Phone</label>
          <input id="ed-phone" className="input mono" type="tel" inputMode="tel" maxLength={40} autoFocus={focus === 'phone'} value={form.phone} onChange={set('phone')} />
        </div>
        <div className="field">
          <label htmlFor="ed-email">Email</label>
          <input id="ed-email" className="input" type="email" maxLength={320} autoFocus={focus === 'email'} value={form.email} onChange={set('email')} />
        </div>
      </div>
      <div className="form-row">
        <div style={{ flex: '3 1 220px' }}>
          <AddressField id="ed-address" value={form.address} autoFocus={focus === 'address'} placed={moved && Boolean(pin)}
            onChange={(val) => { setForm((f) => ({ ...f, address: val })); setPin(null); }}
            onPick={(a) => { setForm((f) => ({ ...f, address: a.address, unit: a.unit || f.unit, city: a.city || f.city, postal: a.postal || f.postal })); setPin(pinOf(a)); }}
            hint={addrHint} />
        </div>
        <div className="field" style={{ flex: '0 1 90px' }}>
          <label htmlFor="ed-unit">Unit</label>
          <input id="ed-unit" className="input" maxLength={40} value={form.unit} onChange={set('unit')} />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ed-city">City</label>
          <input id="ed-city" className="input" maxLength={120} value={form.city} onChange={set('city')} />
        </div>
        <div className="field" style={{ flex: '0 1 120px' }}>
          <label htmlFor="ed-postal">Postal</label>
          <input id="ed-postal" className="input mono" maxLength={20} value={form.postal} onChange={set('postal')} />
        </div>
      </div>
      {act.error && <p className="error">{act.error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary pp-btn" disabled={act.busy}>Save</button>
        <button type="button" className="btn btn-quiet pp-btn" onClick={() => onClose()}>Cancel</button>
      </div>
    </form>
  );
}

// editing: null, or the field the form opens on (the header's Edit, a tap on
// a line, or "Edit details" — the page holds it so the header can open it).
function Details({ person, household, refresh, desk, me, editing, setEditing }) {
  const [saved, setSaved] = useState(null);
  // The number dials from your own phone only when calls through the campaign are off.
  const ownDialler = textingOn(useTextingStatus(me)).voice === false;
  if (desk && editing) {
    return <EditDetailsForm key={editing} person={person} refresh={refresh} focus={editing} onClose={(said) => { setEditing(null); setSaved(said || null); }} />;
  }
  const addr = [
    [person.address, person.unit ? `#${person.unit}` : null].filter(Boolean).join(' '),
    [person.city, person.postal].filter(Boolean).join('  '),
  ].filter(Boolean);
  const none = <span className="muted">—</span>;

  return (
    <>
      <ul className="contact-lines">
        <li>
          <span className="k">Phone</span>
          <span className="v">{person.phone
            ? (ownDialler && !noCalls(person) ? <a className="mono" href={telHref(person.phone)}>{person.phone}</a> : <span className="mono">{person.phone}</span>)
            : none}</span>
        </li>
        {desk && (
          <li>
            <span className="k">Email</span>
            <span className="v">{person.email ? (person.email_why ? person.email : <a href={`mailto:${person.email}`}>{person.email}</a>) : none}</span>
          </li>
        )}
        {!desk && (
          <li className="contact-lines__fix">
            <span className="k" />
            <span className="v">
              <QuickDetails person={person} me={me} onSaved={() => refresh()} />
            </span>
          </li>
        )}
        <li>
          <span className="k">Address</span>
          <span className="v addr-lines">{addr.length ? addr.map((l, i) => <div key={i}>{l}</div>) : none}</span>
          {person.address && (
            <span className="act">
              <Link className="btn btn-quiet pp-btn" to={`/map?person=${person.id}`}>
                {person.lat != null && person.lng != null ? 'On map' : 'Place pin'}
              </Link>
            </span>
          )}
        </li>
      </ul>

      {person.note && (
        <div className="pf-their-note">
          <span className="eyebrow">Their note</span>
          <p>{person.note}</p>
        </div>
      )}

      {desk && <SocialsBlock person={person} refresh={refresh} />}

      {person.address && (desk || household.length > 0) && (
        <>
          <div className="card-head pf-sub"><span className="eyebrow">Same address</span></div>
          {household.length === 0
            ? <p className="pf-empty">No one else.</p>
            : (
              <ul className="list-plain">
                {household.map((h) => (
                  <li key={h.id}>
                    <Link to={`/people/${h.id}`}>{h.name}</Link>
                    {h.rating && <RatingChip code={h.rating} who />}
                  </li>
                ))}
              </ul>
            )}
        </>
      )}

      {/* About the person, not the phone: its own row at the end of Details. */}
      {!desk && <div className="pf-iknow"><IKnowThem person={person} me={me} /></div>}

      {desk && (
        <div className="pf-row-acts">
          {saved && <span className="pf-saved" role="status">✓ {saved}</span>}
          <button type="button" className="btn pp-btn" onClick={() => setEditing('name')}>Edit details</button>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tags, roles, signs, shifts, gifts, history
// ─────────────────────────────────────────────────────────────────────────────
function Tags({ person, refresh, desk }) {
  const [editing, setEditing] = useState(false);
  const act = useAction(refresh);
  const tags = Array.isArray(person.tags) ? person.tags : [];
  // Only what changed (person.tag): with no signal it waits on this device
  // and never undoes a tag someone else changed meanwhile.
  const save = (next) => {
    const add = next.filter((t) => !tags.includes(t));
    const remove = tags.filter((t) => !next.includes(t));
    if (add.length || remove.length) act.run('person.tag', { id: person.id, add, remove }, { who: person.name });
  };
  if (desk && editing) {
    return (
      <>
        <TagEditor
          tags={tags}
          suggestions={SUGGESTED_TAGS}
          disabled={act.busy}
          autoFocus
          onChange={save}
        />
        {act.error && <p className="error">{act.error}</p>}
        <div className="pf-row-acts">
          <button type="button" className="btn pp-btn" onClick={() => setEditing(false)}>Done</button>
        </div>
      </>
    );
  }
  return (
    <>
      {tags.length === 0
        ? <p className="pf-empty">No tags.</p>
        : (
          <div className="tag-chips">
            {tags.map((t) => (
              <Link key={t} to={`/people?tag=${encodeURIComponent(t)}`} className="chip pf-chip-link">{tagWord(t)}</Link>
            ))}
          </div>
        )}
      {desk && (
        <div className="pf-row-acts">
          <button type="button" className="btn pp-btn" onClick={() => setEditing(true)}>Edit tags</button>
        </div>
      )}
    </>
  );
}

function Roles({ person, roles, refresh, desk }) {
  const [role, setRole] = useState('');
  const [detail, setDetail] = useState('');
  const act = useAction(refresh, { needsSignal: true });
  const def = VOLUNTEER_ROLES.find((r) => r.code === role);
  const label = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label || code;

  const add = async (e) => {
    e.preventDefault();
    if (!role) return;
    const res = await act.run('volunteer.assign', { person_id: person.id, role, detail: detail.trim() || undefined });
    if (res) { setRole(''); setDetail(''); }
  };

  return (
    <>
      {roles.length === 0
        ? <p className="pf-empty">None yet.</p>
        : (
          <div className="role-chips">
            {roles.map((r) => (
              <span key={r.id} className="chip removable">
                {label(r.role)}{r.detail ? <span className="d"> · {r.detail}</span> : null}
                {desk && (
                  <button type="button" className="chip-x" aria-label={`Remove ${label(r.role)}`} disabled={act.busy}
                    onClick={() => act.run('volunteer.unassign', { id: r.id })}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
      {desk && (
        <form className="role-add" onSubmit={add}>
          <div className="field">
            <label htmlFor="role-pick">Add a role</label>
            <select id="role-pick" className="input" value={role} onChange={(e) => { setRole(e.target.value); setDetail(''); }}>
              <option value="">—</option>
              {VOLUNTEER_ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </div>
          {def?.detail && (
            <div className="field">
              <label htmlFor="role-detail">{def.detail}</label>
              <input id="role-detail" className="input" maxLength={200} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={def.detail} />
            </div>
          )}
          <button type="submit" className="btn pp-btn" disabled={!role || act.busy}>Add</button>
        </form>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}

function Signs({ person, signs, refresh, desk }) {
  const act = useAction(refresh, { needsSignal: true });
  // sign.cancel (GET /api/actions, same key as the door card): only then can a
  // request that never went up be taken back from here.
  const actions = useQuery({ queryKey: ['actions'], queryFn: () => apiGet('/actions'), staleTime: 5 * 60_000 });
  const canCancel = Array.isArray(actions.data?.actions) && actions.data.actions.includes('sign.cancel');
  const kindLabel = (k) => SIGN_KINDS.find((s) => s.code === k)?.label || k;
  // A sign goes to an address: with none on file there's nowhere to put it.
  const noAddress = !String(person.address || '').trim();
  const setStatus = (s, v) => (v === SIGN_CANCEL
    ? act.run('sign.cancel', { id: s.id })
    : act.run('sign.update', { id: s.id, status: v }));
  return (
    <>
      {signs.length === 0 && <p className="pf-empty">No signs yet.</p>}
      {signs.map((s) => {
        const cancelable = canCancel && s.status === 'requested';
        const options = cancelable ? ['requested', 'installed', SIGN_CANCEL] : SIGN_STATUSES;
        return (
          <div key={s.id} className="sign-row">
            <span>
              <strong>{kindLabel(s.kind)}</strong>
              {s.note ? <span className="muted"> · {s.note}</span> : null}
            </span>
            <span className="head-actions">
              <span className={STATUS_CHIP[s.status] || 'chip'}>{SIGN_STATUS_WORD[s.status] || s.status}</span>
              <select className="input" aria-label="Sign status" value={s.status} disabled={act.busy}
                onChange={(e) => setStatus(s, e.target.value)}>
                {options.map((st) => (
                  <option key={st} value={st}>{st === SIGN_CANCEL ? 'Cancel request' : SIGN_STATUS_WORD[st] || st}</option>
                ))}
              </select>
            </span>
          </div>
        );
      })}
      <div className="card-head pf-sub"><span className="eyebrow">Request a sign</span></div>
      <div className="pf-row-acts" style={{ marginTop: 0 }}>
        {SIGN_BUTTONS.map((k) => (
          <button key={k.code} type="button" className="btn pp-btn" disabled={act.busy || noAddress} title={k.label}
            onClick={() => act.run('sign.place', { kind: k.code, person_id: person.id })}>
            {SIGN_SHORT[k.code] || k.label}
          </button>
        ))}
      </div>
      {noAddress && (
        <p className="hint" style={{ marginTop: 'var(--s-2)' }}>
          {desk ? 'No address — add one under Details first.' : 'No address on file — ask your organizer.'}
        </p>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}

// A shift's time on the campaign's clock (tz), as every shift screen says it.
function Shifts({ shifts, tz }) {
  if (shifts.length === 0) {
    return <p className="pf-empty">None. <Link to="/shifts">See shifts</Link></p>;
  }
  return (
    <ul className="list-plain">
      {shifts.map((s) => (
        <li key={s.assignment_id}>
          <span>
            <Link to={`/shifts/${s.id}`}>{s.title}</Link>
            <br />
            <span className="muted mono" style={{ fontSize: 12 }}>{whenText(s.starts_at, tz)}{s.location ? ` · ${placeLabel(s.location)}` : ''}</span>
          </span>
          <span className={STATUS_CHIP[s.status] || 'chip'}>{String(s.status || '').replace('_', ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

const slatesOf = (me) => (Array.isArray(me?.org?.slates) && me.org.slates.length ? me.org.slates : FALLBACK_SLATES);
function Gifts({ person, gifts, totals, slates = FALLBACK_SLATES }) {
  return (
    <>
      {totals.length > 0 && (
        <div className="chip-row" style={{ margin: '0 0 var(--s-3)' }}>
          {/* total_cents is a sum()::bigint — may arrive as a string; fmtMoney coerces with Number() */}
          {totals.map((t) => (
            <span key={t.year} className="chip">
              {t.year} · <strong className="mono">{fmtMoney(Number(t.total_cents))}</strong>
            </span>
          ))}
        </div>
      )}
      {gifts.length === 0
        ? <p className="pf-empty">No gifts yet.</p>
        : (
          <ul className="pf-gifts">
            {gifts.map((g) => (
              <li key={g.id}>
                <span className="amt">{fmtMoney(g.amount_cents)}</span>
                <span className="when">{fmtDate(g.date)}</span>
                {g.method && <span className="chip">{g.method}</span>}
                {g.cadence === 'monthly'
                  ? <span className="chip chip-ok">monthly</span>
                  : <span className="chip chip-ghost">one-time</span>}
                {slates.length > 1 && g.slate && g.slate !== slates[0].code && <span className="chip" title="The slate this contribution is to">{slateLabel(g.slate, slates)}</span>}
                {g.flagged && <span className="chip chip-warn" title={g.flag_reason || ''}>flagged</span>}
                {g.source === 'import' && <span className="chip" title="Brought in from another tool’s file">Imported</span>}
                {g.note && <span className="note">{g.note}</span>}
              </li>
            ))}
          </ul>
        )}
      <div className="pf-row-acts">
        <Link className="btn pp-btn" to={`/money?new=1&person=${person.id}`}>Log a gift</Link>
      </div>
    </>
  );
}

// History is components/PersonTimeline.jsx: one list of everything. A
// contact still on this device goes to it in a row's words, as History has
// always said them ("Door · No answer", the note under it).
const waitingRow = (c) => ({
  id: c.id, at: c.created_at, pending: true, label: CHANNEL_LABEL[c.channel] || c.channel,
  title: OUTCOME_LABEL[c.outcome] || c.outcome, rating: c.rating || null, detail: c.note || null,
});

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────
export default function Person() {
  const { id } = useParams();
  const { me } = useOutletContext() ?? {};
  const desk = canDesk(me);
  const queryClient = useQueryClient();
  const [savedChannel, setChannel] = useChannel(id);
  // Desks open on the history; volunteers on phone + address.
  const location = useLocation();
  // "3 more" on the Calls card's key line opens their Knows (#knows).
  const [open, setOpen] = useState(() => (desk ? { history: true, ...(location.hash === '#knows' ? { knows: true } : {}) } : { details: true }));
  const [editing, setEditing] = useState(null); // the details form, open on this field (desk)
  const ratingRef = useRef(null);
  const toggle = (key) => () => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const scale = useScale();

  const profile = useQuery({
    queryKey: ['person', id],
    queryFn: () => apiGet(`/persons/${id}`),
  });
  const ladders = usePersonLadders(id, desk); // engagement level + ladders (desk only)
  const answers = usePersonAnswers(id, desk); // survey answers (desk only)
  const fields = usePersonFields(id); // profile fields (a volunteer gets only theirs)
  const knows = usePersonKnows(id, desk); // who they know (desk only)
  const history = usePersonTimeline(id, desk); // History: everything, newest first (desk only)
  // What's saved on this device and not sent yet (a rating, a note, tags) is
  // shown as it will be, and said once under the name.
  const outbox = useOutbox();
  const online = useOnline();
  const device = useThisDevice();
  // The "Email Jane Doe" sheet (Gmail): null, or { draft } while open.
  const [emailing, setEmailing] = useState(null);
  const toast = useToast();
  // Back from Google's connect page (the sheet's "Connect again"): what it
  // said, once, and the sheet reopened with what was written.
  const googleCode = useGoogleReturn();
  const gmail = useGmail(desk);
  useEffect(() => {
    if (googleCode) toast.show(googleWords(googleCode, { where: 'profile' }));
  }, [googleCode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!desk || emailing || !gmailReady(gmail.data)) return;
    const draft = takeDraft(id);
    if (draft) setEmailing({ draft });
  }, [desk, id, gmail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Awaited by useAction so controls stay disabled until the profile refetches.
  // Covers the map (['doors']: pins, ratings, unlocated count after an address
  // edit), signs, Today, housemates' profiles, and Outreach's press audience
  // (['blasts'].mediaContacts counts media-tagged people with an email).
  const refresh = () => invalidatePersonData(queryClient);

  // Call / Text at the top: preset the channel, bring the rating card into view.
  const onLog = (ch) => {
    setChannel(ch);
    ratingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // The sheet closed: sent from Gmail, or handed to the mail app ('mailto').
  const emailDone = (how) => {
    setEmailing(null);
    if (how === 'sent') toast.show('Sent from your Gmail');
    if (how) onLog('email');
  };
  // An entry in History that leads to a section here ("#gifts"): open it,
  // bring it into view, and put the keyboard on its heading.
  const openSection = (key) => {
    setOpen((o) => ({ ...o, [key]: true }));
    const sec = document.getElementById(`pf-${key}`);
    sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    sec?.querySelector('.pf-sec__btn')?.focus({ preventScroll: true });
  };

  const loaded = Boolean(profile.data?.person);
  useEffect(() => {
    if (loaded && desk && location.hash === '#knows') document.getElementById('pf-knows')?.scrollIntoView({ block: 'start' });
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  if (profile.isLoading) return <p className="muted">Loading…</p>;
  // No signal and never opened here: they're there, it just can't load yet.
  if (noSignal(profile)) {
    return (
      <div className="pf-page">
        <BackLink desk={desk} />
        <p className="pp-offline" role="status">No signal — this profile loads when you’re back online.</p>
      </div>
    );
  }
  if (profile.isError || !profile.data?.person) {
    // Only the server saying so means they're gone (a 502 mid-deploy doesn't).
    const gone = profile.error?.status === 404 || (!profile.isError && !profile.data?.person);
    return (
      <div className="pp-empty">
        <p>{gone ? 'No one here — they may have been removed.' : noAnswer(profile.error) ? 'No answer — check your signal' : profile.error.message}</p>
        {profile.error?.body?.merged_into && (
          <Link className="btn btn-primary pp-btn" to={`/people/${profile.error.body.merged_into}`} replace>Merged — open their record</Link>
        )}
        <BackLink desk={desk} className="btn pp-btn" />
      </div>
    );
  }
  // Volunteers get gifts: [], totals: [], donor: null from the server.
  const {
    person, gifts = [], totals = [], contacts = [], roles = [], signs = [], shifts = [], donor = null, household = [],
  } = applyOutboxToProfile(profile.data, outbox.items);
  const waiting = pendingAbout(outbox.items, person.id);
  // Contacts still on this device: History shows them first, "Not sent yet".
  const notSent = contacts.filter((c) => c.pending).map(waitingRow);
  // Ladders and Answers come with reads of their own (none with no signal):
  // History leads to a section only while it's on the page.
  const showLadders = desk && (ladders.data?.runs?.length > 0 || ladders.data?.followups?.length > 0);
  const showAnswers = desk && answers.data?.answers?.length > 0;
  const linkedSections = ['signs', 'gifts', ...(showLadders ? ['ladders'] : []), ...(showAnswers ? ['answers'] : [])];
  const tags = Array.isArray(person.tags) ? person.tags : [];
  const thisYear = totals.find((t) => String(t.year) === String(new Date().getFullYear()));
  const last = contacts[0];
  const channel = savedChannel || firstChannel(person);
  // The header already shows the rating: the line adds when and how.
  const lastWhat = last && (last.rating
    ? (last.rating === person.rating ? '' : ratingText(scale, last.rating))
    : OUTCOME_LABEL[last.outcome] || last.outcome);

  return (
    <div className="pf-page">
      <Header person={person} donor={donor} me={me} desk={desk} onLog={onLog} onEmail={() => setEmailing({ draft: null })} contacted={contacts.length > 0} level={ladders.data?.level}
        onEdit={() => { setOpen((o) => ({ ...o, details: true })); setEditing('name'); }}
        keyLine={desk ? <ProfileKeyTies query={knows} household={household} onMore={() => openSection('knows')} /> : null} />
      {waiting > 0 && (
        <p className="ds-waiting" role="status">Saved on {device} — {online ? 'sends soon' : 'sends when you’re back online'}</p>
      )}

      {desk && emailing && (
        <EmailSheet key={person.id} person={person} gmail={gmail.data} draft={emailing.draft}
          onClose={(how) => emailDone(how)} onSent={() => { emailDone('sent'); refresh(); }} />
      )}
      <RatingCard key={person.id} person={person} refresh={refresh} channel={channel} setChannel={setChannel} cardRef={ratingRef} desk={desk} />
      {/* Undecided or not rated: a supporter who knows them (desk). */}
      {desk && <KnowsNudge query={knows} person={person} />}

      {/* Volunteers get one line instead of the full history. */}
      {!desk && last && (
        <p className="pf-last">
          Last contact: {fmtShort(last.created_at)} · {CHANNEL_LABEL[last.channel] || last.channel}{lastWhat ? ` · ${lastWhat}` : ''}
        </p>
      )}

      <div className="pf-sections">
        <Section title="Details" open={!!open.details} onToggle={toggle('details')}>
          <Details person={person} household={household} refresh={refresh} desk={desk} me={me} editing={editing} setEditing={setEditing} />
        </Section>
        {/* The campaign's own fields (People → More → Profile fields); with no signal and no copy, it says so.
            The desk always has it: the voter number lives here (ext/voternumber). */}
        {(desk || fields.data?.fields?.length > 0 || noSignal(fields)) && (
          <Section title="More details" count={filledCount(fields) || ''} open={!!open.more} onToggle={toggle('more')}>
            {desk && <VoterNumber key={`voter-${person.id}`} personId={person.id} />}
            {desk && <SocialsTyped person={person} />}
            {(!desk || fields.data?.fields?.length !== 0) && <PersonFields key={person.id} query={fields} personId={person.id} />}
          </Section>
        )}
        {desk && (
          <Section title="Knows" count={knows.data?.knows?.length || ''} open={!!open.knows} onToggle={toggle('knows')}>
            <PersonKnows person={person} query={knows} me={me} />
          </Section>
        )}
        {/* Tags and roles are desk work: volunteers can't change them (person.update / volunteer.* are desk-only). */}
        {desk && (
          <Section title="Tags" count={tags.length || ''} open={!!open.tags} onToggle={toggle('tags')}>
            <Tags person={person} refresh={refresh} desk={desk} />
          </Section>
        )}
        {desk && (
          <Section title="Volunteer roles" count={roles.length || ''} open={!!open.roles} onToggle={toggle('roles')}>
            <Roles person={person} roles={roles} refresh={refresh} desk={desk} />
          </Section>
        )}
        <Section title="Signs" count={signs.length || ''} open={!!open.signs} onToggle={toggle('signs')}>
          <Signs person={person} signs={signs} refresh={refresh} desk={desk} />
        </Section>
        {/* Shifts and the full history are desk views; volunteers have Shifts and the line above. */}
        {desk && (
          <Section title="Shifts" count={shifts.length || ''} open={!!open.shifts} onToggle={toggle('shifts')}>
            <Shifts shifts={shifts} tz={zoneOf(me)} />
          </Section>
        )}
        {desk && (
          <Section title="Gifts" count={thisYear ? fmtMoney(Number(thisYear.total_cents)) : gifts.length || ''}
            open={!!open.gifts} onToggle={toggle('gifts')}>
            <Gifts slates={slatesOf(me)} person={person} gifts={gifts} totals={totals} />
          </Section>
        )}
        {showLadders && (
          <Section title="Ladders" count={ladders.data.runs.filter((r) => r.status !== 'done').length || ''} open={!!open.ladders} onToggle={toggle('ladders')}>
            <PersonLadders data={ladders.data} name={person.name} />
          </Section>
        )}
        {showAnswers && (
          <Section title="Answers" count={answers.data.answers.length} open={!!open.answers} onToggle={toggle('answers')}>
            <PersonAnswers query={answers} />
          </Section>
        )}
        {desk && (
          <Section title="History" count={timelineCount(history, notSent.length)} open={!!open.history} onToggle={toggle('history')}>
            <PersonTimeline key={person.id} personId={person.id} name={person.name} all={history} pending={notSent}
              sections={linkedSections} onSection={openSection} />
          </Section>
        )}
        {/* Texts through the campaign's number with this person (desk). */}
        {desk && <TextingPersonLink personId={person.id} />}
      </div>
      {toast.msg && <div className="toast" role="status">{toast.msg}</div>}
    </div>
  );
}
