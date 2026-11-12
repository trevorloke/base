// Shifts → Week: the people to put on shifts (GET /shifts/board → people) —
// everyone holding a volunteer role or a volunteer sign-in, who asked to
// volunteer (the website's form among the ways) or who has been on a shift.
//
// At a desk it is a strip across the top of the week, so the seven days
// keep the whole width: find by name, filter by role, then every name. Tap
// (or Enter on) a name and it stays in hand while you tap as many shifts as
// you like; or drag it onto a card. A chip dragged back here comes off its
// shift.
// On a phone it is a button, "People", that opens a sheet with the same
// list: tap a name and the sheet goes, the name stays in hand over the week.
//
//   people     the tray as the server sent it: [{ id, name, roles, asked }]
//   loaded     the week's read is in (until then nothing says "No volunteers")
//   weekCount  Map person id → their shifts this week
//   inHand     the person id in hand, picked here (not a chip off a card)
//   props      (item) → what makes a name tappable and draggable (ShiftsBoard)
//   onTap      (item) → a name tapped in the phone's sheet
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { apiGet } from '../api.js';
import Sheet from './ScheduleSheet.jsx';

const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label ?? code;

export default function People({
  narrow, people, loaded, weekCount, inHand = null, taking = false, hot, online, open, onOpen, props, onTap,
}) {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const rolesHere = useMemo(() => {
    const set = new Set(people.flatMap((p) => p.roles || []));
    return VOLUNTEER_ROLES.filter((r) => set.has(r.code));
  }, [people]);
  const needle = q.trim().toLowerCase();
  const tray = people.filter((p) => (!role || (p.roles || []).includes(role)) && (!needle || p.name.toLowerCase().includes(needle)));
  // Typing a name that isn't a volunteer yet: anyone on the list, like the
  // shift screen's "+ Add volunteer".
  const others = useQuery({
    queryKey: ['persons', 'search', needle],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(needle)}&limit=8`),
    enabled: needle.length >= 2,
    placeholderData: keepPreviousData,
  });
  const trayIds = new Set(people.map((p) => p.id));
  const extra = needle.length >= 2 ? (others.data?.persons ?? []).filter((p) => !trayIds.has(p.id)).slice(0, 8) : [];

  const find = (
    <div className="sb-tray__find">
      <input className="input sb-search" type="search" placeholder="Find a volunteer" aria-label="Find a volunteer"
        value={q} onChange={(e) => setQ(e.target.value)} />
      {rolesHere.length > 0 && (
        <select className="input sb-role" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Any role</option>
          {rolesHere.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      )}
    </div>
  );
  const none = loaded && tray.length === 0 && extra.length === 0 && (
    <p className="ops-meta sb-tray__none">
      {people.length === 0 && !needle ? <>No volunteers yet. <Link to="/people">Add roles in People</Link></> : 'No one matches.'}
    </p>
  );
  // In the phone's sheet a name is only tapped (the sheet covers the week,
  // so there is nowhere to drag it to).
  const person = (p, isExtra = false) => {
    const item = { person: { id: p.id, name: p.name } };
    const n = weekCount.get(p.id) || 0;
    const how = narrow
      ? { onClick: () => onTap(item), 'aria-pressed': inHand === p.id, disabled: !online }
      : props(item);
    return (
      <li key={p.id}>
        <button type="button" className="sb-person" data-extra={isExtra ? '' : undefined} {...how}
          title={(p.roles || []).map(roleLabel).join(', ') || undefined}>
          <span className="sb-person__name">{p.name}</span>
          {p.asked && <span className="sb-person__asked">{narrow ? 'Asked to volunteer' : 'Asked'}</span>}
          {n > 0 && <span className="sb-person__n" aria-label={`${n} this week`}>{n}</span>}
        </button>
      </li>
    );
  };
  const list = (
    <ul className="sb-people">
      {tray.map((p) => person(p))}
      {extra.map((p) => person(p, true))}
    </ul>
  );

  if (narrow) {
    return (
      <>
        <button type="button" className="btn ops-tap sch-peoplebtn" disabled={!online} aria-haspopup="dialog" onClick={() => onOpen(true)}>
          People{loaded && people.length ? ` · ${people.length.toLocaleString('en-CA')}` : ''}
        </button>
        {open && (
          <Sheet title="People" sub="Tap a name, then each shift" onClose={() => onOpen(false)}>
            <div className="sb-tray sch-peoplesheet" aria-label="People">
              {find}
              {none}
              {list}
            </div>
          </Sheet>
        )}
      </>
    );
  }
  return (
    <aside className="sb-tray" data-drop="tray" data-hot={hot('tray')} aria-label="People">
      {find}
      {taking && <p className="sb-tray__drop">Drop here to take off the shift</p>}
      {none}
      {list}
    </aside>
  );
}
