// The Menu button and its panel of the site's pages. It is a <details>, so
// it opens and closes without JavaScript; with JavaScript, Escape and a tap
// outside close it (focus goes back to the button) and picking a link
// closes it too.
import { useEffect, useRef, useState } from 'react';
import { html, cx } from './h.js';
import { Icon } from './icons.js';

export function Menu({ uid, items = [], label = 'Menu' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  const close = (refocus) => {
    if (box.current) box.current.open = false;
    setOpen(false);
    if (refocus) box.current?.querySelector('summary')?.focus();
  };

  // A tap or click anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (box.current && !box.current.contains(e.target)) close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Escape, from the button or any link in the panel.
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && box.current?.open) {
      e.preventDefault();
      close(true);
    }
  };

  return html`<details className="menu" ref=${box} open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)} onKeyDown=${onKeyDown}>
    <summary className="btn btn--outline menu-toggle" aria-controls=${`${uid}-panel`}>
      <${Icon} name=${open ? 'close' : 'menu'} size=${18} stroke=${2.4} />
      <span>${label}</span>
    </summary>
    <div className="menu-panel" id=${`${uid}-panel`}>
      <ul className="menu-list">
        ${items.map((it, i) => html`<li key=${`${i}-${it.href}`} className=${cx(it.bar && 'menu-item--bar')}>
          <a className="nav-link" href=${it.href} aria-current=${it.current ? 'page' : undefined} onClick=${() => close(false)}>${it.label}</a>
        </li>`)}
      </ul>
    </div>
  </details>`;
}
