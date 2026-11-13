// What a Google connection is for. Each Google feature (Gmail, Drive,
// Calendar) defines its purpose from its own index.js at load; GSI itself
// defines none. One grant per person holds every purpose they connected
// (google_grants.purposes), since revoking at Google ends them all at once.
//
//   definePurpose(key, {
//     label,                 plain words, e.g. 'Send from your Gmail'
//     scopes: [urls],        required, non-empty
//     roles: [...],          required: who may connect it
//     area: 'outreach'|null, required key: null means no area check
//     domain: (settings) => string|null   the hd it demands in a campaign
//     browserToken: false,   true lets narrowToken hand the browser a token
//     ownCard: false,        true: the feature draws its own card
//     onRevoke: null,        async (db, { userId, workspaceId, fetch }) —
//                            clean-up while the token still works
//   })
//   mayUse(db, { userId, workspaceId }, purpose)   the one rule: a member
//     there, in one of its roles, and not denied its area
import { decide, permsOf, AREA_KEYS } from '../perms.js';

export const ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const registry = new Map();

export const definePurpose = (key, def = {}) => {
  const bad = (why) => { throw new Error(`google purpose ${key}: ${why}`); };
  if (typeof key !== 'string' || !/^[a-z][a-z0-9._-]{0,40}$/.test(key)) bad('needs a short lower-case key');
  if (registry.has(key)) bad('defined twice');
  if (!def.label) bad('needs a label');
  if (!Array.isArray(def.scopes) || !def.scopes.length || def.scopes.some((s) => typeof s !== 'string' || !s)) bad('needs scopes');
  if (!Array.isArray(def.roles) || !def.roles.length) bad('needs roles');
  const unknown = def.roles.find((r) => !ROLES.includes(r));
  if (unknown) bad(`unknown role ${unknown}`);
  if (!Object.hasOwn(def, 'area')) bad('needs an area (null for none)');
  if (def.area !== null && !AREA_KEYS.includes(def.area)) bad(`unknown area ${def.area}`);
  if (def.domain != null && typeof def.domain !== 'function') bad('domain must be a function');
  if (def.onRevoke != null && typeof def.onRevoke !== 'function') bad('onRevoke must be a function');
  const p = Object.freeze({
    key, label: String(def.label), scopes: [...def.scopes], roles: [...def.roles], area: def.area,
    domain: def.domain || (() => null), browserToken: def.browserToken === true, ownCard: def.ownCard === true,
    onRevoke: def.onRevoke || null,
  });
  registry.set(key, p);
  return p;
};

export const purposeOf = (key) => registry.get(key) || null;
export const allPurposes = () => [...registry.values()];
// Tests define their own purposes; this takes one away again.
export const _forgetPurposeForTest = (key) => registry.delete(key);

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
const keyOf = (purpose) => (typeof purpose === 'string' ? purpose : purpose?.key);

// The membership and campaign settings mayUse reads (q: a db or a tx).
const memberIn = async (q, userId, workspaceId) => (await q.query(
  `select m.role, m.permissions, w.settings from memberships m join workspaces w on w.id = m.workspace_id
   where m.user_id = $1 and m.workspace_id = $2`,
  [userId, workspaceId],
)).rows[0] || null;

const allows = (p, m) => {
  if (!p || !m || !p.roles.includes(m.role)) return false;
  if (!p.area || m.role === 'manager') return true;
  return decide(permsOf(m.role, parse(m.settings), parse(m.permissions)), p.area) !== false;
};

export const mayUse = async (q, { userId, workspaceId }, purpose) => allows(purposeOf(keyOf(purpose)), await memberIn(q, userId, workspaceId));

// Whether any of this person's memberships on this server still allows it
// (a grant is the person's, server-wide).
export const mayUseAnywhere = async (q, userId, purpose) => {
  const p = purposeOf(keyOf(purpose));
  const rows = (await q.query(
    `select m.role, m.permissions, w.settings from memberships m join workspaces w on w.id = m.workspace_id
     where m.user_id = $1`,
    [userId],
  )).rows;
  return rows.some((m) => allows(p, m));
};

// The hd this purpose demands in this campaign, or null.
export const domainFor = (purpose, settings) => {
  const p = purposeOf(keyOf(purpose));
  const d = p ? p.domain(parse(settings)) : null;
  return d ? String(d).toLowerCase() : null;
};
