// "Send to Google Sheets": a new Sheet, made and filled in the background,
// one part (at most 20 s) per job — the Mailchimp sync's pattern
// (ext/mailchimp/push.js runSyncJob).
//
//   SOURCES                    what can be sent: a list, a report, a dataset
//   sourceOf(db, ctx, source, ref) → { area[], name, count(), cols(), page(cursor, limit) } | throws
//   ctxFor(db, workspaceId, userId)  the person who started it, as they are now
//   mayStillSend(ctx, rules)   whether they may still send
//   landing(rules, row, settings)    where it lands, or the words that refuse it
//   runExportJob(db, job)      the drive.export job
//
// Google's refusals come back from googleFetch as trouble, never thrown:
// a pause hands the job back ({ again }) with no try counted; Google not
// answering (a 5xx or a timeout that reached Google) counts a try, so the
// runner retries this part with its backoff, 5 in a row per part.
import { httpError } from '../../actions/util.js';
import { runAction } from '../../lib/events.js';
import { enqueueJob, MAX_ATTEMPTS, runJobsSoon } from '../../lib/jobs.js';
import { areasFor, permsOf } from '../../lib/perms.js';
import { grantRowOf } from '../../lib/google/tokens.js';
import { signinRules } from '../../lib/google/config.js';
import { timeZone } from '../../lib/org.js';
import { loadList } from '../lists/audience.js';
import { LIST_HEAD, listCount, listPage } from '../lists/rows.js';
import { DATASETS, REPORTS, datasetCols, datasetCount, datasetPage } from '../reports/rows.js';
import { DESK, driveRules, driveSetup } from './config.js';
import { driveGrant } from './grant.js';
import { exportsFolder, makeSheet } from './files.js';
import { growSheet, shapeSheet, writeRows } from './sheets.js';

export const JOB = 'drive.export';
// Google's limit for one Sheet; the size of a part. Settable in tests.
export const LIMITS = { cells: 10_000_000, sliceMs: 20_000, pageRows: 2000 };
export const _setLimitsForTest = (o) => Object.assign(LIMITS, o);
const pageFor = (cols) => Math.max(1, Math.min(LIMITS.pageRows, Math.floor(60_000 / Math.max(1, cols))));

const REPORT_TITLES = {
  rating: 'People by rating', tags: 'Tags', cities: 'Cities', 'people-by-week': 'People added by week',
  contacts: 'Contacts by week', donations: 'Donations by month', subscribers: 'Newsletter by month', sends: 'Sends',
};
const DATASET_TITLES = {
  people: 'People', members: 'Members', volunteers: 'Volunteers', signs: 'Signs', shifts: 'Shifts',
  gifts: 'Gifts', subscribers: 'Newsletter subscribers', contacts: 'Contacts', lists: 'Lists',
};
const NOT_FOR_YOU = 'not for you — ask a manager under Admin → Permissions';

// ── What can be sent ──
export const sourceOf = async (db, ctx, source, ref) => {
  const ws = ctx.workspaceId;
  if (source === 'list') {
    const list = await loadList(db, ws, ref);
    if (!list) throw httpError(404, 'That list isn’t here any more');
    return {
      area: ['people'], name: list.name,
      count: () => listCount(db, ctx, list), cols: async () => LIST_HEAD.length, head: async () => LIST_HEAD,
      page: async (cursor, limit) => {
        const p = await listPage(db, ctx, list, { cursor, limit });
        return { rows: p.rows, next: p.next };
      },
    };
  }
  if (source === 'report') {
    if (!Object.hasOwn(REPORTS, ref)) throw httpError(404, 'No such report');
    const read = () => REPORTS[ref](db, ws, ctx);
    return {
      area: ['data'], name: REPORT_TITLES[ref] || ref,
      count: async () => (await read()).rows.length, cols: async () => (await read()).head.length, head: async () => (await read()).head,
      // Small (a hundred rows at most): read whole, sent in slices.
      page: async (cursor, limit) => {
        const { rows } = await read();
        const from = Number(cursor?.offset) || 0;
        return { rows: rows.slice(from, from + limit), next: from + limit < rows.length ? { offset: from + limit } : null };
      },
    };
  }
  if (source === 'dataset') {
    if (!Object.hasOwn(DATASETS, ref)) throw httpError(404, 'No such table');
    return {
      // Money going to Google needs Donations as well as Data.
      area: ['gifts', 'members'].includes(ref) ? ['data', 'money'] : ['data'], name: DATASET_TITLES[ref] || ref,
      count: () => datasetCount(db, ws, ref), cols: () => datasetCols(db, ws, ref),
      head: async () => (await datasetPage(db, ws, ref, { limit: 1 })).head,
      page: async (cursor, limit) => {
        const p = await datasetPage(db, ws, ref, { cursor, limit });
        return { rows: p.rows, next: p.next };
      },
    };
  }
  throw httpError(400, 'Send a list, a report or a table');
};
export const mayReadSource = (ctx, src) => src.area.every((a) => areasFor(ctx).includes(a));
export const checkSource = (ctx, src) => { if (!mayReadSource(ctx, src)) throw httpError(403, NOT_FOR_YOU); };

