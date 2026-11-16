// Templates: save (new, or over one with the version the screen loaded),
// copy (a ready-made one or the campaign's own), remove and restore (Undo),
// and a manager's hide/show of a ready-made one. Each is on the event log as
// email_template { name, use, subject } — never the body, as sends do.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { timeZone } from '../../lib/org.js';
import { toCodes } from '@starbase/shared/email/words';
import { STARTER_KEYS, starterOf } from '@starbase/shared/email/starters';
import { DESK, GONE, USES, holds, refusal } from './rules.js';

export const MAX_TEMPLATES = 200;
const NAME_MAX = 80;
const BODY_MAX = 50000;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };

const need = (ctx, use) => { if (!holds(ctx, use)) throw httpError(403, refusal(use)); };
const rowOf = async (tx, ctx, id) => (await tx.query(
  'select * from email_templates where id = $1 and workspace_id = $2', [id, ctx.workspaceId],
)).rows[0] || null;
// A live template of this campaign, checked against the area of its stored
// use (never the one asked for). use: the one a save asked for — a
// template's use never changes.
const liveOf = async (tx, ctx, id, { use = null } = {}) => {
  const row = await rowOf(tx, ctx, id);
  if (!row || row.deleted_at) throw httpError(404, GONE);
  if (use && use !== row.use) throw httpError(400, 'A template can’t move between Email and Media — make a new one');
  need(ctx, row.use);
  return row;
};
const cleanName = (name) => {
  const n = String(name ?? '').trim();
  if (/[\r\n]/.test(n)) throw httpError(400, 'A template’s name is one line');
  if (!n) throw httpError(400, 'Give the template a name');
  if (n.length > NAME_MAX) throw httpError(400, `A template’s name is ${NAME_MAX} characters at most`);
  return n;
};
const nameTaken = async (tx, ctx, use, name, notId = null) => (await tx.query(
  `select 1 from email_templates where workspace_id = $1 and use = $2 and lower(name) = lower($3)
     and deleted_at is null and ($4::uuid is null or id <> $4::uuid) limit 1`,
  [ctx.workspaceId, use, name, notId],
)).rows.length > 0;
const roomFor = async (tx, ctx, use) => {
  const n = Number((await tx.query(
    'select count(*)::int as n from email_templates where workspace_id = $1 and use = $2 and deleted_at is null', [ctx.workspaceId, use],
  )).rows[0].n);
  if (n >= MAX_TEMPLATES) throw httpError(409, `${MAX_TEMPLATES} templates is the most — remove one first`);
};
const answer = (r) => ({ id: r.id, name: r.name, use: r.use, subject: r.subject, body: r.body, version: Number(r.version), updated_at: r.updated_at });
const logged = (r) => ({ name: r.name, use: r.use, subject: r.subject });

// "Pat changed this template at 3:12 pm", in the campaign's time zone.
const changedBy = async (tx, row) => {
  const who = row.updated_by
    ? (await tx.query('select name from users where id = $1', [row.updated_by])).rows[0]?.name || 'Someone'
    : 'Someone';
  const at = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timeZone() })
    .format(new Date(row.updated_at)).replace(/\s?AM$/, ' am').replace(/\s?PM$/, ' pm');
  return `${who} changed this template at ${at} — reload to see it`;
};

// "Monthly newsletter (copy)", then "(copy 2)"…; a copy of a copy counts on
// from the same name.
const copyName = async (tx, ctx, use, name) => {
  const base = String(name).replace(/\s\(copy(?: \d+)?\)$/, '');
  for (let i = 1; ; i += 1) {
    const tail = i === 1 ? ' (copy)' : ` (copy ${i})`;
    const next = `${base.slice(0, NAME_MAX - tail.length).trimEnd()}${tail}`;
    if (!(await nameTaken(tx, ctx, use, next))) return next;
  }
};

