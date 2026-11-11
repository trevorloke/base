// Donations → Needs you → "12 imported gifts need a donor"
// (/money/import/waiting) — the pile. A gift from a file whose donor could
// not be told for sure (nobody on file, or more than one record it could
// be) waits here, a donor at a time as the file names them. Nothing lands
// on a guess: a person
//   picks one of the records it could be ("Dee Twin · 2 Main St — same name
//   and postal code"),
//   finds someone else by name,
//   adds them as a new person (from what the file says), or
//   leaves the gifts out (listed at the foot, "Left out · 3", to bring back).
// Each asks first, in place, and says which record — two it could be often
// share a name ("Put 2 gifts on Dee Twin (2 Main St · V3S 1A1)? Yes · No").
// The gifts then go through the one gift path: the year's limit is checked,
// and one that takes the donor over is said here and listed under Needs you.
import { useState } from 'react';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { action, apiGet, fmtMoney } from '../api.js';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import { Unavailable, giftWord, invalidateGifts } from '../components/GiftImportBits.jsx';
import './shifts.css';
import '../components/gift-import.css';

const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const METHOD_WORD = { card: 'Card', etransfer: 'E-transfer', cheque: 'Cheque', cash: 'Cash', pad: 'Pre-authorized debit', 'in-kind': 'In-kind' };
const day = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
};
const whoIs = (donor) => donor.name || donor.email || 'No name';
// Where a record lives, in a few words: enough to tell two people apart.
const tell = (p) => [p.address, p.postal, p.email, p.phone].filter(Boolean).slice(0, 2).join(' · ');

