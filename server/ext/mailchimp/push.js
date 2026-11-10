// A list becomes a tag in the Mailchimp audience: mailchimp.push (the tap,
// desk) and the job that does the work.
//
// Who goes: the list's addresses that can be emailed (ext/lists recipientsOf
// — never do-not-email, do-not-contact, unsubscribed or suppressed), and by
// default only those subscribed to base.win's own newsletter; "everyone" is
// the desk's one tick, for a list whose people agreed to email some other
// way. What goes: the address, first and last name. Never a rating, a tag,
// a note, an address or anything about money.
//
// The job brings the tag into line, so running it twice changes nothing and
// one that dies part-way is finished by the next run:
//   1. pull first (pull.js, everyone): whoever left in Mailchimp is off
//      here before "who goes" is worked out, so they are never offered again
//   2. new addresses join the audience, 500 to a call, update_existing
//      false: a member already there is never changed, and nobody
//      unsubscribed there is ever put back
//   3. the tag (a static segment named "base.win: <list>") gains who is
//      missing and loses who left the list — the difference against who is
//      in it now
// It works in parts of about 20 seconds so a big list never holds up the
// other background work; how far it got is kept on the sync (cursor), so a
// part, or a retry after Mailchimp said "too many", carries on from there
// and an address Mailchimp refused is not offered twice in one sync.
// Mailchimp's "too many" (429) or a fault of its own fails the job, which
// the job runner tries again later; a refusal that waiting won't change (the
// key, the audience) stops the sync with Mailchimp's words.
import { httpError } from '../../actions/util.js';
import { newId, runAction } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { loadList, recipientsOf } from '../lists/audience.js';
import { lower, mailchimp, mailchimpOn, MailchimpError, pages } from './mailchimp.js';
import { pull, queueDays } from './pull.js';

export const PUSH_ACTION = 'mailchimp.push';
export const SYNC_JOB = 'mailchimp.sync';
const TAG_MAX = 100; // a tag's name in Mailchimp
const tagFor = (listName) => `base.win: ${listName}`.slice(0, TAG_MAX);

// A part's length and a call's size (tests make both small).
let sliceMs = 20_000;
let chunkSize = 500;
export const _setSliceForTest = (v) => { sliceMs = v?.ms ?? 20_000; chunkSize = v?.chunk ?? 500; };

const parseJ = (v, d) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) ?? d; } catch { return d; } };
export const syncOut = (s) => ({
  id: s.id, list_id: s.list_id, status: s.status, consent: s.consent, tag: s.tag,
  total: s.total, added: s.added, tagged: s.tagged, removed: s.removed, skipped: s.skipped, todo: s.todo,
  note: s.note, synced_at: s.synced_at, created_at: s.created_at,
});
// A job still to run, or running, for this sync.
export const jobLive = async (q, ws, syncId) => (await q.query(
  `select 1 from jobs where workspace_id = $1 and kind = $2 and status in ('pending', 'running') and payload->>'sync_id' = $3 limit 1`, [ws, SYNC_JOB, syncId],
)).rows.length > 0;

