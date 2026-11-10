// The small map a place is picked on (ScheduleWhere.jsx): tap a point and
// it is marked; the server then names it. Loaded only when someone opens
// "Pick on the map" — the map library stays out of the Shifts screen itself.
//
//   around   [[lat, lng], …] to open on (the campaign's turfs and saved
//            places); with none, the city
//   point    { lat, lng } | null — the point picked
//   onPoint  called with the point tapped — or, from "Use the middle of the
//            map", the middle: a pick without a pointer (pan with the arrow
//            keys)
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { SURREY_BOUNDS, safeAttribution } from '../components/tiles.js';

export default function PlaceMap({ tiles, around = [], point, onPoint }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const pinRef = useRef(null);
  const pickRef = useRef(onPoint);
  pickRef.current = onPoint;

  useEffect(() => {
    const el = boxRef.current;
    if (!el || mapRef.current) return undefined;
    const map = L.map(el, { zoomControl: true, attributionControl: true, zoomSnap: 0.25 });
    if (around.length > 1) map.fitBounds(around, { padding: [24, 24], maxZoom: 15, animate: false });
    else if (around.length === 1) map.setView(around[0], 15, { animate: false });
    else map.fitBounds(SURREY_BOUNDS, { padding: [8, 8], animate: false });
    map.on('click', (e) => pickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }));
    mapRef.current = map;
    // The sheet slides in and the map's box settles after it is made.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); map.remove(); mapRef.current = null; pinRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tiles?.url) return undefined;
    const layer = L.tileLayer(tiles.url, { maxZoom: tiles.maxZoom || 19, attribution: safeAttribution(tiles.attribution) }).addTo(map);
    return () => { layer.remove(); };
  }, [tiles?.url, tiles?.maxZoom, tiles?.attribution]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pinRef.current?.remove();
    pinRef.current = point
      ? L.circleMarker([point.lat, point.lng], { radius: 9, weight: 3, fillOpacity: 0.9, className: 'sch-pin', interactive: false }).addTo(map)
      : null;
  }, [point?.lat, point?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const useMiddle = () => {
    const c = mapRef.current?.getCenter();
    if (c) onPoint({ lat: c.lat, lng: c.lng });
  };

  return (
    <div className="sch-map">
      <div ref={boxRef} className="sch-map__box" role="application" aria-label="Map — tap where the shift is" />
      <button type="button" className="btn btn-quiet sch-map__mid" onClick={useMiddle}>Use the middle of the map</button>
    </div>
  );
}
