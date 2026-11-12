// Donations → Needs you: "Pledges from call time · 3 · $1,250" (ext/candidates
// calltime.js). It opens in place: each pledge a candidate heard — the
// donor, the amount, who heard it and when — with "Gift in ✓ $250" once
// the donor's gift is logged, or a quiet Drop (asked in place) for one that
// won't come. A pledge is never a gift: the desk logs the gift as ever.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { fmtBig } from './MoneyWords.js';
import { Unavailable } from './GiftImportBits.jsx';

const longDate = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function PledgeRow({ p, onDone }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const drop = async () => {
    setBusy(true); setError(null);
    try {
      await action('calltime.drop', { id: p.id });
      onDone(`Pledge from ${p.person.name} dropped`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <li className="ops-item">
      <div className="ops-row ops-row--static">
        <span className="ops-row__main">
          <Link className="ops-row__name" to={`/people/${p.person.id}`}>{p.person.name}</Link>
          <span className="ops-row__sub">{p.candidate || 'A candidate'} · {longDate(p.said_on)}{p.note ? ` · ${p.note}` : ''}</span>
          {error && <span className="error" role="alert">{error}</span>}
        </span>
        <span className="ops-row__end">
          <span className="ops-row__amt">{fmtBig(p.amount_cents)}</span>
          {p.gift_in ? (
            <span className="chip">Gift in ✓ {fmtBig(p.gift_in.amount_cents)}</span>
          ) : ask ? (
            <span className="ops-confirm">
              <span>Drop it?</span>
              <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={drop}>Yes</button>
              <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setAsk(false)}>No</button>
            </span>
          ) : (
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(true)}>Drop</button>
          )}
        </span>
      </div>
    </li>
  );
}

export function PledgesRow({ open: summary, onDone }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: ['calltime', 'pledges'], queryFn: () => apiGet('/calltime/pledges'), enabled: open });
  const n = Number(summary?.n) || 0;
  if (!Number(summary?.listed)) return null;
  const done = (text) => {
    queryClient.invalidateQueries({ queryKey: ['calltime', 'pledges'] });
    queryClient.invalidateQueries({ queryKey: ['brief'] });
    onDone(text);
  };
  return (
    <li className="ops-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls="ct-pledges" onClick={() => setOpen((v) => !v)}>
        <span className="ops-row__main">
          <span className="ops-row__name">Pledges from call time · {n ? n.toLocaleString('en-CA') : 'all in'}</span>
          <span className="ops-row__sub">{n ? 'Not gifts yet — log each gift as it comes in' : 'Each pledge’s gift is in'}</span>
        </span>
        {n > 0 && <span className="ops-row__end"><span className="ops-row__amt">{fmtBig(summary.cents)}</span></span>}
      </button>
      {open && (
        <div id="ct-pledges">
          {list.isPending && <p className="ops-meta mny-line" role="status">Loading…</p>}
          {list.isError && !list.data && <Unavailable onRetry={() => list.refetch()} busy={list.isFetching} />}
          {list.data && (list.data.pledges.length ? (
            <ul className="ops-rows">{list.data.pledges.map((p) => <PledgeRow key={p.id} p={p} onDone={done} />)}</ul>
          ) : <p className="ops-meta mny-line">No pledges waiting.</p>)}
        </div>
      )}
    </li>
  );
}
