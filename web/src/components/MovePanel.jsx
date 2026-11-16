// "Where did Ana go?" — after a Moved tap (the door card, the walk list, the
// profile), one more choice: a new address, or Address unknown (person.move,
// server/ext/moves). Not a modal: it opens in place under the outcome row,
// and the screen under it holds still until it closes (onClose).
//
//   <MovePanel person desk contactClientId mode oldDoor where toast onClose />
//     person   { id, name, address, unit, city } as it was before the move
//     desk     the desk's words and tools (person.create, Someone on file)
//     mode     'tap' (after a Moved tap) · 'whereTo' (the profile's "Where
//              to?") · 'add' (Address unknown → "Add new address": New
//              address already chosen, no "Did anyone else move?")
//     oldDoor  the door's own people [{ id, name, rating }] — who is still
//              at the old address when there's no signal to ask
//     where    'door' ("— off this door" in the toast) or 'profile'
//     toast(text, tone)   tone: 'ok' | 'queued' | 'error'
//     onClose({ sent, moved })   sent: something reached the server with
//              signal; moved: the ids of others moved from here meanwhile
//
// After Save: who lives at the new address now (Still here · Moved out, +
// Someone else lives here, and at the desk Someone on file lives here), and
// who is still at the old one (Still here · Moved too). Each tap is its own
// action, sent at once (through the outbox). A row's "Moved out" opens one
// small panel of its own — New address or Address unknown, and Save — that
// folds back into the row; it never opens another.
import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import AddressField, { pinOf } from './AddressField.jsx';
import { apiGet } from '../api.js';
import { queueAction, queueMove, refusedText, useOutbox } from '../offline.js';
import { useOnline } from './NoSignal.jsx';
import { RatingChip } from './RatingButtons.jsx';
import PersonResults from './PersonResults.jsx';
import { usePersonSearch } from './usePersonSearch.js';
import { queuedSaid } from './queued.js';
import './move.css';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// "13450 104 Ave #4" — the street line as the door shows it.
const lineOf = (a) => [a?.address, a?.unit ? `#${a.unit}` : null].filter(Boolean).join(' ');
const OFFICE = 'The office will finish this one — thanks';
const OFFICE_MS = 4000;

// The choice and the address: shared by the panel and a row's "Moved out".
// onSave(input) → a promise of an error sentence, or null when it's saved.
function WhereForm({ who, city, onSave, onLater = null, only = null, idPrefix }) {
  const online = useOnline();
  const qid = useId();
  const [choice, setChoice] = useState(only);
  const [form, setForm] = useState({ address: '', unit: '', city: city || '', postal: '' });
  const [pin, setPin] = useState(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const first = firstName(who);
  const ready = choice === 'unknown' || (choice === 'new' && form.address.trim());
  const save = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const to = {
      address: form.address.trim(),
      unit: form.unit.trim() || undefined,
      city: form.city.trim() || undefined,
      postal: form.postal.trim() || undefined,
      // The pick's pin, whatever gave it: the server decides whether it stays.
      ...(pin ? { lat: pin.lat, lng: pin.lng } : {}),
    };
    const err = await onSave(choice === 'unknown' ? { unknown: true } : { to });
    if (err) { setError(err); setBusy(false); }
  };
  return (
    <form className="mv-where" onSubmit={save} aria-labelledby={qid}>
      <p className="mv-q" id={qid}>Where did {first || 'they'} go?</p>
      {!only && (
        <div className="mv-choices" role="group" aria-labelledby={qid}>
          <button type="button" className="btn mv-choice" aria-pressed={choice === 'new'} onClick={() => setChoice('new')}>New address</button>
          <button type="button" className="btn mv-choice" aria-pressed={choice === 'unknown'} onClick={() => setChoice('unknown')}>Address unknown</button>
        </div>
      )}
      {choice === 'new' && (
        <div className="mv-fields">
          <AddressField id={`${idPrefix}-address`} value={form.address} placed={Boolean(pin)} autoFocus
            hint={online ? 'Found on the map when you save' : 'Saved on this phone — placed on the map once it sends'}
            onChange={(v) => { setForm((f) => ({ ...f, address: v })); setPin(null); }}
            onPick={(a) => {
              setForm((f) => ({ ...f, address: a.address || f.address, unit: a.unit || f.unit, city: a.city || f.city, postal: a.postal || f.postal }));
              setPin(pinOf(a));
            }} />
          <div className="mv-row2">
            <div className="field">
              <label htmlFor={`${idPrefix}-unit`}>Unit</label>
              <input id={`${idPrefix}-unit`} className="input" maxLength={20} autoComplete="off" value={form.unit} onChange={set('unit')} />
            </div>
            <div className="field">
              <label htmlFor={`${idPrefix}-city`}>City</label>
              <input id={`${idPrefix}-city`} className="input" maxLength={80} autoComplete="off" value={form.city} onChange={set('city')} />
            </div>
          </div>
          {more ? (
            <div className="field mv-postal">
              <label htmlFor={`${idPrefix}-postal`}>Postal code</label>
              <input id={`${idPrefix}-postal`} className="input mono" maxLength={10} autoComplete="off" value={form.postal} onChange={set('postal')} />
            </div>
          ) : (
            <button type="button" className="disclose disclose--inline mv-more" aria-expanded={false} onClick={() => setMore(true)}>More</button>
          )}
        </div>
      )}
      {choice === 'unknown' && (
        <p className="mv-hint">{first || 'They'} comes off this door and the walk list. The office keeps the old address.</p>
      )}
      {error && <p className="error mv-error" role="alert">{error}</p>}
      <div className="mv-acts">
        <button type="submit" className="btn btn-primary mv-act" disabled={!ready || busy}>{busy ? 'Saving…' : 'Save'}</button>
        {onLater && <button type="button" className="btn btn-quiet mv-act" onClick={onLater}>Later</button>}
      </div>
    </form>
  );
}