// ── Who may send, and where it lands ──
export const mayStillSend = (ctx, rules) => {
  if (!ctx || !DESK.includes(ctx.role) || ctx.candidate) return false;
  if (rules.sheets === 'off') return false;
  if (rules.sheets === 'managers') return ctx.role === 'manager';
  return true;
};
export const sendWords = (ctx, rules) => {
  if (rules.sheets === 'off') return [403, 'Google Sheets is off for this campaign'];
  if (rules.sheets === 'managers' && ctx.role !== 'manager') return [403, 'Only managers can send to Google Sheets here'];
  return null;
};
export const PERSONAL = 'Sheets can’t go to a personal Google account. Ask a manager for a shared-drive folder.';
// row: the person's google_grants row (its hd). → { ok, land } | { ok: false, words }.
export const landing = (rules, row, settings) => {
  if (rules.folder?.shared) return { ok: true, land: 'campaign' };
  const land = rules.folder ? 'campaign' : 'mine';
  if (!row) return { ok: true, land, unknown: true };
  const domain = signinRules(settings).domain;
  if (!row.hd || (domain && String(row.hd).toLowerCase() !== domain)) return { ok: false, words: PERSONAL };
  return { ok: true, land };
};

// The person who started an export, as they are now (the same reading as
// lib/auth.js loadContext, without the session): null once they've left.
export const ctxFor = async (db, workspaceId, userId) => {
  const r = (await db.query(
    `select u.id as user_id, u.email, u.name as user_name, m.role, m.permissions, w.settings, w.name as ws_name,
            exists (select 1 from candidates c where c.workspace_id = m.workspace_id and c.user_id = m.user_id
                      and c.removed_at is null and m.role = 'volunteer') as candidate
       from memberships m join users u on u.id = m.user_id join workspaces w on w.id = m.workspace_id
      where m.workspace_id = $1 and m.user_id = $2`,
    [workspaceId, userId],
  )).rows[0];
  if (!r) return null;
  const settings = typeof r.settings === 'string' ? JSON.parse(r.settings) : (r.settings || {});
  const own = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : (r.permissions || {});
  return {
    user: { id: r.user_id, email: r.email, name: r.user_name },
    role: r.role,
    candidate: r.candidate ? {} : null,
    perms: permsOf(r.candidate ? 'candidate' : r.role, settings, own),
    workspaceId,
    workspace: { id: workspaceId, name: r.ws_name, settings },
  };
};

