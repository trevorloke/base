// AddressField — one "Address" box that knows where addresses are.
//   <AddressField id label value onChange onPick placed required autoFocus />
//   value: the civic line as typed ("13450 104 Ave"). As someone types (3+
//   characters, with signal) it offers up to five doors under the box: the
//   campaign's own doors first ("On the map"), then the address service's
//   (GET /api/address/suggest — ext/addresses). Arrow keys or a tap pick
//   one: onPick({ address, unit, city, postal, lat, lng, label }) — the
//   form fills in and takes the pin. Typing again after a pick asks again.
//   placed: whether the form holds a pin for this address (says so below,
//   in placedText's words).
//   hint: the line below when there is no pin (each form says what happens
//   then: "Found on the map when you save", "Tap the map where it is").
//   allowGoogle: false asks for rows that carry a pin (nogoogle=1) — the map's
//   New door over a map that isn't Google's (Google's rows go only with its map).
// Google's rows (only when the server answers by: 'google', which needs
//   ADDRESS_SUGGEST=google): words with no pin, Google's logo after the list.
//   Picking one asks /address/place (up to 5 s) for its parts and B.C.'s pin
//   — lat null when B.C. couldn't place it. One Google session from the first
//   letter typed to a pick (or the box left with nothing picked).
// lookupAddress(line) — the same suggestions, for a form saving a typed
// address nobody picked: the first door whose number and street match.
import { useEffect, useId, useRef, useState } from 'react';
import { apiGet } from '../api.js';
import { at } from '../base.js';
import { useOnline } from './NoSignal.jsx';
import './address-field.css';

