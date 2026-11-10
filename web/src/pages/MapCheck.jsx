// The map's check, for managers (Show → Map check). A map can look empty for
// reasons that have nothing to do with each other — people never placed, a
// placing run that stopped, a list that mostly lives somewhere else, a
// street map that isn't answering, a page older than the server, a map with
// no room on screen. One sheet says which: GET /api/map/check (ext/mapcheck)
// and what only this page knows, as lines (mapView.js checkLines — tested
// there), the one that applies flagged. A screenshot of it is enough to tell
// which trouble a manager is looking at.
//   facts()  what the page knows now: { build, look, tilesFrom, tiles, size, zoom }
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { clockText } from '../offline.js';
import { checkLines, timeOfDay } from './mapView.js';

export default function MapCheck({ facts, onClose }) {
  // Asked for each time the sheet opens: a check is about now.
  const q = useQuery({ queryKey: ['mapCheck'], queryFn: () => apiGet('/map/check'), staleTime: 0, gcTime: 0, retry: 1 });
  // The page's own facts move under the sheet (tiles arrive, the map is
  // dragged): looked at again every second.
  const [page, setPage] = useState(facts);
  useEffect(() => {
    setPage(facts());
    const t = setInterval(() => setPage(facts()), 1000);
    return () => clearInterval(t);
  }, [facts]);
  const lines = q.data ? checkLines(q.data, page, { clock: timeOfDay }) : null;

  return (
    <aside className="map-sheet map-check" aria-label="Map check">
      <header className="mapsheet-head">
        <h2 className="mapsheet-title">Map check</h2>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close the map check" autoFocus>✕</button>
      </header>
      <div className="map-check__body">
        <p className="map-check__lead">What this map is drawn from. A screenshot of it shows what’s wrong.</p>
        {lines ? (
          <>
            <dl className="map-check__list">
              {lines.map((l) => (
                <div key={l.key} data-key={l.key} className={`map-check__row${l.warn ? ' is-warn' : ''}`}>
                  <dt>{l.warn && <span className="map-check__flag" role="img" aria-label="Look here">!</span>}{l.label}</dt>
                  <dd className="map-check__value">{l.value}</dd>
                  {l.note && <dd className="map-check__note">{l.note}</dd>}
                </div>
              ))}
            </dl>
            <p className="map-check__when" role="status">
              {q.isFetching ? 'Checking…' : `Checked ${clockText(q.dataUpdatedAt)}`}
              <button type="button" className="btn btn-quiet map-check__again" onClick={() => q.refetch()} disabled={q.isFetching}>Check again</button>
            </p>
          </>
        ) : q.isError ? (
          <button type="button" className="btn map-check__retry" onClick={() => q.refetch()}>Unavailable — Try again</button>
        ) : (
          <p className="map-check__wait" role="status">{q.fetchStatus === 'paused' ? 'No signal — the check needs it' : 'Loading…'}</p>
        )}
      </div>
    </aside>
  );
}
