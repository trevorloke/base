// What a phone kept under the app's older name (base.js OLD_NS), carried to
// the new one (NS) once, as the app starts and before anything reads it: the
// saved sign-in (so a volunteer who updates with no signal is still signed
// in), walk lists, letter drafts, the desk's copies, the map's choices and the
// rest. Each key is copied where the new one is missing, then the older one
// is removed — only once the copy is saved: with storage full the older key
// stays (sign-out still forgets it: components/OfflineCache.js). Nothing is
// ever written under the older name.
//
// An explicit list of key families, never "everything under the prefix": at a
// site's root the older prefix also starts the keys of the campaigns under a
// path on the same domain (OLD_NS + '<client>:…'), and those are theirs.
//
// The outbox is not in the list: offline.js merges its older keys itself, on
// every read (a tab still open on the older app keeps writing them). Neither
// is Calls' Phone/Text choice, kept before under a name of its own
// (pages/People.jsx carries it with carryKey when it reads it).
//
//   carryOldStorage(stores?)        → how many keys were carried (main.jsx runs it first)
//   carryKey(store, oldKey, newKey) → true when the older key's value is now under newKey
import { BASE, NS, OLD_NS } from './base.js';

// The families kept under NS (server/test/offline-old-names.test.js checks
// that every `${NS}…` key in web/src is one of these, or below).
export const FAMILIES = Object.freeze({
  // A family of keys: everything starting with it.
  prefix: Object.freeze([
    'copy:v1:',          // phone and desk copies (components/OfflineCache.js, scale.js, KeptCopies.js)
    'field:v1:',         // walk lists (pages/Turfs.jsx, Today.jsx) and letter drafts (components/letterDrafts.js)
    'gotv-notes:',       // GOTV notes typed with no signal (components/gotvNotes.js)
    'gotv-notes-asked:', // pages/WhoVoted.jsx
    'gotv-entered:',     // pages/WhoVoted.jsx
    'surveys:v1:',       // the survey questions kept for no signal (components/SurveyQuestions.jsx)
  ]),
  // One key each.
  exact: Object.freeze([
    'me:v1',             // the saved sign-in (api.js)
    'copy-role:v1',      // whose copies these are (components/OfflineCache.js)
    'map:view', 'map:turfs', 'map:signs', 'map:hint-seen', // pages/mapQueries.js, Map.jsx
    'map:share',         // components/ShareLocation.js
    'today:band', 'today:map', // components/MapWindow.jsx
    'mainstreet:place', 'mainstreet:met', // pages/Mainstreet.jsx
    'dash:period',       // pages/Dashboard.jsx
    'shifts-view',       // pages/Shifts.jsx
    'brand-saved',       // components/BrandSettings.jsx (this tab)
    'google-signin',     // components/google.js (this tab)
    'reloaded-at',       // build.js (this tab)
    'demo-jump',         // pages/Login.jsx (this tab)
  ]),
});
// Carried by their own readers: the outbox (offline.js) and its lock, and
// Calls' Phone/Text choice (pages/People.jsx).
export const OWN_CARRY = Object.freeze(['outbox:v2', 'outbox:v1', 'outbox', 'calls.channel:']);
// New under NS, with no older form under OLD_NS: this tab's Calls and profile
// choices (gone when the tab closes, so nothing to carry), and an event name
// (components/ShareLocation.js — nothing kept).
export const NEW_ONLY = Object.freeze(['calls.done', 'person.channel', 'share']);

const ALL = [...FAMILIES.exact, ...FAMILIES.prefix];
const inFamily = (rest) => FAMILIES.exact.includes(rest) || FAMILIES.prefix.some((p) => rest.startsWith(p));
// At the root: '<client>:…' is a path campaign's — even one whose name starts
// like a family of ours ('gotv-notes:me:v1' is the gotv-notes campaign's sign-in).
const anotherClients = (rest) => {
  const cut = rest.indexOf(':');
  return cut > 0 && ALL.some((f) => rest.slice(cut + 1).startsWith(f));
};

export function carryKey(store, oldKey, newKey) {
  if (!store || !oldKey || !newKey || oldKey === newKey) return false;
  try {
    const v = store.getItem(oldKey);
    if (v == null) return false;
    if (store.getItem(newKey) == null) store.setItem(newKey, v);
    store.removeItem(oldKey);
    return true;
  } catch { return false; } // storage full or blocked: the older key stays
}

const stores = () => {
  const out = [];
  try { if (globalThis.localStorage) out.push(globalThis.localStorage); } catch { /* blocked */ }
  try { if (globalThis.sessionStorage) out.push(globalThis.sessionStorage); } catch { /* blocked */ }
  return out;
};

export function carryOldStorage(list = stores()) {
  let n = 0;
  for (const store of list) {
    let keys = [];
    try { for (let i = 0; i < store.length; i += 1) keys.push(store.key(i)); } catch { keys = []; }
    for (const k of keys) {
      if (!k || !k.startsWith(OLD_NS)) continue;
      const rest = k.slice(OLD_NS.length);
      if (!inFamily(rest) || (!BASE && anotherClients(rest))) continue;
      if (carryKey(store, k, `${NS}${rest}`)) n += 1;
    }
  }
  return n;
}

carryOldStorage();
