// The crew board (desk; Shifts → a shift): who's on the shift, and which
// turf each walks.
//
//   Add people (the tray)   the campaign's volunteers who aren't on it —
//                           search, role, "Free then" — each saying if
//                           they're busy then (another shift that overlaps),
//                           asked to volunteer, new, or how many shifts
//                           they've done. Holding the shift's role, asked,
//                           free first.
//   Columns                 one per turf the shift carries, "Not placed yet"
//                           (they have every walk list until placed) and "No
//                           walk list" (drivers, the office). A shift with one
//                           turf: its column holds everyone not placed. No
//                           turfs: one column, "On the shift".
//
// Move someone by dragging their card (mouse, pen, or a finger: press and
// hold, then drag) onto a column — or tap the card, then "Move here" /
// "Add here" on the column (works with a keyboard too; Escape puts it
// down). From the tray, a drop books them (shift.add — and their "Wants to
// volunteer" request is done); between columns it places them
// (shift.place); back on the tray takes them off the shift (Undo brings
// them back as they were: where, their job, confirmed or Here — when this
// desk may place them there). "Split the rest evenly" places everyone not
// placed yet, one turf at a time, fewest people first.
//
// Each card: team lead or driver, first shift, no app sign-in (a walk list
// can't reach their phone), confirmed. Its ⋯ has Team lead · Driver, on the
// day Here · No-show, Call · Text, Profile, and Take off the shift.
//
// Every change shows at once and goes back if the server says no; every
// move is said out loud (aria-live) as well as shown. Needs signal.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VOLUNTEER_ROLES, noCalls } from '@starbase/shared/canvass';
import { apiGet, action } from '../api.js';
import { useOnline } from '../components/NoSignal.jsx';
import { useDragDrop } from '../components/useDragDrop.js';
import { clockText } from '../components/shiftTime.js';
import './shift-crew.css';

