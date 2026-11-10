// The canvass map's doors from further out, drawn on canvas tiles: no page
// element per door, so a whole city's voter list pans and zooms smoothly.
//   DotLayer      every door a small dot in its band's colour (support,
//                 undecided, opposed; not asked yet in slate, under the
//                 rest). Used below street zoom, where pins would pile up.
//                 A door is what the map has loaded ({ band, persons }) or
//                 the server's lean answer for a busy view ({ band, n }).
//   DensityLayer  a big list from further out still (GET /api/map/density):
//                 every patch of the map with people in it a shaded square —
//                 darker the more people, in the colour of support as far
//                 as they are rated. It reads as a picture of the city.
// Colours, sizes and the shading are mapView.js's (tested there). Neither
// layer takes taps itself (a canvas tile can't tell what was hit): the map
// asks nearest() / cellAt() where it was tapped.
import L from 'leaflet';
import { MARK, css, cellFill, dotRadius, ringedAt } from './mapView.js';

const ORDER = ['unrated', 'undecided', 'opposed', 'support']; // drawn last = on top

// Shared by both layers: items with a latlng, bucketed by the tile they fall
// in at each zoom (built once per zoom, on first draw), drawn per tile.
// The map stops at quarter zooms (a turf can fill the screen exactly), and
// between whole zooms Leaflet stretches the nearest zoom's tiles — so a tile
// is drawn for the zoom the map is really at (`k`: tile pixels to a screen
// pixel), and drawn again when the map settles on another.
const BucketLayer = L.GridLayer.extend({
  options: { pane: 'dots', tileSize: 256, updateWhenZooming: false, keepBuffer: 2 },
  initialize(options) {
    L.setOptions(this, options);
    this._items = [];
    this._buckets = new Map();
    this._dark = false;
  },
  onAdd(map) {
    L.GridLayer.prototype.onAdd.call(this, map);
    map.on('zoomend', this._sameSize, this);
  },
  onRemove(map) {
    map.off('zoomend', this._sameSize, this);
    L.GridLayer.prototype.onRemove.call(this, map);
  },
  // Tiles drawn for another zoom (and only stretched since): draw them again.
  _sameSize() {
    if (this._items.length && this._drawnAt != null && this._drawnAt !== this._map.getZoom()) this.redraw();
  },
  setItems(items, { dark = false, flagged = null } = {}) {
    this._items = items;
    this._dark = dark;
    this._flagged = flagged; // (door) → true: it has a sign (a little flag on its dot)
    this._buckets.clear();
    if (this._map) this.redraw();
    return this;
  },
  _bucketsAt(z) {
    let b = this._buckets.get(z);
    if (b) return b;
    b = new Map();
    const size = this.getTileSize().x;
    for (const it of this._items) {
      const p = this._map.project([it.lat, it.lng], z);
      it._p = it._p || {};
      it._p[z] = p;
      const k = `${Math.floor(p.x / size)}:${Math.floor(p.y / size)}`;
      if (!b.has(k)) b.set(k, []);
      b.get(k).push(it);
    }
    this._buckets.set(z, b);
    return b;
  },
  createTile(coords) {
    const tile = L.DomUtil.create('canvas', 'leaflet-tile map-dots-tile');
    const size = this.getTileSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    tile.width = size.x * dpr;
    tile.height = size.y * dpr;
    tile.style.width = `${size.x}px`;
    tile.style.height = `${size.y}px`;
    if (!this._items.length) return tile;
    const zoom = this._map.getZoom();
    this._drawnAt = zoom;
    const ctx = tile.getContext('2d');
    ctx.scale(dpr, dpr);
    const buckets = this._bucketsAt(coords.z);
    // This tile's own items and its neighbours' (a mark near an edge spills over).
    const near = [];
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        const got = buckets.get(`${coords.x + i}:${coords.y + j}`);
        if (got) near.push(...got);
      }
    }
    this._draw(ctx, near, coords.z, coords.x * size.x, coords.y * size.y, { size: size.x, dpr, zoom, k: 2 ** (coords.z - zoom) });
    return tile;
  },
});

