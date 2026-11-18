// The website's faces, drawn on the desk (WA decisions 13–15): every face is
// loaded from base.win's own address with the FontFace API — the built-in
// files from /site-assets/fonts/, an added Google font's from
// /api/site/fonts/file/<sha>.woff2, and a font not added yet as a sample
// of just the letters shown (/api/site/fonts/sample) under a private name.
// The desk's browser never asks Google.
import { useEffect, useState } from 'react';
import { BUILT_FILES, FONT_BY_VALUE, LATIN, LATIN_EXT, fontFor } from '@starbase/shared/site/fonts';
import { at } from '../../base.js';

const loaded = new Map(); // key → Promise<boolean>
const add = (key, family, url, desc = {}) => {
  if (loaded.has(key)) return loaded.get(key);
  const p = (async () => {
    try {
      if (typeof FontFace === 'undefined') return false;
      const f = new FontFace(family, `url(${url}) format('woff2')`, { display: 'swap', ...desc });
      document.fonts.add(f);
      await f.load();
      return true;
    } catch {
      return false;
    }
  })();
  loaded.set(key, p);
  return p;
};

// A built-in face or an added font, under its own name (so its stack works).
export function loadFace(value, added) {
  const font = fontFor(value, added);
  if (!font?.family) return Promise.resolve(true);
  if (font.added) {
    return Promise.all(font.faces.filter((f) => f.subset === 'latin' || f.subset === 'latin-ext').map((f) => add(`g|${f.sha256}|${f.style}`, font.family,
      at(`/api/site/fonts/file/${f.sha256}.woff2`), { weight: String(f.weight), style: f.style === 'italic' ? 'italic' : 'normal', unicodeRange: f.unicode_range || undefined }))).then((r) => r.every(Boolean));
  }
  // The desk declares Inter, Barlow Condensed and Montserrat itself (fonts.css).
  if (['inter', 'barlow-condensed', 'montserrat'].includes(value)) return Promise.resolve(true);
  const files = BUILT_FILES.filter((x) => x.value === value && x.style === 'normal');
  return Promise.all(files.map((x) => add(`b|${x.file}`, x.family, at(`/site-assets/${x.file}`), { weight: x.weight, unicodeRange: x.subset === 'latin' ? LATIN : LATIN_EXT }))).then((r) => r.every(Boolean));
}

// A family not on the site yet: the letters of `text` in weight w, under a
// private name ('wa-<slug>-<w>'). → Promise<name | null>
export function loadSample(family, text, w = 400) {
  const name = `wa-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${w}`;
  const key = `s|${family}|${w}|${text}`;
  return add(key, name, at(`/api/site/fonts/sample?family=${encodeURIComponent(family)}&text=${encodeURIComponent(text)}&w=${w}`), { weight: String(w) })
    .then((ok) => (ok ? name : null));
}

// Load the faces of some theme values; true once they are in.
export function useFaces(values, added) {
  const [ready, setReady] = useState(false);
  const key = values.join('|') + JSON.stringify((added || []).map((a) => a.slug));
  useEffect(() => {
    let live = true;
    setReady(false);
    Promise.all(values.map((v) => loadFace(v, added))).then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return ready;
}

export const stackOf = (value, added) => (fontFor(value, added) || FONT_BY_VALUE.inter).stack;