const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label ?? code;
const JOBS = { lead: 'Team lead', driver: 'Driver' };
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || name;
const TRAY_SHOWN = 60;
const colKey = (to) => (to === 'every' || to === 'none' ? to : `turf:${to}`);
const toOf = (key) => (key === 'every' || key === 'none' ? key : key?.startsWith('turf:') ? key.slice(5) : null);
const sameItem = (a, b) => a?.id === b?.id;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function ShiftCrew({ shiftId, tz, canMap = true, onChanged }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const crewQ = useQuery({ queryKey: ['crew', shiftId], queryFn: () => apiGet(`/crew/${shiftId}`) });
  // Doors per turf, when the desk's turf list is at hand (a side read).
  const turfsQ = useQuery({ queryKey: ['turfs'], queryFn: () => apiGet('/turfs'), staleTime: 60_000, meta: { side: true } });
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState(null); // { text, undo? } — shown, and read out
  const [error, setError] = useState(null);
  const [find, setFind] = useState('');
  const [role, setRole] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [menu, setMenu] = useState(null);
  // A note fades after a while (one with Undo stays a little longer).
  useEffect(() => {
    if (!say) return undefined;
    const t = setTimeout(() => setSay(null), say.undo ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [say]);

  const data = crewQ.data;
  const shift = data?.shift;
  const turfs = data?.turfs ?? [];
  const crew = data?.crew ?? [];
  const tray = data?.tray ?? [];
  const nameOfTurf = (id) => turfs.find((t) => t.id === id)?.name ?? 'that turf';
  const where = (to) => (to === 'every' ? (turfs.length ? 'not placed yet' : 'on the shift')
    : to === 'none' ? 'no walk list' : nameOfTurf(to));

  // ── Columns ──
  const columns = useMemo(() => {
    const doorsOf = (id) => turfsQ.data?.turfs?.find((t) => t.id === id) ?? null;
    if (!turfs.length) return [{ key: 'every', to: 'every', title: 'On the shift', holds: (c) => true }];
    const turfCols = turfs.map((t) => {
      const s = doorsOf(t.id);
      return {
        key: colKey(t.id), to: t.id, title: t.name, color: t.color, turf: true,
        sub: s ? `${plural(s.doors, 'door')}${s.doorsDone ? ` · ${s.doorsDone} done` : ''}` : null,
        holds: (c) => c.to === t.id || (turfs.length === 1 && c.to === 'every'),
      };
    });
    return [
      ...(turfs.length > 1 ? [{ key: 'every', to: 'every', title: 'Not placed yet', sub: 'Every walk list until you place them', holds: (c) => c.to === 'every' }] : []),
      ...turfCols,
      { key: 'none', to: 'none', title: 'No walk list', sub: 'Drivers, the office…', holds: (c) => c.to === 'none' },
    ];
  }, [turfs, turfsQ.data]);
  const unplaced = turfs.length > 1 ? crew.filter((c) => c.to === 'every') : [];

  // ── The tray: who to add ──
  const roles = useMemo(() => {
    const n = new Map();
    for (const v of tray) for (const r of v.roles) n.set(r, (n.get(r) || 0) + 1);
    return VOLUNTEER_ROLES.filter((r) => n.has(r.code)).map((r) => ({ ...r, n: n.get(r.code) }));
  }, [tray]);
  const sorted = useMemo(() => {
    const rank = (v) => [
      shift?.role && v.roles.includes(shift.role) ? 0 : 1,
      v.busy ? 1 : 0,
      v.asked ? 0 : 1,
      v.stage === 'active' ? 0 : v.stage === 'new' ? 1 : 2,
      -v.done,
    ];
    return [...tray].sort((a, b) => {
      const x = rank(a); const y = rank(b);
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
      return a.name.localeCompare(b.name);
    });
  }, [tray, shift?.role]);
  const q = find.trim().toLowerCase();
  const matching = sorted.filter((v) => (!q || v.name.toLowerCase().includes(q))
    && (!role || v.roles.includes(role)) && (!freeOnly || !v.busy));
  const shown = matching.slice(0, TRAY_SHOWN);

  // ── Writes: shown at once, back if the server says no ──
  const key = ['crew', shiftId];
  const patch = (fn) => queryClient.setQueryData(key, (cur) => (cur ? fn(cur) : cur));
  const settle = () => {
    queryClient.invalidateQueries({ queryKey: key });
    onChanged?.();
  };
  const run = async (optimistic, write, done) => {
    setError(null);
    setBusy(true);
    const before = queryClient.getQueryData(key);
    if (optimistic) patch(optimistic);
    try {
      const r = await write();
      if (done) setSay(done(r));
    } catch (e) {
      queryClient.setQueryData(key, before);
      setError(e.message);
      setSay({ text: `Not saved: ${e.message}` });
    } finally {
      setBusy(false);
      settle();
    }
  };

  // status: Undo's — back as they were (confirmed, or checked in "Here");
  // shift.add books everyone as assigned.
  const add = (v, to, job = null, status = null) => run(
    (cur) => ({
      ...cur,
      tray: cur.tray.filter((x) => x.id !== v.id),
      crew: [...cur.crew, {
        assignment_id: `new-${v.id}`, person_id: v.id, name: v.name, phone: v.phone, email: v.email,
        status: status || 'assigned', to, job, signed_in: v.signed_in, first_shift: v.done === 0,
      }].sort((a, b) => a.name.localeCompare(b.name)),
    }),
    async () => {
      const r = await action('shift.add', { shift_id: shiftId, person_id: v.id, to, ...(job ? { job } : {}) });
      // The card's real id at once, so its ⋯ works before the board reloads.
      patch((cur) => ({ ...cur, crew: cur.crew.map((x) => (x.assignment_id === `new-${v.id}` ? { ...x, assignment_id: r.assignment.id } : x)) }));
      if (status && status !== 'assigned') await action('shift.setStatus', { id: r.assignment.id, status });
      return r;
    },
    (r) => ({ text: `${v.name} is on the shift — ${where(to)}${r.requests_done ? '. Their “Wants to volunteer” is done.' : ''}` }),
  );
  const move = (c, to) => run(
    (cur) => ({ ...cur, crew: cur.crew.map((x) => (x.assignment_id === c.assignment_id ? { ...x, to } : x)) }),
    () => action('shift.place', { id: c.assignment_id, to }),
    () => ({ text: `${c.name} — ${where(to)}` }),
  );
  // Undo books them back where they were, with their job and status — only
  // when this desk could put them there: a turf or "No walk list" needs Map &
  // turfs.
  const remove = (c) => run(
    (cur) => ({ ...cur, crew: cur.crew.filter((x) => x.assignment_id !== c.assignment_id) }),
    () => action('shift.unassign', { id: c.assignment_id }),
    () => ({
      text: `${c.name} is off the shift`,
      undo: canMap || c.to === 'every'
        ? () => add({ ...c, id: c.person_id, roles: [], done: c.first_shift ? 0 : 1 }, c.to, c.job, c.status)
        : undefined,
    }),
  );
  const setJob = (c, job) => run(
    (cur) => ({ ...cur, crew: cur.crew.map((x) => (x.assignment_id === c.assignment_id ? { ...x, job } : x)) }),
    () => action('shift.place', { id: c.assignment_id, job }),
    () => ({ text: job ? `${c.name} — ${JOBS[job].toLowerCase()}` : `${c.name} — no job` }),
  );
  const setStatus = (c, status) => run(
    (cur) => ({
      ...cur,
      crew: status === 'no_show' ? cur.crew.filter((x) => x.assignment_id !== c.assignment_id)
        : cur.crew.map((x) => (x.assignment_id === c.assignment_id ? { ...x, status } : x)),
    }),
    () => action('shift.setStatus', { id: c.assignment_id, status }),
    () => ({ text: status === 'completed' ? `${c.name} is here` : `${c.name} — no-show` }),
  );
  // Everyone not placed yet, one turf at a time, fewest people first.
  const splitEvenly = async () => {
    const counts = new Map(turfs.map((t) => [t.id, crew.filter((c) => c.to === t.id).length]));
    setError(null);
    setBusy(true);
    let done = 0;
    try {
      for (const c of unplaced) {
        const [turfId] = [...counts.entries()].sort((a, b) => a[1] - b[1])[0];
        await action('shift.place', { id: c.assignment_id, to: turfId });
        counts.set(turfId, counts.get(turfId) + 1);
        done += 1;
      }
      setSay({ text: `${plural(done, 'person', 'people')} placed across ${plural(turfs.length, 'turf')}` });
    } catch (e) {
      setError(e.message);
      setSay({ text: `Stopped after ${done}: ${e.message}` });
    } finally {
      setBusy(false);
      settle();
    }
  };

  // ── Drag and drop, and the tap path ──
  const onDrop = (item, dropKey) => {
    setMenu(null);
    if (dropKey === 'tray') {
      if (item.from === 'crew') remove(item.c);
      return;
    }
    const to = toOf(dropKey);
    if (!to) return;
    if (to !== 'every' && !canMap) { setSay({ text: 'Moving walk lists needs Map & turfs' }); return; }
    if (item.from === 'tray') add(item.v, to);
    else if (item.c.to !== to && !(turfs.length === 1 && item.c.to === 'every' && to === turfs[0].id)) move(item.c, to);
  };
  const dnd = useDragDrop({ onDrop, enabled: online && !busy, same: sameItem });
  const picked = dnd.picked;

  if (crewQ.isPending) return <p className="muted cb-loading">Loading the crew…</p>;
  if (crewQ.isError) return <p className="error">{crewQ.error.message}</p>;

  const checkIn = new Date(shift.starts_at).getTime() - Date.now() < 12 * 3600e3;
  const trayItem = (v) => ({ id: `tray:${v.id}`, from: 'tray', name: v.name, v });
  const crewItem = (c) => ({ id: `crew:${c.assignment_id}`, from: 'crew', name: c.name, c });
  const hereLabel = () => (picked.from === 'tray' ? `Add ${firstName(picked.name)} here` : `Move ${firstName(picked.name)} here`);
  const canTake = (col) => picked && (col.to === 'every' || canMap)
    && (picked.from === 'tray' || !col.holds(picked.c));

  const card = (c) => {
    const item = crewItem(c);
    const open = menu === c.assignment_id;
    return (
      <li key={c.assignment_id} className="cb-card" data-job={c.job || undefined}>
        <button type="button" className="cb-card__main" {...dnd.itemProps(item)} disabled={!online || busy}
          aria-label={`${c.name}${c.job ? `, ${JOBS[c.job]}` : ''} — pick up to move`}>
          <span className="cb-card__name">{c.name}</span>
          <span className="cb-tags">
            {c.job && <span className={`chip cb-job cb-job--${c.job}`}>{JOBS[c.job]}</span>}
            {c.status === 'completed' && <span className="chip chip-ok">Here</span>}
            {c.status === 'confirmed' && <span className="chip chip-ok">Confirmed</span>}
            {c.first_shift && <span className="chip chip-warn">First shift</span>}
            {!c.signed_in && turfs.length > 0 && c.to !== 'none' && <span className="chip cb-nosign">No app sign-in</span>}
          </span>
        </button>
        <button type="button" className="cb-card__more" aria-expanded={open} aria-label={`More for ${c.name}`}
          onClick={() => setMenu(open ? null : c.assignment_id)} disabled={!online}>⋯</button>
        {open && (
          <div className="cb-menu" role="group" aria-label={c.name}>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setMenu(null); setJob(c, c.job === 'lead' ? null : 'lead'); }}>
              {c.job === 'lead' ? 'Not team lead' : 'Team lead'}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setMenu(null); setJob(c, c.job === 'driver' ? null : 'driver'); }}>
              {c.job === 'driver' ? 'Not driver' : 'Driver'}
            </button>
            {checkIn && c.status !== 'completed' && (
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setMenu(null); setStatus(c, 'completed'); }}>Here</button>
            )}
            {checkIn && (
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setMenu(null); setStatus(c, 'no_show'); }}>No-show</button>
            )}
            {c.phone && !noCalls(c) && <a className="btn btn-quiet" href={`tel:${c.phone}`}>Call</a>}
            {c.phone && <a className="btn btn-quiet" href={`sms:${c.phone}`}>Text</a>}
            <Link className="btn btn-quiet" to={`/people/${c.person_id}`}>Profile</Link>
            <button type="button" className="btn btn-quiet cb-menu__off" disabled={busy} onClick={() => { setMenu(null); remove(c); }}>
              Take off the shift
            </button>
          </div>
        )}
      </li>
    );
  };

  const trayCard = (v) => {
    const line = v.busy ? `Busy then: ${v.busy.title}, ${clockText(v.busy.starts_at, tz)}`
      : v.asked ? 'Asked to volunteer'
        : v.done ? `${plural(v.done, 'shift')} done${v.no_shows ? ` · ${plural(v.no_shows, 'no-show')}` : ''}`
          : 'New';
    return (
      <li key={v.id}>
        <button type="button" className="cb-person" data-busy={v.busy ? '' : undefined} data-asked={v.asked ? '' : undefined}
          {...dnd.itemProps(trayItem(v))} disabled={!online || busy}
          aria-label={`${v.name} — ${line} — pick up to add`}>
          <span className="cb-person__name">{v.name}</span>
          <span className="cb-person__line">
            {line}
            {v.roles.length > 0 && !v.busy && <span className="cb-person__roles"> · {v.roles.slice(0, 2).map(roleLabel).join(' · ')}{v.roles.length > 2 ? ` +${v.roles.length - 2}` : ''}</span>}
          </span>
        </button>
      </li>
    );
  };

  return (
    <section className="cb" aria-label="Crew board">
      <div className="cb-head">
        <h2 className="cb-title">Crew</h2>
        <span className="cb-count">
          {plural(crew.length, 'person', 'people')} on it
          {unplaced.length > 0 && ` · ${unplaced.length} not placed yet`}
        </span>
        {unplaced.length > 0 && canMap && (
          <button type="button" className="btn ops-tap cb-split" disabled={busy || !online} onClick={splitEvenly}>
            Split the rest evenly
          </button>
        )}
      </div>
      <p className="cb-help">
        {turfs.length
          ? 'Drag people onto a turf — or tap a name, then “Move here”.'
          : 'Drag volunteers in from the left — or tap a name, then “Add here”. Add turfs above to split the crew across walk lists.'}
        {!canMap && turfs.length > 0 && ' Moving walk lists needs Map & turfs.'}
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="cb-layout">
        <aside className="cb-tray" data-drop-key="tray" data-over={dnd.over('tray')} aria-label="Add people">
          <h3 className="cb-tray__title">Add people</h3>
          {picked?.from === 'crew' && (
            <button type="button" className="btn cb-here cb-here--off" onClick={() => dnd.dropPicked('tray')}>
              Take {firstName(picked.name)} off the shift
            </button>
          )}
          <input className="input cb-find" type="search" placeholder="Find a volunteer" aria-label="Find a volunteer"
            value={find} onChange={(e) => setFind(e.target.value)} />
          <div className="cb-filters">
            {roles.length > 0 && (
              <select className="input cb-role" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">Any role</option>
                {roles.map((r) => <option key={r.code} value={r.code}>{r.label} · {r.n}</option>)}
              </select>
            )}
            <label className="cb-free">
              <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> Free then
            </label>
          </div>
          {tray.length === 0 ? (
            <p className="cb-empty">No other volunteers yet. Someone with a volunteer role, a sign-in, or who asked to volunteer shows here.</p>
          ) : matching.length === 0 ? (
            <p className="cb-empty">Nobody matches.</p>
          ) : (
            <ul className="cb-tray__list">{shown.map(trayCard)}</ul>
          )}
          {matching.length > shown.length && <p className="cb-more">{matching.length - shown.length} more — search to find them</p>}
        </aside>

        <div className="cb-cols" data-n={columns.length}>
          {columns.map((col) => {
            const people = crew.filter(col.holds);
            return (
              <section key={col.key} className="cb-col" data-drop-key={col.key} data-over={dnd.over(col.key)}
                data-turf={col.turf ? '' : undefined} style={col.color ? { '--turf': col.color } : undefined}
                aria-label={`${col.title}, ${plural(people.length, 'person', 'people')}`}>
                <header className="cb-col__head">
                  <span className="cb-col__title">{col.title}</span>
                  <span className="cb-col__n">{people.length}</span>
                  {col.sub && <span className="cb-col__sub">{col.sub}</span>}
                </header>
                {canTake(col) && (
                  <button type="button" className="btn cb-here" onClick={() => dnd.dropPicked(col.key)}>{hereLabel()}</button>
                )}
                {people.length > 0 ? <ul className="cb-cards">{people.map(card)}</ul>
                  : <p className="cb-drop">{col.to === 'every' && turfs.length > 1 && crew.length > 0 ? 'Everyone is placed' : 'Drop people here'}</p>}
              </section>
            );
          })}
        </div>
      </div>

      {picked && (
        <div className="cb-hand" role="status">
          <span><b>{picked.name}</b> — {picked.from === 'tray' ? 'tap “Add here” on a column' : 'tap “Move here”, or take them off'}</span>
          <button type="button" className="btn btn-quiet cb-hand__btn" onClick={() => dnd.setPicked(null)}>Cancel</button>
        </div>
      )}
      <div className="cb-ghost" ref={dnd.ghostRef} hidden={!dnd.dragging} aria-hidden="true">{dnd.dragging?.name}</div>
      <p className="cb-live" aria-live="polite">{say?.text || ''}</p>
      {say && !picked && (
        <div className="toast ops-toast cb-toast" role="status" data-plain={say.undo ? undefined : ''}>
          <span>{say.text}</span>
          {say.undo && (
            <button type="button" className="btn" onClick={() => { const u = say.undo; setSay(null); u(); }}>Undo</button>
          )}
          <button type="button" className="btn btn-quiet" aria-label="Dismiss" onClick={() => setSay(null)}>✕</button>
        </div>
      )}
    </section>
  );
}
