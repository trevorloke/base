// The map inside the front page's map window (MapWindow.jsx), loaded only
// while it is open. A picture to glance at, never a second Map: it does not
// trap the page's scrolling (no dragging, zooming or keyboard), the whole
// of it is one link to the full Map, and a quiet "Open the map" sits at its
// corner.
//   window  the doors of the turfs the person walks, a small dot coloured
//           by the household's answer, and those turfs' outlines
//           (GET /map/doors?mine=1 — a lean read, kept on the phone)
//   band    every turf's outline in its own colour (GET /turfs?outline=1 —
//           names and shapes only, nobody read)
// Tiles: the Map's own look, never Google's billed ones (mapView.js
// frontTiles). Honest about the street map with one line under it (the
// Map's own tile check and notice probe — no switch, no Try again).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiGet } from '../api.js';
import { bandOf } from '@starbase/shared/scale';
import { phoneCopy, useKeepCopy } from './OfflineCache.js';
import { useOnline } from './NoSignal.jsx';
import { DEFAULT_TILES, SURREY, safeAttribution } from './tiles.js';
import { MARK, TILE_WAIT_MS, css, frontTiles, tileHealth, tileHost, turfColor } from '../pages/mapView.js';
import { MY_DOORS, readViewPref, tellServiceWorker, useBandTurfs } from '../pages/mapQueries.js';
import { askNotice } from '../pages/tileProbe.js';

const FIVE_MIN = 5 * 60_000;
const EMPTY = [];
const norm = (s) => String(s || '').trim().toLowerCase();
// A tile address as the map fills it ({r}: @2x on a sharp screen).
const drawnAs = (url) => String(url).replace(/\{r\}/g, L.Browser.retina ? '@2x' : '');
const ring = (poly) => (Array.isArray(poly) ? poly.map(([a, b]) => [Number(a), Number(b)]).filter((p) => p.every(Number.isFinite)) : []);

