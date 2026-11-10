// POST /hooks/mail/:provider — the email sender's delivery events (public).
//
// A delivery must carry the sender's signature over its exact bytes
// (lib/mail: Svix's HMAC for Resend, ECDSA for SendGrid) or it is refused
// with nothing read. Each event is done once (mail_events), in the same
// write as what it did, so a repeat changes nothing and a failure answers
// 500 for the sender to try again.
//
// What an event does:
//   delivered    delivered_at on the recipient's row — one write, no campaign
//                lock, the way an open is counted (there is one per email).
//                A row still 'sending' (not sure it went) becomes 'sent':
//                that one is a write on the event log, and the send's own
//                status follows.
//   bounced      (for good) and complained: on the event log as the system
//                (mail.event) — the row is marked, and the address goes on
//                the campaign's suppression list, so nothing emails it again.
//                A complaint is also a no to email: the consent is ended and
//                recorded (emailOff).
//   suppressed   the sender refused to send because of its own list: the row
//                counts as bounced and the address is suppressed here too, so
//                base.win's count and the sender's agree. No consent changes.
//   deferred     the sender has it and is still trying: its words are kept
//                on the row until it arrives (and a row "not sure it went"
//                did go). failed: the sender's words on the row; nothing else.
// The row is found by base.win's own ref (it rides on every email), else by
// the sender's id. An event with no row of ours — a ladder email, a receipt
// — still stops the address after a bounce or a complaint, in every campaign
// on this server that holds it, as a STOP does for a number.
// Events are kept 30 days (long past any sender's retries), then dropped.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { newId, runAction } from '../../lib/events.js';
import { activeProvider, hookOn, providerByKey } from '../../lib/mail/index.js';
import { settleBlast } from '../abtests/send.js';
import { emailOff } from '../site/consent.js';

export const EVENT_ACTION = 'mail.event';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (s) => String(s ?? '').trim().toLowerCase();
// Events that stop an address.
const STOPS = new Set(['bounced', 'complained', 'suppressed']);
// Events that say the sender has (or had) the email: a row "not sure it
// went" went. Not 'failed': the sender couldn't send that one.
const WENT = new Set(['delivered', 'bounced', 'complained', 'suppressed', 'deferred']);

// "Each event once": false when this one was done before.
const claim = async (q, provider, ev, workspaceId) => (await q.query(
  `insert into mail_events (provider, id, workspace_id, kind) values ($1, $2, $3, $4)
   on conflict (provider, id) do nothing returning id`,
  [provider.key, ev.id, workspaceId, ev.kind],
)).rows.length > 0;

// The recipient row an event is about: by our own ref, else by the sender's
// id for the email (when exactly one row carries it). A ref only counts when
// the address is that row's too — another app on the same sender account may
// tag its emails in its own way.
const ROW = 'id, workspace_id, blast_id, person_id, email, status';
const rowFor = async (db, provider, ev) => {
  const same = (r) => r && r.email && (!ev.email || lower(r.email) === ev.email);
  if (ev.ref && UUID.test(ev.ref)) {
    const r = (await db.query(`select ${ROW} from blast_recipients where id = $1`, [ev.ref])).rows[0];
    if (same(r)) return r;
  }
  if (ev.messageId) {
    const rows = (await db.query(
      `select ${ROW} from blast_recipients where provider_id = $1 and provider = $2 limit 2`, [ev.messageId, provider.key],
    )).rows;
    if (rows.length === 1 && same(rows[0])) return rows[0];
  }
  return null;
};

// Every campaign on this server that holds the address: someone on file
// with it, or a newsletter subscription. (ext/mailchimp asks the same.)
export const holders = async (db, email) => (await db.query(
  `select w.id from workspaces w
   where exists (select 1 from persons p where p.workspace_id = w.id and lower(p.email) = $1 and p.deleted_at is null)
      or exists (select 1 from subscriptions s where s.workspace_id = w.id and s.email = $1)
   order by w.created_at, w.id`,
  [email],
)).rows.map((r) => r.id);

