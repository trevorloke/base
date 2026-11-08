// Base's three apps — Ground (here), Web, Air (shared/brand.js). Web and Air
// run on their own; this links to them: BASE_WEB_URL / BASE_AIR_URL on the
// server (me.org.apps), else Web is the campaign's website + /admin. One
// not set up yet shows as such (a manager is told what to set).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { APPS } from '@starbase/shared/brand';
import { fieldHref } from '../mode.js';

export const appLinks = (me) => {
  const site = String(me?.workspace?.settings?.website || '').trim().replace(/\/+$/, '');
  return {
    ground: fieldHref('/'),
    web: me?.org?.apps?.web || (/^https?:\/\//i.test(site) ? `${site}/admin` : null),
    air: me?.org?.apps?.air || null,
  };
};

const GRID = <><rect x="4" y="4" width="6" height="6" rx="1.2" /><rect x="14" y="4" width="6" height="6" rx="1.2" /><rect x="4" y="14" width="6" height="6" rx="1.2" /><rect x="14" y="14" width="6" height="6" rx="1.2" /></>;

export default function AppSwitcher({ me }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const firstRef = useRef(null);
  const links = appLinks(me);
  const manager = me?.role === 'manager' || me?.admin_role === 'manager';
  const close = useCallback((refocus) => { setOpen(false); if (refocus) btnRef.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return undefined;
    firstRef.current?.focus();
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);
  return (
    <div className="apps" ref={wrapRef} onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(true); } }}>
      <button type="button" ref={btnRef} className="apps-btn" aria-expanded={open} aria-controls={panelId}
        aria-label="Base apps — Ground, Web, Air" onClick={() => (open ? close(false) : setOpen(true))}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{GRID}</svg>
      </button>
      <div className="apps-panel" id={panelId} hidden={!open}>
        <p className="apps-head">Base</p>
        <ul className="apps-list">
          {APPS.map((a, i) => {
            const href = links[a.key];
            const here = a.key === 'ground';
            const body = (
              <>
                <span className="apps-name">{a.full}{here && <span className="apps-here"> · here</span>}</span>
                <span className="apps-what">{href || here ? a.what : manager ? `Not linked yet — set ${a.key === 'web' ? 'BASE_WEB_URL (or the website in Settings)' : 'BASE_AIR_URL'} on the server` : 'Not linked yet'}</span>
              </>
            );
            return (
              <li key={a.key}>
                {href ? (
                  <a ref={i === 0 ? firstRef : undefined} className={`apps-item${here ? ' is-here' : ''}`} href={href}
                    aria-current={here ? 'page' : undefined} onClick={here ? () => close(false) : undefined}>{body}</a>
                ) : (
                  <span className="apps-item is-off" aria-disabled="true">{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
