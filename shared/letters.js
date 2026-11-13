// Letters and op-eds: counting, comparing and the email link — plain
// functions the server and the field app share (ext/letters, LTE).
//
//   tokens(text)            the words, lower-cased, punctuation dropped; Han
//                           (Chinese characters) one character each
//   size(text, unit)        'words' (Han by character) or 'characters'
//                           (every one that isn't a space)
//   wordDiff(a, b)          hunks [{ kind: 'same'|'change', from, to, a, b }]:
//                           the writer's text a against the campaign's b, word
//                           by word, the spacing and punctuation kept, so
//   applyHunks(a, b, taken) gives the text with the taken changes (a Set of
//                           hunk indexes): all taken is b, none is a
//   campaignShare(first, campaignDrafts, text)
//                           0–1: how much of text is the campaign's words
//   sharedRuns(a, b, n?)    the longest run of words a and b share, when it is
//                           at least n long (8 words; 20 for Han), or null
//   mailtoFor({ to, subject, body, signoff, max })
//                           { href, bodyInLink }: a mailto: link, the letter in
//                           it only when the link fits in max characters
//   mailtoMax(nav)          that max for this device: 8,000 on a phone, 1,800
//                           elsewhere

const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+|[^\p{Script=Han}]+/gu;
let segmenter;
const words = (text) => {
  segmenter ||= new Intl.Segmenter(undefined, { granularity: 'word' });
  return segmenter.segment(String(text ?? ''));
};

// The text as units: each word with the spacing and punctuation after it
// (lead: whatever comes before the first word). A unit's `w` is the word
// lower-cased; `han` whether it is a Chinese character.
const unitsOf = (text) => {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const units = [];
  let lead = '';
  for (const seg of words(s)) {
    if (!seg.isWordLike) {
      if (units.length) units[units.length - 1].text += seg.segment;
      else lead += seg.segment;
      continue;
    }
    // Han split into characters, whatever the segmenter's dictionary holds.
    for (const part of seg.segment.match(HAN_RUN)) {
      if (HAN.test(part)) for (const ch of part) units.push({ w: ch, text: ch, han: true, len: ch.length });
      else units.push({ w: part.toLowerCase(), text: part, han: false, len: part.length });
    }
  }
  return { lead, units };
};

export const tokens = (text) => unitsOf(text).units.map((u) => u.w);

export const size = (text, unit = 'words') => {
  if (unit === 'characters') return [...String(text ?? '').replace(/\s+/gu, '')].length;
  return unitsOf(text).units.length;
};

// The longest common subsequence of two lists (by `eq`), as pairs [i, j].
// A long rewrite (over four million cells once the common start and end are
// trimmed) is one change: a letter is a few hundred words.
const CELLS = 4e6;
const align = (a, b, eq) => {
  const pairs = [];
  let s = 0;
  while (s < a.length && s < b.length && eq(a[s], b[s])) { pairs.push([s, s]); s += 1; }
  let ea = a.length;
  let eb = b.length;
  const tail = [];
  while (ea > s && eb > s && eq(a[ea - 1], b[eb - 1])) { ea -= 1; eb -= 1; tail.push([ea, eb]); }
  const n = ea - s;
  const m = eb - s;
  if (n && m && n * m <= CELLS) {
    // L[i][j]: the LCS of a[s+i..ea) and b[s+j..eb).
    const L = new Uint32Array((n + 1) * (m + 1));
    const at = (i, j) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        L[at(i, j)] = eq(a[s + i], b[s + j]) ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(a[s + i], b[s + j])) { pairs.push([s + i, s + j]); i += 1; j += 1; } else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) i += 1; else j += 1;
    }
  }
  return pairs.concat(tail.reverse());
};

// Hunks over units compared exactly (word, spacing and punctuation), so the
// writer's text and the campaign's each split into the hunks' pieces with
// nothing left over. The lead (before the first word) is a unit of its own.
export const wordDiff = (a, b) => {
  const A = unitsOf(a);
  const B = unitsOf(b);
  const ua = [{ w: '', text: A.lead, lead: true }, ...A.units];
  const ub = [{ w: '', text: B.lead, lead: true }, ...B.units];
  const pairs = align(ua, ub, (x, y) => x.text === y.text && !x.lead === !y.lead);
  const hunks = [];
  const piece = (u) => ({ word: u.lead ? '' : u.w, text: u.text });
  const push = (kind, from, to) => {
    if (!from.length && !to.length) return;
    const last = hunks[hunks.length - 1];
    if (last && last.kind === kind) { last.from.push(...from.map(piece)); last.to.push(...to.map(piece)); return; }
    hunks.push({ kind, from: from.map(piece), to: to.map(piece) });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [ua.length, ub.length]]) {
    push('change', ua.slice(i, pi), ub.slice(j, pj));
    if (pi < ua.length) push('same', [ua[pi]], [ub[pj]]);
    i = pi + 1;
    j = pj + 1;
  }
  // A same hunk of only an empty lead says nothing.
  return hunks.filter((h) => h.kind === 'change' || h.from.some((p) => p.text));
};

