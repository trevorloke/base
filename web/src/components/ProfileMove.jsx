// The profile's lines about a move, under its header (the desk's; server/ext/moves, GET
// /persons/:id's address_status, latest_move and move_open):
//   Needs an address   "Marked moved 12 Nov by Dana — where to?" · Where to?
//   Address unknown    "Address unknown · since 12 Nov · was 13450 104 Ave"
//                      · Add new address · Undo
//   Moved here         "Moved here 12 Nov · from 13450 104 Ave" · Undo
//                      (a new address, not undone, in the last 30 days)
// Undo asks first, in place ("Put Ana back at 13450 104 Ave? Yes · No").
// A volunteer sees only "Address unknown" (addressWords).
import { useState } from 'react';
import { action } from '../api.js';
import MovePanel from './MovePanel.jsx';
import './move.css';

const DAY = 24 * 3600 * 1000;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// "12 Nov", with the year when it isn't this one.
export const dayWords = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const month = d.toLocaleString('en-CA', { month: 'short' }).replace('.', '');
  return `${d.getDate()} ${month}${d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`}`;
};
const fromWords = (m) => [m?.from_address, m?.from_unit ? `#${m.from_unit}` : null].filter(Boolean).join(' ');

// The Address line for someone marked Address unknown.
export const addressWords = (person, move, desk) => {
  if (person.address_status !== 'unknown') return null;
  if (!desk || !move || move.result !== 'unknown' || move.undone_at) return 'Address unknown';
  const was = fromWords(move);
  return ['Address unknown', `since ${dayWords(move.created_at)}`, was ? `was ${was}` : null].filter(Boolean).join(' · ');
};

export default function ProfileMove({ person, move, open, contacts = [], household = [], refresh }) {
  const [panel, setPanel] = useState(null); // 'whereTo' | 'add'
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const live = move && !move.undone_at ? move : null;
  const unknown = person.address_status === 'unknown';
  const recent = live && live.result === 'new' && Date.now() - new Date(live.created_at).getTime() <= 30 * DAY;
  const marked = open ? contacts.find((c) => c.outcome === 'moved' && !c.pending) : null;
  const was = fromWords(live);
  const first = firstName(person.name);

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('person.unmove', { move_id: live.id });
      setAsking(false);
      setSaid(`Undone — back at ${was || 'the old address'}`);
      await refresh?.();
    } catch (err) {
      setError(err.message || 'Not undone — try again');
    } finally {
      setBusy(false);
    }
  };
  const undoable = live && (unknown ? live.result === 'unknown' : recent);

  if (panel) {
    return (
      <div className="mv-profile">
        <MovePanel person={person} desk mode={panel} oldDoor={household} where="profile"
          toast={(text) => setSaid(text)}
          onClose={() => { setPanel(null); refresh?.(); }} />
      </div>
    );
  }
  if (!open && !undoable && !unknown && !said) return null;
  return (
    <div className="mv-profile" aria-live="polite">
      {open && (
        <p className="mv-pline">
          <span>Marked moved{marked ? ` ${dayWords(marked.created_at)}` : ''}{marked?.by_name ? ` by ${firstName(marked.by_name)}` : ''} — where to?</span>
          <button type="button" className="btn btn-quiet pp-btn" onClick={() => { setSaid(null); setPanel('whereTo'); }}>Where to?</button>
        </p>
      )}
      {(undoable || unknown) && !asking && (
        <p className="mv-pline">
          {unknown ? <span>{addressWords(person, move, true)}</span>
            : <span>Moved here {dayWords(live.created_at)}{was ? ` · from ${was}` : ''}</span>}
          {unknown && <button type="button" className="btn btn-quiet pp-btn" onClick={() => { setSaid(null); setPanel('add'); }}>Add new address</button>}
          {undoable && <button type="button" className="btn btn-quiet pp-btn" onClick={() => { setSaid(null); setError(null); setAsking(true); }}>Undo</button>}
        </p>
      )}
      {undoable && asking && (
        <p className="mv-pline" role="group" aria-label="Undo the move">
          <span>Put {first || 'them'} back at {was || 'the old address'}?</span>
          <button type="button" className="btn btn-quiet pp-btn" disabled={busy} onClick={undo}>Yes</button>
          <button type="button" className="btn btn-quiet pp-btn" disabled={busy} onClick={() => setAsking(false)}>No</button>
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {said && <p className="pf-saved" role="status">✓ {said}</p>}
    </div>
  );
}
