// People you know (/my-people/contacts, the desk: managers, staff and
// treasurers holding People). A contacts file exported from Google (or
// Outlook, or a phone saved as CSV) is read here in the browser
// (components/csv.js, then shared/contactsfile.js: a name, one email and one
// phone a contact — nothing else is read), checked against the list in
// slices of 500 (POST /api/addressbook/check, which answers matches only),
// and only the people already on the list are shown. The rest never leave
// this screen and aren't kept. Tick the ones you really know; "Add 12 to My
// people" links them to you (addressbook.link, slices of 200) and changes
// nothing else about them. Leaving the screen forgets the file.
import { useRef, useState } from 'react';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { readContacts } from '@starbase/shared/contactsfile';
import { action, apiPost, ApiError } from '../api.js';
import { adminHref } from '../mode.js';
import { hasArea, isDesk } from '../Shell.jsx';
import { decodeBytes, isSpreadsheetBinary, readTable, shapeTable } from '../components/csv.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import { RatingChip } from '../components/RatingButtons.jsx';
import { MINE_KEY } from '../components/RelationshipsBits.jsx';
import './shifts.css';
import './addressbook.css';

const CHECK_SLICE = 500;
const LINK_SLICE = 200;
const CONTACTS = { one: 'contact', many: 'contacts' };
const NOT_CONTACTS = 'That isn’t a contacts file. Export Google CSV and try again.';
const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');

// The file → { rows, unusable, total } or { error }.
export async function readContactsFile(file, progress) {
  const buf = await file.arrayBuffer();
  if (isSpreadsheetBinary(buf, file.name)) return { error: NOT_CONTACTS };
  const t = await readTable(decodeBytes(buf), progress, CONTACTS);
  if (t.error) return t;
  const shaped = shapeTable(t.all, true, CONTACTS);
  if (shaped.error) return shaped;
  const read = readContacts(shaped);
  if (read.error) return read;
  // Not one usable contact, and none of the columns a contacts file has.
  if (!read.rows.length) return { error: NOT_CONTACTS };
  return read;
}

export default function AddressBook() {
  const { me } = useOutletContext() ?? {};
  if (!isDesk(me) || me?.candidate || !hasArea(me, 'people')) return <Navigate to="/my-people" replace />;
  return <Finder />;
}

