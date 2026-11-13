// drive.settings       { on?, sheets? }            managers (Admin): the campaign's switches
// drive.folder         { file_id | null }          managers (Admin): where new Sheets land
// drive.folder.reach   { file_id }                 desk: "I picked the campaign folder" — a check, nothing stored
// drive.export         { source, ref, client_key } desk: a new Google Sheet, made in the background
// drive.export.retry   { id }                      its starter or a manager: carry on in the same Sheet
// blast|media.attach.drive, blast|media.link.drive, drive.link.close: attach.js, links.js
//
// Google is called only in before (no lock) or in the job, never inside the
// campaign's write. Every action refuses anyone outside the desk roles
// first ("Google Drive is for the desk"): mayRun alone would let a
// volunteer granted an area through. The desk actions list volunteer among
// their roles only so that refusal is the one they hear.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { grantRowOf } from '../../lib/google/tokens.js';
import { timeZone } from '../../lib/org.js';
import { DESK, SHEETS_CHOICES, driveRules, driveSetup } from './config.js';
import { deskOnly, driveGrant, gate, grantWords, refused, usableGrant } from './grant.js';
import { getFile, FOLDER, refusal } from './files.js';
import { attachActions } from './attach.js';
import { linkActions } from './links.js';
import { JOB, LIMITS, checkSource, ctxFor, landing, mayStillSend, sendWords, sourceOf } from './export.js';

const EVERYONE = ['manager', 'treasurer', 'staff', 'volunteer'];
const MANAGER = ['manager'];
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
const SHARED_FIRST = 'Pick a shared-drive folder first, so staff Sheets stay with the campaign';
const num = (n) => Number(n).toLocaleString('en-CA');
const managerOnly = (ctx) => {
  deskOnly(ctx);
  if (ctx.role !== 'manager') throw httpError(403, 'Only a manager can change this');
};
const settingsOf = async (tx, ws) => parse((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0].settings);
const running = async (tx, ws, userId) => (await tx.query(
  `select count(*) filter (where user_id = $2)::int as mine, count(*)::int as all_
     from drive_exports where workspace_id = $1 and status in ('waiting','sending')`, [ws, userId],
)).rows[0];
const roomFor = async (tx, ws, userId) => {
  const n = await running(tx, ws, userId);
  if (n.mine) throw httpError(409, 'You’re already sending one to Google Sheets — wait for it to finish');
  if (n.all_ >= 3) throw httpError(409, 'Three are already going for this campaign — try in a few minutes');
};
const startNow = async (db, ctx, result) => { runJobsSoon(); return { result }; };

