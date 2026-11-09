// Islands: the few interactive parts of a public page. The server renders
// each one to HTML like the rest of the page, followed by its props as
// <script type="application/json">; web/src/site-islands.js finds them and
// hydrates the same component with the same props. Without that script the
// HTML still works: forms post, menus and sign-ups open (<details>), share
// links are links.
//
//   <div class="island" data-island="form" id="i-…">…</div>
//   <script type="application/json" data-island-props="i-…">{…}</script>
//
// An island's component reads nothing from the browser while rendering
// (only in effects), so the first render in the browser is the server's.
import { Fragment } from 'react';
import { html } from './h.js';
import { jsonForScript } from './util.js';
import { SiteForm } from './form.js';
import { ShareSheet } from './share.js';
import { RotatingWords } from './words.js';
import { Menu } from './menu.js';
import { Openings } from './openings.js';

export const ISLANDS = {
  form: SiteForm,
  share: ShareSheet,
  words: RotatingWords,
  menu: Menu,
  openings: Openings,
};

export function Island({ name, props }) {
  const Component = ISLANDS[name];
  if (!Component) return null;
  const id = `i-${props.uid}`;
  return html`<${Fragment}>
    <div className="island" data-island=${name} id=${id}><${Component} ...${props} /></div>
    <script type="application/json" data-island-props=${id} dangerouslySetInnerHTML=${{ __html: jsonForScript(props) }} />
  <//>`;
}

// In the browser: hydrate every island on the page. Returns how many.
export function hydrateIslands(doc, { createElement, hydrateRoot }) {
  const scripts = new Map([...doc.querySelectorAll('script[data-island-props]')].map((s) => [s.getAttribute('data-island-props'), s]));
  let count = 0;
  for (const el of doc.querySelectorAll('[data-island]')) {
    const Component = ISLANDS[el.getAttribute('data-island')];
    const script = scripts.get(el.id);
    if (!Component || !script) continue;
    let props;
    try { props = JSON.parse(script.textContent || 'null'); } catch { continue; }
    if (!props) continue;
    hydrateRoot(el, createElement(Component, props));
    count += 1;
  }
  return count;
}