export const actions = {
  'template.save': {
    roles: DESK,
    input: z.object({
      id: z.uuid().optional(),
      use: z.enum(USES),
      name: z.string().max(400),
      subject: z.string().max(300).default(''),
      body: z.string().min(1).max(BODY_MAX),
      // The version the screen loaded (an update without it is refused:
      // it never overwrites blind).
      seen: z.number().int().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const name = cleanName(input.name);
      // Typed fill words ("[first name]", from an older screen) are stored as codes.
      const subject = toCodes(input.subject.replace(/\s+/g, ' ').trim());
      const body = toCodes(input.body.replace(/\r\n/g, '\n').trim());
      if (!body) throw httpError(400, 'A template needs a message');
      if (subject.length > 300 || body.length > BODY_MAX) throw httpError(400, 'That template is too long');
      if (input.id) {
        const cur = await liveOf(tx, ctx, input.id, { use: input.use });
        if (await nameTaken(tx, ctx, cur.use, name, cur.id)) throw httpError(409, `There’s already a template called “${name}”`);
        const row = input.seen === undefined ? null : (await tx.query(
          `update email_templates set name = $3, subject = $4, body = $5, updated_by = $6, updated_at = now(), version = version + 1
           where id = $1 and workspace_id = $2 and version = $7 and deleted_at is null returning *`,
          [cur.id, ctx.workspaceId, name, subject, body, ctx.user.id, input.seen],
        )).rows[0];
        if (!row) throw httpError(409, await changedBy(tx, cur));
        emit('email_template', row.id, 'update', logged(row));
        return { template: answer(row) };
      }
      need(ctx, input.use);
      if (await nameTaken(tx, ctx, input.use, name)) throw httpError(409, `There’s already a template called “${name}”`);
      await roomFor(tx, ctx, input.use);
      const row = (await tx.query(
        `insert into email_templates (id, workspace_id, use, name, subject, body, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $7) returning *`,
        [newId(), ctx.workspaceId, input.use, name, subject, body, ctx.user.id],
      )).rows[0];
      emit('email_template', row.id, 'create', logged(row));
      return { template: answer(row) };
    },
  },

  // from: 'starter:<key>' or one of the campaign's own (an id).
  'template.copy': {
    roles: DESK,
    input: z.object({ from: z.string().max(80) }),
    handler: async (tx, ctx, input, emit) => {
      let src;
      if (input.from.startsWith('starter:')) {
        src = starterOf(input.from.slice('starter:'.length));
        if (!src) throw httpError(404, GONE);
        need(ctx, src.use);
      } else {
        if (!z.uuid().safeParse(input.from).success) throw httpError(404, GONE);
        src = await liveOf(tx, ctx, input.from);
      }
      await roomFor(tx, ctx, src.use);
      const name = await copyName(tx, ctx, src.use, src.name);
      const row = (await tx.query(
        `insert into email_templates (id, workspace_id, use, name, subject, body, made_from, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning *`,
        [newId(), ctx.workspaceId, src.use, name, src.subject, src.body, input.from, ctx.user.id],
      )).rows[0];
      emit('email_template', row.id, 'create', { ...logged(row), made_from: input.from });
      return { template: answer(row) };
    },
  },

  'template.remove': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await liveOf(tx, ctx, input.id);
      await tx.query('update email_templates set deleted_at = now() where id = $1 and workspace_id = $2', [cur.id, ctx.workspaceId]);
      emit('email_template', cur.id, 'void', logged(cur));
      return { id: cur.id };
    },
  },

  'template.restore': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await rowOf(tx, ctx, input.id);
      if (!cur) throw httpError(404, GONE);
      need(ctx, cur.use);
      if (!cur.deleted_at) return { template: answer(cur) };
      if (await nameTaken(tx, ctx, cur.use, cur.name, cur.id)) {
        throw httpError(409, `There’s already a template called “${cur.name}” — rename that one first`);
      }
      await roomFor(tx, ctx, cur.use);
      const row = (await tx.query(
        `update email_templates set deleted_at = null, version = version + 1 where id = $1 and workspace_id = $2 returning *`,
        [cur.id, ctx.workspaceId],
      )).rows[0];
      emit('email_template', row.id, 'restore', logged(row));
      return { template: answer(row) };
    },
  },

  // A manager hides a ready-made template from everyone (or shows it again).
  'template.starters': {
    roles: ['manager'],
    input: z.object({ key: z.string().max(80), hidden: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      if (!STARTER_KEYS.includes(input.key)) throw httpError(400, 'There’s no ready-made template by that name');
      const ws = ctx.workspaceId;
      const settings = parseJ((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0].settings, {});
      const was = Array.isArray(settings.templates?.hidden) ? settings.templates.hidden.filter((k) => STARTER_KEYS.includes(k)) : [];
      const hidden = input.hidden ? [...new Set([...was, input.key])] : was.filter((k) => k !== input.key);
      const next = { ...settings, templates: { ...(settings.templates || {}), hidden } };
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify(next)]);
      emit('workspace', ws, 'update', { templates_hidden: hidden });
      return { hidden };
    },
  },
};
