// The page builder's plain parts — no React, no network — so the server's
// tests can run them (server/test/site-builder.test.js):
//
//   newModuleId(taken)        a fresh id for a section ("m" + 8 letters/digits)
//   addModule · moveModule · duplicateModule · removeModule · putBack ·
//   setHidden · setProps      a page's sections, changed without touching the
//                             list it was given
//   problemsOf(modules, { strict, campaigns, pages })
//                             what a save (loose) or a publish (strict)
//                             would refuse, section by section, field by
//                             field: [{ index, id, kind, label, path, field,
//                             text }] — the catalogue's own check
//                             (shared/site/catalogue.js) plus, for a publish,
//                             the petitions and pages a section points at
//   problemWords(p)           "Section 4 (Petition or pledge) · Which one: pick one"
//   sectionFromServer(msg)    the server's "The 4th module (…): campaign: pick one"
//                             → { index, path, text }, to point at the same place
//   summaryOf(module, ctx)    a section's own words for its row ("Get the newsletter")
//   groups()                  the catalogue by CATEGORIES, for "Add a section"
//
// "Module" is the catalogue's word; the screens say "section".
import { CATEGORIES, MODULES, MODULE_BY_KIND, checkProps, newModule } from '@starbase/shared/site/catalogue';

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

// ── Ids ──
const ID_CHARS = 'abcdefghijkmnopqrstuvwxyz23456789';
const randomId = () => {
  let s = 'm';
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 8; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
  return s;
};
export const newModuleId = (taken = []) => {
  const used = taken instanceof Set ? taken : new Set(taken);
  for (;;) {
    const id = randomId();
    if (!used.has(id)) return id;
  }
};
const idsOf = (list) => new Set((list || []).map((m) => m.id));

// ── A page's sections ──
// Each returns a new list; the one given is never changed.
export const addModule = (list, kind, at = list.length) => {
  const m = newModule(kind, newModuleId(idsOf(list)));
  const i = Math.max(0, Math.min(list.length, at));
  return { list: [...list.slice(0, i), m, ...list.slice(i)], module: m, index: i };
};

// From one place to another ("take its place": dropped on a later section,
// it goes after it; on an earlier one, before it).
export const moveModule = (list, from, to) => {
  if (from === to || from < 0 || from >= list.length) return list;
  const j = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [m] = next.splice(from, 1);
  next.splice(j, 0, m);
  return next;
};

export const duplicateModule = (list, index) => {
  const src = list[index];
  if (!src) return { list, module: null, index: -1 };
  const m = { ...clone(src), id: newModuleId(idsOf(list)) };
  const next = [...list.slice(0, index + 1), m, ...list.slice(index + 1)];
  return { list: next, module: m, index: index + 1 };
};

// → { list, removed: { module, index } } — what putBack needs for Undo.
export const removeModule = (list, index) => {
  const m = list[index];
  if (!m) return { list, removed: null };
  return { list: [...list.slice(0, index), ...list.slice(index + 1)], removed: { module: m, index } };
};
export const putBack = (list, removed) => {
  if (!removed?.module || list.some((m) => m.id === removed.module.id)) return list;
  const i = Math.max(0, Math.min(list.length, removed.index));
  return [...list.slice(0, i), removed.module, ...list.slice(i)];
};

export const setHidden = (list, index, hidden) => list.map((m, i) => (i === index ? { ...m, hidden: Boolean(hidden) } : m));
export const setProps = (list, index, props) => list.map((m, i) => (i === index ? { ...m, props } : m));

// ── What a save or a publish would refuse ──
export const ordinal = (n) => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

// "items[2].title: at most 60 characters" → { path: 'items[2].title', text: 'at most 60 characters' }
export const splitProblem = (message) => {
  const s = String(message || '');
  const at = s.indexOf(': ');
  if (at < 0) return { path: '', text: s };
  return { path: s.slice(0, at), text: s.slice(at + 2) };
};

// A field path → the field and its words: 'items[2].title' on columns →
// { field: <items>, words: 'Points · 3rd · Title' }. Paths are the
// catalogue's: key, key.part (a link's label/href, a picture's url/alt, a
// word's place), key[i].sub, key[i].sub.part (a picture in a list).
const PATH_RE = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?(?:\.([A-Za-z0-9_]+))?(?:\.([A-Za-z0-9_]+))?$/;
export const FIELD_PATH_RE = PATH_RE;
const PART_WORDS = { label: 'Words', href: 'Link', alt: 'Description' };
const partWords = (type, part) => {
  if (part == null) return '';
  if (type === 'image' && part === 'url') return '';
  if (type === 'words' && /^\d+$/.test(part)) return ordinal(Number(part) + 1);
  return PART_WORDS[part] || '';
};
export const fieldAt = (kind, path) => {
  const m = PATH_RE.exec(String(path || ''));
  const def = MODULE_BY_KIND[kind];
  if (!m || !def) return { field: null, item: null, sub: null, words: '' };
  const field = def.fields.find((f) => f.key === m[1]) || null;
  if (!field) return { field: null, item: null, sub: null, words: '' };
  const item = m[2] == null ? null : Number(m[2]);
  let sub = null;
  let rest = '';
  if (field.type === 'list' && m[3] != null) {
    sub = (field.of || []).find((f) => f.key === m[3]) || null;
    rest = [sub?.label || m[3], partWords(sub?.type, m[4])].filter(Boolean).join(' · ');
  } else {
    rest = partWords(field.type, m[3]);
  }
  const words = [field.label, item == null ? null : ordinal(item + 1), rest || null].filter(Boolean).join(' · ');
  return { field, item, sub, words };
};

