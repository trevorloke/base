// Letters and op-eds, read (mounted under /api, signed in).
//
// The writer's own — no area, every role, only their own letters:
//   GET /letters/mine           { letters: [{ id, kind, title, status, outlets,
//                               not_printed_at, last_side, unseen, updated_at }], unseen }
//   GET /letters/mine/:id       the letter: drafts (both sides), notes, sends,
//                               the sign-off (what they changed for it over
//                               their person record), the wanted outlets'
//                               cards, dropped_outlets and blocked (an
//                               exclusive paper still has it). Reading it is
//                               "seen" (writer_seen_at; a stamp, no event).
//   GET /letters/outlets?kind=  outlets that take that kind, with only what a
//                               writer needs (published address or form,
//                               limit, rules), the talking points, the
//                               campaign's name and `you` (their own
//                               sign-off, to prefill — theirs alone)
//
// The desk's — area Media, never a volunteer whatever they were granted
// (the sign-off is a writer's address and phone):
//   GET /media/letters?status=  the queue, newest activity first (500)
//   GET /media/letters/count    { new, waiting } for Today's "Needs you"
//   GET /media/letters/:id      everything the writer's read has, plus the
//                               full sign-off, each outlet's rules check and
//                               Editors here. Reading it sets desk_seen_at.
import { Hono } from 'hono';
import { onMedia } from '../media/rules.js';
import { selfPerson } from '../relationships/match.js';
import { outAt, waitDays } from './actions.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const isDesk = (ctx) => ctx.role !== 'volunteer';
const refuse = (c) => c.json({ error: 'volunteers cannot view this' }, 403);
const notFound = (c) => c.json({ error: 'letter not found' }, 404);
const STATUSES = ['new', 'working', 'ready', 'sent', 'published', 'declined', 'withdrawn'];
// Spaced words; shared/letters.js size() counts by each outlet's unit (stage 2).
const words = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || null;

// An outlet as a writer sees it for one kind: its published address or
// form and its rules — never who checked them, never its contacts.
const cardFor = (o, kind) => {
  const op = kind === 'op_ed';
  return {
    id: o.id, name: o.name, kind: o.kind, newsroom: o.newsroom, language: o.language,
    limit: op ? o.oped_limit : o.letters_limit, limit_unit: o.limit_unit, subject_hint: o.subject_hint,
    asks_address: o.asks_address, asks_phone: o.asks_phone, exclusive: o.exclusive, local_only: o.local_only,
    no_candidates: o.no_candidates, disclose: o.disclose, rules: o.rules,
    email: op ? o.oped_email : o.letters_email, form: op ? o.oped_form : o.letters_form,
  };
};
const takesSql = (kind) => (kind === 'op_ed' ? '(oped_email is not null or oped_form is not null)' : '(letters_email is not null or letters_form is not null)');

const outletsOf = async (db, ws, ids) => (ids.length ? (await db.query(
  'select * from media_outlets where workspace_id = $1 and id = any($2::uuid[])', [ws, ids],
)).rows : []);

// The sign-off: what the writer changed for this letter, over their record.
const signOf = (l, p) => ({
  name: l.sign_name ?? p?.name ?? null,
  city: l.sign_city ?? p?.city ?? null,
  address: l.sign_address ?? p?.address ?? null,
  phone: l.sign_phone ?? p?.phone ?? null,
});
const personOf = async (db, ws, id) => (id ? (await db.query(
  'select id, name, city, address, phone from persons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws],
)).rows[0] : null);

// The last paper that didn't print it, while it waits in Ready.
const NOT_PRINTED = `(select o.name from letter_sends s left join media_outlets o on o.id = s.outlet_id
  where s.letter_id = l.id and s.outcome = 'not_published' order by s.outcome_at desc limit 1)`;