// ── Cells, as a Sheet holds them (RAW) ──
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};
// A date is YYYY-MM-DD; a moment keeps its time, in the campaign's time
// zone; numbers stay numbers; null is empty. (A Postgres date arrives as
// midnight UTC.)
export const sheetCell = (v) => {
  if (v == null) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const midnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    return midnight ? `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}` : stamp(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  return String(v);
};

// ── The job ──
// One write on the export's row (as the system: the job, not a person) → the row now.
const step = async (db, ex, set, params = [], emit = null) => (await runAction(db, { workspaceId: ex.workspace_id, actorId: null, action: 'drive.export.step' }, async (tx, e) => {
  const r = (await tx.query(`update drive_exports set ${set}, touched_at = now() where id = $1 and workspace_id = $2 returning *`, [ex.id, ex.workspace_id, ...params])).rows[0];
  if (emit && r) emit(e, r);
  return r;
})).result;
const end = (db, ex, status, said) => step(db, ex, "status = $3, said = $4, done_at = case when $3 = 'done' then now() else done_at end",
  [status, said ? String(said).slice(0, 300) : null],
  (e, r) => e('drive_export', r.id, 'update', { status, rows: r.done_rows }));

const carriesOn = (ex) => `Google didn’t answer — Try again carries on from row ${(Number(ex.done_rows) + 1).toLocaleString('en-CA')}`;
const SAID = {
  client: 'Google refused base.win’s settings — see Settings → Services',
  full: 'Your Google Drive is full',
  fill: 'Google wouldn’t let base.win fill the Sheet',
};
// Thrown for a counted try: the runner retries this part with its backoff.
class NoAnswer extends Error {}
const FOLDER_GONE = ['notFound', 'insufficientFilePermissions', 'appNotAuthorizedToFile'];

// A refused answer → what the job does (decision 10's table).
const outcome = async (db, ex, r, { folder = false, sheet = false } = {}) => {
  const t = r.trouble;
  if (t?.code === 'paused') return { again: Math.max(1000, (t.until ? new Date(t.until).getTime() : 0) - Date.now()) };
  if (t?.code === 'unavailable' && r.reached) throw new NoAnswer('Google didn’t answer');
  if (t?.code === 'unavailable' || t?.code === 'client') {
    const waits = Number(ex.waits) + 1;
    if (waits >= 20) { await end(db, ex, 'failed', t.code === 'client' ? SAID.client : carriesOn(ex)); return {}; }
    await step(db, ex, 'waits = $3', [waits]);
    return { again: t.code === 'client' ? 60_000 : 30_000 };
  }
  if (t?.code === 'reconnect') { await end(db, ex, 'failed', 'reconnect'); return {}; }
  if (!t && r.status >= 500) throw new NoAnswer(`Google answered ${r.status}`);
  if (r.reason === 'storageQuotaExceeded') { await end(db, ex, 'failed', SAID.full); return {}; }
  if (folder && FOLDER_GONE.includes(r.reason)) { await end(db, ex, 'failed', 'pick-folder'); return {}; }
  if (r.code === 'drive-api-off') { await end(db, ex, 'failed', r.plain); return {}; }
  if (sheet && r.status === 403) { await end(db, ex, 'failed', SAID.fill); return {}; }
  await end(db, ex, 'failed', r.plain || `Google Drive refused (${r.status}).`);
  return {};
};
const refusedOf = (r) => {
  const reason = r.body?.error?.errors?.[0]?.reason || r.body?.error?.details?.find?.((d) => d?.reason)?.reason || null;
  const off = reason === 'SERVICE_DISABLED' || /has not been used in project/i.test(r.body?.error?.message || '');
  return {
    ...r, reason,
    code: off ? 'drive-api-off' : null,
    plain: off ? 'The Google Drive API (or Sheets API) isn’t turned on in this Google Cloud project.' : null,
  };
};

// One part: make the Sheet if there is none, then pages until the time is up.
const part = async (db, ex, ctx, g, rules) => {
  const until = Date.now() + LIMITS.sliceMs;
  const src = await sourceOf(db, ctx, ex.source, ex.ref);
  const cols = Number(ex.cols);
  let cur = typeof ex.cursor === 'string' ? JSON.parse(ex.cursor) : (ex.cursor || {});
  let grid = Number(cur.grid) || Number(ex.rows) + 1;
  if (!ex.file_id) {
    let parent = rules.folder?.id;
    if (ex.land === 'mine' || !parent) {
      const f = await exportsFolder(db, g);
      if (!f.ok) return outcome(db, ex, f);
      parent = f.id;
    }
    const made = await makeSheet(db, g, { name: ex.name, parent, exportId: ex.id });
    if (!made.ok) return outcome(db, ex, made, { folder: ex.land === 'campaign' });
    ex = await step(db, ex, "file_id = $3, url = $4, status = 'sending', cursor = $5::jsonb", [made.id, made.url, JSON.stringify({ grid })]);
  }
  if (Number(ex.done_rows) === 0 && !cur.page) {
    // The grid and the header row: exact, so a part tried again repeats them harmlessly.
    const shaped = await shapeSheet(db, g, ex.file_id, { rows: grid, cols });
    if (!shaped.ok) return outcome(db, ex, refusedOf(shaped), { sheet: true });
    const head = (await src.head()).slice(0, cols);
    const wrote = await writeRows(db, g, ex.file_id, 1, [head.map(sheetCell)]);
    if (!wrote.ok) return outcome(db, ex, refusedOf(wrote), { sheet: true });
  }
  for (;;) {
    const page = await src.page(cur.page || null, pageFor(cols));
    const rows = page.rows.map((r) => r.slice(0, cols).map(sheetCell));
    if (rows.length) {
      const need = Number(ex.done_rows) + rows.length + 1;
      if (need > grid) {
        // The source grew since it was counted: more rows, within Google's limit.
        if (need * cols > LIMITS.cells) {
          await end(db, ex, 'done', `Google’s limit reached at ${Number(ex.done_rows).toLocaleString('en-CA')} rows — the rest is in Download CSV`);
          return {};
        }
        const grown = await growSheet(db, g, ex.file_id, need - grid);
        if (!grown.ok) return outcome(db, ex, refusedOf(grown), { sheet: true });
        grid = need;
      }
      const wrote = await writeRows(db, g, ex.file_id, Number(ex.done_rows) + 2, rows);
      if (!wrote.ok) return outcome(db, ex, refusedOf(wrote), { sheet: true });
    }
    cur = { page: page.next, grid };
    ex = await step(db, ex, 'done_rows = done_rows + $3, cursor = $4::jsonb, waits = 0, said = null', [rows.length, JSON.stringify(cur)]);
    if (!page.next) {
      await end(db, ex, 'done', null);
      return {};
    }
    if (Date.now() >= until) return { more: true };
  }
};

const pendingFor = async (db, ex) => Boolean((await db.query(
  `select 1 from jobs where workspace_id = $1 and kind = $2 and status = 'pending' and payload->>'id' = $3 limit 1`,
  [ex.workspace_id, JOB, ex.id],
)).rows[0]);

export const runExportJob = async (db, job) => {
  const ws = job.workspace_id;
  const ex = (await db.query('select * from drive_exports where id = $1 and workspace_id = $2', [job.payload?.id, ws])).rows[0];
  if (!ex || !['waiting', 'sending'].includes(ex.status)) return undefined;
  const ctx = await ctxFor(db, ws, ex.user_id);
  if (!ctx) { await end(db, ex, 'stopped', 'They left the team'); return undefined; }
  const rules = driveRules(ctx.workspace.settings);
  if (!rules.on || !driveSetup().ok) { await end(db, ex, 'stopped', 'Google Drive was turned off'); return undefined; }
  let src = null;
  try { src = await sourceOf(db, ctx, ex.source, ex.ref); } catch { /* gone: below */ }
  if (!mayStillSend(ctx, rules) || !src || !mayReadSource(ctx, src)) {
    await end(db, ex, 'stopped', src ? 'They can’t send to Google Sheets any more' : 'What was being sent isn’t here any more');
    return undefined;
  }
  const g = await driveGrant(db, ctx);
  if (!g) { await end(db, ex, 'stopped', 'Google Drive was disconnected'); return undefined; }
  if (g.state === 'reconnect') { await end(db, ex, 'failed', 'reconnect'); return undefined; }
  if (g.state !== 'ok') { await end(db, ex, 'stopped', 'They can’t send to Google Sheets any more'); return undefined; }
  const place = landing(rules, await grantRowOf(db, ctx.user.id), ctx.workspace.settings);
  if (!place.ok) { await end(db, ex, 'stopped', place.words); return undefined; }
  if (ex.status === 'waiting') await step(db, ex, "status = 'sending'");
  let out;
  try {
    out = await part(db, { ...ex, status: 'sending' }, ctx, g, rules);
  } catch (e) {
    if (!(e instanceof NoAnswer)) throw e;
    const now = (await db.query('select * from drive_exports where id = $1', [ex.id])).rows[0];
    if (Number(job.attempts) >= MAX_ATTEMPTS) { await end(db, now, 'failed', carriesOn(now)); return undefined; }
    await step(db, now, 'said = $3', ['Google didn’t answer — trying again']);
    throw e;
  }
  if (out?.again) return { again: out.again };
  if (out?.more) {
    const now = (await db.query('select done_rows from drive_exports where id = $1', [ex.id])).rows[0];
    if (!(await pendingFor(db, ex))) await enqueueJob(db, { workspaceId: ws, kind: JOB, key: `${ex.id}:${now.done_rows}`, payload: { id: ex.id } });
    runJobsSoon();
  }
  return undefined;
};

// GET /api/drive/exports' safety net: nothing says "Sending" forever.
export const STALE_SQL = `(e.status in ('waiting','sending') and e.touched_at < now() - interval '15 minutes'
  and not exists (select 1 from jobs j where j.workspace_id = e.workspace_id and j.kind = '${JOB}'
                  and j.status in ('pending','running') and j.payload->>'id' = e.id::text))`;