export const actions = {
  ...attachActions,
  ...linkActions,

  'drive.settings': {
    roles: MANAGER,
    input: z.object({ on: z.boolean().optional(), sheets: z.enum(SHEETS_CHOICES).optional() }),
    handler: async (tx, ctx, input, emit) => {
      managerOnly(ctx);
      if (!driveSetup().ok) throw httpError(409, 'Google Drive isn’t set up — see Settings → Services');
      const ws = ctx.workspaceId;
      const settings = await settingsOf(tx, ws);
      const now = driveRules(settings);
      const next = { ...now, on: input.on ?? now.on, sheets: input.sheets ?? now.sheets };
      if (next.sheets === 'desk' && !next.folder?.shared) throw httpError(409, SHARED_FIRST);
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...settings, drive: next })]);
      emit('workspace', ws, 'update', { drive: { on: next.on, sheets: next.sheets } });
      return { on: next.on, sheets: next.sheets };
    },
  },

  'drive.folder': {
    roles: MANAGER,
    input: z.object({ file_id: z.string().trim().min(1).max(200).regex(/^[\w-]+$/).nullable() }),
    // The manager's own grant reads what they picked: only a folder will do.
    before: async (db, ctx, input) => {
      managerOnly(ctx);
      gate(ctx);
      if (!input.file_id) return { folder: null };
      const g = await usableGrant(db, ctx);
      const r = await getFile(db, g, input.file_id);
      if (!r.ok) throw refused(r);
      if (r.file.mimeType !== FOLDER) throw httpError(409, 'Pick a folder');
      return { folder: { id: r.file.id, name: String(r.file.name || 'Folder').slice(0, 200), shared: Boolean(r.file.driveId) } };
    },
    handler: async (tx, ctx, input, emit, ready) => {
      managerOnly(ctx);
      const ws = ctx.workspaceId;
      const settings = await settingsOf(tx, ws);
      const now = driveRules(settings);
      if (now.sheets === 'desk' && !ready.folder?.shared) throw httpError(409, SHARED_FIRST);
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...settings, drive: { ...now, folder: ready.folder } })]);
      emit('workspace', ws, 'update', { drive: { folder: ready.folder ? ready.folder.name : null } });
      return { folder: ready.folder };
    },
  },

  'drive.folder.reach': {
    roles: EVERYONE,
    input: z.object({ file_id: z.string().trim().min(1).max(200).regex(/^[\w-]+$/) }),
    before: async (db, ctx, input) => {
      const rules = gate(ctx);
      if (!rules.folder) throw httpError(409, 'No campaign folder is set — Sheets go to each person’s own Drive');
      if (input.file_id !== rules.folder.id) throw httpError(409, `That’s a different folder — choose ${rules.folder.name}`);
      const g = await usableGrant(db, ctx);
      const r = await getFile(db, g, input.file_id);
      if (!r.ok && ['notFound', 'appNotAuthorizedToFile', 'insufficientFilePermissions'].includes(r.reason)) {
        throw httpError(409, 'You don’t have this folder in your Google Drive. Ask a manager to add you to the shared drive.');
      }
      if (!r.ok) throw refused(r);
      return { ok: true };
    },
    handler: async (tx, ctx) => { deskOnly(ctx); return { ok: true }; },
  },

  'drive.export': {
    roles: EVERYONE,
    input: z.object({
      source: z.enum(['list', 'report', 'dataset']),
      ref: z.string().trim().min(1).max(80),
      client_key: z.uuid(),
    }),
    // Every check, and the count, before the write (no lock); nothing is
    // written and Google is not called when one fails.
    before: async (db, ctx, input) => {
      const rules = gate(ctx);
      const no = sendWords(ctx, rules);
      if (no) throw httpError(...no);
      const src = await sourceOf(db, ctx, input.source, input.ref);
      checkSource(ctx, src);
      const g = await driveGrant(db, ctx);
      const ng = grantWords(g);
      if (ng) throw httpError(...ng);
      const place = landing(rules, await grantRowOf(db, ctx.user.id), ctx.workspace.settings);
      if (!place.ok) throw httpError(409, place.words);
      const rows = await src.count();
      if (!rows) throw httpError(409, input.source === 'list' ? 'Nothing to send — the list is empty' : 'Nothing to send — it’s empty');
      const cols = await src.cols();
      if ((rows + 1) * cols > LIMITS.cells) {
        const what = input.source === 'list' || input.ref === 'people' ? 'people' : 'rows';
        throw httpError(409, `Too big for one Google Sheet — ${num(rows)} ${what} × ${cols} columns. Use Download CSV.`);
      }
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      return { rows, cols, land: place.land, name: `${src.name} — ${day}`.slice(0, 200) };
    },
    handler: async (tx, ctx, input, emit, ready) => {
      deskOnly(ctx);
      const ws = ctx.workspaceId;
      const again = (await tx.query('select * from drive_exports where workspace_id = $1 and client_key = $2', [ws, input.client_key])).rows[0];
      if (again) return { export: { id: again.id, name: again.name, rows: again.rows, status: again.status }, duplicate: true };
      await roomFor(tx, ws, ctx.user.id);
      const id = newId();
      await tx.query(
        `insert into drive_exports (id, workspace_id, user_id, client_key, source, ref, name, rows, cols, land, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'waiting')`,
        [id, ws, ctx.user.id, input.client_key, input.source, input.ref, ready.name, ready.rows, ready.cols, ready.land],
      );
      await enqueueJob(tx, { workspaceId: ws, kind: JOB, key: `${id}:0`, payload: { id } });
      emit('drive_export', id, 'create', { source: input.source, name: ready.name, rows: ready.rows, cols: ready.cols, land: ready.land });
      return { export: { id, name: ready.name, rows: ready.rows, status: 'waiting' } };
    },
    after: startNow,
  },

  'drive.export.retry': {
    roles: EVERYONE,
    input: z.object({ id: z.uuid() }),
    // It carries on as the person who started it, with their grant.
    before: async (db, ctx, input) => {
      gate(ctx);
      const ex = (await db.query('select e.*, u.name as by_name from drive_exports e join users u on u.id = e.user_id where e.id = $1 and e.workspace_id = $2', [input.id, ctx.workspaceId])).rows[0];
      if (!ex) throw httpError(404, 'That export isn’t here');
      const mine = ex.user_id === ctx.user.id;
      if (!mine && ctx.role !== 'manager') throw httpError(403, 'Only the person who sent it, or a manager, can try again');
      if (!['failed', 'stopped'].includes(ex.status)) throw httpError(409, 'It isn’t stopped');
      const them = mine ? ctx : await ctxFor(db, ctx.workspaceId, ex.user_id);
      const only = `Only ${ex.by_name || 'the person who sent it'} can carry this on`;
      const rules = driveRules(ctx.workspace.settings);
      if (!them || !mayStillSend(them, rules)) {
        if (!mine) throw httpError(409, only);
        throw httpError(...(sendWords(ctx, rules) || [403, 'Google Drive is for the desk']));
      }
      const g = await driveGrant(db, them);
      const ng = grantWords(g);
      if (ng) throw httpError(mine ? ng[0] : 409, mine ? ng[1] : only);
      const src = await sourceOf(db, them, ex.source, ex.ref);
      checkSource(them, src);
      return { owner: ex.user_id };
    },
    handler: async (tx, ctx, input, emit, ready) => {
      deskOnly(ctx);
      const ws = ctx.workspaceId;
      const ex = (await tx.query('select * from drive_exports where id = $1 and workspace_id = $2 for update', [input.id, ws])).rows[0];
      if (!ex || !['failed', 'stopped'].includes(ex.status)) throw httpError(409, 'It isn’t stopped');
      await roomFor(tx, ws, ready.owner);
      await tx.query(
        `update drive_exports set status = 'waiting', retries = retries + 1, waits = 0, said = null, done_at = null, touched_at = now()
         where id = $1`, [ex.id],
      );
      await enqueueJob(tx, { workspaceId: ws, kind: JOB, key: `${ex.id}:retry:${ex.retries}`, payload: { id: ex.id } });
      emit('drive_export', ex.id, 'update', { status: 'waiting' });
      return { export: { id: ex.id, status: 'waiting' } };
    },
    after: startNow,
  },
};

export { DESK };
