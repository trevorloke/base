// A campaign's first rows: its workspace and its first manager, made by
// first-run sign-up (routes/auth.js /signup) or by base.win support's first
// entry on a fresh server (ext/operator/enter.js). Both run createWorkspace
// inside their own transaction, under the sign-up lock (SIGNUP_LOCK), and
// then recordCreated as its own action.
import { newId, runAction } from './events.js';
import { runHooks } from './hooks.js';
import { openSignupForced, timeZone } from './org.js';
import { parseKeys } from './entry.js';

export const SIGNUP_LOCK = 7240526;

export const noWorkspace = async (db) => !(await db.query('select 1 from workspaces limit 1')).rows[0];
// First-run sign-up: open on a server with no campaign yet — unless it holds
// the control centre's key (BASE_PLATFORM_PUBKEY), whose campaign is set up
// from there. STARBASE_OPEN_SIGNUP=1 opens it whatever (tests, a rebuild).
// /api/auth/setup and /api/health say the same.
export const setupOpen = async (db) => openSignupForced() || (!parseKeys().length && (await noWorkspace(db)));

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
// entry: base.win support's visit that made it (ext/operator), on each event.
export const recordCreated = (db, { workspaceId, userId, email, name, jurisdiction, extra = {}, entry }) =>
  runAction(db, { workspaceId, actorId: userId, action: 'workspace.create', entry }, async (tx, emit) => {
    emit('workspace', workspaceId, 'create', { name, jurisdiction });
    emit('membership', userId, 'create', { email, role: 'manager', ...extra });
    await runHooks('workspaceCreated', tx, { workspaceId, user: { id: userId } }, { emit });
  });
