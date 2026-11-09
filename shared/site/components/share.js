// The share sheet: WhatsApp first, then a text message, Facebook, X, email
// and "copy link". Every option is a real link that works without
// JavaScript, each tagged ?source=share-<channel> so a sign-up that comes
// from it is credited to where it was shared. With JavaScript, "Copy link"
// copies (or selects the link when the clipboard is blocked) and a link
// handed over as a path gets the site's address in front.
import { useEffect, useRef, useState } from 'react';
import { html, cx } from './h.js';
import { Icon } from './icons.js';
import { SHARE_CHANNELS, shareLinks, str } from './util.js';

const OUTSIDE = new Set(['whatsapp', 'facebook', 'x']);

export function ShareSheet({ uid, url, text, subject, label = 'Share', tone }) {
  const [full, setFull] = useState(str(url));
  const [status, setStatus] = useState('');
  const input = useRef(null);
  useEffect(() => {
    if (str(url).startsWith('/')) setFull(window.location.origin + url);
  }, [url]);
  const links = shareLinks({ url: full, text, subject });

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(links.copy);
      setStatus('Link copied.');
    } catch {
      input.current?.focus();
      input.current?.select();
      setStatus('The link is selected: press Ctrl+C (or long-press) to copy it.');
    }
  }

  return html`<div className=${cx('share-sheet', tone === 'dark' && 'share-sheet--dark')} role="group" aria-labelledby=${`${uid}-label`}>
    <p className="share-sheet__label" id=${`${uid}-label`}>${label}</p>
    <ul className="share-sheet__list">
      ${SHARE_CHANNELS.filter((c) => c.key !== 'copy').map((c) => html`<li key=${c.key}>
        <a className=${`share-sheet__link share-sheet__link--${c.key}`} href=${links[c.key]} target=${OUTSIDE.has(c.key) ? '_blank' : undefined} rel=${OUTSIDE.has(c.key) ? 'noopener noreferrer' : undefined}>
          <${Icon} name=${c.key} />
          <span>${c.label}</span>
          ${OUTSIDE.has(c.key) ? html`<span className="visually-hidden"> (opens in a new tab)</span>` : null}
        </a>
      </li>`)}
      <li className="js-only">
        <button type="button" className="share-sheet__link share-sheet__link--copy" onClick=${copy}>
          <${Icon} name="copy" />
          <span>Copy link</span>
        </button>
      </li>
    </ul>
    <div className="share-sheet__field">
      <label className="visually-hidden" htmlFor=${`${uid}-url`}>The link to share</label>
      <input ref=${input} id=${`${uid}-url`} className="input share-sheet__url" readOnly value=${links.copy} onFocus=${(e) => e.currentTarget.select()} />
    </div>
    <p className="share-sheet__status" role="status">${status}</p>
  </div>`;
}
