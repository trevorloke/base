// The list for picking a person, under a search box (usePersonSearch).
//
//   <PersonResults search={usePersonSearch(term)} boxRef onPick
//     taken takenLabel rowClass desk offlineWords footer autoMore />
//
// "2,363 people" (or "More than 5,000 — type more of the name"), then the
// rows in A–Z order by last name: the name with the surname in bold, the
// rating, and one more line (street and city; on the desk, the phone) so two
// Kevin Smiths can be told apart. It scrolls, and keeps going: "Show more"
// at the end loads the next page, and with autoMore it loads by itself as
// it scrolls into view. Someone already taken (in `taken`, or on_list from
// the server) is drawn greyed with takenLabel and can't be picked.
// Rows from the last term (the new answer still on its way) are dimmed and
// can't be picked: Enter in the box waits for the fresh answer.
// Keys: ↓ from the box to the first row, ↑ ↓ between rows (and on to
// "Show more" and the footer's buttons), Enter picks, Esc goes back to the box.
// lead = { heading, rows, chip }: a block drawn first under its own heading
// (a dropdown's "Has this role: Driver"), one page, no paging; anyone in it
// is left out of the rows under it. onNone: Enter with a fresh answer that
// has no one to pick (a dropdown's "+ Add new person").
import { useEffect, useRef, useState } from 'react';
import { RatingChip } from './RatingButtons.jsx';
import { Unavailable } from './AudienceBits.jsx';
import { NeedsSignal, noSignal, useOnline } from './NoSignal.jsx';
import NameAz from './NameAz.jsx';
import { streetLine } from './people.js';
import './person-search.css';

const fmt = (n) => Number(n).toLocaleString('en-CA');
export const DIGITS_HINT = 'Type at least 3 digits of a house number, or 4 of a phone number.';

// "14520 72 Ave, Surrey · 604-555-0142"
export const whereLine = (p, desk) => {
  const place = [streetLine(p), p.city].filter(Boolean).join(', ');
  return [place, desk ? p.phone : null].filter(Boolean).join(' · ');
};

export const countWords = (search) => {
  if (search.many) return `More than ${fmt(search.cap ?? 5000)} — type more of the name`;
  if (search.total == null) return '';
  return `${fmt(search.total)} ${search.total === 1 ? 'person' : 'people'}`;
};

