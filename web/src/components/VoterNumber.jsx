// A profile's voter number (server/ext/voternumber), under More details:
// the number the list of electors gives this voter, when it has one. The
// desk reads it and can set, change or clear it (person.voterNumber); a
// volunteer never receives it. People → Import fills it from a file, and
// matches on it first.
import { useEffect, useState } from 'react';
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
  useEffect(() => { setDraft(null); }, [onFile]);

  if (noSignal(q)) return <p className="ops-meta vn-line">Voter number: no signal</p>;
  if (q.isPending) return <p className="ops-meta vn-line" role="status">Voter number: Loading…</p>;
  if (q.isError && !q.data) {
    return (
      <p className="vn-line vn-down" role="alert">
        <span>Voter number: unavailable</span>
        <button type="button" className="btn vn-btn" onClick={() => q.refetch()} disabled={q.isFetching}>Try again</button>
      </p>
    );
  }

  const value = draft ?? onFile;
  const changed = value.trim() !== onFile;
  const save = async (e) => {
    e.preventDefault();
    if (!changed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await action('person.voterNumber', { id: personId, voter_number: value.trim() || null });
      queryClient.setQueryData(['person', personId, 'voter-number'], { voter_number: res.voter_number || null });
      setDraft(null);
      setSaid('✓ Saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="vn-form" onSubmit={save} aria-label="Voter number">
      <div className="field vn-field">
        <label htmlFor={`vn-${personId}`}>Voter number</label>
        <input id={`vn-${personId}`} className="input mono vn-input" maxLength={60} autoComplete="off" spellCheck={false}
          disabled={busy || !online} value={value} onChange={(e) => { setSaid(null); setError(null); setDraft(e.target.value); }} />
      </div>
      <button type="submit" className="btn vn-btn" disabled={busy || !online || !changed}>{busy ? 'Saving…' : 'Save'}</button>
      <span className="vn-said" role="status">{said && !changed ? said : (!online ? 'Needs signal' : '')}</span>
      {error && <p className="error vn-error" role="alert">{error}</p>}
    </form>
  );
}
