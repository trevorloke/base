// Turn into a list (managers) — Profile fields ?list=<id>: a Text field with
// words on file becomes a Pick one, and no word is lost.
//   Choices: a field with a standard list starts as it ("The standard list
//   — change it if you like") — Dwelling type everywhere, and whatever
//   else this campaign's server sends with GET /fields (standard, by the
//   field's name) — any other field with two empty rows; "+ Add a choice"
//   and ✕ as in a field's editor, up to 40; Show as.
//   What's on file: "12,408 people · 37 different words", then each word
//   (most people first, at most 500) → a choice or "Keep as written",
//   pre-filled by guessChoice (with the server's own guesses, GET /fields
//   guesses); the unguessed come first under "Needs you".
//   One primary "Turn into a list", then "Change 12,408 people? …  Yes · No".
//   While it runs (GET /fields every 2 s, Fields.jsx): a bar, "Turning into a
//   list… 4,000 of 12,408" and a quiet Stop ("Stop? What's done stays
//   done."). Done: "✓ Dwelling type is now a list".
// Words left on "Keep as written" go to "<name> as written" on each profile
// (ext/fields/convert.js makeAsWritten); the server does the rest.
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DWELLING_TYPES, choiceKey, guessChoice } from '@starbase/shared/fieldlists';
import { action, apiGet } from '../api.js';
import { NeedsSignalLine } from '../components/NoSignal.jsx';
import { FIELDS_QUERY } from '../components/FieldsBits.jsx';

const CHOICES_MAX = 40;
// The product's own standard list; a campaign's others come from its server.
const OWN_STANDARD = { 'dwelling type': DWELLING_TYPES };
const listOf = (v) => (Array.isArray(v) && v.length && v.every((c) => typeof c === 'string') ? v : null);
const KEEP = '';
const fmt = (n) => Number(n || 0).toLocaleString('en-CA');
const people = (n) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;

function Choices({ rows, setRows, disabled }) {
  const nextKey = useRef(rows.length);
  return (
    <div className="field sv-choices">
      <span className="sv-label">Choices</span>
      {rows.map((c, i) => (
        <div className="sv-choice" key={c.key}>
          <input className="input" aria-label={`Choice ${i + 1}`} maxLength={80} autoComplete="off" disabled={disabled}
            value={c.words} onChange={(e) => setRows((list) => list.map((x) => (x.key === c.key ? { ...x, words: e.target.value } : x)))} />
          {rows.length > 2 && (
            <button type="button" className="btn btn-quiet sv-choice__x" aria-label={`Remove choice ${i + 1}`} disabled={disabled}
              onClick={() => setRows((list) => list.filter((x) => x.key !== c.key))}>✕</button>
          )}
        </div>
      ))}
      {rows.length < CHOICES_MAX && (
        <button type="button" className="btn btn-quiet ops-tap sv-choice__add" disabled={disabled}
          onClick={() => setRows((list) => [...list, { words: '', key: nextKey.current++ }])}>
          + Add a choice
        </button>
      )}
    </div>
  );
}

function WordRow({ w, to, choices, onPick, disabled }) {
  return (
    <li className="fl-word">
      <span className="fl-word__w">{w.word}</span>
      <span className="fl-word__n mono">{people(w.n)}</span>
      <span className="fl-word__arrow" aria-hidden="true">→</span>
      <select className="input fl-word__to" aria-label={`“${w.word}” becomes`} value={to} disabled={disabled}
        onChange={(e) => onPick(e.target.value)}>
        {choices.map((c) => <option key={c} value={c}>{c}</option>)}
        <option value={KEEP}>Keep as written</option>
      </select>
    </li>
  );
}

