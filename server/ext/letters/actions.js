// Letters and op-eds: the writer's actions (myletter.*) and the desk's (letter.*).
//
// The writer's own — no area (lib/perms.js names none), every role, and
// only ever their own letter (any other answers 404, whoever asks). The
// phone's outbox carries submit, revise, note, sent, published and
// not_published, keyed by client_id; agree, details, withdraw and delete
// need signal.
//   myletter.submit         { client_id, kind, title?, body, outlet_ids, sign?, disclose_line?, email_me? }
//                           → { letter, dropped_outlets }: an outlet that's gone,
//                           not this campaign's or doesn't take this kind is
//                           dropped, never a refusal (written offline, it lands)
//   myletter.revise         { id, body, client_id, from_version? } a new writer
//                           draft; the same text again is "Keep mine"
//   myletter.note           { id, body, client_id }
//   myletter.agree          { id, version_id } "This is my final text" → Ready
//   myletter.details        { id, title?, outlet_ids?, sign?, disclose_line?, email_me? }
//   myletter.sent           { id, outlet_id, how, client_id } — always recorded
//   myletter.published      { id, send_id, url, on?, client_id? }
//   myletter.not_published  { id, send_id, client_id? } → back to Ready
//   myletter.withdraw       { id } · myletter.delete { id } (never sent)
//
// The desk's — area Media, desk roles, and never a volunteer whatever they
// were granted: the queue holds writers' addresses and phones.
//   letter.status { id, status: new|working } · letter.assign { id, user_id }
//   letter.suggest { id, body, note? } · letter.note { id, body }
//   letter.told_sent { id, outlet_id } — "They told us they sent it": a record, nothing sent
//   letter.published · letter.not_published · letter.decline { id, note } · letter.reopen { id }
//   letter.points { text } — talking points for writers · letter.settings { wait_days } (managers)
// No desk action sets Ready, changes the writer's text or sends to an outlet.
//
// The log never holds a letter's words: events carry ids, sides, statuses
// and a sha256 of each draft — no title, body, note or sign-off.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { campaignDay } from '../../lib/gifts.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { selfPerson } from '../relationships/match.js';

const WRITERS = ['manager', 'treasurer', 'staff', 'volunteer'];
const DESK = ['manager', 'treasurer', 'staff'];
export const BODY_MAX = 20000;
export const PURGE_DAYS = 30;
export const WAIT_DAYS = 10;
const OUT = ['sent', 'published', 'withdrawn'];
const CLOSED = ['published', 'declined', 'withdrawn'];

const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
export const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
export const waitDays = (ws) => {
  const n = Number(ws?.settings?.letters?.wait_days);
  return Number.isInteger(n) && n >= 3 && n <= 60 ? n : WAIT_DAYS;
};
const deskOnly = (ctx) => { if (ctx.role === 'volunteer') throw httpError(403, 'volunteers cannot work the letters queue'); };

const text = (max) => z.string().trim().max(max).optional();
// The writer's words as they wrote them (spacing kept), never only spaces.
const body = (max) => z.string().max(max).refine((v) => v.trim().length > 0, 'is empty');
const sign = z.object({ name: text(120), city: text(80), address: text(300), phone: text(40) }).optional();
const outletIds = z.array(z.uuid()).max(3);
const web = z.string().trim().max(500).regex(/^https?:\/\/\S+$/i, 'must start with http:// or https://');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const SIGN_COLS = { name: 'sign_name', city: 'sign_city', address: 'sign_address', phone: 'sign_phone' };

// The letter row's event: no title, no sign-off.
const letterEvent = (l) => ({
  id: l.id, kind: l.kind, status: l.status, outlet_ids: parseJ(l.outlet_ids, []),
  person_id: l.person_id || null, assigned_to: l.assigned_to || null, disclose_line: Boolean(l.disclose_line),
});

