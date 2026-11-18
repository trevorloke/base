// base.win support's entry, once routes/auth.js /operator has checked the
// token (lib/entry.js): the campaign's switch, the account, the replay
// check, and a two-hour sign-in — all on the campaign's own log.
//
// The account: the one linked to this operator before; else a member here
// with the operator's email; else a new "base.win support" account with no
// password. An account with that email that isn't on the team is never
// taken over (409). An existing member's role and name never change; a
// linked account a manager removed is put back as a manager — the switch
// (Settings → Members) is the campaign's consent, the member row its face.
import { newId, runAction } from '../../lib/events.js';
import { createSession } from '../../lib/auth.js';
import { demoEmail } from '../../lib/demo.js';
import { orgName, jurisdiction } from '../../lib/org.js';
import { createWorkspace, recordCreated, SIGNUP_LOCK } from '../../lib/setup.js';

export const ENTRY_HOURS = 2;
export const SUPPORT_NAME = 'base.win support';

class Replay extends Error {}
const settingsOf = (s) => (typeof s === 'string' ? JSON.parse(s) : s || {});
const firstWorkspace = async (db) =>
  (await db.query('select id, settings from workspaces order by created_at limit 1')).rows[0] || null;

// → { token, userId, workspaceId } or { refused: 'off' | 'email-taken' | 'entry' }
export const enter = async (db, p) => {
  const email = p.op.email.toLowerCase();
  // Read only, first: the switch and the account.
  let ws = await firstWorkspace(db);
  if (ws && settingsOf(ws.settings).operatorEntry === false && !demoEmail()) return { refused: 'off' };
  let userId = (await db.query('select user_id from operator_links where operator_id = $1', [p.op.id])).rows[0]?.user_id || null;
  if (!userId) {
    const u = (await db.query('select id from users where email = $1', [email])).rows[0];
    if (u) {
      const member = ws && (await db.query('select 1 from memberships where user_id = $1 and workspace_id = $2', [u.id, ws.id])).rows[0];
      if (!member) {
        // Someone else's account, maybe: never linked. On the log, as the system.
        if (ws) {
          await runAction(db, { workspaceId: ws.id, actorId: null, action: 'operator.enter' }, async (tx, emit) => {
            emit('workspace', ws.id, 'update', { operator_refused: 'email-taken' });
          });
        }
        return { refused: 'email-taken' };
      }
      userId = u.id;
    }
  }

  // A fresh server: this entry makes the campaign, under sign-up's lock.
  let made = false;
  if (!ws) {
    const id = userId || newId();
    const name = orgName() || 'Campaign';
    const wsId = await db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(${SIGNUP_LOCK})`);
      if ((await tx.query('select 1 from workspaces limit 1')).rows[0]) return null;
      if (!userId) await insertSupport(tx, id, email);
      return createWorkspace(tx, { userId: id, name, jurisdiction: jurisdiction() });
    });
    // Someone else made it a moment ago: as for any campaign.
    if (!wsId) return enter(db, p);
    // Never the operator's email on the log (the account has it).
    await recordCreated(db, { workspaceId: wsId, userId: id, email: undefined, name, jurisdiction: jurisdiction(), extra: { via: SUPPORT_NAME }, entry: p.nonce });
    userId = id;
    made = true;
    ws = await firstWorkspace(db);
  }

  const until = new Date(Date.now() + ENTRY_HOURS * 3600_000);
  const id = userId || newId();
  try {
    const { result } = await runAction(db, { workspaceId: ws.id, actorId: id, action: 'operator.enter', entry: p.nonce }, async (tx, emit) => {
      // A token works once.
      const fresh = (await tx.query(
        `insert into operator_entries (nonce, operator_id, kid, workspace_id, iat, exp)
         values ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6))
         on conflict (nonce) do nothing returning nonce`,
        [p.nonce, p.op.id, p.kid, ws.id, p.iat, p.exp],
      )).rows[0];
      if (!fresh) throw new Replay();
      if (!userId) await insertSupport(tx, id, email);
      const member = (await tx.query('select role from memberships where user_id = $1 and workspace_id = $2', [id, ws.id])).rows[0];
      if (!member) {
        await tx.query('insert into memberships (user_id, workspace_id, role) values ($1, $2, $3)', [id, ws.id, 'manager']);
        emit('membership', id, 'create', { role: 'manager', via: SUPPORT_NAME, user_id: id });
      }
      await tx.query(
        `insert into operator_links (operator_id, user_id) values ($1, $2)
         on conflict (operator_id) do update set user_id = excluded.user_id`,
        [p.op.id, id],
      );
      const token = await createSession(tx, id, ws.id, { expiresAt: until, entry: { nonce: p.nonce, kid: p.kid } });
      // Who came in, from where, and until when — never the operator's email
      // (the account has it).
      emit('session', id, 'create', { via: SUPPORT_NAME, operator: p.op.id, entry: p.nonce, until: until.toISOString(), go: p.go, ...(made ? { made_campaign: true } : {}) });
      await tx.query('update operator_entries set user_id = $2 where nonce = $1', [p.nonce, id]);
      // Kept 8 days, for Today's line.
      await tx.query("delete from operator_entries where used_at < now() - interval '8 days'");
      return { token, userId: id };
    });
    return { ...result, workspaceId: ws.id };
  } catch (e) {
    if (e instanceof Replay) return { refused: 'entry' };
    throw e;
  }
};

// No password ('none' never verifies), so no sign-in but this one.
const insertSupport = (tx, id, email) => tx.query(
  'insert into users (id, email, name, password_hash, support) values ($1, $2, $3, $4, true)',
  [id, email, SUPPORT_NAME, 'none'],
);
