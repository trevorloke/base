// Donations → More → Import donations (/money/import) — gifts made in another
// tool, brought in from its spreadsheet, so the year's limit, the donor
// tiers, next year's lapsed list and the disclosure all see them. Three
// steps, one button each, the way People → Import works (its file reader
// and its steps are shared with it):
//   1 Choose a file    a CSV, or an Excel workbook's first sheet (or paste)
//   2 Match columns    each column → what it is. No tool's column names are
//                      assumed: components/GiftColumns.js matches a heading
//                      by what it means, then by the values, and the person
//                      corrects it. A Payment status column brings in only
//                      what went through (its words asked about, like Paid
//                      by's). Then Check — a dry run, nothing saved.
//   3 Import           what the check found: the gifts and their total, the
//                      donors found, the gifts that need a donor, what is
//                      already here, what can't come in — and anyone the
//                      file would take over the year's limit. Import saves
//                      them a call at a time (one import, so a call sent
//                      twice adds nothing).
// A gift brought in is quiet: no receipt number is used, nothing is
// emailed, no ladder starts, and it is not in To thank (the server's rule).
// Under the steps: the files brought in before, each taken back whole for a
// day. Managers and treasurers only (the server refuses anyone else).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { SLATES as FALLBACK_SLATES, slateLabel } from '@starbase/shared/canvass';
import { dateOrderOf, readGiftDate } from '@starbase/shared/giftfile';
import { action, fmtMoney } from '../api.js';
import { newClientId } from '../offline.js';
import { readXlsx, toCsv } from '../components/xlsx.js';
import {
  GIFT_FIELDS, SKIP, SCI_RE, guessGiftMapping, giftRow, fileRows, callsOf, tallyOf, overLimit,
  valuesIn, methodOf, slateOf, statusOf, columnValues, usedFor, keepUsed,
} from '../components/GiftColumns.js';
import { ImportsList, giftWord, invalidateGifts } from '../components/GiftImportBits.jsx';
import {
  readTable, shapeTable, decodeBytes, isSpreadsheetBinary, fmtN, fmtMB, plural, breathe, DELIM_NAMES, MAX_FILE_BYTES,
  Step, Bar, Reveal, InvalidList,
} from './ImportPeople.jsx';
import './shifts.css';
import '../components/gift-import.css';

const AGENT_ROLES = ['manager', 'treasurer'];
const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const GIFTS = { one: 'gift', many: 'gifts' };
const METHODS = [['card', 'Card'], ['etransfer', 'E-transfer'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['pad', 'Pre-authorized debit'], ['in-kind', 'In-kind']];
const METHOD_WORD = Object.fromEntries(METHODS);
const slatesOf = (me) => (Array.isArray(me?.org?.slates) && me.org.slates.length ? me.org.slates : FALLBACK_SLATES);
// "Mar 4, 2026" from 2026-03-04 (the day as written, never shifted).
const dayWords = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
};

function errText(e) {
  if (!e?.status) return 'Couldn’t reach base.win. Check your connection and try again.';
  if (e.status === 401) return 'You’ve been signed out. Sign in again in another tab, then try again.';
  if (e.status === 403) return 'Only a manager or the treasurer can bring gifts in.';
  const m = String(e.message || '').trim();
  return m ? `base.win said: ${m}${/[.!?]$/.test(m) ? '' : '.'}` : `Something went wrong (${e.status}). Try again.`;
}

const Head = () => (
  <div className="page-head imp-head">
    <div>
      <Link to="/money" className="eyebrow imp-back">← Donations</Link>
      <h1>Import donations</h1>
    </div>
  </div>
);

export default function ImportGifts() {
  const { me } = useOutletContext() ?? {};
  if (!MONEY_ROLES.includes(me?.role)) return <Navigate to="/money" replace />;
  if (!AGENT_ROLES.includes(me.role)) {
    return (
      <div className="imp-page">
        <Head />
        <p className="ops-empty">A manager or the treasurer brings a file in.</p>
      </div>
    );
  }
  return <Flow me={me} />;
}

function Count({ label, value, note, tone }) {
  return (
    <div className={`imp-count${tone ? ` is-${tone}` : ''}`}>
      <dt className="eyebrow">{label}</dt>
      <dd>
        <span className="imp-count__n mono">{value}</span>
        {note && <span className="imp-count__note">{note}</span>}
      </dd>
    </div>
  );
}

