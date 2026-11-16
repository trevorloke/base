// One quick report (/reports/quick/:name): its choices as chips (kept in
// the address, so a link or a reload gives the same report), the number, and
// the sheet — a table on a desk, a stack on a phone, a table on paper.
// Print is the one primary; Download CSV has every row
// (GET /api/quick-reports/:name, server/ext/reports/quick.js). Where a
// manager has turned Google Sheets on, Download CSV sits under GDR's quiet
// "Take it out" with Send to Google Sheets (source 'quick', A–Z only).
import { useState } from 'react';
import { Link, Navigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet, ApiError, fmtMoney } from '../api.js';
import { at } from '../base.js';
import { fmt } from '../components/AudienceBits.jsx';
import NameAz from '../components/NameAz.jsx';
import { NeedsSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { TakeItOut } from '../components/SendToSheet.jsx';
import { zoneOf } from '../components/shiftTime.js';
import { isDesk } from '../Shell.jsx';
import './shifts.css';
import './quick.css';

// "312 donors", "41 people"…: the word after the number.
const NOUN = { donors: ['donor', 'donors'], running: ['person', 'people'], volunteers: ['volunteer', 'volunteers'], members: ['member', 'members'], signs: ['sign', 'signs'], moved: ['person', 'people'] };
export const countWords = (name, n) => `${fmt(n)} ${(NOUN[name] || ['', ''])[Number(n) === 1 ? 0 : 1]}`.trim();
// The fact a phone's stack shows beside the phone.
const MAIN = { donors: 'total', running: 'said_on', volunteers: 'next_shift', members: 'ends_on', signs: 'kind', moved: 'marked_on' };
// A report with no name columns leads each phone block with this one.
const LEAD = { signs: 'address' };
// More than this many role chips: the rest under More.
const CHIPS_MAX = 8;

// "2026-11-13" → "13 Nov 2026".
export const dayWords = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
// Today on the campaign's calendar (settings.tz), as the CSV's file name
// has it — never the device's, which can be a day off abroad or near midnight.
export const todayWords = (me) => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zoneOf(me) });
const show = (v, type) => {
  if (v == null || v === '') return '';
  if (type === 'money') return fmtMoney(Math.round(Number(v) * 100));
  if (type === 'date') return dayWords(v);
  if (type === 'count') return fmt(v);
  return String(v);
};
// "not for you — ask a manager…", a renamed field's sentence: in place, as said.
const refused = (err) => err instanceof ApiError && err.status >= 400 && err.status < 500;

function Chips({ option, onPick }) {
  const [more, setMore] = useState(false);
  const all = option.choices;
  const cut = all.length > CHIPS_MAX + 1 && !more;
  const shown = cut ? all.filter((c, i) => i <= CHIPS_MAX || c.code === option.value) : all;
  return (
    <div className="qr-chips qr-noprint" role="group" aria-label={option.key === 'order' ? 'Order' : 'Show'}>
      {shown.map((c) => (
        <button key={c.code} type="button" className={`chip qr-chip${c.code === option.value ? ' is-on' : ''}`} aria-pressed={c.code === option.value}
          onClick={() => onPick(option.key, c.code)}>{c.words}</button>
      ))}
      {cut && <button type="button" className="chip qr-chip" aria-expanded={false} onClick={() => setMore(true)}>More</button>}
    </div>
  );
}

