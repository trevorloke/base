// A small drawing of each kind of section (WA decision 22): a wireframe of
// what it puts on the page, for "Add a section" and the page starters. Drawn
// in the desk's brand colours through CSS variables (thumbs.css). A kind
// with no drawing here gets a plain card (THUMBS lists the ones drawn; a
// test names any missing).
import './thumbs.css';

// Pieces: a bar of text, a block, a button, a picture.
const L = (x, y, w, k = 't') => <rect key={`${k}${x}-${y}`} className={`th-${k}`} x={x} y={y} width={w} height={k === 'h' ? 6 : 3} rx="1.5" />;
const B = (x, y, w, h, k = 'soft') => <rect key={`b${x}-${y}-${k}`} className={`th-${k}`} x={x} y={y} width={w} height={h} rx="3" />;
const Btn = (x, y, w = 22, k = 'mark') => <rect key={`btn${x}-${y}`} className={`th-${k}`} x={x} y={y} width={w} height={8} rx="4" />;
const Pic = (x, y, w, h) => (
  <g key={`p${x}-${y}`}>
    <rect className="th-pic" x={x} y={y} width={w} height={h} rx="3" />
    <path className="th-picline" d={`M${x + 4} ${y + h - 4} l${w * 0.3} ${-h * 0.4} l${w * 0.2} ${h * 0.2} l${w * 0.15} ${-h * 0.15} L${x + w - 4} ${y + h - 4}z`} />
  </g>
);
const Dot = (cx, cy, r = 4, k = 'mark') => <circle key={`d${cx}-${cy}`} className={`th-${k}`} cx={cx} cy={cy} r={r} />;
const rows = (x, y, n, w = 50, gap = 6) => Array.from({ length: n }, (_, i) => L(x, y + i * gap, i === n - 1 ? w * 0.6 : w));