const detailOf = (provider, ev) => (ev.kind === 'suppressed'
  ? `${provider.name} won’t send to it — ${ev.detail || 'it is on its suppression list'}`
  : ev.detail || (ev.kind === 'failed' ? `${provider.name} couldn’t send it` : ev.kind === 'deferred' ? 'Delivery delayed' : null));
// The sender's words kept on a row after this event, given what the row
// already says: a bounce's words stay whatever comes later; an email that
// arrived has none (an earlier delay is moot, a later one says nothing new);
// otherwise the latest delay or failure.
const wordsAfter = (provider, ev, cur) => {
  if (cur.bounced_at) return cur.bounce_detail;
  if (ev.kind === 'bounced' || ev.kind === 'suppressed') return detailOf(provider, ev);
  if (ev.kind === 'delivered') return null;
  if (ev.kind === 'deferred' || ev.kind === 'failed') return cur.delivered_at ? cur.bounce_detail : detailOf(provider, ev);
  return cur.bounce_detail;
};

// Put an address on the campaign's suppression list (inside a write).
// → whether anything changed: a new address, one the desk had lifted, or a
// bounce that is now a complaint. Nothing changes for one already there.
export const suppress = async (tx, emit, workspaceId, { email, reason, source, detail = null }) => {
  const cur = (await tx.query(
    'select id, reason, lifted_at from email_suppressions where workspace_id = $1 and email = $2 for update', [workspaceId, email],
  )).rows[0];
  if (cur && !cur.lifted_at && (cur.reason === reason || cur.reason === 'complaint')) return false;
  const id = cur?.id || newId();
  if (cur) {
    await tx.query(
      `update email_suppressions set reason = $3, source = $4, detail = $5, lifted_at = null,
         created_at = case when lifted_at is null then created_at else now() end
       where id = $1 and workspace_id = $2`,
      [id, workspaceId, reason, source, detail],
    );
  } else {
    await tx.query(
      'insert into email_suppressions (id, workspace_id, email, reason, source, detail) values ($1, $2, $3, $4, $5, $6)',
      [id, workspaceId, email, reason, source, detail],
    );
  }
  emit('email_suppression', id, cur ? 'update' : 'create', { email, reason, source });
  return true;
};

// What an event does to its recipient's row (inside a write; the row is
// read again under a lock). → whether the row went from "not sure" (or
// refused) to sent, so the send's own status needs another look.
const markRow = async (tx, emit, provider, ev, row) => {
  const cur = (await tx.query(
    'select status, delivered_at, bounced_at, complained_at, bounce_detail from blast_recipients where id = $1 and workspace_id = $2 for update',
    [row.id, row.workspace_id],
  )).rows[0];
  if (!cur) return false;
  const settle = WENT.has(ev.kind) && (cur.status === 'sending' || cur.status === 'failed');
  const delivered = ev.kind === 'delivered' && !cur.delivered_at;
  const bounce = (ev.kind === 'bounced' || ev.kind === 'suppressed') && !cur.bounced_at;
  const complaint = ev.kind === 'complained' && !cur.complained_at;
  await tx.query(
    `update blast_recipients set
       status = case when $3::boolean then 'sent' else status end,
       sent_at = case when $3::boolean then coalesce(sent_at, $4::timestamptz) else sent_at end,
       send_asked_at = case when $3::boolean then null else send_asked_at end,
       delivered_at = case when $5::boolean then $4::timestamptz else delivered_at end,
       bounced_at = case when $6::boolean then $4::timestamptz else bounced_at end,
       bounce_detail = $8,
       complained_at = case when $7::boolean then $4::timestamptz else complained_at end,
       provider = coalesce(provider, $9), provider_id = coalesce(provider_id, $10)
     where id = $1 and workspace_id = $2`,
    [row.id, row.workspace_id, settle, ev.at || new Date().toISOString(), delivered, bounce, complaint,
      wordsAfter(provider, ev, cur), provider.key, ev.messageId || null],
  );
  if (settle || bounce || complaint) {
    emit('blast_recipient', row.id, 'update', {
      blast_id: row.blast_id, ...(settle ? { status: 'sent' } : {}), ...(bounce ? { bounced: true } : {}), ...(complaint ? { complained: true } : {}),
    });
  }
  return settle;
};

