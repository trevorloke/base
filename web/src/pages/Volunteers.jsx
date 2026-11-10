// Shifts → Volunteers (desk): everyone who volunteers, in one list.
//
// Who: a volunteer role, ever on a shift, asked to volunteer (a door, the
// membership form, Mainstreeting), a volunteer sign-in, or the "volunteer"
// tag (server/ext/volunteers). Each row says where they stand — "Asked to
// volunteer · 3 days ago", "Next: Saturday canvass · Sat, Nov 14", "Last
// active Oct 3" — with their roles and shifts done; a chip says New ·
// Active · Lapsed (nothing for 30 days).
//
// Show: Asked to volunteer (only when someone has) · New · Active · Lapsed ·
// All, a role, and a name. Asked come first everywhere; Lapsed is most
// recent first (the easiest to win back); Active is soonest shift first.
//
// Tap a row: Call · Text · Email, their numbers (shifts done, no-shows,
// upcoming), and "Put on a shift" — the next weeks' shifts, each with its
// spots and "Busy then" when it clashes with one of theirs; a tap books them
// (shift.add) and their "Wants to volunteer" request is done. Profile is
// one more tap. Needs signal.
import { useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { apiGet, action } from '../api.js';
import { NeedsSignalLine, useOnline } from '../components/NoSignal.jsx';
import { clockText, monthDay, overlaps, shortDay, zoneOf } from '../components/shiftTime.js';
import './shifts.css';
import './volunteers.css';

const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label ?? code;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Days and hours are the campaign's (components/shiftTime.js), never the device's.
const ago = (iso, tz) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return monthDay(iso, tz);
};
const STAGE = { active: ['Active', 'chip-ok'], new: ['New', 'chip-warn'], lapsed: ['Lapsed', ''] };
const SHOWS = [
  ['asked', 'Asked to volunteer'], ['new', 'New'], ['active', 'Active'], ['lapsed', 'Lapsed'], ['all', 'All'],
];
const PAGE = 150;
const AHEAD_DAYS = 30;

function statusLine(v, tz) {
  if (v.asked) return `Asked to volunteer · ${ago(v.asked_at, tz)}`;
  if (v.next) return `Next: ${v.next.title} · ${shortDay(v.next.starts_at, tz)}`;
  if (v.last_active_at) return `Last active ${monthDay(v.last_active_at, tz)}`;
  return 'Nothing yet';
}

