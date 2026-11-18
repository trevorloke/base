// Undo and Redo for the builder (WA decision 24): the draft as it was before
// each change, in memory for this visit, up to 100 steps. Typing in one box
// is one step per second of typing (changes to the same box within a
// second of each other join the step before). An undo is a change like any
// other: it autosaves. A reload starts a new history.
//
//   const h = createHistory()
//   h.record(before, key)   before a change: `before` is the draft as it is;
//                           key names the box being typed in (or null)
//   h.undo(current) → the draft to go back to (or null) · h.redo(current)
//   h.canUndo() · h.canRedo()
export const HISTORY_STEPS = 100;
const JOIN_MS = 1000;

export function createHistory({ now = () => Date.now(), steps = HISTORY_STEPS } = {}) {
  let past = [];
  let future = [];
  let last = { key: null, at: 0 };
  return {
    record(before, key = null) {
      const t = now();
      future = [];
      if (key && last.key === key && t - last.at < JOIN_MS && past.length) { last.at = t; return; }
      past = [...past, before].slice(-steps);
      last = { key, at: t };
    },
    undo(current) {
      if (!past.length) return null;
      const back = past[past.length - 1];
      past = past.slice(0, -1);
      future = [...future, current];
      last = { key: null, at: 0 };
      return back;
    },
    redo(current) {
      if (!future.length) return null;
      const next = future[future.length - 1];
      future = future.slice(0, -1);
      past = [...past, current].slice(-steps);
      last = { key: null, at: 0 };
      return next;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}
