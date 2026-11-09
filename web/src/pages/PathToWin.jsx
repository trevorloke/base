// Path to win (/path-to-win, from Today → More; the desk, the Data area) —
// where the campaign stands against what it needs (server/ext/pathtowin):
//   · per race (the slates): supporters found of the supporters needed, a
//     bar, what's still to find, the pace a week to election day beside the
//     last 4 weeks', and where that pace leads
//   · where we stand: everyone on file by rating
//   · week by week: supporters found each week (net), against the pace each
//     race needs; a table of the same
//   · where to work next: the turfs on a map, coloured by priority, and
//     ranked in a list whose columns are the score's parts — tap one to open
//     it on the main map (/map?turf=…); how the score works, in plain words
//   · the numbers: what each race needs, typed in or worked out from
//     eligible voters × turnout × share (managers change them; the numbers
//     are the campaign's own, never a jurisdiction's rules)
// The server keeps its counts a minute; "Count again" counts now.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { action, apiGet } from '../api.js';
import { NeedsSignal, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { DEFAULT_TILES, SURREY_BOUNDS, safeAttribution } from '../components/tiles.js';
import './shifts.css';
import './path-to-win.css';

// Counts are whole: 62.76 supporters to find is "63", never "62.76".
const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${Math.round(Number(n)) === 1 ? one : many}`;
// 0.25 → "0.3"; 52 → "52"; 7.75 → "7.8"
const pace = (n) => (Number(n) || 0).toLocaleString('en-CA', { maximumFractionDigits: 1 });
const rate1 = (n) => (n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-CA', { maximumFractionDigits: 1 }));
const dayWords = (ymd, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) => (ymd
  ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-CA', { ...opts, timeZone: 'UTC' }) : '');
const shortDay = (ymd) => dayWords(ymd, { month: 'short', day: 'numeric' });
const clock = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });

// The priority bands, darkest first: one blue, light to dark (never a
// rating's green, amber or red). Checked for steps and contrast on both
// base maps (the dataviz ordinal checks).
export const PRIORITY = [
  { key: 'next', label: 'Work next', color: '#0d366b' },
  { key: 'soon', label: 'Soon', color: '#256abf' },
  { key: 'later', label: 'Later', color: '#6da7ec' },
  { key: 'done', label: 'Nothing left', color: '#8a94a6' },
];
const PRIORITY_BY = Object.fromEntries(PRIORITY.map((p) => [p.key, p]));
const bandWords = (p, rules) => ({
  next: `${rules.next} points or more`,
  soon: `${rules.soon}–${rules.next - 1} points`,
  later: `under ${rules.soon} points`,
  done: 'every door knocked, no persuadables',
}[p]);

export default function PathToWin() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['pathtowin'], queryFn: () => apiGet('/pathtowin'), staleTime: 30_000 });
  const tilesQ = useQuery({ queryKey: ['mapConfig'], queryFn: () => apiGet('/map/config'), staleTime: 10 * 60_000, retry: 1 });
  const [editing, setEditing] = useState(false);
  const [recount, setRecount] = useState({ busy: false, error: null });
  const formRef = useRef(null);
  const online = useOnline();

  const head = (
    <>
      <Link to="/" className="ops-back">← Today</Link>
      <div className="ops-head"><h1>Path to win</h1></div>
    </>
  );
  if (noSignal(q)) return <div className="ops-page ptw-page">{head}<NoSignal /></div>;
  if (q.isPending) return <div className="ops-page ptw-page">{head}<p className="muted" role="status">Counting…</p></div>;
  if (q.isError) return <div className="ops-page ptw-page">{head}<p className="error" role="alert">{q.error.message}</p></div>;
  const d = q.data;
  const anySet = d.races.some((r) => r.set);
  const view = tilesQ.data?.views?.find((v) => v.key === 'clean');
  const tiles = view || tilesQ.data?.tiles || (tilesQ.isError ? DEFAULT_TILES : null);

  const openForm = () => {
    setEditing(true);
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const countAgain = async () => {
    setRecount({ busy: true, error: null });
    try {
      queryClient.setQueryData(['pathtowin'], await apiGet('/pathtowin?fresh=1'));
      setRecount({ busy: false, error: null });
    } catch (e) {
      setRecount({ busy: false, error: e.message });
    }
  };

  return (
    <div className="ops-page ptw-page">
      {head}
      <ElectionLine e={d.election} />

      <section className="ptw-sec" aria-labelledby="ptw-races-h">
        <h2 id="ptw-races-h" className="ptw-h">Supporters found</h2>
        {!anySet && (
          <div className="card ptw-empty">
            <p className="ptw-empty__line">No win number yet: how many votes each race needs.</p>
            {!d.can_edit && <p className="ops-meta">A manager sets it.</p>}
            {d.can_edit && !editing && <button type="button" className="btn btn-primary ops-tap" onClick={openForm}>Set the win number</button>}
          </div>
        )}
        <div className="ptw-races">
          {d.races.filter((r) => r.set || anySet).map((r) => (
            <RaceCard key={r.code} r={r} found={d.standing.supporters} electionSet={Boolean(d.election.day)}
              canEdit={d.can_edit} onSet={openForm} />
          ))}
        </div>
      </section>

      <Standing s={d.standing} />

      <section className="ptw-sec" aria-labelledby="ptw-trend-h">
        <h2 id="ptw-trend-h" className="ptw-h">Week by week</h2>
        <Trend points={d.trend} races={d.races} last4={d.last4} perWeek={d.per_week_last4} />
      </section>

      <section className="ptw-sec" aria-labelledby="ptw-turfs-h">
        <h2 id="ptw-turfs-h" className="ptw-h">Where to work next</h2>
        {d.turfs.length === 0 ? (
          <p className="ops-empty">No turfs drawn yet — <Link to="/map?draw=1">draw one on the map</Link>.</p>
        ) : (
          <>
            <TurfMap turfs={d.turfs} tiles={tiles} onOpen={(id) => navigate(`/map?turf=${encodeURIComponent(id)}`)} />
            <Legend rules={d.rules} turfs={d.turfs} />
            <TurfList turfs={d.turfs} campaignRate={d.campaign_rate} />
            <HowScore rules={d.rules} campaignRate={d.campaign_rate} />
          </>
        )}
      </section>

      <section className="ptw-sec" aria-labelledby="ptw-numbers-h" ref={formRef}>
        <h2 id="ptw-numbers-h" className="ptw-h">The numbers</h2>
        {editing && d.can_edit
          ? <NumbersForm d={d} onDone={() => setEditing(false)} />
          : <NumbersSaid d={d} onEdit={d.can_edit ? () => setEditing(true) : null} />}
      </section>

      <p className="ops-meta ptw-counted">
        Counted at {clock(d.computed_at)} ·{' '}
        <button type="button" className="btn-link ptw-again" onClick={countAgain} disabled={recount.busy || !online}>
          {recount.busy ? 'Counting…' : 'Count again'}
        </button>
        {!online && <> · <NeedsSignal /></>}
      </p>
      {recount.error && <p className="error" role="alert">{recount.error}</p>}
    </div>
  );
}

function ElectionLine({ e }) {
  if (!e.day) return <p className="ptw-when">No election day yet — set it below to see the pace a week.</p>;
  const left = e.days_left;
  const when = left > 13 ? `${plural(Math.floor(left / 7), 'week')} to go`
    : left > 0 ? `${plural(left, 'day')} to go` : left === 0 ? 'it’s today' : 'it has passed';
  return (
    <p className="ptw-when">
      Election day: <strong className="ptw-nowrap">{dayWords(e.day)}</strong> · <span className="ptw-nowrap">{when}</span>
      {e.from === 'gotv' && <span className="muted"> · from <Link to="/voted">GOTV &amp; voting days</Link></span>}
    </p>
  );
}

// ── A race ──
const howWords = (r) => {
  const i = r.inputs || {};
  if (r.how === 'worked') return `${num(i.eligible)} eligible × ${pace(i.turnout)}% turnout × ${pace(i.share)}% share = ${plural(r.votes, 'vote')}`;
  return `${plural(r.votes, 'vote')} to win, typed in`;
};
function RaceCard({ r, found, electionSet, canEdit, onSet }) {
  const headId = useId();
  if (!r.set) {
    return (
      <article className="card ptw-race is-unset" aria-labelledby={headId}>
        <h3 className="ptw-race__h" id={headId}>{r.label}</h3>
        <p className="ops-meta">No win number yet.</p>
        {canEdit && <button type="button" className="btn ops-tap" onClick={onSet}>Set it</button>}
      </article>
    );
  }
  const short = r.on_pace === false && r.per_week_needed != null ? Math.max(1, Math.ceil(r.per_week_needed - r.per_week_last4)) : 0;
  return (
    <article className="card ptw-race" aria-labelledby={headId}>
      <h3 className="ptw-race__h" id={headId}>{r.label}</h3>
      <p className="ptw-race__big"><strong className="ptw-race__n">{num(found)}</strong> of {plural(r.supporters_needed, 'supporter')}</p>
      <span className="ptw-meter" role="progressbar" aria-label={`${r.label}: supporters found`}
        aria-valuemin={0} aria-valuemax={r.supporters_needed} aria-valuenow={Math.min(found, r.supporters_needed)}
        aria-valuetext={`${num(found)} of ${num(r.supporters_needed)} (${r.pct}%)`}>
        <span className="ptw-meter__fill" style={{ width: `${Math.max(r.pct, found > 0 ? 1 : 0)}%` }} />
      </span>
      {r.still === 0 ? (
        <p className="ptw-verdict is-ok"><span aria-hidden="true">✓ </span>Enough supporters found</p>
      ) : (
        <dl className="ptw-facts">
          <div><dt>Still to find</dt><dd className="mono">{num(r.still)}</dd></div>
          <div><dt>Needed a week</dt><dd className="mono">{r.per_week_needed != null ? num(r.per_week_needed) : '—'}</dd></div>
          <div><dt>Found a week</dt><dd className="mono">{pace(r.per_week_last4)}</dd><dd className="ptw-facts__sub">last 4 weeks</dd></div>
        </dl>
      )}
      {r.still > 0 && r.on_pace === true && <p className="ptw-verdict is-ok"><span aria-hidden="true">✓ </span>On pace</p>}
      {short > 0 && <p className="ptw-verdict is-behind">Behind: {plural(short, 'more supporter')} a week</p>}
      {r.still > 0 && r.projected != null && (
        <p className="ptw-race__proj">At the last 4 weeks’ pace: <strong className="mono">{num(r.projected)}</strong> by election day</p>
      )}
      {r.still > 0 && !electionSet && <p className="ops-meta">Set election day to see the pace a week.</p>}
      <p className="ptw-race__how">
        {howWords(r)}
        {r.inputs?.vote_rate ? ` · ${pace(r.inputs.vote_rate)}% of supporters vote → ${plural(r.supporters_needed, 'supporter')}` : ''}
      </p>
    </article>
  );
}

// ── Everyone on file, by rating ──
function Standing({ s }) {
  const items = [
    { key: 'supporters', n: s.supporters, label: 'Supporters', sub: `${num(s.strong)} strong yes · ${num(s.lean)} lean yes` },
    { key: 'persuadables', n: s.persuadables, label: 'Persuadables', sub: 'rated 3, undecided' },
    { key: 'opposed', n: s.opposed, label: 'Opposed', sub: 'rated 4' },
    { key: 'unrated', n: s.unrated, label: 'Not rated yet', sub: `of ${plural(s.people, 'person', 'people')}` },
  ];
  return (
    <section className="ptw-sec" aria-labelledby="ptw-stand-h">
      <h2 id="ptw-stand-h" className="ptw-h">Where we stand</h2>
      <ul className="ptw-stand">
        {items.map((x) => (
          <li key={x.key} className="ptw-stand__i" data-band={x.key}>
            <span className="ptw-stand__n">{num(x.n)}</span>
            <span className="ptw-stand__label"><span className="ptw-sw" data-band={x.key} aria-hidden="true" />{x.label}</span>
            <span className="ptw-stand__sub">{x.sub}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Week by week: supporters found each week (net), and the pace each race needs ──
const niceMax = (n) => {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
};
function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setW(el.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

function Trend({ points, races, last4, perWeek }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState(null);
  const boxRef = useRef(null);
  const width = useWidth(boxRef);
  const tipId = useId();
  const lines = races.filter((r) => r.set && r.per_week_needed != null && r.still > 0)
    .map((r, i) => ({ code: r.code, label: r.label, v: r.per_week_needed, dash: i ? '6 4' : null }));
  const gained = points.map((p) => p.gained);
  const H = 200; const padL = 40; const padR = 8; const padT = 22; const padB = 24;
  const W = Math.max(width, 280);
  const innerW = W - padL - padR; const innerH = H - padT - padB;
  const top = niceMax(Math.max(1, ...gained, ...lines.map((l) => l.v)));
  const low = Math.min(0, ...gained);
  const bottom = low < 0 ? -niceMax(-low) : 0;
  const y = (v) => padT + ((top - v) / (top - bottom)) * innerH;
  const slot = innerW / points.length;
  const bw = Math.max(4, Math.min(24, slot - 6));
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 56))));
  const ticks = [...new Set([bottom, 0, ...(Number.isInteger(top / 2) ? [top / 2] : []), top])].sort((a, b) => a - b);
  // Each needed-pace label sits above its line, or under it when two would touch.
  const placed = [...lines].sort((a, b) => b.v - a.v).map((l, i, all) => ({
    ...l, below: i > 0 && Math.abs(y(all[i - 1].v) - y(l.v)) < 16,
  }));
  const total = points.reduce((a, p) => a + p.gained, 0);

  return (
    <div className="ptw-trend">
      <div className="ptw-trend__top">
        <p className="ptw-trend__line">
          Last 4 weeks: <strong className="mono">{signed(last4)}</strong> supporters, <strong className="mono">{pace(perWeek)}</strong> a week
          {' '}<span className="muted ptw-nowrap">· 12 weeks: {signed(total)}</span>
        </p>
        <div className="ops-seg ptw-seg" role="group" aria-label="Show as">
          <button type="button" aria-pressed={!table} onClick={() => setTable(false)}>Chart</button>
          <button type="button" aria-pressed={table} onClick={() => setTable(true)}>Table</button>
        </div>
      </div>
      {table ? (
        <div className="ptw-tablewrap">
          <table className="ptw-table">
            <caption className="ops-sr">Supporters found each week, the last 12 weeks</caption>
            <thead><tr><th scope="col">Week</th><th scope="col" className="num">New supporters</th><th scope="col" className="num">Supporters</th><th scope="col" className="num">Persuadables</th><th scope="col" className="num">Opposed</th></tr></thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.end}>
                  <th scope="row">{shortDay(p.start)} – {shortDay(p.end)}</th>
                  <td className="num mono">{signed(p.gained)}</td>
                  <td className="num mono">{num(p.supporters)}</td>
                  <td className="num mono">{num(p.persuadables)}</td>
                  <td className="num mono">{num(p.opposed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ptw-chart" ref={boxRef}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
            aria-label={`New supporters each week for 12 weeks${lines.length ? `, against the pace needed (${lines.map((l) => `${l.label} ${num(l.v)} a week`).join(', ')})` : ''}; the table has the numbers`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'ptw-base' : 'ptw-grid'} />
                <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="ptw-axis">{num(t)}</text>
              </g>
            ))}
            {points.map((p, i) => {
              const x0 = padL + i * slot;
              const bx = x0 + (slot - bw) / 2;
              const v = p.gained;
              const y0 = y(0); const y1 = y(v);
              const h = Math.abs(y0 - y1);
              const r = Math.min(4, bw / 2, h);
              const up = v >= 0;
              const path = h > 0 ? (up
                ? `M${bx},${y0} V${y1 + r} Q${bx},${y1} ${bx + r},${y1} H${bx + bw - r} Q${bx + bw},${y1} ${bx + bw},${y1 + r} V${y0} Z`
                : `M${bx},${y0} V${y1 - r} Q${bx},${y1} ${bx + r},${y1} H${bx + bw - r} Q${bx + bw},${y1} ${bx + bw},${y1 - r} V${y0} Z`) : '';
              const show = i % every === (points.length - 1) % every;
              return (
                <g key={p.end}>
                  {path && <path d={path} className={`ptw-bar${up ? '' : ' is-down'}${hover === i ? ' is-on' : ''}`} />}
                  {show && <text x={x0 + slot / 2} y={H - 6} textAnchor="middle" className="ptw-axis">{shortDay(p.end)}</text>}
                  <rect x={x0} y={padT} width={slot} height={innerH} className="ptw-hit" tabIndex={0}
                    aria-label={`${shortDay(p.start)} to ${shortDay(p.end)}: ${signed(v)} supporters, ${num(p.supporters)} in all`}
                    aria-describedby={hover === i ? tipId : undefined}
                    onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
                </g>
              );
            })}
            {placed.map((l) => (
              <g key={l.code} className="ptw-need" aria-hidden="true">
                <line x1={padL} x2={W - padR} y1={y(l.v)} y2={y(l.v)} strokeDasharray={l.dash || undefined} />
                <text x={W - padR - 2} y={l.below ? y(l.v) + 14 : y(l.v) - 5} textAnchor="end">{l.label}: {num(l.v)} a week</text>
              </g>
            ))}
          </svg>
          {hover !== null && points[hover] && (
            <div className="ptw-tip" id={tipId} role="tooltip"
              style={{ left: Math.min(Math.max(padL + hover * slot + slot / 2, 96), W - 96) }}>
              <strong>{shortDay(points[hover].start)} – {shortDay(points[hover].end)}</strong>
              <span className="mono">{signed(points[hover].gained)} new supporters</span>
              <span className="mono">{num(points[hover].supporters)} supporters by then</span>
            </div>
          )}
        </div>
      )}
      <p className="ops-meta ptw-trend__note">A supporter is someone rated 1 or 2; one rated again counts where they are now.</p>
    </div>
  );
}

// ── The turfs on a map, coloured by priority ──
function TurfMap({ turfs, tiles, onOpen }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const boundsRef = useRef(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  // Every turf in view (the city, before they're drawn), at once — no
  // animation; again when the map's box changes width for real (a phone
  // turned, a window narrowed), not for a scrollbar coming or going.
  const fit = (map) => (boundsRef.current
    ? map.fitBounds(boundsRef.current, { padding: [16, 16], maxZoom: 16, animate: false })
    : map.fitBounds(SURREY_BOUNDS, { padding: [8, 8], animate: false }));
  useEffect(() => {
    const el = boxRef.current;
    if (!el || mapRef.current) return undefined;
    const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, zoomSnap: 0.25 });
    fit(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    let ro = null;
    let last = el.getBoundingClientRect().width;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        map.invalidateSize();
        const w = el.getBoundingClientRect().width;
        if (Math.abs(w - last) > 24) { last = w; fit(map); }
      });
      ro.observe(el);
    }
    return () => { ro?.disconnect(); map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tiles?.url) return undefined;
    const layer = L.tileLayer(tiles.url, { maxZoom: tiles.maxZoom || 19, attribution: safeAttribution(tiles.attribution) }).addTo(map);
    return () => { layer.remove(); };
  }, [tiles?.url, tiles?.maxZoom, tiles?.attribution]);
  useEffect(() => {
    const map = mapRef.current; const group = layerRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const bounds = [];
    // Best last, so it draws on top where turfs touch.
    for (const t of [...turfs].reverse()) {
      const ring = (t.polygon || []).map(([a, b]) => [Number(a), Number(b)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      if (ring.length < 3) continue;
      const p = PRIORITY_BY[t.priority] || PRIORITY_BY.later;
      const poly = L.polygon(ring, {
        color: p.color, weight: t.priority === 'next' ? 3 : 2, fillColor: p.color,
        fillOpacity: t.priority === 'done' ? 0.15 : 0.45, className: `ptw-turf ptw-turf--${t.priority}`,
      }).addTo(group);
      poly.bindTooltip(`${t.rank} · ${t.name} · ${t.score} points · ${p.label}`, { sticky: true, className: 'ptw-tt' });
      poly.on('click', () => openRef.current(t.id));
      bounds.push(...ring);
      if (t.rank <= 5 && t.priority !== 'done') {
        L.marker(poly.getBounds().getCenter(), {
          icon: L.divIcon({ className: 'ptw-rank-wrap', html: `<span class="ptw-rank ptw-rank--${t.priority}">${t.rank}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
          interactive: false, keyboard: false,
        }).addTo(group);
      }
    }
    boundsRef.current = bounds.length ? L.latLngBounds(bounds) : null;
    fit(map);
  }, [turfs]);
  return (
    <div className="ptw-map" ref={boxRef} role="region"
      aria-label="Turfs on a map, coloured by priority — the same turfs are listed below, with links to the main map" />
  );
}