function Finder() {
  const qc = useQueryClient();
  const online = useOnline();
  const fileRef = useRef(null);
  const [phase, setPhase] = useState('start'); // start · reading · checking · results
  const [error, setError] = useState(null);
  const [read, setRead] = useState(null); // { rows, unusable, total } while checking
  const [progress, setProgress] = useState(0);
  const [checkedN, setCheckedN] = useState(0);
  const [failed, setFailed] = useState(null); // the slice to try again
  const [found, setFound] = useState([]); // [{ person, how, mine, email }]
  const [total, setTotal] = useState(0);
  const [matched, setMatched] = useState(0);
  const [ticked, setTicked] = useState(() => new Set());
  const [adding, setAdding] = useState(null); // { done, total }
  const [skipped, setSkipped] = useState([]); // [{ person, why }]
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const say = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  };

  // Slices one after another, from `from`; matches gathered as they come. A
  // failed slice stops here and is tried again on its own.
  const check = async (data, from, have) => {
    setPhase('checking'); setFailed(null); setError(null);
    const byPerson = new Map(have.map((f) => [f.person.id, f]));
    for (let at = from; at < data.rows.length; at += CHECK_SLICE) {
      const slice = data.rows.slice(at, at + CHECK_SLICE);
      try {
        const r = await apiPost('/addressbook/check', {
          rows: slice.map(({ ref, name, email, phone }) => ({ ref, name, ...(email ? { email } : {}), ...(phone ? { phone } : {}) })),
        });
        for (const m of r.rows || []) {
          // Contacts that match the same person show once.
          if (byPerson.has(m.person.id)) continue;
          const contact = data.rows.find((x) => x.ref === m.ref);
          byPerson.set(m.person.id, { person: m.person, how: m.how, mine: m.mine, email: contact?.email || null });
        }
        setCheckedN(Math.min(data.rows.length, at + slice.length));
      } catch (err) {
        const list = [...byPerson.values()];
        setFound(list);
        if (err instanceof ApiError && err.status === 429) { setError(err.message); setPhase('start'); setRead(null); return; }
        if (err instanceof ApiError && err.status < 500) { setError(err.message); setPhase('start'); setRead(null); return; }
        setFailed({ at, list, offline: !(err instanceof ApiError) });
        return;
      }
    }
    // Done: the contacts themselves are dropped; only the matches stay.
    setFound([...byPerson.values()]);
    setMatched(byPerson.size);
    setRead(null);
    setPhase('results');
  };

  const choose = async (file) => {
    if (!file) return;
    setError(null); setFailed(null); setSkipped([]); setFound([]); setTicked(new Set()); setProgress(0); setCheckedN(0);
    setPhase('reading');
    let data;
    try {
      data = await readContactsFile(file, setProgress);
    } catch {
      data = { error: NOT_CONTACTS };
    }
    if (fileRef.current) fileRef.current.value = '';
    if (data.error) { setError(data.error); setPhase('start'); return; }
    setTotal(data.total);
    setRead(data);
    await check(data, 0, []);
  };

  const open = found.filter((f) => !f.mine);
  const tickable = open.map((f) => f.person.id);
  const toggle = (id) => setTicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const add = async () => {
    const ids = tickable.filter((id) => ticked.has(id));
    if (!ids.length) return;
    setError(null);
    setAdding({ done: 0, total: ids.length });
    let linked = 0;
    let already = 0;
    const done = new Set();
    const left = [];
    try {
      for (let at = 0; at < ids.length; at += LINK_SLICE) {
        const slice = ids.slice(at, at + LINK_SLICE);
        const r = await action('addressbook.link', { person_ids: slice });
        linked += r.linked || 0;
        already += r.already || 0;
        const bad = new Map((r.skipped || []).map((s) => [slice[s.index], s.why]));
        for (const id of slice) {
          if (bad.has(id)) left.push({ person: found.find((f) => f.person.id === id)?.person, why: bad.get(id) });
          else done.add(id);
        }
        setAdding({ done: Math.min(ids.length, at + slice.length), total: ids.length });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No answer — check your signal. Nothing more was added.');
    } finally {
      setAdding(null);
      // Added (or already there) rows leave the list; skipped ones say why.
      setFound((list) => list.filter((f) => !done.has(f.person.id)));
      setTicked((s) => new Set([...s].filter((id) => !done.has(id))));
      setSkipped((s) => [...s, ...left.filter((x) => x.person)]);
      if (done.size) {
        say(`Added ${fmtN(linked)}${already ? ` · Already there ${fmtN(already)}` : ''}`);
        qc.invalidateQueries({ queryKey: MINE_KEY });
      }
    }
  };

  const nTicked = tickable.filter((id) => ticked.has(id)).length;
  // A check that failed waits on Try again, but another file can be chosen.
  const busy = phase === 'reading' || (phase === 'checking' && !failed) || Boolean(adding);
  const picker = (
    <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="ab-file" tabIndex={-1} aria-hidden="true"
      onChange={(e) => choose(e.target.files?.[0])} />
  );

  return (
    <div className="ops-page ab-page">
      <Link className="ops-back" to="/my-people">← My people</Link>
      <div className="ops-head">
        <h1>People you know</h1>
        {phase === 'results' && !adding && found.length > 0 ? (
          <button type="button" className="btn btn-primary ops-tap" disabled={!nTicked || !online} onClick={add}>
            Add {fmtN(nTicked)} to My people
          </button>
        ) : phase !== 'results' && (
          <button type="button" className="btn btn-primary ops-tap" disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose file
          </button>
        )}
      </div>
      {picker}

      {phase === 'start' && (
        <div className="ab-steps">
          <ol className="ab-how">
            <li>On a computer, open contacts.google.com</li>
            <li>Choose Export, then Google CSV</li>
            <li>Choose the file here</li>
          </ol>
          <p className="ab-promise">We only show people already on our list. The rest never leave this screen.</p>
          <p className="ab-other muted">Other contacts files work too (CSV)</p>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div role="status" aria-live="polite" className="ab-status">
        {phase === 'reading' && <p className="ab-line">Loading… {progress > 0 ? `${Math.round(progress * 100)}%` : ''}</p>}
        {phase === 'checking' && read && !failed && (
          <>
            {/* The contacts already answered, of those with something to match. */}
            <p className="ab-line">Checking {fmtN(checkedN)} of {fmtN(read.rows.length)} {read.rows.length === 1 ? 'contact' : 'contacts'}…</p>
            {read.total > read.rows.length && (
              <p className="ab-line muted">{fmtN(read.total - read.rows.length)} had no email or phone to match</p>
            )}
          </>
        )}
        {adding && <p className="ab-line">Adding {fmtN(Math.min(adding.total, adding.done + LINK_SLICE))} of {fmtN(adding.total)}…</p>}
      </div>

      {failed && (
        failed.offline && !online ? <NeedsSignal className="ab-line">Checking needs signal — try again when you’re back online</NeedsSignal> : null
      )}
      {failed && (
        <p className="ab-line">Unavailable — <button type="button" className="btn btn-quiet" disabled={!online}
          onClick={() => check(read, failed.at, failed.list)}>Try again</button></p>
      )}

      {phase === 'results' && (
        <>
          <p className="ab-count"><strong>{fmtN(matched)}</strong> on our list</p>
          <p className="ab-sub muted">of {fmtN(total)} {total === 1 ? 'contact' : 'contacts'} · the rest aren’t kept</p>

          {skipped.length > 0 && (
            <ul className="ops-rows ab-rows">
              {skipped.map((s) => (
                <li key={`skip-${s.person.id}`} className="ops-item ab-skip">
                  <span className="ab-row">
                    <span className="ab-row__main"><span className="ops-row__name">{s.person.name}</span>
                      <span className="ops-row__sub">{s.why}</span></span>
                    <span className="chip chip-warn">Not added</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {open.length > 1 && (
            <div className="ab-ticks">
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setTicked(new Set(tickable))}>Tick all {fmtN(open.length)}</button>
              <button type="button" className="btn btn-quiet" disabled={busy || !nTicked} onClick={() => setTicked(new Set())}>Untick all</button>
            </div>
          )}

          {found.length > 0 && (
            <ul className="ops-rows ab-rows" aria-label="On our list">
              {found.map((f) => {
                const p = f.person;
                const where = [p.unit && `${p.unit}-`, p.address].filter(Boolean).join('') || f.email;
                const id = `ab-${p.id}`;
                return (
                  <li key={p.id} className="ops-item">
                    <div className="ab-row">
                      {f.mine ? <span className="ab-box ab-box--none" aria-hidden="true" /> : (
                        <label className="ab-box" htmlFor={id}>
                          <input id={id} type="checkbox" checked={ticked.has(p.id)} disabled={busy} onChange={() => toggle(p.id)}
                            aria-label={`Add ${p.name} to My people`} />
                        </label>
                      )}
                      <span className="ab-row__main">
                        <a className="ops-row__name ab-name" href={adminHref(`/people/${p.id}`)} target="_blank" rel="noopener noreferrer">{p.name}</a>
                        {where && <span className="ops-row__sub">{where}</span>}
                      </span>
                      <span className="ab-row__end">
                        {f.mine ? <span className="chip">In My people</span> : <RatingChip code={p.rating} who />}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {matched === 0 && <p className="ops-empty">Nobody in this file is on our list.</p>}

          <p className="ab-again">
            <Link className="btn btn-quiet" to="/my-people">Back to My people</Link>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => fileRef.current?.click()}>Choose another file</button>
          </p>
        </>
      )}

      {toast && <div className="toast ab-toast" aria-hidden="true">{toast}</div>}
      <p className="ab-sr" role="status" aria-live="polite">{toast}</p>
    </div>
  );
}
