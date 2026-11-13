// Media reads, under /api/media (area Media: lib/perms.js). Not desk-only:
// anyone holding Media reads them — but only the desk gets a contact's
// email and phone (a reporter's cell is not door-knocking data): for
// anyone else both are null, after the volunteer rule (lib/viewer.js).
//
//   GET /media/contacts       { contacts: [{ person, kind, outlet, beat, note,
//                             reachable, why, last }], counts: { media,
//                             influencer, emailable: { media, influencer, all } } }
//                             why: the first reason a release won't reach
//                             them (lib/reach.js). At most 2,000.
//   GET /media/releases       the press releases, newest first (200), with
//                             GET /blasts' counting fields and opened,
//                             clicked, bounced, ab_status, from_addr
//                             and emailConfigured (Send now / Try again wait for it);
//                             held_count: of retry_count, the rest of an A/B
//                             send still waiting for its winner (not to try
//                             again); first_sent_at: when the first copy went
//   GET /media/stats          GET /blasts/stats for press releases only (A/B
//                             state, opens and clicks per send)
//   GET /media/releases/:id   one, with its body and who it went to: { name,
//                             outlet, status, held, opened_at, clicked_at,
//                             bounced, complained } — no tokens, no addresses
import { Hono } from 'hono';
import { areasFor } from '../../lib/perms.js';
import { forViewer } from '../../lib/viewer.js';
import { azKey } from '../../lib/az.js';
import { mayReach, person, whyNotSql } from '../../lib/reach.js';
import { notSuppressed } from '../../lib/mail/index.js';
import { deliveredRow, goingRow, repeatRow, retryable, sendJobOn } from '../abtests/send.js';
import { attachmentsOf } from '../abtests/attach.js';
import { toWords } from '@starbase/shared/email/words';
import { sendStats, statsBody } from '../abtests/stats.js';
import { emailConfigured } from '../../lib/notify.js';
import { isDesk, kindOf, onMedia } from './rules.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTACTS_MAX = 2000;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const refuse = (c) => c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);
const mayRead = (ctx) => areasFor(ctx).includes('media');
const P = person('p', '$1');
const DELIVERED = deliveredRow('r');
// The rest of an A/B send before its winner is picked: held, not failed
// (blast.resend skips them the same way: send.js restReleased).
const HELD = `(r.ab_group = 'rest' and b.ab_status is not null and b.ab_winner is null)`;

// A person as this viewer may see them.
const shown = (ctx) => {
  const view = forViewer(ctx);
  return (p) => {
    const v = view(p);
    return isDesk(ctx) ? v : { ...v, email: null, phone: null };
  };
};

api.get('/media/contacts', async (c) => {
  const ctx = c.get('ctx');
  if (!mayRead(ctx)) return refuse(c);
  const db = c.get('db');
  const { rows } = await db.query(
    `select p.id, p.name, p.email, p.phone, p.socials, p.tags, m.outlet, m.beat, m.note,
            ${whyNotSql('email', 'press', P)} as why, l.*
     from persons p
     left join media_contacts m on m.workspace_id = p.workspace_id and m.person_id = p.id
     left join lateral (
       select b.id as release_id, b.subject, b.sent_at, r.bounced_at,
              (r.first_open_at is not null or r.first_click_at is not null) as opened
       from blast_recipients r join blasts b on b.id = r.blast_id and b.workspace_id = r.workspace_id
       -- The last release that reached them: one that failed or never went
       -- isn't "Not opened".
       where r.workspace_id = p.workspace_id and r.person_id = p.id and b.kind = 'press' and r.status = 'sent'
       order by b.created_at desc limit 1
     ) l on true
     where p.workspace_id = $1 and p.deleted_at is null and ${onMedia('p')}
     order by case when ${onMedia('p', ['media'])} then 0 else 1 end, lower(coalesce(m.outlet, '')) = '', lower(m.outlet), ${azKey('p')}
     limit ${CONTACTS_MAX}`,
    [ctx.workspaceId],
  );
  const counts = (await db.query(
    `select (count(*) filter (where ${onMedia('p', ['media'])}))::int as media,
            (count(*) filter (where not ${onMedia('p', ['media'])}))::int as influencer,
            (count(*) filter (where ok and ${onMedia('p', ['media'])}))::int as e_media,
            (count(*) filter (where ok and ${onMedia('p', ['influencer'])}))::int as e_influencer,
            (count(*) filter (where ok))::int as e_all
     from persons p cross join lateral (select ${mayReach('email', 'press', P)} as ok) x
     where p.workspace_id = $1 and p.deleted_at is null and ${onMedia('p')}`,
    [ctx.workspaceId],
  )).rows[0];
  const see = shown(ctx);
  return c.json({
    contacts: rows.map((r) => {
      const tags = parseJ(r.tags, []);
      const p = see({ id: r.id, name: r.name, email: r.email, phone: r.phone, socials: parseJ(r.socials, {}) || {}, tags });
      return {
        person: p, kind: kindOf(tags), outlet: r.outlet, beat: r.beat, note: r.note,
        reachable: !r.why, why: r.why || null,
        last: r.release_id ? { release_id: r.release_id, subject: toWords(r.subject), sent_at: r.sent_at, opened: !!r.opened, bounced: !!r.bounced_at } : null,
      };
    }),
    counts: {
      media: counts.media, influencer: counts.influencer,
      emailable: { media: counts.e_media, influencer: counts.e_influencer, all: counts.e_all },
    },
  });
});