// What a saved move says: "Moved · 9800 King George Blvd" or "Address unknown".
const movedWords = (input) => (input.unknown ? 'Address unknown' : `Moved · ${lineOf(input.to)}`);

// One move, through the outbox. → { ok, queued, result, error, office }
async function sendMove(input, who) {
  try {
    const r = await queueMove(input, { who });
    return { ok: true, queued: r.queued, result: r.result, cid: r.client_id, r };
  } catch (err) {
    return { ok: false, error: err.message || 'Not saved — try again', office: err.status === 403 };
  }
}

// GET /api/moves/door once a move saved with no signal has gone.
function useDoorLists(personId, cid, enabled) {
  const outbox = useOutbox();
  const [state, setState] = useState({ status: 'waiting', data: null, refused: null });
  const [tick, setTick] = useState(0);
  const item = cid ? outbox.items.find((i) => i.cid === cid) : null;
  const gone = enabled && cid && !item;
  const refused = item?.state === 'refused' ? refusedText(item) : null;
  useEffect(() => {
    if (!gone) return undefined;
    let live = true;
    setState({ status: 'loading', data: null });
    apiGet(`/moves/door?person=${personId}`)
      .then((data) => { if (live) setState({ status: 'ok', data }); })
      .catch(() => { if (live) setState({ status: 'error', data: null }); });
    return () => { live = false; };
  }, [gone, personId, tick]);
  return { ...state, status: refused ? 'refused' : gone ? state.status : 'waiting', refused, retry: () => setTick((t) => t + 1) };
}

