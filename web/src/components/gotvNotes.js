// Names a scrutineer wrote on Who voted (pages/WhoVoted.jsx) that haven't
// gone to the office: written before polls closed, with no signal, or when
// a look-up didn't answer. They live on this phone only, per sign-in
// (`gotv-notes:<campaign>:<user>`), each { id, typed, written_at, place_id },
// and are kept until matched, sent to the office or deleted — never by date
// (the field copies' daily clean-up doesn't touch them). Sign-out counts
// them in its one confirm (Shell) and deletes them with the sign-in.
import { NS } from '../base.js';

const keyOf = (me) => (me?.user?.id && me?.workspace?.id ? `${NS}gotv-notes:${me.workspace.id}:${me.user.id}` : null);
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const listeners = new Set();
const told = () => { for (const fn of listeners) fn(); };
export const onNotes = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function readNotes(me) {
  const k = keyOf(me);
  if (!k) return [];
  try {
    const list = JSON.parse(ls()?.getItem(k) || '[]');
    return Array.isArray(list) ? list.filter((n) => n && n.id && n.typed) : [];
  } catch { return []; }
}
const write = (me, list) => {
  const k = keyOf(me);
  if (!k) return;
  try { if (list.length) ls()?.setItem(k, JSON.stringify(list)); else ls()?.removeItem(k); } catch { /* storage full or blocked */ }
  told();
};
export const addNote = (me, note) => write(me, [...readNotes(me), note]);
export const dropNote = (me, id) => write(me, readNotes(me).filter((n) => n.id !== id));
export const gotvNoteCount = (me) => readNotes(me).length;
export const clearGotvNotes = (me) => write(me, []);
