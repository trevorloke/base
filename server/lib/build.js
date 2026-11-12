// Which web build this server hands out: the name of the page's entry file
// ("index-DoXy12ab.js", from web/dist/index.html — it changes with every
// build). Every /api answer carries it (X-Build), so a page left open across
// a deploy, or one a phone kept from before it, can tell it is older than
// the server and say so (web/src/build.js). GET /api/health shows it too.
//
// Read again when index.html changes on disk (a build under a running
// server); looked at no more than every two seconds. null where there is no
// web build (API-only, most tests): no header, nothing compared.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let indexPath = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
let seen = { at: 0, mtime: -1, name: null };

// '<script type="module" crossorigin src="/assets/index-DoXy12ab.js">' → 'index-DoXy12ab.js'
export const buildOf = (html) => {
  for (const tag of String(html || '').match(/<script\b[^>]*>/gi) || []) {
    if (!/type="module"/i.test(tag)) continue;
    const m = /\ssrc="[^"]*\/assets\/([A-Za-z0-9._-]+\.js)"/i.exec(tag);
    if (m) return m[1];
  }
  return null;
};

export const currentBuild = () => {
  const now = Date.now();
  if (now - seen.at < 2000) return seen.name;
  seen.at = now;
  try {
    const mtime = statSync(indexPath).mtimeMs;
    if (mtime !== seen.mtime) seen = { at: now, mtime, name: buildOf(readFileSync(indexPath, 'utf8')) };
  } catch {
    seen = { at: now, mtime: -1, name: null };
  }
  return seen.name;
};

// Tests hand it a page of their own (and look again at once).
export const _setIndexForTest = (path) => {
  if (path) indexPath = path;
  seen = { at: 0, mtime: -1, name: null };
};
