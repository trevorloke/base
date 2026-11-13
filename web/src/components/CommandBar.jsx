// The command bar (the desk): Ctrl+K — ⌘K on a Mac — or the Search button
// in the header. One box to jump to any screen this person may open, find
// someone by name, phone or email (GET /persons?q=, the same search as
// People), or start a common job (add a person, log a gift, enter a
// membership form, draw a turf, a new shift, write an email or a text).
//
// The ARIA combobox pattern: the box keeps focus, ↑ ↓ move through the
// list (aria-activedescendant), Enter opens, Esc closes and focus goes back
// where it was. Screens and jobs are filtered here as you type; people come
// from the server a beat later (one search at a time, the last one wins).
// What a person may open follows their areas (lib/perms.js; App.jsx's own
// guards say the same) — the server refuses the rest anyway. The list and
// its ranking: commands.js.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { allowed, commandsFor, fold, rank, scoreItem } from './commands.js';
import './command-bar.css';


// People's own search reads every row: asked only after this much more quiet.
const FALLBACK_PAUSE_MS = 350;

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
export const shortcutLabel = () => (isMac() ? '⌘K' : 'Ctrl K');

const SearchIcon = () => (
  <svg className="cmd-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9"
    strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
);

// "Sam Example · 604-555-0142 · Whalley" — what tells two people apart.
const personHint = (p) => [p.phone, p.email, p.address].filter(Boolean).slice(0, 2).join(' · ');
// Someone found for what was typed a moment ago who still fits what's typed
// now: every word in their name, email, phone or address; or the phone's
// digits (a leading 1, the country code, aside — as lib/audience.js does).
const stillFits = (p, q) => {
  const hay = fold([p.name, p.email, p.phone, p.address].filter(Boolean).join(' '));
  let digits = /^[\d\s().+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  if (digits.startsWith('1') && digits.length > 4) digits = digits.slice(1);
  return fold(q).split(' ').every((w) => hay.includes(w))
    || (digits.length >= 4 && String(p.phone || '').replace(/\D/g, '').includes(digits));
};

function Dialog({ me, nav, onClose }) {
  const navigate = useNavigate();
  const baseId = useId();
  const inputRef = useRef(null);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState({ q: '', list: [], busy: false, error: null });
  const [activeKey, setActiveKey] = useState(null);
  const canPeople = allowed(me, { area: 'people' });

  // Whether "Shifts in Google Calendar" is on here (an older server: no).
  const gcalQ = useQuery({ queryKey: ['gcal'], queryFn: () => apiGet('/gcal'), staleTime: 5 * 60_000, retry: false });
  const gcal = gcalQ.data?.available === true;
  const { actions, screens } = useMemo(() => commandsFor({ ...me, gcal }, nav || []), [me, nav, gcal]);

  // People, from the server: after a short pause, the last search only. The
  // quick search first (the start of a name, a phone, an email — indexed,
  // ext/search); finding nobody, People's own (any part of a name or an
  // address), which reads the whole file — so only once typing has paused
  // a while longer.
  const q = query.trim();
  useEffect(() => {
    if (!canPeople || q.length < 2) { setPeople({ q: '', list: [], busy: false, error: null }); return undefined; }
    let live = true;
    setPeople((p) => ({ ...p, busy: true, error: null }));
    const t = setTimeout(async () => {
      try {
        let list = (await apiGet(`/search/people?q=${encodeURIComponent(q)}`)).persons || [];
        if (live && !list.length && q.length >= 3) {
          setPeople((p) => ({ ...p, q, list: [], busy: true }));
          await new Promise((r) => { setTimeout(r, FALLBACK_PAUSE_MS); });
          if (!live) return;
          list = (await apiGet(`/persons?q=${encodeURIComponent(q)}&limit=6`)).persons || [];
        }
        if (live) setPeople({ q, list, busy: false, error: null });
      } catch (e) {
        if (live) setPeople({ q, list: [], busy: false, error: e.message });
      }
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [q, canPeople]);

  const groups = useMemo(() => {
    const out = [];
    const doThese = rank(actions, q);
    const goTo = rank(screens, q);
    // Typing on from a search keeps those of its people who still fit, until
    // the new answer comes — never one who doesn't (Enter would open them).
    const found = people.q === q ? people.list
      : people.q && q.startsWith(people.q) ? people.list.filter((p) => stillFits(p, q)) : [];
    const peopleGroup = found.length ? {
      id: 'people', label: 'People',
      items: found.map((p) => ({ kind: 'person', key: `person:${p.id}`, label: p.name, hint: personHint(p), to: `/people/${p.id}` })),
    } : null;
    if (q) {
      // A name that's in no screen's or job's own words: the people first.
      const named = [...goTo, ...doThese].some((it) => scoreItem({ label: it.label }, q) > 0);
      if (peopleGroup && !named) out.push(peopleGroup);
      if (goTo.length) out.push({ id: 'go', label: 'Go to', items: goTo.slice(0, 8) });
      if (doThese.length) out.push({ id: 'do', label: 'Do', items: doThese });
      if (peopleGroup && named) out.push(peopleGroup);
    } else {
      if (doThese.length) out.push({ id: 'do', label: 'Do', items: doThese });
      out.push({ id: 'go', label: 'Go to', items: goTo });
    }
    return out;
  }, [actions, screens, q, people]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // The highlighted row stays the same row when results move under it.
  const active = flat.find((it) => it.key === activeKey) || flat[0] || null;
  const optionId = (it) => `${baseId}-opt-${flat.indexOf(it)}`;

  // The box keeps focus; the page behind it doesn't scroll meanwhile.
  useEffect(() => {
    inputRef.current?.focus();
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = was; };
  }, []);
  useEffect(() => {
    if (!active) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key]);

  const run = useCallback((it) => {
    if (!it) return;
    onClose(false);
    navigate(it.to);
  }, [navigate, onClose]);

  const move = (delta) => {
    if (!flat.length) return;
    const i = active ? flat.indexOf(active) : -1;
    setActiveKey(flat[(i + delta + flat.length) % flat.length].key);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } else if (e.key === 'PageDown') { e.preventDefault(); move(5); } else if (e.key === 'PageUp') { e.preventDefault(); move(-5); } else if (e.key === 'Enter') {
      e.preventDefault();
      run(active);
    }
  };
  // Esc anywhere in the box closes it; Tab stays inside (box ↔ Close).
  const onDialogKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
    if (e.key === 'Tab') {
      const nodes = [inputRef.current, e.currentTarget.querySelector('.cmd-close')].filter(Boolean);
      const at = nodes.indexOf(document.activeElement);
      e.preventDefault();
      nodes[(at + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus();
    }
  };

  // Said once something is typed (a polite live region): how many, or
  // that people are still being looked up.
  const count = flat.length;
  const status = !q ? ''
    : people.busy && q.length >= 2 ? 'Searching…'
      : count ? `${count} ${count === 1 ? 'result' : 'results'}` : 'Nothing found';

  return (
    <div className="cmd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(true); }}>
      <div className="cmd" role="dialog" aria-modal="true" aria-label="Search and go" onKeyDown={onDialogKeyDown}>
        <div className="cmd-bar">
          <SearchIcon />
          <input ref={inputRef} className="cmd-input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list"
            aria-controls={`${baseId}-list`} aria-activedescendant={active ? optionId(active) : undefined}
            aria-label="Search people, screens and jobs" aria-describedby={`${baseId}-status`}
            placeholder={canPeople ? 'Search people, screens, jobs…' : 'Search screens and jobs…'}
            autoComplete="off" autoCapitalize="off" spellCheck={false}
            value={query} onChange={(e) => { setQuery(e.target.value); setActiveKey(null); }} onKeyDown={onKeyDown} />
          <button type="button" className="cmd-close" aria-label="Close" onClick={() => onClose(true)}>
            <span className="cmd-close__esc" aria-hidden="true">Esc</span><span className="cmd-close__word" aria-hidden="true">Close</span>
          </button>
        </div>
        <div className="cmd-list" id={`${baseId}-list`} role="listbox" aria-label="Results">
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={g.label} className="cmd-group">
              <div className="cmd-group__h" aria-hidden="true">{g.label}</div>
              {g.items.map((it) => (
                <div key={it.key} id={optionId(it)} role="option" aria-selected={active?.key === it.key}
                  className={`cmd-opt cmd-opt--${it.kind}${active?.key === it.key ? ' is-active' : ''}`}
                  onMouseMove={() => { if (activeKey !== it.key) setActiveKey(it.key); }}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => run(it)}>
                  <span className="cmd-opt__label">{it.label}</span>
                  {it.hint && <span className="cmd-opt__hint">{it.hint}</span>}
                  {active?.key === it.key && <span className="cmd-opt__enter" aria-hidden="true">↵</span>}
                </div>
              ))}
            </div>
          ))}
          {q && !count && !people.busy && (
            <p className="cmd-empty">{people.error ? people.error : `Nothing for “${q}”`}</p>
          )}
        </div>
        <div className="cmd-foot">
          <span id={`${baseId}-status`} role="status" aria-live="polite" className="cmd-status">{status}</span>
          <span className="cmd-keys" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

// The Search button for the header and the shortcut; the dialog while open.
export default function CommandBar({ me, nav }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const back = useRef(null);
  const btnRef = useRef(null);
  const show = useCallback((from) => {
    back.current = from;
    openRef.current = true;
    setOpen(true);
  }, []);
  // Closed: focus goes back where it was (or to the Search button).
  const close = useCallback((refocus) => {
    openRef.current = false;
    setOpen(false);
    if (refocus) requestAnimationFrame(() => (back.current && document.contains(back.current) ? back.current : btnRef.current)?.focus?.());
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key !== 'k' && e.key !== 'K')) return;
      e.preventDefault();
      if (openRef.current) close(true); else show(document.activeElement);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, show]);
  return (
    <>
      <button type="button" ref={btnRef} className="cmd-btn" aria-haspopup="dialog" aria-expanded={open}
        aria-keyshortcuts="Control+K Meta+K" onClick={() => show(btnRef.current)}>
        <SearchIcon />
        <span className="cmd-btn__label">Search</span>
        <kbd className="cmd-btn__kbd" aria-hidden="true">{shortcutLabel()}</kbd>
      </button>
      {open && <Dialog me={me} nav={nav} onClose={close} />}
    </>
  );
}