// One letter, as both sides read it (the desk adds its own on top).
const letterOut = async (db, ctx, l) => {
  const ws = ctx.workspaceId;
  const ids = parseJ(l.outlet_ids, []);
  const [drafts, notes, sends] = await Promise.all([
    db.query(
      `select v.id, v.n, v.side, v.body, v.from_version, v.created_at, u.name as by_name
       from letter_versions v left join users u on u.id = v.by_user where v.letter_id = $1 order by v.n`, [l.id],
    ),
    db.query(
      `select n.id, n.side, n.body, n.created_at, u.name as by_name
       from letter_notes n left join users u on u.id = n.by_user where n.letter_id = $1 order by n.created_at, n.id`, [l.id],
    ),
    db.query(
      `select s.id, s.outlet_id, o.name as outlet_name, s.how, s.sent_at, s.outcome, s.url, s.published_on::text as published_on,
              s.while_out_at, w.name as while_out_name
       from letter_sends s left join media_outlets o on o.id = s.outlet_id
       left join letter_sends ws on ws.id = s.while_out_at left join media_outlets w on w.id = ws.outlet_id
       where s.letter_id = $1 order by s.sent_at, s.id`, [l.id],
    ),
  ]).then((r) => r.map((x) => x.rows));
  const outlets = await outletsOf(db, ws, ids);
  const by = new Map(outlets.map((o) => [o.id, o]));
  const live = ids.map((id) => by.get(id)).filter((o) => o && !o.deleted_at);
  const days = waitDays(ctx.workspace);
  const blocked = [];
  for (const o of live) {
    const out = (await outAt(db, ctx, l.id, o, days))[0];
    if (out) blocked.push({ outlet_id: o.id, by: out.name, until: new Date(new Date(out.sent_at).getTime() + days * 86400000).toISOString() });
  }
  const person = await personOf(db, ws, l.person_id);
  return {
    id: l.id, kind: l.kind, title: l.title, status: l.status, created_at: l.created_at, updated_at: l.updated_at,
    agreed_version: l.agreed_version, agreed_at: l.agreed_at, disclose_line: l.disclose_line, email_me: l.email_me,
    declined_note: l.declined_note, last_side: l.last_side, last_at: l.last_at,
    outlets: live.map((o) => cardFor(o, l.kind)),
    dropped_outlets: ids.filter((id) => !by.get(id) || by.get(id).deleted_at).map((id) => ({ id, name: by.get(id)?.name || null })),
    blocked,
    drafts: drafts.map((d) => ({
      id: d.id, n: d.n, side: d.side, body: d.body, from_version: d.from_version, created_at: d.created_at,
      ...(d.side === 'campaign' ? { by: firstName(d.by_name) } : {}),
    })),
    notes: notes.map((n) => ({ id: n.id, side: n.side, body: n.body, created_at: n.created_at, ...(n.side === 'campaign' ? { by: firstName(n.by_name) } : {}) })),
    sends: sends.map((s) => ({
      id: s.id, outlet_id: s.outlet_id, outlet_name: s.outlet_name, how: s.how, sent_at: s.sent_at, outcome: s.outcome,
      url: s.url, published_on: s.published_on, while_out_at: s.while_out_at ? { id: s.while_out_at, outlet_name: s.while_out_name } : null,
    })),
    sign: signOf(l, person),
    // stored: which sign-off fields the writer changed for this letter.
    sign_stored: Object.fromEntries(['name', 'city', 'address', 'phone'].map((k) => [k, l[`sign_${k}`] != null])),
  };
};

