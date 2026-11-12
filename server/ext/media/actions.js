// Media actions (area Media, lib/perms.js).
//
// Contacts — the desk's only (a volunteer granted Media sends releases but
// never adds or edits who is on file):
//   media.contact.add    { name, kind, email?, phone?, outlet?, beat?, socials?, note? }
//                        → { person_id, existing? }: a live person with that
//                        email is used (the tag added, empty fields filled);
//                        else a new person (person.create). Someone who left
//                        by a release's link is refused.
//   media.contact.save   { person_id, kind?, outlet?, beat?, note? } ("" clears)
//   media.contact.remove { person_id } — both tags off, the row kept
//
// Releases, for anyone holding Media — the blast.* actions under the Media
// area's own names, so someone with Media but not Outreach can work:
//   media.send     blast.send's press release, To: media, influencers or both
//   media.test     blast.test, kind press
//   media.attach · media.unattach · media.picture   blast.attach · blast.unattach · blast.picture
//   media.resend   blast.resend, for a press release only
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { SOCIAL_PLATFORMS } from '@starbase/shared/canvass';
import { parseSocial, platformWord } from '@starbase/shared/socials';
import { actions as FILES, ATTACH_COUNT } from '../abtests/attach.js';
import { abInput } from '../abtests/send.js';
import { DESK_ROLES, KINDS, isDesk, kindOf, offMedia, onMediaTags } from './rules.js';
import { takeOff } from './leave.js';

// actions/field.js and actions/index.js load before any request reaches
// here; read at call time (a feature module never imports them at load).
const field = async () => (await import('../../actions/field.js')).FIELD_ACTIONS;
const core = async () => (await import('../../actions/index.js')).ACTIONS;

const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const text = (max) => z.string().trim().max(max).optional();
// "" clears a field; absent keeps it.
const blankNull = (v) => (v === undefined ? undefined : v || null);
// Handles typed when adding, read as a person's page reads them (shared/
// socials.js): one the parser refuses is refused in its words.
const cleanSocials = (socials) => {
  const out = {};
  for (const [k, v] of Object.entries(socials || {})) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const r = parseSocial(v, k);
    if (r.error) throw Object.assign(httpError(400, `${platformWord(k)}: ${r.error}`), { field: 'socials' });
    out[r.platform] = r.handle;
  }
  return out;
};
const deskOnly = (ctx) => { if (!isDesk(ctx)) throw httpError(403, 'only the desk adds or changes media contacts'); };

const personOf = async (tx, ws, id) => (await tx.query(
  'select id, name, email, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws],
)).rows[0];
const rowOf = async (tx, ws, personId) => (await tx.query(
  'select * from media_contacts where workspace_id = $1 and person_id = $2', [ws, personId],
)).rows[0];
const setTags = async (tx, ws, p, tags, emit) => {
  await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, ws, JSON.stringify(tags)]);
  emit('person', p.id, 'update', { tags, source: 'media' });
};
const leftByLink = (tx, ctx, row) => {
  const tz = ctx.workspace?.settings?.tz || 'America/Vancouver';
  const on = new Date(row.left_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
  return httpError(409, `They asked to stop getting releases on ${on}`);
};
// The row's fields from an input: only those sent ("" → null).
const fieldsOf = (input) => Object.fromEntries(['outlet', 'beat', 'note'].filter((k) => input[k] !== undefined).map((k) => [k, blankNull(input[k])]));

const releaseInput = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(50000),
  ab: abInput.nullish(),
  attachment_ids: z.array(z.uuid()).max(ATTACH_COUNT).optional(),
  sender_id: z.uuid().nullish(),
  to: z.object({ kinds: z.array(z.enum(KINDS)).min(1).max(2) }).optional(),
});

