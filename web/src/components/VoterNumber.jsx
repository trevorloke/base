// A profile's voter number (server/ext/voternumber), under More details:
// the number the list of electors gives this voter, when it has one. The
// desk reads it and can set, change or clear it (person.voterNumber); a
// volunteer never receives it. People → Import fills it from a file, and
// matches on it first.
//
// It saves itself when you leave the box or press Enter, and says so: the
// section's one Save, at its foot, is the campaign's fields' — a number
// typed here and left is never silently dropped.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { noSignal, useOnline } from './NoSignal.jsx';
import './voter-number.css';

export default function VoterNumber({ personId }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const q = useQuery({
    queryKey: ['person', personId, 'voter-number'],
    queryFn: () => apiGet(`/persons/${personId}/voter-number`),
    enabled: Boolean(personId),
  });
  const onFile = q.data?.voter_number || '';
  const [draft, setDraft] = useState(null); // null: as on file
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const saving = useRef(false);
  const box = useRef(null);
  const saveRef = useRef(null);
  useEffect(() => { setDraft(null); }, [onFile]);
  // Signal back with a number typed and left while it was out: save it then.
  useEffect(() => { if (online && document.activeElement !== box.current) saveRef.current?.(); }, [online]);

  if (noSignal(q)) return <p className="ops-meta vn-line">Voter number: no signal</p>;
  if (q.isPending) return <p className="ops-meta vn-line" role="status">Voter number: Loading…</p>;
  if (q.isError && !q.data) {
    return (
      <p className="vn-line vn-down" role="alert">
        <span>Voter number: unavailable —</span>
        <button type="button" className="btn vn-btn" onClick={() => q.refetch()} disabled={q.isFetching}>Try again</button>
      </p>
    );
  }

  const value = draft ?? onFile;
  const changed = value.trim() !== onFile;
  const save = async () => {
    const typed = value.trim();
    if (typed === onFile || saving.current || !online) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await action('person.voterNumber', { id: personId, voter_number: typed || null });
      queryClient.setQueryData(['person', personId, 'voter-number'], { voter_number: res.voter_number || null });
      // As kept ("123 456-789" is 123456789) — unless more was typed meanwhile.
      setDraft((d) => (d === null || d.trim() === typed ? null : d));
      setSaid(typed ? '✓ Saved' : '✓ Cleared');
    } catch (err) {
      setError(err.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  saveRef.current = save;
  const status = busy ? 'Saving…'
    : !online ? (changed ? 'Not saved — needs signal' : 'Needs signal')
      : changed ? (error ? '' : 'Saves when you leave the box')
        : said || '';

  return (
    <form className="vn-form" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label="Voter number">
      <div className="field vn-field">
        <label htmlFor={`vn-${personId}`}>Voter number</label>
        <input ref={box} id={`vn-${personId}`} className="input mono vn-input" maxLength={40} autoComplete="off" spellCheck={false}
          enterKeyHint="done" aria-describedby={`vn-${personId}-said`}
          disabled={!online} value={value} onBlur={save}
          onChange={(e) => { setSaid(null); setError(null); setDraft(e.target.value); }} />
      </div>
      <span id={`vn-${personId}-said`} className={`vn-said${status === said && said ? ' is-ok' : ''}`} role="status">{status}</span>
      {error && <p className="error vn-error" role="alert">{error}</p>}
    </form>
  );
}