// The form, for a field that isn't being turned into a list right now.
// lists: what GET /fields sent beside the fields ({ standard, guesses }).
function Plan({ f, words, online, onStarted, lists }) {
  const nameKey = f.name.trim().toLowerCase();
  const standard = listOf(lists?.standard?.[nameKey]) || OWN_STANDARD[nameKey];
  const guesses = lists?.guesses;
  const [rows, setRows] = useState(() => (standard || ['', '']).map((words, key) => ({ words, key })));
  const choices = rows.map((r) => r.words.trim()).filter(Boolean);
  const [display, setDisplay] = useState(() => ((standard || []).length > 12 || f.name.trim().toLowerCase() === 'dwelling type' ? 'list' : 'buttons'));
  const [picked, setPicked] = useState({}); // word → choice or KEEP, what a person chose
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const list = words.words;
  // Which rows a person must look at: from the standard list, not the
  // choices being typed, so a row doesn't jump while it's being picked.
  const needs = useMemo(() => new Set(list.filter((w) => !guessChoice(f.name, w.word, standard || [], guesses)).map((w) => w.word)), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  // A word that is a choice in any spelling always goes to it (the server does the same).
  const toOf = (w) => {
    const exact = choices.find((c) => choiceKey(c) === choiceKey(w.word));
    if (exact) return exact;
    const p = picked[w.word];
    if (p !== undefined) return p === KEEP || choices.includes(p) ? p : KEEP;
    return guessChoice(f.name, w.word, choices, guesses) || KEEP;
  };
  const toChoices = list.reduce((m, w) => m + (toOf(w) !== KEEP ? w.n : 0), 0);
  const kept = words.people - toChoices;
  const pick = (word, to) => { setConfirm(false); setPicked((p) => ({ ...p, [word]: to })); };
  const off = busy || !online;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('field.list.start', {
        id: f.id, choices, display,
        map: list.map((w) => ({ word: w.word, to: toOf(w) === KEEP ? null : toOf(w) })),
      });
      onStarted();
    } catch (e) {
      setError(e.message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  const rowsFor = (ws) => ws.map((w) => (
    <WordRow key={w.word} w={w} to={toOf(w)} choices={choices} disabled={off} onPick={(to) => pick(w.word, to)} />
  ));
  const needy = list.filter((w) => needs.has(w.word));
  const rest = list.filter((w) => !needs.has(w.word));
  return (
    <>
      {standard && <p className="muted fl-line">The standard list — change it if you like</p>}
      <Choices rows={rows} setRows={(fn) => { setConfirm(false); setRows(fn); }} disabled={off} />
      <div className="field">
        <span className="sv-label" id="fl-show">Show as</span>
        <div className="sv-kinds" role="group" aria-labelledby="fl-show">
          {[['buttons', 'Buttons'], ['list', 'Scroll-down list']].map(([code, label]) => (
            <button key={code} type="button" className="sv-kind" aria-pressed={display === code} disabled={off} onClick={() => setDisplay(code)}>{label}</button>
          ))}
        </div>
      </div>

      <h2 className="fl-h">What’s on file</h2>
      <p className="fl-count">{people(words.people)} · {fmt(words.distinct)} different {words.distinct === 1 ? 'word' : 'words'}</p>
      {needy.length > 0 && (
        <section aria-labelledby="fl-needs">
          <h3 className="fl-h3" id="fl-needs">Needs you</h3>
          <ul className="fl-words">{rowsFor(needy)}</ul>
        </section>
      )}
      {rest.length > 0 && (
        <section aria-label="Guessed">
          {needy.length > 0 && <h3 className="fl-h3">Guessed — check them</h3>}
          <ul className="fl-words">{rowsFor(rest)}</ul>
        </section>
      )}
      {words.rest.distinct > 0 && (
        <p className="muted fl-line">
          and {fmt(words.rest.distinct)} more different {words.rest.distinct === 1 ? 'word' : 'words'} ({people(words.rest.people)}) — kept as written
        </p>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions fl-go" aria-live="polite">
        {confirm ? (
          <span className="ops-confirm" role="group" aria-label="Turn into a list">
            <span>
              Change {people(words.people)}? {fmt(toChoices)} get a choice
              {kept > 0 ? ` · ${fmt(kept)} keep their words in “${f.name} as written”` : ''}.
            </span>
            <button type="button" className="btn ops-tap ops-solid" disabled={off} onClick={start}>{busy ? 'Starting…' : 'Yes'}</button>
            <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setConfirm(false)}>No</button>
          </span>
        ) : (
          <button type="button" className="btn btn-primary ops-tap" disabled={off || choices.length < 2}
            onClick={() => { setError(null); setConfirm(true); }}>
            Turn into a list
          </button>
        )}
      </div>
    </>
  );
}

function Running({ f, online, onStopped }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { done, total } = f.converting;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const stop = async () => {
    setBusy(true);
    try { await action('field.list.stop', { id: f.id }); setConfirm(false); onStopped(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="fl-run">
      <p role="status">Turning into a list… {fmt(done)} of {fmt(total)}</p>
      <div className="fl-bar" role="progressbar" aria-label="Turning into a list" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        {confirm ? (
          <span className="ops-confirm" role="group" aria-label="Stop">
            <span>Stop? What’s done stays done.</span>
            <button type="button" className="btn ops-tap sv-danger" disabled={busy || !online} onClick={stop}>Yes</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
          </span>
        ) : (
          <button type="button" className="btn btn-quiet ops-tap" disabled={!online} onClick={() => setConfirm(true)}>Stop</button>
        )}
      </div>
    </div>
  );
}

export default function FieldToList({ id, fields, online, onBack }) {
  const queryClient = useQueryClient();
  const f = fields.find((x) => x.id === id);
  const [started, setStarted] = useState(false);
  const [stopped, setStopped] = useState(false);
  const isText = f && !f.retired && f.kind === 'text' && !f.as_written_of;
  const words = useQuery({
    queryKey: ['fields', id, 'words'],
    queryFn: () => apiGet(`/fields/${id}/words`),
    enabled: Boolean(isText && !f.converting),
    retry: false,
    staleTime: 0,
  });
  // The lists and guesses that came with the fields (Profile fields has
  // read them already: the same query, no second request).
  const lists = useQuery({ ...FIELDS_QUERY, retry: false }).data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['fields'] });
  // After a Stop the words on file are new: drop the old ones so the form
  // starts from what's there now, not from the copy read before it ran.
  const afterStop = () => { queryClient.removeQueries({ queryKey: ['fields', id, 'words'] }); setStopped(true); setStarted(false); refresh(); };
  const head = (
    <>
      <button type="button" className="ops-back fl-back" onClick={onBack}>← Profile fields</button>
      <div className="ops-head"><h1>{f ? `Turn “${f.name}” into a list` : 'Turn into a list'}</h1></div>
      {!online && <NeedsSignalLine>Changing fields needs signal</NeedsSignalLine>}
    </>
  );
  let body;
  if (!f) body = <p className="muted">That field isn’t here any more.</p>;
  else if (f.kind === 'choice' && started) body = <p className="ops-done" role="status">✓ {f.name} is now a list</p>;
  else if (f.converting) body = <Running f={f} online={online} onStopped={afterStop} />;
  else if (f.kind === 'choice') body = <p className="ops-done" role="status">✓ {f.name} is a list</p>;
  else if (!isText) body = <p className="muted">Only a Text field can be turned into a list.</p>;
  else if (started) body = <p className="muted" role="status">Turning into a list…</p>;
  else if (words.isPending) body = <p className="muted">Loading…</p>;
  else if (words.isError) {
    body = (
      <p className="error" role="alert">
        {words.error.status === 409 ? words.error.message : 'Unavailable — '}
        {words.error.status !== 409 && <button type="button" className="btn btn-quiet" onClick={() => words.refetch()}>Try again</button>}
      </p>
    );
  } else {
    body = (
      <>
        {stopped && <p className="ops-done" role="status">Stopped — what was done stays done. Turn into a list again to finish.</p>}
        {/* Keyed on the field, not the read: a reload of the words (every
            refetch) updates the counts and never wipes what's been picked. */}
        <Plan key={f.id} f={f} words={words.data} online={online} lists={lists}
          onStarted={() => { setStarted(true); setStopped(false); refresh(); }} />
      </>
    );
  }
  return <div className="ops-page fd-page fl-page">{head}{body}</div>;
}
