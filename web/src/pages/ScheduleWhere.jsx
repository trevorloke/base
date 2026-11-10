// "Where", by tap (server/ext/schedule). In this order:
//   - for a canvass or a lit drop, the campaign's turfs: the turf IS the
//     place — one tap gives the shift its walk list and its name;
//   - the places this kind of shift used before, most used first, then the
//     other saved places and the words already on shifts (GET /places);
//   - "Pick on the map": tap a point on a small map, the server suggests a
//     name ("King George Blvd & 88 Ave"), one tap accepts it. Renaming is
//     the only typing, and nobody has to.
//
//   value   { turfs: [{ id, name }], place: null | { id, name }, words: null | '…' }
//   whereInput(value)        → what shift.createMany takes for it
//   wherePatch(before, now)  → what shift.update takes for the change
//   whereName(value)         → the words the shift will show
import { Suspense, lazy, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { DEFAULT_TILES } from '../components/tiles.js';
import { Unavailable } from './ScheduleSheet.jsx';

// The map is its own download, fetched when someone opens it. One that
// doesn't arrive (a weak signal) says so and never takes the sheet down
// with it. A browser won't fetch a failed download again on the same page,
// so trying again is a reload: the week and the day stay (they are in the
// address), the sheet's other choices are made again.
const MapFailed = () => (
  <p className="sch-unavailable" role="alert">
    <span>The map didn’t load</span>
    <button type="button" className="btn ops-tap" onClick={() => window.location.reload()}>Reload</button>
  </p>
);
const PlaceMap = lazy(() => import('./SchedulePlaceMap.jsx').catch(() => ({ default: MapFailed })));
// Chips shown before "More places".
const FIRST = 8;
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const ids = (list) => list.map((t) => t.id);
const sameIds = (a, b) => a.length === b.length && a.every((t) => b.some((x) => x.id === t.id));

export const NOWHERE = { turfs: [], place: null, words: null };

export const whereInput = (v) => ({
  ...(v.place ? { place_id: v.place.id } : v.words ? { location: v.words } : {}),
  ...(v.turfs.length ? { turf_ids: ids(v.turfs) } : {}),
});

// A saved place's name becomes the words; words alone leave a saved place
// behind; with neither, the turfs are the place — as shift.update reads them.
export const wherePatch = (before, now) => {
  const turfs = !sameIds(before.turfs, now.turfs);
  const place = (before.place?.id || null) !== (now.place?.id || null) || !same(before.words, now.words);
  if (!turfs && !place) return {};
  if (now.place) return { place_id: now.place.id, ...(turfs ? { turf_ids: ids(now.turfs) } : {}) };
  if (now.words) return { location: now.words, ...(turfs ? { turf_ids: ids(now.turfs) } : {}) };
  if (now.turfs.length) return { turf_ids: ids(now.turfs) };
  return { location: null, ...(before.place ? { place_id: null } : {}), ...(turfs ? { turf_ids: [] } : {}) };
};

export const whereName = (v) => v.place?.name || v.words || v.turfs.map((t) => t.name).join(', ') || null;

// The map, the name the server gives the point, and one tap to take it.
function MapPick({ around, ready, onPlace, onClose }) {
  const queryClient = useQueryClient();
  const tilesQ = useQuery({ queryKey: ['mapConfig'], queryFn: () => apiGet('/map/config'), staleTime: 10 * 60_000, retry: 1 });
  const tiles = tilesQ.data?.tiles || (tilesQ.isError ? DEFAULT_TILES : null);
  const [point, setPoint] = useState(null);
  // { state: 'naming' | 'named' | 'failed', name, address }
  const [named, setNamed] = useState(null);
  const [typed, setTyped] = useState(null); // a name being typed instead, when someone wants one
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const asked = useRef(0);

  const nameIt = async (p) => {
    const mine = ++asked.current;
    setPoint(p);
    setTyped(null);
    setError(null);
    setNamed({ state: 'naming' });
    try {
      const r = await apiGet(`/places/name?lat=${p.lat.toFixed(6)}&lng=${p.lng.toFixed(6)}`);
      // A second tap while the first was being named: only the last counts.
      if (mine === asked.current) setNamed({ state: 'named', name: r.name, address: r.address || null });
    } catch {
      if (mine === asked.current) setNamed({ state: 'failed' });
    }
  };
  const save = async () => {
    const name = (typed ?? named?.name ?? '').trim();
    if (!name || !point) return;
    setBusy(true);
    setError(null);
    try {
      const res = await action('place.save', {
        name, lat: point.lat, lng: point.lng, source: 'map', ...(named?.address ? { address: named.address } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ['places'] });
      onPlace({ id: res.place.id, name: res.place.name });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="sch-pick" role="group" aria-label="Pick on the map">
      {/* It opens once, on what it is given: so not before the turfs are in. */}
      {ready ? (
        <Suspense fallback={<p className="sch-note" role="status">Loading the map…</p>}>
          <PlaceMap tiles={tiles} around={around} point={point} onPoint={nameIt} />
        </Suspense>
      ) : <p className="sch-note" role="status">Loading the map…</p>}
      <div className="sch-named" role="status">
        {named?.state === 'naming' && <span className="sch-note">Finding a name…</span>}
        {named?.state === 'failed' && <Unavailable what="A name" onRetry={() => nameIt(point)} />}
        {named?.state === 'named' && typed === null && <b className="sch-named__name">{named.name}</b>}
      </div>
      {named?.state === 'named' && typed !== null && (
        <div className="field sch-rename">
          <label htmlFor="sch-place-name">Name</label>
          <input id="sch-place-name" className="input" autoFocus maxLength={200} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        {named?.state === 'named' && (
          <button type="button" className="btn ops-solid ops-tap" disabled={busy || !(typed ?? named.name).trim()} onClick={save}>
            {busy ? 'Saving…' : 'Use this place'}
          </button>
        )}
        {named?.state === 'named' && typed === null && (
          <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setTyped(named.name)}>Rename</button>
        )}
        <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

export default function Where({ kind, value, onChange, canMap }) {
  const withTurfs = Boolean(kind.turfs && canMap);
  const places = useQuery({ queryKey: ['places', kind.code], queryFn: () => apiGet(`/places?kind=${kind.code}`), staleTime: 30_000 });
  const [all, setAll] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  // The turfs: chips for a kind that walks them — and, for any kind, where the map opens.
  const turfsQ = useQuery({ queryKey: ['turfs'], queryFn: () => apiGet('/turfs'), enabled: withTurfs || (mapOpen && canMap) });

  const allTurfs = turfsQ.data?.turfs ?? [];
  const turfs = withTurfs ? allTurfs : [];
  const saved = places.data?.places ?? [];
  const words = (places.data?.words ?? []).filter((w) => !saved.some((p) => same(p.name, w.name)));
  // One list of chips, in the server's order; what is chosen is always among
  // them (a place saved a moment ago, a shift's own words).
  const list = [...saved.map((p) => ({ key: p.id, place: p })), ...words.map((w) => ({ key: `w:${w.name}`, words: w.name }))];
  if (value.place && !saved.some((p) => p.id === value.place.id)) list.unshift({ key: value.place.id, place: value.place });
  if (value.words && !words.some((w) => same(w.name, value.words))) list.unshift({ key: `w:${value.words}`, words: value.words });
  const chosen = (c) => (c.place ? value.place?.id === c.place.id : same(value.words, c.words));
  const shown = all ? list : list.filter((c, i) => i < FIRST || chosen(c));

  const onTurf = (t) => value.turfs.some((x) => x.id === t.id);
  const toggleTurf = (t) => onChange({
    ...value, turfs: onTurf(t) ? value.turfs.filter((x) => x.id !== t.id) : [...value.turfs, { id: t.id, name: t.name }],
  });
  const pick = (c) => onChange({
    ...value,
    place: c.place && !chosen(c) ? { id: c.place.id, name: c.place.name } : null,
    words: c.words && !chosen(c) ? c.words : null,
  });
  // The map opens on the campaign's own ground: its turfs and pinned places.
  const around = [
    ...allTurfs.flatMap((t) => (t.polygon || []).map(([a, b]) => [Number(a), Number(b)])),
    ...saved.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lat, p.lng]),
  ].filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));

  return (
    <div className="sch-where">
      {withTurfs && turfsQ.isPending && <p className="sch-note" role="status">Loading turfs…</p>}
      {withTurfs && turfsQ.isError && <Unavailable what="Turfs" onRetry={() => turfsQ.refetch()} />}
      {withTurfs && turfs.length > 0 && (
        <div className="sch-chips" role="group" aria-label="Turfs">
          {turfs.map((t) => (
            <button key={t.id} type="button" className="sch-chip" aria-pressed={onTurf(t)} onClick={() => toggleTurf(t)}>
              <span className="st-dot" style={t.color ? { background: t.color } : undefined} aria-hidden="true" />
              <span className="sch-chip__words">{t.name}</span>
            </button>
          ))}
        </div>
      )}
      {places.isPending && <p className="sch-note" role="status">Loading places…</p>}
      {places.isError && <Unavailable what="Places" onRetry={() => places.refetch()} />}
      <div className="sch-chips" role="group" aria-label="Places">
        {shown.map((c) => (
          <button key={c.key} type="button" className="sch-chip" aria-pressed={chosen(c)} onClick={() => pick(c)}>
            <span className="sch-chip__words">{c.place ? c.place.name : c.words}</span>
          </button>
        ))}
        {!all && list.length > shown.length && (
          <button type="button" className="sch-chip sch-chip--quiet" onClick={() => setAll(true)}>More places · {list.length - shown.length}</button>
        )}
        {!mapOpen && (
          <button type="button" className="sch-chip sch-chip--quiet" aria-expanded={false} onClick={() => setMapOpen(true)}>
            <svg className="sk-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" />
            </svg>
            Pick on the map
          </button>
        )}
      </div>
      {mapOpen && (
        <MapPick around={around} ready={!canMap || !turfsQ.isPending} onClose={() => setMapOpen(false)}
          onPlace={(place) => { onChange({ ...value, place, words: null }); setMapOpen(false); }} />
      )}
    </div>
  );
}