// Doors as dots. From zoom 14 every dot wears a white ring, so it reads on
// any map and apart from its neighbours; undecided also keeps a darker edge
// at every zoom (its ochre alone is too light on a light map). Close in (z16
// up) a door with a sign flies a little flag; at z17 a household's size is
// written on its dot.
export const DotLayer = BucketLayer.extend({
  _draw(ctx, doors, z, ox, oy, { size, zoom, k }) {
    const theme = this._dark ? 'dark' : 'light';
    const r0 = dotRadius(zoom);
    const ring = ringedAt(zoom);
    // Sizes below are screen pixels: the tile is drawn at k tile pixels to one.
    ctx.scale(k, k);
    const at = (d) => [(d._p[z].x - ox) / k, (d._p[z].y - oy) / k];
    const edge = size / k;
    const reach = r0 + 12; // a dot, its ring, its flag
    const shown = doors.filter((d) => {
      const [x, y] = at(d);
      return x > -reach && x < edge + reach && y > -reach && y < edge + reach;
    });
    for (const band of ORDER) {
      ctx.fillStyle = css(band === 'unrated' ? MARK.unrated[theme] : MARK[band]);
      for (const d of shown) {
        if (d.band !== band) continue;
        const [x, y] = at(d);
        ctx.beginPath();
        ctx.arc(x, y, r0, 0, Math.PI * 2);
        ctx.fill();
        if (band === 'undecided') {
          ctx.strokeStyle = css(MARK.undecidedEdge[theme]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, r0 - 0.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (ring) {
          ctx.strokeStyle = css(MARK.ring[theme]);
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.arc(x, y, r0 + 0.4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    if (zoom < 16) return;
    if (this._flagged) {
      ctx.lineWidth = 1.2;
      for (const d of shown) {
        if (!this._flagged(d)) continue;
        const x = at(d)[0] + r0 * 0.55;
        const y = at(d)[1] - r0 * 0.55;
        ctx.strokeStyle = this._dark ? '#e8edf7' : '#161a2e';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 9); ctx.stroke();
        ctx.fillStyle = '#ffc72c';
        ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 7, y - 6.5); ctx.lineTo(x, y - 4); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    if (zoom < 17) return;
    ctx.font = '700 9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of shown) {
      const n = d.persons ? d.persons.length : d.n;
      if (!(n >= 2)) continue;
      ctx.fillStyle = d.band === 'undecided' ? '#161a2e' : '#ffffff';
      ctx.fillText(n > 9 ? '9+' : String(n), at(d)[0], at(d)[1] + 0.5);
    }
  },
});

// The far-out picture. Items: mapView.js cellsFrom's patches (their corners,
// people, how many are rated). Each is filled edge to edge — neighbours meet
// on a whole pixel, so the city reads as one shape, not a lattice of marks.
export const DensityLayer = BucketLayer.extend({
  _draw(ctx, cells, z, ox, oy, { size, dpr }) {
    const whole = (v) => Math.round(v * dpr) / dpr;
    const dark = this._dark;
    for (const c of cells) {
      c._q = c._q || {};
      let q = c._q[z];
      if (!q) {
        const nw = this._map.project([c.n2, c.w], z);
        const se = this._map.project([c.s, c.e], z);
        q = [nw.x, nw.y, se.x, se.y];
        c._q[z] = q;
      }
      const x0 = whole(q[0] - ox);
      const y0 = whole(q[1] - oy);
      const x1 = whole(q[2] - ox);
      const y1 = whole(q[3] - oy);
      if (x1 <= 0 || y1 <= 0 || x0 >= size || y0 >= size) continue;
      c._fill = c._fill || {};
      ctx.fillStyle = c._fill[dark] || (c._fill[dark] = css(cellFill(c, dark)));
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  },
});

// The door nearest a tap, within reach px on screen; null if none.
export function nearest(map, items, latlng, reach) {
  const at = map.latLngToContainerPoint(latlng);
  const size = map.getSize();
  let best = null;
  let bestD = reach * reach;
  for (const it of items) {
    const p = map.latLngToContainerPoint([it.lat, it.lng]);
    if (p.x < -reach || p.y < -reach || p.x > size.x + reach || p.y > size.y + reach) continue;
    const d = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
}
// The patch a tap landed in; null if nobody lives there.
export const cellAt = (cells, latlng) => cells.find((c) => latlng.lat >= c.s && latlng.lat < c.n2 && latlng.lng >= c.w && latlng.lng < c.e) || null;