function PutOnShift({ v, shifts, tz, onDone }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const mine = new Set(v.upcoming_shifts.map((s) => s.id));
  const book = async (s) => {
    setError(null);
    setBusyId(s.id);
    try {
      const r = await action('shift.add', { shift_id: s.id, person_id: v.id });
      onDone(s, r);
    } catch (e) {
      setError(`${s.title}: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };
  if (!shifts.length) {
    return <p className="ops-empty">No shifts in the next {AHEAD_DAYS} days. <Link to="/shifts?add=1">New shift</Link></p>;
  }
  return (
    <div className="vl-pick">
      <ul className="vl-shifts" aria-label={`Shifts for ${v.name}`}>
        {shifts.map((s) => {
          const on = mine.has(s.id);
          const full = !!s.capacity && (Number(s.filled) || 0) >= s.capacity;
          const clash = !on && v.upcoming_shifts.find((x) => x.id !== s.id && overlaps(x, s));
          const left = s.capacity ? Math.max(0, s.capacity - (Number(s.filled) || 0)) : null;
          return (
            <li key={s.id}>
              <button type="button" className="vl-shift" disabled={on || full || busyId !== null}
                data-clash={clash ? '' : undefined} onClick={() => book(s)}>
                <span className="vl-shift__what">{s.title}</span>
                <span className="vl-shift__when">{shortDay(s.starts_at, tz)} · {clockText(s.starts_at, tz)}{s.location ? ` · ${s.location}` : ''}</span>
                <span className="vl-shift__note">
                  {on ? 'On it' : full ? 'Full' : clash ? `Busy then: ${clash.title}` : left != null ? `${plural(left, 'spot')} left` : `${Number(s.filled) || 0} going`}
                  {busyId === s.id && ' — saving…'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Row({ v, tz, open, onToggle, shifts, onBooked }) {
  const [picking, setPicking] = useState(false);
  const [booked, setBooked] = useState(null);
  const [label, tone] = STAGE[v.stage] || ['', ''];
  const bodyId = `vl-${v.id}`;
  return (
    <li className="ops-item vl-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { setPicking(false); onToggle(); }}>
        <span className="ops-row__main">
          <span className="ops-row__name">{v.name}</span>
          <span className="ops-row__sub vl-status" data-asked={v.asked ? '' : undefined}>
            {statusLine(v, tz)}{v.done ? ` · ${plural(v.done, 'shift')}` : ''}
          </span>
          {v.roles.length > 0 && <span className="vl-roles">{v.roles.map(roleLabel).join(' · ')}</span>}
        </span>
        <span className="ops-row__end"><span className={`chip${tone ? ` ${tone}` : ''}`}>{label}</span></span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          {(v.phone || v.email) && (
            <div className="ops-contact vl-contact">
              {v.phone && <a className="btn ops-tap" href={`tel:${v.phone}`}>Call</a>}
              {v.phone && <a className="btn ops-tap" href={`sms:${v.phone}`}>Text</a>}
              {v.email && <a className="btn ops-tap" href={`mailto:${v.email}`}>Email</a>}
              <span className="vl-numbers">{[v.phone, v.email].filter(Boolean).join(' · ')}</span>
            </div>
          )}
          <p className="vl-facts">
            {plural(v.done, 'shift')} done
            {v.no_shows ? ` · ${plural(v.no_shows, 'no-show')}` : ''}
            {v.upcoming ? ` · ${v.upcoming} coming up` : ''}
            {v.last_active_at ? ` · last active ${monthDay(v.last_active_at, tz)}` : ''}
            {!v.signed_in && ' · no app sign-in'}
          </p>
          {v.upcoming_shifts.length > 0 && (
            <ul className="vl-next">
              {v.upcoming_shifts.slice(0, 4).map((s) => (
                <li key={s.id}><Link to={`/shifts/${s.id}`}>{s.title}</Link> · {shortDay(s.starts_at, tz)} · {clockText(s.starts_at, tz)}</li>
              ))}
            </ul>
          )}
          {booked && <p className="ops-done" role="status">✓ On {booked.title}{booked.requestDone ? ' — their “Wants to volunteer” is done' : ''}</p>}
          {!picking ? (
            <div className="ops-actions">
              <button type="button" className="btn btn-primary ops-tap" onClick={() => setPicking(true)}>Put on a shift</button>
              <Link className="btn btn-quiet ops-tap ops-link" to={`/people/${v.id}`}>Profile</Link>
            </div>
          ) : (
            <>
              <span className="eyebrow ops-label">Put {v.name.split(' ')[0]} on</span>
              <PutOnShift v={v} shifts={shifts} tz={tz}
                onDone={(s, r) => { setPicking(false); setBooked({ title: s.title, requestDone: r.requests_done > 0 }); onBooked(); }} />
              <div className="ops-actions">
                <button type="button" className="btn btn-quiet ops-tap" onClick={() => setPicking(false)}>Done</button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function Volunteers() {
  const { me } = useOutletContext() ?? {};
  const tz = zoneOf(me);
  const queryClient = useQueryClient();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const rosterQ = useQuery({ queryKey: ['volunteers'], queryFn: () => apiGet('/volunteers') });
  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => apiGet('/shifts') });
  const [find, setFind] = useState('');
  const [role, setRole] = useState('');
  const [openId, setOpenId] = useState(null);
  const [limit, setLimit] = useState(PAGE);

  const all = rosterQ.data?.volunteers ?? [];
  const counts = rosterQ.data?.counts ?? { all: 0, active: 0, new: 0, lapsed: 0, asked: 0 };
  const want = params.get('show');
  const show = SHOWS.some(([k]) => k === want) && (want !== 'asked' || counts.asked > 0) ? want : 'all';
  const pick = (k) => { setParams(k === 'all' ? {} : { show: k }, { replace: true }); setLimit(PAGE); setOpenId(null); };
  const roles = useMemo(() => {
    const n = new Map();
    for (const v of all) for (const r of v.roles) n.set(r, (n.get(r) || 0) + 1);
    return VOLUNTEER_ROLES.filter((r) => n.has(r.code)).map((r) => ({ ...r, n: n.get(r.code) }));
  }, [all]);
  const q = find.trim().toLowerCase();
  const rows = useMemo(() => {
    const keep = all.filter((v) => (show === 'all' || (show === 'asked' ? v.asked : v.stage === show))
      && (!role || v.roles.includes(role))
      && (!q || v.name.toLowerCase().includes(q) || (v.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000')));
    const time = (iso) => (iso ? new Date(iso).getTime() : 0);
    const by = show === 'lapsed' ? (a, b) => time(b.last_active_at) - time(a.last_active_at)
      : show === 'active' ? (a, b) => time(a.next?.starts_at) - time(b.next?.starts_at) || time(b.last_active_at) - time(a.last_active_at)
        : (a, b) => (b.asked - a.asked) || time(b.asked_at) - time(a.asked_at)
          || ['active', 'new', 'lapsed'].indexOf(a.stage) - ['active', 'new', 'lapsed'].indexOf(b.stage);
    return keep.sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
  }, [all, show, role, q]);
  // The next weeks' shifts, for "Put on a shift".
  const ahead = useMemo(() => {
    const now = Date.now();
    return (shiftsQ.data?.shifts ?? [])
      .filter((s) => new Date(s.starts_at).getTime() > now && new Date(s.starts_at).getTime() < now + AHEAD_DAYS * 864e5)
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  }, [shiftsQ.data]);
  const booked = () => {
    queryClient.invalidateQueries({ queryKey: ['volunteers'] });
    queryClient.invalidateQueries({ queryKey: ['shifts'] });
    queryClient.invalidateQueries({ queryKey: ['shift'] });
    queryClient.invalidateQueries({ queryKey: ['crew'] });
    queryClient.invalidateQueries({ queryKey: ['requests'] });
  };

  return (
    <div className="ops-page vl-page">
      <Link to="/shifts" className="ops-back">← Shifts</Link>
      <div className="ops-head">
        <h1>Volunteers</h1>
      </div>
      {!online && <NeedsSignalLine>The volunteer list needs signal</NeedsSignalLine>}
      {rosterQ.isPending && <p className="muted">{online ? 'Loading…' : ''}</p>}
      {rosterQ.isError && <p className="error">{rosterQ.error.message}</p>}
      {rosterQ.isSuccess && (
        <>
          <p className="vl-sum">
            {plural(counts.all, 'volunteer')} · {counts.active} active
            {counts.asked > 0 && <> · <strong>{counts.asked} asked to volunteer</strong> and waiting</>}
          </p>
          <div className="ops-seg ops-filter vl-shows" role="group" aria-label="Show">
            {SHOWS.filter(([k]) => k !== 'asked' || counts.asked > 0).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={show === k} onClick={() => pick(k)}>
                {label} <span className="vl-n">{counts[k]}</span>
              </button>
            ))}
          </div>
          <div className="vl-find">
            <input className="input" type="search" placeholder="Find by name or phone" aria-label="Find a volunteer"
              value={find} onChange={(e) => { setFind(e.target.value); setLimit(PAGE); }} />
            {roles.length > 0 && (
              <select className="input" aria-label="Role" value={role} onChange={(e) => { setRole(e.target.value); setLimit(PAGE); }}>
                <option value="">Any role</option>
                {roles.map((r) => <option key={r.code} value={r.code}>{r.label} · {r.n}</option>)}
              </select>
            )}
          </div>
          {all.length === 0 ? (
            <p className="ops-empty">
              No volunteers yet. Someone shows here once they have a volunteer role, a shift, a volunteer sign-in,
              the “volunteer” tag, or asked to volunteer.
            </p>
          ) : rows.length === 0 ? (
            <p className="ops-empty">Nobody here.</p>
          ) : (
            <ul className="ops-rows vl-rows">
              {rows.slice(0, limit).map((v) => (
                <Row key={v.id} v={v} tz={tz} open={openId === v.id} shifts={ahead} onBooked={booked}
                  onToggle={() => setOpenId((cur) => (cur === v.id ? null : v.id))} />
              ))}
            </ul>
          )}
          {rows.length > limit && (
            <button type="button" className="btn btn-quiet ops-tap vl-more" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}
            </button>
          )}
        </>
      )}
      {me?.role === 'volunteer' && <p className="ops-meta">Phone numbers and emails are the desk’s.</p>}
    </div>
  );
}
