// "A new version is ready · Reload" — the strip under the nav once the server
// has moved on to a newer build than this page (src/build.js). Until it is
// tapped, the next link is a full page load, so the new build arrives with
// it: nobody stays on a page the server has left behind. With no signal the
// link is an ordinary one (the page already here is the one that works).
import { useEffect } from 'react';
import { useNewVersion } from '../build.js';
import './reload.css';

// A plain tap on a link to somewhere in this app (not a new tab, not a
// download, not a jump within the screen).
const linkOf = (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = e.target?.closest?.('a[href]');
  if (!a || a.target || a.hasAttribute('download') || a.origin !== window.location.origin) return null;
  if (a.pathname === window.location.pathname && a.search === window.location.search) return null;
  return a;
};

export default function NewVersion() {
  const ready = useNewVersion();
  useEffect(() => {
    if (!ready) return undefined;
    // Before the router sees the tap (it leaves a prevented one alone).
    const onClick = (e) => {
      const a = linkOf(e);
      if (!a || navigator.onLine === false) return;
      e.preventDefault();
      window.location.assign(a.href);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [ready]);
  if (!ready) return null;
  return (
    <div className="offline-strip new-version" role="status">
      <div className="offline-strip__inner">
        <span className="offline-strip__dot" aria-hidden="true" />
        <span className="new-version__text">A new version is ready</span>
        <button type="button" className="btn offline-strip__btn" onClick={() => window.location.reload()}>Reload</button>
      </div>
    </div>
  );
}
