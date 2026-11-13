// Sending one email through a staff member's own Gmail (gmail.send's and
// gmail.test's `after`, outside the campaign's write), and the words for
// every answer Gmail or Google gives.
//
//   GMAIL_API_BASE    test address (server/test/fake-google.js); ignored in
//                     production, so a stray value can never send mail
//                     elsewhere
//   GMAIL_DAILY_MAX   sends a person may make in 24 hours, every campaign on
//                     this server counted (default 100, 1–400): far below
//                     Gmail's own limits, so a mistake never gets a staff
//                     mailbox suspended
//
// Gmail's messages.send takes no idempotency key: a send that may have gone
// is "Not sure it went", never tried again by base.win.
import { runAction } from '../../lib/events.js';
import { clockAt } from '../../lib/org.js';
import { scrubbed } from '../../lib/google/flow.js';
import { googleFetch, grantFor, markReconnect } from '../../lib/google/tokens.js';

export const GMAIL_API = 'https://gmail.googleapis.com';
const env = (k) => String(process.env[k] || '').trim();
const testBase = () => (process.env.NODE_ENV === 'production' ? '' : env('GMAIL_API_BASE').replace(/\/+$/, ''));
export const gmailBase = () => testBase() || GMAIL_API;
export const gmailTestBaseInUse = () => Boolean(testBase());
export const sendUrl = () => `${gmailBase()}/gmail/v1/users/me/messages/send`;

export const dailyMax = () => {
  const n = Math.floor(Number(env('GMAIL_DAILY_MAX') || 100));
  return Number.isFinite(n) ? Math.min(400, Math.max(1, n)) : 100;
};

// Gmail's own timeout (GSI's 10 s); a test makes it shorter.
let TIMEOUT_MS = 10_000;
export const _setGmailTimeoutForTest = (ms) => { TIMEOUT_MS = ms; };
// A day's limit with no Retry-After waits an hour, not a minute.
const QUOTA_PAUSE_MS = 3_600_000;

// ── The Gmail API turned off in Google Cloud: no sends for 60 s ──
// Server-wide (the map tiles' refused/pausedFor shape, lib/gtiles.js); GSI's
// own pauses are untouched.
const API_OFF_MS = 60_000;
let apiOff = null; // { until (ms), said }
export const apiOffNow = () => (apiOff && apiOff.until > Date.now() ? { until: new Date(apiOff.until).toISOString(), said: apiOff.said } : null);
const turnApiOff = (said) => {
  const already = Boolean(apiOffNow());
  apiOff = { until: Date.now() + API_OFF_MS, said };
  if (!already) console.warn('gmail: Gmail API is off in Google Cloud — no sends for 60 s');
};
export const _resetGmailForTest = () => { apiOff = null; };

// ── Words ──
// "3:40 pm", in the campaign's own time zone.
export const clock = clockAt;
export const WORDS = {
  notSetUp: 'Gmail isn’t set up on this server — see Settings → Services',
  off: 'Sending from Gmail is off for this campaign',
  connect: 'Connect your Gmail first — Your profile',
  reconnect: 'Gmail needs connecting again — Your profile',
  broken: 'Gmail isn’t working on this server — tell your campaign manager.',
  unsure: 'Not sure it went — check your Gmail’s Sent folder before sending again.',
  notReached: 'Google isn’t answering — nothing was sent. Try again in a minute.',
  badAddress: 'That email address isn’t valid — fix it under Edit',
  lost: 'base.win lost track of this send',
  waitUntil: (iso) => `Gmail asked us to wait — try after ${clock(iso)}`,
  waited: (iso) => `Gmail asked us to wait. Try after ${clock(iso)}.`,
  cap: (n) => `You’ve sent ${n.toLocaleString('en-CA')} from Gmail today — try tomorrow, or use Outreach → Email`,
};
export const REACH_WORDS = {
  no_email: 'No email on file',
  suppressed: 'That address bounced or reported spam — check it under Edit',
  do_not_email: 'They asked not to be emailed',
  do_not_contact: 'They asked not to be contacted',
};

