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
// lookupAddress(line) — the same suggestions, for a form saving a typed
// address nobody picked: the first door whose number and street match.
import { useEffect, useId, useRef, useState } from 'react';
import { apiGet } from '../api.js';
import { useOnline } from './NoSignal.jsx';
import './address-field.css';

const WAIT_MS = 250;
const norm = (s) => String(s || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

const ask = (q) => apiGet(`/address/suggest?q=${encodeURIComponent(q)}`);

export async function lookupAddress(line) {
  const q = String(line || '').trim();
  if (q.length < 3) return null;
  try {
    const r = await ask(q);
    const want = norm(q);
    return (r.suggestions || []).find((s) => norm(s.address) === want || norm(s.label).startsWith(want)) || null;
  } catch {
    return null;
  }
}

export default function AddressField({
  id, label = 'Address', value, onChange, onPick, placed = false, hint = null, required = false, autoFocus = false,
  placeholder = '13450 104 Ave', disabled = false, placedText = 'Pinned on the map',
}) {
  const online = useOnline();
  const listId = useId();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [state, setState] = useState('idle'); // idle | loading | done | unavailable
  const typed = useRef(false); // only typing asks (a pick or a prefilled value doesn't)
  const seq = useRef(0);

  useEffect(() => {
    if (!typed.current) return undefined;
    const q = String(value || '').trim();
    if (q.length < 3 || !online) { setItems([]); setOpen(false); setState('idle'); return undefined; }
    const n = ++seq.current;
    setState('loading');
    const t = setTimeout(async () => {
      try {
        const r = await ask(q);
        if (n !== seq.current) return; // a newer question is out
        setItems(r.suggestions || []);
        setActive(-1);
        setOpen(true);
        setState(r.lookup === 'unavailable' ? 'unavailable' : 'done');
      } catch {
        if (n !== seq.current) return;
        setItems([]);
        setState('unavailable');
      }
    }, WAIT_MS);
    return () => clearTimeout(t);
  }, [value, online]);

  const pick = (s) => {
    typed.current = false;
    seq.current += 1;
    setOpen(false);
    setItems([]);
    setState('idle');
    onPick?.(s);
  };

  const onKeyDown = (e) => {
    if (!open || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i <= 0 ? items.length - 1 : i - 1)); } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(items[active]); } else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  };

  const showList = open && String(value || '').trim().length >= 3;
  const below = placed
    ? <span className="af-placed">✓ {placedText}</span>
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
          onChange={(e) => { typed.current = true; onChange(e.target.value); }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onFocus={() => { if (items.length) setOpen(true); }}
        />
        {showList && items.length > 0 && (
          <ul className="af-list" id={listId} role="listbox" aria-label="Addresses">
            {items.map((s, i) => (
              <li key={`${s.address}|${s.unit || ''}|${s.source}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                <button type="button" className={`af-opt${i === active ? ' is-active' : ''}`} tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
                  <span className="af-opt__main">{s.unit ? `${s.unit} – ` : ''}{s.address}</span>
                  <span className="af-opt__sub">{[s.city, s.source === 'map' ? 'On the map' : null].filter(Boolean).join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="af-note" id={`${id}-af-note`} role="status">{below}</p>
    </div>
  );
}
