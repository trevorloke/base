// Who voted (/gotv): a scrutineer or runner enters the names they wrote
// down at a voting place — outside it, phones away inside. A few letters,
// one tap on the right person, the next name. The desk reaches the same
// screen from Get out the vote → Voting places → Enter a sheet (?place=).
//
// Never a list of people, never whether anyone was already marked: the
// look-up (GET /gotv/find) answers names and streets only, and a mark's
// answer is the same for everyone (ext/voted).
//
// Sending rule: until the place closes (or the office releases the day, or
// the Chief Election Officer's yes is recorded) names are written here and
// kept on this phone only (components/gotvNotes.js) — no look-up, since a
// look-up sends the name. When sending opens they become "names to match".
// No signal, or a look-up that doesn't answer in 4 s: the typed name becomes
// a note at once, with no retyping. Marks go through the outbox.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../api.js';
import { NS } from '../base.js';
import { newClientId, onOutboxSent, practiceWasOver, queueAction, undoQueued, useOutbox } from '../offline.js';
import { useVotedMode } from '../components/Voted.jsx';
import { addNote, dropNote, onNotes, readNotes } from '../components/gotvNotes.js';
import { useOnline } from '../components/NoSignal.jsx';
import './gotv.css';

const DEBOUNCE_MS = 400;
const LOOKUP_MS = 4000;
const NOTE_MODE_MS = 60_000;
const UNDO_MS = 15 * 60_000;
const TOAST_MS = 8000;
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (t) => fold(t).replace(/[,–—-]/g, ' ').split(/\s+/).filter((w) => w && !/^x+$/.test(w));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const clock = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
// "8:00 p.m." from the campaign's wall time "20:00".
const hmWord = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`; };
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const num = (n) => Number(n || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// This phone's own entries today (never anyone else's): { cid, name, at, sent_at, undone }.
const enteredKey = (me) => (me?.user?.id && me?.workspace?.id ? `${NS}gotv-entered:${me.workspace.id}:${me.user.id}` : null);
const readEntered = (me) => {
  const k = enteredKey(me);
  try { return (JSON.parse(localStorage.getItem(k) || '[]') || []).filter((e) => sameDay(e.at, Date.now())); } catch { return []; }
};
const writeEntered = (me, list) => {
  const k = enteredKey(me);
  try { if (k) localStorage.setItem(k, JSON.stringify(list)); } catch { /* storage full or blocked */ }
};

// A look-up a phone can answer from a shorter one it already has: the
// shorter answer was complete (no `more`), so the longer text only filters.
const fromCache = (cache, q) => {
  const ws = words(q);
  let best = null;
  for (const [k, v] of cache) if (fold(q).startsWith(k) && !v.more && (!best || k.length > best.k.length)) best = { k, v };
  if (!best) return null;
  return best.v.rows.filter((r) => ws.every((w) => fold(`${r.name} ${r.where}`).includes(w)));
};

export default function WhoVoted({ me: given }) {
  const ctx = useOutletContext();
  const me = given || ctx?.me;
  const [params] = useSearchParams();
  const mode = useVotedMode();
  const status = mode.status;
  const online = useOnline();
  const outbox = useOutbox();
  const desk = Boolean(me?.admin_role || (me?.role && me.role !== 'volunteer'));
  const duty = status?.on_duty || null;
  const practice = Boolean(status?.practice && status?.active);
  // The place: a scrutineer's own; a runner or the desk picks.
  const fixedPlace = duty?.role === 'scrutineer' ? duty.place : null;
  const [picked, setPicked] = useState(params.get('place') || '');
  const places = useQuery({
    queryKey: ['gotv', 'places'], queryFn: () => apiGet('/gotv/places'), enabled: !fixedPlace && Boolean(duty || desk), staleTime: 60_000, meta: { side: true },
  });
  const placeList = places.data?.places || [];
  const place = fixedPlace || placeList.find((p) => p.id === picked) || null;
  const placeId = place?.id || null;

  // Sending open for this place: the server's word for a scrutineer's own
  // place, or the place's own close (or a release) for a runner's pick.
  const closesAt = fixedPlace ? status?.closes_at : place?.closes_at ?? null;
  const closesHm = fixedPlace ? status?.closes_hm : place?.closes_hm ?? null;
  const open = practice || status?.send === 'live' || (fixedPlace ? Boolean(status?.send_open)
    : Boolean(status?.send_open) || Boolean(closesAt && Date.now() >= Date.parse(closesAt)));
  const [heldByServer, setHeldByServer] = useState(false);
  const [noteUntil, setNoteUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!noteUntil) return undefined;
    const t = setTimeout(() => { setNoteUntil(0); tick((n) => n + 1); }, Math.max(0, noteUntil - Date.now()));
    return () => clearTimeout(t);
  }, [noteUntil]);
  const sending = open && !heldByServer;
  const noteMode = !sending || !online || noteUntil > Date.now();

  const [text, setText] = useState('');
  const [writtenAt, setWrittenAt] = useState(null); // matching a note: when it was written
  const [matching, setMatching] = useState(null); // the note being matched
  const [rows, setRows] = useState(null); // { rows, more } | null
  const [looking, setLooking] = useState(false);
  const [said, setSaid] = useState(null); // a refusal or a note, in place
  const [toast, setToast] = useState(null); // { text, undo? }
  const [flash, setFlash] = useState(null);
  const [notes, setNotes] = useState(() => readNotes(me));
  const [entered, setEntered] = useState(() => readEntered(me));
  const [showEntered, setShowEntered] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [overSaid, setOverSaid] = useState(false);
  const inputRef = useRef(null);
  const cache = useRef(new Map());
  const ctrl = useRef(null);
  const toastT = useRef(null);
  useEffect(() => onNotes(() => setNotes(readNotes(me))), [me]);
  useEffect(() => { setNotes(readNotes(me)); setEntered(readEntered(me)); }, [me]);
  // A practice mark that reached the server after practice ended: said once.
  useEffect(() => { if (practiceWasOver() > 0) setOverSaid(true); }, [outbox.items]);
  // A mark that waited on the phone: its undo window starts when it lands.
  useEffect(() => onOutboxSent(({ name, input }) => {
    if (name !== 'vote.mark' || !input?.client_id) return;
    setEntered((list) => {
      const next = list.map((e) => (e.cid === input.client_id && !e.sent_at ? { ...e, sent_at: new Date().toISOString() } : e));
      writeEntered(me, next);
      return next;
    });
  }), [me]);
  useEffect(() => () => { clearTimeout(toastT.current); ctrl.current?.abort(); }, []);
  // A new place, practice or sending rule: the look-ups so far don't hold.
  useEffect(() => { cache.current = new Map(); setRows(null); }, [placeId, practice, sending]);

  const say = (t) => { setToast(t); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(null), TOAST_MS); };
  const focus = () => setTimeout(() => inputRef.current?.focus(), 0);

  const saveNote = useCallback((typed, line) => {
    const t = String(typed || '').trim();
    if (t.length < 2) return;
    addNote(me, { id: newClientId(), typed: t.slice(0, 120), written_at: writtenAt || new Date().toISOString(), place_id: placeId });
    setText(''); setRows(null); setWrittenAt(null); setMatching(null);
    setSaid(line || null);
    focus();
  }, [me, placeId, writtenAt]);

  // The look-up: after 3 letters and 400 ms without typing; a new key
  // cancels the one in flight; 4 s without an answer makes it a note.
  useEffect(() => {
    ctrl.current?.abort();
    const q = text.trim();
    if (noteMode || !placeId || q.length < 3) { setRows(null); setLooking(false); return undefined; }
    const local = fromCache(cache.current, q);
    if (local) { setRows({ rows: local.slice(0, 8), more: false }); return undefined; }
    const t = setTimeout(async () => {
      const c = new AbortController();
      ctrl.current = c;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; c.abort(); }, LOOKUP_MS);
      setLooking(true);
      try {
        const qs = new URLSearchParams({ q, place_id: placeId, ...(writtenAt ? { written_at: writtenAt } : {}), ...(practice ? { practice: '1' } : {}) });
        const r = await apiGet(`/gotv/find?${qs}`, { signal: c.signal });
        cache.current.set(fold(q), { rows: r.people || [], more: Boolean(r.more) });
        setRows({ rows: r.people || [], more: Boolean(r.more) });
        setSaid(null);
      } catch (e) {
        if (e?.name === 'AbortError' && !timedOut) return;
        if (e instanceof ApiError && e.status === 409) { setHeldByServer(true); setSaid(e.message); return; }
        if (e instanceof ApiError && e.status === 429 && /limit/i.test(e.message)) { saveNote(q, e.message); return; }
        if (e instanceof ApiError && e.status < 500) { setSaid(e.message); return; }
        // No answer: keep the name, try look-ups again in a minute.
        saveNote(q, 'Saved — we’ll match it when signal is back');
        setNoteUntil(Date.now() + NOTE_MODE_MS);
      } finally {
        clearTimeout(timer);
        if (ctrl.current === c) setLooking(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, noteMode, placeId, practice, writtenAt, saveNote]);

  const mark = async (row) => {
    const cid = newClientId();
    const at = new Date().toISOString();
    setFlash(row.id);
    setTimeout(() => setFlash(null), 600);
    try {
      const r = await queueAction('vote.mark', {
        person_id: row.id, voted: true, source: 'scrutineer', place_id: placeId, client_id: cid,
        ...(writtenAt ? { client_at: writtenAt } : {}), ...(practice ? { practice: true } : {}),
      }, { who: row.name });
      const entry = { cid, name: row.name, at: writtenAt || at, sent_at: r.queued ? null : new Date().toISOString(), undone: false };
      const next = [entry, ...entered];
      setEntered(next); writeEntered(me, next);
      if (matching) dropNote(me, matching.id);
      setText(''); setRows(null); setWrittenAt(null); setMatching(null); setSaid(null);
      say({ text: `Marked ${row.name}`, undo: cid });
    } catch (e) {
      setSaid(e.message);
    }
    focus();
  };

  const undo = async (cid) => {
    const entry = entered.find((e) => e.cid === cid);
    if (!entry || entry.undone) return;
    try {
      const u = undoQueued(cid);
      if (u !== 'removed' && u !== 'queued') await queueAction('vote.undo', { client_id: cid });
      const next = entered.map((e) => (e.cid === cid ? { ...e, undone: true } : e));
      setEntered(next); writeEntered(me, next);
      say({ text: `Taken back · ${firstName(entry.name)}` });
    } catch (e) {
      say({ text: e.message });
    }
  };

  const toOffice = async () => {
    const typed = text.trim();
    if (typed.length < 2) return;
    try {
      await queueAction('gotv.check', {
        typed, place_id: placeId, written_at: writtenAt || new Date().toISOString(), ...(practice ? { practice: true } : {}),
      }, { who: typed });
      if (matching) dropNote(me, matching.id);
      setText(''); setRows(null); setWrittenAt(null); setMatching(null); setSaid(null);
      say({ text: 'Sent to the office' });
    } catch (e) {
      setSaid(e.message);
    }
    focus();
  };

  const matchNote = (n) => {
    setMatching(n); setWrittenAt(n.written_at); setText(n.typed); setSaid(null);
    if (n.place_id && !fixedPlace && n.place_id !== picked) setPicked(n.place_id);
    focus();
  };

  const queuedIds = useMemo(() => new Set(outbox.items.filter((i) => i.name === 'vote.mark' && i.state === 'pending').map((i) => i.cid)), [outbox.items]);
  const live = entered.filter((e) => !e.undone);
  const mayUndo = (e) => !e.undone && (queuedIds.has(e.cid) || !e.sent_at || Date.now() - Date.parse(e.sent_at) < UNDO_MS);
  const myNotes = notes.filter((n) => !placeId || !n.place_id || n.place_id === placeId || fixedPlace);

  if (!mode.ready) return <div className="gv-page"><h1>Who voted</h1><p className="muted">Loading…</p></div>;
  if (!duty && !desk) {
    return (
      <div className="gv-page">
        <h1>Who voted</h1>
        <p className="gv-line">This is for scrutineers and runners on a voting day. Ask the office if you should be one.</p>
        <Link to="/" className="btn">Back to Today</Link>
      </div>
    );
  }

  const heldLine = closesAt
    ? `Names are sent after this voting place closes at ${closesHm ? hmWord(closesHm) : clock(closesAt)}.`
    : 'Names are sent when the office says polls are closed.';
  const placeholder = !online ? 'No signal — write the name, we’ll match it later' : noteMode ? 'Write a name' : 'Name, street or voter number';
  const q = text.trim();
  return (
    <div className="gv-page">
      <div className="gv-head">
        <h1>Who voted</h1>
        {fixedPlace ? <span className="chip gv-place">{fixedPlace.name}</span> : (
          <label className="gv-pick">
            <span className="gv-sr">Which voting place?</span>
            <select className="input gv-pick__sel" value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Which voting place?">
              <option value="">Which voting place?</option>
              {placeList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {practice && <span className="chip gv-practice">Practice</span>}
      </div>
      <p className="gv-line gv-phones">Phones away inside the voting place. Enter names outside.</p>
      {!sending && <p className="gv-line" role="status">{heldByServer && said ? said : heldLine}</p>}
      {overSaid && <p className="gv-line gv-warn" role="status">Practice is over — nothing was saved.</p>}
      {!placeId && !fixedPlace && <p className="gv-line">Pick the voting place on the sheet first.</p>}

      <form className="gv-form" onSubmit={(e) => { e.preventDefault(); if (noteMode) saveNote(text); }}>
        <label htmlFor="gv-q" className="gv-sr">{noteMode ? 'Write a name' : 'Name, street or voter number'}</label>
        <input id="gv-q" ref={inputRef} className="input gv-input" autoFocus autoComplete="off" inputMode="search" spellCheck={false}
          value={text} placeholder={placeholder} disabled={!placeId}
          onChange={(e) => { setText(e.target.value); if (!e.target.value) { setWrittenAt(null); setMatching(null); } }} />
        {noteMode && <button type="submit" className="btn btn-primary gv-save" disabled={!placeId || q.length < 2}>Save name</button>}
      </form>
      <p className="gv-said" role="status" aria-live="polite">{said && !(heldByServer && !sending) ? said : looking ? 'Looking…' : ''}</p>

      {!noteMode && q.length >= 3 && rows && (
        <div className="gv-results">
          {rows.rows.length ? (
            <ul className="gv-rows" aria-label="Matches">
              {rows.rows.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`gv-row${flash === r.id ? ' is-flash' : ''}`} onClick={() => mark(r)}>
                    <strong className="gv-row__name">{r.name}</strong>
                    <span className="gv-row__where">{r.where}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="gv-line">No one by that name.</p>}
          {rows.more && <p className="gv-line gv-more">More than 8 — add the street or voter number.</p>}
        </div>
      )}
      {!noteMode && q.length >= 2 && (
        <button type="button" className="btn btn-quiet gv-office" onClick={toOffice}>Not sure? Send to the office</button>
      )}

      {myNotes.length > 0 && (
        <section className="gv-notes" aria-labelledby="gv-notes-h">
          <h2 id="gv-notes-h" className="gv-h">{sending && online ? `Polls closed — match your ${plural(myNotes.length, 'name')}` : `${plural(myNotes.length, 'name')} to send`}</h2>
          <ul className="gv-notelist">
            {myNotes.map((n) => (
              <li key={n.id} className="gv-note">
                {sending && online ? (
                  <button type="button" className="gv-note__match" onClick={() => matchNote(n)}>
                    <span className="gv-note__typed">{n.typed}</span><span className="gv-note__at mono">{clock(n.written_at)}</span>
                  </button>
                ) : (
                  <span className="gv-note__match gv-note__static"><span className="gv-note__typed">{n.typed}</span><span className="gv-note__at mono">{clock(n.written_at)}</span></span>
                )}
                {deleting === n.id ? (
                  <span className="gv-confirm" role="group" aria-label="Delete this name?">
                    <span>Delete this name?</span>
                    <button type="button" className="btn gv-small" onClick={() => { dropNote(me, n.id); setDeleting(null); }}>Yes</button>
                    <button type="button" className="btn btn-quiet gv-small" onClick={() => setDeleting(null)}>No</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-quiet gv-x" aria-label={`Delete ${n.typed}`} onClick={() => setDeleting(n.id)}>✕</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="gv-foot">
        <p className="gv-count mono">{plural(live.length, 'name')} entered today</p>
        {entered.length > 0 && (
          <>
            <button type="button" className="btn btn-quiet gv-disclose" aria-expanded={showEntered} onClick={() => setShowEntered((o) => !o)}>
              Entered today
            </button>
            {showEntered && (
              <ul className="gv-entered">
                {entered.map((e) => (
                  <li key={e.cid} className={e.undone ? 'is-undone' : ''}>
                    <span className="gv-entered__name">{e.name}</span>
                    <span className="mono gv-entered__at">{clock(e.at)}</span>
                    {queuedIds.has(e.cid) && <span className="chip fk-wait">Not sent</span>}
                    {e.undone ? <span className="muted">Taken back</span>
                      : mayUndo(e) && <button type="button" className="btn btn-quiet gv-small" onClick={() => undo(e.cid)}>Undo</button>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </footer>

      <div className="gv-toast" role="status" aria-live="polite">
        {toast && (
          <span className="gv-toast__in">
            {toast.text}
            {toast.undo && <> · <button type="button" className="gv-toast__act" onClick={() => { undo(toast.undo); }}>Undo</button></>}
          </span>
        )}
      </div>
    </div>
  );
}
