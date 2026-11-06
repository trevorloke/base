// GOTV (ext/voted) — /voted, from Today → More. The desk's one place for
// get-out-the-vote: GOTV mode puts "Voted ✓" on every walk list, door card
// and Calls card, swaps in the GOTV scripts, and puts the supporters who
// haven't voted at the top of Today and the map. It turns itself on for the
// voting days (the advance-voting days and election day, in the campaign's
// day), or a manager turns it on by hand (staff see where it stands). Then
// "Voted so far" — supporters voted, by band, and by turf with a Walk list
// link — and how a voted file comes in (People → Import). Needs signal.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
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
  const [draft, setDraft] = useState(null); // { on, election_day, advance_days, auto } once edited
  const [newDay, setNewDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const head = (
    <>
      <Link to="/" className="ops-back">← Today</Link>
      <h1>Get out the vote</h1>
    </>
  );
  if (noSignal(q)) return <div className="vt-page">{head}<NoSignal /></div>;
  if (q.isPending) return <div className="vt-page">{head}<p className="muted">Loading…</p></div>;
  if (q.isError) return <div className="vt-page">{head}<p className="error" role="alert">{q.error.message}</p></div>;
  const s = q.data;
  const saved = { on: Boolean(s.manual), election_day: s.election_day || '', advance_days: s.advance_days || [], auto: s.auto !== false };
  const cur = draft || saved;
  const changed = Boolean(draft) && JSON.stringify(cur) !== JSON.stringify(saved);
  const patch = (p) => setDraft({ ...cur, ...p });
  const setOn = (on) => patch({ on });
  const addDay = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDay)) return;
    patch({ advance_days: [...new Set([...cur.advance_days, newDay])].sort() });
    setNewDay('');
  };
  const dayWord = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  const why = s.on
    ? (s.voting_day === 'election' && !s.manual ? 'On — it’s election day.' : s.voting_day === 'advance' && !s.manual ? 'On — it’s an advance-voting day.' : 'On.')
    : 'Off.';
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('vote.settings', { on: cur.on, election_day: cur.election_day || null, advance_days: cur.advance_days, auto: cur.auto });
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
        <h2 id="vt-mode-h">GOTV mode</h2>
        <p className="vt-now" role="status"><strong>{why}</strong></p>
        <p className="vt-line">While it’s on: everyone can mark people as voted (walk list, door card, Calls), the GOTV scripts are said instead of the usual ones (<Link to="/scripts">Scripts</Link>), and Today and the map open on the supporters who haven’t voted.</p>

        <div className="field">
          <label htmlFor="vt-date">Election day</label>
          <input id="vt-date" type="date" className="input vt-date" value={cur.election_day || ''} disabled={!isManager || busy}
            onChange={(e) => patch({ election_day: e.target.value })} />
        </div>
        <div className="field">
          <span className="vt-label" id="vt-adv-l">Advance-voting days</span>
          {cur.advance_days.length > 0 ? (
            <ul className="vt-days" aria-labelledby="vt-adv-l">
              {cur.advance_days.map((d) => (
                <li key={d} className="chip vt-day">
                  <span className="mono">{dayWord(d)}</span>
                  {isManager && <button type="button" className="vt-day__x" aria-label={`Take ${dayWord(d)} off`} disabled={busy} onClick={() => patch({ advance_days: cur.advance_days.filter((x) => x !== d) })}>✕</button>}
                </li>
              ))}
            </ul>
          ) : <p className="ops-meta">None yet.</p>}
          {isManager && (
            <div className="vt-addday">
              <input id="vt-newday" type="date" className="input vt-date" aria-label="An advance-voting day" value={newDay} disabled={busy} onChange={(e) => setNewDay(e.target.value)} />
              <button type="button" className="btn vt-tap" disabled={busy || !newDay} onClick={addDay}>Add day</button>
            </div>
          )}
        </div>
        <label className="ot-check vt-auto">
          <input type="checkbox" checked={cur.auto} disabled={!isManager || busy} onChange={(e) => patch({ auto: e.target.checked })} />
          <span>Turn on by itself on these days (in the campaign’s time)</span>
        </label>
        <div className="vt-switchrow">
          <button type="button" role="switch" aria-checked={cur.on} className="sv-switch" disabled={!isManager || busy}
            onClick={() => setOn(!cur.on)}>
            <span className="sv-switch__track" aria-hidden="true"><span className="sv-switch__dot" /></span>
            <span className="sv-switch__label">{cur.on ? 'On by hand' : 'Not on by hand'}</span>
          </button>
          <span className="ops-meta">On by hand: on whatever the day (a practice run, the weekend before).</span>
        </div>
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
        <p className="vt-line mono">{plural(s.total, 'person', 'people')} voted in all · {num(s.today)} today</p>
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