// ── Who goes ──
const byEmail = (a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
// What a job needs of the campaign to ask "who is on this list" (as a send does).
const ctxOf = async (db, ws) => {
  const w = (await db.query('select name, settings from workspaces where id = $1', [ws])).rows[0];
  return { workspaceId: ws, workspace: { name: w?.name || '', settings: parseJ(w?.settings, {}) } };
};
const subscribedAmong = async (db, ws, emails) => new Set(emails.length ? (await db.query(
  "select email from subscriptions where workspace_id = $1 and status = 'subscribed' and email = any($2::text[])", [ws, emails],
)).rows.map((r) => r.email) : []);
// One row per address, in address order: { id (the person), email }.
export const whoGoes = async (db, ws, list, consent) => {
  const rows = await recipientsOf(db, await ctxOf(db, ws), { list, reach: 'email' });
  let people = rows.map((r) => ({ id: r.id, email: lower(r.email) })).filter((p) => p.email);
  if (consent !== 'all') {
    const yes = await subscribedAmong(db, ws, people.map((p) => p.email));
    people = people.filter((p) => yes.has(p.email));
  }
  return people.sort(byEmail);
};
// Before the tap: how many would go, each way.
export const countsFor = async (db, ws, list) => {
  const everyone = await whoGoes(db, ws, list, 'all');
  return { subscribed: (await subscribedAmong(db, ws, everyone.map((p) => p.email))).size, everyone: everyone.length };
};

// ── The tap ──
// Inside the action's write. `audience` was found before it (never a call
// to Mailchimp while the campaign's lock is held).
export const startSync = async (tx, ctx, emit, { list_id: listId, everyone = false, audience }) => {
  const ws = ctx.workspaceId;
  const list = (await tx.query('select id, name from lists where id = $1 and workspace_id = $2 and deleted_at is null', [listId, ws])).rows[0];
  if (!list) throw httpError(404, 'list not found');
  const consent = everyone ? 'all' : 'subscribed';
  const cur = (await tx.query('select * from mailchimp_syncs where workspace_id = $1 and list_id = $2 and audience_id = $3 for update', [ws, list.id, audience])).rows[0];
  // Still on its way: this tap is that one — never two jobs filling one tag.
  if (cur && ['queued', 'syncing'].includes(cur.status) && await jobLive(tx, ws, cur.id)) return { sync: syncOut(cur) };
  const id = cur?.id || newId();
  const tag = cur?.tag || tagFor(list.name);
  const row = (await tx.query(
    `insert into mailchimp_syncs (id, workspace_id, list_id, audience_id, tag, consent, status, created_by)
     values ($1, $2, $3, $4, $5, $6, 'queued', $7)
     on conflict (id) do update set consent = excluded.consent, status = 'queued', created_by = excluded.created_by, created_at = now(),
       added = 0, tagged = 0, removed = 0, skipped = 0, todo = 0, cursor = null, note = null
     returning *`,
    [id, ws, list.id, audience, tag, consent, ctx.user.id],
  )).rows[0];
  await enqueueJob(tx, { workspaceId: ws, kind: SYNC_JOB, payload: { sync_id: id } });
  await queueDays(tx, ws);
  emit('mailchimp_sync', id, cur ? 'update' : 'create', { list_id: list.id, list: list.name, tag, consent });
  return { sync: syncOut(row) };
};

// ── The job ──
const patch = (db, sync, sets, params = []) => db.query(`update mailchimp_syncs set ${sets} where id = $1 and workspace_id = $2`, [sync.id, sync.workspace_id, ...params]);
// The sync's end, on the event log as the system: how many, or why not.
const finish = (db, sync, status, payload, note = null) => runAction(db, { workspaceId: sync.workspace_id, actorId: null, action: PUSH_ACTION }, async (tx, emit) => {
  await tx.query(
    `update mailchimp_syncs set status = $3, note = $4, cursor = null, todo = 0, synced_at = case when $3 = 'synced' then now() else synced_at end
      where id = $1 and workspace_id = $2`, [sync.id, sync.workspace_id, status, note],
  );
  emit('mailchimp_sync', sync.id, 'update', { status, ...payload });
});
const stop = (db, sync, why) => finish(db, sync, 'failed', { note: why }, why);

// The tag's id in Mailchimp: the one kept, else one of that name, else a new one.
const segmentOf = async (db, sync) => {
  if (sync.segment_id) return sync.segment_id;
  const base = `/lists/${sync.audience_id}/segments`;
  const have = (await pages(base, 'segments', { type: 'static', fields: 'segments.id,segments.name,total_items' })).find((s) => s?.name === sync.tag);
  const made = have || await mailchimp('POST', base, { body: { name: sync.tag, static_segment: [] }, idempotencyKey: `base-mc-tag-${sync.id}` });
  if (made?.id == null) throw new MailchimpError('Mailchimp made the tag but didn’t say which it is');
  await patch(db, sync, 'segment_id = $3', [String(made.id)]);
  return String(made.id);
};
// Who is in the tag now. A tag deleted in Mailchimp is made again.
const inTag = async (db, sync) => {
  const read = async (segment) => new Set((await pages(`/lists/${sync.audience_id}/segments/${segment}/members`, 'members', { fields: 'members.email_address,total_items' }))
    .map((m) => lower(m?.email_address)).filter(Boolean));
  let segment = await segmentOf(db, sync);
  try {
    return { segment, have: await read(segment) };
  } catch (e) {
    if (!(e instanceof MailchimpError && e.httpStatus === 404 && sync.segment_id)) throw e;
    await patch(db, sync, 'segment_id = null');
    segment = await segmentOf(db, { ...sync, segment_id: null });
    return { segment, have: await read(segment) };
  }
};

const num = (v, otherwise) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : otherwise);
// A batch answer's refusals. Someone already in the audience is not one:
// they were left as they are, which is the point.
const alreadyThere = (e) => e?.error_code === 'ERROR_CONTACT_EXISTS' || /already (a |an? existing )?(list )?member|already exists/i.test(String(e?.error || ''));
const refusedBy = (res) => (Array.isArray(res?.errors) ? res.errors : []).filter((e) => !alreadyThere(e));
const emailsIn = (errors) => errors.flatMap((e) => [e?.email_address, ...(Array.isArray(e?.email_addresses) ? e.email_addresses : [])]).map(lower).filter(Boolean);

