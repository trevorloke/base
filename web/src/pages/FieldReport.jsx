// Field, by turf (Reports → Field, by turf; desk, the data area): the
// knocks over a range of days — by turf (doors, knocked with a coverage bar,
// talked, yes, not-homes, refused…), by canvasser (doors, talks, yes, days
// out, last out) and by day — and the same as a spreadsheet. The range lives
// in the address (?from&to), so the back button and the kept copy (with no
// signal, components/KeptCopies.js 'fieldReport') agree with the pills.
// Days are the campaign's (the server's zone); the pills count from the
// browser's today. Reads only (server/ext/fieldreport).
import { useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { addDays, dayOf, safeZone, weekStart } from '@starbase/shared/dayparts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import './shifts.css';
import './field-report.css';

// The days are the campaign's (its time zone, as the server counts them),
// not this browser's: a desk in another zone sees the same week. This week
// starts on Monday.
const RANGES = [
  { key: 'week', label: 'This week', from: (today) => weekStart(today) },
  { key: '7d', label: 'Last 7 days', from: (today) => addDays(today, -6) },
  { key: '30d', label: '30 days', from: (today) => addDays(today, -29) },
  { key: 'all', label: 'All', from: () => 'all' },
];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;
const pct = (n) => `${Math.max(0, Math.min(100, Number(n) || 0))}%`;
// "Sat 4:12 p.m." this week; "Oct 3, 4:12 p.m." before.
const when = (iso, tz) => {
  if (!iso) return '';
  const d = new Date(iso);
  const recent = Date.now() - d.getTime() < 6 * 86_400_000;
  const opts = recent ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try { return d.toLocaleString('en-CA', { ...opts, timeZone: tz }); } catch { return d.toLocaleString('en-CA', opts); }
};
const dayWords = (s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(`${s}T12:00:00Z`).toLocaleDateString('en-CA', { ...opts, timeZone: 'UTC' });
const rangeWords = (from, to) => (from === 'all' ? `Everything up to ${dayWords(to)}`
  : from === to ? dayWords(to) : `${dayWords(from)} – ${dayWords(to)}`);

function Bar({ value }) {
  return <span className="fr-bar" aria-hidden="true"><span style={{ width: pct(value) }} /></span>;
}

// The rest of a turf's knocks, said only when there are some.
const restOf = (t) => [
  [t.no_answer, 'no answer'], [t.refused, 'refused'], [t.moved, 'moved'], [t.inaccessible, 'no access'], [t.left_lit, 'left lit'], [t.other, 'other'],
].filter(([n]) => n > 0).map(([n, w]) => `${num(n)} ${w}`);

function Turfs({ turfs, tz }) {
  if (!turfs.length) return <p className="ops-empty">No turfs drawn yet — draw one on the map.</p>;
  return (
    <>
      <ul className="fr-rows fr-narrow">
        {turfs.map((t) => (
          <li key={t.id} className="fr-row">
            <span className="fr-row__name">{t.name}</span>
            <span className="fr-row__line">
              <span>{plural(t.doors, 'door')}</span> · <span><strong className="mono">{num(t.knocked)}</strong> knocked ({pct(t.coverage_pct)})</span>
            </span>
            <Bar value={t.coverage_pct} />
            <span className="fr-row__sub">
              {[`${num(t.talked)} talked`, `${num(t.support_found)} yes`, ...restOf(t)].join(' · ')}
            </span>
            {t.last_knock_at && <span className="fr-row__sub">{plural(t.canvassers, 'canvasser')} · last knock {when(t.last_knock_at, tz)}</span>}
          </li>
        ))}
      </ul>
      <div className="fr-table-wrap fr-wide">
        <table className="fr-table">
          <thead>
            <tr>
              <th>Turf</th><th className="num">Doors</th><th>Knocked</th><th className="num">Talked</th><th className="num">Yes</th>
              <th className="num">No answer</th><th className="num">Refused</th><th className="num">Moved</th><th className="num">No access</th>
              <th className="num">Left lit</th><th className="num">Other</th><th className="num">Canvassers</th><th>Last knock</th>
            </tr>
          </thead>
          <tbody>
            {turfs.map((t) => (
              <tr key={t.id}>
                <td className="fr-name">{t.name}</td>
                <td className="mono num">{num(t.doors)}</td>
                <td className="fr-knocked"><span className="mono">{num(t.knocked)}</span> <span className="muted">({pct(t.coverage_pct)})</span><Bar value={t.coverage_pct} /></td>
                <td className="mono num">{num(t.talked)}</td>
                <td className="mono num">{num(t.support_found)}</td>
                <td className="mono num">{num(t.no_answer)}</td>
                <td className="mono num">{num(t.refused)}</td>
                <td className="mono num">{num(t.moved)}</td>
                <td className="mono num">{num(t.inaccessible)}</td>
                <td className="mono num">{num(t.left_lit)}</td>
                <td className="mono num">{num(t.other)}</td>
                <td className="mono num">{num(t.canvassers)}</td>
                <td>{when(t.last_knock_at, tz) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Canvassers({ people, tz }) {
  return (
    <>
      <ul className="fr-rows fr-narrow">
        {people.map((p) => (
          <li key={p.id || 'gone'} className="fr-row">
            <span className="fr-row__name">{p.name}{p.team && <span className="muted"> · {p.team}</span>}</span>
            <span className="fr-row__line">
              {[plural(p.doors, 'door'), plural(p.talked, 'talk'), `${num(p.support_found)} yes`, `${plural(p.days_out, 'day')} out`].join(' · ')}
            </span>
            {p.last_out && <span className="fr-row__sub">last out {when(p.last_out, tz)}</span>}
          </li>
        ))}
      </ul>
      <div className="fr-table-wrap fr-wide">
        <table className="fr-table">
          <thead>
            <tr>
              <th>Canvasser</th><th>Team</th><th className="num">Doors</th><th className="num">Talks</th><th className="num">Yes</th>
              <th className="num">Days out</th><th>Last out</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id || 'gone'}>
                <td className="fr-name">{p.name}</td>
                <td>{p.team || <span className="muted">—</span>}</td>
                <td className="mono num">{num(p.doors)}</td>
                <td className="mono num">{num(p.talked)}</td>
                <td className="mono num">{num(p.support_found)}</td>
                <td className="mono num">{num(p.days_out)}</td>
                <td>{when(p.last_out, tz) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Days({ days }) {
  const list = [...days].reverse(); // newest first
  return (
    <div className="fr-table-wrap fr-days">
      <table className="fr-table">
        <thead><tr><th>Day</th><th className="num">Doors</th><th className="num">Talks</th></tr></thead>
        <tbody>
          {list.map((d) => (
            <tr key={d.day}><td>{dayWords(d.day)}</td><td className="mono num">{num(d.doors)}</td><td className="mono num">{num(d.talked)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FieldReport() {
  const [params, setParams] = useSearchParams();
  const { me } = useOutletContext() || {};
  const today = dayOf(new Date(), safeZone(me?.workspace?.settings?.tz || me?.org?.tz));
  const pFrom = params.get('from') || '';
  const pTo = params.get('to') || '';
  const from = pFrom === 'all' || DAY.test(pFrom) ? pFrom : RANGES[2].from(today);
  const to = DAY.test(pTo) ? pTo : today;
  // On a Sunday "This week" and "Last 7 days" are the same days: the one tapped is on.
  const [picked, setPicked] = useState(null);
  const matches = RANGES.filter((r) => r.from(today) === from && to === today).map((r) => r.key);
  const on = matches.includes(picked) ? picked : matches[0];
  const q = useQuery({
    queryKey: ['fieldReport', `${from}:${to}`],
    queryFn: () => apiGet(`/field-report?from=${from}&to=${to}`),
  });
  const d = q.data;
  const t = d?.totals;
  const tz = d?.range?.tz;
  const knocks = (d?.days?.length ?? 0) > 0;
  const pick = (r) => { setPicked(r.key); setParams({ from: r.from(today), to: today }); };

  return (
    <div className="ops-page fr-page">
      <Link className="ops-back" to="/reports">← Reports</Link>
      <div className="ops-head">
        <h1>Field, by turf</h1>
        <a className="btn ops-tap" href={`/api/field-report.csv?from=${from}&to=${to}`}>Download CSV</a>
      </div>
      <div className="fr-ranges" role="radiogroup" aria-label="Range">
        {RANGES.map((r) => (
          <button key={r.key} type="button" role="radio" aria-checked={on === r.key}
            className={`fr-range${on === r.key ? ' is-on' : ''}`} onClick={() => pick(r)}>{r.label}</button>
        ))}
      </div>
      <p className="ops-meta fr-when">{rangeWords(from, to)}</p>

      {noSignal(q) ? <NoSignal /> : q.isPending ? <p className="muted">Loading…</p> : q.isError ? (
        <p className="error" role="alert">{q.error.message}</p>
      ) : (
        <>
          {t && (
            <p className="fr-totals">
              <span><strong className="mono">{num(t.knocked)}</strong> of {plural(t.doors, 'door')} in turfs knocked</span>
              <span><strong className="mono">{num(t.talked)}</strong> talked</span>
              <span><strong className="mono">{num(t.support_found)}</strong> yes</span>
              <span><strong className="mono">{num(t.canvassers)}</strong> {Number(t.canvassers) === 1 ? 'canvasser' : 'canvassers'}</span>
            </p>
          )}
          {!knocks && <p className="ops-empty">No knocks in this range yet.</p>}
          <section className="fr-sec" aria-labelledby="fr-turfs">
            <h2 id="fr-turfs">By turf</h2>
            <Turfs turfs={d.turfs} tz={tz} />
          </section>
          {knocks && (
            <>
              <section className="fr-sec" aria-labelledby="fr-people">
                <h2 id="fr-people">By canvasser</h2>
                <Canvassers people={d.canvassers} tz={tz} />
              </section>
              <section className="fr-sec" aria-labelledby="fr-days">
                <h2 id="fr-days">By day</h2>
                <Days days={d.days} />
              </section>
            </>
          )}
          <p className="ops-meta fr-note">People are counted where their pin is today; support found is the rating given at the door.</p>
        </>
      )}
    </div>
  );
}