export default function PersonResults({
  search, boxRef, onPick, taken = null, takenLabel = 'Already added', rowClass = '',
  desk = false, offlineWords = 'Searching needs signal', footer = null, autoMore = true,
  lead = null, onNone = null,
}) {
  const online = useOnline();
  const listRef = useRef(null);
  const moreRef = useRef(null);
  // Enter in the box before the answer for what's typed has come: picked
  // once it comes (the first one who can be picked), never from the old rows.
  const [wantFirst, setWantFirst] = useState(false);
  const { fresh } = search;
  const leadRows = lead?.rows || [];
  const leadIds = new Set(leadRows.map((p) => p.id));
  const rows = leadIds.size ? search.rows.filter((p) => !leadIds.has(p.id)) : search.rows;
  const all = [...leadRows, ...rows];
  const isTaken = (p) => Boolean(p.on_list) || Boolean(taken?.has?.(p.id));
  const typedNow = boxRef?.current?.value?.trim() ?? search.term;

  const wrapRef = useRef(null);
  // Everything ↑ ↓ moves through: the rows, "Show more", the footer's buttons.
  const navOf = () => [...(wrapRef.current?.querySelectorAll('button[data-row]:not([disabled]), button.ps-more:not([disabled]), .ps-foot button:not([disabled])') || [])];
  useEffect(() => {
    const box = boxRef?.current;
    if (!box) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowDown') {
        const first = navOf()[0];
        if (first) { e.preventDefault(); first.focus(); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setWantFirst(true);
      }
    };
    box.addEventListener('keydown', onKey);
    return () => box.removeEventListener('keydown', onKey);
  }, [boxRef]);
  // Typing again after Enter starts over: Enter is for what's in the box then.
  useEffect(() => {
    const box = boxRef?.current;
    if (!box) return undefined;
    const reset = () => setWantFirst(false);
    box.addEventListener('input', reset);
    return () => box.removeEventListener('input', reset);
  }, [boxRef]);
  useEffect(() => {
    if (!wantFirst || !fresh) return;
    setWantFirst(false);
    const p = all.find((r) => !isTaken(r));
    if (p) onPick(p);
    else onNone?.();
  });

  // Scrolled to the end: the next page, by itself (autoMore).
  const loadMore = search.loadMore;
  useEffect(() => {
    const el = moreRef.current;
    if (!autoMore || !el || !search.more || !fresh || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((seen) => { if (seen.some((s) => s.isIntersecting)) loadMore(); }, { root: listRef.current });
    io.observe(el);
    return () => io.disconnect();
  });

  // ↑ ↓ and Esc anywhere in the list or its footer (the box has its own).
  const onNavKey = (e) => {
    const nav = navOf();
    const i = nav.indexOf(e.target);
    if (i < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); nav[i + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) nav[i - 1].focus(); else boxRef?.current?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); boxRef?.current?.focus(); }
  };

  if (String(typedNow).length < 2 && !all.length) {
    return footer ? <div className="ps" ref={wrapRef} onKeyDown={onNavKey}><div className="ps-foot">{footer}</div></div> : null;
  }
  const offline = !online || noSignal(search.query) || (search.status === 'error' && search.error?.name === 'NoSignalError');
  if (offline) return <NeedsSignal className="pf-empty ps-state">{offlineWords}</NeedsSignal>;

  let state = null;
  if (search.status === 'error' && !all.length) {
    state = <p className="ps-state" role="alert"><Unavailable onRetry={search.retry} /></p>;
  } else if (!all.length && (search.waiting || search.status === 'pending' || search.status === 'idle')) {
    state = <p className="ps-state muted" role="status">Searching…</p>;
  } else if (!all.length && fresh && search.hint === 'digits') {
    state = <p className="ps-state" role="status">{DIGITS_HINT}</p>;
  } else if (!all.length && fresh) {
    state = (
      <div className="ps-state" role="status">
        <p className="ps-none">No one matches “{search.term}”.</p>
        <p className="ps-help">{desk ? 'Try a last name, a phone number or an email.' : 'Try a last name or a phone number.'}</p>
      </div>
    );
  }
  const count = all.length ? countWords(search) : '';
  const row = (p, chip = null) => {
    const off = isTaken(p);
    const where = whereLine(p, desk);
    return (
      <li key={p.id}>
        <button type="button" data-row="" className={`ps-row ${rowClass}${off ? ' is-taken' : ''}`} disabled={off}
          aria-disabled={!fresh || undefined}
          onClick={() => { if (fresh && !off) onPick(p); }}>
          <span className="ps-row__main">
            <span className="ps-row__name"><NameAz person={p} /></span>
            {where && <span className="ps-row__where">{where}</span>}
          </span>
          <span className="ps-row__end">
            {off ? <span className="chip chip-ghost ps-taken">{takenLabel}</span> : (
              <>{chip && <span className="chip chip-ok ps-chip">{chip}</span>}<RatingChip code={p.rating} who /></>
            )}
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className="ps" ref={wrapRef} onKeyDown={onNavKey}>
      <p className="ps-count" aria-live="polite">{count}</p>
      {state}
      {all.length > 0 && (
        <ul ref={listRef} className={`ps-list${fresh ? '' : ' is-stale'}`} aria-busy={fresh ? undefined : 'true'} aria-label="People found">
          {leadRows.length > 0 && <li className="ps-head">{lead.heading}</li>}
          {leadRows.map((p) => row(p, lead.chip))}
          {rows.map((p) => row(p))}
          {search.more && (
            <li className="ps-more-li">
              <button type="button" ref={moreRef} className="btn btn-quiet ps-more" disabled={search.loadingMore || !fresh}
                onClick={loadMore}>
                {search.loadingMore ? 'Loading…' : 'Show more'}
              </button>
            </li>
          )}
          {search.full && <li className="ps-state ps-full">Type more of the name to narrow it</li>}
        </ul>
      )}
      {footer && <div className="ps-foot">{footer}</div>}
    </div>
  );
}