const load = async (tx, ctx, id, { mine }) => {
  const l = (await tx.query(
    `select * from letters where id = $1 and workspace_id = $2 ${mine ? 'and writer_user = $3' : ''} for update`,
    mine ? [id, ctx.workspaceId, ctx.user.id] : [id, ctx.workspaceId],
  )).rows[0];
  if (!l) throw httpError(404, 'letter not found');
  return l;
};

// Wanted outlets that are live, this campaign's and take this kind, in the
// writer's order; the rest dropped, with their name when there is one.
const takes = (kind) => (kind === 'op_ed' ? '(o.oped_email is not null or o.oped_form is not null)' : '(o.letters_email is not null or o.letters_form is not null)');
export const sortOutlets = async (tx, ws, kind, ids) => {
  const want = [...new Set(ids || [])];
  if (!want.length) return { kept: [], dropped: [] };
  const rows = (await tx.query(
    `select o.id, o.name, (o.deleted_at is null and ${takes(kind)}) as ok from media_outlets o where o.workspace_id = $1 and o.id = any($2::uuid[])`,
    [ws, want],
  )).rows;
  const by = new Map(rows.map((r) => [r.id, r]));
  return {
    kept: want.filter((id) => by.get(id)?.ok),
    dropped: want.filter((id) => !by.get(id)?.ok).map((id) => (by.get(id) ? { id, name: by.get(id).name } : { id })),
  };
};

const newestDraft = async (tx, letterId) => (await tx.query(
  'select id, n, side, body from letter_versions where letter_id = $1 order by n desc limit 1', [letterId],
)).rows[0];

