// A small person picker: a box with a dropdown (Shifts' "+ Add volunteer",
// Signs' supporter, Money's donor).
//
//   <PersonPicker id onPick roleHint excludeIds excludeLabel allowCreate
//     placeholder disabled autoFocus />
//
// The dropdown is PersonResults over usePersonSearch: everyone the server
// finds, A–Z by last name, 8 at a time with a "Show more" button (a dropdown
// never loads by itself), and the count. With roleHint it starts with one
// page of people holding that role, under "Has this role: Driver". Someone
// in excludeIds is shown, greyed, as excludeLabel. "+ Add new person “…”"
// sits under the list, so it stays one tap away however far it's paged.
import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { action } from '../api.js';
import { usePersonSearch } from './usePersonSearch.js';
import PersonResults from './PersonResults.jsx';

const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label ?? code;
const PAGE = 8;

export function PersonPicker({
  id,
  onPick,
  roleHint = null,
  excludeIds = [],
  excludeLabel = 'already added',
  allowCreate = true,
  placeholder = 'Start typing a name…',
  disabled = false,
  autoFocus = false,
}) {
  const queryClient = useQueryClient();
  const { me } = useOutletContext() ?? {};
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const wrapRef = useRef(null);
  const boxRef = useRef(null);

  const general = usePersonSearch(q, { limit: PAGE, enabled: open });
  const holders = usePersonSearch(q, { limit: PAGE, role: roleHint, enabled: open && Boolean(roleHint) });
  // Both answers for what's typed before anything can be picked (the role
  // block is a help: if it fails, everyone is still listed under it).
  const holdersOff = holders.status === 'error';
  const search = roleHint ? { ...general, fresh: general.fresh && (holders.fresh || holdersOff) } : general;
  const lead = roleHint && !holdersOff && holders.rows.length
    ? { heading: `Has this role: ${roleLabel(roleHint)}`, rows: holders.rows.slice(0, PAGE), chip: roleLabel(roleHint) }
    : null;

  useEffect(() => {
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const typed = q.trim();
  const shown = [...(lead?.rows || []), ...general.rows];
  const canCreate = allowCreate && typed.length > 0 && !busy
    && !shown.some((p) => String(p.name || '').toLowerCase() === typed.toLowerCase());

  const choose = async (person) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onPick?.(person);
      setQ('');
      setOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!canCreate) return;
    setError(null);
    setBusy(true);
    try {
      const res = await action('person.create', { name: typed.slice(0, 300) });
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      queryClient.invalidateQueries({ queryKey: ['brief'] });
      setBusy(false);
      await choose(res.person);
    } catch (e) {
      setError(e.message); // the typed name stays, so they can try again
      setBusy(false);
    }
  };

  const footer = canCreate ? (
    <button type="button" className="btn btn-quiet ps-create" onClick={create}>+ Add new person “{typed}”</button>
  ) : null;
  const taken = new Set(excludeIds);

  return (
    <div className="picker ops-picker" ref={wrapRef}
      onKeyDown={(e) => { if (e.key === 'Escape' && e.target === boxRef.current) setOpen(false); }}>
      <input
        id={id}
        ref={boxRef}
        className="input"
        type="search"
        aria-expanded={open}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={q}
        disabled={disabled || busy}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && (typed.length >= 2 || footer) && (
        <div className="ps-drop">
          <PersonResults search={search} boxRef={boxRef} onPick={choose} taken={taken} takenLabel={excludeLabel}
            desk={Boolean(me?.role) && me.role !== 'volunteer'} autoMore={false} lead={lead} footer={footer}
            onNone={canCreate ? create : null} />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export default PersonPicker;
