// A campaign's first rows: its workspace and its first manager, made by
// first-run sign-up (routes/auth.js /signup) or by base.win support's first
// entry on a fresh server (ext/operator/enter.js). Both run createWorkspace
// inside their own transaction, under the sign-up lock (SIGNUP_LOCK), and
// then recordCreated as its own action.
import { newId, runAction } from './events.js';
import { runHooks } from './hooks.js';
import { timeZone } from './org.js';

export const SIGNUP_LOCK = 7240526;

// URL slug for the workspace's public pages (/p/:slug/…, /n/:slug, /v/:slug).
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'campaign';
const uniqueSlug = async (tx, base) => {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const taken = (await tx.query('select 1 from workspaces where slug = $1', [candidate])).rows[0];
    if (!taken) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
};

// The workspace and the user's manager membership (the user exists).
export const createWorkspace = async (tx, { userId, name, jurisdiction, candidate = null }) => {
  const workspaceId = newId();
  await tx.query(
    'insert into workspaces (id, name, slug, candidate, jurisdiction, settings) values ($1, $2, $3, $4, $5, $6)',
    [workspaceId, name, await uniqueSlug(tx, slugify(name)), candidate || null, jurisdiction, JSON.stringify({ tz: timeZone() })],
  );
  await tx.query('insert into memberships (user_id, workspace_id, role) values ($1, $2, $3)', [userId, workspaceId, 'manager']);
  return workspaceId;
};

// The campaign's first entries: who created it and who holds access, and
// what every campaign starts with (ext/fields: the standard fields).
export const recordCreated = (db, { workspaceId, userId, email, name, jurisdiction, extra = {} }) =>
  runAction(db, { workspaceId, actorId: userId, action: 'workspace.create' }, async (tx, emit) => {
    emit('workspace', workspaceId, 'create', { name, jurisdiction });
    emit('membership', userId, 'create', { email, role: 'manager', ...extra });
    await runHooks('workspaceCreated', tx, { workspaceId, user: { id: userId } }, { emit });
  });