// A draft from either side: numbered after the last, any agreement gone (a
// new draft is new text), and Ready back to Working.
const addDraft = async (tx, ctx, l, { side, text: words, from = null, clientId = null }, emit) => {
  const last = await newestDraft(tx, l.id);
  const id = newId();
  const n = (last?.n || 0) + 1;
  await tx.query(
    `insert into letter_versions (id, workspace_id, letter_id, n, side, by_user, body, from_version, client_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, ctx.workspaceId, l.id, n, side, ctx.user?.id || null, words, from, clientId],
  );
  emit('letter_version', id, 'create', { id, letter_id: l.id, n, side, from_version: from, hash: sha(words) });
  return { id, n };
};

// Who spoke last, and when: the other side's "Reply" and "waiting" dots.
const touch = async (tx, l, side, set = {}) => {
  const cols = Object.keys(set);
  const row = (await tx.query(
    `update letters set last_side = $3, last_at = now(), updated_at = now()${cols.map((k, i) => `, ${k} = $${i + 4}`).join('')}
     where id = $1 and workspace_id = $2 returning *`,
    [l.id, l.workspace_id, side, ...cols.map((k) => set[k])],
  )).rows[0];
  return row;
};
const UNAGREE = { agreed_version: null, agreed_hash: null, agreed_at: null, agreed_campaign_share: null };

// Closed (published, declined, withdrawn): the address and phone typed for
// this letter go 30 days on (lib/jobs.js; withdraw takes them at once).
const purgeLater = async (tx, l) => {
  const at = new Date(l.closed_at);
  await enqueueJob(tx, {
    workspaceId: l.workspace_id, kind: 'letters.purge',
    runAt: new Date(at.getTime() + PURGE_DAYS * 86400000).toISOString(),
    payload: { letter_id: l.id, closed_at: at.toISOString() },
    key: `letters.purge:${l.id}:${at.getTime()}`,
  });
};

// Another paper's exclusive send still out (no answer yet, younger than the
// wait) at a different newsroom: the one this send went out while.
const sameNewsroom = (a, b) => a.id === b.id || (a.newsroom && b.newsroom && a.newsroom.trim().toLowerCase() === b.newsroom.trim().toLowerCase());
export const outAt = async (db, ctx, letterId, outlet, days) => (await db.query(
  `select s.id, s.sent_at, o.id as outlet_id, o.name, o.newsroom from letter_sends s join media_outlets o on o.id = s.outlet_id and o.workspace_id = s.workspace_id
   where s.letter_id = $1 and s.workspace_id = $2 and s.outcome is null and o.exclusive and s.sent_at > now() - make_interval(days => $3)
   order by s.sent_at desc`,
  [letterId, ctx.workspaceId, days],
)).rows.filter((s) => !sameNewsroom({ id: s.outlet_id, newsroom: s.newsroom }, outlet));

const recordSend = async (tx, ctx, l, { outletId, how, clientId = null }, emit) => {
  if (clientId) {
    const dup = (await tx.query('select * from letter_sends where workspace_id = $1 and client_id = $2', [ctx.workspaceId, clientId])).rows[0];
    if (dup) return { send: dup, duplicate: true };
  }
  if (!l.agreed_version) throw httpError(409, 'Agree the final text first');
  if (!['ready', 'sent'].includes(l.status)) throw httpError(409, 'This letter is closed');
  // A removed outlet is taken: the email has gone already.
  const o = (await tx.query('select id, newsroom from media_outlets where id = $1 and workspace_id = $2', [outletId, ctx.workspaceId])).rows[0];
  if (!o) throw httpError(404, 'outlet not found');
  const out = (await outAt(tx, ctx, l.id, o, waitDays(ctx.workspace)))[0];
  const id = newId();
  const send = (await tx.query(
    `insert into letter_sends (id, workspace_id, letter_id, outlet_id, how, by_user, sent_at, while_out_at, client_id)
     values ($1, $2, $3, $4, $5, $6, now(), $7, $8) returning *`,
    [id, ctx.workspaceId, l.id, o.id, how, ctx.user.id, out?.id || null, clientId],
  )).rows[0];
  emit('letter_send', id, 'create', { id, letter_id: l.id, outlet_id: o.id, how, outcome: null, url: null, while_out_at: out?.id || null });
  const next = await touch(tx, l, how === 'told_desk' ? 'campaign' : 'writer', { status: 'sent', closed_at: null });
  if (l.status !== 'sent') emit('letter', l.id, 'update', letterEvent(next));
  return { send };
};

// A send's answer: published (with its public link) closes the letter;
// not published sends it back to Ready, its agreed text still standing.
const answer = async (tx, ctx, l, { sendId, outcome, url = null, on = null }, side, emit) => {
  const s = (await tx.query('select * from letter_sends where id = $1 and letter_id = $2 and workspace_id = $3 for update', [sendId, l.id, ctx.workspaceId])).rows[0];
  if (!s) throw httpError(404, 'send not found');
  if (s.outcome === outcome && (outcome !== 'published' || s.url === url)) return { duplicate: true, send: s };
  if (['withdrawn', 'declined'].includes(l.status)) throw httpError(409, 'This letter is closed');
  const publishedOn = outcome === 'published' ? (on || campaignDay(new Date(), ctx.workspace?.settings?.tz || DEFAULT_TZ)) : null;
  const send = (await tx.query(
    `update letter_sends set outcome = $2, url = $3, published_on = $4, outcome_by = $5, outcome_at = now() where id = $1 returning *`,
    [s.id, outcome, url, publishedOn, ctx.user.id],
  )).rows[0];
  emit('letter_send', s.id, 'update', { id: s.id, letter_id: l.id, outlet_id: s.outlet_id, how: s.how, outcome, url, while_out_at: s.while_out_at });
  let status = l.status;
  if (outcome === 'published') status = 'published';
  else if (l.status === 'sent' || l.status === 'published') {
    // Back to Ready unless another send is still waiting for an answer.
    const open = (await tx.query('select 1 from letter_sends where letter_id = $1 and outcome is null limit 1', [l.id])).rows[0];
    status = open ? 'sent' : 'ready';
  }
  const next = await touch(tx, l, side, {
    status, closed_at: status === 'published' ? (l.closed_at || new Date().toISOString()) : null,
  });
  if (status !== l.status) emit('letter', l.id, 'update', letterEvent(next));
  if (status === 'published' && l.status !== 'published') await purgeLater(tx, next);
  return { send };
};

const signSet = (s) => Object.fromEntries(Object.entries(s || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [SIGN_COLS[k], v || null]));

export const actions = {
  // ── The writer's own ──
  'myletter.submit': {
    roles: WRITERS,
    input: z.object({
      client_id: z.uuid(),
      kind: z.enum(['letter', 'op_ed']),
      title: text(200),
      body: body(BODY_MAX),
      outlet_ids: outletIds.default([]),
      sign,
      disclose_line: z.boolean().optional(),
      email_me: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const dup = (await tx.query('select * from letters where workspace_id = $1 and client_id = $2', [ws, input.client_id])).rows[0];
      if (dup) {
        // Someone else's key is not a way into their letter.
        if (dup.writer_user !== ctx.user.id) throw httpError(409, 'That letter was already sent from another sign-in');
        return { letter: { id: dup.id, status: dup.status }, dropped_outlets: [], duplicate: true };
      }
      const me = await selfPerson(tx, ctx, emit, { create: true });
      const { kept, dropped } = await sortOutlets(tx, ws, input.kind, input.outlet_ids);
      const id = newId();
      const s = signSet(input.sign);
      const l = (await tx.query(
        `insert into letters (id, workspace_id, kind, writer_user, person_id, title, outlet_ids, sign_name, sign_city, sign_address, sign_phone,
           disclose_line, email_me, last_side, last_at, client_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'writer', now(), $14) returning *`,
        [id, ws, input.kind, ctx.user.id, me?.id || null, input.title || null, JSON.stringify(kept),
          s.sign_name ?? null, s.sign_city ?? null, s.sign_address ?? null, s.sign_phone ?? null,
          input.disclose_line ?? false, input.email_me ?? true, input.client_id],
      )).rows[0];
      emit('letter', id, 'create', letterEvent(l));
      await addDraft(tx, ctx, l, { side: 'writer', text: input.body }, emit);
      return { letter: { id, status: l.status }, dropped_outlets: dropped };
    },
  },

  'myletter.revise': {
    roles: WRITERS,
    input: z.object({ id: z.uuid(), body: body(BODY_MAX), client_id: z.uuid(), from_version: z.uuid().optional() }),
    handler: async (tx, ctx, input, emit) => {
      const l = await load(tx, ctx, input.id, { mine: true });
      const dup = (await tx.query('select id, n from letter_versions where workspace_id = $1 and client_id = $2', [ctx.workspaceId, input.client_id])).rows[0];
      if (dup) return { version: dup, duplicate: true };
      if (OUT.includes(l.status)) throw httpError(409, 'It’s already out');
      if (l.status === 'declined') throw httpError(409, 'The campaign declined this one');
      if (input.from_version) {
        const from = (await tx.query('select side from letter_versions where id = $1 and letter_id = $2', [input.from_version, l.id])).rows[0];
        if (from?.side !== 'campaign') throw httpError(400, 'from_version: not a suggestion on this letter');
      }
      const version = await addDraft(tx, ctx, l, { side: 'writer', text: input.body, from: input.from_version || null, clientId: input.client_id }, emit);
      const next = await touch(tx, l, 'writer', { ...UNAGREE, status: l.status === 'ready' ? 'working' : l.status });
      if (next.status !== l.status) emit('letter', l.id, 'update', letterEvent(next));
      return { version };
    },
  },

  'myletter.note': {
    roles: WRITERS,
    input: z.object({ id: z.uuid(), body: z.string().trim().min(1).max(2000), client_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const l = await load(tx, ctx, input.id, { mine: true });
      const dup = (await tx.query('select id from letter_notes where workspace_id = $1 and client_id = $2', [ctx.workspaceId, input.client_id])).rows[0];
      if (dup) return { note: dup, duplicate: true };
      const id = newId();
      await tx.query(
        `insert into letter_notes (id, workspace_id, letter_id, side, by_user, body, client_id) values ($1, $2, $3, 'writer', $4, $5, $6)`,
        [id, ctx.workspaceId, l.id, ctx.user.id, input.body, input.client_id],
      );
      emit('letter_note', id, 'create', { id, letter_id: l.id, side: 'writer' });
      await touch(tx, l, 'writer');
      return { note: { id } };
    },
  },

  // Ready is the writer's word alone, on the text the server has now: their
  // newest draft, newer than any suggestion.
  'myletter.agree': {
    roles: WRITERS,
    input: z.object({ id: z.uuid(), version_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const l = await load(tx, ctx, input.id, { mine: true });
      if (OUT.includes(l.status)) throw httpError(409, 'It’s already out');
      if (l.status === 'declined') throw httpError(409, 'The campaign declined this one');
      const last = await newestDraft(tx, l.id);
      if (!last || last.id !== input.version_id || last.side !== 'writer') throw httpError(409, 'There’s a newer draft — have a look');
      const hash = sha(last.body);
      // agreed_campaign_share: how much of it is the campaign's words — set
      // by shared/letters.js campaignShare (LTE stage 2).
      const next = await touch(tx, l, 'writer', { agreed_version: last.id, agreed_hash: hash, agreed_at: new Date().toISOString(), status: 'ready' });
      emit('letter_agreement', l.id, 'create', { letter_id: l.id, version_id: last.id, hash });
      if (l.status !== 'ready') emit('letter', l.id, 'update', letterEvent(next));
      return { letter: { id: l.id, status: 'ready', agreed_version: last.id, agreed_hash: hash } };
    },
  },

  // Where it goes and how it's signed — not its text, so an agreement stands.
  'myletter.details': {
    roles: WRITERS,
    input: z.object({
      id: z.uuid(), title: text(200), outlet_ids: outletIds.optional(), sign,
      disclose_line: z.boolean().optional(), email_me: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const l = await load(tx, ctx, input.id, { mine: true });
      if (OUT.includes(l.status)) throw httpError(409, 'It’s already out');
      const set = { ...signSet(input.sign) };
      let dropped = [];
      if (input.title !== undefined) set.title = input.title || null;
      if (input.outlet_ids) {
        const sorted = await sortOutlets(tx, ctx.workspaceId, l.kind, input.outlet_ids);
        set.outlet_ids = JSON.stringify(sorted.kept);
        dropped = sorted.dropped;
      }
      if (input.disclose_line !== undefined) set.disclose_line = input.disclose_line;
      if (input.email_me !== undefined) set.email_me = input.email_me;
      const cols = Object.keys(set);
      if (!cols.length) return { letter: { id: l.id }, dropped_outlets: [] };
      const next = (await tx.query(
        `update letters set ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() where id = $1 and workspace_id = $2 returning *`,
        [l.id, ctx.workspaceId, ...cols.map((k) => set[k])],
      )).rows[0];
      // Which fields changed, never what they say.
      emit('letter', l.id, 'update', { ...letterEvent(next), changed: cols });
      return { letter: { id: l.id }, dropped_outlets: dropped };
    },
  },

  'myletter.sent': {
    roles: WRITERS,
    input: z.object({ id: z.uuid(), outlet_id: z.uuid(), how: z.enum(['email', 'form']), client_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const l = await load(tx, ctx, input.id, { mine: true });
      return recordSend(tx, ctx, l, { outletId: input.outlet_id, how: input.how, clientId: input.client_id }, emit);
    },
  },

  'myletter.published': {
    roles: WRITERS,
    input: z.object({ id: z.uuid(), send_id: z.uuid(), url: web, on: day, client_id: z.uuid().optional() }),
    handler: async (tx, ctx, input, emit) => answer(tx, ctx, await load(tx, ctx, input.id, { mine: true }),
      { sendId: input.send_id, outcome: 'published', url: input.url, on: input.on }, 'writer', emit),
  },

  'myletter.not_published': {
    roles: WRITERS,
    input: z.object({ id: z.uuid(), send_id: z.uuid(), client_id: z.uuid().optional() }),
    handler: async (tx, ctx, input, emit) => answer(tx, ctx, await load(tx, ctx, input.id, { mine: true }),
      { sendId: input.send_id, outcome: 'not_published' }, 'writer', emit),
  },

  'myletter.withdraw': {
    roles: WRITERS,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const l = await load(tx, ctx, input.id, { mine: true });
      if (l.status === 'withdrawn') return { letter: { id: l.id, status: l.status } };
      if (l.status === 'published') throw httpError(409, 'It’s been published');
      const next = await touch(tx, l, 'writer', {
        status: 'withdrawn', closed_at: new Date().toISOString(), sign_address: null, sign_phone: null,
      });
      emit('letter', l.id, 'update', letterEvent(next));
      return { letter: { id: l.id, status: 'withdrawn' } };
    },
  },

  'myletter.delete': {
    roles: WRITERS,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const l = await load(tx, ctx, input.id, { mine: true });
      if ((await tx.query('select 1 from letter_sends where letter_id = $1 limit 1', [l.id])).rows[0]) {
        throw httpError(409, 'It’s been sent — withdraw it instead');
      }
      await tx.query('delete from letters where id = $1 and workspace_id = $2', [l.id, ctx.workspaceId]);
      emit('letter', l.id, 'void', { id: l.id });
      return { deleted: l.id };
    },
  },

  // ── The desk's ──
  'letter.status': {
    roles: DESK,
    input: z.object({ id: z.uuid(), status: z.enum(['new', 'working']) }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await load(tx, ctx, input.id, { mine: false });
      if (!['new', 'working'].includes(l.status)) throw httpError(409, 'Only a new letter or one being worked on');
      if (l.status === input.status) return { letter: { id: l.id, status: l.status } };
      const next = (await tx.query('update letters set status = $3, updated_at = now() where id = $1 and workspace_id = $2 returning *', [l.id, ctx.workspaceId, input.status])).rows[0];
      emit('letter', l.id, 'update', letterEvent(next));
      return { letter: { id: l.id, status: next.status } };
    },
  },

  'letter.assign': {
    roles: DESK,
    input: z.object({ id: z.uuid(), user_id: z.uuid().nullable() }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await load(tx, ctx, input.id, { mine: false });
      if (input.user_id && !(await tx.query(
        `select 1 from memberships where workspace_id = $1 and user_id = $2 and role = any($3::text[])`, [ctx.workspaceId, input.user_id, DESK],
      )).rows[0]) throw httpError(400, 'user_id: not on the campaign’s staff');
      const next = (await tx.query('update letters set assigned_to = $3, updated_at = now() where id = $1 and workspace_id = $2 returning *', [l.id, ctx.workspaceId, input.user_id])).rows[0];
      emit('letter', l.id, 'update', letterEvent(next));
      return { letter: { id: l.id, assigned_to: next.assigned_to } };
    },
  },

  // A suggestion: the campaign's draft beside the writer's, never over it.
  'letter.suggest': {
    roles: DESK,
    input: z.object({ id: z.uuid(), body: body(BODY_MAX), note: z.string().trim().max(2000).optional() }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await load(tx, ctx, input.id, { mine: false });
      if (OUT.includes(l.status)) throw httpError(409, 'It’s already out');
      if (l.status === 'declined') throw httpError(409, 'Take it back first');
      const version = await addDraft(tx, ctx, l, { side: 'campaign', text: input.body }, emit);
      if (input.note) {
        const nid = newId();
        await tx.query(
          `insert into letter_notes (id, workspace_id, letter_id, side, by_user, body) values ($1, $2, $3, 'campaign', $4, $5)`,
          [nid, ctx.workspaceId, l.id, ctx.user.id, input.note],
        );
        emit('letter_note', nid, 'create', { id: nid, letter_id: l.id, side: 'campaign' });
      }
      const next = await touch(tx, l, 'campaign', { ...UNAGREE, status: 'working', desk_seen_at: new Date().toISOString() });
      if (l.status !== 'working') emit('letter', l.id, 'update', letterEvent(next));
      return { version, letter: { id: l.id, status: 'working' } };
    },
  },

  'letter.note': {
    roles: DESK,
    input: z.object({ id: z.uuid(), body: z.string().trim().min(1).max(2000) }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await load(tx, ctx, input.id, { mine: false });
      const id = newId();
      await tx.query(
        `insert into letter_notes (id, workspace_id, letter_id, side, by_user, body) values ($1, $2, $3, 'campaign', $4, $5)`,
        [id, ctx.workspaceId, l.id, ctx.user.id, input.body],
      );
      emit('letter_note', id, 'create', { id, letter_id: l.id, side: 'campaign' });
      const next = await touch(tx, l, 'campaign', { status: l.status === 'new' ? 'working' : l.status, desk_seen_at: new Date().toISOString() });
      if (next.status !== l.status) emit('letter', l.id, 'update', letterEvent(next));
      return { note: { id } };
    },
  },

  'letter.told_sent': {
    roles: DESK,
    input: z.object({ id: z.uuid(), outlet_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await load(tx, ctx, input.id, { mine: false });
      return recordSend(tx, ctx, l, { outletId: input.outlet_id, how: 'told_desk' }, emit);
    },
  },

  'letter.published': {
    roles: DESK,
    input: z.object({ id: z.uuid(), send_id: z.uuid(), url: web, on: day }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      return answer(tx, ctx, await load(tx, ctx, input.id, { mine: false }),
        { sendId: input.send_id, outcome: 'published', url: input.url, on: input.on }, 'campaign', emit);
    },
  },

  'letter.not_published': {
    roles: DESK,
    input: z.object({ id: z.uuid(), send_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      return answer(tx, ctx, await load(tx, ctx, input.id, { mine: false }), { sendId: input.send_id, outcome: 'not_published' }, 'campaign', emit);
    },
  },

  // Declined is the campaign's word alone: it won't help with this one.
  'letter.decline': {
    roles: DESK,
    input: z.object({ id: z.uuid(), note: z.string().trim().min(1).max(500) }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await load(tx, ctx, input.id, { mine: false });
      if (!['new', 'working', 'ready'].includes(l.status)) throw httpError(409, l.status === 'declined' ? 'Already declined' : 'It’s already out');
      const next = await touch(tx, l, 'campaign', {
        status: 'declined', declined_note: input.note, closed_at: new Date().toISOString(), desk_seen_at: new Date().toISOString(),
      });
      emit('letter', l.id, 'update', letterEvent(next));
      await purgeLater(tx, next);
      return { letter: { id: l.id, status: 'declined' } };
    },
  },

  'letter.reopen': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await load(tx, ctx, input.id, { mine: false });
      if (l.status !== 'declined') throw httpError(409, 'Only a declined letter');
      const next = await touch(tx, l, 'campaign', { status: 'working', declined_note: null, closed_at: null });
      emit('letter', l.id, 'update', letterEvent(next));
      return { letter: { id: l.id, status: 'working' } };
    },
  },

  // Talking points for writers — facts and links, never a letter to copy.
  'letter.points': {
    roles: DESK,
    input: z.object({ text: z.string().trim().max(1000) }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      return saveSettings(tx, ctx, { points: input.text || null }, emit);
    },
  },

  'letter.settings': {
    roles: ['manager'],
    input: z.object({ wait_days: z.number().int().min(3).max(60).optional() }),
    handler: async (tx, ctx, input, emit) => saveSettings(tx, ctx, input, emit),
  },
};

const saveSettings = async (tx, ctx, patch, emit) => {
  const ws = ctx.workspaceId;
  const settings = parseJ((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0].settings, {});
  const letters = { ...(settings.letters || {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) letters[k] = v;
  await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...settings, letters })]);
  // The points are the campaign's own words (public, like a release): on the log.
  emit('workspace', ws, 'update', { letters });
  return { letters };
};
