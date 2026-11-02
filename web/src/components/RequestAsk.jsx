// Ask the office — under More on the walk list's door and the map's door
// card. One quiet button; tapping it opens a small sheet in place: what it's
// about (Call them back · Wants to volunteer · Has a question · Something
// else), one line for what they said, Send and Cancel. Send goes through the
// outbox (request.ask, keyed by an id made here), so with no signal it is
// kept on the phone ("Ask the office · Saved offline") and sent once later.
// Afterwards the button reads "Asked the office · 2:10 pm" — from the
// outbox while it waits there, else from the person's requests on the
// server (the newest one still open; a volunteer gets the kind and when
// only). Tapping it again asks something else.
//
// toast(text) is the screen's own (the map's or the walk list's); only the
// text is passed, which both read the same way.
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, ApiError } from '../api.js';
import { clockText, queueAction, useOutbox } from '../offline.js';
import { queuedSaid } from './queued.js';
import { useOnline } from './NoSignal.jsx';
import '../pages/requests.css';

// The kinds in words (server/ext/requests KIND_WORDS; offline.js's sheet).
export const KIND_WORDS = {
  call_back: 'Call them back',
  volunteer: 'Wants to volunteer',
  question: 'Has a question',
  other: 'Something else',
};
const KINDS = Object.keys(KIND_WORDS);

export const requestsKey = (personId) => ['person', personId, 'requests'];

// A person picked at a door with several people: a fresh sheet for each.
export default function RequestAsk(props) {
  if (!props.person?.id || props.person.pending) return null;
  return <Ask key={props.person.id} {...props} />;
}

function Ask({ person, toast }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const id = useId();
  const online = useOnline();
  const outbox = useOutbox();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: requestsKey(person.id),
    queryFn: () => apiGet(`/persons/${person.id}/requests`),
    enabled: online,
  });

  // Still on the phone, else the newest still open on the server.
  const waiting = outbox.items.filter((i) => i.name === 'request.ask' && i.state === 'pending' && i.input?.person_id === person.id).at(-1);
  const openOne = (q.data?.requests || []).find((r) => !(r.done ?? r.done_at));
  const at = waiting?.at || openOne?.created_at || null;

  const close = () => { setOpen(false); setKind(null); setNote(''); setError(null); };

  const send = async () => {
    if (!kind || busy) return;
    setBusy(true);
    setError(null);
    try {
      const said = note.trim();
      const r = await queueAction('request.ask', { person_id: person.id, kind, ...(said ? { note: said } : {}) }, { who: person.name });
      const row = r.result?.request;
      if (!r.queued && row) {
        queryClient.setQueryData(requestsKey(person.id), (d) => ({
          ...(d || {}),
          requests: [{ id: row.id, kind: row.kind, created_at: row.created_at, done: false, done_at: null }, ...(d?.requests || []).filter((x) => x.id !== row.id)],
        }));
      }
      toast?.(r.queued ? queuedSaid(r, 'Ask the office') : 'Sent to the office');
      close();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'Not sent — this person isn’t on the list' : 'Not sent — try again');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="rq">
        <button type="button" className="btn rq-open" aria-expanded={false} onClick={() => setOpen(true)}>
          {at ? `Asked the office · ${clockText(at)}` : 'Ask the office'}
        </button>
      </div>
    );
  }
  return (
    <div className="rq rq-sheet" role="group" aria-labelledby={`${id}-h`}>
      <p className="rq-h" id={`${id}-h`}>Ask the office about {person.name}</p>
      <div className="rq-kinds" role="radiogroup" aria-label="What it’s about">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k}
            className={`rq-kind${kind === k ? ' is-on' : ''}`} onClick={() => setKind(k)}>
            {KIND_WORDS[k]}
          </button>
        ))}
      </div>
      <label htmlFor={`${id}-note`} className="rq-sr">What they said</label>
      <input id={`${id}-note`} className="input rq-note" maxLength={500} autoComplete="off"
        placeholder="What they said" value={note} onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
      {error && <p className="error rq-error" role="alert">{error}</p>}
      <div className="rq-acts">
        <button type="button" className="btn rq-send" disabled={busy || !kind} onClick={send}>Send</button>
        <button type="button" className="btn btn-quiet rq-cancel" disabled={busy} onClick={close}>Cancel</button>
      </div>
    </div>
  );
}
