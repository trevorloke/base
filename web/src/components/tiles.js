// The map's tiles (GET /api/map/config), shared by the canvass map and the
// dashboard's field-tracking map — and where a map opens before it has
// anything of the campaign's to frame.
import { useQueryClient } from '@tanstack/react-query';
import { BRAND, mapOf } from '../brand.js';

export const DEFAULT_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
};
// Where the campaign's maps open: its own map area, as its server says at
// sign-in (me.org.map: { centre, zoom, bounds }). A sign-in kept from before
// the server said so falls back to what the page carries. null: no area is
// set — the map opens wide (openHome) until the campaign's is.
export const homeView = (me) => mapOf(me?.org?.map) ?? BRAND.map ?? null;
// The same for a map with no sign-in at hand: the one every screen reads.
export const useHomeView = () => homeView(useQueryClient().getQueryData(['me']));
// No area set: most of the country, so nothing is implied about where the
// campaign is.
export const WIDE_VIEW = { centre: [56, -96], zoom: 3 };
// What a new map is made with (L.map options).
export const homeStart = (home) => ({ center: (home || WIDE_VIEW).centre, zoom: (home || WIDE_VIEW).zoom });
// Put a map on the campaign's area: its centre, or with fit its whole box.
export const openHome = (map, home, { fit = false, padding = [8, 8] } = {}) => {
  if (!home) map.setView(WIDE_VIEW.centre, WIDE_VIEW.zoom, { animate: false });
  else if (fit) map.fitBounds(home.bounds, { padding, animate: false });
  else map.setView(home.centre, home.zoom, { animate: false });
};

// The provider's credit line, kept to text and http(s) links.
export function safeAttribution(html) {
  if (!html || typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const out = document.createElement('span');
  const walk = (node, into) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) into.append(n.textContent);
      else if (n.nodeType === 1 && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName)) continue;
      else if (n.nodeType === 1 && n.tagName === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '')) {
        const a = document.createElement('a');
        a.href = n.getAttribute('href');
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = n.textContent;
        into.append(a);
      } else if (n.nodeType === 1) walk(n, into);
    }
  };
  walk(doc.body.firstChild || doc.body, out);
  return out.innerHTML;
}
