// Voted — the election-day mark on the field screens (ext/voted).
//   useVotedMode()      whether Election day is on (GET /voted/status; a
//                       side read, kept on the phone — the button still
//                       shows after a reload with no signal).
//   <VotedRow />        under a person on the walk list, the door card and
//                       the Calls card: "Voted ✓" (48px, never the yellow
//                       button) → vote.mark through the outbox, so a tap
//                       with no signal is saved and sent once. Marked: the
//                       line "✓ Voted · 9:12 a.m." and a quiet Change
//                       (a take-back is a new mark: voted:false). Nothing
//                       is drawn while Election day is off.
//   <VotedChip />       the door row's "✓ Voted" when everyone at the door
//                       has voted — "Voted · Not sent" while a mark waits.
//   pendingVoted(items) the marks still in the outbox, by person (latest wins).
//   votedWord(iso)      "Voted · 9:12 a.m." today, "Voted · Oct 18" before.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { queueAction, useOutbox } from '../offline.js';
import { queuedChip, queuedSaid } from './queued.js';
import './voted.css';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// "9:12 a.m." today, "Oct 18" before that — the phone's own clock (the walk list's fmtWhen).
const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
};
export const votedWord = (iso) => {
  const when = iso ? fmtWhen(iso) : '';
  return when ? `Voted · ${when}` : 'Voted';
};

export function useVotedMode() {
  const q = useQuery({ queryKey: ['voted', 'status'], queryFn: () => apiGet('/voted/status'), staleTime: 60_000, meta: { side: true } });
  return { on: Boolean(q.data?.on), election_day: q.data?.election_day ?? null, ready: q.data !== undefined };
}

// The marks still on this phone, by person: { voted, at } — the latest wins.
export function pendingVoted(items = []) {
  const out = {};
  for (const it of items) {
    if (it.state !== 'pending' || it.name !== 'vote.mark' || !it.input?.person_id) continue;
    out[it.input.person_id] = { voted: it.input.voted !== false, at: it.at };
  }
  return out;
}

// What a person's row says now: the server's fact, or the mark on its way.
const stateOf = (person, pending) => {
  const p = pending[person.id];
  if (p) return { voted: p.voted, at: p.at, queued: true };
  return { voted: Boolean(person.voted_at), at: person.voted_at || null, queued: false };
};

export function VotedChip({ persons = [], items }) {
  const outbox = useOutbox();
  const pending = pendingVoted(items || outbox.items);
  if (!persons.length) return null;
  const states = persons.map((p) => stateOf(p, pending));
  if (!states.every((s) => s.voted)) return null;
  const waiting = states.some((s) => s.queued);
  return (
    <span className={`chip vt-chip${waiting ? ' fk-wait' : ''}`} title={waiting ? 'Voted — not sent yet' : 'Voted'}>
      {waiting ? 'Voted · Not sent' : '✓ Voted'}
    </span>
  );
}

// toast(text, { tone, act }) — the walk list's shape; the door card and
// Calls hand in a small adapter.
export function VotedRow({ person, source = 'door', toast, onMarked }) {
  const mode = useVotedMode();
  const outbox = useOutbox();
  const [busy, setBusy] = useState(false);
  // What this row just did, until the screen loads the server's answer.
  const [local, setLocal] = useState(null); // { id, voted, at }
  useEffect(() => { setLocal(null); }, [person?.id, person?.voted_at]);
  if (!mode.on || !person) return null;
  const fromOutbox = stateOf(person, pendingVoted(outbox.items));
  const mine = local && local.id === person.id ? local : null;
  const voted = mine ? mine.voted : fromOutbox.voted;
  const at = mine ? mine.at : fromOutbox.at;
  const queued = fromOutbox.queued;

  const mark = async (v) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await queueAction('vote.mark', { person_id: person.id, voted: v, source }, { who: person.name });
      setLocal({ id: person.id, voted: v, at: new Date().toISOString() });
      const tone = r.queued ? 'queued' : 'ok';
      if (v) {
        toast?.(r.queued ? queuedSaid(r, 'Voted') : `Voted · ${firstName(person.name)}`, { tone, act: { label: 'Change', onClick: () => mark(false) } });
      } else {
        toast?.(r.queued ? queuedSaid(r, 'Not voted') : `Not voted · ${firstName(person.name)}`, { tone });
      }
      if (!r.queued) onMarked?.();
    } catch (err) {
      toast?.(`Not saved — ${err.message}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (voted) {
    return (
      <div className="vt-row vt-row--done" role="status">
        <span className="vt-done">
          ✓ {votedWord(at)}
          {queued && <span className="chip fk-wait">{queuedChip()}</span>}
        </span>
        <button type="button" className="btn btn-quiet vt-change" disabled={busy} onClick={() => mark(false)}>Change</button>
      </div>
    );
  }
  return (
    <div className="vt-row">
      <button type="button" className="btn vt-btn" disabled={busy} onClick={() => mark(true)}>
        Voted <span aria-hidden="true">✓</span>
      </button>
    </div>
  );
}