export default function QuickReport() {
  const { me } = useOutletContext() ?? {};
  const { name } = useParams();
  const [params, setParams] = useSearchParams();
  const online = useOnline();
  const [moreOpen, setMoreOpen] = useState(false);
  const qs = params.toString();
  const q = useQuery({
    queryKey: ['quick', name, qs],
    queryFn: () => apiGet(`/quick-reports/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`),
    // A chip keeps the sheet on screen while the next one loads; another
    // report never shows this one's rows.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === name ? keepPreviousData(prev) : undefined),
    retry: (n, err) => !refused(err) && n < 1,
  });
  // Donors: the period's dollars beside the number.
  const sum = useQuery({
    queryKey: ['quick', name, 'count', qs],
    queryFn: () => apiGet(`/quick-reports/${encodeURIComponent(name)}/count${qs ? `?${qs}` : ''}`),
    enabled: name === 'donors' && q.isSuccess,
    retry: false,
  });
  if (!isDesk(me)) return <Navigate to="/" replace />;

  const d = q.data;
  const pick = (key, code) => {
    const next = new URLSearchParams(params);
    next.set(key, code);
    setParams(next, { replace: true });
  };
  const cols = d ? d.head.filter((h) => h.print) : [];
  const nameCols = cols.some((h) => h.key === 'last_name');
  const rows = d?.rows || [];
  const dark = noSignal(q) || (!online && !d);
  const canPrint = Boolean(d) && rows.length > 0 && !q.isPlaceholderData && online;
  const csv = at(`/api/quick-reports/${encodeURIComponent(name)}.csv${qs ? `?${qs}` : ''}`);
  // The Sheet's ref: the name and the choices in force, in the report's own order.
  const sheetRef = d ? [name, new URLSearchParams((d.options || []).map((o) => [o.key, o.value])).toString()].filter(Boolean).join('?') : name;
  const title = d?.title || (q.isError ? 'Report' : 'Loading…');
  const largest = d?.options?.find((o) => o.key === 'order')?.value === 'largest';

  return (
    <div className="ops-page qr-page qr-print">
      <Link className="ops-back qr-noprint" to="/reports">← Reports</Link>
      <div className="qr-printonly">
        <strong>{me?.workspace?.name}</strong> · {d?.title}{d?.said ? ` · ${d.said}` : ''}
        <br />Printed {todayWords(me)}{me?.user?.name ? ` by ${me.user.name}` : ''} · {d ? countWords(name, d.total) : ''}
      </div>
      <div className="ops-head">
        <h1>{title}</h1>
        <div className="ops-head__actions qr-noprint">
          <button type="button" className="btn btn-primary ops-tap" disabled={!canPrint} onClick={() => window.print()}>Print</button>
          {/* No file to give while the report is loading or was refused. */}
          {d && !q.isError
            ? <TakeItOut csvHref={csv} source="quick" of={sheetRef} name={[d.title, d.said].filter(Boolean).join(' · ')}
                count={d.total} noun={(NOUN[name] || ['row', 'rows'])[d.total === 1 ? 0 : 1]} head={d.head.map((h) => h.label)}
                // Sheets pages are A–Z only: said before Send, never refused after it.
                blocked={largest ? 'Choose A–Z to send to Sheets' : null} onUnblock={() => pick('order', 'az')} unblockLabel="A–Z by last name" />
            : <button type="button" className="btn btn-quiet ops-tap" disabled>Download CSV</button>}
        </div>
      </div>
      {d?.options?.map((o) => <Chips key={o.key} option={o} onPick={pick} />)}

      {dark ? <p className="qr-state"><NeedsSignal className="" /></p>
        : q.isPending ? <p className="qr-state" role="status">Loading…</p>
        : q.isError && refused(q.error) ? <p className="qr-state qr-state--bad" role="alert">{q.error.message}</p>
        : q.isError ? <p className="qr-state qr-state--bad" role="alert">Unavailable — <button type="button" className="btn btn-quiet ops-tap" onClick={() => q.refetch()}>Try again</button></p>
        : (
          <>
            <p className="qr-big qr-noprint" aria-live="polite">
              {countWords(name, d.total)}
              {name === 'donors' && <span className="muted"> · {sum.isSuccess ? fmtMoney(sum.data.extra?.cents) : sum.isError ? 'Unavailable' : 'Loading…'}</span>}
            </p>
            {!rows.length ? <p className="qr-state">No one yet.</p> : (
              <div className="qr-wrap">
                <table className="qr-table">
                  <thead><tr>{cols.map((h) => <th key={h.key} scope="col" className={h.type === 'money' || h.type === 'count' ? 'num' : ''}>{h.label}</th>)}</tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.id || i}>
                        {nameCols && <td className="qr-stackname"><NameAz person={{ name: [r.first_name, r.last_name].filter(Boolean).join(' '), last_name: r.first_name ? r.last_name : '' }} /></td>}
                        {cols.map((h) => {
                          const masked = (h.key === 'phone' || h.key === 'email') && r.no_contact && r[h.key] && !/[\d@]/.test(r[h.key]);
                          const v = show(r[h.key], h.type);
                          const lead = !nameCols && h.key === LEAD[name];
                          // A blank fact is left off the phone block, not shown as a bare label.
                          // Volunteers with no shift booked: what they do is the fact, in its place.
                          const main = name === 'volunteers' && !r.next_shift ? 'roles' : MAIN[name];
                          const fact = !lead && v !== '' && (h.key === 'phone' || h.key === main);
                          const cls = [h.type === 'money' || h.type === 'count' ? 'num' : '', masked ? 'qr-masked' : '', fact ? 'qr-fact' : '', lead ? 'qr-lead' : ''].filter(Boolean).join(' ');
                          return <td key={h.key} className={cls || undefined} data-label={h.label}>{v}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.total > rows.length && <p className="qr-cut">Showing {fmt(rows.length)} of {fmt(d.total)} — Download CSV has them all.</p>}
            {d.filter && (
              <div className="qr-more qr-noprint">
                <button type="button" className="disclose" aria-expanded={moreOpen} aria-controls="qr-more-b" onClick={() => setMoreOpen((v) => !v)}>More</button>
                {moreOpen && <p id="qr-more-b"><Link className="btn ops-tap" to={`/lists/new?${d.filter}`}>Make it a list</Link></p>}
              </div>
            )}
          </>
        )}
    </div>
  );
}
