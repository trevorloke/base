// Small pieces every Website screen shares:
//   <WebsiteTabs />        Overview · Pages · News · Petitions and pledges · Other websites · Theme · Settings
//   useToast()             one message at a time, with an optional Undo
//                          ({ toast, say(text, { undo }) } and <Toast toast={…} />)
//   <MoreMenu label>       a "⋯" button that opens a short list of actions
//                          (a disclosure: Tab moves through it, Escape or a
//                          tap outside closes it, and so does picking one)
//   <Dialog open title onClose>   a native <dialog> (focus stays inside;
//                          Escape closes it)
//   <SaveState state />    "Saving…" · "Saved 2:14 pm" · "Not saved — …"
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { clock } from './useSite.js';

const TABS = [
  ['/website', 'Overview', true],
  ['/website/pages', 'Pages'],
  ['/website/news', 'News'],
  ['/website/petitions', 'Petitions and pledges'],
  ['/website/sites', 'Other websites'],
  ['/website/theme', 'Theme'],
  ['/website/settings', 'Settings'],
];
export function WebsiteTabs() {
  return (
    <nav className="ws-tabs wb-tabs" aria-label="Website">
      {TABS.map(([to, label, end]) => <NavLink key={to} to={to} end={end} className="ws-tab">{label}</NavLink>)}
    </nav>
  );
}

export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const clear = useCallback(() => { clearTimeout(timer.current); setToast(null); }, []);
  const say = useCallback((text, { undo = null, ms } = {}) => {
    clearTimeout(timer.current);
    const t = { text, undo, n: Date.now() };
    setToast(t);
    timer.current = setTimeout(() => setToast((cur) => (cur === t ? null : cur)), ms ?? (undo ? 10_000 : 4000));
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { toast, say, clear };
}

export function Toast({ toast, onClear }) {
  return (
    <>
      {/* Read out once, whether or not the toast is still up. */}
      <p className="ws-sr" aria-live="polite">{toast?.text || ''}</p>
      {toast && (
        <div className="toast wb-toast" data-undo={toast.undo ? '' : undefined}>
          <span>{toast.text}</span>
          {toast.undo && (
            <button type="button" className="btn" onClick={() => { const u = toast.undo; onClear(); u(); }}>Undo</button>
          )}
          <button type="button" className="btn btn-quiet wb-toast__x" aria-label="Dismiss" onClick={onClear}>✕</button>
        </div>
      )}
    </>
  );
}

// items: [{ label, onClick, danger?, disabled?, href?, external? }] (falsy items skipped)
export function MoreMenu({ label, items, className = '' }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrap = useRef(null);
  const btn = useRef(null);
  const first = useRef(null);
  const close = useCallback((refocus) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return undefined;
    first.current?.focus();
    const down = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  const list = items.filter(Boolean);
  return (
    <div className={`wb-more ${className}`.trim()} ref={wrap}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(true); } }}>
      <button type="button" ref={btn} className="btn btn-quiet wb-more__btn" aria-expanded={open} aria-controls={panelId}
        aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
      </button>
      <div className="wb-more__panel" id={panelId} hidden={!open}>
        {list.map((it, i) => (it.href ? (
          <a key={it.label} ref={i === 0 ? first : undefined} className="wb-more__item" href={it.href}
            target={it.external ? '_blank' : undefined} rel={it.external ? 'noopener' : undefined} onClick={() => close(false)}>
            {it.label}{it.external && <span aria-hidden="true"> ↗</span>}{it.external && <span className="ws-sr"> (opens a new tab)</span>}
          </a>
        ) : (
          <button key={it.label} ref={i === 0 ? first : undefined} type="button"
            className={`wb-more__item${it.danger ? ' wb-more__item--danger' : ''}`} disabled={it.disabled}
            onClick={() => { close(true); it.onClick(); }}>
            {it.label}
          </button>
        )))}
      </div>
    </div>
  );
}

export function Dialog({ open, title, onClose, children, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`wb-dialog${wide ? ' wb-dialog--wide' : ''}`} aria-labelledby={titleId}
      onClose={() => { if (open) onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <div className="wb-dialog__inner">
          <div className="wb-dialog__head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn btn-quiet wb-dialog__x" aria-label="Close" onClick={onClose}>✕</button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

// state: { state: 'saved' | 'saving' | 'waiting' | 'blocked' | 'error' | 'conflict', at?, text? }
export function SaveState({ state, onRetry }) {
  if (!state) return null;
  const words = {
    saved: state.at ? `Saved ${clock(state.at)}` : 'Saved',
    saving: 'Saving…',
    waiting: 'Saving…',
    blocked: `Not saved yet — ${state.text}`,
    error: `Not saved — ${state.text}`,
    conflict: state.text,
  }[state.state] || '';
  return (
    <span className="wb-saved" data-state={state.state} role="status" aria-live="polite">
      {state.state === 'saved' && <span aria-hidden="true">✓ </span>}
      {words}
      {state.state === 'error' && onRetry && <> <button type="button" className="btn-link" onClick={onRetry}>Try again</button></>}
    </span>
  );
}
