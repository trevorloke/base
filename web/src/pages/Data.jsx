// Import & export (/data — the desk, the Data area): one place to bring the
// campaign's data in and take it out.
//   In:   People — a CSV or an Excel workbook (.xlsx), from any spreadsheet
//         or another campaign tool: columns are matched for you, nothing is
//         saved until it's checked, and the same file twice adds no one
//         twice (People → Import). A voted file goes the same way (a Voted
//         column). Gifts made in another tool come in from its file under
//         Donations (Import donations). The website sends sign-ups itself
//         (Settings → Services).
//   Out:  each table as a spreadsheet (/api/export/<name>.csv — the
//         People one reads straight back in), and everything as one JSON
//         file, for a backup or a move (/api/export).
//   Check: "Verify the records" — the books' hash chain, end to end
//         (/api/audit/verify; it was under Today's More).
import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { apiGet } from '../api.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import { EXPORTS, ExportItem } from './Reports.jsx';
import DriveSent from '../components/DriveSent.jsx';
import './shifts.css';
import './data.css';
import { at } from '../base.js';

export default function DataPage() {
  const { me } = useOutletContext() ?? {};
  const isManager = me?.role === 'manager';
  // Gifts made in another tool come in under Donations (pages/ImportGifts.jsx): the financial agent's people.
  const canGifts = me?.role === 'manager' || me?.role === 'treasurer';
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
                (Mailchimp, NationBuilder, VAN and the like). base.win matches the columns — names, email, phone,
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
              <strong>Gifts made in another tool</strong>
              <span className="muted">A CSV or Excel file of donations taken elsewhere. They count toward the year’s limit; no receipt is made or emailed, and the same file twice adds nothing twice.</span>
            </div>
            {canGifts ? <Link className="btn ops-tap" to="/money/import">Import donations</Link> : <span className="ops-meta">A manager or the treasurer brings it in.</span>}
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
          {EXPORTS.map(([k, label]) => <ExportItem key={k} k={k} label={label} me={me} download />)}
        </ul>
        <div className="card dt-item dt-backup">
          <div className="dt-item__main">
            <strong>Everything, in one file</strong>
            <span className="muted">The whole campaign as JSON — people, contacts, gifts, shifts, signs, lists, the event log — for a backup or a move. Keep it somewhere safe: it holds everyone’s details.</span>
          </div>
          <a className="btn ops-tap" href={at('/api/export')} download>Download everything</a>
        </div>
      </section>

      <DriveSent tz={me?.workspace?.settings?.tz || me?.org?.tz || null} />

      <CheckRecords />
    </div>
  );
}

// Every entry in the books, checked link by link (lib/events.js verifyChain).
function CheckRecords() {
  const [verify, setVerify] = useState(null);
  const online = useOnline();
  const onVerify = async () => {
    setVerify({ busy: true });
    try {
      setVerify(await apiGet('/audit/verify'));
    } catch (e) {
      setVerify({ error: e.message });
    }
  };
  return (
    <section className="dt-sec" aria-labelledby="dt-check">
      <h2 id="dt-check">Check the records</h2>
      <div className="ops-actions">
        <button type="button" className="btn btn-quiet ops-tap" onClick={onVerify} disabled={!online || verify?.busy}>Verify the records</button>
        {!online && <NeedsSignal />}
      </div>
      <div aria-live="polite">
        {verify?.ok && <p className="mono ok-text" role="status">✓ {Number(verify.checked).toLocaleString('en-CA')} entries check out</p>}
        {verify?.ok === false && <p className="error" role="alert">The books don’t check out</p>}
        {verify?.error && <p className="error" role="alert">{verify.error}</p>}
      </div>
    </section>
  );
}