export const actions = {
  'media.contact.add': {
    roles: DESK_ROLES,
    input: z.object({
      name: z.string().trim().min(1).max(300),
      kind: z.enum(KINDS).default('media'),
      email: z.string().trim().toLowerCase().pipe(z.email().max(320)).nullish().or(z.literal('')),
      phone: z.string().max(40).nullish(),
      outlet: text(160), beat: text(160), note: text(500),
      socials: z.partialRecord(z.enum(SOCIAL_PLATFORMS), z.string().max(300)).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const ws = ctx.workspaceId;
      const email = input.email || null;
      const socials = cleanSocials(input.socials);
      let p = email ? (await tx.query(
        `select id, name, email, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null
         order by created_at, id limit 1`, [ws, email],
      )).rows[0] : null;
      const existing = !!p;
      if (p) {
        const row = await rowOf(tx, ws, p.id);
        if (row?.left_how === 'link') throw leftByLink(tx, ctx, row);
        const tags = parseJ(p.tags, []);
        if (!onMediaTags(tags, [input.kind])) await setTags(tx, ws, p, [...tags, input.kind], emit);
      } else {
        const made = await (await core())['person.create'].handler(tx, ctx, {
          kind: 'person', name: input.name, email, phone: input.phone || null, tags: [input.kind], socials,
        }, emit);
        p = { id: made.person.id };
      }
      // Outlet, beat and note: filled where empty, never written over.
      await tx.query(
        `insert into media_contacts (workspace_id, person_id, outlet, beat, note) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, person_id) do update set
           outlet = coalesce(media_contacts.outlet, excluded.outlet), beat = coalesce(media_contacts.beat, excluded.beat),
           note = coalesce(media_contacts.note, excluded.note), left_at = null, left_how = null, updated_at = now()`,
        [ws, p.id, input.outlet || null, input.beat || null, input.note || null],
      );
      emit('media_contact', p.id, existing ? 'update' : 'create', { kind: input.kind, outlet: input.outlet || null, beat: input.beat || null, ...(existing ? { existing } : {}) });
      return { person_id: p.id, ...(existing ? { existing: true } : {}) };
    },
  },

  'media.contact.save': {
    roles: DESK_ROLES,
    input: z.object({ person_id: z.uuid(), kind: z.enum(KINDS).optional(), outlet: text(160), beat: text(160), note: text(500) }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const ws = ctx.workspaceId;
      const p = await personOf(tx, ws, input.person_id);
      const tags = parseJ(p?.tags, []);
      if (!p || !onMediaTags(tags)) throw httpError(404, 'not on the media list');
      if (input.kind && kindOf(tags) !== input.kind) await setTags(tx, ws, p, [...offMedia(tags), input.kind], emit);
      const f = fieldsOf(input);
      await tx.query(
        `insert into media_contacts (workspace_id, person_id, outlet, beat, note) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, person_id) do update set
           outlet = case when $6 then excluded.outlet else media_contacts.outlet end,
           beat = case when $7 then excluded.beat else media_contacts.beat end,
           note = case when $8 then excluded.note else media_contacts.note end, updated_at = now()`,
        [ws, p.id, f.outlet ?? null, f.beat ?? null, f.note ?? null, 'outlet' in f, 'beat' in f, 'note' in f],
      );
      emit('media_contact', p.id, 'update', { ...(input.kind ? { kind: input.kind } : {}), ...f });
      return { person_id: p.id };
    },
  },

  'media.contact.remove': {
    roles: DESK_ROLES,
    input: z.object({ person_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const p = await personOf(tx, ctx.workspaceId, input.person_id);
      if (!p || !onMediaTags(parseJ(p.tags, []))) throw httpError(404, 'not on the media list');
      await takeOff(tx, ctx.workspaceId, p, 'desk', emit, 'media');
      return { person_id: p.id };
    },
  },

  'media.send': {
    roles: DESK_ROLES,
    input: releaseInput,
    handler: async (tx, ctx, { to, ...input }, emit) => (await field())['blast.send'].handler(tx, ctx, {
      ...input, kind: 'press', audience: { media: to?.kinds || ['media'] },
    }, emit),
    after: async (db, ctx, result) => (await field())['blast.send'].after(db, ctx, result),
  },

  'media.test': {
    roles: DESK_ROLES,
    input: releaseInput.pick({ subject: true, body: true, attachment_ids: true, sender_id: true }),
    handler: async (tx, ctx, input, emit) => (await field())['blast.test'].handler(tx, ctx, { ...input, kind: 'press' }, emit),
    after: async (db, ctx, result) => (await field())['blast.test'].after(db, ctx, result),
  },

  'media.resend': {
    roles: DESK_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const b = (await tx.query('select kind from blasts where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId])).rows[0];
      if (b?.kind !== 'press') throw httpError(404, 'release not found');
      return (await field())['blast.resend'].handler(tx, ctx, input, emit);
    },
    after: async (db, ctx, result) => (await field())['blast.resend'].after(db, ctx, result),
  },

  'media.attach': { ...FILES['blast.attach'], roles: DESK_ROLES },
  'media.picture': { ...FILES['blast.picture'], roles: DESK_ROLES },
  // Taking back a file not yet sent (the compose's ×), as blast.unattach.
  'media.unattach': { ...FILES['blast.unattach'], roles: DESK_ROLES },
};