export const THUMBS = {
  hero: [L(10, 14, 64, 'h'), L(10, 24, 50, 'h'), ...rows(10, 36, 2, 52), Btn(10, 52), Btn(36, 52, 20, 'line'), Pic(80, 12, 32, 48)],
  text: [L(10, 12, 60, 'h'), ...rows(10, 26, 5, 96)],
  image: [Pic(10, 8, 100, 46), L(30, 60, 60)],
  video: [L(10, 8, 50, 'h'), B(10, 18, 100, 46, 'ink'), <path key="play" className="th-paper" d="M54 33 l14 8 l-14 8z" />],
  columns: [L(10, 8, 54, 'h'), ...[10, 46, 82].flatMap((x) => [Dot(x + 6, 28), L(x, 38, 26, 'h2'), ...rows(x, 46, 3, 26, 5)])],
  band: [B(4, 18, 112, 36, 'mark'), L(14, 30, 56, 'paper'), Btn(80, 28, 26, 'paper')],
  faq: [L(10, 8, 50, 'h'), ...[22, 34, 46, 58].flatMap((y) => [L(10, y, 86), <path key={`c${y}`} className="th-strokeline" d={`M104 ${y - 1} l3 3 l3 -3`} />])],
  quote: [<text key="q" className="th-markt" x="10" y="28" fontSize="26">“</text>, ...rows(28, 14, 3, 72), Dot(34, 50, 6, 'soft'), L(44, 48, 30, 'h2')],
  newsletter: [L(10, 10, 56, 'h'), L(10, 22, 70), B(10, 32, 46, 10, 'line'), B(60, 32, 46, 10, 'line'), Btn(10, 48, 30)],
  join: [L(10, 10, 56, 'h'), ...rows(10, 22, 2, 46), B(64, 10, 46, 52, 'soft'), Btn(70, 50, 34)],
  donate: [L(10, 10, 40, 'h'), ...[10, 36, 62, 88].map((x) => B(x, 26, 22, 12, 'line')), Btn(10, 48, 50)],
  petition: [L(10, 10, 48, 'h'), ...rows(10, 22, 3, 46), B(10, 44, 46, 5, 'soft'), B(10, 44, 30, 5, 'mark'), B(64, 10, 46, 52, 'line'), Btn(70, 50, 34)],
  volunteer: [L(10, 10, 48, 'h'), B(10, 24, 46, 10, 'line'), B(60, 24, 46, 10, 'line'), ...[10, 36, 62].map((x) => B(x, 40, 22, 8, 'soft')), Btn(10, 54, 30)],
  shifts: [L(10, 8, 52, 'h'), ...[20, 36, 52].flatMap((y) => [B(10, y, 64, 12, 'line'), Btn(80, y + 2, 26)])],
  contact: [L(10, 8, 46, 'h'), B(10, 20, 46, 9, 'line'), B(60, 20, 46, 9, 'line'), B(10, 33, 96, 18, 'line'), Btn(10, 56, 28)],
  actNow: [L(10, 8, 40, 'h'), ...[10, 46, 82].flatMap((x) => [B(x, 20, 28, 30, 'soft'), L(x + 4, 28, 14, 'h'), L(x + 4, 40, 20)])],
  events: [L(10, 8, 52, 'h'), ...[20, 36, 52].flatMap((y) => [B(10, y, 12, 12, 'mark'), L(28, y + 2, 50, 'h2'), L(28, y + 8, 36)])],
  news: [L(10, 8, 30, 'h'), ...[10, 46, 82].flatMap((x) => [Pic(x, 20, 28, 18), L(x, 42, 26, 'h2'), ...rows(x, 50, 2, 26, 5)])],
  tracker: [L(10, 8, 52, 'h'), ...[20, 32, 44, 56].flatMap((y, i) => [L(10, y, 62), B(84, y - 3, 24, 8, ['ok', 'mark', 'soft', 'line'][i])])],
  people: [L(10, 8, 40, 'h'), ...[14, 50, 86].flatMap((x) => [Dot(x + 10, 32, 10, 'soft'), L(x, 48, 20, 'h2'), L(x + 2, 55, 16)])],
  groups: [L(10, 8, 60, 'h'), ...[[10, 20], [62, 20], [10, 44], [62, 44]].flatMap(([x, y]) => [B(x, y, 48, 20, 'line'), L(x + 4, y + 5, 26, 'h2'), L(x + 4, y + 12, 36)])],
  social: [L(10, 10, 40, 'h'), ...[10, 38, 66, 94].map((x) => Dot(x + 8, 40, 9, 'soft')), ...[10, 38, 66, 94].map((x) => L(x + 2, 56, 16))],
  voterguide: [L(10, 8, 56, 'h'), B(10, 20, 100, 14, 'mark'), L(14, 25, 50, 'paper'), ...[40, 50, 60].flatMap((y) => [Dot(14, y + 1, 2), L(20, y, 70)])],
};

export function Thumb({ kind, className = '' }) {
  const parts = THUMBS[kind];
  if (!parts) return null;
  return (
    <svg className={`th ${className}`.trim()} viewBox="0 0 120 72" aria-hidden="true" focusable="false">
      <rect className="th-bg" x="0" y="0" width="120" height="72" rx="6" />
      {parts}
    </svg>
  );
}

// A starter: its first sections, stacked small.
export function StarterThumb({ sections }) {
  const show = sections.slice(0, 3);
  return (
    <svg className="th th--stack" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <rect className="th-bg" x="0" y="0" width="120" height="120" rx="6" />
      {show.length === 0 && <path className="th-strokeline" d="M60 46 v28 M46 60 h28" />}
      {show.map((k, i) => (
        <svg key={`${k}${i}`} x="6" y={6 + i * 37} width="108" height="34" viewBox="0 0 120 72" preserveAspectRatio="xMidYMid slice">
          {THUMBS[k]}
        </svg>
      ))}
    </svg>
  );
}