const WAIT_MS = 250;
const norm = (s) => String(s || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

const PICK_MS = 5000;
const ask = (q, { session = null, google = true } = {}) => apiGet(`/address/suggest?q=${encodeURIComponent(q)}${session ? `&session=${session}` : ''}${google ? '' : '&nogoogle=1'}`);
// A v4 id for Google's session (crypto.randomUUID needs a secure page).
const newSession = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const PICK_FAILED = 'Couldn’t get that address — ';

export async function lookupAddress(line) {
  const q = String(line || '').trim();
  if (q.length < 3) return null;
  try {
    const r = await ask(q, { google: false }); // a row with a pin, never Google's words
    const want = norm(q);
    return (r.suggestions || []).find((s) => norm(s.address) === want || norm(s.label).startsWith(want)) || null;
  } catch {
    return null;
  }
}

export default function AddressField({
  id, label = 'Address', value, onChange, onPick, placed = false, hint = null, required = false, autoFocus = false,
  placeholder = '13450 104 Ave', disabled = false, placedText = 'Pinned on the map', allowGoogle = true,
}) {
  const online = useOnline();
  const listId = useId();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [state, setState] = useState('idle'); // idle | loading | done | unavailable | pickFailed
  const [by, setBy] = useState(null); // who gave the outside rows ('google' draws Google's logo)
  const [picking, setPicking] = useState(-1); // the Google row being fetched
  const typed = useRef(false); // only typing asks (a pick or a prefilled value doesn't)
  const seq = useRef(0);
  const session = useRef(null);
  const googleOk = useRef(allowGoogle);
  googleOk.current = allowGoogle;

  useEffect(() => {
    if (!typed.current) return undefined;
    const q = String(value || '').trim();
    if (q.length < 3 || !online) { setItems([]); setOpen(false); setState('idle'); return undefined; }
    const n = ++seq.current;
    setState('loading');
    const t = setTimeout(async () => {
      try {
        const r = await ask(q, { session: session.current, google: googleOk.current });
        if (n !== seq.current) return; // a newer question is out
        setItems(r.suggestions || []);
        setBy(r.by || null);
        setActive(-1);
        setOpen(true);
        setState(r.lookup === 'unavailable' ? 'unavailable' : 'done');
      } catch {
        if (n !== seq.current) return;
        setItems([]);
        setBy(null);
        setState('unavailable');
      }
    }, WAIT_MS);
    return () => clearTimeout(t);
  }, [value, online]);

  const done = (next = 'idle') => {
    typed.current = false;
    seq.current += 1;
    session.current = null; // a pick ends Google's session
    setOpen(false);
    setItems([]);
    setBy(null);
    setPicking(-1);
    setState(next);
  };
  const pick = async (s, i) => {
    if (picking >= 0) return;
    if (s.source !== 'google') { done(); onPick?.(s); return; }
    // Google's row is words only: its parts, and B.C.'s pin, from the server.
    setPicking(i);
    const n = seq.current;
    let timer;
    const r = await Promise.race([
      apiGet(`/address/place?id=${encodeURIComponent(s.place_id)}&session=${session.current}`).catch(() => null),
      new Promise((res) => { timer = setTimeout(() => res(null), PICK_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (n !== seq.current) return;
    if (r && r.address) { done(); onPick?.(r); return; }
    // Keep the words Google offered; the form places them when it saves.
    done('pickFailed');
    onChange(s.label || s.address || '');
  };

  const onKeyDown = (e) => {
    if (!open || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i <= 0 ? items.length - 1 : i - 1)); } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(items[active], active); } else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  };

  const showList = open && String(value || '').trim().length >= 3;
  const google = by === 'google' && items.some((s) => s.source === 'google');
  const below = placed
    ? <span className="af-placed">✓ {placedText}</span>
    : state === 'pickFailed'
      ? <span>{PICK_FAILED}{hint ? hint.charAt(0).toLowerCase() + hint.slice(1) : 'check it and save; it’s placed on the map when you save'}</span>
    : showList && state === 'done' && !items.length
      ? <span>No door found for that — check the number and street</span>
      : state === 'unavailable'
        ? <span>The address service isn’t answering — {hint || 'save it, and place the pin on the map'}</span>
        : !online
          ? <span>No signal — {hint || 'place the pin on the map'}</span>
          : hint ? <span>{hint}</span> : null;

  return (
    <div className="field af">
      <label htmlFor={id}>{label}</label>
      <div className="af-box">
        <input
          id={id}
          className="input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList && items.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={`${id}-af-note`}
          required={required}
          autoFocus={autoFocus}
          disabled={disabled}
          maxLength={1000}
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          readOnly={picking >= 0}
          aria-busy={picking >= 0 || undefined}
          onChange={(e) => {
            typed.current = true;
            if (!session.current) session.current = newSession();
            if (state === 'pickFailed') setState('idle');
            onChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => { setOpen(false); if (picking < 0) session.current = null; }, 150)}
          onFocus={() => { if (items.length) setOpen(true); }}
        />
        {showList && items.length > 0 && (
          <div className={`af-pop${google ? ' has-attrib' : ''}`}>
            <ul className="af-list" id={listId} role="listbox" aria-label="Addresses">
              {items.map((s, i) => (
                <li key={`${s.place_id || s.address}|${s.unit || ''}|${s.source}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                  <button type="button" className={`af-opt${i === active ? ' is-active' : ''}`} tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s, i)}>
                    <span className="af-opt__main">{s.source === 'google' ? s.label : <>{s.unit ? `${s.unit} – ` : ''}{s.address}</>}</span>
                    <span className="af-opt__sub">{i === picking ? 'Loading…'
                      : s.source === 'google' ? s.sub
                        : [s.city, s.source === 'map' ? 'On the map' : null].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
            {google && (
              // Google's logo goes with its rows (its display rules), after
              // the list, not in it: a listbox holds only options.
              <div className="af-attrib">
                <img src={at('/google/google-maps-logo.svg')} alt="" aria-hidden="true" height="16" />
                <span className="visually-hidden">Suggestions by Google</span>
              </div>
            )}
          </div>
        )}
      </div>
      <p className="af-note" id={`${id}-af-note`} role="status">{below}</p>
    </div>
  );
}