// ── The writer's own ──
api.get('/letters/mine', async (c) => {
  const ctx = c.get('ctx');
  const rows = (await c.get('db').query(
    `select l.id, l.kind, l.title, l.status, l.outlet_ids, l.last_side, l.updated_at,
            (l.last_side = 'campaign' and l.last_at > coalesce(l.writer_seen_at, 'epoch'::timestamptz)) as unseen,
            case when l.status = 'ready' then ${NOT_PRINTED} end as not_printed_at,
            (select v.body from letter_versions v where v.letter_id = l.id and v.side = 'writer' order by v.n desc limit 1) as body
     from letters l where l.workspace_id = $1 and l.writer_user = $2
     order by coalesce(l.last_at, l.created_at) desc, l.id limit 200`,
    [ctx.workspaceId, ctx.user.id],
  )).rows;
  const ids = [...new Set(rows.flatMap((r) => parseJ(r.outlet_ids, [])))];
  const names = new Map((await outletsOf(c.get('db'), ctx.workspaceId, ids)).map((o) => [o.id, o.name]));
  return c.json({
    letters: rows.map((r) => ({
      id: r.id, kind: r.kind, title: r.title,
      // The first words, for a letter with no headline.
      first_words: r.body ? r.body.trim().split(/\s+/).slice(0, 12).join(' ') : '',
      status: r.status, outlets: parseJ(r.outlet_ids, []).filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) })),
      not_printed_at: r.not_printed_at || null, last_side: r.last_side, unseen: Boolean(r.unseen), updated_at: r.updated_at,
    })),
    unseen: rows.filter((r) => r.unseen).length,
  });
});

api.get('/letters/mine/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return notFound(c);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const l = (await db.query('select * from letters where id = $1 and workspace_id = $2 and writer_user = $3', [id, ctx.workspaceId, ctx.user.id])).rows[0];
  if (!l) return notFound(c);
  await db.query('update letters set writer_seen_at = now() where id = $1 and workspace_id = $2', [id, ctx.workspaceId]);
  return c.json({ letter: await letterOut(db, ctx, l) });
});

api.get('/letters/outlets', async (c) => {
  const ctx = c.get('ctx');
  const kind = c.req.query('kind') === 'op_ed' ? 'op_ed' : 'letter';
  const db = c.get('db');
  const rows = (await db.query(
    `select * from media_outlets where workspace_id = $1 and deleted_at is null and ${takesSql(kind)} order by lower(name), id`,
    [ctx.workspaceId],
  )).rows;
  const me = await selfPerson(db, ctx, () => {}, { create: false });
  const p = me ? await personOf(db, ctx.workspaceId, me.id) : null;
  return c.json({
    kind,
    outlets: rows.map((o) => cardFor(o, kind)),
    points: ctx.workspace.settings?.letters?.points || null,
    campaign_name: ctx.workspace.name,
    you: {
      candidate: Boolean(ctx.candidate), desk: isDesk(ctx),
      sign: { name: p?.name || ctx.user.name || null, city: p?.city || null, address: p?.address || null, phone: p?.phone || null },
    },
  });
});

// ── The desk's ──
const WAITING = `(l.status in ('new','working','ready') and l.last_side = 'writer' and l.last_at > coalesce(l.desk_seen_at, 'epoch'::timestamptz))`;

api.get('/media/letters/count', async (c) => {
  const ctx = c.get('ctx');
  if (!isDesk(ctx)) return refuse(c);
  const r = (await c.get('db').query(
    // waiting: ones past New the writer has moved since the desk looked (New counts once, as new).
    `select (count(*) filter (where l.status = 'new'))::int as new,
            (count(*) filter (where l.status <> 'new' and ${WAITING}))::int as waiting
     from letters l where l.workspace_id = $1`,
    [ctx.workspaceId],
  )).rows[0];
  return c.json({ new: r.new, waiting: r.waiting });
});