function Legend({ rules, turfs }) {
  const n = (k) => turfs.filter((t) => t.priority === k).length;
  return (
    <ul className="ptw-legend" aria-label="Priority">
      {PRIORITY.map((p) => (
        <li key={p.key} className="ptw-legend__i">
          <span className="ptw-sw ptw-sw--turf" style={{ background: p.color, opacity: p.key === 'done' ? 0.55 : 1 }} aria-hidden="true" />
          <span><strong>{p.label}</strong> <span className="muted">· {bandWords(p.key, rules)} · {plural(n(p.key), 'turf')}</span></span>
        </li>
      ))}
    </ul>
  );
}

// ── The ranked list: the score's parts as its columns ──
const lastWords = (t) => (t.days_since == null ? 'Never' : t.days_since === 0 ? 'Today' : `${plural(t.days_since, 'day')} ago`);
const findLine = (t) => {
  if (!t.doors) return 'Nobody on the map here yet';
  if (!t.doors_left) return 'every door knocked';
  if (t.rate == null) return `${plural(t.doors_left, 'door')} not yet knocked`;
  return `${num(t.doors_left)} doors left × ${rate1(t.rate)} per 100${t.rate_from === 'campaign' ? ' (average)' : ''}`;
};
function Points({ n }) {
  return <span className="ptw-pts mono" aria-label={`${n} points`}>+{n}</span>;
}
function Chip({ t }) {
  const p = PRIORITY_BY[t.priority] || PRIORITY_BY.later;
  return <span className={`chip ptw-chip ptw-chip--${t.priority}`}><span className="ptw-sw ptw-sw--chip" style={{ background: p.color }} aria-hidden="true" />{p.label}</span>;
}
function TurfList({ turfs, campaignRate }) {
  return (
    <>
      <ol className="ptw-rows ptw-narrow" aria-label="Turfs, best first">
        {turfs.map((t) => (
          <li key={t.id} className="ptw-row">
            <Link className="ptw-row__link" to={`/map?turf=${encodeURIComponent(t.id)}`}>
              <span className="ptw-row__top">
                <span className="ptw-row__rank mono" aria-hidden="true">{t.rank}</span>
                <span className="ptw-row__name">{t.name}</span>
                <span className="ptw-row__score mono">{t.score}<span className="ops-sr"> points</span></span>
              </span>
              <Chip t={t} />
              <span className="ptw-row__reasons">
                {t.reasons.map((r) => (
                  <span key={r.key} className="ptw-row__reason">{r.text}{r.key !== 'done' && <> <Points n={r.points} /></>}</span>
                ))}
              </span>
              <span className="ptw-row__go">Open on the map <span aria-hidden="true">›</span></span>
            </Link>
          </li>
        ))}
      </ol>
      <div className="ptw-tablewrap ptw-wide">
        <table className="ptw-table ptw-turfs">
          <caption className="ops-sr">Turfs ranked by priority, with the points each part of the score gives</caption>
          <thead>
            <tr>
              <th scope="col" className="num">#</th>
              <th scope="col">Turf</th>
              <th scope="col">Score</th>
              <th scope="col">Supporters to find <span className="ptw-th__pts">up to 60</span></th>
              <th scope="col">Persuadables left <span className="ptw-th__pts">up to 30</span></th>
              <th scope="col">Last knocked <span className="ptw-th__pts">up to 10</span></th>
            </tr>
          </thead>
          <tbody>
            {turfs.map((t) => (
              <tr key={t.id}>
                <td className="num mono">{t.rank}</td>
                <th scope="row" className="ptw-turfs__name">
                  <Link to={`/map?turf=${encodeURIComponent(t.id)}`}>{t.name}</Link>
                  <span className="ptw-cell__sub">{plural(t.doors, 'door')} · {plural(t.people, 'person', 'people')}</span>
                </th>
                <td>
                  <span className="ptw-score"><span className="ptw-score__n mono">{t.score}</span><Chip t={t} /></span>
                  <span className="ptw-scorebar" aria-hidden="true"><span style={{ width: `${t.score}%`, background: (PRIORITY_BY[t.priority] || PRIORITY_BY.later).color }} /></span>
                </td>
                <td>
                  <span className="ptw-cell__main mono">{t.to_find != null && t.doors_left ? `≈ ${num(t.to_find)}` : num(t.doors_left)}</span>{t.priority !== 'done' && <Points n={t.parts.find} />}
                  <span className="ptw-cell__sub">{findLine(t)}</span>
                </td>
                <td>
                  <span className="ptw-cell__main mono">{num(t.persuadables)}</span>{t.priority !== 'done' && <Points n={t.parts.persuade} />}
                  <span className="ptw-cell__sub">rated 3</span>
                </td>
                <td>
                  <span className="ptw-cell__main">{lastWords(t)}</span>{t.priority !== 'done' && <Points n={t.parts.rest} />}
                  <span className="ptw-cell__sub">{t.knocked ? `${plural(t.knocked, 'door')} knocked` : 'no doors knocked'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {campaignRate != null && <p className="ops-meta ptw-avg">Your turfs’ average: {rate1(campaignRate)} supporters per 100 doors knocked.</p>}
    </>
  );
}

function HowScore({ rules, campaignRate }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="ptw-how">
      <button type="button" className="disclose" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        How the score works
      </button>
      {open && (
        <div id={id} className="ptw-how__body">
          <p>Each turf gets up to 100 points, compared with your other turfs:</p>
          <ul>
            <li><strong>Up to {rules.find}</strong> for supporters still to find: doors not yet knocked × supporters per 100 doors knocked. The turf with the most gets all {rules.find}.</li>
            <li><strong>Up to {rules.persuade}</strong> for persuadables left — people rated 3. The turf with the most gets all {rules.persuade}.</li>
            <li><strong>Up to {rules.rest}</strong> for time since the last knock: {rules.restDays} days or more (or never) gets all {rules.rest}.</li>
          </ul>
          <p>A turf with under {rules.minKnocked} doors knocked uses your turfs’ average{campaignRate != null ? ` (${rate1(campaignRate)} per 100)` : ''} until it has its own.
            {' '}Work next: {rules.next} points or more · Soon: {rules.soon}–{rules.next - 1} · Later: under {rules.soon}.</p>
        </div>
      )}
    </div>
  );
}

// ── The numbers: what each race needs ──
function NumbersSaid({ d, onEdit }) {
  return (
    <>
      <ul className="ptw-said">
        {d.races.map((r) => (
          <li key={r.code}>
            <strong>{r.label}:</strong>{' '}
            {r.set ? <>{howWords(r)}{r.inputs?.vote_rate ? ` · ${pace(r.inputs.vote_rate)}% of supporters vote` : ''} → {plural(r.supporters_needed, 'supporter')} needed</> : <span className="muted">not set</span>}
          </li>
        ))}
        <li>
          <strong>Election day:</strong>{' '}
          {d.election.day ? <>{dayWords(d.election.day)}{d.election.from === 'gotv' && <span className="muted"> (from GOTV &amp; voting days)</span>}</> : <span className="muted">not set</span>}
        </li>
      </ul>
      {onEdit ? <button type="button" className="btn ops-tap" onClick={onEdit}>Change the numbers</button>
        : <p className="ops-meta">A manager changes these.</p>}
    </>
  );
}

// The same arithmetic as the server's (server/ext/pathtowin/rules.js), for
// the preview while typing; the server works the saved numbers out itself.
const tenths = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const t = Math.round(n * 10);
  return t >= 1 && t <= 1000 && Math.abs(n * 10 - t) < 1e-6 ? t : null;
};
const wholeOf = (v) => {
  const s = String(v ?? '').replace(/[\s,]/g, '');
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
};
const preview = (f) => {
  let votes = null;
  if (f.how === 'direct') votes = wholeOf(f.votes);
  else {
    const e = wholeOf(f.eligible); const t = tenths(f.turnout); const s = tenths(f.share);
    if (e && t && s) votes = Math.ceil((e * t * s) / 1e6);
  }
  if (!votes) return null;
  const r = tenths(f.vote_rate);
  return { votes, supporters: r ? Math.ceil((votes * 1000) / r) : votes };
};
const blankRace = { how: 'direct', votes: '', eligible: '', turnout: '', share: '', vote_rate: '' };
const formOf = (inputs) => (inputs ? {
  ...blankRace, how: inputs.how,
  ...Object.fromEntries(['votes', 'eligible', 'turnout', 'share', 'vote_rate'].map((k) => [k, inputs[k] != null ? String(inputs[k]) : ''])),
} : { ...blankRace });
const isBlank = (f) => ['votes', 'eligible', 'turnout', 'share', 'vote_rate'].every((k) => !String(f[k]).trim());

// What's wrong with a race's boxes: { field: words }.
const problemsOf = (f) => {
  const out = {};
  if (isBlank(f)) return out;
  const pct = (k, words) => {
    if (String(f[k]).trim() && tenths(f[k]) == null) out[k] = `${words}: a percent from 0.1 to 100`;
  };
  if (f.how === 'direct') {
    if (!wholeOf(f.votes)) out.votes = 'Votes needed: a whole number';
  } else {
    if (!wholeOf(f.eligible)) out.eligible = 'Eligible voters: a whole number';
    if (!String(f.turnout).trim()) out.turnout = 'Turnout: a percent';
    if (!String(f.share).trim()) out.share = 'Share needed: a percent';
    pct('turnout', 'Turnout');
    pct('share', 'Share needed');
  }
  pct('vote_rate', 'Supporters who vote');
  return out;
};
const toInput = (f) => {
  if (isBlank(f)) return null;
  const pctOf = (v) => tenths(v) / 10; // "32,5" or "32.5" → 32.5
  const rate = String(f.vote_rate).trim() ? { vote_rate: pctOf(f.vote_rate) } : {};
  return f.how === 'direct'
    ? { how: 'direct', votes: wholeOf(f.votes), ...rate }
    : { how: 'worked', eligible: wholeOf(f.eligible), turnout: pctOf(f.turnout), share: pctOf(f.share), ...rate };
};

function NumbersForm({ d, onDone }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [races, setRaces] = useState(() => Object.fromEntries(d.races.map((r) => [r.code, formOf(r.inputs)])));
  const [day, setDay] = useState(d.settings.election_day || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);
  const firstRef = useRef(null);
  useEffect(() => { firstRef.current?.focus({ preventScroll: true }); }, []);
  const set = (code, patch) => setRaces((cur) => ({ ...cur, [code]: { ...cur[code], ...patch } }));
  const problems = useMemo(() => Object.fromEntries(d.races.map((r) => [r.code, problemsOf(races[r.code])])), [races, d.races]);
  const bad = Object.values(problems).some((p) => Object.keys(p).length);
  const save = async (e) => {
    e.preventDefault();
    setTried(true);
    if (bad) return;
    setBusy(true);
    setError(null);
    try {
      await action('pathtowin.save', {
        ...(d.election.from === 'gotv' ? {} : { election_day: day || null }),
        races: Object.fromEntries(d.races.map((r) => [r.code, toInput(races[r.code])])),
      });
      await queryClient.invalidateQueries({ queryKey: ['pathtowin'] });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ptw-form" onSubmit={save} aria-label="The numbers" noValidate>
      {d.election.from === 'gotv' ? (
        <p className="ptw-form__line">Election day: <strong>{dayWords(d.election.day)}</strong> — from <Link to="/voted">GOTV &amp; voting days</Link> (change it there).</p>
      ) : (
        <div className="field ptw-field">
          <label htmlFor="ptw-day">Election day</label>
          <input id="ptw-day" ref={firstRef} type="date" className="input ptw-date" value={day} disabled={busy}
            aria-describedby="ptw-day-hint" onChange={(e) => setDay(e.target.value)} />
          <span className="ptw-hint" id="ptw-day-hint">The pace a week counts down to it.</span>
        </div>
      )}
      {d.races.map((r, i) => (
        <RaceFields key={r.code} race={r} f={races[r.code]} onChange={(p) => set(r.code, p)} busy={busy}
          problems={tried ? problems[r.code] : {}} firstRef={i === 0 && d.election.from === 'gotv' ? firstRef : null} />
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      {tried && bad && <p className="error" role="alert">Check the boxes marked above.</p>}
      <div className="ops-actions ptw-form__actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !online}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onDone} disabled={busy}>Cancel</button>
        {!online && <NeedsSignal />}
      </div>
    </form>
  );
}

function RaceFields({ race, f, onChange, busy, problems, firstRef }) {
  const base = `ptw-${race.code}`;
  const p = preview(f);
  const box = (k, label, hint, opts = {}) => (
    <div className="field ptw-field">
      <label htmlFor={`${base}-${k}`}>{label}</label>
      <span className="ptw-inputrow">
        <input id={`${base}-${k}`} className="input ptw-num" inputMode={opts.decimal ? 'decimal' : 'numeric'} autoComplete="off"
          value={f[k]} disabled={busy} aria-invalid={problems[k] ? 'true' : undefined}
          aria-describedby={`${base}-${k}-hint${problems[k] ? ` ${base}-${k}-err` : ''}`}
          ref={opts.first ? firstRef : undefined}
          onChange={(e) => onChange({ [k]: e.target.value })} />
        {opts.pct && <span className="ptw-unit" aria-hidden="true">%</span>}
      </span>
      <span className="ptw-hint" id={`${base}-${k}-hint`}>{hint}</span>
      {problems[k] && <span className="ptw-err" id={`${base}-${k}-err`}>{problems[k]}</span>}
    </div>
  );
  return (
    <fieldset className="ptw-race-fields">
      <legend>{race.label}</legend>
      <div className="ptw-how-pick" role="radiogroup" aria-label={`${race.label}: the votes needed`}>
        {[['direct', 'I know the votes needed'], ['worked', 'Work it out']].map(([v, words]) => (
          <label key={v} className={`ptw-pick${f.how === v ? ' is-on' : ''}`}>
            <input type="radio" name={`${base}-how`} value={v} checked={f.how === v} disabled={busy} onChange={() => onChange({ how: v })} />
            {words}
          </label>
        ))}
      </div>
      {f.how === 'direct'
        ? box('votes', 'Votes needed to win', 'The votes your candidate needs to win a seat in this race.', { first: true })
        : (
          <>
            {box('eligible', 'Eligible voters', 'Everyone who can vote in this race.', { first: true })}
            {box('turnout', 'Turnout', 'Of them, how many you expect to vote.', { pct: true, decimal: true })}
            {box('share', 'Share needed', 'Of those who vote, how many must vote for you to win.', { pct: true, decimal: true })}
          </>
        )}
      {box('vote_rate', 'Supporters who vote (optional)', 'Of the supporters you find, how many you expect to vote. Blank: all of them.', { pct: true, decimal: true })}
      <p className="ptw-preview" aria-live="polite">
        {p ? <><strong className="mono">{num(p.votes)}</strong> votes needed → <strong className="mono">{num(p.supporters)}</strong> supporters to find</>
          : isBlank(f) ? <span className="muted">Not set — leave it blank to keep this race off.</span> : <span className="muted">Fill in the boxes to see the numbers.</span>}
      </p>
    </fieldset>
  );
}
