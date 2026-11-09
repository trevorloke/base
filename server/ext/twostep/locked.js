// Too many wrong two-step codes in a row (lib/twostep.js LOCK_AFTER): the
// codes from the account's authenticator app stop working until one of its
// recovery codes is used or a manager resets it. Someone may have the
// password, so it isn't kept quiet:
//
//   tellLocked(db, userId)  the moment it locks: on the log of each campaign
//                           the account is in (by nobody — it may not have
//                           been them), and an email to the person and to
//                           each of those campaigns' managers (when email
//                           is connected). Never a code or a key in it.
//   briefLocked             a manager's Today says so, for each locked
//                           member of their campaign, until it's unlocked.
//
// What the person is told when they try: LOCKED_SIGN_IN (sign-in, joining)
// and the actions' own words (actions.js).
import { runAction } from '../../lib/events.js';
import { emailConfigured, sendEmail } from '../../lib/notify.js';
import { LOCK_AFTER } from '../../lib/twostep.js';

export const LOCKED_SIGN_IN = `Too many wrong codes in a row (${LOCK_AFTER}) — codes from your app are locked for this account. `
  + 'Type one of your recovery codes, or ask a manager to reset your two-step sign-in.';
export const LOCKED_ACTION = `too many wrong codes in a row (${LOCK_AFTER}) — codes from your app are locked until one of your recovery codes is used or a manager resets your two-step sign-in`;

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

export async function tellLocked(db, userId) {
  const user = (await db.query('select id, name, email from users where id = $1', [userId])).rows[0];
  if (!user) return;
  const lockedAt = (await db.query('select locked_at from two_step where user_id = $1', [userId])).rows[0]?.locked_at;
  const campaigns = (await db.query(
    `select w.id, w.name from memberships m join workspaces w on w.id = m.workspace_id
     where m.user_id = $1 order by m.created_at`,
    [userId],
  )).rows;
  for (const w of campaigns) {
    await runAction(db, { workspaceId: w.id, actorId: null, action: 'twostep.locked' }, async (tx, emit) => {
      emit('two_step', userId, 'update', { locked: true, wrong_codes: LOCK_AFTER });
    });
  }
  if (!emailConfigured()) return;
  const key = (to) => `two-step-locked-${userId}-${new Date(lockedAt || Date.now()).getTime()}-${to}`;
  const names = campaigns.map((w) => w.name).join(', ') || 'your campaign';
  const sent = new Set([String(user.email).toLowerCase()]);
  await sendEmail({
    to: user.email,
    subject: 'Your two-step sign-in is locked',
    idempotencyKey: key(user.email),
    text: `Hi ${first(user.name)},\n\n`
      + `Someone typed ${LOCK_AFTER} wrong two-step codes in a row while signing in to base.win as ${user.email}. `
      + 'Codes from your authenticator app are locked for now.\n\n'
      + `To get back in, sign in and type one of your recovery codes, or ask a manager of ${names} to reset your two-step sign-in.\n\n`
      + `If it wasn’t you, someone knows your password: tell a manager of ${names} today.\n`,
  }).catch(() => null);
  for (const w of campaigns) {
    const managers = (await db.query(
      `select u.name, u.email from memberships m join users u on u.id = m.user_id
       where m.workspace_id = $1 and m.role = 'manager' order by m.created_at`,
      [w.id],
    )).rows;
    for (const m of managers) {
      const to = String(m.email || '').toLowerCase();
      if (!to || sent.has(to)) continue;
      sent.add(to);
      await sendEmail({
        to: m.email,
        subject: `${user.name}’s two-step sign-in is locked`,
        idempotencyKey: key(to),
        text: `Hi ${first(m.name)},\n\n`
          + `Someone typed ${LOCK_AFTER} wrong two-step codes in a row while signing in as ${user.name} (${user.email}) on ${w.name}. `
          + 'Codes from their authenticator app are locked now.\n\n'
          + 'They can still sign in with one of their recovery codes, which unlocks it. '
          + 'You can reset their two-step sign-in under Settings → Members — '
          + `check with them first: if it wasn’t them, someone knows their password.\n`,
      }).catch(() => null);
    }
  }
}

// A manager's Today (GET /api/brief): each locked member of this campaign.
export const briefLocked = async (db, ctx, body) => {
  if (ctx.role !== 'manager') return;
  const rows = (await db.query(
    `select u.name from two_step t
     join memberships m on m.user_id = t.user_id and m.workspace_id = $1
     join users u on u.id = t.user_id
     where t.locked_at is not null and t.on_since is not null
     order by t.locked_at`,
    [ctx.workspaceId],
  )).rows;
  if (!rows.length) return;
  body.serverWarnings = [
    ...(body.serverWarnings || []),
    ...rows.map((r) => `${r.name}’s two-step sign-in is locked — ${LOCK_AFTER} wrong codes in a row. `
      + 'If it wasn’t them, someone has their password. They can sign in with a recovery code; '
      + 'you can reset it under Settings → Members.'),
  ];
};