export default function MovePanel({
  person, desk = false, contactClientId = null, mode = 'tap', oldDoor = [], where = 'door', toast = () => {}, onClose,
}) {
  const [phase, setPhase] = useState('ask'); // ask · lists · office
  const [saved, setSaved] = useState(null); // { input, result | null, cid, queued }
  const [rowOpen, setRowOpen] = useState(null); // the row whose "Moved out" is open
  const sent = useRef(false);
  const movedIds = useRef([]); // others who moved too (Moved out, Moved too)
  const closed = useRef(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    clearTimeout(timer.current);
    onClose?.({ sent: sent.current, moved: movedIds.current });
  };
  const first = firstName(person.name);
  const was = lineOf(person);

  const onSave = async (choice) => {
    const input = { person_id: person.id, ...choice, ...(contactClientId ? { contact_client_id: contactClientId } : {}) };
    const r = await sendMove(input, person.name);
    if (!r.ok) {
      if (r.office) {
        setPhase('office');
        timer.current = setTimeout(close, OFFICE_MS);
        return null;
      }
      return r.error;
    }
    if (!r.queued) sent.current = true;
    const what = movedWords(input);
    const tail = where === 'door' ? ' — off this door' : '';
    toast(r.queued ? queuedSaid(r.r, what) : `${what}${tail}`, r.queued ? 'queued' : 'ok');
    const res = r.result;
    // With signal: the server's lists. With none: the door's own people for
    // the old address, and the new one once it has gone.
    const left = mode === 'add' ? [] : (res ? res.left : oldDoor.filter((p) => p.id !== person.id));
    const any = input.unknown
      ? left.length > 0
      : res ? (res.there !== null || res.there_hidden || left.length > 0) : true;
    if (!any) { close(); return null; }
    setSaved({ input, result: res, cid: r.cid, queued: r.queued, left });
    setPhase('lists');
    return null;
  };

  return (
    <section className="mv-panel" aria-label={`Where did ${first || 'they'} go?`}>
      {phase === 'ask' && (
        <WhereForm who={person.name} city={person.city} idPrefix={`mv-${person.id.slice(0, 8)}`}
          only={mode === 'add' ? 'new' : null} onSave={onSave} onLater={close} />
      )}
      {phase === 'office' && <p className="mv-office" role="status">{OFFICE}</p>}
      {phase === 'lists' && saved && (
        <Lists person={person} desk={desk} saved={saved} was={was} mode={mode}
          rowOpen={rowOpen} setRowOpen={setRowOpen} onSent={() => { sent.current = true; }} toast={toast}
          onMoved={(id) => { movedIds.current = [...movedIds.current, id]; }} />
      )}
      {phase === 'lists' && rowOpen == null && (
        <div className="mv-acts">
          <button type="button" className="btn btn-primary mv-act" onClick={close}>Done</button>
        </div>
      )}
    </section>
  );
}

// "Who lives at 9800 King George Blvd now?" and "Did anyone else move from …?"
function Lists({ person, desk, saved, was, mode, rowOpen, setRowOpen, onSent, onMoved, toast }) {
  const { input } = saved;
  const unknown = Boolean(input.unknown);
  // Saved with no signal: the lists come once the outbox has sent it.
  const later = useDoorLists(person.id, saved.cid, saved.queued);
  const res = saved.result || (later.status === 'ok' ? later.data : null);
  const left = res && mode !== 'add' ? res.left : saved.left;
  return (
    <div className="mv-lists" aria-live="polite">
      {!unknown && (
        <There person={person} desk={desk} input={input} res={res} later={saved.result ? null : later}
          rowOpen={rowOpen} setRowOpen={setRowOpen} onSent={onSent} toast={toast} />
      )}
      {left.length > 0 && (
        <Left rows={left} was={was} input={input} onSent={onSent} onMoved={onMoved} />
      )}
    </div>
  );
}

// A row's own state: 'here' (Still here, nothing written) or what was sent.
function useRows() {
  const [rows, setRows] = useState({}); // id → { said, busy, error }
  const patch = (id, v) => setRows((m) => ({ ...m, [id]: { ...m[id], ...v } }));
  return [rows, patch];
}