// One dot per door: the household's answer (any opposed → opposed; else any
// support → support; else any undecided → undecided), as the Map's pins.
function doorsOf(persons) {
  const byKey = new Map();
  for (const p of persons) {
    if (p.lat == null || p.lng == null) continue;
    const key = p.address ? `${norm(p.address)}|${norm(p.unit)}` : `@${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
    const d = byKey.get(key) || { lat: Number(p.lat), lng: Number(p.lng), bands: new Set() };
    d.bands.add(bandOf(p.rating) || 'unrated');
    byKey.set(key, d);
  }
  return [...byKey.values()].map((d) => ({
    lat: d.lat, lng: d.lng,
    band: ['opposed', 'support', 'undecided'].find((b) => d.bands.has(b)) || 'unrated',
  }));
}
const dotColor = (band) => css(band === 'unrated' ? MARK.unrated.light : MARK[band]);

export default function MapWindowMap({ me, band, turfId }) {
  const online = useOnline();
  const tilesQ = useQuery({
    queryKey: ['mapConfig'], queryFn: () => apiGet('/map/config'), staleTime: 10 * 60_000, retry: 1, ...phoneCopy(me, 'mapConfig'),
  });
  useKeepCopy(me, 'mapConfig', tilesQ);
  const baseTiles = tilesQ.data?.tiles || (tilesQ.isError || tilesQ.fetchStatus === 'paused' ? DEFAULT_TILES : null);
  const tiles = useMemo(
    () => frontTiles({ views: tilesQ.data?.views ?? EMPTY, baseTiles, savedPick: readViewPref() }),
    [tilesQ.data, baseTiles],
  );

  const doorsQ = useQuery({
    queryKey: MY_DOORS.key, queryFn: () => apiGet(MY_DOORS.path), staleTime: FIVE_MIN, enabled: !band, ...phoneCopy(me, MY_DOORS.copy),
  });
  useKeepCopy(me, MY_DOORS.copy, doorsQ);
  const turfsQ = useBandTurfs(me, band);
  const q = band ? turfsQ : doorsQ;
  const outlines = band ? (turfsQ.data?.turfs ?? EMPTY) : (doorsQ.data?.outlines ?? EMPTY);
  const doors = useMemo(() => (band ? EMPTY : doorsOf(doorsQ.data?.persons ?? EMPTY)), [band, doorsQ.data]);

  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const fitRef = useRef(() => {});
  const [street, setStreet] = useState({ down: false, why: null });

  // The map: made once, removed when the window folds or Today goes.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const map = L.map(el, {
      center: SURREY, zoom: 12, zoomSnap: 0.25, zoomControl: false, attributionControl: false,
      dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false,
    });
    const layers = { turfs: L.layerGroup().addTo(map), doors: L.layerGroup().addTo(map) };
    mapRef.current = map; layersRef.current = layers;
    // Leaflet measures 0 × 0 while the box is opening: measured again on
    // every change of size, and framed again.
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { map.invalidateSize(); fitRef.current(); });
      ro.observe(el);
    }
    return () => { ro?.disconnect(); map.remove(); mapRef.current = null; layersRef.current = null; };
  }, []);

  // What it draws, and where it looks (before the street map below, so
  // its first tiles are asked for where the map frames).
  useEffect(() => {
    const map = mapRef.current; const ly = layersRef.current;
    if (!map || !ly) return;
    ly.turfs.clearLayers(); ly.doors.clearLayers();
    for (const t of outlines) {
      const r = ring(t.polygon);
      if (r.length < 3) continue;
      const color = turfColor(t);
      L.polygon(r, { color, weight: 2, opacity: 0.95, fillColor: color, fillOpacity: 0.07, interactive: false }).addTo(ly.turfs);
    }
    for (const d of doors) {
      L.circleMarker([d.lat, d.lng], {
        radius: 4, color: 'rgb(255, 255, 255)', weight: 1, fillColor: dotColor(d.band), fillOpacity: 0.95, interactive: false,
      }).addTo(ly.doors);
    }
    // The turf "Start canvassing" points to: its doors, else its outline;
    // else every door (and outline) drawn. Nothing to frame on: the point
    // the Map itself opens on.
    const target = !band && turfId ? outlines.find((t) => t.id === turfId) : null;
    const tr = target ? ring(target.polygon) : [];
    const inTarget = tr.length >= 3 ? L.latLngBounds(tr) : null;
    const pts = inTarget ? doors.filter((d) => inTarget.contains([d.lat, d.lng])).map((d) => [d.lat, d.lng]) : [];
    const frame = pts.length ? pts : tr.length >= 3 ? tr
      : [...doors.map((d) => [d.lat, d.lng]), ...outlines.flatMap((t) => ring(t.polygon))];
    fitRef.current = () => {
      if (!frame.length) { map.setView(SURREY, 12, { animate: false }); return; }
      // "Open the map" sits over the bottom-right corner (48 px and its
      // gap): frame the doors above it, so none hides under the button.
      map.fitBounds(L.latLngBounds(frame), { paddingTopLeft: [16, 16], paddingBottomRight: [16, 64], maxZoom: 17, animate: false });
    };
    fitRef.current();
  }, [outlines, doors, band, turfId]);

  // The street map, and whether it is loading (the Map's own check). Only
  // once it knows where it looks (the doors or outlines are in, or the read
  // has failed or waits for a signal): streets for the whole city first
  // would be asked for and thrown away a moment later, on every visit.
  const tileUrl = tiles?.url;
  const tileMax = tiles?.maxZoom;
  const placed = Boolean(q.data) || q.isError || q.fetchStatus === 'paused';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileUrl || !placed) return undefined;
    if (tileHost(tileUrl) && !/openstreetmap\.org|cartocdn\.com/.test(tileHost(tileUrl))) tellServiceWorker(tileUrl);
    const layer = L.tileLayer(tileUrl, { maxZoom: tileMax || 19 });
    const health = tileHealth();
    let timer = null;
    let gone = false;
    let probed = false;
    const tell = () => { if (!gone) { const h = health.get(); setStreet({ down: h.down, why: h.why }); } };
    layer.on('loading', () => {
      health.batch(Date.now());
      clearTimeout(timer);
      timer = setTimeout(() => { health.late(Date.now()); tell(); }, TILE_WAIT_MS + 20);
    });
    layer.on('tileload', () => health.tile(true));
    layer.on('tileerror', () => health.tile(false));
    layer.on('load', () => {
      clearTimeout(timer); health.done(); tell();
      // Streets, or a provider's notice? Asked once per address per page
      // life, shared with the Map (tileProbe.js); never Google's /tiles/.
      if (probed || !health.get().loaded || navigator.onLine === false) return;
      probed = true;
      askNotice(drawnAs(tileUrl), map.getCenter(), tileMax).then((notice) => { if (notice === true && !gone) { health.notice(); tell(); } });
    });
    setStreet({ down: false, why: null });
    layer.addTo(map);
    return () => { gone = true; clearTimeout(timer); layer.remove(); };
  }, [tileUrl, tileMax, placed]);

  const to = band ? '/map' : turfId ? `/map?turf=${encodeURIComponent(turfId)}` : '/map';
  const failed = q.isError && !q.data;
  const note = !street.down ? null
    : !online ? (band ? 'No signal — the map is back when you are.' : 'No signal — the street map is back when you are. Your doors are all here.')
      : street.why === 'notice' ? 'The street map isn’t showing streets — open the map'
        : 'The street map isn’t loading — open the map';
  return (
    <>
      <div className={`mapwindow__frame${tiles?.shade ? ` mapwindow--${tiles.shade}` : ''}`} data-tiles={street.why || 'ok'}>
        <div ref={boxRef} className="mapwindow__canvas" />
        <Link to={to} className="mapwindow__link" aria-label="Open the map" tabIndex={-1} />
        {tiles?.attribution && (
          // The provider's credit (required), above the link so its own links work.
          <div className="mapwindow__credit" dangerouslySetInnerHTML={{ __html: safeAttribution(tiles.attribution) }} />
        )}
        <Link to={to} className="btn btn-quiet mapwindow__open">Open the map</Link>
        {failed ? (
          <p className="mapwindow__over" role="status">
            <span>Unavailable</span>
            <button type="button" className="btn btn-quiet mapwindow__retry" onClick={() => q.refetch()} disabled={q.isFetching}>Try again</button>
          </p>
        ) : !q.data ? (
          <p className="mapwindow__over" role="status">Loading…</p>
        ) : null}
      </div>
      {note && <p className="mapwindow__note" role="status" data-why={street.why || ''}>{note}</p>}
    </>
  );
}
