// Share kits: the campaign writes a post once (a few words, a picture, a page
// of its website); everyone signed in shares it with their own tracked link,
// /r/<their code>?k=<kit code> (ext/site/public.js), and the desk sees the
// sign-ups each post and each sharer brought in (share-api.js).
//
//   share.kit.save  { id?, title, body, path, media_id?, authorized? }
//       Outreach (manager, staff, treasurer; a grant lets anyone else).
//       path: a page of the main website ("/", "/act/<slug>", "/<slug>").
//       body plus, when authorized, the authorization line ≤ 500.
//   share.kit.open  { id, open }   stop or restart; a stopped kit's links
//       keep working, it only leaves the Share screen
//   share.picture   a picture for a kit (the site.picture shape, into media)
//   share.me        {} → { code }: the signed-in person's own link code, for
//       every role and no area, so someone denied Outreach still has a link
import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { readUpload } from '../abtests/media.js';
import { selfPerson } from '../relationships/match.js';
import { refCodeFor } from '../site/people.js';

const DESK = ['manager', 'staff', 'treasurer'];
const ALL = ['manager', 'staff', 'treasurer', 'volunteer'];
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const KIT_CODE_RE = /^[a-z0-9]{6}$/;
export const BODY_MAX = 500;
export const TITLE_MAX = 80;
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

// SW's authorizedBy(org) once it has shipped (shared/site/wording.js);
// until then the line typed under Website → Settings.
let wording = null;
try { wording = await import('@starbase/shared/site/wording'); } catch { /* not there yet */ }
export const authLineOf = (org = {}) => {
  if (typeof wording?.authorizedBy === 'function') {
    const s = String(wording.authorizedBy(org) || '').trim();
    if (s) return s;
  }
  return String(org?.authorizationLine || '').trim();
};
export const authLine = async (q, ws) => {
  const r = (await q.query('select org from site_settings where workspace_id = $1', [ws])).rows[0];
  return r ? authLineOf(parseJ(r.org, {})) : '';
};
// The words people post: the kit's, then the line when it carries one.
export const kitText = (kit, line) => (kit.authorized && line ? `${kit.body}\n${line}` : kit.body);

