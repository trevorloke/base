// The campaign's From addresses (workspace settings, set by managers; not
// secret) and which one a send goes from.
//
//   settings.senders        [{ id, name, email }], at most SENDERS_MAX
//   settings.sender_email   the id newsletters and emails to a list use
//   settings.sender_press   the id press releases use
// Either default may be null: MAIL_FROM, as before any address was added.
// A send names an id, never an address; the From it resolves to is kept on
// the send (blasts.from_addr), so a resend or an A/B winner goes from it.
import { httpError } from '../../actions/util.js';
import { mailFrom } from '../../lib/mail/index.js';

export const SENDERS_MAX = 10;
export const DESK_ROLES = ['manager', 'treasurer', 'staff'];
export const isDesk = (ctx) => DESK_ROLES.includes(ctx?.role);

const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
export const settingsOf = (row) => parseJ(row?.settings, {}) || {};
export const sendersOf = (settings) => (Array.isArray(settings?.senders) ? settings.senders : []);
// The name is quoted: "Surrey, BC Media" stays one name to a mail app (it
// never holds a " — the input refuses it).
export const rawOf = (s) => `"${s.name}" <${s.email}>`;
export const defaultsOf = (settings) => {
  const ids = new Set(sendersOf(settings).map((s) => s.id));
  const pick = (id) => (id && ids.has(id) ? id : null);
  return { email: pick(settings?.sender_email), press: pick(settings?.sender_press) };
};

// The From a send goes from, as typed ('"Name" <addr>'), or null for
// MAIL_FROM. Only the desk chooses: anyone else's sender_id is ignored and
// the kind's default is used. An id no longer on the list is refused.
export const resolveFrom = async (tx, ctx, kind, senderId) => {
  const settings = settingsOf((await tx.query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0]);
  const list = sendersOf(settings);
  let id = isDesk(ctx) ? senderId ?? null : null;
  if (id) {
    if (!list.some((s) => s.id === id)) throw httpError(400, 'That From address was removed — pick another');
  } else {
    id = defaultsOf(settings)[kind === 'press' ? 'press' : 'email'];
  }
  const s = id ? list.find((x) => x.id === id) : null;
  return s ? rawOf(s) : null;
};

// The domain a From may be at: MAIL_FROM's, with email connected.
export const allowedDomain = () => mailFrom().domain || null;
