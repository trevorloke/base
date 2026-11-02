// Election day (ext/voted) — /voted, from Today → More. The desk's one
// place for the mark: the switch that puts "Voted ✓" on every volunteer's
// walk list, door card and Calls card (managers; staff see where it
// stands) with the date; then "Voted so far" — supporters voted, by band,
// and by turf with a Walk list link — and how a voted file from the
// campaign's website comes in (People → Import). Needs signal.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, todayISO } from '../api.js';
import { NeedsSignal, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import '../components/voted.css';
import './shifts.css';
import './surveys.css';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const BANDS = [['support', 'Support'], ['undecided', 'Undecided'], ['opposed', 'Opposed'], ['unrated', 'Unrated']];

export default function Voted() {
  const { me } = useOutletContext() ?? {};
  const isManager = me?.role === 'manager';
  const queryClient = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: ['voted', 'summary'], queryFn: () => apiGet('/voted/summary'), staleTime: 15_000 });
  const [draft, setDraft] = useState(null); // { on, election_day } once edited
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const head = (
    <>
      <Link to="/" className="ops-back">← Today</Link>
      <h1>Election day</h1>
    </>
  );
  if (noSignal(q)) return <div className="vt-page">{head}<NoSignal /></div>;
  if (q.isPending) return <div className="vt-page">{head}<p className="muted">Loading…</p></div>;
  if (q.isError) return <div className="vt-page">{head}<p className="error" role="alert">{q.error.message}</p></div>;
  const s = q.data;
  const cur = draft || { on: Boolean(s.on), election_day: s.election_day || '' };
  const changed = Boolean(draft) && (cur.on !== Boolean(s.on) || (cur.election_day || '') !== (s.election_day || ''));

  const setOn = (on) => setDraft({ on, election_day: cur.election_day || (on ? todayISO() : '') });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('vote.settings', { on: cur.on, election_day: cur.election_day || null });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['voted'] }),
        queryClient.invalidateQueries({ queryKey: ['brief'] }),
      ]);
      setDraft(null);
      setSaid('Saved');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaid(null), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pct = s.supporters ? Math.min(100, Math.round((s.supporters_voted / s.supporters) * 100)) : 0;
  return (
    <div className="vt-page">
      {head}

      <section className="vt-sec" aria-labelledby="vt-mode-h">
        <h2 id="vt-mode-h">Election day</h2>
        <div className="vt-switchrow">
          <button type="button" role="switch" aria-checked={cur.on} className="sv-switch" disabled={!isManager || busy}
            onClick={() => setOn(!cur.on)}>
            <span className="sv-switch__track" aria-hidden="true"><span className="sv-switch__dot" /></span>
            <span className="sv-switch__label">{cur.on ? 'On' : 'Off'}</span>
          </button>
          <div className="field">
            <label htmlFor="vt-date">Date</label>
            <input id="vt-date" type="date" className="input vt-date" value={cur.election_day || ''} disabled={!isManager || busy}
              onChange={(e) => setDraft({ on: cur.on, election_day: e.target.value })} />
          </div>
        </div>
        <p className="vt-line">When this is on, every volunteer can mark a person as voted from the walk list, the door card and Calls.</p>
        {isManager ? (
          <div className="vt-save">
            <button type="button" className="btn btn-primary vt-tap" disabled={busy || !changed || !online} onClick={save}>Save</button>
            {!online && <NeedsSignal />}
            {said && <span className="mono ok-text" role="status">✓ {said}</span>}
          </div>
        ) : (
          <p className="ops-meta">A manager turns this on.</p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="vt-sec" aria-labelledby="vt-sofar-h">
        <h2 id="vt-sofar-h">Voted so far</h2>
        <p className="vt-big mono"><strong>{num(s.supporters_voted)}</strong> of {num(s.supporters)} supporters voted</p>
        <span className="vt-bar" role="progressbar" aria-label="Supporters voted" aria-valuemin={0} aria-valuemax={s.supporters || 0} aria-valuenow={Math.min(s.supporters_voted || 0, s.supporters || 0)}>
          <span className="vt-bar__fill" style={{ width: `${pct}%` }} />
        </span>
        <p className="vt-line mono">{plural(s.total, 'person', 'people')} voted in all · {num(s.today)} marked today</p>
        <ul className="vt-bands" aria-label="Voted, by rating">
          {BANDS.map(([key, label]) => <li key={key}><span className="chip">{label} · {num(s.by_band?.[key])}</span></li>)}
        </ul>
        {s.by_turf?.length ? (
          <table className="table vt-table">
            <thead>
              <tr><th>Turf</th><th className="num">Supporters</th><th className="num">Voted</th><th className="num">People</th></tr>
            </thead>
            <tbody>
              {s.by_turf.map((t) => (
                <tr key={t.turf_id}>
                  <td>
                    <span className="vt-turf">{t.name}</span><br />
                    <Link className="vt-walk" to={`/turfs/${t.turf_id}`}>Walk list</Link>
                  </td>
                  <td className="num">{num(t.supporters)}</td>
                  <td className="num">{num(t.voted)}</td>
                  <td className="num">{num(t.people)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="vt-empty">No turfs yet — draw one on the map to see this by turf.</p>}
      </section>

      <section className="vt-sec" aria-labelledby="vt-file-h">
        <h2 id="vt-file-h">A voted file</h2>
        <p className="vt-line">
          A voted file from the campaign’s website: <Link to="/people/import">People → Import</Link> with a Voted column (1/0 or a date).
          A file marks people; it never un-marks anyone.
        </p>
      </section>
    </div>
  );
}