function There({ person, desk, input, res, later, rowOpen, setRowOpen, onSent, toast }) {
  // The city the server kept when none was typed: the people added or moved
  // here get the same one, so they're found at this address.
  const to = { ...input.to, city: input.to.city || res?.person?.city || person.city || undefined };
  const [rows, patch] = useRows();
  const [added, setAdded] = useState([]); // [{ id, name, said }] added or moved in here
  const [adding, setAdding] = useState(null); // 'new' | 'file'
  const head = `Who lives at ${lineOf(to)} now?`;
  if (!res) {
    return (
      <section className="mv-list">
        <h3 className="mv-h">{head}</h3>
        {later?.status === 'refused' ? <p className="error" role="alert">{later.refused}</p>
          : later?.status === 'loading' ? <p className="mv-line" role="status">Loading…</p>
            : later?.status === 'error' ? (
              <p className="mv-line" role="alert">Unavailable — <button type="button" className="fk-link" onClick={later.retry}>Try again</button></p>
            ) : <p className="mv-line">Shown when you have signal</p>}
      </section>
    );
  }
  if (res.there_hidden) {
    return (
      <section className="mv-list">
        <h3 className="mv-h">{head}</h3>
        <p className="mv-line">The office will check who else lives there.</p>
      </section>
    );
  }
  const there = res.there || [];
  const taken = new Set([person.id, ...there.map((p) => p.id), ...added.map((p) => p.id)]);
  const housemate = there.find((p) => p.has_pin);
  const movedOut = async (p, choice) => {
    const r = await sendMove({ person_id: p.id, ...choice }, p.name);
    if (!r.ok) return r.error;
    if (!r.queued) onSent();
    patch(p.id, { said: choice.unknown ? 'moved · Address unknown' : `moved · ${lineOf(choice.to)}` });
    setRowOpen(null);
    return null;
  };
  return (
    <section className="mv-list">
      <h3 className="mv-h">{head}</h3>
      {there.length === 0 && added.length === 0 && <p className="mv-line">No one else on file at this address.</p>}
      <ul className="mv-rows">
        {there.map((p) => {
          const row = rows[p.id] || {};
          const open = rowOpen === p.id;
          return (
            <li key={p.id} className="mv-person">
              <div className="mv-person__top">
                <span className="mv-name">{row.said ? `${firstName(p.name)} · ${row.said}` : p.name}</span>
                {p.rating && <RatingChip code={p.rating} who />}
              </div>
              {!row.said && (
                <div className="mv-seg" role="group" aria-label={`Does ${p.name} still live here?`}>
                  <button type="button" className="btn mv-segbtn" aria-pressed={!open} disabled={rowOpen != null && !open}
                    onClick={() => setRowOpen(null)}>Still here</button>
                  <button type="button" className="btn mv-segbtn" aria-pressed={open} disabled={rowOpen != null && !open}
                    onClick={() => setRowOpen(p.id)}>Moved out</button>
                </div>
              )}
              {open && (
                <div className="mv-sub">
                  <WhereForm who={p.name} city={to.city || person.city} idPrefix={`mv-row-${p.id.slice(0, 8)}`}
                    onSave={(choice) => movedOut(p, choice)} />
                </div>
              )}
            </li>
          );
        })}
        {added.map((p) => (
          <li key={p.id} className="mv-person">
            <div className="mv-person__top"><span className="mv-name">{p.name} · {p.said}</span></div>
          </li>
        ))}
      </ul>
      {rowOpen == null && (adding === 'new' ? (
        <AddHere desk={desk} to={to} housemate={housemate} onCancel={() => setAdding(null)} toast={toast}
          onDone={(p, viaServer) => { if (viaServer) onSent(); setAdded((a) => [...a, { ...p, said: 'added' }]); setAdding(null); }} />
      ) : adding === 'file' ? (
        <OnFile person={person} to={to} taken={taken} onCancel={() => setAdding(null)}
          onDone={(p, viaServer) => { if (viaServer) onSent(); setAdded((a) => [...a, { id: p.id, name: p.name, said: 'moved here' }]); setAdding(null); }} />
      ) : (
        <div className="mv-adds">
          {desk || housemate
            ? <button type="button" className="btn btn-quiet mv-act" onClick={() => setAdding('new')}>+ Someone else lives here</button>
            : <p className="mv-line">You can add people here once it’s on the map.</p>}
          {desk && <button type="button" className="btn btn-quiet mv-act" onClick={() => setAdding('file')}>Someone on file lives here</button>}
        </div>
      ))}
    </section>
  );
}