// The catalogue's words, plainer where they're terse.
export const plainText = (text) => {
  const t = String(text || '');
  if (t === 'pick one') return 'pick one';
  if (t === 'required') return 'fill this in';
  if (t === 'a picture is required') return 'add a picture';
  if (t === 'text expected') return 'type some words';
  if (t === 'not one of the choices') return 'pick one of the choices';
  return t;
};

// modules: the page's sections. strict: a publish's check (every required
// box filled in the sections that show; the petitions and pages they point
// at must be there). campaigns: [{ id, kind, title, status }] · pages:
// [{ slug, status }] (only read when strict).
export const problemsOf = (modules, { strict = false, campaigns = null, pages = null } = {}) => {
  const out = [];
  const seen = new Set();
  (modules || []).forEach((m, index) => {
    const def = MODULE_BY_KIND[m?.kind];
    const base = { index, id: m?.id, kind: m?.kind, label: def?.label || 'Unknown section' };
    if (!def) { out.push({ ...base, path: '', field: null, text: 'this kind of section isn’t known any more — remove it' }); return; }
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(m.id || '')) || seen.has(m.id)) {
      out.push({ ...base, path: '', field: null, text: 'this section needs removing and adding again' });
      return;
    }
    seen.add(m.id);
    const showing = strict && !m.hidden;
    try {
      checkProps(m.kind, m.props, { strict: showing });
    } catch (e) {
      const { path, text } = splitProblem(e.message);
      out.push({ ...base, path, field: fieldAt(m.kind, path).field, text: plainText(text) });
      return;
    }
    if (!showing) return;
    for (const f of def.fields) {
      const v = m.props?.[f.key];
      if (!v) continue;
      if (f.type === 'campaign' && campaigns) {
        const c = campaigns.find((x) => x.id === v);
        if (!c) out.push({ ...base, path: f.key, field: f, text: 'the petition or pledge it shows is gone — pick another' });
        else if (f.kinds && !f.kinds.includes(c.kind)) out.push({ ...base, path: f.key, field: f, text: `pick a ${f.kinds.join(' or ')}` });
      }
      if (f.type === 'page' && pages) {
        const p = pages.find((x) => x.slug === v);
        if (!p || p.status !== 'published') out.push({ ...base, path: f.key, field: f, text: 'the page it links to isn’t on the site — publish it, or pick another' });
      }
    }
  });
  return out;
};

export const problemWords = (p) => {
  const where = p.path ? fieldAt(p.kind, p.path).words : '';
  return `Section ${p.index + 1} (${p.label})${where ? ` · ${where}` : ''}: ${p.text}`;
};

// The server names the module too ("The 4th module (Petition or pledge):
// campaign: pick one") — the same place, as an index and a path.
export const sectionFromServer = (message) => {
  const m = /^The (\d+)(?:st|nd|rd|th) module(?: \([^)]*\))?: (.*)$/.exec(String(message || ''));
  if (!m) return null;
  const rest = m[2];
  const at = rest.indexOf(': ');
  // "campaign: pick one" names a field; "the petition … is gone" doesn't.
  if (at > 0 && PATH_RE.test(rest.slice(0, at))) {
    return { index: Number(m[1]) - 1, path: rest.slice(0, at), text: plainText(rest.slice(at + 2)) };
  }
  return { index: Number(m[1]) - 1, path: '', text: rest };
};

// ── A section's own words, for its row ──
const firstWords = (s, n = 70) => {
  const t = String(s || '').replace(/[#*_>`[\]()!-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
// campaigns: the petitions and pledges, or null while they load.
export const summaryOf = (m, { campaigns = null } = {}) => {
  const p = m?.props || {};
  if (m?.kind === 'petition') {
    if (!p.campaign) return 'No petition picked yet';
    if (!campaigns) return '';
    const c = campaigns.find((x) => x.id === p.campaign);
    return c ? c.title : 'A petition that’s gone';
  }
  if (m?.kind === 'hero') return firstWords([p.titlePrefix, ...(p.words || []).slice(0, 1)].filter(Boolean).join(' '));
  for (const k of ['title', 'quote', 'caption', 'intro', 'body', 'text']) if (p[k]) return firstWords(p[k]);
  if (m?.kind === 'image') return p.image?.alt ? firstWords(p.image.alt) : '';
  return '';
};

export const groups = () => CATEGORIES.map((c) => ({ ...c, modules: MODULES.filter((m) => m.category === c.key) }));

// ── Links and addresses ──
// What a link box may hold (the catalogue's rule): the site's own path
// (/donate, /#m-join), #anchor, http(s), mailto: or tel:.
export const isSiteLink = (s) => s === '' || /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i.test(String(s));
// "imaginesurrey.ca/x" typed without https:// → "https://imaginesurrey.ca/x";
// anything else as it was.
export const tidyLink = (s) => {
  const t = String(s ?? '').trim();
  if (!t || isSiteLink(t)) return t;
  if (/^www\.|^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(t) && !/\s/.test(t)) return `https://${t}`;
  if (/^[a-z0-9-]+(\/[a-z0-9-]*)*$/i.test(t)) return `/${t.replace(/^\/+/, '')}`;
  return t;
};

// A page's address from its title ("Town hall 2030!" → "town-hall-2030"),
// as the server makes one (server/ext/site/shape.js slugify).
export const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
// While typing an address: lowercase letters, digits and single dashes.
export const slugInput = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 60);

// After a save (or a close) comes back while someone kept typing: each box
// typed in since the request went (`sent`) keeps what was typed; the others
// take the server's copy (its tidied words, an address it made). An editor
// never throws away words for a slow answer.
export const rebaseForm = (cur, sent, server) => Object.fromEntries(Object.keys(server || {}).map((k) => [
  k, JSON.stringify(cur?.[k]) === JSON.stringify(sent?.[k]) ? server[k] : cur?.[k],
]));
