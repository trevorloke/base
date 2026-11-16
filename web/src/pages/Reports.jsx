// Reports — first the quick reports (a short menu of ready-made lists of
// people, each to print or download: QuickReport.jsx, WalkSheet.jsx), then
// "Field, by turf", then under More the campaign in numbers, each table
// downloadable as CSV, and the exports: any table as a spreadsheet, or
// everything as JSON. The numbers are read only once More is opened.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError, fmtMoney } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { fmt } from '../components/AudienceBits.jsx';
import './shifts.css'; // the ops-* pieces (the head, the page column, the buttons)
import './reports.css';
import './quick.css';
import { at } from '../base.js';

const TITLES = {
  rating: 'People by rating', tags: 'Tags', cities: 'Cities', 'people-by-week': 'People added, by week',
  contacts: 'Contacts by week', donations: 'Donations by month', subscribers: 'Newsletter list, by month', sends: 'Sends',
};
export const EXPORTS = [
  ['people', 'People'], ['contacts', 'Contacts (doors, calls, texts)'], ['gifts', 'Gifts'], ['members', 'Members (paper and website)'],
  ['volunteers', 'Volunteers and their roles'], ['signs', 'Signs'], ['shifts', 'Shifts'],
  ['subscribers', 'Newsletter subscribers'], ['lists', 'Lists (hand-picked)'],
];
const cell = (v) => (v instanceof Date || /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? String(v).slice(0, 10) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v ?? ''));

function Report({ name, r }) {
  return (
    <section className="rp-sec" aria-labelledby={`rp-${name}`}>
      <div className="rp-sec__head">
        <h2 id={`rp-${name}`}>{TITLES[name] || name}</h2>
        <a className="btn btn-quiet ops-tap" href={at(`/api/reports/${name}.csv`)}>CSV</a>
      </div>
      {!r.rows.length ? <p className="ops-empty">Nothing yet.</p> : (
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead><tr>{r.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{r.rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} className={typeof v === 'number' ? 'mono num' : ''}>{cell(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// One menu row's number: turfs for the walking list (names only, under
// their own key — never the shared ['turfs'], which holds counted turfs),
// else the report's own count. Loading…, the number, or Unavailable.
function QuickCount({ name }) {
  const walk = name === 'walk';
  const q = useQuery({
    queryKey: walk ? ['turfs', 'outline'] : ['quick', name, 'count', ''],
    queryFn: () => apiGet(walk ? '/turfs?outline=1' : `/quick-reports/${name}/count`),
    retry: false,
  });
  if (q.isError) return <span className="rp-quick__n">Unavailable</span>;
  if (!q.data) return <span className="rp-quick__n">Loading…</span>;
  if (walk) { const n = q.data.turfs?.length || 0; return <span className="rp-quick__n">{fmt(n)} {n === 1 ? 'turf' : 'turfs'}</span>; }
  return <span className="rp-quick__n">{fmt(q.data.count)}</span>;
}

function QuickReports() {
  const q = useQuery({ queryKey: ['quick', 'menu'], queryFn: () => apiGet('/quick-reports-menu'), retry: false });
  const mine = (q.data?.reports || []).filter((r) => r.can);
  // Refused (a volunteer granted Data: "desk only") — trying again can't help.
  const refused = q.error instanceof ApiError && q.error.status >= 400 && q.error.status < 500;
  return (
    <section className="rp-quick" aria-labelledby="rp-quick-h">
      <h2 id="rp-quick-h">Quick reports</h2>
      {noSignal(q) ? <NoSignal />
        : q.isPending ? <p className="ops-meta" role="status">Loading…</p>
        : refused ? <p className="ops-meta">No quick reports for you here.</p>
        : q.isError ? <p className="ops-meta" role="alert">Unavailable — <button type="button" className="btn btn-quiet ops-tap" onClick={() => q.refetch()}>Try again</button></p>
        : !mine.length ? <p className="ops-meta">No quick reports for you here.</p>
        : (
          <ul className="rp-quick__list">
            {mine.map((r) => (
              <li key={r.name}>
                <Link className="rp-quick__i" to={r.name === 'walk' ? '/reports/walk' : `/reports/quick/${r.name}`}>
                  <span className="rp-quick__t"><span className="rp-quick__name">{r.title}</span><span className="rp-quick__what">{r.what}</span></span>
                  <QuickCount name={r.name} />
                </Link>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

// The numbers and the exports, as they were — one tap down.
function Numbers() {
  const q = useQuery({ queryKey: ['reports'], queryFn: () => apiGet('/reports') });
  const t = q.data?.totals;
  return (
    <div className="rp-more__body" id="rp-more-b">
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="ops-meta" role="status">Loading…</p>}
      {q.isError && !noSignal(q) && <p className="error">{q.error.message}</p>}
      {t && (
        <div className="rp-totals" role="list">
          <span role="listitem"><strong className="mono">{fmt(t.people.total)}</strong> people <span className="muted">· {fmt(t.people.rated)} rated · {fmt(t.people.with_email)} with email · {fmt(t.people.with_phone)} with phone</span></span>
          <span role="listitem"><strong className="mono">{fmt(t.contacts.week)}</strong> contacts this week <span className="muted">· {fmt(t.contacts.total)} all time</span></span>
          {!t.donations?.hidden && <span role="listitem"><strong className="mono">{fmtMoney(t.donations.cents)}</strong> raised this year <span className="muted">· {fmt(t.donations.gifts)} gifts from {fmt(t.donations.donors)} donors</span></span>}
          <span role="listitem"><strong className="mono">{fmt(t.newsletter.subscribed)}</strong> subscribers <span className="muted">· {fmt(t.newsletter.unsubscribed)} left</span></span>
        </div>
      )}
      {q.data && Object.entries(q.data.reports).map(([name, r]) => <Report key={name} name={name} r={r} />)}
      <section className="rp-sec" aria-labelledby="rp-exports">
        <div className="rp-sec__head"><h2 id="rp-exports">Exports</h2></div>
        <p className="ops-meta">A whole table as a spreadsheet. Bringing data in, and the full backup, are on <Link to="/data">Import &amp; export</Link>.</p>
        <ul className="rp-exports">
          {EXPORTS.map(([k, label]) => <li key={k}><a className="btn ops-tap" href={at(`/api/export/${k}.csv`)}>{label}</a></li>)}
          <li><a className="btn btn-quiet ops-tap" href={at('/api/export')}>Everything (JSON)</a></li>
        </ul>
      </section>
    </div>
  );
}

export default function Reports() {
  const [more, setMore] = useState(false);
  return (
    <div className="ops-page rp-page">
      <div className="ops-head"><h1>Reports</h1></div>
      <QuickReports />
      <p className="rp-links"><Link className="btn ops-tap" to="/field-report">Field, by turf →</Link></p>
      <div className="rp-more">
        <button type="button" className="disclose" aria-expanded={more} aria-controls="rp-more-b" onClick={() => setMore((v) => !v)}>More: numbers and exports</button>
        {more && <Numbers />}
      </div>
    </div>
  );
}
