// The From line on a send: "From: Imagine Surrey <media@…> · Change".
// Reads GET /api/senders (['senders']). Only the desk chooses (canChoose);
// anyone else sees the default and sends no sender_id — the server would
// ignore it anyway. Change opens chips of the addresses; the one picked is
// handed up as an id (onChange), sent as sender_id. While the read is on its
// way or failed the line says so, and Send stays on: the server picks the
// default by itself.
//   use: 'email' (newsletters, emails to a list) or 'press' (releases)
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { LOADING, Unavailable } from './AudienceBits.jsx';
import './senders.css';

export const SENDERS_KEY = ['senders'];
export const useSenders = (enabled = true) => useQuery({ queryKey: SENDERS_KEY, queryFn: () => apiGet('/senders'), enabled });
export const fromWords = (s) => (s ? (s.name ? `${s.name} <${s.email}>` : s.email) : '');

// What a send of this kind goes from, and what the desk may pick instead.
// The system address (MAIL_FROM) is a choice only while it is the default:
// a send can't ask for it over a default the manager set.
export const fromChoices = (data, use) => {
  if (!data) return { current: null, choices: [] };
  const def = data.defaults?.[use] || null;
  const list = data.senders || [];
  const current = (def && list.find((s) => s.id === def)) || data.system;
  const choices = [...(!def || !list.some((s) => s.id === def) ? (data.system ? [{ id: null, ...data.system }] : []) : []), ...list];
  return { current, choices };
};

export default function SenderPick({ use, value, onChange }) {
  const q = useSenders();
  const [open, setOpen] = useState(false);
  const id = useId();
  if (q.isPending) return <p className="sp-line" role="status">From: {LOADING}</p>;
  if (q.isError) return <p className="sp-line" role="status">From: <Unavailable onRetry={() => q.refetch()} /></p>;
  const { current, choices } = fromChoices(q.data, use);
  const picked = value !== undefined ? choices.find((c) => c.id === value) || current : current;
  const canChange = q.data.canChoose && choices.length >= 2;
  return (
    <div className="sp" data-testid="sender-pick">
      <p className="sp-line">
        <span className="sp-label">From:</span> <span className="sp-addr">{picked ? fromWords(picked) : 'the campaign’s address'}</span>
        {canChange && (
          <> · <button type="button" className="sp-change" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>Change</button></>
        )}
      </p>
      {canChange && open && (
        <div id={id} className="sp-chips" role="radiogroup" aria-label="Send from">
          {choices.map((c) => {
            const on = (picked?.email || '') === c.email;
            return (
              <button key={c.id || 'system'} type="button" role="radio" aria-checked={on} className={`chip sp-chip${on ? ' is-on' : ''}`}
                onClick={() => { onChange?.(c.id ?? undefined); setOpen(false); }}>
                {fromWords(c)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
