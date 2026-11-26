// Where Activity's map looks first, from the campaign's own data (pure, so
// server/test/dashframe.test.js checks it). The first that applies:
//   1. the turfs' outlines, all of them;
//   2. else the period's contact dots from the 2nd to the 98th percentile of
//      their latitudes and longitudes (one door mis-placed far away does not
//      throw the map wide), with where people were seen today;
//   3. else null: the map opens on the campaign's own area (tiles.js openHome).
// → [[south, west], [north, east]] or null.
const finite = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
// The day of t in the campaign's zone (the answer's tz), as YYYY-MM-DD; a
// zone this browser doesn't know falls back to the device's.
const dayOf = (t, tz) => {
  try { return new Date(t).toLocaleDateString('en-CA', tz ? { timeZone: tz } : undefined); } catch { return new Date(t).toLocaleDateString('en-CA'); }
};

function boundsOf(lats, lngs) {
  return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]];
}
// The value at fraction f of a sorted list (nearest rank).
const at = (sorted, f) => sorted[Math.round(f * (sorted.length - 1))];

// today: the campaign's day as YYYY-MM-DD (the answer's today), or a time.
export function frameOf({ turfs = [], dots = [], people = [], today = Date.now(), tz } = {}) {
  const corners = [];
  for (const t of turfs || []) {
    if (!Array.isArray(t?.polygon) || t.polygon.length < 3) continue;
    for (const [a, b] of t.polygon) if (Number.isFinite(Number(a)) && Number.isFinite(Number(b))) corners.push([Number(a), Number(b)]);
  }
  if (corners.length) return boundsOf(corners.map((c) => c[0]), corners.map((c) => c[1]));

  const lats = []; const lngs = [];
  const ok = (dots || []).filter(finite);
  if (ok.length) {
    const la = ok.map((p) => Number(p.lat)).sort((x, y) => x - y);
    const ln = ok.map((p) => Number(p.lng)).sort((x, y) => x - y);
    lats.push(at(la, 0.02), at(la, 0.98));
    lngs.push(at(ln, 0.02), at(ln, 0.98));
  }
  const day = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : dayOf(today, tz);
  for (const p of people || []) {
    if (!finite(p?.where) || !p.where.at || dayOf(p.where.at, tz) !== day) continue;
    lats.push(Number(p.where.lat)); lngs.push(Number(p.where.lng));
  }
  return lats.length ? boundsOf(lats, lngs) : null;
}