// "+ Someone else lives here": the desk adds a person at the new address
// (person.create); a volunteer adds a housemate of someone there with a pin
// (person.addAtDoor — it copies their address and pin).
function AddHere({ desk, to, housemate, onCancel, onDone, toast }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ first: '', last: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const id = useId();
  const submit = async (e) => {
    e.preventDefault();
    const name = [form.first, form.last].map((x) => x.trim()).filter(Boolean).join(' ');
    if (!name) { setError('Add a name'); return; }
    setBusy(true);
    setError(null);
    const who = { name, first_name: form.first.trim() || undefined, last_name: form.last.trim() || undefined, phone: form.phone.trim() || undefined };
    try {
      const r = desk
        ? await queueAction('person.create', {
          ...who, address: to.address, unit: to.unit, city: to.city, postal: to.postal,
          ...(to.lat != null ? { lat: to.lat, lng: to.lng } : {}),
        }, { who: name })
        : await queueAction('person.addAtDoor', { ...who, housemate_id: housemate.id }, { who: name });
      if (r.queued) toast(queuedSaid(r, `Added ${name}`), 'queued');
      else { toast(`Added ${name}`, 'ok'); queryClient.invalidateQueries({ queryKey: ['persons'] }); }
      onDone({ id: r.client_id || r.result?.person?.id, name }, !r.queued);
    } catch (err) {
      setError(err.message || 'Not saved — try again');
      setBusy(false);
    }
  };
  return (
    <form className="mv-add" onSubmit={submit} aria-label="Someone else lives here">
      <div className="mv-row2">
        <div className="field">
          <label htmlFor={`${id}-first`}>First name</label>
          <input id={`${id}-first`} className="input" maxLength={150} autoFocus autoComplete="off" value={form.first} onChange={set('first')} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-last`}>Last name</label>
          <input id={`${id}-last`} className="input" maxLength={150} autoComplete="off" value={form.last} onChange={set('last')} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-phone`}>Phone</label>
        <input id={`${id}-phone`} className="input" type="tel" maxLength={40} autoComplete="off" value={form.phone} onChange={set('phone')} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="mv-acts">
        <button type="submit" className="btn mv-act" disabled={busy}>Save person</button>
        <button type="button" className="btn btn-quiet mv-act" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// The desk's "Someone on file lives here": find them (A–Z, PS's search) and
// move them here, to the same address. Someone already here can't be picked.
function OnFile({ person, to, taken, onCancel, onDone }) {
  const online = useOnline();
  const boxRef = useRef(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const search = usePersonSearch(q, { limit: 25, not: person.id });
  const pick = async (p) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await sendMove({ person_id: p.id, to }, p.name);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone(p, !r.queued);
  };
  return (
    <div className="mv-onfile">
      <label className="mv-q" htmlFor={id}>Who lives here?</label>
      <input id={id} ref={boxRef} className="input" type="search" autoFocus autoComplete="off" placeholder="Name, phone or email"
        value={q} onChange={(e) => setQ(e.target.value)} />
      {online
        ? <PersonResults search={search} boxRef={boxRef} onPick={pick} taken={taken} takenLabel="Already lives here" desk />
        : <p className="mv-line">Searching needs signal</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="mv-acts">
        <button type="button" className="btn btn-quiet mv-act" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// "Did anyone else move from 13450 104 Ave?" — Still here · Moved too, one
// tap each: the same new address (or Address unknown).
function Left({ rows: people, was, input, onSent, onMoved }) {
  const [rows, patch] = useRows();
  const too = async (p) => {
    patch(p.id, { busy: true, error: null });
    const r = await sendMove({ person_id: p.id, ...(input.unknown ? { unknown: true } : { to: input.to }) }, p.name);
    if (!r.ok) { patch(p.id, { busy: false, error: r.error }); return; }
    if (!r.queued) onSent();
    onMoved(p.id);
    patch(p.id, { busy: false, said: input.unknown ? 'moved · Address unknown' : 'moved too' });
  };
  return (
    <section className="mv-list">
      <h3 className="mv-h">Did anyone else move{was ? ` from ${was}` : ''}?</h3>
      <ul className="mv-rows">
        {people.map((p) => {
          const row = rows[p.id] || {};
          return (
            <li key={p.id} className="mv-person">
              <div className="mv-person__top">
                <span className="mv-name">{row.said ? `${firstName(p.name)} · ${row.said}` : p.name}</span>
                {p.rating && <RatingChip code={p.rating} who />}
              </div>
              {!row.said && (
                <div className="mv-seg" role="group" aria-label={`Did ${p.name} move too?`}>
                  <button type="button" className="btn mv-segbtn" aria-pressed="true" disabled={row.busy}>Still here</button>
                  <button type="button" className="btn mv-segbtn" aria-pressed="false" disabled={row.busy} onClick={() => too(p)}>Moved too</button>
                </div>
              )}
              {row.error && <p className="error" role="alert">{row.error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