// A row that went from "not sure" to sent: the send's status and counts
// follow (written only when they differ from what the send says).
const settleSend = async (tx, emit, row) => {
  const s = await settleBlast(tx, row.workspace_id, row.blast_id, { quiet: true });
  if (s?.wrote) emit('blast', row.blast_id, 'update', { status: s.status });
};

// Whether email to this address is still on in the campaign: on the
// newsletter list as subscribed, or (never on the list) someone on file with
// it who isn't do-not-email — what emailOff would turn off.
export const stillOn = async (tx, workspaceId, email) => {
  const sub = (await tx.query('select status from subscriptions where workspace_id = $1 and email = $2', [workspaceId, email])).rows[0];
  if (sub) return sub.status !== 'unsubscribed';
  return (await tx.query(
    `select 1 from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null
       and not (tags @> '"do-not-email"'::jsonb) limit 1`, [workspaceId, email],
  )).rows.length > 0;
};

// An event that changes who may be emailed, in one campaign.
const stop = async (tx, emit, provider, ev, { workspaceId, row, email }) => {
  const settled = row ? await markRow(tx, emit, provider, ev, row) : false;
  const reason = ev.kind === 'complained' || ev.reason === 'complaint' ? 'complaint' : 'bounce';
  const changed = await suppress(tx, emit, workspaceId, { email, reason, source: provider.key, detail: detailOf(provider, ev) });
  // A complaint is also a no to email, recorded once: with the address's
  // first complaint, or whenever email to it is still on (the sender's own
  // list said "complaint" before the reader's complaint reached us).
  if (ev.kind === 'complained' && (changed || await stillOn(tx, workspaceId, email))) {
    await emailOff(tx, workspaceId, { personId: row?.person_id || null, email, source: 'complaint' }, emit);
  }
  if (settled) await settleSend(tx, emit, row);
};

// One event, once. → 'done' | 'duplicate' | 'unmatched'
export const handleEvent = async (db, provider, ev) => {
  if ((await db.query('select 1 from mail_events where provider = $1 and id = $2', [provider.key, ev.id])).rows.length) return 'duplicate';
  const row = await rowFor(db, provider, ev);
  const act = (workspaceId, fn) => runAction(db, { workspaceId, actorId: null, action: EVENT_ACTION }, fn);

  if (STOPS.has(ev.kind)) {
    const email = ev.email || lower(row?.email);
    const campaigns = row ? [row.workspace_id] : email ? await holders(db, email) : [];
    if (!campaigns.length) return (await claim(db, provider, ev, null)) ? 'unmatched' : 'duplicate';
    // Each campaign in its own write; every step is safe to repeat, and the
    // event is marked done with the last one — so a failure midway is
    // finished when the sender sends it again.
    let outcome = 'done';
    for (const [i, workspaceId] of campaigns.entries()) {
      const { result } = await act(workspaceId, async (tx, emit) => {
        if (i === campaigns.length - 1 && !(await claim(tx, provider, ev, workspaceId))) return 'duplicate';
        await stop(tx, emit, provider, ev, { workspaceId, row, email });
        return 'done';
      });
      outcome = result;
    }
    return outcome;
  }

  if (!row) return (await claim(db, provider, ev, null)) ? 'unmatched' : 'duplicate';
  // The sender is telling us about a row we weren't sure of: a write on the log.
  if (WENT.has(ev.kind) && (row.status === 'sending' || row.status === 'failed')) {
    return (await act(row.workspace_id, async (tx, emit) => {
      if (!(await claim(tx, provider, ev, row.workspace_id))) return 'duplicate';
      if (await markRow(tx, emit, provider, ev, row)) await settleSend(tx, emit, row);
      return 'done';
    })).result;
  }
  // Delivered (the row already 'sent'), delayed or failed: the row alone.
  // The words follow wordsAfter's rule, in one statement.
  return db.transaction(async (tx) => {
    if (!(await claim(tx, provider, ev, row.workspace_id))) return 'duplicate';
    await tx.query(
      `update blast_recipients set
         delivered_at = case when $3 = 'delivered' then coalesce(delivered_at, $4::timestamptz) else delivered_at end,
         bounce_detail = case when bounced_at is not null then bounce_detail
                              when $3 = 'delivered' then null
                              when delivered_at is not null then bounce_detail
                              else $5 end,
         provider = coalesce(provider, $6), provider_id = coalesce(provider_id, $7)
       where id = $1 and workspace_id = $2`,
      [row.id, row.workspace_id, ev.kind, ev.at || new Date().toISOString(), detailOf(provider, ev), provider.key, ev.messageId || null],
    );
    return 'done';
  });
};