// What each value of a column means: the file's own words, most common
// first, each with a choice (the same rows People → Import uses for ratings).
function Meanings({ title, hint, values, current, own, options, none, onPick, disabled, say }) {
  return (
    <section className="imp-rmap gi-rmap" aria-label={title}>
      <p className="imp-hint imp-hint--sm gi-rmap-hint">{hint}</p>
      <ul className="imp-rmap__list">
        {values.map(({ value, n }) => {
          const cur = current(value) || '';
          return (
            <li key={value.toLowerCase()} className={`imp-rmap__row${cur ? ' is-used' : ''}`}>
              <span className="imp-rmap__val"><span className="imp-rmap__word">{value}</span> <span className="mono muted">{plural(n, 'row', 'rows')}</span></span>
              <span className="imp-map__arrow" aria-hidden="true">→</span>
              <select className="input imp-rmap__select" value={cur} disabled={disabled}
                aria-label={say(value)} onChange={(e) => onPick(value, e.target.value)}>
                <option value="">{none}</option>
                {options.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
              {own(value) && <span className="imp-rmap__own mono" aria-hidden="true">yours</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Flow({ me }) {
  const queryClient = useQueryClient();
  const slates = slatesOf(me);
  const timeZone = me?.workspace?.settings?.tz || me?.org?.tz || undefined;
  const fields = useMemo(() => GIFT_FIELDS.filter((f) => f.key !== 'slate' || slates.length > 1), [slates.length]);

  // Step 1 — the file
  const [source, setSource] = useState(null); // { name, headers, records, delimiter, all, header }
  const [loadError, setLoadError] = useState(null);
  const [reading, setReading] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  // Step 2 — the columns, then the check (a dry run). A change throws the check away.
  const [mapping, setMapping] = useState([]);
  const [orderPick, setOrderPick] = useState('mdy'); // 03/04/2026: which number is the month, when the file can't say
  const [methodMap, setMethodMap] = useState({}); // a Paid by value (lower-cased) → a method ('' not recorded), by choice
  const [slateMap, setSlateMap] = useState({}); // a Slate value → a slate ('' the first one), by choice
  const [statusMap, setStatusMap] = useState({}); // a Payment status value → 'in' ('' left out), by choice
  const [bumped, setBumped] = useState(null); // { col, key } — a column switched off by a pick
  const [check, setCheck] = useState(null); // { phase, done, total, answers: [{ res, part }], error }
  // Rows that look like a gift already typed in here: left out when ticked
  // (asked in the check; the same answers are counted again).
  const [leaveTyped, setLeaveTyped] = useState(false);
  // Step 3 — the import
  const [imp, setImp] = useState(null); // { phase, sent, total, fresh, waiting, already, flagged, invalid, totals, error, resumeAt }
  const run = useRef(null); // the import under way: its id and its calls, the same on a retry

  const busy = Boolean(reading) || check?.phase === 'running' || imp?.phase === 'running';
  const locked = busy || imp?.phase === 'done' || imp?.phase === 'error';

  // Don't lose a half-sent import to a stray tab close.
  useEffect(() => {
    if (imp?.phase !== 'running') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [imp?.phase]);

  const fresh = () => { setCheck(null); setImp(null); setBumped(null); run.current = null; };
  const guess = (shaped, header) => guessGiftMapping(shaped.headers, shaped.records, { slates, noHeader: !header });

  const loadText = async (text, name, size = text.length) => {
    const what = `Reading ${fmtMB(size)}…`;
    let shown = -1;
    const t = await readTable(text, (share) => {
      const pct = Math.floor(share * 100);
      if (pct !== shown) { shown = pct; setReading(`${what} ${pct}%`); }
    }, GIFTS);
    if (t.error) { setLoadError(t.error); return; }
    const shaped = shapeTable(t.all, t.header, GIFTS);
    if (shaped.error) { setLoadError(shaped.error); return; }
    setLoadError(null);
    setSource({ name, ...t, ...shaped });
    setMapping(guess(shaped, t.header));
    setMethodMap({});
    setSlateMap({});
    setStatusMap({});
    setOrderPick('mdy');
    setLeaveTyped(false);
    fresh();
  };
  const setHeader = (on) => {
    if (!source) return;
    const shaped = shapeTable(source.all, on, GIFTS);
    if (shaped.error) return;
    setSource({ ...source, header: on, ...shaped });
    setMapping(guess(shaped, on));
    fresh();
  };
  const loadFile = async (file) => {
    if (!file) return;
    setLoadError(null);
    if (file.size > MAX_FILE_BYTES) { setLoadError(`That file is over ${fmtMB(MAX_FILE_BYTES)}. Split it into parts and import them one at a time.`); return; }
    setReading(`Reading ${fmtMB(file.size)}…`);
    await breathe();
    try {
      let buf = await file.arrayBuffer();
      if (isSpreadsheetBinary(buf, file.name)) {
        // An Excel workbook (.xlsx): its first sheet. An old .xls, Numbers or OpenDocument file needs saving as CSV.
        if (!/\.(xlsx|xlsm)$/i.test(file.name) && new Uint8Array(buf.slice(0, 2))[0] !== 0x50) {
          setLoadError('That’s an older spreadsheet file. Save it as CSV or Excel (.xlsx), then choose that.');
          return;
        }
        let book;
        try {
          book = await readXlsx(buf);
        } catch (err) {
          setLoadError(err.message || 'Couldn’t read that workbook. Save it as CSV and choose that.');
          return;
        }
        buf = null;
        await loadText(toCsv(book.rows), `${file.name} · ${book.sheet}`, file.size);
        return;
      }
      const text = decodeBytes(buf);
      buf = null;
      await loadText(text, file.name, file.size);
    } catch {
      setLoadError('Couldn’t read that file. Try saving it again as CSV.');
    } finally {
      setReading(null);
    }
  };
  const onPick = (e) => { const file = e.target.files?.[0]; e.target.value = ''; loadFile(file); };
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); if (!locked) loadFile(e.dataTransfer?.files?.[0]); };
  const usePaste = async () => {
    if (!pasteText.trim()) { setLoadError('Paste some rows first.'); return; }
    setReading('Reading…');
    try { await loadText(pasteText, 'Pasted text'); } finally { setReading(null); }
    setPasteOpen(false);
  };
  const startOver = () => { setSource(null); setMapping([]); setMethodMap({}); setSlateMap({}); setStatusMap({}); setLeaveTyped(false); setLoadError(null); setPasteText(''); fresh(); };

  const setField = (col, key) => {
    let bump = null;
    setMapping(mapping.map((k, j) => {
      if (j === col) return key;
      if (key && k === key) { bump = { col: j, key }; return SKIP; }
      return k;
    }));
    setBumped(bump);
    setCheck(null);
  };

  // ── Derived ──
  const records = source?.records || [];
  const total = records.length;
  const col = (key) => mapping.indexOf(key);
  const dateCol = col('date');
  const methodCol = col('method');
  const slateCol = slates.length > 1 ? col('slate') : -1;
  const statusCol = col('status');
  // Which number of 03/04/2026 is the month: what the column itself says, else the person's pick.
  const orderSeen = useMemo(() => (source && dateCol >= 0 ? dateOrderOf(source.records.map((r) => r.cells[dateCol])) : null), [source, dateCol]);
  const order = orderSeen === 'mdy' || orderSeen === 'dmy' ? orderSeen : orderPick;
  const askOrder = orderSeen === 'either' || orderSeen === 'mixed';
  const orderExample = useMemo(() => {
    if (!askOrder) return null;
    const v = columnValues(source.records, dateCol, 2000).find((x) => readGiftDate(x, { order: 'mdy' }) && readGiftDate(x, { order: 'dmy' }));
    return v ? { value: v.split(/[ ,T]/)[0], mdy: dayWords(readGiftDate(v, { order: 'mdy' })), dmy: dayWords(readGiftDate(v, { order: 'dmy' })) } : null;
  }, [askOrder, source, dateCol]);
  const opts = useMemo(() => ({ order, timeZone, methodMap, slateMap, statusMap, slates }), [order, timeZone, methodMap, slateMap, statusMap, slates]);
  // The whole file as the rows to send, what can't be read here, and what its payment status leaves out.
  const file = useMemo(() => (source ? fileRows(source.records, mapping, opts) : { rows: [], unread: [], unpaid: [], repeats: 0, alike: 0 }), [source, mapping, opts]);
  const examples = useMemo(() => (source ? source.headers.map((_, i) => columnValues(source.records, i, 3)) : []), [source]);
  const preview = useMemo(() => (source ? source.records.slice(0, 5).map((r) => ({ at: r.row, ...giftRow(r.cells, mapping, opts) })) : []), [source, mapping, opts]);
  const methodValues = useMemo(() => (source ? valuesIn(source.records, methodCol) : []), [source, methodCol]);
  const slateValues = useMemo(() => (source ? valuesIn(source.records, slateCol) : []), [source, slateCol]);
  const statusValues = useMemo(() => (source ? valuesIn(source.records, statusCol) : []), [source, statusCol]);
  const unknownMethods = methodValues.filter(({ value }) => !Object.hasOwn(methodMap, value.toLowerCase()) && !methodOf(null, value)).length;
  // A value in the Slate column that names no slate would go to the first one unasked: the limit is per slate, so it is asked.
  const unknownSlates = slateValues.filter(({ value }) => !Object.hasOwn(slateMap, value.toLowerCase()) && !slateOf(null, slates, value)).length;
  // A payment status it doesn't know is left out until the person says it comes in: asked.
  const unknownStatuses = statusValues.filter(({ value }) => !Object.hasOwn(statusMap, value.toLowerCase()) && statusOf(null, value) === null).length;
  // The words that left rows out, most common first ("Refunded · Failed").
  const unpaidWords = useMemo(() => valuesIn(file.unpaid.map((u) => ({ cells: [u.status] })), 0, 4).map((v) => v.value).join(' · '), [file]);
  // Numbers Excel cut short ("1.6047E+10"), by column: how many.
  const sciByCol = useMemo(() => {
    const out = {};
    if (!source) return out;
    source.headers.forEach((_, i) => {
      if (mapping[i] !== 'phone' && mapping[i] !== 'source_id') return;
      const n = source.records.reduce((m, r) => m + (SCI_RE.test(String(r.cells[i] ?? '').trim()) ? 1 : 0), 0);
      if (n) out[i] = n;
    });
    return out;
  }, [source, mapping]);
  const hasDonor = ['name', 'first', 'last', 'email'].some((k) => mapping.includes(k));
  const ready = hasDonor && mapping.includes('amount') && mapping.includes('date');
  const usedCount = mapping.filter(Boolean).length;
  const usedFields = fields.filter((f) => mapping.includes(f.key)).map((f) => f.label);
  const setMeaning = (set) => (value, code) => { set((m) => ({ ...m, [value.toLowerCase()]: code })); setCheck(null); };

  // ── Check (a dry run: nothing is saved) ──
  const runCheck = async () => {
    const parts = callsOf(file.rows);
    const sum = file.rows.length;
    const answers = [];
    const used = []; // the gifts on the books that answered for a row so far: each answers once
    const id = newClientId(); // no import is made by a check
    setCheck({ phase: 'running', done: 0, total: sum });
    try {
      let done = 0;
      for (const part of parts) {
        const res = await action('gift.import', { import_id: id, file_name: source.name, rows: part, dry_run: true, typed_used: usedFor(used, part) });
        keepUsed(used, res, part);
        answers.push({ res, part });
        done += part.length;
        setCheck({ phase: 'running', done, total: sum });
      }
      setCheck({ phase: 'done', done: sum, total: sum, answers });
    } catch (e) {
      setCheck({ phase: 'error', done: 0, total: sum, error: errText(e) });
    }
  };

  // ── Import: a call at a time, all under one import ──
  const runImport = async (from = 0) => {
    if (from === 0) {
      run.current = {
        id: newClientId(), parts: callsOf(file.rows), leave: leaveTyped, used: [],
        acc: { fresh: 0, waiting: 0, already: 0, flagged: 0, typedIn: 0, typedLeft: 0, invalid: [], totals: null },
      };
    }
    const { id, parts, acc, leave, used } = run.current;
    const sum = parts.reduce((n, p) => n + p.length, 0);
    const sentBefore = (i) => parts.slice(0, i).reduce((n, p) => n + p.length, 0);
    setImp({ phase: 'running', sent: sentBefore(from), total: sum, ...acc });
    let i = from;
    try {
      for (; i < parts.length; i += 1) {
        const res = await action('gift.import', { import_id: id, file_name: source.name, rows: parts[i], leave_typed: leave, typed_used: usedFor(used, parts[i]) });
        keepUsed(used, res, parts[i]);
        (res.results || []).forEach((r, k) => {
          if (r.state === 'new') { acc.fresh += 1; if (r.flagged) acc.flagged += 1; if (r.typed) acc.typedIn += 1; }
          else if (r.state === 'typed') acc.typedLeft += 1;
          else if (r.state === 'waiting') acc.waiting += 1;
          else if (r.state === 'already') acc.already += 1;
          else if (r.state === 'invalid') acc.invalid.push({ row: parts[i][k]?.row ?? null, text: r.error });
        });
        acc.totals = res.totals || acc.totals;
        setImp({ phase: 'running', sent: sentBefore(i + 1), total: sum, ...acc });
      }
      setImp({ phase: 'done', sent: sum, total: sum, ...acc });
    } catch (e) {
      setImp({ phase: 'error', sent: sentBefore(i), total: sum, ...acc, error: errText(e), resumeAt: i });
    } finally {
      invalidateGifts(queryClient);
    }
  };

  const checked = check?.phase === 'done';
  const t = useMemo(() => (checked ? tallyOf(check.answers, { leave: leaveTyped }) : null), [checked, check, leaveTyped]);
  const willBring = t ? t.fresh + t.waiting : 0;
  const cantImport = t ? [...file.unread, ...t.invalid].sort((a, b) => (a.row ?? 0) - (b.row ?? 0)) : [];
  const over = t ? overLimit(t) : [];
  const imported = imp?.phase === 'done';
  const held = imp?.totals; // what the import holds on the books, as the server has it
  const at = !source ? 1 : !checked ? 2 : 3;
  const stepState = (n) => (n < at ? 'done' : n === at ? 'now' : 'todo');

  return (
    <div className="imp-page">
      <Head />

      {/* ── 1. Choose ── */}
      <Step n={1} title="Choose a file" line="A CSV or an Excel workbook (.xlsx) from the other tool — its first sheet." state={stepState(1)}>
        {source ? (
          <div className="imp-source">
            <p>
              <strong>{source.name}</strong>
              <span className="muted"> · {plural(source.records.length, 'row', 'rows')}</span>
            </p>
            <button type="button" className="btn btn-quiet imp-tap" onClick={startOver} disabled={busy}
              title={`${plural(source.headers.length, 'column', 'columns')}, ${DELIM_NAMES[source.delimiter]}-separated`}>
              {imported ? 'Import another' : 'Change file'}
            </button>
          </div>
        ) : (
          <>
            <label htmlFor="gi-file" className={`imp-drop${dragOver ? ' is-over' : ''}${reading ? ' is-busy' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
              <input id="gi-file" className="imp-file-input" type="file"
                accept=".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={onPick} disabled={Boolean(reading)} />
              <span className={`btn ${pasteOpen ? 'btn-quiet' : 'btn-primary'} imp-tap imp-drop__btn`}>{reading || 'Choose a file'}</span>
              <span className="imp-drop__or">or drop it here</span>
            </label>
            {!pasteOpen ? (
              <button type="button" className="btn btn-quiet imp-tap" onClick={() => setPasteOpen(true)}>Paste text</button>
            ) : (
              <div className="imp-paste">
                <div className="field">
                  <label htmlFor="gi-paste">One gift per line</label>
                  <textarea id="gi-paste" className="input mono imp-paste__text" rows={7} spellCheck={false}
                    placeholder={'Ana Example, ana@example.org, 50.00, 2026-03-01\nBen Example, ben@example.org, 20.00, 2026-03-02'}
                    value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
                </div>
                <div className="imp-actions">
                  <button type="button" className="btn btn-primary imp-tap" onClick={usePaste} disabled={busy}>Use this text</button>
                  <button type="button" className="btn btn-quiet imp-tap" onClick={() => setPasteOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
        {loadError && <p className="error" role="alert">{loadError}</p>}
      </Step>

      {/* ── 2. Match columns, then check ── */}
      <Step n={2} title="Match columns" line="Check where each column goes." state={stepState(2)}>
        {source && (checked ? (
          <div className="imp-source">
            <p className="imp-summary">{usedFields.join(' · ')}</p>
            {!imp && <button type="button" className="btn btn-quiet imp-tap" onClick={() => setCheck(null)}>Change</button>}
          </div>
        ) : (
          <>
            <label className="imp-headrow">
              <input type="checkbox" checked={source.header} disabled={locked || (!source.header && source.all.length < 2)}
                onChange={(e) => setHeader(e.target.checked)} />
              First row is column names
            </label>
            <ul className="imp-map">
              {source.headers.map((h, i) => {
                const id = `gi-col-${i}`;
                const ex = examples[i] || [];
                return (
                  <li key={i} className={`imp-map__row${mapping[i] ? ' is-used' : ''}`}>
                    <div className="imp-map__src">
                      <label htmlFor={id} className="imp-map__head">{h}</label>
                      <span className="imp-map__ex">{ex.length ? ex.join(' · ') : 'empty'}</span>
                    </div>
                    <span className="imp-map__arrow" aria-hidden="true">→</span>
                    <select id={id} className="input imp-map__select" value={mapping[i] || SKIP} disabled={locked}
                      onChange={(e) => setField(i, e.target.value)}>
                      <option value={SKIP}>Don’t import</option>
                      {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    {bumped?.col === i && (
                      <p className="imp-map__note" role="status">
                        Now “Don’t import” — {fields.find((f) => f.key === bumped.key)?.label} comes from one column.
                      </p>
                    )}
                    {sciByCol[i] > 0 && (
                      <p className="imp-map__note is-warn">
                        {plural(sciByCol[i], 'number has', 'numbers have')} lost {sciByCol[i] === 1 ? 'its' : 'their'} last digits in Excel (like 1.6047E+10).
                        {mapping[i] === 'source_id' ? ' Those rows can’t come in.' : ' Those phone numbers are left out.'} Format this column as Text in the spreadsheet, save, and choose the file again.
                      </p>
                    )}
                    {mapping[i] === 'source_id' && file.repeats > 0 && (
                      <p className="imp-map__note is-warn">
                        {plural(file.repeats, 'row repeats', 'rows repeat')} a number from earlier in the file, so {file.repeats === 1 ? 'it is' : 'they are'} left out as the same gift. Not each gift’s own number? Set this column to Don’t import.
                      </p>
                    )}
                    {mapping[i] === 'email' && file.badEmails > 0 && (
                      <p className="imp-map__note">
                        {plural(file.badEmails, 'email here isn’t an address', 'emails here aren’t addresses')} — {file.badEmails === 1 ? 'that gift is' : 'those gifts are'} matched by the donor’s name instead.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            {askOrder && (
              <div className="gi-ask" role="group" aria-labelledby="gi-order-h">
                <p className="gi-ask__q" id="gi-order-h">{orderExample ? `${orderExample.value} in this file is` : 'This file’s dates have'}</p>
                <div className="ops-seg">
                  {[['mdy', orderExample?.mdy || 'The month first'], ['dmy', orderExample?.dmy || 'The day first']].map(([code, label]) => (
                    <button key={code} type="button" aria-pressed={order === code} disabled={locked}
                      onClick={() => { setOrderPick(code); setCheck(null); }}>
                      {label}
                    </button>
                  ))}
                </div>
                {orderSeen === 'mixed' && <p className="imp-map__note is-warn">Some dates here can only be month first and others only day first: the ones that don’t fit your pick can’t be read.</p>}
              </div>
            )}

            {methodValues.length > 0 && (
              <Reveal label={`How each was paid${unknownMethods ? ` · ${fmtN(unknownMethods)} to say` : ''}`} defaultOpen={unknownMethods > 0}>
                <Meanings title="How each was paid" disabled={locked} values={methodValues}
                  hint="The file’s own words, most common first. One left “Not recorded” still comes in — without how it was paid."
                  current={(v) => methodOf(methodMap, v)} own={(v) => Object.hasOwn(methodMap, v.toLowerCase())}
                  options={METHODS} none="Not recorded" say={(v) => `How “${v}” was paid`} onPick={setMeaning(setMethodMap)} />
              </Reveal>
            )}
            {statusValues.length > 0 && (
              <Reveal label={`Which come in${unknownStatuses ? ` · ${fmtN(unknownStatuses)} to say` : ''}`} defaultOpen={unknownStatuses > 0}>
                <Meanings title="Which come in" disabled={locked} values={statusValues}
                  hint="Only a payment that went through is a gift. One left out isn’t brought in."
                  current={(v) => (statusOf(statusMap, v) ? 'in' : '')} own={(v) => Object.hasOwn(statusMap, v.toLowerCase())}
                  options={[['in', 'Comes in']]} none="Left out" say={(v) => `Whether “${v}” comes in`} onPick={setMeaning(setStatusMap)} />
              </Reveal>
            )}
            {slateValues.length > 0 && (
              <Reveal label={`Which slate each is to${unknownSlates ? ` · ${fmtN(unknownSlates)} to say` : ''}`} defaultOpen={unknownSlates > 0}>
                <Meanings title="Which slate each is to" disabled={locked} values={slateValues}
                  hint={`The year’s limit is per slate. One left as it is goes to ${slates[0].label}.`}
                  current={(v) => slateOf(slateMap, slates, v)} own={(v) => Object.hasOwn(slateMap, v.toLowerCase())}
                  options={slates.map((s) => [s.code, s.label])} none={`${slates[0].label} (the first slate)`}
                  say={(v) => `The slate “${v}” is`} onPick={setMeaning(setSlateMap)} />
              </Reveal>
            )}

            {!ready && (
              <p className="imp-need" role="alert">
                Match a column to the <strong>donor</strong> (a name or an email), the <strong>Amount</strong> and the <strong>Date of the gift</strong>.
              </p>
            )}
            {/* More than one slate and no column for it: said, since the year's limit is per slate. */}
            {ready && slates.length > 1 && slateCol < 0 && (
              <p className="imp-hint gi-slate-note">No column says which slate, so every gift goes to {slates[0].label}.</p>
            )}

            {ready && preview.length > 0 && (
              <Reveal label="Preview">
                <div className="imp-preview__scroll">
                  <table className="table imp-preview__table">
                    <thead><tr><th className="mono">Row</th><th>Donor</th><th>Amount</th><th>Date</th><th>Paid by</th></tr></thead>
                    <tbody>
                      {preview.map((p) => (
                        <tr key={p.at}>
                          <td className="mono muted">{p.at}</td>
                          {p.out ? <td colSpan={4}><span className="muted">Left out — {p.out}</span></td> : p.error ? <td colSpan={4}><span className="danger-text">{p.error}</span></td> : (
                            <>
                              <td>{p.row.name || [p.row.first, p.row.last].filter(Boolean).join(' ') || p.row.email || <span className="danger-text">no donor</span>}</td>
                              <td className="mono">{fmtMoney(p.row.amount_cents)}</td>
                              <td>{dayWords(p.row.date)}</td>
                              <td>{p.row.method ? METHOD_WORD[p.row.method] : <span className="muted">—</span>}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Reveal>
            )}

            {check?.phase === 'running' ? (
              <div className="imp-running" role="status" aria-live="polite">
                <Bar value={check.done} max={check.total} label="Checking" />
                <p className="imp-line mono">Checking {fmtN(check.done)} of {fmtN(check.total)}…</p>
              </div>
            ) : (
              <div className="imp-actions">
                <button type="button" className="btn btn-primary imp-tap" onClick={() => runCheck()} disabled={!ready || busy || locked || file.rows.length === 0}>
                  Check {plural(total, 'row', 'rows')}
                </button>
                <span className="imp-line imp-line--inline">{fmtN(usedCount)} of {fmtN(source.headers.length)} columns</span>
              </div>
            )}
            {ready && file.rows.length === 0 && (
              <p className="imp-line">
                {file.unpaid.length > 0 && file.unread.length === 0
                  ? 'Every row is left out by its payment status — say which come in above.'
                  : 'No row here reads as a gift yet — check the Amount and Date columns.'}
              </p>
            )}
            {check?.phase === 'error' && <p className="error" role="alert">The check didn’t finish. {check.error}</p>}
          </>
        ))}
      </Step>

      {/* ── 3. Import ── */}
      <Step n={3} title={imported ? 'Done' : 'Import'} line={!imp && willBring > 0 ? 'Nothing is saved until you tap Import.' : null} state={imported ? 'done' : stepState(3)}>
        {checked && (
          <>
            {!imp && (
              <div className="imp-result" role="status">
                <dl className="imp-counts">
                  <Count label="Gifts" value={fmtN(willBring)} note={fmtMoney(t.cents)} tone="ok" />
                  <Count label="Donors found" value={fmtN(t.people.size)} />
                  <Count label="To settle" value={fmtN(t.waiting)} note={t.waiting ? 'need a donor' : null} />
                  <Count label="Already here" value={fmtN(t.already)} />
                  <Count label="Can’t import" value={fmtN(cantImport.length)} tone={cantImport.length ? 'danger' : null} />
                </dl>
                {over.length > 0 && (
                  <div className="gi-over">
                    <p className="gi-over__lead">{plural(over.length, 'donor', 'donors')} would be over the year’s limit</p>
                    <ul className="gi-over__list">
                      {over.slice(0, 12).map((o) => (
                        <li key={`${o.person_id}|${o.year}|${o.slate}`}>
                          <span>{o.name} · {o.year}{slates.length > 1 ? ` · ${slateLabel(o.slate, slates)}` : ''}</span>
                          <span className="mono">{fmtMoney(o.total_cents)} of {fmtMoney(o.cap_cents)}</span>
                        </li>
                      ))}
                    </ul>
                    {over.length > 12 && <p className="imp-hint imp-hint--sm">…and {fmtN(over.length - 12)} more.</p>}
                    <p className="imp-hint imp-hint--sm">Their gifts still come in, flagged — Donations lists them under Needs you.</p>
                  </div>
                )}
                {t.typed > 0 && (
                  <div className="gi-typed">
                    <p className="gi-typed__lead">{plural(t.typed, 'row looks like a gift', 'rows look like gifts')} already typed in here</p>
                    <p className="imp-hint imp-hint--sm">The same donor, amount and day as a gift on the books.</p>
                    <label className="gi-typed__leave">
                      <input type="checkbox" checked={leaveTyped} onChange={(e) => setLeaveTyped(e.target.checked)} />
                      <span>Leave {t.typed === 1 ? 'it' : 'those'} out</span>
                    </label>
                    <Reveal label="See them">
                      {t.typed > t.typedRows.length && <p className="imp-hint imp-hint--sm">First {fmtN(t.typedRows.length)} of {fmtN(t.typed)}.</p>}
                      <ul className="imp-matches__list">
                        {t.typedRows.map((x, i) => (
                          <li key={`${x.row}-${i}`}>
                            <span className="mono muted">Row {fmtN(x.row)}</span> {x.donor || '—'} → <strong>{x.person}</strong>
                            <span className="muted"> · {fmtMoney(x.amount_cents)} · {dayWords(x.date)}</span>
                          </li>
                        ))}
                      </ul>
                    </Reveal>
                  </div>
                )}
                {file.unpaid.length > 0 && (
                  <p className="imp-hint imp-hint--sm">{plural(file.unpaid.length, 'row is', 'rows are')} left out by {file.unpaid.length === 1 ? 'its' : 'their'} payment status ({unpaidWords}).</p>
                )}
                {t.waiting > 0 && <p className="imp-hint imp-hint--sm">{plural(t.waiting, 'gift has', 'gifts have')} no sure donor on file. {t.waiting === 1 ? 'It waits' : 'They wait'} under Donations → Needs you for you to pick.</p>}
                {file.repeats > 0 && <p className="imp-map__note is-warn gi-note">{plural(file.repeats, 'row repeats', 'rows repeat')} a gift number from earlier in the file — left out as the same gift.</p>}
                {file.alike > 0 && <p className="imp-hint imp-hint--sm">{plural(file.alike, 'row reads', 'rows read')} like an earlier one (same donor, amount and day) — each comes in as its own gift.</p>}
                {t.matches.length > 0 && (
                  <Reveal label={t.differs ? `Who each gift goes to · ${fmtN(t.differs)} under another name` : 'Who each gift goes to'} defaultOpen={t.differs > 0}>
                    {t.fresh > t.matches.length && <p className="imp-hint imp-hint--sm">First {fmtN(t.matches.length)} of {fmtN(t.fresh)}.</p>}
                    <ul className="imp-matches__list">
                      {t.matches.map((m, i) => (
                        <li key={`${m.row}-${i}`}>
                          <span className="mono muted">Row {fmtN(m.row)}</span> {m.donor || '—'} → <strong>{m.person}</strong>
                          <span className="muted"> — same {m.by === 'email' ? 'email' : `name and ${m.by}`}</span>
                          {m.differs && <> <span className="chip chip-warn">another name</span></>}
                        </li>
                      ))}
                    </ul>
                  </Reveal>
                )}
                <InvalidList invalid={cantImport}
                  intro={`${plural(cantImport.length, 'row', 'rows')} can’t come in. Fix ${cantImport.length === 1 ? 'it' : 'them'} in the spreadsheet and import the file again — nothing is added twice.`} />
                {willBring === 0 && t.already + t.typedLeft > 0 && <p className="imp-line">Nothing new — every gift in this file is already here.</p>}
                {willBring === 0 && t.already + t.typedLeft === 0 && <p className="imp-line">Nothing to import yet. Fix the rows above, or change a column.</p>}
                {willBring > 0 && (
                  <div className="imp-actions">
                    <button type="button" className="btn btn-primary imp-tap" onClick={() => runImport(0)}>Import {giftWord(willBring)}</button>
                  </div>
                )}
              </div>
            )}

            {imp && (
              <div className="imp-running" role="status" aria-live="polite">
                {imp.phase !== 'done' && <Bar value={imp.sent} max={imp.total} label="Importing" />}
                {imp.phase === 'running' && <p className="imp-line mono">{fmtN(imp.sent)} of {fmtN(imp.total)} · keep this page open</p>}
                {imp.phase === 'error' && (
                  <>
                    <p className="error" role="alert">
                      Stopped part way. {imp.error}{imp.sent > 0 ? ' The gifts before it are saved.' : ''}
                    </p>
                    <div className="imp-actions">
                      <button type="button" className="btn btn-primary imp-tap" onClick={() => runImport(imp.resumeAt)}>Try the rest again</button>
                    </div>
                  </>
                )}
                {imp.phase === 'done' && (
                  <>
                    <p className="imp-done">✓ {giftWord(held?.gifts ?? imp.fresh)} on the books · {fmtMoney(held?.cents ?? 0)}</p>
                    <ul className="gi-after">
                      {(held?.waiting ?? imp.waiting) > 0 && (
                        <li>{plural(held?.waiting ?? imp.waiting, 'gift needs', 'gifts need')} a donor{held ? ` · ${fmtMoney(held.waiting_cents)}` : ''}</li>
                      )}
                      {(held?.flagged ?? imp.flagged) > 0 && <li>{plural(held?.flagged ?? imp.flagged, 'gift is', 'gifts are')} over the year’s limit — under Needs you on Donations</li>}
                      {imp.already > 0 && <li>{plural(imp.already, 'was', 'were')} already here</li>}
                      {imp.typedLeft > 0 && <li>{plural(imp.typedLeft, 'was', 'were')} left out: already typed in here</li>}
                      {file.unpaid.length > 0 && <li>{plural(file.unpaid.length, 'was', 'were')} left out by payment status ({unpaidWords})</li>}
                      {imp.typedIn > 0 && <li>{plural(imp.typedIn, 'looked like a gift', 'looked like gifts')} already typed in here — {imp.typedIn === 1 ? 'it' : 'they'} came in too</li>}
                      <li>No receipts were made or emailed: the other tool did that.</li>
                    </ul>
                    <InvalidList invalid={imp.invalid}
                      intro={`${plural(imp.invalid.length, 'row', 'rows')} skipped. Fix ${imp.invalid.length === 1 ? 'it' : 'them'} and import the file again — nothing is added twice.`} />
                    <div className="imp-actions imp-next">
                      {(held?.waiting ?? imp.waiting) > 0 && <Link className="btn imp-tap" to="/money/import/waiting">Pick the donors</Link>}
                      <Link className="btn imp-tap" to="/money">See Donations</Link>
                    </div>
                    <p className="imp-hint imp-hint--sm">The wrong file? Take it back below — for a day.</p>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </Step>

      <ImportsList />
    </div>
  );
}
