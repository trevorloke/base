// Reading an Excel workbook (.xlsx) in the browser, with nothing added: an
// .xlsx is a zip of XML files. The zip's directory gives each file; the
// browser's own DecompressionStream inflates it; DOMParser reads the XML.
// What comes back is the first sheet as rows of strings, and as CSV text for
// the importer's usual path (ImportPeople.jsx), which already knows CSV.
//   readXlsx(arrayBuffer) → { rows: string[][], sheet: name } — throws a
//   plain-words Error on anything it can't read (an old .xls, a broken zip).
// Numbers come as Excel keeps them ("6045550101", "1"); a date cell is a
// day count, read back as YYYY-MM-DD when its format is a date.

const td = new TextDecoder();
const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');

const unzip = (buf) => {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let end = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('That isn’t an Excel workbook (.xlsx) we can read. Save it as CSV and choose that.');
  const count = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  const files = new Map();
  for (let k = 0; k < count; k += 1) {
    if (dv.getUint32(at, true) !== 0x02014b50) break;
    const method = dv.getUint16(at + 10, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const noteLen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    files.set(td.decode(u8.subarray(at + 46, at + 46 + nameLen)), { method, size, local });
    at += 46 + nameLen + extraLen + noteLen;
  }
  const read = async (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
    const data = u8.subarray(start, start + f.size);
    if (f.method === 0) return td.decode(data);
    if (f.method !== 8 || typeof DecompressionStream === 'undefined') {
      throw new Error('This browser can’t open that workbook. Save it as CSV and choose that.');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
  return { files, read };
};

// "BC12" → column 54 (0-based), from a cell's reference.
const colOf = (ref) => {
  let n = 0;
  for (const ch of String(ref).replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
// Excel's built-in date formats, and any custom one with d/m/y in it.
const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
const dayOf = (serial) => {
  const ms = Math.round((Number(serial) - 25_569) * 86_400_000); // 1970-01-01 is day 25569
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(serial) : d.toISOString().slice(0, 10);
};

export async function readXlsx(buf) {
  const zip = unzip(buf);
  const book = await zip.read('xl/workbook.xml');
  if (!book) throw new Error('That isn’t an Excel workbook (.xlsx) we can read. Save it as CSV and choose that.');
  // The first sheet, by the workbook's own order and links.
  const wb = xml(book);
  const first = wb.getElementsByTagName('sheet')[0];
  const sheetName = first?.getAttribute('name') || 'Sheet1';
  const rid = first?.getAttribute('r:id') || first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  let path = 'xl/worksheets/sheet1.xml';
  const rels = await zip.read('xl/_rels/workbook.xml.rels');
  if (rels && rid) {
    for (const r of xml(rels).getElementsByTagName('Relationship')) {
      if (r.getAttribute('Id') === rid) {
        const t = r.getAttribute('Target') || '';
        path = t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
      }
    }
  }
  const sheetText = await zip.read(path) || await zip.read([...zip.files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)) || '');
  if (!sheetText) throw new Error('That workbook has no sheet we can read. Save it as CSV and choose that.');

  const shared = [];
  const sst = await zip.read('xl/sharedStrings.xml');
  if (sst) {
    for (const si of xml(sst).getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    }
  }
  // Which cell styles are dates.
  const dateStyles = new Set();
  const styles = await zip.read('xl/styles.xml');
  if (styles) {
    const doc = xml(styles);
    const custom = new Map([...doc.getElementsByTagName('numFmt')].map((f) => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '']));
    const xfs = doc.getElementsByTagName('cellXfs')[0];
    [...(xfs ? xfs.getElementsByTagName('xf') : [])].forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId'));
      if (DATE_IDS.has(id) || /[dy]/i.test((custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]/g, ''))) dateStyles.add(i);
    });
  }

  const rows = [];
  for (const row of xml(sheetText).getElementsByTagName('row')) {
    const r = Number(row.getAttribute('r')) || rows.length + 1;
    const cells = [];
    for (const c of row.getElementsByTagName('c')) {
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (!t && v !== '' && dateStyles.has(Number(c.getAttribute('s')))) val = dayOf(v);
      else val = v;
      cells[c.getAttribute('r') ? colOf(c.getAttribute('r')) : cells.length] = val;
    }
    rows[r - 1] = Array.from(cells, (x) => x ?? '');
  }
  return { rows: Array.from(rows, (x) => x ?? []), sheet: sheetName };
}

// Rows → CSV text, quoting what needs it.
export const toCsv = (rows) => rows.map((r) => r.map((v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n');
