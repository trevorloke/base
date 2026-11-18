// A draft's preview, live (WA decisions 20–21). Loaded only on preview
// pages, which carry the renderer's inputs as <script id="wa-rc">. The
// builder (web/src/components/site/builder/PreviewFrame.jsx) posts
//   { type: 'wa:modules', modules }   the draft's sections as typed: each
//                                     changed section is drawn again here,
//                                     with the same renderContext and the
//                                     same components the server uses, and
//                                     swapped in place
//   { type: 'wa:focus', section }     scroll to a section and outline it
// On the builder's own preview (?edit=1) a tap on a headline, a paragraph,
// a button or a picture posts { type: 'wa:pick', section, field } back.
// Only messages from the page that framed this one, from this origin, and
// only these types; it never navigates and never writes anything.
import { MODULE_BY_KIND } from '../../shared/site/catalogue.js';
import { drawBody, markSections } from '../../shared/site/components/preview.js';
import { markdownText } from '../../shared/markdown.js';

const el = document.getElementById('wa-rc');
const wa = el ? JSON.parse(el.textContent) : null;
const edit = document.documentElement.hasAttribute('data-wa-edit');
let modules = wa?.page?.modules || [];
let drawn = 0;

// ── Which box drew what: data-wa-field="titlePrefix" / "items.2.title" ──
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const TEXTY = 'h1,h2,h3,h4,p,li,a,span,strong,em,blockquote,figcaption,dt,dd,summary,label,button,div';
function markFields(section, m) {
  const def = MODULE_BY_KIND[m?.kind];
  if (!def || !section) return;
  const used = new Set();
  const nodes = [...section.querySelectorAll(TEXTY)];
  const byText = (value, markdown) => {
    const want = norm(markdown ? markdownText(value, 400) : value);
    if (!want) return null;
    const head = want.slice(0, 60);
    let best = null;
    for (const n of nodes) {
      if (used.has(n) || n.hasAttribute('data-wa-field')) continue;
      const t = norm(n.textContent);
      if (t === want || (head.length >= 12 && t.startsWith(head))) {
        // The innermost element holding it.
        if (!best || best.contains(n)) best = n;
      }
    }
    return best;
  };
  const byImg = (url) => (url ? [...section.querySelectorAll('img')].find((i) => !used.has(i) && (i.getAttribute('src') || '').includes(url)) : null);
  const put = (node, key) => { if (node) { node.setAttribute('data-wa-field', key); used.add(node); } };
  const one = (f, v, key) => {
    if (['text', 'textarea', 'markdown'].includes(f.type)) put(byText(v, f.type === 'markdown'), key);
    else if (f.type === 'link') put(byText(v?.label), key);
    else if (f.type === 'image') put(byImg(v?.url), key);
    else if (f.type === 'words') (Array.isArray(v) ? v : []).forEach((w) => put(byText(w), key));
  };
  const p = m.props || {};
  for (const f of def.fields) {
    if (f.type === 'list') {
      (Array.isArray(p[f.key]) ? p[f.key] : []).forEach((item, i) => {
        for (const sub of f.of || []) one(sub, item?.[sub.key], `${f.key}.${i}.${sub.key}`);
      });
    } else {
      one(f, p[f.key], f.key);
    }
  }
}
const markAll = () => {
  if (!edit) return;
  for (const m of modules) markFields(document.getElementById(`m-${m.id}`), m);
};

