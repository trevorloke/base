// A shift's turfs — the walk lists it is for (server/ext/shiftturfs).
//
//   useShiftTurfs(me, { side })  → { byShift: { [shift_id]: [{ id, name, color }] }, ready, failed }
//                                GET /shiftturfs, any role; kept on the phone
//                                (OfflineCache) so the Shifts list and a shift
//                                opened with no signal still name their turfs.
//                                ready: the answer is in; failed: it couldn't
//                                be read (and nothing is kept).
//                                side: the screen only reads a line of it (a
//                                shift, the week board) — its time isn't the
//                                screen's (KeptCopies.js useKeptTime)
//   <TurfPicker value onChange/>  the campaign's turfs as chips to tick (desk
//                                only: it reads GET /turfs)
//   <TurfChips turfs/>         small chips, one per turf, in the turf's colour
//   turfNames(list)            'Newton block, 72 Ave east'
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { phoneCopy, useKeepCopy } from './OfflineCache.js';
import './shiftturfs.css';

export const turfNames = (list) => (Array.isArray(list) ? list.map((t) => t.name).filter(Boolean).join(', ') : '');

const NO_TURFS = {};
export function useShiftTurfs(me, { side = false } = {}) {
  const q = useQuery({
    queryKey: ['shiftturfs'],
    queryFn: () => apiGet('/shiftturfs'),
    staleTime: 60_000,
    ...phoneCopy(me, 'shiftturfs'),
    ...(side ? { meta: { side: true } } : {}),
  });
  useKeepCopy(me, 'shiftturfs', q);
  return { byShift: q.data?.shifts ?? NO_TURFS, ready: q.data !== undefined, failed: q.isError && q.data === undefined };
}

// Tap a turf to add it, tap again to take it off. Picked ones get an ink
// ring and a check — never yellow (that is the screen's one main button).
export function TurfPicker({ value = [], onChange, disabled = false, id }) {
  const turfs = useQuery({ queryKey: ['turfs'], queryFn: () => apiGet('/turfs') });
  const list = turfs.data?.turfs ?? [];
  const picked = new Set(value);
  const toggle = (turfId) => onChange(picked.has(turfId) ? value.filter((v) => v !== turfId) : [...value, turfId]);
  if (turfs.isPending) return <p className="st-note">{turfs.fetchStatus === 'paused' ? 'Turfs load with signal' : 'Loading turfs…'}</p>;
  if (turfs.isError) return <p className="error">{turfs.error.message}</p>;
  if (list.length === 0) return <p className="st-note">No turfs yet — <Link to="/map">draw one on the map</Link>.</p>;
  return (
    <div className="st-pick" role="group" id={id} aria-label="Turfs">
      {list.map((t) => {
        const on = picked.has(t.id);
        return (
          <button key={t.id} type="button" className="st-opt" aria-pressed={on} disabled={disabled} onClick={() => toggle(t.id)}>
            <span className="st-dot" style={t.color ? { background: t.color } : undefined} aria-hidden="true" />
            <span className="st-opt__name">{t.name}</span>
            {on && <span className="st-opt__check" aria-hidden="true">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TurfChips({ turfs, label = 'Turfs', card = false }) {
  if (!Array.isArray(turfs) || turfs.length === 0) return null;
  return (
    <ul className={`st-chips${card ? ' st-chips--card' : ''}`} aria-label={label}>
      {turfs.map((t) => (
        <li key={t.id} className="st-chip" title={t.name}>
          <span className="st-dot" style={t.color ? { background: t.color } : undefined} aria-hidden="true" />
          <span className="st-chip__name">{t.name}</span>
        </li>
      ))}
    </ul>
  );
}
