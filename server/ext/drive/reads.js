// Reading a file someone picked in the Picker, for People → Import: through
// their own grant (drive.file: only files they picked), streamed, nothing
// written anywhere. The import that follows is recorded as today.
//
//   GET /api/drive/files/:id               → { id, name, kind, bytes, tabs }
//   GET /api/drive/files/:id/tabs/:tab.csv  a Sheet's tab as CSV (csvPlain:
//                                           no apostrophes, no BOM), for loadText
//   GET /api/drive/files/:id/content        a .csv or .xlsx file's bytes, for loadFile
//
// Bounded: the two reads share 6 per person per 15 minutes and one open at
// a time; the metadata read counts with the Picker's 30. Refusals are plain
// words, never Google's own text.
import { makeLimiter } from '../../lib/guard.js';
import { csvPlainRow } from '../../lib/csv.js';
import { NOT_PICKED, gate, refused, usableGrant } from './grant.js';
import { getFile, kindOf, mediaUrl, refusal } from './files.js';
import { readRows, tabsOf } from './sheets.js';
import { StreamStopped, chunksOf, openStream } from './stream.js';

export const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const MAX_IMPORT_BYTES = 300 * 1024 * 1024; // the importer's MAX_FILE_BYTES
export const READ = { pageRows: 5000 };
export const _setReadForTest = (o) => Object.assign(READ, o);
const reads = makeLimiter({ windowMs: 15 * 60_000, max: 6 });
const open = new Set(); // user ids with a read going
export const _resetReadsForTest = () => { open.clear(); };

const words = (c, e) => c.json({ error: e.message }, e.status);
const why = (r) => (r.plain ? r : { ...r, ...refusal(r) });

// The checks every read shares → { g } or an answer already made.
const ready = async (c) => {
  if (!FILE_ID.test(c.req.param('id'))) return { res: c.json({ error: 'not found' }, 404) };
  try {
    const ctx = c.get('ctx');
    gate(ctx);
    return { g: await usableGrant(c.get('db'), ctx) };
  } catch (e) {
    if (e.status) return { res: words(c, e) };
    throw e;
  }
};
// One open read per person, then the 6-in-15-minutes limit.
const claim = (c) => {
  const me = c.get('ctx').user.id;
  if (open.has(me)) return { res: c.json({ error: 'Already reading one from Google Drive' }, 409) };
  if (reads(me)) return { res: c.json({ error: 'Too many reads from Google Drive — wait a few minutes' }, 429) };
  open.add(me);
  let done = false;
  return { release: () => { if (!done) { done = true; open.delete(me); } } };
};

// A stream to the browser that lets go of the person's open read however it ends.
const streamOut = (next, release) => new ReadableStream({
  async pull(ctrl) {
    try {
      const v = await next();
      if (v == null) { release(); ctrl.close(); } else ctrl.enqueue(v);
    } catch (e) {
      release();
      ctrl.error(e instanceof StreamStopped ? e : new StreamStopped());
    }
  },
  cancel() { release(); },
});

export const fileMeta = async (c, picker) => {
  const r0 = await ready(c);
  if (r0.res) return r0.res;
  if (picker(c.get('ctx').user.id)) return c.json({ error: 'Too many tries — wait a few minutes' }, 429);
  const db = c.get('db');
  const f = await getFile(db, r0.g, c.req.param('id'));
  if (!f.ok) return words(c, refused(f, { picked: true }));
  const kind = kindOf(f.file);
  let tabs = null;
  if (kind === 'sheet') {
    const t = await tabsOf(db, r0.g, f.file.id);
    if (!t.ok) return words(c, refused(why(t), { picked: true }));
    tabs = t.tabs;
  }
  return c.json({ id: f.file.id, name: f.file.name, kind, bytes: f.file.size, tabs });
};

const enc = new TextEncoder();
const blankRow = (row) => !row.length || row.every((v) => v === '' || v == null);

export const tabCsv = async (c) => {
  const r0 = await ready(c);
  if (r0.res) return r0.res;
  const m = String(c.req.param('tab') || '').match(/^(\d{1,10})(\.csv)?$/);
  if (!m) return c.json({ error: 'not found' }, 404);
  const hold = claim(c);
  if (hold.res) return hold.res;
  const db = c.get('db');
  const { g } = r0;
  const id = c.req.param('id');
  try {
    const t = await tabsOf(db, g, id);
    if (!t.ok) { hold.release(); return words(c, refused(why(t), { picked: true })); }
    const tab = t.tabs.find((x) => x.id === Number(m[1]));
    if (!tab) { hold.release(); return c.json({ error: 'That tab isn’t in the Sheet any more — pick it again' }, 404); }
    // Up to the tab's own row count, read just now: a blank gap in the
    // middle is kept; blank rows after the last one with anything are not.
    let from = 1;
    let blanks = 0;
    const page = async () => {
      if (from > tab.rows) return null;
      const to = Math.min(tab.rows, from + READ.pageRows - 1);
      const r = await readRows(db, g, id, tab.title, from, to);
      if (!r.ok) throw refused(why(r), { picked: true });
      let out = '';
      for (const row of r.values) {
        if (blankRow(row)) { blanks += 1; continue; }
        out += '\r\n'.repeat(blanks) + csvPlainRow(row);
        blanks = 0;
      }
      blanks += (to - from + 1) - r.values.length; // Google leaves out blank rows at a range's end
      from = to + 1;
      return out;
    };
    const first = await page();
    let sent = false;
    const next = async () => {
      if (!sent) { sent = true; return enc.encode(first ?? ''); }
      for (;;) {
        const more = await page();
        if (more == null) return null;
        if (more) return enc.encode(more);
      }
    };
    c.header('Cache-Control', 'no-store');
    return c.body(streamOut(next, hold.release), 200, { 'Content-Type': 'text/csv; charset=utf-8' });
  } catch (e) {
    hold.release();
    if (e.status) return words(c, e);
    throw e;
  }
};

export const fileContent = async (c) => {
  const r0 = await ready(c);
  if (r0.res) return r0.res;
  const hold = claim(c);
  if (hold.res) return hold.res;
  const db = c.get('db');
  try {
    const f = await getFile(db, r0.g, c.req.param('id'));
    if (!f.ok) throw refused(f, { picked: true });
    if (!['csv', 'xlsx'].includes(kindOf(f.file))) {
      hold.release();
      return c.json({ error: 'Pick a Google Sheet, a CSV or an Excel file' }, 415);
    }
    if (f.file.size != null && f.file.size > MAX_IMPORT_BYTES) {
      hold.release();
      return c.json({ error: 'That file is over 300 MB. Split it into parts and import them one at a time.' }, 413);
    }
    const r = await openStream(db, r0.g, mediaUrl(f.file.id));
    if (!r.ok) throw refused(why(r), { picked: true });
    const it = chunksOf(r.body);
    let n = 0;
    const next = async () => {
      const { value, done } = await it.next();
      if (done) return null;
      n += value.length;
      if (n > MAX_IMPORT_BYTES) { await it.return(); throw new StreamStopped(); }
      return value;
    };
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (f.file.size != null) headers['Content-Length'] = String(f.file.size);
    return c.body(streamOut(next, () => { hold.release(); it.return().catch(() => {}); }), 200, headers);
  } catch (e) {
    hold.release();
    if (e.status) return words(c, e);
    throw e;
  }
};

export { NOT_PICKED };