// New addresses into the audience, then into the tag. → what happened.
const addPart = async (db, sync, segment, part) => {
  const names = new Map((await db.query('select id, first_name, last_name from persons where id = any($1::uuid[])', [part.map((p) => p.id)])).rows.map((r) => [r.id, r]));
  const members = part.map((p) => ({
    email_address: p.email, status: 'subscribed',
    merge_fields: { FNAME: names.get(p.id)?.first_name || '', LNAME: names.get(p.id)?.last_name || '' },
  }));
  const key = `${sync.id}-${part[0].email}`;
  const res = await mailchimp('POST', `/lists/${sync.audience_id}`, { body: { members, update_existing: false }, idempotencyKey: `base-mc-add-${key}`, timeoutMs: 60_000 });
  const refused = refusedBy(res);
  const no = new Set(emailsIn(refused));
  const added = num(res?.total_created, Array.isArray(res?.new_members) ? res.new_members.length : 0);
  // What Mailchimp took (or already had) goes into the tag; said at once, so a retry never counts it twice.
  await patch(db, sync, 'added = added + $3, skipped = skipped + $4', [added, Math.max(refused.length, no.size)]);
  const toTag = part.map((p) => p.email).filter((e) => !no.has(e));
  if (!toTag.length) return;
  const tagged = await mailchimp('POST', `/lists/${sync.audience_id}/segments/${segment}`, { body: { members_to_add: toTag }, idempotencyKey: `base-mc-tag-${key}`, timeoutMs: 60_000 });
  const missed = emailsIn(Array.isArray(tagged?.errors) ? tagged.errors : []).length;
  await patch(db, sync, 'tagged = tagged + $3, skipped = skipped + $4', [num(tagged?.total_added, toTag.length - missed), missed]);
};

// One part of a sync. → true when there is more to do.
const part = async (db, sync) => {
  const ws = sync.workspace_id;
  const cursor = parseJ(sync.cursor, {}) || {};
  const keep = () => patch(db, sync, 'cursor = $3::jsonb', [JSON.stringify(cursor)]);
  if (!cursor.pulled) {
    await pull(db, ws, { full: true });
    cursor.pulled = true;
    await keep();
  }
  const list = await loadList(db, ws, sync.list_id);
  if (!list) { await stop(db, sync, 'The list was deleted'); return false; }
  const want = await whoGoes(db, ws, list, sync.consent);
  const wanted = new Set(want.map((p) => p.email));
  const { segment, have } = await inTag(db, sync);
  // In address order, past where the last part got to.
  const toAdd = want.filter((p) => !have.has(p.email) && !(cursor.add && p.email <= cursor.add));
  const toRemove = [...have].filter((e) => !wanted.has(e) && !(cursor.remove && e <= cursor.remove)).sort();
  await patch(db, sync, 'total = $3, todo = $4', [want.length, toAdd.length + toRemove.length]);
  const until = Date.now() + sliceMs;
  const left = () => toAdd.length + toRemove.length;
  while (toAdd.length) {
    const some = toAdd.splice(0, chunkSize);
    await addPart(db, sync, segment, some);
    cursor.add = some.at(-1).email;
    await patch(db, sync, 'todo = $3, cursor = $4::jsonb', [left(), JSON.stringify(cursor)]);
    if (left() && Date.now() >= until) return true;
  }
  while (toRemove.length) {
    const some = toRemove.splice(0, chunkSize);
    const res = await mailchimp('POST', `/lists/${sync.audience_id}/segments/${segment}`, { body: { members_to_remove: some }, idempotencyKey: `base-mc-untag-${sync.id}-${some[0]}`, timeoutMs: 60_000 });
    cursor.remove = some.at(-1);
    await patch(db, sync, 'removed = removed + $3, todo = $4, cursor = $5::jsonb', [num(res?.total_removed, some.length), left(), JSON.stringify(cursor)]);
    if (left() && Date.now() >= until) return true;
  }
  const done = (await db.query('select total, added, tagged, removed, skipped from mailchimp_syncs where id = $1 and workspace_id = $2', [sync.id, ws])).rows[0];
  await finish(db, sync, 'synced', done);
  return false;
};

export const runSyncJob = async (db, job) => {
  const ws = job.workspace_id;
  const sync = (await db.query('select * from mailchimp_syncs where id = $1 and workspace_id = $2', [job.payload?.sync_id, ws])).rows[0];
  // Gone with its list, or already ended.
  if (!sync || !['queued', 'syncing'].includes(sync.status)) return;
  if (!mailchimpOn()) { await stop(db, sync, 'Mailchimp isn’t connected here any more'); return; }
  if (sync.status === 'queued') await patch(db, sync, "status = 'syncing'");
  try {
    if (await part(db, sync)) {
      // More to do: the next part, and nothing left of an earlier try's words.
      await patch(db, sync, 'note = null');
      await enqueueJob(db, { workspaceId: ws, kind: SYNC_JOB, payload: { sync_id: sync.id } });
      runJobsSoon();
    }
  } catch (e) {
    const words = e instanceof MailchimpError ? e.message : 'It stopped part-way';
    if (e instanceof MailchimpError && !e.retryable) { await stop(db, sync, words); return; }
    // Kept on the sync while the job runner waits to try again.
    await patch(db, sync, 'note = $3', [words.slice(0, 300)]);
    throw e;
  }
};
