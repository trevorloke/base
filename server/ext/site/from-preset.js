// What the website takes from this server's set-up (server/lib/preset.js),
// in one place. A campaign whose set-up brings its own website look, words
// and starting sections has them here; every other campaign has the
// product's own and nothing else. Everything is read when it is asked for,
// never kept: the brand is a setting, and tests change it between cases.
//
//   siteWords()      the website's fixed words (shared/site/ui-words.js)
//                    with the campaign's own laid over them
//   ownWords()       only the campaign's own ({} for most)
//   wordsForRender() those, as the page renderer's ctx takes them
//   siteExtras()     what GET /api/site sends the Website screens: the looks
//                    on offer (Base first), the starting sections' own
//                    words and a field's own label
//   previewExtras()  the same, for a draft's live preview (its page data)
//   lookCss()        the name of the campaign's own stylesheet, or null
//   ownAsset(rel)    the file behind /site-assets/<rel> when it is one of
//                    the campaign's own pictures, or null
//
// Importing this file is what tells the shared code (theme.js, catalogue.js)
// where this server's looks and starting words come from.
import { fileURLToPath } from 'node:url';
import { normalize, sep } from 'node:path';
import { presetLooks, allLooks } from '@starbase/shared/site/theme';
import { presetModuleDefaults } from '@starbase/shared/site/catalogue';
import { layWords } from '../../../shared/site/ui-words.js';
import { preset } from '../../lib/preset.js';

const site = () => preset().site || {};

presetLooks(() => [site().skin].filter(Boolean));
presetModuleDefaults(() => site().moduleDefaults || {});

export const ownWords = () => site().words || {};
export const siteWords = () => layWords(ownWords(), site().wordsBefore);
// What a page's renderer is handed so it draws with the same words: nothing
// for a campaign with none of its own.
export const wordsForRender = () => {
  const own = ownWords();
  return Object.keys(own).length ? { words: own, wordsBefore: site().wordsBefore || {} } : {};
};

export const siteExtras = () => ({
  skins: allLooks(),
  moduleDefaults: site().moduleDefaults || {},
  fieldLabels: site().fieldLabels || {},
});

// For the page's own data: only what a campaign has of its own, so a
// campaign with none gets the page as it always was.
export const previewExtras = () => {
  const out = {};
  const looks = allLooks().slice(1);
  if (looks.length) out.looks = looks;
  const defaults = site().moduleDefaults || {};
  if (Object.keys(defaults).length) out.moduleDefaults = defaults;
  return out;
};

export const lookCss = () => (site().assets && site().css ? site().css : null);

// "imagine-surrey/logo.webp" → the file in the set-up's own folder, when
// this server has that set-up; null otherwise (and for anything that would
// step outside the folder).
export const ownAsset = (rel) => {
  const a = site().assets;
  if (!a || typeof rel !== 'string' || !rel.startsWith(a.prefix)) return null;
  const dir = fileURLToPath(a.dir);
  const root = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  const file = normalize(`${root}${rel.slice(a.prefix.length)}`);
  return file.startsWith(root) ? file : null;
};