// The writer's text with the changes they took.
export const applyHunks = (writerText, campaignText, taken = new Set()) => wordDiff(writerText, campaignText)
  .map((h, k) => (h.kind === 'change' && taken.has(k) ? h.to : h.from).map((p) => p.text).join(''))
  .join('');

const grams = (ws, n) => {
  const out = new Set();
  for (let i = 0; i + n <= ws.length; i += 1) out.add(ws.slice(i, i + n).join('\u0001'));
  return out;
};

// A word of `text` is the campaign's when both hold:
//  - it isn't the writer's own from their FIRST draft: not aligned to it, in a
//    run of three or more aligned in a row (one "the" in common with a full
//    rewrite isn't theirs);
//  - it sits in a run of three or more words found in a campaign draft and not
//    in that first draft.
// So their own later typing stays theirs, and words a suggestion brought stay
// the campaign's after "Keep mine" or later edits.
export const campaignShare = (firstWriter, campaignDrafts = [], text) => {
  const t = tokens(text);
  if (!t.length) return 0;
  const f = tokens(firstWriter);
  const fromCampaign = new Set();
  for (const d of campaignDrafts) for (const g of grams(tokens(d), 3)) fromCampaign.add(g);
  if (!fromCampaign.size) return 0;
  const inFirst = grams(f, 3);

  const pairs = align(t, f, (x, y) => x === y);
  const own = new Array(t.length).fill(false);
  for (let k = 0; k < pairs.length;) {
    let e = k + 1;
    while (e < pairs.length && pairs[e][0] === pairs[e - 1][0] + 1 && pairs[e][1] === pairs[e - 1][1] + 1) e += 1;
    if (e - k >= Math.min(3, f.length)) for (let x = k; x < e; x += 1) own[pairs[x][0]] = true;
    k = e;
  }
  const theirs = new Array(t.length).fill(false);
  for (let i = 0; i + 3 <= t.length; i += 1) {
    const g = t.slice(i, i + 3).join('\u0001');
    if (fromCampaign.has(g) && !inFirst.has(g)) for (let x = i; x < i + 3; x += 1) theirs[x] = true;
  }
  let n = 0;
  for (let i = 0; i < t.length; i += 1) if (theirs[i] && !own[i]) n += 1;
  return Math.round((n / t.length) * 1000) / 1000;
};

// How long a shared run must be: 8 words, or 20 Chinese characters.
export const RUN_WORDS = 8;
export const RUN_HAN = 20;

// The longest run of words a and b share, as it reads in a ({ length, text,
// start, end }: the characters of a it spans), when it is long enough —
// n words, or by default 8 (20 when it is mostly Chinese characters).
export const sharedRuns = (a, b, n) => {
  const A = unitsOf(a);
  const B = unitsOf(b).units;
  const ua = A.units;
  if (!ua.length || !B.length) return null;
  // The longest common substring, one row at a time.
  let prev = new Uint32Array(B.length + 1);
  let cur = new Uint32Array(B.length + 1);
  let best = 0;
  let endA = 0;
  for (let i = 1; i <= ua.length; i += 1) {
    for (let j = 1; j <= B.length; j += 1) {
      cur[j] = ua[i - 1].w === B[j - 1].w ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) { best = cur[j]; endA = i; }
    }
    [prev, cur] = [cur, prev];
  }
  if (!best) return null;
  const run = ua.slice(endA - best, endA);
  const need = n ?? (run.filter((u) => u.han).length * 2 > run.length ? RUN_HAN : RUN_WORDS);
  if (best < need) return null;
  // Where it sits in a: from the run's first word to the end of its last.
  let start = A.lead.length;
  for (let k = 0; k < endA - best; k += 1) start += ua[k].text.length;
  let end = start;
  for (let k = 0; k < run.length - 1; k += 1) end += run[k].text.length;
  end += run[run.length - 1].len;
  return { length: best, text: String(a).replace(/\r\n?/g, '\n').slice(start, end), start, end };
};

// ── The email link ──
// Percent-encoded with %0A line breaks. When the whole link would pass max,
// the letter and its sign-off are left out (the writer pastes them).
export const MAILTO_PHONE = 8000;
export const MAILTO_OTHER = 1800;
export const mailtoMax = (nav = globalThis.navigator) => {
  const mobile = nav?.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent || '');
  return mobile ? MAILTO_PHONE : MAILTO_OTHER;
};
const enc = (v) => encodeURIComponent(String(v ?? '').replace(/\r\n?/g, '\n'));
export const mailtoFor = ({ to, subject = '', body = '', signoff = '', max = MAILTO_OTHER }) => {
  const addr = String(to || '').trim();
  const base = `mailto:${/^[^\s@?&#]+@[^\s@?&#]+$/.test(addr) ? addr : enc(addr)}?subject=${enc(subject)}`;
  const text = [String(body ?? '').trim(), String(signoff ?? '').trim()].filter(Boolean).join('\n\n');
  const full = text ? `${base}&body=${enc(text)}` : base;
  return full.length <= max ? { href: full, bodyInLink: Boolean(text) } : { href: base, bodyInLink: false };
};
