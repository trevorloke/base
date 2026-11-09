// htm bound to React.createElement. The website's components are plain
// modules — no JSX, no build step — so the server renders them in Node and
// the browser islands (web/src/site-islands.js) hydrate the very same code.
import htm from 'htm';
import { createElement } from 'react';

export const html = htm.bind(createElement);

// Class names, skipping the falsy ones: cx('btn', big && 'btn--lg').
export const cx = (...names) => names.filter(Boolean).join(' ');