// Events older than 30 days are dropped: far past any sender's retries, and
// one row per email would otherwise grow without end. Looked at every few
// hours, when a delivery comes in; never in the way of one.
const KEEP = "interval '30 days'";
const PRUNE_EVERY_MS = 6 * 3600_000;
let prunedAt = 0;
export const pruneEvents = (db) => db.query(`delete from mail_events where received_at < now() - ${KEEP}`);
const pruneSoon = (db) => {
  if (Date.now() - prunedAt < PRUNE_EVERY_MS) return;
  prunedAt = Date.now();
  pruneEvents(db).catch((e) => console.error('mail: old delivery events not cleared:', e.message));
};

// A delivery's events, a few at a time (SendGrid posts hundreds in one
// delivery): each is its own short write, and no two events share an id.
const TOGETHER = 6;
const handleAll = async (db, provider, events) => {
  const todo = events.filter((ev) => ev.id); // nothing to tell a repeat by: left alone
  let duplicate = 0;
  let failed = null;
  const work = async () => {
    for (let ev = todo.shift(); ev && !failed; ev = todo.shift()) {
      try { if ((await handleEvent(db, provider, ev)) === 'duplicate') duplicate += 1; } catch (e) { failed = e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TOGETHER, todo.length) }, work));
  if (failed) throw failed;
  return duplicate;
};

export const publicRoutes = new Hono();

publicRoutes.post('/hooks/mail/:provider', async (c) => {
  const provider = providerByKey(c.req.param('provider'));
  // Only the sender in use is heard here.
  if (!provider || provider !== activeProvider()) return c.json({ error: 'not found' }, 404);
  if (!hookOn(provider)) return c.json({ error: `delivery events aren’t set up here (${provider.hookNeeds.join(', ')} isn’t set)` }, 503);
  const raw = Buffer.from(await c.req.arrayBuffer());
  const header = (name) => c.req.header(name) ?? null;
  if (!provider.verify(raw, header)) return c.json({ error: 'signature refused' }, 400);
  let events;
  try { events = provider.parse(raw, header); } catch { return c.json({ error: 'not an event' }, 400); }
  let duplicate = 0;
  try {
    const db = await getDb();
    duplicate = await handleAll(db, provider, events);
    pruneSoon(db);
  } catch (e) {
    console.error(`mail: a ${provider.name} delivery event failed — it will be sent again:`, e.message);
    return c.json({ error: 'not done — send it again' }, 500);
  }
  // What the sender's dashboard shows for the delivery: counts, never a person.
  return c.json({ received: true, events: events.length, ...(duplicate ? { duplicate } : {}) });
});
// Nothing else answers at this address (never the app's own page).
publicRoutes.all('/hooks/mail/:provider', (c) => c.json({ error: 'not found' }, 404));