api.get('/media/letters', async (c) => {
  const ctx = c.get('ctx');
  if (!isDesk(ctx)) return refuse(c);
  const status = c.req.query('status');
  const want = status ? status.split(',').filter((s) => STATUSES.includes(s)) : [];
  const db = c.get('db');
  const rows = (await db.query(
    `select l.id, l.kind, l.title, l.status, l.outlet_ids, l.last_side, l.last_at, l.person_id, l.agreed_campaign_share,
            coalesce(p.name, wu.name) as writer_name, au.name as assigned_to_name, ${WAITING} as waiting,
            case when l.status = 'ready' then ${NOT_PRINTED} end as not_printed_at,
            exists (select 1 from letter_sends s where s.letter_id = l.id and s.while_out_at is not null) as sent_while_out,
            (select v.body from letter_versions v where v.letter_id = l.id and v.side = 'writer' order by v.n desc limit 1) as body
     from letters l
     left join persons p on p.id = l.person_id and p.workspace_id = l.workspace_id
     left join users wu on wu.id = l.writer_user
     left join users au on au.id = l.assigned_to
     where l.workspace_id = $1 ${want.length ? 'and l.status = any($2::text[])' : ''}
     order by coalesce(l.last_at, l.created_at) desc, l.id limit 500`,
    want.length ? [ctx.workspaceId, want] : [ctx.workspaceId],
  )).rows;
  const ids = [...new Set(rows.flatMap((r) => parseJ(r.outlet_ids, [])))];
  const names = new Map((await outletsOf(db, ctx.workspaceId, ids)).map((o) => [o.id, o.name]));
  return c.json({
    letters: rows.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, first_words: r.body ? r.body.trim().split(/\s+/).slice(0, 12).join(' ') : '',
      status: r.status, writer: { name: r.writer_name || null, person_id: r.person_id },
      outlets: parseJ(r.outlet_ids, []).filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) })),
      assigned_to_name: r.assigned_to_name || null, last_side: r.last_side, last_at: r.last_at, waiting: Boolean(r.waiting),
      size: words(r.body), not_printed_at: r.not_printed_at || null, sent_while_out: Boolean(r.sent_while_out),
      mostly_campaign: r.agreed_campaign_share != null && Number(r.agreed_campaign_share) > 0.5,
    })),
  });
});

api.get('/media/letters/:id', async (c) => {
  const ctx = c.get('ctx');
  if (!isDesk(ctx)) return refuse(c);
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return notFound(c);
  const db = c.get('db');
  const l = (await db.query('select * from letters where id = $1 and workspace_id = $2', [id, ctx.workspaceId])).rows[0];
  if (!l) return notFound(c);
  await db.query('update letters set desk_seen_at = now() where id = $1 and workspace_id = $2', [id, ctx.workspaceId]);
  const out = await letterOut(db, ctx, l);
  const ids = parseJ(l.outlet_ids, []);
  const outlets = await outletsOf(db, ctx.workspaceId, ids);
  const checked = new Map(outlets.map((o) => [o.id, o.confirmed_on ? new Date(o.confirmed_on).toISOString().slice(0, 10) : null]));
  // Editors here: live contacts on the matching list at a wanted outlet.
  const list = l.kind === 'op_ed' ? 'op_ed' : 'letters';
  const names = out.outlets.map((o) => o.name.toLowerCase());
  const editors = names.length ? (await db.query(
    `select p.id as person_id, p.name, p.email, p.phone, m.outlet from media_contacts m
     join persons p on p.id = m.person_id and p.workspace_id = m.workspace_id and p.deleted_at is null
     where m.workspace_id = $1 and m.left_at is null and m.lists ? $2 and lower(m.outlet) = any($3::text[]) and ${onMedia('p')}
     order by lower(p.name), p.id`,
    [ctx.workspaceId, list, names],
  )).rows : [];
  const writer = l.writer_user ? (await db.query('select name from users where id = $1', [l.writer_user])).rows[0] : null;
  return c.json({
    letter: {
      ...out,
      writer: { name: out.sign.name || writer?.name || null, person_id: l.person_id, user_name: writer?.name || null },
      assigned_to: l.assigned_to,
      agreed_campaign_share: l.agreed_campaign_share,
      outlets: out.outlets.map((o) => ({ ...o, confirmed_on: checked.get(o.id) || null })),
      editors,
    },
  });
});
