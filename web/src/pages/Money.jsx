// Donations (the /money screen) — what came in, and what needs the desk.
//   Top: one big "Raised this year" number, then "Needs you": gifts over
//   the contribution limit ("Over limit":
//   "$150 over the $1,250 limit", the legal wording under "Why?", Donor ·
//   Void right there) — and receipts with no home address ("Needs address":
//   Street address · Save address right there; the receipt's email waits).
//   One yellow "Log a gift" (?new=1; ?person=<id> preselects the donor):
//   donor, amount, date — paid by, cadence and note under "More details"
//   (and the donor's street address when none is on file).
//   Type-ahead donor picker (never type IDs). Saving says "✓ $150 from Owen
//   Patel · receipt emails in a minute" (Undo voids it, and the email never
//   goes); a cap crossing also raises an "Over limit" banner. Voiding a gift
//   whose receipt was already emailed asks "Receipt already emailed — send a
//   void notice? Yes · No".
//   The ledger: rows of donor, amount, date (+ monthly / over limit chips). Tap
//   a row for how it was paid, note, the donor's profile and Void ("Void this
//   gift? Yes · No", then a 7s Undo).
//   Under "More": receipts.
//   Dollars on screen, integer cents on the wire; cursor-paginated load more.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  useInfiniteQuery, useQuery, useQueryClient, keepPreviousData,
} from '@tanstack/react-query';
import { apiGet, action, fmtMoney, fmtDate, todayISO, dollarsToCents } from '../api.js';
import { SLATES, DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';
import ReceiptsGiftLine from '../components/ReceiptsGiftLine.jsx';
import { AddressRow, VoidNoticeAsk, receiptOf, receiptNote } from '../components/ReceiptsNeeds.jsx';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import './shifts.css';

// gift.log / gift.void / gift.restore and GET /records/* are desk-only
// (server: MONEY_ROLES; volunteers get 403 on both reads and writes).
const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
// Registry: gift.method / gift.cadence select options, in plain words.
const METHODS = ['card', 'etransfer', 'cheque', 'cash', 'in-kind'];
const METHOD_WORD = { card: 'Card', etransfer: 'E-transfer', cheque: 'Cheque', cash: 'Cash', 'in-kind': 'In-kind' };
const methodWord = (m) => METHOD_WORD[m] ?? m;
const CADENCES = [
  { code: 'one-time', label: 'One-time' },
  { code: 'monthly', label: 'Monthly' },
];
// Which slate a contribution is to (the limit is per slate). A gift to the
// first slate wears no chip; one to another slate says which.
const MANY_SLATES = SLATES.length > 1;
const SlateChip = ({ slate }) => (MANY_SLATES && slate && slate !== DEFAULT_SLATE
  ? <span className="chip" title="The slate this contribution is to">{slateLabel(slate)}</span> : null);
// The ledger opens on the latest few; the rest is one tap ("All gifts").
const LATEST = 3;

// "$3,325" for the big number; rows keep the cents.
const fmtBig = (cents) => fmtMoney(cents).replace(/\.00$/, '');

// Over the contribution limit, in one line: "$150 over the $1,250 limit".
// The server's flag_reason reads "<donor> is at $1400.00 for 2026 — over the
// $1250.00 limit (<legal source>)"; a fresh gift.log also returns the numbers.
const parseOver = (reason) => {
  const m = /at \$([\d,]+(?:\.\d+)?) for (\d{4}) — over the \$([\d,]+(?:\.\d+)?) limit/.exec(String(reason || ''));
  if (!m) return null;
  const cents = (v) => Math.round(Number(v.replace(/,/g, '')) * 100);
  return { totalCents: cents(m[1]), capCents: cents(m[3]) };
};
// The brief's flagged rows carry the numbers (total_cents: the donor's total
// for that year as it stands; cap_cents: the limit); a ledger row, or a brief
// without them, falls back to reading flag_reason.
const centsOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const overOf = (g) => {
  const totalCents = centsOrNull(g?.total_cents);
  const capCents = centsOrNull(g?.cap_cents);
  return totalCents != null && capCents != null ? { totalCents, capCents } : parseOver(g?.flag_reason);
};
const overLine = (c) => (c && Number.isFinite(c.totalCents) && Number.isFinite(c.capCents) && c.totalCents > c.capCents
  ? `${fmtBig(c.totalCents - c.capCents)} over the ${fmtBig(c.capCents)} limit`
  : 'Over limit');
// "Aug 2" (this year) or "Aug 2, 2025"
const shortDate = (value) => {
  const [y, m, d] = fmtDate(value).split('-').map(Number);
  if (!y || !m || !d) return fmtDate(value);
  const date = new Date(y, m - 1, d);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('en-CA', opts);
};
const localDay = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fmtDate(ts) : shortDate(d.toLocaleDateString('en-CA'));
};

