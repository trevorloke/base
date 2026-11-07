// Starbase became base ground (November 2026). Everything this browser kept
// under the old names — the offline outbox of knocks not yet sent, kept
// copies, walk lists, preferences — moves to the new names once, before any
// other module reads them. Imported first by main.jsx.
//
// A key already under the new name wins (it was written by the new app); the
// old one is then dropped. Nothing is ever lost to a full or blocked store:
// the old key stays where it was if the copy can't be written.
const OLD = [['starbase:', 'base:'], ['starbase.', 'base.']];

export const renameKept = (store) => {
  if (!store) return 0;
  let moved = 0;
  const keys = [];
  try {
    for (let i = 0; i < store.length; i += 1) keys.push(store.key(i));
  } catch { return 0; }
  for (const key of keys) {
    const pair = key && OLD.find(([from]) => key.startsWith(from));
    if (!pair) continue;
    const next = pair[1] + key.slice(pair[0].length);
    try {
      if (store.getItem(next) == null) store.setItem(next, store.getItem(key));
      store.removeItem(key);
      moved += 1;
    } catch { /* full or blocked: keep the old key, try again next time */ }
  }
  return moved;
};

try { renameKept(globalThis.localStorage); } catch { /* storage blocked */ }
try { renameKept(globalThis.sessionStorage); } catch { /* storage blocked */ }
