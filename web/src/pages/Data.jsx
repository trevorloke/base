// Import & export (/data — the desk, the Data area): one place to bring the
// campaign's data in and take it out.
//   In:   People — a CSV or an Excel workbook (.xlsx), from any spreadsheet
//         or another campaign tool: columns are matched for you, nothing is
//         saved until it's checked, and the same file twice adds no one
//         twice (People → Import). A voted file goes the same way (a Voted
//         column). The website sends sign-ups itself (Settings → Services).
//   Out:  each table as a spreadsheet (/api/export/<name>.csv — the
//         People one reads straight back in), and everything as one JSON
//         file, for a backup or a move (/api/export).
import { Link, useOutletContext } from 'react-router-dom';
import { EXPORTS } from './Reports.jsx';
import './shifts.css';
import './data.css';
import { at } from '../base.js';

export default function DataPage() {
  const { me } = useOutletContext() ?? {};
  const isManager = me?.role === 'manager';
  return (
    <div className="ops-page dt-page">
      <div className="ops-head"><h1>Import &amp; export</h1></div>

      <section className="dt-sec" aria-labelledby="dt-in">
        <h2 id="dt-in">Bring data in</h2>
        <ul className="dt-list">
          <li className="card dt-item">
            <div className="dt-item__main">
              <strong>People</strong>
              <span className="muted">
                A CSV or an Excel workbook (.xlsx) — from a spreadsheet, a voter file, or another tool’s export
                (Mailchimp, NationBuilder, VAN and the like). Base matches the columns — names, email, phone,
                address, tags, ratings, voted — you check them, and nothing is saved until you say so. Importing
                the same file again adds no one twice: it fills in blanks.
              </span>
            </div>
            <Link className="btn btn-primary ops-tap" to="/people/import">Import people</Link>
          </li>
          <li className="card dt-item">
            <div className="dt-item__main">
              <strong>A voted file</strong>
              <span className="muted">The same import, with a Voted column (1/0 or a date). It marks people as voted; it never un-marks anyone.</span>
            </div>
            <Link className="btn ops-tap" to="/people/import">Import a voted file</Link>
          </li>
          <li className="card dt-item">
            <div className="dt-item__main">
              <strong>From the website</strong>
              <span className="muted">Sign-ups, petitions and volunteer forms come in on their own, with a website key.</span>
            </div>
            {isManager ? <Link className="btn ops-tap" to="/settings/services">Website keys</Link> : <span className="ops-meta">A manager sets it up.</span>}
          </li>
        </ul>
      </section>

      <section className="dt-sec" aria-labelledby="dt-out">
        <h2 id="dt-out">Take data out</h2>
        <p className="ops-meta">Each as a spreadsheet (CSV, opens in Excel, Numbers or Google Sheets). The People one imports straight back in.</p>
        <ul className="dt-exports">
          {EXPORTS.map(([k, label]) => (
            <li key={k}><a className="btn ops-tap" href={at(`/api/export/${k}.csv`)} download>{label}</a></li>
          ))}
        </ul>
        <div className="card dt-item dt-backup">
          <div className="dt-item__main">
            <strong>Everything, in one file</strong>
            <span className="muted">The whole campaign as JSON — people, contacts, gifts, shifts, signs, lists, the event log — for a backup or a move. Keep it somewhere safe: it holds everyone’s details.</span>
          </div>
          <a className="btn ops-tap" href={at('/api/export')} download>Download everything</a>
        </div>
      </section>
    </div>
  );
}
