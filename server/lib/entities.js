// HTML entities back to the characters they stand for: what Google Cloud
// Translation's HTML mode sends back (&#39;, &quot;, &amp;, &nbsp; …) is
// decoded before anything is checked or stored (lib/translate.js). Named
// entities a translation can carry, and every numeric one; an unknown name
// stays as written.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', divide: '÷',
  shy: '', zwj: '‍', zwnj: '‌', thinsp: ' ', ensp: ' ', emsp: ' ',
};
export const decodeEntities = (s) => String(s ?? '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,15});/gi, (m, k) => {
  if (k[0] === '#') {
    const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    if (!Number.isFinite(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return m;
    return n === 0xa0 ? ' ' : String.fromCodePoint(n);
  }
  const v = NAMED[k] ?? NAMED[k.toLowerCase()];
  return v === undefined ? m : v;
});
