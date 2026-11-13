// The front page's map, in one of two shapes:
//   shape="window"  field Today, under the one big button: the doors and
//                   outlines of the turfs the person walks
//   shape="band"    desk Today, the page's full width under the numbers:
//                   every turf's outline, nothing else
// One row, always there and cheap: "Map", a short meta, a chevron. Tapping
// it folds or opens the map in place; open or folded is kept per browser
// (open the first time). The map itself (MapWindowMap.jsx, with Leaflet) is
// loaded only while open, so a browser that keeps it folded never downloads
// Leaflet on Today — and if that load fails (no service worker yet, an old
// chunk gone after a deploy), only this box says so: Today stays.
import { Component, Suspense, lazy, useId, useState } from 'react';
import { NS } from '../base.js';
import { useBandTurfs } from '../pages/mapQueries.js';
import './mapwindow.css';

const readOpen = (key) => { try { return localStorage.getItem(key) !== 'closed'; } catch { return true; } };
const writeOpen = (key, open) => { try { localStorage.setItem(key, open ? 'open' : 'closed'); } catch { /* storage blocked */ } };
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');

const Inner = lazy(() => import('./MapWindowMap.jsx'));

// A chunk that failed to load: said in the box, with a way to try again.
// Try again loads the page afresh: Chrome remembers a failed import() for
// the page's life, so asking again in place fails again (a new lazy() did).
class ChunkBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="mapwindow__fail" role="status">
        <span>Unavailable</span>
        <button type="button" className="btn btn-quiet mapwindow__retry" onClick={this.props.onRetry}>Try again</button>
      </p>
    );
  }
}

function BandMeta({ me }) {
  const q = useBandTurfs(me);
  if (q.data) {
    const n = (q.data.turfs ?? []).length;
    return n ? `${num(n)} ${n === 1 ? 'walk list' : 'walk lists'}` : 'No walk lists yet';
  }
  return q.isError ? 'Unavailable' : 'Loading…';
}

export default function MapWindow({ me, shape = 'window', turfId = null, meta = null }) {
  const band = shape === 'band';
  const key = `${NS}today:${band ? 'band' : 'map'}`;
  const [open, setOpen] = useState(() => readOpen(key));
  const bodyId = useId();
  const flip = () => { setOpen((o) => { writeOpen(key, !o); return !o; }); };
  return (
    <section className={`mapwindow mapwindow--${band ? 'band' : 'window'}`} aria-label="Map">
      <button type="button" className="mapwindow__toggle" aria-expanded={open} aria-controls={bodyId} onClick={flip}>
        <strong>Map</strong>
        <span className="mapwindow__meta">{band ? <BandMeta me={me} /> : meta}</span>
        <svg className="mapwindow__chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div id={bodyId} className="mapwindow__body" hidden={!open}>
        {open && (
          <ChunkBoundary onRetry={() => window.location.reload()}>
            <Suspense fallback={<p className="mapwindow__wait" role="status">Loading the map…</p>}>
              <Inner me={me} band={band} turfId={turfId} />
            </Suspense>
          </ChunkBoundary>
        )}
      </div>
    </section>
  );
}
