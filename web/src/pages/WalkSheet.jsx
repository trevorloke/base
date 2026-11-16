// The paper walking list (/reports/walk): for a canvasser with no phone.
// No ?turf: choose a turf (names only — counting every turf is what
// ?outline=1 exists to avoid). With ?turf: the sheet, the same on screen and
// on paper — doors in walking order under street headings, the people at
// each door A–Z, a tick box under each answer in the campaign's own words,
// and a line for a note. Never a phone number or an email.
// (GET /api/quick-reports/walk, server/ext/reports/quick.js)
import { useMemo, useState } from 'react';
import { Link, Navigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../api.js';
import { at } from '../base.js';
import { fmt } from '../components/AudienceBits.jsx';
import NameAz from '../components/NameAz.jsx';
import { NeedsSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { useScripts } from '../components/ScriptLine.jsx';
import { useVotedMode } from '../components/Voted.jsx';
import { azSort } from '@starbase/shared/names';
import { isDesk } from '../Shell.jsx';
import { todayWords } from './QuickReport.jsx';
import './shifts.css';
import './quick.css';

// The outcomes a canvasser ticks, in plain words (shared/canvass.js OUTCOMES:
// no_answer, refused, moved, left_lit, inaccessible), then two asks.
const TICKS = ['Not home', 'Refused', 'Moved', 'Left a flyer', 'Can’t get in', 'Sign', 'Volunteer'];
const SEARCH_FROM = 12;
const refused = (err) => err instanceof ApiError && err.status >= 400 && err.status < 500;

// The door script filled for paper: the campaign's name, and blanks to say.
const fillForPaper = (body, campaign) => String(body || '')
  .replace(/\{\{\s*first_name\s*\}\}/gi, '[their first name]')
  .replace(/\{\{\s*my_name\s*\}\}/gi, '[your name]')
  .replace(/\{\{\s*campaign\s*\}\}/gi, campaign || '');
// "Voting for Locke" reads "Last: voting for Locke".
const lastWord = (w) => (/^Voting for /.test(w) ? `voting for ${w.slice(11)}` : w);

function Chooser() {
  const [find, setFind] = useState('');
  const turfs = useQuery({ queryKey: ['turfs', 'outline'], queryFn: () => apiGet('/turfs?outline=1') });
  const unplaced = useQuery({ queryKey: ['quick', 'walk', 'unplaced'], queryFn: () => apiGet('/quick-reports/walk/unplaced'), retry: false });
  const list = useMemo(() => [...(turfs.data?.turfs || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true })), [turfs.data]);
  const f = find.trim().toLowerCase();
  const shown = f ? list.filter((t) => String(t.name).toLowerCase().includes(f)) : list;
  return (
    <div className="ops-page qr-page">
      <Link className="ops-back" to="/reports">← Reports</Link>
      <div className="ops-head"><h1>Walking list</h1></div>
      {noSignal(turfs) ? <p className="qr-state"><NeedsSignal className="" /></p>
        : turfs.isPending ? <p className="qr-state" role="status">Loading…</p>
        : turfs.isError ? <p className="qr-state qr-state--bad" role="alert">Unavailable — <button type="button" className="btn btn-quiet ops-tap" onClick={() => turfs.refetch()}>Try again</button></p>
        : !list.length ? (
          <div className="ops-empty-block"><p className="ops-empty">No turfs yet.</p><Link className="btn btn-quiet ops-tap" to="/map?draw=1">Draw a turf</Link></div>
        ) : (
          <>
            <p className="ops-meta">Choose a turf to print its doors.</p>
            {list.length > SEARCH_FROM && (
              <input className="input ws-search" type="search" aria-label="Find a turf" placeholder="Find a turf" value={find} onChange={(e) => setFind(e.target.value)} />
            )}
            {shown.length ? (
              <ul className="ws-turfs">
                {shown.map((t) => <li key={t.id}><Link to={`/reports/walk?turf=${t.id}`}>{t.name}</Link></li>)}
              </ul>
            ) : <p className="ops-empty" role="status">No turf by that name.</p>}
          </>
        )}
      {unplaced.isError ? <p className="ws-unplaced">Unavailable</p>
        : unplaced.data?.count > 0 && (
          <p className="ws-unplaced">
            {fmt(unplaced.data.count)} {unplaced.data.count === 1 ? 'person with an address isn’t' : 'people with an address aren’t'} on the map yet, so they’re on no walking list.{' '}
            <Link to="/map">Map → Not on the map</Link>
          </p>
        )}
    </div>
  );
}

function Sheet({ s, script }) {
  const steps = s.scale?.steps || [];
  const heads = [...steps.map((x) => x.word), ...TICKS];
  const cands = (s.scale?.candidates || []).map((c) => `${String(c.code).replace(/^4/, '')} ${c.name}`);
  const cols = heads.length + 2;
  let street = null;
  const body = [];
  s.doors.forEach((d, i) => {
    if (d.street !== street) {
      street = d.street;
      body.push(<tbody key={`s${i}`}><tr className="ws-street"><th colSpan={cols} scope="colgroup">{d.street || 'No street'}</th></tr></tbody>);
    }
    const done = d.state === 'done';
    body.push(
      <tbody key={`d${i}`} className={`ws-door${done ? ' is-done' : ''}`}>
        <tr className="ws-door__addr">
          <td colSpan={cols}>
            {d.house_number ? `${d.house_number} ${d.street}` : d.address}{d.unit ? `, Unit ${d.unit}` : ''}
            {done && <span className="ws-door__state">Done</span>}
            {d.state === 'again' && <span className="ws-door__state">Try again</span>}
          </td>
        </tr>
        {[...d.persons].sort(azSort).map((p) => (
          <tr key={p.id}>
            <td className="ws-person">
              <NameAz person={p} />
              <span className="ws-person__facts">
                {[p.rating_word ? `Last: ${lastWord(p.rating_word)}` : '', p.voted_at ? 'Voted' : ''].filter(Boolean).join(' · ')}
                {p.no_contact && <>{p.rating_word || p.voted_at ? ' · ' : ''}<span className="ws-skip">Do not contact — skip</span></>}
              </span>
            </td>
            {heads.map((h) => <td key={h} className="ws-tick"><span className="ws-box" aria-hidden="true" /></td>)}
            <td className="ws-note"><span className="ws-line" aria-hidden="true" /></td>
          </tr>
        ))}
      </tbody>,
    );
  });
  return (
    <div className="ws-sheet">
      <h2>{s.turf.name} — walking list</h2>
      <p className="ws-sub">{[s.pass?.name, `${fmt(s.counts.doors)} ${s.counts.doors === 1 ? 'door' : 'doors'}`, `${fmt(s.counts.people)} people`, `printed ${todayWords()}`].filter(Boolean).join(' · ')}</p>
      <p className="ws-fill">{'Canvasser ____________  Date ________  Back to the office by ________'}</p>
      {cands.length > 0 && <p className="ws-who">If Opposed, write the letter of who they’re voting for: {cands.join(' · ')}</p>}
      {script && <div className="ws-script"><b>Script</b>{script}</div>}
      {!s.doors.length ? (
        <p className="qr-state">{s.doors_shown === 'left' ? 'No doors left to knock in this turf.' : 'No doors on the map in this turf yet.'}</p>
      ) : (
        <table className="ws-table">
          <thead>
            <tr>
              <th scope="col">Door and people</th>
              {heads.map((h) => <th key={h} scope="col" className="ws-tickh">{h}</th>)}
              <th scope="col" className="ws-noteh">Note</th>
            </tr>
          </thead>
          {body}
        </table>
      )}
      {s.more > 0 && <p className="ws-foot">Showing the first {fmt(s.doors.length)} doors. Split the turf on the map to print the rest.</p>}
      <p className="ws-foot qr-printonly">Private — bring this sheet back to the office.</p>
    </div>
  );
}

function WalkOne({ turf }) {
  const { me } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();
  const online = useOnline();
  const doors = params.get('doors') || '';
  const scriptOff = params.get('script') === 'off';
  const q = useQuery({
    queryKey: ['quick', 'walk', turf, doors],
    queryFn: () => apiGet(`/quick-reports/walk?turf=${encodeURIComponent(turf)}${doors ? `&doors=${doors}` : ''}`),
    placeholderData: keepPreviousData,
    retry: (n, err) => !refused(err) && n < 1,
  });
  const scripts = useScripts();
  const gotv = useVotedMode().on;
  const gotvScript = gotv ? scripts.data?.gotv_door : null;
  const door = gotvScript?.body ? gotvScript : scripts.data?.door;
  const s = q.data;
  const script = door?.body && !scriptOff ? fillForPaper(door.body, s?.campaign || me?.workspace?.name) : null;
  const set = (k, v) => { const n = new URLSearchParams(params); n.set(k, v); setParams(n, { replace: true }); };
  const dark = noSignal(q) || (!online && !s);
  const canPrint = Boolean(s) && !q.isPlaceholderData && online;
  const csv = at(`/api/quick-reports/walk.csv?turf=${encodeURIComponent(turf)}${doors ? `&doors=${doors}` : ''}`);
  const tooBig = q.isError && q.error?.status === 409;
  const shownDoors = s?.doors_shown || 'left';
  return (
    <div className="ops-page qr-page qr-print">
      <Link className="ops-back qr-noprint" to="/reports/walk">← Choose another turf</Link>
      <div className="qr-printonly">
        <strong>{s?.campaign || me?.workspace?.name}</strong> · Walking list
        <br />Printed {todayWords()}{me?.user?.name ? ` by ${me.user.name}` : ''}{s ? ` · ${fmt(s.counts.doors)} doors` : ''}
      </div>
      <div className="ops-head">
        <h1>{s?.turf?.name || (q.isError ? 'Walking list' : 'Loading…')}</h1>
        <div className="ops-head__actions qr-noprint">
          <button type="button" className="btn btn-primary ops-tap" disabled={!canPrint || tooBig} onClick={() => window.print()}>Print</button>
          <a className="btn btn-quiet ops-tap" href={csv} download>Download CSV</a>
        </div>
      </div>
      {s && (s.pass || door?.body) && (
        <div className="qr-noprint">
          {s.pass && (
            <div className="qr-chips" role="group" aria-label="Doors">
              {[['left', 'Still to knock'], ['all', 'Every door']].map(([code, words]) => (
                <button key={code} type="button" className={`chip qr-chip${shownDoors === code ? ' is-on' : ''}`} aria-pressed={shownDoors === code} onClick={() => set('doors', code)}>{words}</button>
              ))}
            </div>
          )}
          {door?.body && (
            <div className="qr-chips" role="group" aria-label="Script">
              {[['on', 'Script: On'], ['off', 'Script: Off']].map(([code, words]) => {
                const on = (code === 'off') === scriptOff;
                return <button key={code} type="button" className={`chip qr-chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => set('script', code)}>{words}</button>;
              })}
            </div>
          )}
        </div>
      )}
      {dark ? <p className="qr-state"><NeedsSignal className="" /></p>
        : q.isPending ? <p className="qr-state" role="status">Loading…</p>
        : tooBig ? <p className="qr-state qr-state--bad" role="alert">{q.error.message}. <Link to={`/map?turf=${encodeURIComponent(turf)}`}>Open the map</Link></p>
        : q.isError && refused(q.error) ? <p className="qr-state qr-state--bad" role="alert">{q.error.status === 404 ? 'No such turf.' : q.error.message}</p>
        : q.isError ? <p className="qr-state qr-state--bad" role="alert">Unavailable — <button type="button" className="btn btn-quiet ops-tap" onClick={() => q.refetch()}>Try again</button></p>
        : <Sheet s={s} script={script} />}
    </div>
  );
}

export default function WalkSheet() {
  const { me } = useOutletContext() ?? {};
  const [params] = useSearchParams();
  if (!isDesk(me)) return <Navigate to="/" replace />;
  const turf = params.get('turf');
  return turf ? <WalkOne key={turf} turf={turf} /> : <Chooser />;
}
