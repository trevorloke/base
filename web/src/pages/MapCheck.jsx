// The map's check, for managers (Show → Map check). A map can look empty for
// reasons that have nothing to do with each other — people never placed, a
// placing run that stopped, a list that mostly lives somewhere else, a
// street map that isn't answering, a page older than the server, a map with
// no room on screen. One sheet says which: GET /api/map/check (ext/mapcheck)
// and what only this page knows, as lines (mapView.js checkLines — tested
// there), the one that applies flagged. A screenshot of it is enough to tell
// which trouble a manager is looking at. Whether the services behind the
// map answer (Google's tiles, address lookup) is asked apart — it waits on
// them, up to 8 s — so the other lines never wait for it.
//   facts()  what the page knows now: { build, look, tilesFrom, tiles, size, zoom, picture }
//   onAgain()  Check again, on the page: the street map asked afresh
// Under the Street map line, the tile under the map's middle as this phone
// gets it (an image, never read as markup): "API KEY REQUIRED", a block
// notice or real streets can be read straight off a screenshot.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { clockText } from '../offline.js';
import { checkLines, timeOfDay } from './mapView.js';
import './mapservices.css';
import './mapcheckpic.css';

function TilePicture({ picture }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [picture.src]);
  if (picture.small) {
    return failed ? null : (
      <span className="map-check__picture map-check__picture--small">
        <img src={picture.src} alt={picture.alt} title={picture.label} width="36" height="36" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <dd className="map-check__picture">
      <span>{picture.label}</span>
      {failed ? <span className="map-check__nopic">{picture.failed}</span>
        : <img src={picture.src} alt={picture.alt} width="128" height="128" onError={() => setFailed(true)} />}
    </dd>
  );
}

export default function MapCheck({ facts, onClose, onAgain }) {
  // Asked for each time the sheet opens: a check is about now.
  const q = useQuery({ queryKey: ['mapCheck'], queryFn: () => apiGet('/map/check'), staleTime: 0, gcTime: 0, retry: 1 });
  const sq = useQuery({ queryKey: ['mapCheckServices'], queryFn: () => apiGet('/map/check/services'), staleTime: 0, gcTime: 0, retry: 0 });
  const services = sq.data && !sq.isFetching ? { state: 'ok', data: sq.data }
    : sq.fetchStatus === 'paused' ? { state: 'offline' }
      : sq.isError && !sq.isFetching ? { state: 'error' } : { state: 'pending' };
  const again = () => { q.refetch(); sq.refetch(); onAgain?.(); };
  // The page's own facts move under the sheet (tiles arrive, the map is
  // dragged): looked at again every second.
  const [page, setPage] = useState(facts);
  useEffect(() => {
    setPage(facts());
    const t = setInterval(() => setPage(facts()), 1000);
    return () => clearInterval(t);
  }, [facts]);
  // The lines that apply come first: a screenshot must show the trouble,
  // and on a phone the whole check can be taller than the screen.
  const all = q.data ? checkLines(q.data, page, { clock: timeOfDay, services }) : null;
  const lines = all && [...all.filter((l) => l.warn), ...all.filter((l) => !l.warn)];

  return (
    <aside className="map-sheet map-check" aria-label="Map check">
      <header className="mapsheet-head">
        <h2 className="mapsheet-title">Map check</h2>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close the map check" autoFocus>✕</button>
      </header>
      <div className="map-check__body">
        <p className="map-check__lead">A screenshot of this sheet shows what’s wrong.</p>
        {lines ? (
          <>
            <dl className="map-check__list">
              {lines.map((l) => (
                <div key={l.key} data-key={l.key} className={`map-check__row${l.warn ? ' is-warn' : ''}`}>
                  <dt>{l.warn && <span className="map-check__flag" role="img" aria-label="Look here">!</span>}<span>{l.label}</span></dt>
                  <dd className="map-check__value">{l.picture?.small && <TilePicture picture={l.picture} />}{l.value}</dd>
                  {l.note && <dd className="map-check__note">{l.note}</dd>}
                  {l.picture && !l.picture.small && <TilePicture picture={l.picture} />}
                </div>
              ))}
            </dl>
            <p className="map-check__when" role="status">
              {q.isFetching || sq.isFetching ? 'Checking…' : `Checked ${clockText(q.dataUpdatedAt)}`}
              <button type="button" className="btn btn-quiet map-check__again" onClick={again} disabled={q.isFetching || sq.isFetching}>Check again</button>
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