// ── Donor picker: type-ahead against /api/persons?q=, arrow keys, inline create ──
function DonorPicker({ value, onChange }) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [createError, setCreateError] = useState(null);
  const [creating, setCreating] = useState(false);
  const boxRef = useRef(null);

  const search = useQuery({
    queryKey: ['persons', 'search', q],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(q)}&limit=8`),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const matches = search.data?.persons ?? [];
  const trimmed = q.trim();
  const canCreate = trimmed.length > 0
    && !matches.some((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  const items = canCreate
    ? [...matches, { id: '__create__', name: trimmed }]
    : matches;

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(items.length - 1, 0)));
  }, [items.length]);

  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const choose = async (item) => {
    if (!item || creating) return;
    setCreateError(null);
    if (item.id === '__create__') {
      setCreating(true);
      try {
        const res = await action('person.create', { name: item.name.slice(0, 300) });
        queryClient.invalidateQueries({ queryKey: ['persons'] });
        queryClient.invalidateQueries({ queryKey: ['brief'] });
        onChange(res.person);
      } catch (e) {
        setCreateError(e.message); // keep the typed name so they can retry
        return;
      } finally {
        setCreating(false);
      }
    } else {
      onChange(item);
    }
    setQ('');
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (open && items.length) { e.preventDefault(); choose(items[active]); } }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  if (value) {
    return (
      <div className="ops-picked">
        <span className="chip ops-chip-lg">{value.name}</span>
        <button type="button" className="btn btn-quiet ops-tap" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }

  return (
    <div className="picker ops-picker" ref={boxRef}>
      <input
        id="gift-donor"
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls="donor-options"
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Start typing a name…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && items.length > 0 && (
        <ul className="picker-list" id="donor-options" role="listbox">
          {items.map((item, i) => (
            <li
              key={item.id}
              role="option"
              aria-selected={i === active}
              className={(i === active ? 'active ' : '') + (item.id === '__create__' ? 'create' : '')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
            >
              {item.id === '__create__'
                ? <>+ Add new person “{item.name}”</>
                : <>{item.name}{item.email && <span className="meta">{item.email}</span>}</>}
            </li>
          ))}
        </ul>
      )}
      {createError && <p className="error">{createError}</p>}
    </div>
  );
}

// ── Log a gift: donor, amount, date — the rest under "More details" ──
function GiftForm({ presetPersonId, onSaved, onClose }) {
  const online = useOnline(); // a gift is cap-checked by the server: never saved offline
  const [donor, setDonor] = useState(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [method, setMethod] = useState('');
  const [cadence, setCadence] = useState('one-time');
  const [slate, setSlate] = useState(DEFAULT_SLATE);
  const [note, setNote] = useState('');
  const [address, setAddress] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // A receipt prints the donor's home address: ask for it when none is on file.
  const noAddress = !!donor && !String(donor.address || '').trim();

  const preset = useQuery({
    queryKey: ['person', presetPersonId],
    queryFn: () => apiGet(`/persons/${presetPersonId}`),
    enabled: !!presetPersonId,
  });
  useEffect(() => {
    if (preset.data?.person) setDonor((d) => d ?? preset.data.person);
  }, [preset.data]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const cents = dollarsToCents(amount);
    if (!donor) { setError('Pick a donor first'); return; }
    if (cents === null) { setError('Enter dollars, like 50 or 49.99'); return; }
    // amount_cents is z.number().int().nonnegative(); a $0 gift is never intended.
    if (cents === 0) { setError('The amount must be more than $0'); return; }
    setBusy(true);
    try {
      // The address first, so the gift's receipt is issued with it.
      if (noAddress && address.trim()) {
        const up = await action('person.update', { id: donor.id, address: address.trim().slice(0, 1000) });
        setDonor((d) => (d && d.id === donor.id ? { ...d, ...(up.person || {}), address: address.trim() } : d));
      }
      const res = await action('gift.log', {
        person_id: donor.id,
        amount_cents: cents,
        date,
        method: method || undefined,
        cadence,
        ...(MANY_SLATES ? { slate } : {}),
        note: note.trim() || undefined,
      });
      onSaved(res, donor);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card ops-form" onSubmit={submit} aria-label="Log a gift">
      <div className="field">
        <label htmlFor="gift-donor">Donor</label>
        <DonorPicker value={donor} onChange={setDonor} />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="gift-amount">Amount ($)</label>
          <input id="gift-amount" className="input mono" inputMode="decimal" required placeholder="0.00"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="gift-date">Date</label>
          <input id="gift-date" className="input mono" type="date" required
            value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      <button type="button" className="ops-more disclose disclose--inline" aria-expanded={more} aria-controls="gift-more"
        onClick={() => setMore((v) => !v)}>
        More details
      </button>
      {more && (
        <div id="gift-more" className="ops-more-body">
          <div className="form-row">
            <div className="field">
              <label htmlFor="gift-method">Paid by</label>
              <select id="gift-method" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">—</option>
                {METHODS.map((m) => <option key={m} value={m}>{methodWord(m)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="gift-cadence">Cadence</label>
              <select id="gift-cadence" className="input" value={cadence} onChange={(e) => setCadence(e.target.value)}>
                {CADENCES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </div>
          </div>
          {MANY_SLATES && (
            <div className="field">
              <label htmlFor="gift-slate">Slate</label>
              <select id="gift-slate" className="input" value={slate} onChange={(e) => setSlate(e.target.value)}>
                {SLATES.map((sl) => <option key={sl.code} value={sl.code}>{sl.label}</option>)}
              </select>
              <span className="ops-meta">The annual limit is per slate.</span>
            </div>
          )}
          <div className="field">
            <label htmlFor="gift-note">Note</label>
            <input id="gift-note" className="input" maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {noAddress && (
            <div className="field">
              <label htmlFor="gift-address">Street address</label>
              <input id="gift-address" className="input" maxLength={1000} autoComplete="off" placeholder="For the receipt"
                value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
          )}
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !online}>{busy ? 'Saving…' : 'Save gift'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

const MonthlyChip = () => <span className="chip">monthly</span>;
const shownNote = (n) => (n && n.trim().toLowerCase() !== 'sample' ? n : null);

function GiftActions({ personId, onVoid }) {
  const [confirm, setConfirm] = useState(false);
  if (confirm) {
    return (
      <div className="ops-confirm" role="group" aria-label="Void this gift">
        <span>Void this gift?</span>
        <button type="button" className="btn ops-danger ops-tap" onClick={() => { setConfirm(false); onVoid(); }}>Yes</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
      </div>
    );
  }
  return (
    <div className="ops-actions">
      {personId && <Link className="btn btn-quiet ops-tap ops-link" to={`/people/${personId}`}>Donor</Link>}
      <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(true)}>Void</button>
    </div>
  );
}

// "Over limit" — the same word on every gift that crossed the cap.
const OverChip = ({ title }) => <span className="chip chip-warn" title={title || undefined}>over limit</span>;

// ── A gift over the limit (from the brief); tap for how far over ──
function FlaggedRow({ f, personId, onVoid }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(false);
  const bodyId = `fl-${f.id}`;
  return (
    <li className="ops-item">
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="ops-row__main">
          <span className="ops-row__name">{f.donor}</span>
          <span className="ops-row__sub">{shortDate(f.date)}<OverChip /></span>
        </span>
        <span className="ops-row__end"><span className="ops-row__amt">{fmtMoney(f.amount_cents)}</span></span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          <p className="ops-over" title={f.flag_reason || undefined}>{overLine(overOf(f))}</p>
          {f.flag_reason && (
            <>
              <button type="button" className="ops-more disclose disclose--inline" aria-expanded={why}
                aria-controls={`${bodyId}-why`} onClick={() => setWhy((v) => !v)}>
                Why?
              </button>
              {why && <p id={`${bodyId}-why`} className="ops-meta">{f.flag_reason}</p>}
            </>
          )}
          <GiftActions personId={personId} onVoid={onVoid} />
        </div>
      )}
    </li>
  );
}

// ── One ledger row; tap for method, note, donor and Void ──
function GiftRow({ g, open, onToggle, onVoid }) {
  const bodyId = `gift-${g.id}`;
  return (
    <li className="ops-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="ops-row__main">
          <span className="ops-row__name">{g.person_name ?? '…'}</span>
          <span className="ops-row__sub">
            {shortDate(g.date)}
            {g.cadence === 'monthly' && <MonthlyChip />}
            <SlateChip slate={g.slate} />
            {g.flagged && <OverChip title={g.flag_reason} />}
          </span>
        </span>
        <span className="ops-row__end"><span className="ops-row__amt">{fmtMoney(g.amount_cents)}</span></span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          {(g.method || shownNote(g.note)) && (
            <p className="ops-chips">
              {g.method && <span className="chip">{methodWord(g.method)}</span>}
              {shownNote(g.note) && <span className="ops-meta">{shownNote(g.note)}</span>}
            </p>
          )}
          {g.flagged && <p className="ops-over" title={g.flag_reason || undefined}>{overLine(overOf(g))}</p>}
          <ReceiptsGiftLine giftId={g.id} />
          <GiftActions personId={g.person_id} onVoid={onVoid} />
        </div>
      )}
    </li>
  );
}

// ── The screen ──
export default function Money() {
  const queryClient = useQueryClient();
  const { me } = useOutletContext() ?? {};
  const canMoney = MONEY_ROLES.includes(me?.role);
  const [params, setParams] = useSearchParams();
  const showNew = params.get('new') === '1' && canMoney; // the global 'n' key lands here too
  const presetPersonId = params.get('person');

  const [banner, setBanner] = useState(null);
  const [voidAsk, setVoidAsk] = useState(null); // { id, number, name, giftId } — a void receipt the donor already got
  const [voided, setVoided] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [more, setMore] = useState(false);
  const [allGifts, setAllGifts] = useState(false);
  const toastTimer = useRef(null);

  const gifts = useInfiniteQuery({
    queryKey: ['records', 'gift'],
    queryFn: ({ pageParam }) =>
      apiGet(`/records/gift?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null,
    getNextPageParam: (last) => last?.next ?? undefined,
    enabled: canMoney,
  });
  const brief = useQuery({ queryKey: ['brief'], queryFn: () => apiGet('/brief'), enabled: canMoney });
  const receiptNeeds = useQuery({ queryKey: ['receipts', 'needs'], queryFn: () => apiGet('/receipts/needs'), enabled: canMoney });
  // No signal: this tab's last copy (components/KeptCopies.js), read only.
  const online = useOnline();
  const giftsOffline = noSignal(gifts);

  // Newest gift date first (the ledger itself pages in entry order).
  const rows = (gifts.data?.pages ?? []).flatMap((p) => p?.records ?? []).filter((g) => !voided.has(g.id))
    .sort((a, b) => fmtDate(b.date).localeCompare(fmtDate(a.date)));
  const flagged = (brief.data?.flagged ?? []).filter((f) => !voided.has(f.id));
  const noAddress = (receiptNeeds.data?.receipts ?? []).filter((r) => !voided.has(r.gift_id));
  // The latest few skip gifts already listed under "Needs you"; "All gifts" shows every one.
  const flaggedIds = new Set(flagged.map((f) => f.id));
  const latest = rows.filter((g) => !flaggedIds.has(g.id)).slice(0, LATEST);
  const personOf = Object.fromEntries(rows.map((g) => [g.id, g.person_id]));

  // The big number: this calendar year from the ledger once it's all loaded;
  // until then (or past one page) the brief's running total.
  const year = String(new Date().getFullYear());
  const allLoaded = gifts.isSuccess && !gifts.hasNextPage;
  let raised = null;
  if (allLoaded) {
    raised = {
      label: 'Raised this year',
      cents: rows.filter((g) => fmtDate(g.date).startsWith(year)).reduce((n, g) => n + (Number(g.amount_cents) || 0), 0),
    };
  } else if (brief.data?.money) {
    raised = { label: 'Raised so far', cents: brief.data.money.totalCents };
  }
  const weekCents = brief.data?.money?.weekCents ?? 0;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['records', 'gift'] });
    queryClient.invalidateQueries({ queryKey: ['brief'] });
    queryClient.invalidateQueries({ queryKey: ['person'] });
    queryClient.invalidateQueries({ queryKey: ['receipts'] }); // a gift's receipt is made, voided and restored with it
  };

  // toast({ text, undo? }) — one at a time, 7s.
  const showToast = (t) => {
    clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  };
  // A cap crossing: one line, the legal wording kept as the tooltip.
  const overBanner = (res, name) => (res.compliance?.over
    ? { name, line: overLine(res.compliance), reason: res.gift?.flag_reason, giftId: res.gift?.id }
    : null);

  const onSaved = async (res, donor) => {
    const g = res.gift || {};
    setBanner(overBanner(res, donor?.name));
    setParams({});
    invalidate();
    // What the receipt is doing, as the server has it: "receipt emails in a
    // minute" (Undo before then and it never goes) or "receipt needs address".
    const note = g.id ? receiptNote(await receiptOf(g.id)) : '';
    showToast({
      text: `✓ ${fmtBig(g.amount_cents)} from ${donor?.name ?? 'donor'}${note}`,
      undo: g.id ? () => voidGift(g.id) : null,
    });
  };

  // The row leaves at once; the toast waits for the server, so it only ever
  // says what happened.
  const voidGift = async (id) => {
    setError(null);
    setOpenId(null);
    setVoided((s) => new Set(s).add(id)); // optimistic remove
    setBanner((b) => (b?.giftId === id ? null : b)); // that gift no longer counts
    try {
      await action('gift.void', { id });
      showToast({ text: 'Gift voided', undo: () => undoVoid(id) });
      // Its receipt already went to the donor: offer to tell them it's void.
      const r = await receiptOf(id);
      setVoidAsk(r?.void && r.can_send_void ? { id: r.id, number: r.number, name: r.donor_name, giftId: id } : null);
    } catch (e) {
      setVoided((s) => { const n = new Set(s); n.delete(id); return n; });
      setError(e.message);
    } finally {
      // The donor's profile shows gifts, yearly totals and the donor tier.
      invalidate();
    }
  };

  const undoVoid = async (id) => {
    setError(null);
    try {
      await action('gift.restore', { id });
      setVoided((s) => { const n = new Set(s); n.delete(id); return n; });
      setVoidAsk((a) => (a?.giftId === id ? null : a));
      showToast({ text: '✓ Gift restored' });
    } catch (e) {
      setError(e.message);
    } finally {
      invalidate();
    }
  };

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  if (!canMoney) {
    return (
      <div className="ops-page">
        <div className="ops-head"><h1>Donations</h1></div>
        <p className="ops-empty">Handed a donation? Tell the campaign desk.</p>
      </div>
    );
  }

  const needs = flagged.length + noAddress.length;

  return (
    <div className="ops-page">
      <div className="ops-head">
        <h1>Donations</h1>
        <div className="ops-head__actions">
          {!showNew && (
            <button type="button" className="btn btn-primary ops-tap" disabled={!online} onClick={() => setParams({ new: '1' })}>
              Log a gift
            </button>
          )}
        </div>
      </div>
      {!online && <NeedsSignalLine>Gifts need signal</NeedsSignalLine>}

      {banner && (
        <div className="banner" role="status">
          <span title={banner.reason || undefined}>
            <strong>Over limit</strong>{banner.name ? ` · ${banner.name}` : ''} · {banner.line}
          </span>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setBanner(null)}>Dismiss</button>
        </div>
      )}

      {voidAsk && (
        <VoidNoticeAsk ask={voidAsk} onClose={() => setVoidAsk(null)}
          onDone={(text) => { setVoidAsk(null); invalidate(); showToast({ text }); }} />
      )}

      {showNew && (
        <GiftForm presetPersonId={presetPersonId} onSaved={onSaved} onClose={() => setParams({})} />
      )}

      <div className="ops-hero">
        <span className="eyebrow">{raised?.label ?? 'Raised'}</span>
        <span className="n">{raised ? fmtBig(raised.cents) : '—'}</span>
        {weekCents > 0 && <span className="sub">+{fmtBig(weekCents)} this week</span>}
      </div>

      {needs > 0 && (
        <section className="ops-needs" aria-labelledby="needs-head">
          <span className="eyebrow" id="needs-head">Needs you · {needs}</span>
          <ul className="ops-rows">
            {flagged.map((f) => (
              <FlaggedRow key={f.id} f={f} personId={f.person_id ?? personOf[f.id]} onVoid={() => voidGift(f.id)} />
            ))}
            {noAddress.map((r) => (
              <AddressRow key={r.id} r={r} onSaved={(text) => { invalidate(); showToast({ text }); }} />
            ))}
          </ul>
        </section>
      )}

      <span className="eyebrow ops-label">Gifts</span>
      {error && <p className="error">{error}</p>}
      {giftsOffline && <NoSignal />}
      {gifts.isError && !giftsOffline && <p className="error">{gifts.error.message}</p>}
      {rows.length === 0 && gifts.isSuccess && <p className="ops-empty">No gifts yet.</p>}
      {rows.length > 0 && (
        <ul className="ops-rows" id="gift-list">
          {(allGifts ? rows : latest).map((g) => (
            <GiftRow
              key={g.id}
              g={g}
              open={openId === g.id}
              onToggle={() => setOpenId((cur) => (cur === g.id ? null : g.id))}
              onVoid={() => voidGift(g.id)}
            />
          ))}
        </ul>
      )}
      {(rows.length > latest.length || gifts.hasNextPage) && (
        <button type="button" className="ops-more disclose" aria-expanded={allGifts} aria-controls="gift-list"
          onClick={() => setAllGifts((v) => !v)}>
          All gifts · {gifts.hasNextPage ? `${rows.length}+` : rows.length}
        </button>
      )}
      {allGifts && gifts.hasNextPage && (
        <div className="ops-actions">
          <button type="button" className="btn ops-tap" disabled={gifts.isFetchingNextPage}
            onClick={() => gifts.fetchNextPage()}>
            {gifts.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      <div className="ops-foot">
        <button type="button" className="ops-more disclose" aria-expanded={more} aria-controls="money-more"
          onClick={() => setMore((v) => !v)}>
          More
        </button>
        {more && (
          <div id="money-more" className="ops-more-body">
            <Link className="btn btn-quiet ops-tap rc-moneylink" to="/money/receipts">Receipts</Link>
          </div>
        )}
      </div>

      {toast && (
        <div className="toast ops-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button type="button" className="btn ops-tap"
              onClick={() => { const u = toast.undo; clearTimeout(toastTimer.current); setToast(null); u(); }}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
