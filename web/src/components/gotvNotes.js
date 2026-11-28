// Names a scrutineer wrote on Who voted (pages/WhoVoted.jsx) that haven't
// gone to the office: written before polls closed, with no signal, or when
// a look-up didn't answer. They live on this phone only, per sign-in
// (`gotv-notes:<campaign>:<user>`), each { id, typed, written_at, place_id },
// and are kept until matched, sent to the office or deleted — never by date
// (the field copies' daily clean-up doesn't touch them). Sign-out counts
// them in its one confirm (Shell) and deletes them with the sign-in.
import { NS, OLD_NS } from '../base.js';

const keyOf = (me) => (me?.user?.id && me?.workspace?.id ? `${NS}gotv-notes:${me.workspace.id}:${me.user.id}` : null);
// The same list under the app's older name: a tab still on the older app may
// write it after this one started (oldStorage.js carries it at the next
// start). Read with this one, each note once; the next save holds both, and
// the older key goes.
const oldKeyOf = (me) => (keyOf(me) ? `${OLD_NS}${keyOf(me).slice(NS.length)}` : null);
const listAt = (k) => {
  try {
    const list = JSON.parse(ls()?.getItem(k) || '[]');
    return Array.isArray(list) ? list.filter((n) => n && n.id && n.typed) : [];
  } catch { return []; }
};
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const listeners = new Set();
const told = () => { for (const fn of listeners) fn(); };
export const onNotes = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function readNotes(me) {
  const k = keyOf(me);
  if (!k) return [];
  const list = listAt(k);
  const ids = new Set(list.map((n) => n.id));
  return [...list, ...listAt(oldKeyOf(me)).filter((n) => !ids.has(n.id))];
}
const write = (me, list) => {
  const k = keyOf(me);
  if (!k) return;
  try {
    if (list.length) ls()?.setItem(k, JSON.stringify(list)); else ls()?.removeItem(k);
    ls()?.removeItem(oldKeyOf(me)); // only once the list it was read into is saved
  } catch { /* storage full or blocked */ }
  told();
};
export const addNote = (me, note) => write(me, [...readNotes(me), note]);
export const dropNote = (me, id) => write(me, readNotes(me).filter((n) => n.id !== id));
export const gotvNoteCount = (me) => readNotes(me).length;
export const clearGotvNotes = (me) => write(me, []);
