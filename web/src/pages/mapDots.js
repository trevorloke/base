// The canvass map's doors from further out, drawn on canvas tiles: no page
// element per door, so a whole city's voter list pans and zooms smoothly.
//   DotLayer      every door a small dot in its band's colour (support,
//                 undecided, opposed; not asked yet in slate grey, under the
//                 rest). Used below street zoom, where pins would pile up.
//   DensityLayer  a big list from further out still (GET /api/map/density):
//                 per patch of the map, a grey disc for its people, with a
//                 coloured disc on top for those rated (the leading band) —
//                 where people live, and what we know about them.
// Neither takes taps itself (a canvas tile can't tell which dot was hit):
// the map asks nearestDoor / nearestCell where it was tapped.
import L from 'leaflet';

export const BAND_FILL = { support: '#138a52', undecided: '#e8960c', opposed: '#d43c3c' };
const UNRATED = { light: 'rgba(58, 72, 98, 0.5)', dark: 'rgba(205, 216, 238, 0.55)' };
const RING = { light: 'rgba(255, 255, 255, 0.95)', dark: 'rgba(20, 26, 38, 0.9)' };
const ORDER = ['unrated', 'undecided', 'opposed', 'support']; // drawn last = on top

// A dot's radius (CSS px) at a tile zoom: small enough far out that a street
// reads as a line of dots, big enough close in to aim a finger at.
export const dotRadius = (z) => (z <= 11 ? 1.5 : z <= 12 ? 2 : z <= 13 ? 2.5 : z <= 14 ? 3.2 : z <= 15 ? 4.2 : z <= 16 ? 5.4 : 7);

// A density patch, in degrees, for an integer zoom: CELL_PX screen pixels a
// side near the given latitude (Web Mercator).
export const CELL_PX = 10;
export const cellOf = (z, lat) => {
  const dlng = (CELL_PX * 360) / (256 * 2 ** z);
  const dlat = dlng * Math.cos((lat * Math.PI) / 180);
  return [Number(dlat.toFixed(7)), Number(dlng.toFixed(7))];
};

// Shared by both layers: items with a latlng, bucketed by the tile they fall
// in at each zoom (built once per zoom, on first draw), drawn per tile.
const BucketLayer = L.GridLayer.extend({
  options: { pane: 'dots', tileSize: 256, updateWhenZooming: false, keepBuffer: 2 },
  initialize(options) {
    L.setOptions(this, options);
    this._items = [];
    this._buckets = new Map();
    this._dark = false;
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
    const ctx = tile.getContext('2d');
    ctx.scale(dpr, dpr);
    const buckets = this._bucketsAt(coords.z);
    // This tile's own items and its neighbours' (a dot near an edge spills over).
    const near = [];
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        const got = buckets.get(`${coords.x + i}:${coords.y + j}`);
        if (got) near.push(...got);
      }
    }
    this._draw(ctx, near, coords.z, coords.x * size.x, coords.y * size.y);
    return tile;
  },
});

// Doors as dots. Items: doors ({ lat, lng, band, persons }). Close in (z16
// up) a door with a sign flies a little flag; at z17 a household's size is
// written on its dot.
export const DotLayer = BucketLayer.extend({
  _draw(ctx, doors, z, ox, oy) {
    const theme = this._dark ? 'dark' : 'light';
    const r0 = dotRadius(z);
    const ring = z >= 14;
    for (const band of ORDER) {
      ctx.fillStyle = band === 'unrated' ? UNRATED[theme] : BAND_FILL[band];
      ctx.strokeStyle = RING[theme];
      ctx.lineWidth = band === 'unrated' ? 0.75 : 1.25;
      for (const d of doors) {
        if (d.band !== band) continue;
        const p = d._p[z];
        ctx.beginPath();
        ctx.arc(p.x - ox, p.y - oy, r0, 0, Math.PI * 2);
        ctx.fill();
        if (ring && (band !== 'unrated' || z >= 15)) ctx.stroke();
      }
    }
    if (z < 16) return;
    if (this._flagged) {
      ctx.lineWidth = 1.2;
      for (const d of doors) {
        if (!this._flagged(d)) continue;
        const x = d._p[z].x - ox + r0 * 0.55;
        const y = d._p[z].y - oy - r0 * 0.55;
        ctx.strokeStyle = this._dark ? '#e8edf7' : '#161a2e';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 9); ctx.stroke();
        ctx.fillStyle = '#ffc72c';
        ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 7, y - 6.5); ctx.lineTo(x, y - 4); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    if (z < 17) return;
    ctx.font = '700 9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of doors) {
      if (d.persons.length < 2) continue;
      ctx.fillStyle = d.band === 'undecided' ? '#161a2e' : '#ffffff';
      ctx.fillText(d.persons.length > 9 ? '9+' : String(d.persons.length), d._p[z].x - ox, d._p[z].y - oy + 0.5);
    }
  },
});

// Density patches. Items: { lat, lng, n, rated, band } (see cellsFrom).
export const DensityLayer = BucketLayer.extend({
  _draw(ctx, cells, z, ox, oy) {
    const theme = this._dark ? 'dark' : 'light';
    // The grey disc grows with the people in the patch (gaps between
    // patches keep it a texture, not a carpet); the coloured disc inside it
    // covers the share of them rated — a patch where few are known stays
    // mostly grey.
    const disc = (n) => Math.min(CELL_PX * 0.42, 1.2 + Math.sqrt(n) * 0.5);
    ctx.fillStyle = UNRATED[theme];
    for (const c of cells) {
      const p = c._p[z];
      ctx.beginPath();
      ctx.arc(p.x - ox, p.y - oy, disc(c.n), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const c of cells) {
      if (!c.rated) continue;
      const p = c._p[z];
      ctx.fillStyle = BAND_FILL[c.band];
      ctx.beginPath();
      ctx.arc(p.x - ox, p.y - oy, Math.max(1.3, disc(c.n) * Math.sqrt(c.rated / c.n)), 0, Math.PI * 2);
      ctx.fill();
    }
  },
});

// /map/density's rows → one item per patch, keeping only the ratings the
// filter wants (keep(code) — '' is not rated yet). band: the rated band with
// the most people in the patch.
export function cellsFrom(data, bandOfCode, keep = () => true) {
  if (!data?.cells?.length) return [];
  const [dlat, dlng] = data.cell;
  const by = new Map();
  for (const [y, x, r, n] of data.cells) {
    if (!keep(r)) continue;
    const k = `${y}:${x}`;
    let c = by.get(k);
    if (!c) { c = { lat: (y + 0.5) * dlat, lng: (x + 0.5) * dlng, n: 0, rated: 0, support: 0, undecided: 0, opposed: 0 }; by.set(k, c); }
    c.n += n;
    const band = r ? bandOfCode(r) : null;
    if (band && band !== 'unrated') { c.rated += n; c[band] += n; }
  }
  const out = [...by.values()];
  for (const c of out) c.band = c.support >= c.opposed && c.support >= c.undecided ? 'support' : c.opposed >= c.undecided ? 'opposed' : 'undecided';
  return out;
}

// The door (or patch) nearest a tap, within reach px on screen; null if none.
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
