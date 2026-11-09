// Shifts — volunteer scheduling.
//   /shifts        rows: title, day/time, "5 spots left". Volunteers see their
//                  own shifts first ("Your shifts", marked "You're on"), then
//                  the open ones. Past shifts fold away under one quiet toggle.
//   /shifts?new=1  new shift: what, when, where, how many. Role, end time,
//                  instructions and link sit under "More details".
//   /shifts/:id    the shift in plain lines, the spots left, then who's on
//                  it. Desk: one yellow button under the spots — "+ Add
//                  volunteer" while spots are open (people holding the shift's
//                  role float to the top), "Notify everyone" (email + text)
//                  once it's full (then "Notify again"); the other sits quiet
//                  under the roster. Without email/text connected nothing is
//                  sent and nothing sends later — the screen says so. Tap
//                  a person for phone, email, status and remove. Volunteers:
//                  "✓ You're on this shift" in plain green (+ a quiet "Can't
//                  make it" → "Can't make it? Yes · No" when the server offers
//                  shift.leave), or one "Count me in" when it offers shift.join
//                  (else "Ask your organizer to add you"); the roster is a
//                  plain list of names — no contact details, nothing to tap.
//                  While "Notify everyone" asks "Email + text N people?", its
//                  Send is the one yellow button — "Save — nothing sends"
//                  when neither email nor text is connected. The result
//                  counts people, not messages: reached (any message went
//                  out), not reached (it failed), not sent (not connected),
//                  no email or phone on file. "Notify again" only once
//                  someone was actually reached. No signal: Notify and
//                  its Send are off — "Needs signal — nothing sent".
//
// Offline: the list and each shift opened are kept on this phone (with
// "Offline copy" when there's no signal), and "Count me in" / "Can't make
// it" go through the outbox (src/offline.js) — saved here, sent once when
// the signal is back; until then the screen says "Not sent yet", never
// "You're on", with "Take back" on a "Count me in" still waiting.
//
// Turfs (components/ShiftTurfs.jsx, server/ext/shiftturfs): a shift can
// carry the walk lists it is for — picked under the new shift's "More
// details", or "Change turfs" on the shift (desk). A row reads "Saturday
// canvass · Newton block, 72 Ave east"; the shift says "Walk lists: …" and,
// to a volunteer, "Count me in puts them on your phone" (the server puts
// whoever joins on those turfs, and Can't make it takes back only what the
// shift gave). An assignee with no app sign-in can't get them on a phone:
// their row says so.
//
// Desk: "Week · List · Volunteers" under the title. Week (the default) is
// the slot board (ShiftsBoard.jsx) — drag people into each day's morning,
// afternoon or evening. The choice is remembered on this device.
// Volunteers is the roster (/shifts/volunteers, Volunteers.jsx).
//
// A shift (desk) also has its crew board (ShiftCrew.jsx) under the spots:
// drag volunteers on, onto its turfs, "No walk list", or back off.
//
// Also exports two small building blocks:
//   <PersonPicker onPick={(person) => …} />   type-ahead over /api/persons?q= (Signs uses it)
//   <FillBar filled={n} capacity={m} />       filled / capacity meter
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { VOLUNTEER_ROLES, SHIFT_STATUSES } from '@starbase/shared/canvass';
import { apiGet, action } from '../api.js';
import { queueAction, undoQueued, useOutbox } from '../offline.js';
import { phoneCopy, showingCopy, useKeepCopy } from '../components/OfflineCache.js';
import { NeedsSignal, NeedsSignalLine, useOnline } from '../components/NoSignal.jsx';
import ShiftsBoard from './ShiftsBoard.jsx';
import ShiftCrew from './ShiftCrew.jsx';
import { TurfPicker, turfNames, useShiftTurfs } from '../components/ShiftTurfs.jsx';
import './shifts.css';
import { NS } from '../base.js';

// The desk's last choice of List or Week, on this device only.
const VIEW_KEY = `${NS}shifts-view`;
const savedView = () => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'week'; } catch { return 'week'; } };
const saveView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } };

// This phone's own "Count me in" / "Can't make it" still waiting to send, by shift.
const waitingSelf = (items, shiftId) => [...items].reverse().find((i) => i.state === 'pending'
  && (i.name === 'shift.join' || i.name === 'shift.leave') && i.input?.shift_id === shiftId) || null;

const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label ?? code;
// One set of words for a volunteer's spot (select, chip, hints).
const STATUS_WORDS = {
  assigned: 'Assigned', confirmed: 'Confirmed', declined: 'Can’t make it', no_show: 'No-show', completed: 'Done',
};
const statusLabel = (s) => STATUS_WORDS[s] ?? String(s || '').replace(/_/g, ' ');

// ── Time helpers (everything on screen is local time) ──
const pad = (n) => String(n).padStart(2, '0');

