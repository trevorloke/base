// Forgot password: a link by email that works once, for 30 minutes (or a
// manager's, for 24 hours: actions.js). routes/auth.js answers the screens;
// the how is here.
//
// The link is built only from STARBASE_PUBLIC_URL — never from the address
// the request came to, which anyone can set — and the token travels in the
// fragment (…/reset#t=…), so it never reaches a server log or a Referer.
// The Reset screen sends it back by POST. A new ask never ends an earlier
// link (a stranger can't cancel the real one by asking again); at most 3
// live at once; using one ends them all.
import { createHash, randomBytes } from 'node:crypto';
import { configuredUrl } from '../../lib/calendar.js';
import { demoEmail } from '../../lib/demo.js';
import { basePath } from '../../lib/mount.js';
import { emailConfigured, sendEmail } from '../../lib/notify.js';

export const EMAIL_MINUTES = 30;
export const MANAGER_HOURS = 24;
export const LIVE_MAX = 3;
export const TOKEN_RE = /^[0-9a-f]{64}$/;
export const RUN_OUT = 'That link has run out or was already used.';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const tokenHash = (token) => sha256(String(token || ''));

// STARBASE_PUBLIC_URL, when it is an http(s) address; else null.
export const publicBase = () => {
  const raw = configuredUrl();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null;
  } catch { return null; }
};

// Forgot password can email a link here: a sender, the campaign's address,
// and not the public demo (whose one account anyone may use).
export const resetByEmail = () => emailConfigured() && Boolean(publicBase()) && !demoEmail();

// Straight to the app's own Reset screen: under a client's path that is the
// volunteers' app (/field), at a site's root the app's root.
export const resetLink = (token) => {
  const at = publicBase();
  if (!at) throw new Error('STARBASE_PUBLIC_URL is not set');
  return `${at}${basePath() ? '/field/reset' : '/reset'}#t=${token}`;
};

const liveCount = async (db, userId) => Number((await db.query(
  'select count(*)::int as n from password_resets where user_id = $1 and used_at is null and expires_at > now()',
  [userId],
)).rows[0].n);

// A new link for userId: its token (shown once, never kept) and hash. Old
// rows a day past their end are cleared as each new one is made. null when
// the account already has LIVE_MAX links that still work.
export const makeLink = async (db, userId, { madeBy = null, minutes = EMAIL_MINUTES } = {}) => {
  if ((await liveCount(db, userId)) >= LIVE_MAX) return null;
  await db.query("delete from password_resets where expires_at < now() - interval '1 day'");
  const token = randomBytes(32).toString('hex');
  const hash = sha256(token);
  await db.query(
    `insert into password_resets (token_hash, user_id, made_by, expires_at)
     values ($1, $2, $3, now() + $4::int * interval '1 minute')`,
    [hash, userId, madeBy, minutes],
  );
  return { token, hash };
};

// A link ended before anyone could use it (its email didn't go).
export const endLink = (db, hash) => db.query(
  'update password_resets set expires_at = now() where token_hash = $1 and used_at is null', [hash],
);

// The campaign the account belongs to first (its name goes in the email).
const firstCampaign = async (db, userId) => (await db.query(
  `select w.id, w.name from memberships m join workspaces w on w.id = m.workspace_id
    where m.user_id = $1 order by m.created_at limit 1`,
  [userId],
)).rows[0] || null;

export const forgotEmail = ({ campaign, link }) => ({
  subject: `Reset your password for ${campaign} on base.win`,
  text: `Someone asked to reset the password for this address on ${campaign}’s base.win.\n\n`
    + `Choose a new one here (works once, for ${EMAIL_MINUTES} minutes): ${link}\n\n`
    + 'If it wasn’t you, ignore this email: your password stays the same.',
});

export const managerEmail = ({ campaign, manager, link }) => ({
  subject: `Choose a password for ${campaign} on base.win`,
  text: `${manager} made you a link to choose a new password on ${campaign}’s base.win.\n\n`
    + `Choose one here (works once, for ${MANAGER_HOURS} hours): ${link}\n\n`
    + `If you didn’t expect this, ask ${manager}.`,
});

// One email: never more than once for the same link, whatever retries.
export const sendLink = ({ to, token, hash, words }) => sendEmail({
  to, subject: words.subject, text: words.text, idempotencyKey: `reset:${hash.slice(0, 32)}`,
}).then((r) => r, () => ({ sent: false }));

// Forgot password's work, after the answer has gone (the answer is the same
// whether or not the address has an account). Does nothing for an unknown
// address, base.win support, the demo's account, someone in no campaign,
// or one with LIVE_MAX links still working.
export const sendReset = async (db, email) => {
  if (!resetByEmail()) return { sent: false };
  const e = String(email || '').trim().toLowerCase();
  if (!e || e === demoEmail()) return { sent: false };
  const user = (await db.query('select id, email, support from users where email = $1', [e])).rows[0];
  if (!user || user.support) return { sent: false };
  const ws = await firstCampaign(db, user.id);
  if (!ws) return { sent: false };
  const made = await makeLink(db, user.id);
  if (!made) return { sent: false };
  const words = forgotEmail({ campaign: ws.name, link: resetLink(made.token) });
  const r = await sendLink({ to: user.email, ...made, words });
  return { sent: Boolean(r.sent) };
};

// Each ask runs after its answer; tests wait for the last one.
let lastWork = Promise.resolve();
export const queueReset = (db, email) => {
  lastWork = new Promise((resolve) => queueMicrotask(resolve))
    .then(() => sendReset(db, email))
    // Never the address in the log.
    .catch((err) => { console.error('forgot password: the email was not sent', err?.code || err?.name || 'error'); });
  return lastWork;
};
export const _lastResetWork = () => lastWork;

// A link that still works → its account's email; else null.
export const checkLink = async (db, token) => {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return (await db.query(
    `select r.user_id, u.email from password_resets r join users u on u.id = r.user_id
      where r.token_hash = $1 and r.used_at is null and r.expires_at > now() and not u.support`,
    [tokenHash(token)],
  )).rows[0] || null;
};

// Inside the reset's write: the link used (once), the new password, every
// sign-in and every waiting code step ended, and the account's other links
// ended too. → { user_id, made_by } or null (run out, or used just now).
export const useLink = async (tx, token, passwordHash) => {
  const row = (await tx.query(
    `update password_resets set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning user_id, made_by`,
    [tokenHash(token)],
  )).rows[0];
  if (!row) return null;
  const n = await tx.query('update users set password_hash = $2 where id = $1 and support = false', [row.user_id, passwordHash]);
  if (n.affectedRows === 0) return null;
  await tx.query('delete from sessions where user_id = $1', [row.user_id]);
  await tx.query('delete from two_step_pending where user_id = $1', [row.user_id]);
  await tx.query('update password_resets set expires_at = now() where user_id = $1 and used_at is null', [row.user_id]);
  return row;
};

// What goes on each campaign's log: that it happened and how — never the token.
export const resetEvent = (row) => ({
  password_reset: true, via: row.made_by ? 'manager link' : 'email link', made_by: row.made_by || null,
});
