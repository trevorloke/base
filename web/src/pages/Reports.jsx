// Reports — the campaign in numbers, each table downloadable as CSV, and
// the exports: any table as a spreadsheet, or everything as JSON.
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, fmtMoney } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { SendToSheet, TakeItOut } from '../components/SendToSheet.jsx';
import { hasArea } from '../Shell.jsx';
import './shifts.css'; // the ops-* pieces (the head, the page column, the buttons)
import './reports.css';
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
// The columns that say a table holds ways to reach people (the Sheets
// confirm's do-not-contact line); the server's DATASETS have the rest.
const CONTACT_COLS = {
  people: ['email', 'phone'], members: ['email', 'phone'], volunteers: ['email', 'phone'], signs: ['phone'],
  gifts: ['email'], subscribers: ['email'], lists: ['email', 'phone'],
};
// Money's tables go to Google only for those who hold Donations (the server checks too).
const MONEY = ['gifts', 'members'];

// One table in the exports: its CSV, and a quiet "Google Sheets" beside it when Sheets may be sent.
export function ExportItem({ k, label, me, csvClass = 'btn ops-tap', download = false }) {
  const href = at(`/api/export/${k}.csv`);
  return (
    <li className="drv-export">
      <a className={csvClass} href={href} download={download || undefined}>{label}</a>
      {(!MONEY.includes(k) || hasArea(me, 'money')) && (
        <SendToSheet source="dataset" of={k} name={label} head={CONTACT_COLS[k] || []} label={<>Google Sheets<span className="drv-sr"> for {label}</span></>} csvHref={href} />
      )}
    </li>
  );
}

const cell = (v) => (v instanceof Date || /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? String(v).slice(0, 10) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v ?? ''));

function Report({ name, r }) {
  return (
    <section className="rp-sec" aria-labelledby={`rp-${name}`}>
      <div className="rp-sec__head">
        <h2 id={`rp-${name}`}>{TITLES[name] || name}</h2>
        <TakeItOut csvHref={at(`/api/reports/${name}.csv`)} csvLabel="CSV" source="report" of={name} name={TITLES[name] || name}
          count={r.rows.length} noun={r.rows.length === 1 ? 'row' : 'rows'} head={r.head} />
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

export default function Reports() {
  const { me } = useOutletContext() ?? {};
  const q = useQuery({ queryKey: ['reports'], queryFn: () => apiGet('/reports') });
  const t = q.data?.totals;
  return (
    <div className="ops-page rp-page">
      <div className="ops-head"><h1>Reports</h1></div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error">{q.error.message}</p>}
      {t && (
        <div className="rp-totals" role="list">
          <span role="listitem"><strong className="mono">{t.people.total}</strong> people <span className="muted">· {t.people.rated} rated · {t.people.with_email} with email · {t.people.with_phone} with phone</span></span>
          <span role="listitem"><strong className="mono">{t.contacts.week}</strong> contacts this week <span className="muted">· {t.contacts.total} all time</span></span>
          <span role="listitem"><strong className="mono">{fmtMoney(t.donations.cents)}</strong> raised this year <span className="muted">· {t.donations.gifts} gifts from {t.donations.donors} donors</span></span>
          <span role="listitem"><strong className="mono">{t.newsletter.subscribed}</strong> subscribers <span className="muted">· {t.newsletter.unsubscribed} left</span></span>
        </div>
      )}
      <p className="rp-links"><Link className="btn ops-tap" to="/field-report">Field, by turf →</Link></p>
      {q.data && Object.entries(q.data.reports).map(([name, r]) => <Report key={name} name={name} r={r} />)}
      <section className="rp-sec" aria-labelledby="rp-exports">
        <div className="rp-sec__head"><h2 id="rp-exports">Exports</h2></div>
        <p className="ops-meta">A whole table as a spreadsheet. Bringing data in, and the full backup, are on <Link to="/data">Import &amp; export</Link>.</p>
        <ul className="rp-exports">
          {EXPORTS.map(([k, label]) => <ExportItem key={k} k={k} label={label} me={me} />)}
          <li><a className="btn btn-quiet ops-tap" href={at('/api/export')}>Everything (JSON)</a></li>
        </ul>
      </section>
    </div>
  );
}