// datetime-local value ("2026-10-21T18:00") → ISO with this device's offset
// ("2026-10-21T18:00:00-07:00"), so the server stores the moment the organizer meant.
const localToISO = (value) => {
  if (!value) return null;
  const d = new Date(value); // no offset in the string → parsed as local time
  if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

const dayKey = (when) => {
  const d = new Date(when);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// "10am", "6:30pm"
const clock = (iso) => {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 || 12}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`;
};
const shortDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
const longDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
const dayName = (iso) => {
  const now = new Date();
  if (dayKey(iso) === dayKey(now)) return 'Today';
  if (dayKey(iso) === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return 'Tomorrow';
  return shortDay(iso);
};
const timeRange = (starts, ends) => {
  if (!ends) return clock(starts);
  if (dayKey(starts) === dayKey(ends)) return `${clock(starts)}–${clock(ends)}`;
  return `${clock(starts)} – ${shortDay(ends)} ${clock(ends)}`;
};
const isLive = (s, now) => new Date(s.starts_at) <= now && now < new Date(s.ends_at || s.starts_at);
const whenLine = (s, now) => (isLive(s, now)
  ? `Now · until ${clock(s.ends_at)}`
  : `${dayName(s.starts_at)} · ${timeRange(s.starts_at, s.ends_at)}`);
const fmtStamp = (iso) => (iso
  ? new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '');

// "5 spots left", "1 spot left", "Full", or "3 going" when there's no cap.
const spotsLeft = (filled, capacity) => Math.max(0, capacity - (Number(filled) || 0));
const spotsText = (filled, capacity) => {
  const n = Number(filled) || 0;
  if (!capacity) return `${n} going`;
  const left = spotsLeft(n, capacity);
  if (left === 0) return 'Full';
  return `${left} ${left === 1 ? 'spot' : 'spots'} left`;
};
function SpotsBar({ filled, capacity }) {
  if (!capacity) return null;
  const n = Number(filled) || 0;
  const pct = Math.min(100, Math.round((n / capacity) * 100));
  return (
    <span className="ops-row__bar" data-full={n >= capacity ? '' : undefined} aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

// Only http(s) links become clickable; bare domains get https:// in front.
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+([/?#]|$)/;
const safeHref = (link) => {
  const v = String(link || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (BARE_DOMAIN.test(v)) return `https://${v}`;
  return null;
};
// What gets saved: a pasted "bit.ly/turf" is stored as https://bit.ly/turf so
// the link in the email/text is tappable too. Anything else is kept as typed.
const normalizeLink = (link) => {
  const v = String(link || '').trim();
  if (!v) return undefined;
  if (!/^[a-z][a-z\d+.-]*:/i.test(v) && BARE_DOMAIN.test(v)) return `https://${v}`;
  return v;
};

// The server 500s on a malformed uuid in the path, so a hand-typed or
// truncated link is treated as "not found" before it ever hits the API.
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

const ASSIGN_TONE = { assigned: '', confirmed: 'ok', completed: 'ok', declined: 'danger', no_show: 'danger' };
const NOTIFY_CHIP = { sent: 'chip-ok', queued: 'chip-warn', failed: 'chip-danger', skipped: '', opted_out: '', quiet: 'chip-warn' };
// What happened to one message, in plain words ("Email not sent"). 'queued'
// means the server sent nothing because that channel isn't connected, and
// nothing sends it later: connect it, then Notify again.
const NOTIFY_WORDS = {
  email: { sent: 'Email sent', queued: 'Email not sent', failed: 'Email didn’t send', skipped: 'No email on file' },
  text: {
    sent: 'Text sent', queued: 'Text not sent', failed: 'Text didn’t send', skipped: 'No phone on file',
    // The texting rules hold a notice back too (server/ext/texting).
    opted_out: 'Opted out of texts', quiet: 'Text not sent — quiet hours',
  },
};
const NOTIFY_TITLE = {
  email: { queued: 'Not sent — email isn’t connected', failed: 'Try again, or reach them another way' },
  text: {
    queued: 'Not sent — texting isn’t connected', failed: 'Try again, or reach them another way',
    opted_out: 'They replied STOP or are marked do not text', quiet: 'Texts go out only in the campaign’s hours',
  },
};

// One person's outcome across both channels:
//   reached — at least one message went out
//   failed  — nothing went out, and a provider turned one down
//   offline — nothing went out: that channel isn't connected
//   quiet   — nothing went out: the text waits for the campaign's hours
//   optedout — nothing went out: no email, and they opted out of texts
//   skipped — no email or phone on file
const outcomeOf = (email, text) => {
  if (email === 'sent' || text === 'sent') return 'reached';
  if (email === 'failed' || text === 'failed') return 'failed';
  if (email === 'queued' || text === 'queued') return 'offline';
  if (text === 'quiet') return 'quiet';
  if (text === 'opted_out') return 'optedout';
  return 'skipped';
};
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

// The result of one Notify, counted per person, in one line:
//   "✓ Sent to 2 people"
//   "✓ Sent to 1 of 2 · 1 not reached — see Details"
//   "Not sent · 2 people — connect email and text, then Notify again"
// Green only when everyone was reached.
function notifySummary(results) {
  const total = results.length;
  const n = { reached: 0, failed: 0, offline: 0, quiet: 0, optedout: 0, skipped: 0 };
  // Texts held back for quiet hours, whoever else reached them by email.
  const quietTexts = results.filter((r) => r.text === 'quiet');
  let offEmail = false;
  let offText = false;
  for (const r of results) {
    const o = outcomeOf(r.email, r.text);
    n[o] += 1;
    if (o === 'offline') {
      if (r.email === 'queued') offEmail = true;
      if (r.text === 'queued') offText = true;
    }
  }
  const connect = offEmail && offText ? 'email and text' : offEmail ? 'email' : 'text';
  const parts = [];
  if (n.reached) parts.push(n.reached === total ? `✓ Sent to ${people(total)}` : `✓ Sent to ${n.reached} of ${total}`);
  // The first part leads ("Not sent · 2 people …"); later ones are counts.
  const say = (lead, count) => parts.push(parts.length === 0 ? lead : count);
  if (n.failed) say(`Not reached · ${people(n.failed)} — see Details`, `${n.failed} not reached — see Details`);
  if (n.offline) {
    const next = `connect ${connect}, then Notify again`;
    say(`Not sent · ${people(n.offline)} — ${next}`, `${n.offline} not sent — ${next}`);
  }
  if (quietTexts.length) {
    // "Quiet hours — sending opens at 9 am" (the server's words).
    const note = quietTexts.find((r) => r.text_note)?.text_note || 'Quiet hours';
    const k = quietTexts.length;
    say(`${note} · ${k} ${k === 1 ? 'text' : 'texts'} not sent`, `${k} ${k === 1 ? 'text' : 'texts'} not sent — ${note.toLowerCase()}`);
  }
  if (n.optedout) say(`Opted out of texts · ${people(n.optedout)}`, `${n.optedout} opted out of texts`);
  if (n.skipped) say(`No email or phone on file · ${people(n.skipped)}`, `${n.skipped} with no email or phone`);
  return { text: parts.join(' · '), ok: total > 0 && n.reached === total && quietTexts.length === 0 };
}

function NotifyChip({ channel, status }) {
  if (!status) return null;
  return (
    <span className={`chip ${NOTIFY_CHIP[status] ?? ''}`.trim()} title={NOTIFY_TITLE[channel]?.[status]}>
      {NOTIFY_WORDS[channel]?.[status] ?? `${channel} ${status}`}
    </span>
  );
}

const NOTIFIED_WORD = { reached: 'Notified', failed: 'Tried', offline: 'Saved', quiet: 'Saved', optedout: 'Saved', skipped: 'Saved' };

// ── Fill bar: filled / capacity ──
export function FillBar({ filled = 0, capacity }) {
  const n = Number(filled) || 0;
  if (!capacity) {
    return (
      <span className="ops-fill" aria-label={`${n} signed up, no cap`}>
        <span className="ops-fill-num mono">{n} signed up</span>
      </span>
    );
  }
  const pct = Math.min(100, Math.round((n / capacity) * 100));
  const full = n >= capacity;
  return (
    <span className="ops-fill" data-full={full ? '' : undefined} aria-label={`${n} of ${capacity} spots filled`}>
      <span className="ops-fill-track" aria-hidden="true">
        <span className="ops-fill-bar" style={{ width: `${pct}%` }} />
      </span>
      <span className="ops-fill-num mono">{n}/{capacity}{full ? ' full' : ''}</span>
    </span>
  );
}

// ── Person picker: type-ahead over /api/persons?q=, arrow keys, inline create ──
// roleHint: a VOLUNTEER_ROLES code; people holding it are listed first with
// that role as a chip. excludeIds: shown but not pickable (already on it).
export function PersonPicker({
  id,
  onPick,
  roleHint = null,
  excludeIds = [],
  excludeLabel = 'already added',
  allowCreate = true,
  placeholder = 'Start typing a name…',
  meta = (p) => p.email || p.phone || p.address,
  disabled = false,
  autoFocus = false,
}) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const boxRef = useRef(null);
  const listId = `${id}-options`;
  const enc = encodeURIComponent;

  const general = useQuery({
    queryKey: ['persons', 'search', q],
    queryFn: () => apiGet(`/persons?q=${enc(q)}&limit=8`),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const matching = useQuery({
    queryKey: ['persons', 'search', q, 'role', roleHint],
    queryFn: () => apiGet(`/persons?q=${enc(q)}&role=${enc(roleHint)}&limit=8`),
    enabled: open && !!roleHint,
    placeholderData: keepPreviousData,
  });

  const excludeKey = excludeIds.join(',');
  const items = useMemo(() => {
    const taken = new Set(excludeKey ? excludeKey.split(',') : []);
    const seen = new Set();
    const out = [];
    const add = (p, match) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      out.push({ ...p, _match: match, _taken: taken.has(p.id) });
    };
    for (const p of (roleHint ? matching.data?.persons : null) ?? []) add(p, true);
    for (const p of general.data?.persons ?? []) add(p, false);
    const trimmed = q.trim();
    if (allowCreate && trimmed && !out.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      out.push({ id: '__create__', name: trimmed });
    }
    return out;
  }, [general.data, matching.data, roleHint, excludeKey, q, allowCreate]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(items.length - 1, 0)));
  }, [items.length]);

  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const choose = async (item) => {
    if (!item || item._taken || busy) return;
    setError(null);
    setBusy(true);
    try {
      let person = item;
      if (item.id === '__create__') {
        const res = await action('person.create', { name: item.name });
        queryClient.invalidateQueries({ queryKey: ['persons'] });
        queryClient.invalidateQueries({ queryKey: ['brief'] });
        person = res.person;
      }
      setQ('');
      setOpen(false);
      await onPick?.(person);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (open && items.length) { e.preventDefault(); choose(items[active]); } }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div className="picker ops-picker" ref={boxRef}>
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={q}
        disabled={disabled || busy}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && items.length > 0 && (
        <ul className="picker-list" id={listId} role="listbox">
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={item._taken || undefined}
              className={(i === active ? 'active ' : '') + (item.id === '__create__' ? 'create' : '')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
            >
              {item.id === '__create__' ? (
                <>+ Add new person “{item.name}”</>
              ) : (
                <>
                  <span>{item.name}</span>
                  {item._match && <span className="chip chip-ok">{roleLabel(roleHint)}</span>}
                  {item._taken && <span className="chip">{excludeLabel}</span>}
                  {meta(item) && <span className="meta">{meta(item)}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && items.length === 0 && q.trim() && general.isSuccess && !general.isPlaceholderData && (
        <div className="ops-picker-hint" role="status">No one matches “{q.trim()}”.</div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// ── New shift form: four fields, the rest under "More details" ──
function ShiftForm({ onClose }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({
    title: '', role: '', location: '', starts: '', ends: '', capacity: '', link: '', instructions: '',
  });
  const [turfIds, setTurfIds] = useState([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const starts_at = localToISO(f.starts);
    const ends_at = localToISO(f.ends);
    if (!f.title.trim()) { setError('Give the shift a name'); return; }
    if (!starts_at) { setError('Pick when it starts'); return; }
    if (ends_at && new Date(ends_at) <= new Date(starts_at)) { setMore(true); setError('The end has to be after the start'); return; }
    let capacity;
    if (f.capacity.trim()) {
      capacity = Number(f.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) { setError('How many: a whole number, 1 or more'); return; }
    }
    setBusy(true);
    try {
      const res = await action('shift.create', {
        title: f.title.trim(),
        role: f.role || undefined,
        location: f.location.trim() || undefined,
        starts_at,
        ends_at: ends_at || undefined,
        instructions: f.instructions.trim() || undefined,
        link: normalizeLink(f.link),
        capacity,
      });
      // Its turfs, once it exists. Should that fail, the shift is made: it
      // opens with the picked turfs waiting under "Change turfs".
      let turfError = null;
      if (turfIds.length) {
        try {
          await action('shift.turfs.set', { shift_id: res.shift.id, turf_ids: turfIds });
        } catch (err) {
          turfError = err.message;
        }
        queryClient.invalidateQueries({ queryKey: ['shiftturfs'] });
      }
      queryClient.invalidateQueries({ queryKey: ['shifts'] });
      queryClient.invalidateQueries({ queryKey: ['brief'] });
      navigate(`/shifts/${res.shift.id}`, turfError ? { state: { turfIds, turfError } } : undefined);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card ops-form" onSubmit={submit} aria-label="New shift">
      <div className="field">
        <label htmlFor="shift-title">What</label>
        <input id="shift-title" className="input" required autoFocus placeholder="Saturday doorknock — Fleetwood"
          value={f.title} onChange={set('title')} />
      </div>
      <div className="field">
        <label htmlFor="shift-starts">When</label>
        <input id="shift-starts" className="input mono" type="datetime-local" required
          value={f.starts} onChange={set('starts')} />
      </div>
      <div className="field">
        <label htmlFor="shift-location">Where</label>
        <input id="shift-location" className="input" placeholder="Campaign office"
          value={f.location} onChange={set('location')} />
      </div>
      <div className="field">
        <label htmlFor="shift-capacity">How many people</label>
        <input id="shift-capacity" className="input mono" type="number" min="1" step="1" inputMode="numeric"
          placeholder="No limit" value={f.capacity} onChange={set('capacity')} />
      </div>

      <button type="button" className="ops-more disclose disclose--inline" aria-expanded={more} aria-controls="shift-more"
        onClick={() => setMore((v) => !v)}>
        More details
      </button>
      {more && (
        <div id="shift-more" className="ops-more-body">
          <div className="field">
            <label htmlFor="shift-role">Role</label>
            <select id="shift-role" className="input" value={f.role} onChange={set('role')}>
              <option value="">Any role</option>
              {VOLUNTEER_ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="shift-ends">Ends</label>
            <input id="shift-ends" className="input mono" type="datetime-local" min={f.starts || undefined}
              value={f.ends} onChange={set('ends')} />
          </div>
          <div className="field">
            <label htmlFor="shift-instructions">Instructions</label>
            <textarea id="shift-instructions" className="input" rows={3}
              placeholder="What to bring, who to ask for, parking…"
              value={f.instructions} onChange={set('instructions')} />
          </div>
          <div className="field">
            <label htmlFor="shift-link">Link</label>
            {/* type=text + inputMode=url: native type=url would refuse a bare "bit.ly/turf". */}
            <input id="shift-link" className="input" type="text" inputMode="url" autoCapitalize="none"
              autoCorrect="off" spellCheck={false} placeholder="Turf map, sign-up doc, call script"
              value={f.link} onChange={set('link')} />
          </div>
          <div className="field">
            <label htmlFor="shift-turfs">Turfs</label>
            <TurfPicker id="shift-turfs" value={turfIds} onChange={setTurfIds} disabled={busy} />
            <span className="ops-meta">Anyone who counts themselves in gets these walk lists</span>
          </div>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Saving…' : 'Create shift'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// ISO from the server → a datetime-local value in this device's time.
const isoToLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const sameMoment = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

// ── Edit a shift (desk): the same fields, filled in; only what changed is
// sent. Moving it in time or place says so, and offers to tell those booked
// (shift.notify, which emails and texts the shift as it now stands). ──
function EditShiftForm({ shift, booked, onClose, onSaved }) {
  const [f, setF] = useState({
    title: shift.title || '', role: shift.role || '', location: shift.location || '',
    starts: isoToLocal(shift.starts_at), ends: isoToLocal(shift.ends_at),
    capacity: shift.capacity ? String(shift.capacity) : '', link: shift.link || '', instructions: shift.instructions || '',
    public: Boolean(shift.public),
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const starts_at = localToISO(f.starts);
    const ends_at = localToISO(f.ends);
    if (!f.title.trim()) { setError('Give the shift a name'); return; }
    if (!starts_at) { setError('Pick when it starts'); return; }
    if (ends_at && new Date(ends_at) <= new Date(starts_at)) { setError('The end has to be after the start'); return; }
    let capacity = null;
    if (f.capacity.trim()) {
      capacity = Number(f.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) { setError('How many: a whole number, 1 or more'); return; }
    }
    const patch = {};
    if (f.title.trim() !== shift.title) patch.title = f.title.trim();
    if ((f.role || null) !== (shift.role || null)) patch.role = f.role || null;
    if ((f.location.trim() || null) !== (shift.location || null)) patch.location = f.location.trim() || null;
    if (!sameMoment(starts_at, shift.starts_at)) patch.starts_at = starts_at;
    if (!sameMoment(ends_at, shift.ends_at)) patch.ends_at = ends_at;
    if (capacity !== (shift.capacity ?? null)) patch.capacity = capacity;
    if ((normalizeLink(f.link) ?? null) !== (shift.link || null)) patch.link = normalizeLink(f.link) ?? null;
    if ((f.instructions.trim() || null) !== (shift.instructions || null)) patch.instructions = f.instructions.trim() || null;
    // On the website or not is its own switch (ext/site: shift.public).
    const onSite = f.public !== Boolean(shift.public);
    if (!Object.keys(patch).length && !onSite) { onClose(); return; }
    setBusy(true);
    try {
      if (Object.keys(patch).length) await action('shift.update', { id: shift.id, ...patch });
      if (onSite) await action('shift.public', { id: shift.id, public: f.public });
      const moved = ['starts_at', 'ends_at', 'location'].some((k) => k in patch);
      onSaved({ moved: moved && booked > 0 });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card ops-form" onSubmit={submit} aria-label="Edit shift">
      <div className="field">
        <label htmlFor="edit-shift-title">What</label>
        <input id="edit-shift-title" className="input" required autoFocus value={f.title} onChange={set('title')} />
      </div>
      <div className="field">
        <label htmlFor="edit-shift-starts">When</label>
        <input id="edit-shift-starts" className="input mono" type="datetime-local" required value={f.starts} onChange={set('starts')} />
      </div>
      <div className="field">
        <label htmlFor="edit-shift-ends">Ends</label>
        <input id="edit-shift-ends" className="input mono" type="datetime-local" min={f.starts || undefined}
          value={f.ends} onChange={set('ends')} />
      </div>
      <div className="field">
        <label htmlFor="edit-shift-location">Where</label>
        <input id="edit-shift-location" className="input" value={f.location} onChange={set('location')} />
      </div>
      <div className="field">
        <label htmlFor="edit-shift-capacity">How many people</label>
        <input id="edit-shift-capacity" className="input mono" type="number" min={Math.max(1, booked)} step="1" inputMode="numeric"
          placeholder="No limit" value={f.capacity} onChange={set('capacity')} />
        {booked > 0 && <span className="ops-meta">{people(booked)} booked</span>}
      </div>
      <div className="field">
        <label htmlFor="edit-shift-role">Role</label>
        <select id="edit-shift-role" className="input" value={f.role} onChange={set('role')}>
          <option value="">Any role</option>
          {VOLUNTEER_ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="edit-shift-instructions">Instructions</label>
        <textarea id="edit-shift-instructions" className="input" rows={3} value={f.instructions} onChange={set('instructions')} />
      </div>
      <div className="field">
        <label htmlFor="edit-shift-link">Link</label>
        <input id="edit-shift-link" className="input" type="text" inputMode="url" autoCapitalize="none"
          autoCorrect="off" spellCheck={false} value={f.link} onChange={set('link')} />
      </div>
      <label className="ops-check">
        <input type="checkbox" checked={f.public} onChange={(e) => setF((cur) => ({ ...cur, public: e.target.checked }))} />
        <span><b>Show on the website</b><span className="ops-meta">Anyone can see it on the site’s events and sign up for it</span></span>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// ── Which shifts am I on? (volunteers) ──
// The server marks each shift the caller is on (s.mine: their own supporter
// record, matched by login email, holds an active spot). Only an older
// server leaves it out; then — and only then — this falls back to finding
// the caller's own record by email and reading its shifts.
function useLegacyMyShifts(me, enabled) {
  const email = String(me?.user?.email || '').trim().toLowerCase();
  const search = useQuery({
    queryKey: ['persons', 'search', email],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(email)}&limit=8`),
    enabled: enabled && !!email,
  });
  const self = (search.data?.persons ?? []).find((p) => String(p.email || '').toLowerCase() === email);
  const person = useQuery({
    queryKey: ['person', self?.id],
    queryFn: () => apiGet(`/persons/${self.id}`),
    enabled: enabled && !!self,
  });
  return useMemo(() => {
    const mine = new Map();
    for (const a of person.data?.shifts ?? []) if (a.status !== 'declined') mine.set(a.id, a.status);
    return mine;
  }, [person.data]);
}

// ── List ──
function ShiftRow({ s, now, past = false, mine = false, waiting = false, turfs }) {
  const full = s.capacity && Number(s.filled) >= s.capacity;
  const names = turfNames(turfs);
  return (
    <li className="ops-item" data-tone={past ? 'past' : undefined}>
      <Link to={`/shifts/${s.id}`} className="ops-row">
        <span className="ops-row__main">
          <span className="ops-row__name">{s.title}{names && <span className="st-row-turfs"> · {names}</span>}</span>
          <span className="ops-row__sub">{whenLine(s, now)}</span>
        </span>
        <span className="ops-row__end">
          {waiting
            ? <span className="chip obx-chip ops-chip-lg">Not sent yet</span>
            : mine
              ? <span className="chip chip-ok ops-chip-lg">You’re on ✓</span>
              : <span className={`chip ops-chip-lg${full ? ' chip-ok' : ''}`}>{spotsText(s.filled, s.capacity)}</span>}
        </span>
      </Link>
      {!past && <SpotsBar filled={s.filled} capacity={s.capacity} />}
    </li>
  );
}

function ShiftList({ canDesk, me }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const showNew = canDesk && params.get('new') === '1';
  // A link with ?week= opens the week board.
  const [view, setView] = useState(() => (!canDesk ? 'list' : params.get('week') ? 'week' : savedView()));
  // The board needs signal (it's live, not kept on the phone): with none,
  // the list and its offline copy show instead, and the board comes back
  // with the signal. The saved choice stays as it was.
  const online = useOnline();
  const week = canDesk && !showNew && online && view === 'week';
  const pickView = (v) => {
    setView(v);
    saveView(v);
    if (v === 'list' && params.get('week')) setParams({}, { replace: true });
  };
  const [showPast, setShowPast] = useState(false);
  const shifts = useQuery({ queryKey: ['shifts'], queryFn: () => apiGet('/shifts'), ...phoneCopy(me, 'shifts') });
  useKeepCopy(me, 'shifts', shifts);
  const { byShift } = useShiftTurfs(me);
  const listCopy = showingCopy(shifts);
  const outbox = useOutbox();
  const all = shifts.data?.shifts ?? [];
  // s.mine is the answer; the email lookup runs only for a server without it.
  const legacy = !canDesk && shifts.isSuccess && all.some((s) => typeof s.mine !== 'boolean');
  const legacyMine = useLegacyMyShifts(me, legacy);

  const now = new Date();
  const isPast = (s) => new Date(s.ends_at || s.starts_at) < now;
  const upcoming = all.filter((s) => !isPast(s));
  const past = all.filter(isPast).reverse(); // most recent first
  const isMineShift = (s) => (typeof s.mine === 'boolean' ? s.mine : legacyMine.has(s.id));
  const yours = upcoming.filter(isMineShift);
  const others = upcoming.filter((s) => !isMineShift(s));

  return (
    <div className="ops-page">
      <div className="ops-head">
        <h1>Shifts</h1>
        {canDesk && !showNew && (
          <button type="button" className="btn btn-primary ops-tap" disabled={!online} onClick={() => setParams({ new: '1' })}>
            New shift
          </button>
        )}
      </div>
      {canDesk && !showNew && !online && <NeedsSignalLine>New shifts need signal</NeedsSignalLine>}

      {showNew && <ShiftForm onClose={() => setParams({})} />}

      {canDesk && !showNew && (
        <div className="ops-seg ops-filter sb-views" role="group" aria-label="Show">
          <button type="button" aria-pressed={week} onClick={() => pickView('week')} disabled={!online}
            title={online ? undefined : 'The week board needs signal'}>Week</button>
          <button type="button" aria-pressed={!week} onClick={() => pickView('list')}>List</button>
          <button type="button" aria-pressed={false} onClick={() => navigate('/shifts/volunteers')} disabled={!online}
            title={online ? undefined : 'The volunteer list needs signal'}>Volunteers</button>
        </div>
      )}
      {week ? <ShiftsBoard me={me} /> : (
      <>

      {listCopy && <p className="ops-copy"><span className="chip obx-copy">Offline copy</span></p>}
      {shifts.isPending && <p className="muted">{shifts.fetchStatus === 'paused' ? 'Offline — loads with signal' : 'Loading…'}</p>}
      {shifts.isError && !listCopy && <p className="error">{shifts.error.message}</p>}
      {shifts.isSuccess && upcoming.length === 0 && <p className="ops-empty">No shifts coming up.</p>}

      {yours.length > 0 && (
        <>
          <span className="eyebrow ops-label">Your shifts</span>
          <ul className="ops-rows">{yours.map((s) => <ShiftRow key={s.id} s={s} now={now} mine waiting={!!waitingSelf(outbox.items, s.id)} turfs={byShift[s.id]} />)}</ul>
          {others.length > 0 && <span className="eyebrow ops-label">Open shifts</span>}
        </>
      )}
      {others.length > 0 && (
        <ul className="ops-rows">{others.map((s) => <ShiftRow key={s.id} s={s} now={now} waiting={!!waitingSelf(outbox.items, s.id)} turfs={byShift[s.id]} />)}</ul>
      )}

      {past.length > 0 && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={showPast} aria-controls="ops-past"
            onClick={() => setShowPast((v) => !v)}>
            Past shifts · {past.length}
          </button>
          {showPast && (
            <ul id="ops-past" className="ops-rows ops-more-body">
              {past.map((s) => <ShiftRow key={s.id} s={s} now={now} past mine={isMineShift(s)} turfs={byShift[s.id]} />)}
            </ul>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

// ── Detail: one person on the shift; tap to open ──
function AssigneeRow({ a, open, onToggle, canDesk, busy, onStatus, onRemove, noSignIn = false }) {
  const [confirm, setConfirm] = useState(false);
  const bodyId = `as-${a.assignment_id}`;
  const tone = ASSIGN_TONE[a.status];
  return (
    <li className="ops-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { setConfirm(false); onToggle(); }}>
        <span className="ops-row__main">
          <span className="ops-row__name">{a.name}</span>
          {/* The shift's walk lists reach a phone through an app sign-in. */}
          {noSignIn && <span className="ops-row__sub st-signin">No app sign-in — add them to the turf on the map</span>}
        </span>
        <span className="ops-row__end">
          <span className={`chip${tone ? ` chip-${tone}` : ''}`}>{statusLabel(a.status)}</span>
        </span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          {(a.phone || a.email) && (
            <div className="ops-contact">
              {a.phone && <a href={`tel:${a.phone}`}>{a.phone}</a>}
              {a.email && <a href={`mailto:${a.email}`}>{a.email}</a>}
            </div>
          )}
          {canDesk && (
            <div className="field">
              <label htmlFor={`${bodyId}-status`}>Status</label>
              <select id={`${bodyId}-status`} className="ops-status" value={a.status} disabled={busy}
                onChange={(e) => onStatus(e.target.value)}>
                {SHIFT_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </div>
          )}
          {a.notified_at && (
            <div className="ops-chips">
              {/* "Notified" only when a message actually went out; "Tried"
                  when a provider turned it down; "Saved" when nothing was
                  even tried (not connected, or nothing on file). */}
              <span className="ops-meta mono">
                {NOTIFIED_WORD[outcomeOf(a.notify_email, a.notify_text)]} {fmtStamp(a.notified_at)}
              </span>
              <NotifyChip channel="email" status={a.notify_email} />
              <NotifyChip channel="text" status={a.notify_text} />
            </div>
          )}
          <div className="ops-actions">
            <Link className="btn btn-quiet ops-tap ops-link" to={`/people/${a.id}`}>Profile</Link>
            {canDesk && !confirm && (
              <button type="button" className="btn btn-quiet ops-tap" aria-label={`Remove ${a.name} from this shift`}
                disabled={busy} onClick={() => setConfirm(true)}>
                Remove
              </button>
            )}
          </div>
          {canDesk && confirm && (
            <div className="ops-confirm" role="group" aria-label={`Remove ${a.name}`}>
              <span>Remove {a.name}?</span>
              <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={onRemove}>Yes</button>
              <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setConfirm(false)}>No</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Volunteers see who else is coming — names only, never contact details.
// A plain list line, not a card: there is nothing to tap.
function NameRow({ a, isMe }) {
  return (
    <li className="ops-plain">
      <span className="ops-plain__name">{a.name}</span>
      {isMe && <span className="chip chip-ok">You</span>}
    </li>
  );
}

function ShiftDetail({ id, canDesk, me }) {
  const queryClient = useQueryClient();
  const validId = isUuid(id);
  // Each shift opened is kept on this phone, with what this sign-in may do.
  const shiftQ = useQuery({ queryKey: ['shift', id], queryFn: () => apiGet(`/shifts/${id}`), enabled: validId, ...phoneCopy(me, `shift:${id}`) });
  useKeepCopy(me, `shift:${id}`, shiftQ);
  const outbox = useOutbox();
  const waiting = waitingSelf(outbox.items, id);
  // The desk's Notify needs signal (it emails and texts now, or not at all).
  const online = useOnline();
  // Providers are read once; the brief is shared with Today so it is usually
  // cached (a side read: its time isn't this screen's, KeptCopies.js).
  const brief = useQuery({ queryKey: ['brief'], queryFn: () => apiGet('/brief'), staleTime: Infinity, meta: { side: true } });
  // Which actions this login may run. A volunteer gets "Count me in" only
  // when the server offers shift.join; otherwise "Ask your organizer".
  const allowed = useQuery({
    queryKey: ['actions'],
    queryFn: () => apiGet('/actions'),
    enabled: !canDesk,
    staleTime: Infinity,
    ...phoneCopy(me, 'actions'),
  });
  useKeepCopy(me, 'actions', allowed);

  const [openId, setOpenId] = useState(null);
  // With the crew board on screen, the roster below it (status, contact,
  // notices) folds away under one toggle.
  const [rosterOpen, setRosterOpen] = useState(false);
  const [rowBusy, setRowBusy] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(null);
  const [addError, setAddError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState(null);
  const [showResults, setShowResults] = useState(false);
  const [notifyError, setNotifyError] = useState(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);
  const [leaving, setLeaving] = useState(false); // "Can't make it? Yes · No"
  // Desk: "Edit" opens the form in place; "Call off" asks once.
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(null); // { moved } after a save
  const [callingOff, setCallingOff] = useState(false);
  const [offBusy, setOffBusy] = useState(false);
  const [offError, setOffError] = useState(null);
  // The shift's turfs: every role reads the kept list; the desk also learns
  // who on it has no app sign-in (their phone can't get the walk lists).
  const { byShift } = useShiftTurfs(me, { side: true });
  const deskTurfs = useQuery({
    queryKey: ['shiftturfs', id],
    queryFn: () => apiGet(`/shiftturfs/${id}`),
    enabled: canDesk && validId,
    meta: { side: true },
  });
  // "Change turfs": null while closed. A new shift whose turfs didn't save
  // opens with them waiting here (ShiftForm).
  const location = useLocation();
  const navigate = useNavigate();
  const handed = location.state;
  const [editTurfs, setEditTurfs] = useState(() => (Array.isArray(handed?.turfIds) ? handed.turfIds : null));
  const [turfBusy, setTurfBusy] = useState(false);
  const [turfError, setTurfError] = useState(() => (handed?.turfError ? `Turfs not saved: ${handed.turfError}` : null));
  const [turfSaved, setTurfSaved] = useState(false);
  // Read once: a reload doesn't bring it back.
  useEffect(() => {
    if (handed?.turfIds) navigate(location.pathname, { replace: true, state: null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['shift', id] });
    queryClient.invalidateQueries({ queryKey: ['shifts'] });
    queryClient.invalidateQueries({ queryKey: ['brief'] });
    queryClient.invalidateQueries({ queryKey: ['person'] });
    // Who's on it decides who has its walk lists.
    queryClient.invalidateQueries({ queryKey: ['shiftturfs'] });
    queryClient.invalidateQueries({ queryKey: ['turfs'] });
    queryClient.invalidateQueries({ queryKey: ['crew', id] });
    queryClient.invalidateQueries({ queryKey: ['volunteers'] });
  };
  // Volunteer books or drops their own spot (shift.join / shift.leave),
  // through the outbox: no signal, it waits on the phone ("Not sent yet").
  const selfAction = async (name) => {
    setJoinError(null);
    setJoining(true);
    try {
      const r = await queueAction(name, { shift_id: id }, { who: shiftQ.data?.shift?.title });
      setLeaving(false);
      if (r.queued) return;
      // Joining may create the volunteer's supporter record; an older
      // server's "Your shifts" lookup searches persons, so refresh that too.
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      refresh();
    } catch (e) {
      setJoinError(e.message);
    } finally {
      setJoining(false);
    }
  };
  // "Take back" on a "Count me in" still on the phone: it never goes, or
  // (it may already have reached the server) "Can't make it" follows it.
  const takeBack = async () => {
    setJoinError(null);
    const u = waiting ? undoQueued(waiting.cid) : null;
    if (u?.sent) await selfAction('shift.leave'); // it went just now: drop out again
  };

  // A copy kept on the phone still opens when the signal is gone; a shift
  // the server says is gone is gone.
  if (!validId || (shiftQ.isError && (!shiftQ.data || shiftQ.error?.status))) {
    return (
      <div className="ops-page">
        <Link to="/shifts" className="ops-back">← Shifts</Link>
        <p className="ops-empty">
          {!validId || shiftQ.error.status === 404 ? 'That shift is gone.' : shiftQ.error.message}
        </p>
      </div>
    );
  }
  // isPending, not isLoading: a query paused offline is pending but not
  // fetching, and reading shiftQ.data below would throw.
  if (shiftQ.isPending) {
    return shiftQ.fetchStatus === 'paused' ? (
      <div className="ops-page">
        <Link to="/shifts" className="ops-back">← Shifts</Link>
        <p className="ops-empty">Offline — open this shift once with signal.</p>
      </div>
    ) : <p className="muted">Loading…</p>;
  }

  const { shift, assignees } = shiftQ.data;
  const active = assignees.filter((a) => a.status === 'assigned' || a.status === 'confirmed');
  const full = !!shift.capacity && active.length >= shift.capacity;
  const href = safeHref(shift.link);
  const myEmail = String(me?.user?.email || '').toLowerCase();
  // The server marks the viewer's own row (is_me); older servers don't, so
  // fall back to matching the login email.
  const isMine = (a) => (typeof a.is_me === 'boolean'
    ? a.is_me
    : !!myEmail && String(a.email || '').toLowerCase() === myEmail);
  const onIt = !canDesk && active.some(isMine);
  const over = new Date(shift.ends_at || shift.starts_at) < new Date();
  const offered = allowed.data?.actions ?? [];
  const canJoin = offered.includes('shift.join');
  const canLeave = offered.includes('shift.leave');
  const providers = brief.data?.providers;
  const missingEmail = providers && !providers.email;
  const missingText = providers && !providers.text;
  // Neither connected: pressing it sends nothing, now or later — so its
  // button says "Save — nothing sends", never "Send".
  const nothingSends = !!(missingEmail && missingText);
  // Said before Send, and literally true: a channel that isn't connected
  // sends nothing, now or later.
  let providerNote = null;
  if (nothingSends) providerNote = 'Email and text aren’t connected.';
  else if (missingEmail) providerNote = 'Email isn’t connected — no emails will be sent.';
  else if (missingText) providerNote = 'Texting isn’t connected — no texts will be sent.';
  // Desk: the yellow button is the job at hand. Open spots → fill them
  // ("Add volunteer"); full → tell the crew ("Notify everyone").
  const primary = over ? null : full ? 'notify' : 'add';
  const turfs = (canDesk ? deskTurfs.data?.turfs : null) ?? byShift[shift.id] ?? [];
  const noSignIn = new Set(turfs.length ? (deskTurfs.data?.no_sign_in ?? []) : []);
  const saveTurfs = async () => {
    setTurfError(null);
    setTurfBusy(true);
    try {
      await action('shift.turfs.set', { shift_id: shift.id, turf_ids: editTurfs });
      setEditTurfs(null);
      setTurfSaved(true);
      refresh();
    } catch (e) {
      setTurfError(e.message);
    } finally {
      setTurfBusy(false);
    }
  };
  // One or many: "Walk list: Newton block" / "Walk lists: Newton block, 72 Ave east".
  const them = turfs.length === 1 ? 'it' : 'them';
  const walkHint = canDesk || over ? null
    : onIt ? `${turfs.length === 1 ? 'it’s' : 'they’re'} on your phone`
      : !full && canJoin ? `Count me in puts ${them} on your phone` : null;

  const setStatus = async (a, status) => {
    setError(null);
    setRowBusy(a.assignment_id);
    queryClient.setQueryData(['shift', id], (cur) => cur && ({
      ...cur,
      assignees: cur.assignees.map((x) => (x.assignment_id === a.assignment_id ? { ...x, status } : x)),
    }));
    try {
      await action('shift.setStatus', { id: a.assignment_id, status });
    } catch (e) {
      setError(`${a.name}: ${e.message}`);
    } finally {
      setRowBusy(null);
      refresh();
    }
  };

  const unassign = async (a) => {
    setError(null);
    setRowBusy(a.assignment_id);
    try {
      await action('shift.unassign', { id: a.assignment_id });
      setAdded(null);
      setOpenId(null);
    } catch (e) {
      setError(`${a.name}: ${e.message}`);
    } finally {
      setRowBusy(null);
      refresh();
    }
  };

  const assign = async (person) => {
    setAddError(null);
    setAdded(null);
    try {
      await action('shift.assign', { shift_id: shift.id, person_id: person.id });
      setAdded(person.name);
      refresh();
    } catch (e) {
      setAddError(e.status === 409 ? `${person.name}: ${e.message}` : e.message);
    }
  };

  const notify = async () => {
    setNotifyError(null);
    setSending(true);
    try {
      const res = await action('shift.notify', { shift_id: shift.id });
      setResults(res.notified ?? []);
      setShowResults(false);
      setConfirming(false);
      refresh();
    } catch (e) {
      setNotifyError(e.message);
    } finally {
      setSending(false);
    }
  };

  // ── Desk blocks: whichever is `primary` sits under the spots number in
  // yellow; the other waits, quiet, under the roster. ──
  // While "Email + text N people?" is open, its Send is the job at hand, so
  // the yellow moves there and "+ Add volunteer" goes quiet.
  const addBlock = (isPrimary) => (
    <div className="ops-add" data-primary={isPrimary ? '' : undefined}>
      {!adding ? (
        <>
          <button type="button" className={`btn ops-tap${isPrimary ? ' ops-wide' : ''}${isPrimary && !confirming ? ' btn-primary' : ''}`}
            disabled={!online} onClick={() => { setAdding(true); setAdded(null); setAddError(null); }}>
            + Add volunteer
          </button>
          {!online && <NeedsSignal>Needs signal</NeedsSignal>}
        </>
      ) : (
        <>
          <label htmlFor="shift-add-person" className="eyebrow">Add volunteer</label>
          <PersonPicker
            id="shift-add-person"
            autoFocus
            roleHint={shift.role || null}
            excludeIds={assignees.map((a) => a.id)}
            excludeLabel="on this shift"
            placeholder="Name, email or phone…"
            onPick={assign}
          />
          {full && <span className="ops-meta">Full. Set someone to “Can’t make it” to free a spot.</span>}
          <div className="ops-actions">
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAdding(false)}>Done</button>
          </div>
        </>
      )}
      {addError && <p className="error">{addError}</p>}
      {added && <p className="ops-done" role="status">✓ {added} added</p>}
    </div>
  );

  // Nobody on it yet → nothing to send, so the quiet Notify stays out of the way.
  const showNotify = active.length > 0 || !!results || !!notifyError;
  // "Notify again" only once someone was actually reached; a run that sent
  // nothing leaves it "Notify everyone" (pressing it is still the only way
  // a not-sent message goes out).
  const reachedNow = (results ?? []).some((r) => outcomeOf(r.email, r.text) === 'reached');
  const notifiedBefore = reachedNow
    || assignees.some((a) => outcomeOf(a.notify_email, a.notify_text) === 'reached' && !!a.notified_at);
  const summary = results?.length ? notifySummary(results) : null;
  const notifyBlock = (isPrimary) => showNotify && (
    <section className="ops-notify" aria-label="Notify volunteers">
      {!confirming ? (
        <button type="button" className={`btn ops-tap${isPrimary ? ' btn-primary ops-wide' : ''}`}
          disabled={active.length === 0 || !online}
          onClick={() => { setConfirming(true); setResults(null); setNotifyError(null); }}>
          {notifiedBefore ? 'Notify again' : 'Notify everyone'}
        </button>
      ) : (
        <div className="ops-confirm" role="group" aria-label="Send notification">
          <span>Email + text {people(active.length)}?</span>
          <button type="button" className="btn btn-primary ops-tap"
            onClick={notify} disabled={sending || !online}>
            {sending ? (nothingSends ? 'Saving…' : 'Sending…') : (nothingSends ? 'Save — nothing sends' : 'Send')}
          </button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirming(false)} disabled={sending}>
            Cancel
          </button>
        </div>
      )}
      {!online && active.length > 0 && <NeedsSignal />}
      {confirming && providerNote && (
        <span className="ops-meta">{providerNote} <Link to="/outreach/connect?connect=1">Connect</Link></span>
      )}
      {notifyError && <p className="error">{notifyError}</p>}
      {results && (results.length === 0 ? (
        <span className="ops-meta" role="status">Nobody to notify.</span>
      ) : (
        <>
          {/* Say "Sent" only for people a message actually reached. Without a
              provider nothing is sent and nothing sends later: say which
              channel to connect, then Notify again. */}
          <p className={summary.ok ? 'ops-done' : 'ops-done ops-done--wait'} role="status">{summary.text}</p>
          <button type="button" className="ops-more disclose" aria-expanded={showResults} aria-controls="notify-results"
            onClick={() => setShowResults((v) => !v)}>
            Details
          </button>
          {showResults && (
          <ul className="ops-results" id="notify-results" aria-label="Notification results">
            {results.map((r) => (
              <li key={r.person_id}>
                <span>{r.name}</span>
                <span className="chips">
                  <NotifyChip channel="email" status={r.email} />
                  <NotifyChip channel="text" status={r.text} />
                </span>
              </li>
            ))}
          </ul>
          )}
        </>
      ))}
    </section>
  );

  const callOff = async () => {
    setOffError(null);
    setOffBusy(true);
    try {
      await action('shift.delete', { id: shift.id });
      queryClient.removeQueries({ queryKey: ['shift', id] });
      refresh();
      // The board opens without it, not with it for a moment.
      await queryClient.refetchQueries({ queryKey: ['shifts'] }).catch(() => {});
      navigate('/shifts');
    } catch (e) {
      setOffError(e.message);
      setOffBusy(false);
    }
  };

  if (canDesk && editing) {
    return (
      <div className="ops-page">
        <Link to="/shifts" className="ops-back">← Shifts</Link>
        <h1>Edit shift</h1>
        <EditShiftForm shift={shift} booked={active.length} onClose={() => setEditing(false)}
          onSaved={(r) => { setEditing(false); setEdited(r); refresh(); }} />
      </div>
    );
  }

  return (
    <div className="ops-page">
      <Link to="/shifts" className="ops-back">← Shifts</Link>
      <h1>{shift.title}</h1>
      {canDesk && (
        <div className="ops-actions ops-shift-tools">
          <button type="button" className="btn btn-quiet ops-tap" disabled={!online || offBusy}
            onClick={() => { setEditing(true); setEdited(null); setCallingOff(false); }}>
            Edit
          </button>
          {!callingOff ? (
            <button type="button" className="btn btn-quiet ops-tap" disabled={!online}
              onClick={() => { setCallingOff(true); setOffError(null); }}>
              Call off
            </button>
          ) : (
            <div className="ops-confirm" role="group" aria-label="Call off this shift">
              <span>
                Call off this shift?
                {active.length > 0 && ` ${people(active.length)} booked won’t be told — Notify them first if they should know.`}
              </span>
              <button type="button" className="btn ops-danger ops-tap" disabled={offBusy || !online} onClick={callOff}>
                {offBusy ? 'Calling off…' : 'Call it off'}
              </button>
              <button type="button" className="btn btn-quiet ops-tap" disabled={offBusy} onClick={() => setCallingOff(false)}>
                Keep it
              </button>
            </div>
          )}
          {!online && <NeedsSignal>Needs signal</NeedsSignal>}
          {edited && !edited.moved && <span className="ops-done" role="status">✓ Saved</span>}
        </div>
      )}
      {offError && <p className="error" role="alert">{offError}</p>}
      {canDesk && edited?.moved && !confirming && (
        <div className="ops-moved" role="status">
          <span>✓ Saved. It moved — {people(active.length)} booked {active.length === 1 ? 'has' : 'have'} the old time or place.</span>
          <button type="button" className="btn btn-primary ops-tap"
            onClick={() => {
              setConfirming(true); setResults(null); setNotifyError(null); setEdited(null);
              requestAnimationFrame(() => document.querySelector('.ops-notify[aria-label="Notify volunteers"]')?.scrollIntoView({ block: 'center' }));
            }}>
            Let them know
          </button>
        </div>
      )}
      <div className="ops-lines">
        {(shift.role || (canDesk && shift.public)) && (
          <span className="ops-chips">
            {shift.role && <span className="chip">{roleLabel(shift.role)}</span>}
            {canDesk && shift.public && <span className="chip">On the website</span>}
          </span>
        )}
        <span className="when">{longDay(shift.starts_at)} · {timeRange(shift.starts_at, shift.ends_at)}</span>
        {shift.location && <span>{shift.location}</span>}
        {shift.instructions && <span className="note">{shift.instructions}</span>}
        {shift.link && (href
          ? <a href={href} target="_blank" rel="noopener noreferrer">{shift.link.replace(/^https?:\/\//i, '')}</a>
          : <span>{shift.link}</span>)}
      </div>

      {(turfs.length > 0 || canDesk) && (
        <section className="st-walk" aria-label="Walk lists">
          {turfs.length > 0 && (
            <p className="st-walk__line">
              <strong>{turfs.length === 1 ? 'Walk list' : 'Walk lists'}:</strong> {turfNames(turfs)}
              {walkHint && <span className="st-walk__hint"> — {walkHint}</span>}
            </p>
          )}
          {canDesk && (editTurfs === null ? (
            <div className="ops-actions">
              <button type="button" className="btn btn-quiet ops-tap" disabled={!online}
                onClick={() => { setEditTurfs(turfs.map((t) => t.id)); setTurfSaved(false); setTurfError(null); }}>
                {turfs.length ? 'Change turfs' : 'Add turfs'}
              </button>
              {!online && <NeedsSignal>Needs signal</NeedsSignal>}
              {turfSaved && <span className="ops-done" role="status">✓ Saved</span>}
            </div>
          ) : (
            <div className="st-walk__edit">
              <TurfPicker id="shift-turfs-edit" value={editTurfs} onChange={setEditTurfs} disabled={turfBusy} />
              <span className="ops-meta">Anyone who counts themselves in gets these walk lists</span>
              <div className="ops-actions">
                <button type="button" className="btn ops-solid ops-tap" disabled={turfBusy || !online} onClick={saveTurfs}>
                  {turfBusy ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="btn btn-quiet ops-tap" disabled={turfBusy}
                  onClick={() => { setEditTurfs(null); setTurfError(null); }}>
                  Cancel
                </button>
              </div>
              {!online && <NeedsSignal>Needs signal</NeedsSignal>}
            </div>
          ))}
          {turfError && <p className="error" role="alert">{turfError}</p>}
        </section>
      )}

      <div className="ops-spots" aria-label={shift.capacity ? `${active.length} of ${shift.capacity} spots filled` : `${active.length} going`}>
        <span className="n">{spotsText(active.length, shift.capacity)}</span>
        <SpotsBar filled={active.length} capacity={shift.capacity} />
      </div>

      {showingCopy(shiftQ) && <p className="ops-copy"><span className="chip obx-copy">Offline copy</span></p>}

      {!canDesk && (
        <section className="ops-notify" aria-label="Your spot">
          {waiting?.name === 'shift.join' && waiting.undo ? (
            <p className="ops-pending" role="status">Taken back <span className="chip obx-chip">Not sent yet</span></p>
          ) : waiting?.name === 'shift.join' && !onIt ? (
            <div className="ops-confirm">
              <p className="ops-pending" role="status">Count me in <span className="chip obx-chip">Not sent yet</span></p>
              <button type="button" className="btn btn-quiet ops-tap" disabled={joining} onClick={takeBack}>Take back</button>
            </div>
          ) : onIt ? (
            <>
              <span className="ops-onit" role="status"><span aria-hidden="true">✓</span> You’re on this shift</span>
              {waiting?.name === 'shift.leave' ? (
                <p className="ops-pending" role="status">Can’t make it <span className="chip obx-chip">Not sent yet</span></p>
              ) : canLeave && !over && (!leaving ? (
                <button type="button" className="btn btn-quiet ops-tap" disabled={joining}
                  onClick={() => { setLeaving(true); setJoinError(null); }}>
                  Can’t make it
                </button>
              ) : (
                <div className="ops-confirm" role="group" aria-label="Can’t make it">
                  <span>Can’t make it?</span>
                  <button type="button" className="btn ops-danger ops-tap" disabled={joining}
                    onClick={() => selfAction('shift.leave')}>
                    {joining ? 'Saving…' : 'Yes'}
                  </button>
                  <button type="button" className="btn btn-quiet ops-tap" disabled={joining}
                    onClick={() => setLeaving(false)}>
                    No
                  </button>
                </div>
              ))}
            </>
          ) : over || full ? null : canJoin ? (
            <button type="button" className="btn btn-primary ops-tap ops-wide" disabled={joining}
              onClick={() => selfAction('shift.join')}>
              {joining ? 'Saving…' : 'Count me in'}
            </button>
          ) : !allowed.isPending ? (
            <p className="ops-empty">Ask your organizer to add you.</p>
          ) : null}
          {joinError && <p className="error" role="alert">{joinError}</p>}
        </section>
      )}

      {canDesk && primary === 'add' && addBlock(true)}
      {canDesk && primary === 'notify' && notifyBlock(true)}

      {/* The crew board: drag people on, and onto its turfs (ShiftCrew.jsx). */}
      {canDesk && (online
        ? <ShiftCrew shiftId={shift.id} canMap={(me?.areas ?? []).includes('map')} onChanged={refresh} />
        : <NeedsSignalLine>The crew board needs signal</NeedsSignalLine>)}

      {canDesk && online && assignees.length > 0 ? (
        <button type="button" className="ops-more disclose st-roster-toggle" aria-expanded={rosterOpen} aria-controls="shift-roster"
          onClick={() => setRosterOpen((v) => !v)}>
          Status and contact · {assignees.length}
        </button>
      ) : (
        <span className="eyebrow ops-label">On this shift · {canDesk ? assignees.length : active.length}</span>
      )}
      {error && <p className="error">{error}</p>}
      {canDesk && online && assignees.length > 0 && !rosterOpen ? null : (canDesk ? assignees : active).length === 0 ? (
        <p className="ops-empty">Nobody yet.</p>
      ) : !canDesk ? (
        <ul className="ops-plain-list">
          {active.map((a) => <NameRow key={a.assignment_id} a={a} isMe={isMine(a)} />)}
        </ul>
      ) : (
        <ul className="ops-rows" id="shift-roster">
          {assignees.map((a) => (
            <AssigneeRow
              key={a.assignment_id}
              a={a}
              open={openId === a.assignment_id}
              onToggle={() => setOpenId((cur) => (cur === a.assignment_id ? null : a.assignment_id))}
              canDesk={canDesk}
              busy={rowBusy === a.assignment_id}
              onStatus={(status) => setStatus(a, status)}
              onRemove={() => unassign(a)}
              noSignIn={noSignIn.has(a.assignment_id)}
            />
          ))}
        </ul>
      )}

      {canDesk && (
        <div className="ops-after">
          {primary !== 'add' && addBlock(false)}
          {primary !== 'notify' && notifyBlock(false)}
        </div>
      )}
    </div>
  );
}

export default function Shifts() {
  const { id } = useParams();
  const { me } = useOutletContext() ?? {};
  // Shift writes are desk work (manager / treasurer / staff); volunteers can read.
  const canDesk = me?.role !== 'volunteer';
  return id
    ? <ShiftDetail key={id} id={id} canDesk={canDesk} me={me} />
    : <ShiftList canDesk={canDesk} me={me} />;
}
