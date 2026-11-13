// Reading a CSV in the browser: the parser, the bytes → text step, and
// readTable/shapeTable (the rows → { headers, records }). Shared by Data →
// Import (pages/ImportPeople.jsx), Import donations (pages/ImportGifts.jsx)
// and People you know (pages/AddressBook.jsx).

export const PARSE_SLICE = 20000; // rows parsed between breaths, so the page stays alive

// Let the browser paint (a progress line) before the next stretch of work.
export const breathe = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
  else setTimeout(resolve, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV parsing
// ─────────────────────────────────────────────────────────────────────────────

const DELIMS = [',', ';', '\t'];
export const DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

// Count each candidate delimiter outside quotes on the first non-blank line.
export function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let seen = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') { if (seen) break; continue; }
    if (ch in counts) counts[ch] += 1;
    if (ch.trim()) seen = true;
  }
  let best = ',';
  for (const d of DELIMS) if (counts[d] > counts[best]) best = d;
  return best;
}

// RFC 4180-ish, forgiving: quoted fields with "" escapes, delimiters and
// newlines inside quotes, CRLF / LF / CR line ends, a leading BOM, spaces
// before an opening quote, and stray text after a closing quote.
// → { delimiter, rows: string[][] } (blank lines kept as [''] so row numbers
// match the spreadsheet).
export function parseCSV(input, forced) {
  const p = csvParser(input, forced);
  p.step(Infinity);
  return { delimiter: p.delimiter, rows: p.rows };
}

// The same parse a slice at a time: step(max) reads up to max more rows and
// says whether it reached the end; at() is how far through the text it is (0–1).
export function csvParser(input, forced) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = forced || detectDelimiter(text);
  const rows = [];
  let row = [];
  const n = text.length;
  let i = 0;
  const endRow = () => { rows.push(row); row = []; };
  const step = (max) => {
    const stop = rows.length + max;
    while (i < n && rows.length < stop) {
      // Start of a field. Allow spaces before an opening quote.
      let j = i;
      while (j < n && (text[j] === ' ' || (text[j] === '\t' && delim !== '\t'))) j++;
      if (text[j] === '"') {
        let value = '';
        let k = j + 1;
        for (;;) {
          const q = text.indexOf('"', k);
          if (q === -1) { value += text.slice(k); k = n; break; } // unterminated: take the rest
          value += text.slice(k, q);
          if (text[q + 1] === '"') { value += '"'; k = q + 2; continue; }
          k = q + 1;
          break;
        }
        // Anything between the closing quote and the next delimiter/newline.
        let e = k;
        while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
        value += text.slice(k, e).trim() ? text.slice(k, e) : '';
        row.push(value);
        i = e;
      } else {
        let e = i;
        while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
        row.push(text.slice(i, e));
        i = e;
      }
      if (i >= n) { endRow(); break; }
      const ch = text[i];
      if (ch === delim) {
        i += 1;
        if (i >= n) { row.push(''); endRow(); }
      } else {
        // newline: \r\n, \n or \r
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        endRow();
      }
    }
    return i >= n;
  };
  return { delimiter: delim, rows, step, at: () => (n ? i / n : 1) };
}

export const isBlankRow = (cells) => cells.every((c) => !String(c).trim());

// Bytes → text. UTF-8 first; UTF-16 when it has a BOM (Excel "Unicode text");
// otherwise Windows-1252, which is what older Excel saves as "CSV".
export function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

export const isSpreadsheetBinary = (buf, name) => {
  const b = new Uint8Array(buf.slice(0, 4));
  const zip = b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // .xlsx / .numbers
  const ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // .xls
  return zip || ole || /\.(xlsx|xlsm|xls|numbers|ods)$/i.test(name || '');
};

// Text → { delimiter, all: [{ cells, row }], header } or { error }.
// header: whether the first non-blank row is column names (a guess).
// A big file is parsed a slice at a time; progress(share) hears how far (0–1).
// what: what a row of the file is, for the words (the gift import's: gifts).
export const PEOPLE = { one: 'person', many: 'people' };
// isData(cells): whether a first row holds data rather than column names
// (Data → Import's own guess, from its header rules); none: a header row.
export async function readTable(text, progress, what = PEOPLE, isData = () => false) {
  const empty = { error: `That file is empty. Choose a CSV with at least one ${what.one} in it.` };
  if (!text || !/\S/.test(text)) return empty;
  const parser = csvParser(text);
  while (!parser.step(PARSE_SLICE)) {
    progress?.(parser.at());
    await breathe();
  }
  const { delimiter, rows } = parser;
  const all = [];
  rows.forEach((cells, i) => { if (!isBlankRow(cells)) all.push({ cells, row: i + 1 }); }); // spreadsheet row numbers
  if (!all.length) return empty;
  return { delimiter, all, header: !isData(all[0].cells) };
}

// The rows, with or without the first as column names → { headers, records } or { error }.
export function shapeTable(all, header, what = PEOPLE) {
  const head = header ? all[0].cells : [];
  const records = header ? all.slice(1) : all;
  if (records.length === 0) {
    return { error: `There’s a header row but no ${what.many} under it. Check you saved the whole sheet.` };
  }
  let width = Math.min(500, Math.max(head.length, ...records.slice(0, 500).map((r) => r.cells.length)));
  // Drop trailing columns with no header and nothing in them ("a,b," on every line).
  const emptyCol = (i) => !String(head[i] ?? '').trim() && records.every((r) => !String(r.cells[i] ?? '').trim());
  while (width > 1 && emptyCol(width - 1)) width -= 1;
  const headers = Array.from({ length: width }, (_, i) => String(head[i] ?? '').trim() || `Column ${i + 1}`);
  return { headers, records };
}