// A page of the campaign's own website, never somewhere else.
export const goodPath = (p) => typeof p === 'string' && p.length <= 300 && p.startsWith('/') && !p.startsWith('//')
  // eslint-disable-next-line no-control-regex
  && !/[\u0000-\u001f\u007f\\\s]/.test(p) && !/^\/*[a-z][a-z0-9+.-]*:/i.test(p.slice(1));
const pageOf = (path) => path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';

// The page a kit opens, and whether it is on the website now: "/" always
// (Home); /act/<slug> an open petition or pledge; any other /<slug> a
// published page. → { live, title }
export const kitPage = async (q, ws, path) => {
  const p = pageOf(path);
  if (p === '/') return { live: true, title: 'Home' };
  const slug = (re) => { const m = p.match(re); try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; } };
  const act = slug(/^\/act\/([^/]+)$/);
  if (act) {
    const r = (await q.query(
      'select title, status, deleted_at from site_campaigns where workspace_id = $1 and slug = $2 order by deleted_at nulls first limit 1',
      [ws, act],
    )).rows[0];
    return { live: Boolean(r && !r.deleted_at && r.status === 'open'), title: r?.title || p };
  }
  const page = slug(/^\/([^/]+)$/);
  if (!page) return { live: false, title: p };
  const r = (await q.query(
    `select coalesce(nullif(published->>'title', ''), title) as title, status, deleted_at from site_pages
      where workspace_id = $1 and slug = $2 order by deleted_at nulls first limit 1`,
    [ws, page],
  )).rows[0];
  return { live: Boolean(r && !r.deleted_at && r.status === 'published'), title: r?.title || p };
};
export const kitPageLive = async (q, ws, path) => (await kitPage(q, ws, path)).live;

const freshKitCode = async (tx, ws) => {
  for (let i = 0; i < 8; i += 1) {
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (!(await tx.query('select 1 from share_kits where workspace_id = $1 and code = $2', [ws, code])).rows[0]) return code;
  }
  throw new Error('no free kit code');
};

// "kit-<code>" → the kit's title (deleted or not), else null. SW's
// "Where they came from" lists show "Share: <title>" through it.
export const kitTitleOf = async (q, ws, source) => {
  const m = String(source || '').match(/^kit-([a-z0-9]{6})$/);
  if (!m) return null;
  return (await q.query('select title from share_kits where workspace_id = $1 and code = $2', [ws, m[1]])).rows[0]?.title ?? null;
};

export const kitOut = (k) => ({
  id: k.id, code: k.code, title: k.title, body: k.body, path: k.path,
  media_id: k.media_id ?? null, picture_url: k.media_id ? `/media/${k.media_id}` : null,
  authorized: k.authorized, open: k.open, created_at: k.created_at, updated_at: k.updated_at,
});

export const shareActions = {
  'share.kit.save': {
    roles: DESK,
    input: z.object({
      id: z.uuid().optional(),
      title: z.string().trim().min(1, 'Give it a name').max(TITLE_MAX),
      body: z.string().trim().min(1, 'Write the words to share').max(BODY_MAX),
      path: z.string().trim().max(300),
      media_id: z.uuid().nullable().optional(),
      authorized: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      if (!goodPath(input.path)) throw Object.assign(httpError(400, 'Pick a page of your website'), { field: 'path' });
      const authorized = input.authorized ?? true;
      if (kitText({ body: input.body, authorized }, await authLine(tx, ws)).length > BODY_MAX) {
        throw Object.assign(httpError(400, 'Too long with the Authorized by line — shorten the words'), { field: 'body' });
      }
      if (input.media_id && !(await tx.query('select 1 from media where id = $1 and workspace_id = $2', [input.media_id, ws])).rows[0]) {
        throw Object.assign(httpError(400, 'That picture is gone — upload it again'), { field: 'media_id' });
      }
      const fields = { title: input.title, body: input.body, path: input.path, media_id: input.media_id ?? null, authorized };
      if (input.id) {
        const row = (await tx.query(
          `update share_kits set title = $3, body = $4, path = $5, media_id = $6, authorized = $7, updated_at = now()
            where id = $1 and workspace_id = $2 and deleted_at is null returning *`,
          [input.id, ws, fields.title, fields.body, fields.path, fields.media_id, fields.authorized],
        )).rows[0];
        if (!row) throw httpError(404, 'That post is gone — reload the list');
        emit('share_kit', row.id, 'update', fields);
        return { kit: kitOut(row) };
      }
      const id = newId();
      const code = await freshKitCode(tx, ws);
      const row = (await tx.query(
        `insert into share_kits (id, workspace_id, code, title, body, path, media_id, authorized, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [id, ws, code, fields.title, fields.body, fields.path, fields.media_id, fields.authorized, ctx.user?.id || null],
      )).rows[0];
      emit('share_kit', id, 'create', { code, ...fields });
      return { kit: kitOut(row) };
    },
  },

  'share.kit.open': {
    roles: DESK,
    input: z.object({ id: z.uuid(), open: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      const row = (await tx.query(
        'update share_kits set open = $3, updated_at = now() where id = $1 and workspace_id = $2 and deleted_at is null returning *',
        [input.id, ctx.workspaceId, input.open],
      )).rows[0];
      if (!row) throw httpError(404, 'That post is gone — reload the list');
      emit('share_kit', row.id, 'update', { open: input.open });
      return { kit: kitOut(row) };
    },
  },

  'share.picture': {
    roles: DESK,
    input: z.object({
      data: z.string().min(1).max(3_000_000),
      name: z.string().trim().max(200).optional(),
      width: z.number().int().min(1).max(20_000).optional(),
      height: z.number().int().min(1).max(20_000).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const up = readUpload(input.data);
      if (up.error) throw httpError(400, up.error);
      const id = newId();
      await tx.query(
        `insert into media (id, workspace_id, content_type, bytes, width, height, name, data, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.workspaceId, up.type, up.buf.length, input.width ?? null, input.height ?? null, input.name || null, up.buf, ctx.user?.id || null],
      );
      const media = { id, content_type: up.type, bytes: up.buf.length, width: input.width ?? null, height: input.height ?? null, name: input.name || null };
      emit('media', id, 'create', { ...media, for: 'share' });
      return { media: { ...media, url: `/media/${id}` } };
    },
  },

  // Their own link: the supporter record of their login email (made the
  // first time), and its referral code (made the first time).
  'share.me': {
    roles: ALL,
    input: z.object({}).passthrough(),
    handler: async (tx, ctx, input, emit) => {
      const me = await selfPerson(tx, ctx, emit, { create: true });
      if (!me) throw httpError(400, 'Your sign-in has no email — ask a manager');
      return { code: await refCodeFor(tx, ctx.workspaceId, me.id, emit) };
    },
  },
};
