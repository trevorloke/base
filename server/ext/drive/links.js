// A link instead of a copy, for one file too big to attach (offered only
// after *.attach.drive answered link: true): blast.link.drive (Outreach)
// and media.link.drive (Media), by their prefixes.
//
//   { file_id, anyone: false }  the file's Drive link, for the people it's
//                               shared with: nothing changes at Google,
//                               nothing is stored
//   { file_id, anyone: true }   Google opens it to anyone with the link
//                               (reader, no email); a drive_links row keeps
//                               the permission so it can be closed. Never a
//                               Sheet base.win made, a folder or a Google Sheet.
//   drive.link.close { id }     "Make private again": the person who opened
//                               it, with their own grant (nobody else's
//                               reaches that file under drive.file)
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { driveSetup } from './config.js';
import { deskOnly, gate, refused, usableGrant } from './grant.js';
import { FOLDER, SHEET, closePermission, getFile, openToAnyone } from './files.js';
import { FILE_ID } from './reads.js';
import { EVERYONE } from './attach.js';

const NOT_ANYONE = 'Google wouldn’t open this file to anyone with the link. Share it in Drive, or ask your Google admin.';
const HELD_BACK = ['paused', 'unavailable', 'client', 'reconnect'];

const link = {
  roles: EVERYONE,
  input: z.object({ file_id: z.string().trim().regex(FILE_ID), anyone: z.boolean().default(false) }),
  before: async (db, ctx, input) => {
    gate(ctx);
    const g = await usableGrant(db, ctx);
    // A Sheet base.win made: refused before Google is asked anything.
    const made = input.anyone && (await db.query('select 1 from drive_exports where workspace_id = $1 and file_id = $2 limit 1', [ctx.workspaceId, input.file_id])).rows[0];
    if (made) throw httpError(409, 'Sheets base.win made stay private — share them in Drive if you must');
    const f = await getFile(db, g, input.file_id);
    if (!f.ok) throw refused(f, { picked: true });
    const file = f.file;
    const url = file.url || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
    if (!input.anyone) return { file, url };
    if (file.mimeType === FOLDER || file.mimeType === SHEET) throw httpError(409, 'Only single files can be opened to anyone');
    const p = await openToAnyone(db, g, file.id);
    if (!p.ok) throw HELD_BACK.includes(p.trouble?.code) ? refused(p) : httpError(409, NOT_ANYONE);
    return { file, url, permissionId: p.permissionId };
  },
  handler: async (tx, ctx, input, emit, ready) => {
    deskOnly(ctx);
    const name = String(ready.file.name).slice(0, 300);
    if (input.anyone) {
      const id = newId();
      await tx.query(
        `insert into drive_links (id, workspace_id, user_id, file_id, permission_id, name, url) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.workspaceId, ctx.user.id, ready.file.id, ready.permissionId, name, ready.url],
      );
      emit('drive_link', id, 'create', { name, anyone: true });
    }
    return { name, url: ready.url, anyone: input.anyone };
  },
};

const linkOf = async (q, ctx, id, lock = false) => (await q.query(
  `select l.*, u.name as by_name from drive_links l join users u on u.id = l.user_id
    where l.id = $1 and l.workspace_id = $2${lock ? ' for update of l' : ''}`, [id, ctx.workspaceId],
)).rows[0];

export const linkActions = {
  'blast.link.drive': link,
  'media.link.drive': { ...link },

  'drive.link.close': {
    roles: EVERYONE,
    input: z.object({ id: z.uuid() }),
    before: async (db, ctx, input) => {
      deskOnly(ctx);
      if (!driveSetup().ok) throw httpError(409, 'Google Drive isn’t set up — see Settings → Services');
      const l = await linkOf(db, ctx, input.id);
      if (!l) throw httpError(404, 'That link isn’t here');
      if (l.closed_at) throw httpError(409, 'It’s already private');
      if (l.user_id !== ctx.user.id) throw httpError(403, `Only ${l.by_name || 'the person who opened it'} can make this private — or change it in Drive`);
      const g = await usableGrant(db, ctx);
      const r = await closePermission(db, g, l.file_id, l.permission_id);
      if (!r.ok) throw refused(r);
      return { ok: true };
    },
    handler: async (tx, ctx, input, emit) => {
      deskOnly(ctx);
      const l = await linkOf(tx, ctx, input.id, true);
      if (!l || l.user_id !== ctx.user.id) throw httpError(404, 'That link isn’t here');
      if (!l.closed_at) {
        await tx.query('update drive_links set closed_at = now(), closed_by = $2 where id = $1', [l.id, ctx.user.id]);
        emit('drive_link', l.id, 'update', { closed: true });
      }
      return { id: l.id, closed: true };
    },
  },
};
