// /people/duplicates (the desk, the People area): two records that look like
// one person — the same email, the same phone and name, or the same name at
// one door — side by side. "Keep this one" merges the other into it
// (person.merge: everything that pointed at the other moves; blanks are
// filled; it asks once). "Not the same" keeps the pair away.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import './duplicates.css';

const WHY = { email: 'Same email', phone: 'Same phone and name', address: 'Same name at the same door' };
const when = (iso) => new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function Side({ p, other, busy, onKeep }) {
  const lines = [p.email, p.phone, [p.unit, p.address, p.city].filter(Boolean).join(' · ')].filter(Boolean);
  const history = [count(p.contacts, 'contact', 'contacts'), p.gifts ? count(p.gifts, 'gift', 'gifts') : null, p.shifts ? count(p.shifts, 'shift', 'shifts') : null].filter(Boolean);
  return (
    <div className="dup-side">
      <Link className="dup-name" to={`/people/${p.id}`}>{p.name}</Link>
      {lines.map((l) => <span key={l} className="dup-line">{l}</span>)}
      {p.tags.length > 0 && <span className="dup-line muted">{p.tags.join(', ')}</span>}
      <span className="dup-line muted">{history.join(' · ')} · added {when(p.created_at)}</span>
      <button type="button" className="btn ops-tap dup-keep" disabled={busy} onClick={() => onKeep(p, other)}>Keep this one</button>
    </div>
  );
}

function Pair({ pair, onDone }) {
  const online = useOnline();
  const [asking, setAsking] = useState(null); // { keep, drop }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input, said) => {
    setBusy(true); setError(null);
    try {
      const r = await action(name, input);
      onDone(said(r));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <li className="card dup-pair">
      <p className="dup-why">{pair.why.map((w) => WHY[w] || w).join(' · ')}</p>
      <div className="dup-sides">
        <Side p={pair.a} other={pair.b} busy={busy || !online} onKeep={(keep, drop) => setAsking({ keep, drop })} />
        <Side p={pair.b} other={pair.a} busy={busy || !online} onKeep={(keep, drop) => setAsking({ keep, drop })} />
      </div>
      {asking ? (
        <div className="ops-confirm" role="group" aria-label="Merge">
          <span>
            Make them one: keep <strong>{asking.keep.name}</strong>
            {asking.keep.created_at !== asking.drop.created_at && <> ({when(asking.keep.created_at)})</>}? The other’s
            history moves over and fills its blanks.
          </span>
          <button type="button" className="btn btn-primary ops-tap" disabled={busy || !online}
            onClick={() => run('person.merge', { keep: asking.keep.id, drop: asking.drop.id }, (r) => (
              `✓ ${asking.keep.name}: one record${r.flagged?.length ? ' — over the donation limit now, flagged in Donations' : ''}`))}>
            {busy ? 'Merging…' : 'Merge'}
          </button>
          <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
        </div>
      ) : (
        <div className="ops-actions">
          <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online}
            onClick={() => run('person.notDuplicate', { a: pair.a.id, b: pair.b.id }, () => `Kept apart: ${pair.a.name} and ${pair.b.name}`)}>
            Not the same
          </button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </li>
  );
}

export default function Duplicates() {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: ['duplicates'], queryFn: () => apiGet('/duplicates') });
  const [said, setSaid] = useState(null);
  const done = (text) => {
    setSaid(text);
    qc.invalidateQueries({ queryKey: ['duplicates'] });
    qc.invalidateQueries({ queryKey: ['persons'] });
    qc.invalidateQueries({ queryKey: ['person'] });
    qc.invalidateQueries({ queryKey: ['doors'] });
  };
  return (
    <div className="ops-page dup-page">
      <Link to="/people" className="ops-back">← People</Link>
      <h1>Duplicates</h1>
      <p className="muted">Two records that look like one person. Keep the better one: the other’s contacts, gifts, shifts, lists and answers move to it.</p>
      {!online && <NeedsSignalLine>Merging needs signal</NeedsSignalLine>}
      {said && <p className="ops-done" role="status">{said}</p>}
      {!q.data ? (
        noSignal(q) ? <NoSignal /> : q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>
      ) : q.data.pairs.length === 0 ? (
        <p className="ops-empty">No duplicates found.</p>
      ) : (
        <>
          <ul className="dup-list" aria-label="Possible duplicates">
            {q.data.pairs.map((p) => <Pair key={`${p.a.id}:${p.b.id}`} pair={p} onDone={done} />)}
          </ul>
          {q.data.more && <p className="muted">More after these — merge or set these apart to see them.</p>}
        </>
      )}
    </div>
  );
}
