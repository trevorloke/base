// The Base switcher (SUITE.md, "The app switcher"): a small "Base" button in
// the top bar of both faces that opens the list of this client's apps the
// person may open — Field, Ground, and Air and Web once they're set up
// (GET /api/suite, ext/sso). With no answer (no signal) it still lists the
// two faces this person has, worked out here the same way.
//
// A disclosure, not an ARIA menu: a real button (aria-expanded, aria-controls)
// and a list of plain links, so Tab, Enter and a screen reader all work as
// they do on any link. Up/Down move between the links too; Escape closes and
// puts focus back on the button; a click outside closes.
// Its look is its own file (base-switcher.css), all from CSS variables with
// fallbacks, so the app's tokens (and a client's brand) carry over.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { withBase } from '../paths.js';
import { mayAdmin } from '../mode.js';
import './base-switcher.css';

const OWN = {
  field: { name: 'Field', what: 'Canvass, calls and shifts', href: '/field/' },
  ground: { name: 'Ground', what: 'The campaign desk', href: '/ground/' },
};

// me: who is signed in as they really are (the field app's view of a
// manager carries admin_role); current: 'field' | 'ground'.
export default function BaseSwitcher({ me, current }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const suite = useQuery({ queryKey: ['suite'], queryFn: () => apiGet('/suite'), staleTime: 10 * 60_000, retry: false });
  const real = { ...me, role: me?.admin_role || me?.role, areas: me?.admin_areas || me?.areas };
  const apps = suite.data?.apps
    || [{ key: 'field', ...OWN.field }, ...(mayAdmin(real) ? [{ key: 'ground', ...OWN.ground }] : [])];

  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  const links = () => [...(wrapRef.current?.querySelectorAll('.bsw-link') || [])];
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && open) { e.stopPropagation(); close(true); return; }
    if (!open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const all = links();
    if (!all.length) return;
    e.preventDefault();
    const at = all.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % all.length : (at <= 0 ? all.length - 1 : at - 1);
    all[next].focus();
  };
  const toggle = () => {
    if (open) { close(false); return; }
    setOpen(true);
    // Focus the first app once the list is shown.
    requestAnimationFrame(() => links()[0]?.focus());
  };

  return (
    <nav className="bsw" ref={wrapRef} aria-label="Base apps" onKeyDown={onKeyDown}>
      <button type="button" ref={btnRef} className="bsw-btn" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        <span className="bsw-word" aria-hidden="true">Base</span>
        <span className="bsw-sr">Base apps — you’re in Base {OWN[current]?.name || current}</span>
        <svg className="bsw-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <ul className="bsw-panel" id={panelId} hidden={!open}>
        {apps.map((a) => {
          const here = a.key === current;
          return (
            <li key={a.key}>
              <a className="bsw-link" href={withBase(a.href)} aria-current={here ? 'true' : undefined}
                onClick={here ? (e) => { e.preventDefault(); close(true); } : undefined}>
                <span className="bsw-name"><span className="bsw-name__base">Base</span> {a.name}</span>
                <span className="bsw-what">{a.what}{here ? ' · you’re here' : ''}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
