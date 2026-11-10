// Gifts brought in from another tool's file (server/ext/giftimport) — the
// pieces more than one screen uses:
//   invalidateGifts(queryClient)   every screen a gift shows on, after a write
//   ImportedChip · ImportedLine    Donations' ledger and a profile's gifts:
//                                  "Imported", and under an opened gift what
//                                  that means for its receipt (base.win made
//                                  none: the other tool did)
//   PileRow                        Donations → Needs you: "12 imported gifts
//                                  need a donor" — a tap to the pile
//                                  (pages/GiftsWaiting.jsx)
//   ImportsList                    the files brought in, latest first; each
//                                  can be taken back whole for a day
//                                  ("Take back gifts.csv? Yes · No")
//   Unavailable                    a read that failed, said the same way:
//                                  "Unavailable — Try again"
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, fmtMoney } from '../api.js';
import { NoSignal, noSignal } from './NoSignal.jsx';
import './gift-import.css';

const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');
export const giftWord = (n, tail = '') => `${fmtN(n)} ${n === 1 ? 'gift' : 'gifts'}${tail}`;

const GIFT_KEYS = [['records', 'gift'], ['brief'], ['person'], ['persons'], ['receipts'], ['payments'], ['stewardship'], ['duplicates'], ['giftimports']];
export const invalidateGifts = (queryClient) => Promise.all(GIFT_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));

export const isImported = (g) => (g?.attrs?.source ?? g?.source) === 'import';
export const ImportedChip = () => <span className="chip" title="Brought in from another tool’s file">Imported</span>;
// Under an opened gift, where a receipt's line would be.
export function ImportedLine({ g }) {
  const theirs = g?.attrs?.import_receipt;
  return (
    <p className="ops-meta">
      Imported — no receipt from base.win{theirs ? <> · their receipt <span className="mono">{theirs}</span></> : null}
    </p>
  );
}

// A read that failed: never a blank where a number or a list should be.
export function Unavailable({ what = null, onRetry, busy = false }) {
  return (
    <p className="gi-down" role="alert">
      <span>{what ? `${what}: unavailable` : 'Unavailable'}</span>
      {onRetry && <button type="button" className="btn ops-tap" onClick={onRetry} disabled={busy}>Try again</button>}
    </p>
  );
}

// ── Donations → Needs you ──
export function PileRow({ waiting }) {
  const n = Number(waiting?.gifts) || 0;
  if (!n) return null;
  return (
    <li className="ops-item">
      <Link className="ops-row gi-pilerow" to="/money/import/waiting">
        <span className="ops-row__main">
          <span className="ops-row__name">{fmtN(n)} imported {n === 1 ? 'gift needs' : 'gifts need'} a donor</span>
          <span className="ops-row__sub">Pick who gave {n === 1 ? 'it' : 'each'}</span>
        </span>
        <span className="ops-row__end">
          <span className="ops-row__amt">{fmtMoney(waiting.cents)}</span>
          <span className="gi-go" aria-hidden="true">›</span>
        </span>
      </Link>
    </li>
  );
}

// ── The files brought in ──
export const useGiftImports = (enabled = true) => useQuery({
  queryKey: ['giftimports'],
  queryFn: () => apiGet('/gifts/imports'),
  enabled,
});

const when = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function ImportRow({ imp, onChanged }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const name = imp.file_name || 'This file';

  // A big import is taken back a few hundred gifts a call: keep going until none remain.
  const takeBack = async () => {
    setAsk(false);
    setBusy(true);
    setError(null);
    let voided = 0;
    try {
      for (;;) {
        const r = await action('gift.importUndo', { id: imp.id });
        voided += Number(r.voided) || 0;
        if (!(Number(r.remaining) > 0)) break;
      }
      setSaid(`✓ Taken back — ${giftWord(voided)} off the books`);
    } catch (e) {
      setError(voided ? `${e.message} — ${giftWord(voided)} taken back so far. Tap Take back again.` : e.message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <li className="gi-file">
      <div className="gi-file__main">
        <span className="gi-file__name">{name}</span>
        <span className="gi-file__meta">
          {when(imp.created_at)}{imp.by_name ? ` · ${imp.by_name}` : ''}
          {imp.undone_at
            ? <> · <span className="chip">Taken back</span></>
            : <> · {giftWord(imp.gifts)} · {fmtMoney(imp.cents)}{imp.waiting > 0 ? ` · ${fmtN(imp.waiting)} need a donor` : ''}</>}
        </span>
        {said && <span className="gi-file__said" role="status">{said}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
      {imp.can_undo && !said && (ask ? (
        <div className="ops-confirm" role="group" aria-label={`Take back ${name}`}>
          <span>Take back {name}? Its gifts leave the books.</span>
          <button type="button" className="btn ops-danger ops-tap" onClick={takeBack}>Yes</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(false)}>No</button>
        </div>
      ) : (
        <button type="button" className="btn ops-tap" disabled={busy} onClick={() => setAsk(true)}>
          {busy ? 'Taking back…' : imp.undone_at ? 'Finish taking back' : 'Take back'}
        </button>
      ))}
    </li>
  );
}

export function ImportsList() {
  const queryClient = useQueryClient();
  const q = useGiftImports();
  if (noSignal(q)) return <NoSignal />;
  if (q.isPending) return <p className="ops-meta" role="status">Loading…</p>;
  if (q.isError && !q.data) return <Unavailable what="Files brought in" onRetry={() => q.refetch()} busy={q.isFetching} />;
  const imports = q.data?.imports ?? [];
  if (!imports.length) return null;
  return (
    <section className="gi-files" aria-labelledby="gi-files-h">
      <h2 id="gi-files-h" className="gi-h">Brought in before</h2>
      <p className="ops-meta">An import can be taken back whole for a day.</p>
      <ul className="gi-files__list">
        {imports.map((imp) => <ImportRow key={imp.id} imp={imp} onChanged={() => invalidateGifts(queryClient)} />)}
      </ul>
    </section>
  );
}