// ── One bare address, exactly ──
// The stored value can be anything typed or imported ("a@b.co,c@d.co",
// "\"x\" <a@b.co>"); it goes into a To header, so nothing but one address.
export const oneAddress = (raw) => {
  const a = String(raw ?? '').trim();
  if (!a || a.length > 254) return null;
  if (/[,;<>"()[\]\\\s]/.test(a)) return null;
  const at = a.split('@');
  if (at.length !== 2 || !at[0] || !at[1] || !/\.[^.]+$/.test(at[1]) || at[1].startsWith('.')) return null;
  return a;
};

// ── The message ──
// A personal email: plain text, no tracking pixel, no tracked links, no
// List-Unsubscribe.
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const displayName = (s) => String(s ?? '').replace(/["\\\r\n]/g, '').replace(/\s+/g, ' ').trim();
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');
export const buildMessage = ({ fromName, from, to, subject, body }) => {
  const name = displayName(fromName);
  const head = [
    `From: ${name ? `"${encodeWord(name)}" ` : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeWord(String(subject).replace(/[\r\n]+/g, ' '))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const text = String(body).replace(/\r?\n/g, '\r\n');
  return `${head.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(text, 'utf8').toString('base64'))}`;
};

// ── Gmail's answer → the row ──
const reasonsOf = (body) => {
  const e = body?.error || {};
  return [
    ...(Array.isArray(e.errors) ? e.errors.map((x) => x?.reason) : []),
    ...(Array.isArray(e.details) ? e.details.map((d) => d?.reason) : []),
    e.status,
  ].filter(Boolean).map(String);
};
const googleWords = (body) => scrubbed(body?.error?.message || body?.text || '').replace(/\s+/g, ' ').trim();

// → { status, said, gmailId, code } — code for the screens: reconnect,
// paused, broken, unavailable, refused.
export const classify = async (db, grant, r) => {
  if (r.ok) return { status: 'sent', gmailId: r.body?.id ? String(r.body.id).slice(0, 100) : null, said: null };
  const t = r.trouble;
  if (!r.reached) {
    if (t?.code === 'reconnect') return { status: 'failed', said: WORDS.reconnect, code: 'reconnect' };
    if (t?.code === 'client') return { status: 'failed', said: WORDS.broken, code: 'broken' };
    return { status: 'failed', said: WORDS.notReached, code: 'unavailable' };
  }
  if (t?.code === 'reconnect') return { status: 'failed', said: WORDS.reconnect, code: 'reconnect' };
  if (t?.code === 'paused') return { status: 'failed', said: WORDS.waited(t.until), code: 'paused', until: t.until };
  // Asked, then no answer in time, the connection dropped, or a 5xx: it
  // may have gone.
  if (!r.status || r.status >= 500) return { status: 'unsure', said: WORDS.unsure, code: 'unsure' };
  const reasons = reasonsOf(r.body);
  if (r.status === 403 && reasons.some((x) => ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(x))) {
    await markReconnect(db, grant, 'Gmail sending wasn’t allowed — connect Gmail again');
    return { status: 'failed', said: WORDS.reconnect, code: 'reconnect' };
  }
  if (r.status === 403 && reasons.some((x) => ['accessNotConfigured', 'SERVICE_DISABLED'].includes(x))) {
    turnApiOff(googleWords(r.body));
    return { status: 'failed', said: WORDS.broken, code: 'broken' };
  }
  const said = googleWords(r.body);
  return { status: 'failed', said: `Gmail didn’t send it${said ? `: ${said}` : ''}`.slice(0, 300), code: 'refused' };
};

// The send itself, then its outcome on the row (a runAction of its own:
// gmail.result is not in the action registry, so no one can call it).
// → { result: { id, status, said?, code?, until? }, lastSeq }
export const deliver = async (db, ctx, id) => {
  const row = (await db.query('select * from gmail_sends where id = $1 and workspace_id = $2', [id, ctx.workspaceId])).rows[0];
  if (!row || row.status !== 'sending') return { result: { id, status: row?.status || 'failed', ...(row?.said ? { said: row.said } : {}) } };
  const grant = await grantFor(db, { userId: row.user_id, workspaceId: row.workspace_id }, 'gmail.send');
  let out;
  if (!grant) out = { status: 'failed', said: WORDS.connect, code: 'connect' };
  // Gone bad since the write (another tab's reconnect, the domain rule, a
  // role change): said as the write would have, nothing asked of Google.
  else if (grant.state !== 'ok') out = { status: 'failed', said: grant.state === 'reconnect' ? WORDS.reconnect : grant.said || WORDS.reconnect, code: 'reconnect' };
  else if (apiOffNow()) out = { status: 'failed', said: WORDS.broken, code: 'broken' };
  else {
    const raw = Buffer.from(buildMessage({
      fromName: ctx.user.name, from: grant.email, to: row.to_email, subject: row.subject, body: row.body,
    }), 'utf8').toString('base64url');
    const r = await googleFetch(db, grant, sendUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
    }, { retry: 'auth-only', quotaPauseMs: QUOTA_PAUSE_MS, timeoutMs: TIMEOUT_MS });
    out = await classify(db, grant, r);
  }
  const said = out.said ? scrubbed(out.said).slice(0, 300) : null;
  const { lastSeq } = await runAction(db, { workspaceId: row.workspace_id, actorId: row.user_id, action: 'gmail.result' }, async (tx, emit) => {
    const done = (await tx.query(
      `update gmail_sends set status = $3, gmail_id = $4, said = $5, done_at = now()
       where id = $1 and workspace_id = $2 and status = 'sending' returning id`,
      [row.id, row.workspace_id, out.status, out.gmailId || null, said],
    )).rows[0];
    if (done) emit('gmail_send', row.id, 'update', { status: out.status });
  });
  return {
    result: { id: row.id, status: out.status, ...(said ? { said } : {}), ...(out.code ? { code: out.code } : {}), ...(out.until ? { until: out.until } : {}) },
    lastSeq,
  };
};

// The gmail.settle job: a row still 'sending' 15 minutes on (the server
// restarted mid-send) is "Not sure it went". Any other status: nothing.
export const settleJob = async (db, job) => {
  const row = (await db.query('select id, workspace_id, user_id, status from gmail_sends where id = $1', [job.payload?.id])).rows[0];
  if (!row || row.status !== 'sending') return;
  await runAction(db, { workspaceId: row.workspace_id, actorId: row.user_id, action: 'gmail.settle' }, async (tx, emit) => {
    const done = (await tx.query(
      `update gmail_sends set status = 'unsure', said = $2, done_at = now() where id = $1 and status = 'sending' returning id`,
      [row.id, WORDS.lost],
    )).rows[0];
    if (done) emit('gmail_send', row.id, 'update', { status: 'unsure' });
  });
};