// The same counts per send as GET /blasts (routes/api.js says what each
// means). A row still "live" is one the send would still email: still on
// the media list, no do-not tag, not suppressed (send.js deliver's re-check).
const RELEASE_COLS = `b.id, b.kind, b.subject, b.body, b.status, b.provider_note, b.audience_count, b.sent_at, b.created_at,
  b.audience, b.list_id, b.from_addr, b.ab_status,
  k.sent_count, k.failed_count, k.queued_count, k.retry_count, k.repeat_count, k.sending_count, k.going_count,
  k.held_count, k.first_sent_at, k.opened, k.clicked, k.bounced`;
const releases = (where) => `select ${RELEASE_COLS}
  from blasts b
  cross join lateral (select ${sendJobOn('b.id', 'b.workspace_id')} as job_on) j
  cross join lateral (
    select (count(*) filter (where r.status = 'sent'))::int as sent_count,
           (count(*) filter (where r.status = 'failed'))::int as failed_count,
           (count(*) filter (where r.status = 'queued' and l.live))::int as queued_count,
           (count(*) filter (where ${retryable('r')} and l.live and not (j.job_on and ${goingRow('r')})))::int as retry_count,
           (count(*) filter (where ${repeatRow('r')} and l.live and not (j.job_on and ${goingRow('r')})))::int as repeat_count,
           (count(*) filter (where ${HELD} and ${retryable('r')} and l.live and not (j.job_on and ${goingRow('r')})))::int as held_count,
           min(r.sent_at) as first_sent_at,
           (count(*) filter (where r.status = 'sending'))::int as sending_count,
           (count(*) filter (where j.job_on and ${goingRow('r')} and l.live))::int as going_count,
           (count(*) filter (where ${DELIVERED} and (r.first_open_at is not null or r.first_click_at is not null)))::int as opened,
           (count(*) filter (where ${DELIVERED} and r.first_click_at is not null))::int as clicked,
           (count(*) filter (where r.bounced_at is not null))::int as bounced
    from blast_recipients r
    left join persons rp on rp.id = r.person_id and rp.workspace_id = r.workspace_id and rp.deleted_at is null
    cross join lateral (
      select (rp.id is not null and ${onMedia('rp')}
        and ${mayReach('email', 'press', { ws: 'b.workspace_id', id: 'rp.id', email: 'r.email', phone: 'null::text', tags: 'rp.tags' })}
        and ${notSuppressed('b.workspace_id', 'r.email')}) as live
    ) l
    where r.workspace_id = b.workspace_id and r.blast_id = b.id
  ) k
  where b.workspace_id = $1 and b.kind = 'press' ${where}`;

const releaseOut = (b, files) => {
  const { body, ...rest } = b;
  // The subject in words ("[first name]"), as GET /blasts answers it: what
  // the compose's lost-answer check compares with what was typed.
  return { ...rest, subject: toWords(b.subject), audience: parseJ(b.audience, null), attachments: files[b.id] || [] };
};

api.get('/media/releases', async (c) => {
  const ctx = c.get('ctx');
  if (!mayRead(ctx)) return refuse(c);
  const db = c.get('db');
  const { rows } = await db.query(`${releases('')} order by b.created_at desc limit 200`, [ctx.workspaceId]);
  const files = await attachmentsOf(db, ctx.workspaceId);
  return c.json({ releases: rows.map((b) => releaseOut(b, files)), emailConfigured: emailConfigured() });
});

api.get('/media/stats', async (c) => {
  const ctx = c.get('ctx');
  if (!mayRead(ctx)) return refuse(c);
  return c.json(statsBody(await sendStats(c.get('db'), ctx.workspaceId, { press: true })));
});

api.get('/media/releases/:id', async (c) => {
  const ctx = c.get('ctx');
  if (!mayRead(ctx)) return refuse(c);
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'release not found' }, 404);
  const db = c.get('db');
  const b = (await db.query(`${releases('and b.id = $2')}`, [ctx.workspaceId, id])).rows[0];
  if (!b) return c.json({ error: 'release not found' }, 404);
  const recipients = (await db.query(
    `select r.person_id, coalesce(p.name, r.name) as name, m.outlet, r.status,
            (${HELD} and r.status = 'queued') as held,
            case when ${DELIVERED} then coalesce(r.first_open_at, r.first_click_at) end as opened_at,
            case when ${DELIVERED} then r.first_click_at end as clicked_at,
            (r.bounced_at is not null) as bounced, (r.complained_at is not null) as complained
     from blast_recipients r
     join blasts b on b.id = r.blast_id and b.workspace_id = r.workspace_id
     left join persons p on p.id = r.person_id and p.workspace_id = r.workspace_id
     left join media_contacts m on m.workspace_id = r.workspace_id and m.person_id = r.person_id
     where r.workspace_id = $1 and r.blast_id = $2
     order by person_fold(coalesce(p.last_name, p.name, r.name, '')) collate "C", person_fold(coalesce(p.name, r.name, '')) collate "C", r.id`,
    [ctx.workspaceId, id],
  )).rows;
  const files = await attachmentsOf(db, ctx.workspaceId);
  return c.json({ release: { ...releaseOut(b, files), body: b.body }, recipients, emailConfigured: emailConfigured() });
});