// ── Drawing the changed sections again ──
// Each child of <main> is kept as long as its markup is what it was.
const SRC = new WeakMap();
const main = () => document.querySelector('main');
function remember() {
  for (const n of main()?.children || []) SRC.set(n, n.outerHTML);
}
function redraw(next) {
  modules = next;
  const tpl = document.createElement('template');
  let body = drawBody(wa, next);
  if (edit) body = markSections(body);
  tpl.innerHTML = body;
  const fresh = tpl.content.querySelector('main');
  const cur = main();
  if (!fresh || !cur) return;
  const old = new Map();
  [...cur.children].forEach((n, i) => old.set(n.id || `#${i}`, n));
  const out = [];
  [...fresh.children].forEach((n, i) => {
    const html = n.outerHTML;
    const had = old.get(n.id || `#${i}`);
    if (had && SRC.get(had) === html) { out.push(had); return; }
    const node = document.importNode(n, true);
    SRC.set(node, html);
    out.push(node);
  });
  cur.replaceChildren(...out);
  markAll();
  drawn += 1;
  document.documentElement.setAttribute('data-wa-drawn', String(drawn));
  window.parent.postMessage({ type: 'wa:drawn', n: drawn }, location.origin);
}

function focusSection(id) {
  const s = document.getElementById(`m-${id}`);
  if (!s) return;
  for (const o of document.querySelectorAll('[data-wa-on]')) o.removeAttribute('data-wa-on');
  s.setAttribute('data-wa-on', '');
  s.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ── Tap to edit ──
const style = () => {
  const css = document.createElement('style');
  css.textContent = `
    [data-wa-field]{cursor:pointer}
    [data-wa-hover]{outline:2px solid var(--brand);outline-offset:2px}
    [data-wa-section][data-wa-on]{outline:2px solid var(--brand);outline-offset:-2px}
    .wa-tag{position:fixed;z-index:2147483647;pointer-events:none;font:600 12px/1.4 system-ui,sans-serif;padding:2px 6px;border-radius:4px;background:var(--brand);color:var(--brand-ink)}`;
  document.head.append(css);
};
function fieldWords(sectionId, key) {
  const m = modules.find((x) => x.id === sectionId);
  const def = MODULE_BY_KIND[m?.kind];
  const [k, , sub] = String(key).split('.');
  const f = def?.fields.find((x) => x.key === k);
  if (!f) return '';
  return sub ? `${(f.of || []).find((x) => x.key === sub)?.label || sub}` : f.label;
}
function tapToEdit() {
  style();
  const tag = document.createElement('div');
  tag.className = 'wa-tag';
  tag.hidden = true;
  document.body.append(tag);
  const target = (e) => {
    const field = e.target.closest?.('[data-wa-field]');
    const section = e.target.closest?.('[data-wa-section]');
    return { field, section };
  };
  let lit = null;
  document.addEventListener('pointerover', (e) => {
    const { field, section } = target(e);
    const on = field || section;
    if (lit === on) return;
    lit?.removeAttribute('data-wa-hover');
    lit = on;
    if (!on) { tag.hidden = true; return; }
    on.setAttribute('data-wa-hover', '');
    const r = on.getBoundingClientRect();
    tag.textContent = field ? fieldWords(section?.getAttribute('data-wa-section'), field.getAttribute('data-wa-field')) : (MODULE_BY_KIND[section?.getAttribute('data-module')]?.label || '');
    tag.style.left = `${Math.max(4, r.left)}px`;
    tag.style.top = `${Math.max(4, r.top - 22)}px`;
    tag.hidden = !tag.textContent;
  });
  // Nothing in the preview goes anywhere or sends anything.
  document.addEventListener('click', (e) => {
    const { field, section } = target(e);
    e.preventDefault();
    e.stopPropagation();
    if (!section) return;
    window.parent.postMessage({ type: 'wa:pick', section: section.getAttribute('data-wa-section'), field: field?.getAttribute('data-wa-field') || null }, location.origin);
  }, true);
  document.addEventListener('submit', (e) => e.preventDefault(), true);
}

if (wa) {
  remember();
  markAll();
  if (edit) tapToEdit();
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('wa:')) return;
    if (d.type === 'wa:modules' && Array.isArray(d.modules)) redraw(d.modules);
    else if (d.type === 'wa:focus' && typeof d.section === 'string') focusSection(d.section);
  });
  // Which petitions and pledges this page's data holds (needsReload).
  window.parent.postMessage({ type: 'wa:ready', campaigns: Object.keys(wa.data?.campaigns || {}) }, location.origin);
}
