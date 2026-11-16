// Letters typed on this phone and not yet on the server (pages/Letters.jsx):
// the letter being written, an edit to one, a note. Kept under the field
// copies' prefix with the sign-in's scope (components/OfflineCache.js), so
// sign-out forgets them and nobody else signed in here reads them; a
// "letters:" name is kept 14 days, not one, so a half-written op-ed
// survives a weekend.
//
//   name: 'draft' (Write a letter) · 'edit:<id>' · 'note:<id>'
//   data: what the form holds; { queued: client_id } while the outbox has it
//
// A draft is cleared only when the server has it (onOutboxSent for that
// client_id), never when it's queued. Shell's sign-out confirm counts them
// (letterDraftCount) with the outbox's items.
import { NS } from '../base.js';
import { onOutboxSent } from '../offline.js';

const FIELD_PREFIX = `${NS}field:v1:`;
let scope = null;
// Whose drafts these are (Shell, with setOutboxOwner).
export const setLetterScope = (me) => {
  scope = me?.user?.id && me?.workspace?.id ? `${me.workspace.id}:${me.user.id}:` : null;
};
const keyOf = (name) => (scope ? `${FIELD_PREFIX}${scope}letters:${name}` : null);
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export function readDraft(name) {
  const k = keyOf(name);
  if (!k) return null;
  try { return JSON.parse(ls()?.getItem(k) || 'null')?.data ?? null; } catch { return null; }
}
export function writeDraft(name, data) {
  const k = keyOf(name);
  if (!k) return;
  try { ls()?.setItem(k, JSON.stringify({ at: Date.now(), data })); } catch { /* storage full or blocked */ }
}
export function clearDraft(name) {
  const k = keyOf(name);
  if (!k) return;
  try { ls()?.removeItem(k); } catch { /* blocked */ }
}

const has = (d) => Boolean(d && String(d.body || '').trim());
const mine = () => {
  const out = [];
  const store = ls();
  if (!store || !scope) return out;
  const pre = `${FIELD_PREFIX}${scope}letters:`;
  try {
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k && k.startsWith(pre)) out.push(k.slice(pre.length));
    }
  } catch { /* blocked */ }
  return out;
};
// Letters typed here and not on the server. One queued in the outbox is
// counted there, not twice.
export const letterDraftCount = () => mine().filter((n) => { const d = readDraft(n); return has(d) && !d.queued; }).length;

// The server has it: the draft that waited for it goes.
const KEYED = { 'myletter.submit': () => 'draft', 'myletter.revise': (i) => `edit:${i.id}`, 'myletter.note': (i) => `note:${i.id}` };
onOutboxSent(({ name, input }) => {
  const nameOf = KEYED[name];
  if (!nameOf || !input) return;
  const n = nameOf(input);
  const d = readDraft(n);
  if (d?.queued && d.queued === input.client_id) clearDraft(n);
});

// A refused letter in the outbox sheet: its text goes back where it was
// typed (and the item is dismissed by the caller). → the screen to open.
export const LETTER_ITEMS = Object.keys(KEYED);
export function backToDraft(item) {
  const i = item?.input || {};
  if (item.name === 'myletter.submit') {
    writeDraft('draft', {
      kind: i.kind, title: i.title || '', body: i.body || '', outlet_ids: i.outlet_ids || [], sign: i.sign || {},
      disclose_line: i.disclose_line, email_me: i.email_me,
    });
    return '/letters/new';
  }
  if (item.name === 'myletter.revise') { writeDraft(`edit:${i.id}`, { body: i.body || '', from_version: i.from_version || null }); return `/letters/${i.id}`; }
  if (item.name === 'myletter.note') { writeDraft(`note:${i.id}`, { body: i.body || '' }); return `/letters/${i.id}`; }
  return null;
}
// Dropping a refused letter's text: a draft still waiting on it goes too.
export function dropQueued(item) {
  const nameOf = KEYED[item?.name];
  if (!nameOf) return;
  const n = nameOf(item.input || {});
  if (readDraft(n)?.queued === item.input?.client_id) clearDraft(n);
}
export const letterTextOf = (item) => String(item?.input?.body || '');

// Copy to the clipboard, or false (the caller shows the text selected).
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