// Find someone already on file by name, email or phone.
function FindPerson({ id, onPick }) {
  const [q, setQ] = useState('');
  const words = q.trim();
  const search = useQuery({
    queryKey: ['persons', 'search', words],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(words)}&limit=8`),
    enabled: words.length >= 2,
    placeholderData: keepPreviousData,
  });
  const found = words.length >= 2 ? (search.data?.persons ?? []) : [];
  return (
    <div className="gw-find">
      <div className="field">
        <label htmlFor={id}>Their name, email or phone</label>
        <input id={id} className="input" autoComplete="off" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {words.length >= 2 && search.isPending && <p className="ops-meta" role="status">Loading…</p>}
      {words.length >= 2 && search.isError && <p className="error" role="alert">{search.error.message}</p>}
      {words.length >= 2 && search.isSuccess && found.length === 0 && <p className="ops-meta" role="status">No one on file by that.</p>}
      {found.length > 0 && (
        <ul className="gw-cands">
          {found.map((p) => (
            <li key={p.id}>
              <button type="button" className="btn ops-tap gw-cand" onClick={() => onPick(p)}>
                <span className="gw-cand__name">{p.name}</span>
                {tell(p) && <span className="gw-cand__why">{tell(p)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One donor as the file names them, and their gifts that wait.
function Waiting({ group, index, onSettled, online }) {
  const { donor, gifts, candidates } = group;
  const [open, setOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [ask, setAsk] = useState(null); // { kind: 'person', person } | { kind: 'new' } | { kind: 'out' }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null); // the new person, once made: a second try never makes another
  const bodyId = `gw-${index}`;
  const n = gifts.length;
  const ids = gifts.map((g) => g.id);
  const them = n === 1 ? 'this gift' : `these ${n} gifts`;
  const first = gifts[0]?.date;
  const last = gifts[n - 1]?.date;

  const settle = async () => {
    const what = ask;
    setAsk(null);
    setBusy(true);
    setError(null);
    try {
      if (what.kind === 'out') {
        await action('gift.importSettle', { ids, leave_out: true });
        onSettled(`✓ ${giftWord(n)} from ${whoIs(donor)} left out`);
        return;
      }
      let person = what.person;
      if (what.kind === 'new') {
        person = made;
        if (!person) {
          const named = donor.first || donor.last ? { first_name: donor.first || undefined, last_name: donor.last || undefined } : { name: whoIs(donor) };
          person = (await action('person.create', {
            kind: 'person', ...named,
            ...Object.fromEntries(['email', 'phone', 'address', 'unit', 'city', 'postal'].filter((k) => donor[k]).map((k) => [k, donor[k]])),
          })).person;
          setMade(person);
        }
      }
      const res = await action('gift.importSettle', { ids, person_id: person.id });
      const flagged = (res.gifts || []).filter((g) => g.flagged).length;
      onSettled(`✓ ${giftWord(res.settled ?? n)} on ${res.person?.name || person.name}${flagged ? ` · ${flagged === 1 ? 'one is' : `${flagged} are`} over the year’s limit — see Needs you` : ''}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const question = !ask ? null
    : ask.kind === 'out' ? `Leave ${them} out? ${n === 1 ? 'It stays' : 'They stay'} off the books.`
      : ask.kind === 'new' ? `Add ${whoIs(donor)} as a new person and put ${them} on them?`
        : `Put ${them} on ${ask.person.name}${tell(ask.person) ? ` (${tell(ask.person)})` : ''}?`;

  return (
    <li className="ops-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="ops-row__main">
          <span className="ops-row__name">{whoIs(donor)}</span>
          <span className="ops-row__sub">
            {giftWord(n)} · {first === last ? day(first) : `${day(first)} – ${day(last)}`}
            <span className="chip">{candidates.length === 0 ? 'No one on file' : candidates.length === 1 ? 'One it could be' : `${candidates.length} it could be`}</span>
          </span>
        </span>
        <span className="ops-row__end"><span className="ops-row__amt">{fmtMoney(group.cents)}</span></span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          <p className="ops-meta">
            The file says: {[donor.email, donor.phone, [donor.address, donor.unit ? `#${donor.unit}` : null].filter(Boolean).join(' '), donor.city, donor.postal].filter(Boolean).join(' · ') || 'a name only'}
          </p>
          <ul className="gw-gifts">
            {gifts.map((g) => (
              <li key={g.id}>
                <span className="mono">{fmtMoney(g.amount_cents)}</span>
                <span>{day(g.date)}</span>
                {g.method && <span className="chip">{METHOD_WORD[g.method] ?? g.method}</span>}
                {g.receipt && <span className="ops-meta">their receipt <span className="mono">{g.receipt}</span></span>}
                <span className="ops-meta">{g.file_name}{g.row ? ` · row ${g.row}` : ''}</span>
              </li>
            ))}
          </ul>

          {ask ? (
            <div className="ops-confirm" role="group" aria-label={question}>
              <span>{question}</span>
              <button type="button" className={`btn ops-tap ${ask.kind === 'out' ? 'ops-danger' : 'ops-solid'}`} onClick={settle}>Yes</button>
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(null)}>No</button>
            </div>
          ) : (
            <>
              {candidates.length > 0 && (
                <>
                  <p className="gw-label" id={`${bodyId}-who`}>Who gave {n === 1 ? 'it' : 'them'}?</p>
                  <ul className="gw-cands" aria-labelledby={`${bodyId}-who`}>
                    {candidates.map((c) => (
                      <li key={c.id}>
                        <button type="button" className="btn ops-tap gw-cand" disabled={busy || !online} onClick={() => setAsk({ kind: 'person', person: c })}>
                          <span className="gw-cand__name">{c.name}</span>
                          <span className="gw-cand__why">{[tell(c), c.why].filter(Boolean).join(' — ')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {finding && <FindPerson id={`${bodyId}-find`} onPick={(p) => { setFinding(false); setAsk({ kind: 'person', person: p }); }} />}
              <div className="ops-actions">
                {!finding && <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={() => setFinding(true)}>{candidates.length ? 'Someone else' : 'Find them on file'}</button>}
                {finding && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setFinding(false)}>Close the search</button>}
                <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={() => setAsk({ kind: 'new' })}>Add as a new person</button>
                <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online} onClick={() => setAsk({ kind: 'out' })}>Leave out</button>
              </div>
            </>
          )}
          {busy && <p className="ops-meta" role="status">Saving…</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
    </li>
  );
}

// The pile's foot: gifts left out — by mistake, perhaps — each with Bring
// back, which only puts it back in the pile above (so nothing asks first).
function LeftOut({ out, online, onBack }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null); // the gift being brought back
  const [error, setError] = useState(null);
  if (!out?.gifts) return null;
  const back = async (g) => {
    setBusy(g.id);
    setError(null);
    try {
      await action('gift.importBringBack', { ids: [g.id] });
      await onBack(`✓ ${fmtMoney(g.amount_cents)} from ${whoIs(g.donor)} is back — it waits for a donor above`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="gw-out">
      <button type="button" className="disclose" aria-expanded={open} aria-controls="gw-out-list" onClick={() => setOpen((v) => !v)}>
        Left out · {out.gifts.toLocaleString('en-CA')}
      </button>
      {open && (
        <div id="gw-out-list">
          <ul className="gw-gifts gw-out__list">
            {out.items.map((g) => (
              <li key={g.id}>
                <span className="gw-out__who">{whoIs(g.donor)}</span>
                <span className="mono">{fmtMoney(g.amount_cents)}</span>
                <span>{day(g.date)}</span>
                <span className="ops-meta">{g.file_name}{g.row ? ` · row ${g.row}` : ''}</span>
                <button type="button" className="btn ops-tap gw-out__back" disabled={!!busy || !online} onClick={() => back(g)}>
                  {busy === g.id ? 'Bringing back…' : 'Bring back'}
                </button>
              </li>
            ))}
          </ul>
          {out.gifts > out.items.length && <p className="ops-meta">The latest {out.items.length} of {out.gifts.toLocaleString('en-CA')}.</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}

export default function GiftsWaiting() {
  const { me } = useOutletContext() ?? {};
  const queryClient = useQueryClient();
  const canMoney = MONEY_ROLES.includes(me?.role);
  const online = useOnline();
  const [said, setSaid] = useState(null);
  const pile = useQuery({ queryKey: ['giftimports', 'waiting'], queryFn: () => apiGet('/gifts/imports/waiting'), enabled: canMoney });
  if (!canMoney) return <Navigate to="/money" replace />;

  const groups = pile.data?.groups ?? [];
  const gifts = groups.reduce((n, g) => n + g.gifts.length, 0);
  const onSettled = (text) => { setSaid(text); return invalidateGifts(queryClient); };

  return (
    <div className="ops-page">
      <Link to="/money" className="ops-back">← Donations</Link>
      <div className="ops-head"><h1>Gifts that need a donor</h1></div>
      {!online && <NeedsSignalLine>Picking a donor needs signal</NeedsSignalLine>}
      {said && <p className="ops-done" role="status">{said}</p>}

      {noSignal(pile) ? <NoSignal />
        : pile.isPending ? <p className="ops-meta" role="status">Loading…</p>
          : pile.isError && !pile.data ? <Unavailable onRetry={() => pile.refetch()} busy={pile.isFetching} />
            : groups.length === 0 ? (
              <div className="ops-empty-block">
                <p className="ops-empty">Nothing waiting — every imported gift has a donor.</p>
                <Link className="btn ops-tap" to="/money">Back to Donations</Link>
              </div>
            ) : (
              <>
                <p className="ops-meta gw-lead">{giftWord(gifts)} from a file, as it names {groups.length === 1 ? 'the donor' : `${groups.length} donors`}. Tap one to say who gave.</p>
                <ul className="ops-rows">
                  {groups.map((g, i) => (
                    <Waiting key={g.gifts.map((x) => x.id).join('|')} group={g} index={i} online={online} onSettled={onSettled} />
                  ))}
                </ul>
                {pile.data?.more && <p className="ops-meta">These are the first 300 gifts. The rest follow once these have a donor.</p>}
              </>
            )}
      {pile.data && <LeftOut out={pile.data.left_out} online={online} onBack={onSettled} />}
    </div>
  );
}
