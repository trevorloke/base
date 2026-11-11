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
//      here before "who goes" is worked out, so they are never offered
//      again — and how many that was is kept on the sync, for the list's
//      line: the question before the tap could not know
//   2. new addresses join the audience, 500 to a call, update_existing
//      false: a member already there is never changed, and nobody
//      unsubscribed there is ever put back
//   3. the tag (a static segment named "base.win: <list>") gains who is
//      missing and loses who left the list — the difference against
//      everyone in it now, whoever unsubscribed there included
// It works in parts of about 20 seconds so a big list never holds up the
// other background work; how far it got is kept on the sync (cursor), so
// the next part, or a retry after Mailchimp said "too many", carries on
// from there: an address Mailchimp refused is not offered again by a later
// part, and is counted once however often its own part is tried.
// Mailchimp's "too many" (429) or a fault of its own fails the job, which
// the job runner tries again later; a refusal that waiting won't change (the
// key, the audience) stops the sync with Mailchimp's words.
import { httpError } from '../../actions/util.js';
import { newId, runAction } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { loadList, recipientsOf } from '../lists/audience.js';
import { keyFor, lower, mailchimp, mailchimpOn, MailchimpError, pages } from './mailchimp.js';
import { firstOf, pull, PULL_JOB, queueDays, sayYes } from './pull.js';

export const PUSH_ACTION = 'mailchimp.push';
export const SYNC_JOB = 'mailchimp.sync';
const TAG_MAX = 100; // a tag's name in Mailchimp
const tagFor = (listName, ending = '') => `${`base.win: ${listName}`.slice(0, TAG_MAX - ending.length)}${ending}`;

// A part's length and a call's size (tests make both small).
let sliceMs = 20_000;
let chunkSize = 500;
export const _setSliceForTest = (v) => { sliceMs = v?.ms ?? 20_000; chunkSize = v?.chunk ?? 500; };

const parseJ = (v, d) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) ?? d; } catch { return d; } };
export const syncOut = (s) => ({
  id: s.id, list_id: s.list_id, status: s.status, consent: s.consent, tag: s.tag,
  total: s.total, added: s.added, tagged: s.tagged, removed: s.removed, skipped: s.skipped, todo: s.todo,
  skipped_why: s.skipped_why ?? null, pulled_unsubscribed: s.pulled_unsubscribed ?? 0, pulled_cleaned: s.pulled_cleaned ?? 0,
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
// One row per address, in address order: { id (the person), email (lower
// case, what addresses are told apart by), as (the address as it is on file) }.
export const whoGoes = async (db, ws, list, consent) => {
  const rows = await recipientsOf(db, await ctxOf(db, ws), { list, reach: 'email' });
  let people = rows.map((r) => ({ id: r.id, email: lower(r.email), as: String(r.email).trim() })).filter((p) => p.email);
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
// The first pull from an audience waits for a person's yes (pull.js), and a
// sync starts with a pull: while nobody has said yes, a tap is answered with
// the question — { first } — counted afresh by a job first, so the numbers
// it shows are today's. `agree` (the audience) with `shown` (the numbers the
// question showed) is the yes — or, when it showed nobody to turn off, the
// tap that goes on without one. → { sync } or { first }
export const startSync = async (tx, ctx, emit, { list_id: listId, everyone = false, audience, agree = null, shown = null }) => {
  const ws = ctx.workspaceId;
  const list = (await tx.query('select id, name from lists where id = $1 and workspace_id = $2 and deleted_at is null', [listId, ws])).rows[0];
  if (!list) throw httpError(404, 'list not found');
  if (agree) await sayYes(tx, emit, ws, audience, shown);
  else {
    const first = await firstOf(tx, ws, audience);
    if (first) {
      if (!first.counting) await enqueueJob(tx, { workspaceId: ws, kind: PULL_JOB, payload: { full: true } });
      return { first: { ...first, counting: true } };
    }
  }
  const consent = everyone ? 'all' : 'subscribed';
  const cur = (await tx.query('select * from mailchimp_syncs where workspace_id = $1 and list_id = $2 and audience_id = $3 for update', [ws, list.id, audience])).rows[0];
  // Still on its way: this tap is that one — never two jobs filling one tag.
  if (cur && ['queued', 'syncing'].includes(cur.status) && await jobLive(tx, ws, cur.id)) return { sync: syncOut(cur) };
  const id = cur?.id || newId();
  // The tag's name is the list's, kept from the first send. Two lists of one
  // name never share a tag (each would empty the other's): the second is "… (2)".
  let tag = cur?.tag;
  if (!tag) {
    const taken = new Set((await tx.query('select tag from mailchimp_syncs where workspace_id = $1 and audience_id = $2', [ws, audience])).rows.map((r) => r.tag));
    tag = tagFor(list.name);
    for (let n = 2; taken.has(tag); n += 1) tag = tagFor(list.name, ` (${n})`);
  }
  const row = (await tx.query(
    `insert into mailchimp_syncs (id, workspace_id, list_id, audience_id, tag, consent, status, created_by)
     values ($1, $2, $3, $4, $5, $6, 'queued', $7)
     on conflict (id) do update set consent = excluded.consent, status = 'queued', created_by = excluded.created_by, created_at = now(),
       added = 0, tagged = 0, removed = 0, skipped = 0, todo = 0, cursor = null, note = null,
       skipped_why = null, pulled_unsubscribed = 0, pulled_cleaned = 0
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
  kept.delete(runOf(sync));
  await tx.query(
    `update mailchimp_syncs set status = $3, note = $4, cursor = null, todo = 0, synced_at = case when $3 = 'synced' then now() else synced_at end
      where id = $1 and workspace_id = $2`, [sync.id, sync.workspace_id, status, note],
  );
  emit('mailchimp_sync', sync.id, 'update', { status, ...payload });
});
const stop = (db, sync, why) => finish(db, sync, 'failed', { note: why }, why);

// A write's key in this sync: the sync, this run of it (each tap starts a
// new one), and what the call says. A retry of a part says the same and
// carries the same key; "Sync again" next month never does.
const keyOf = (sync, what, ...said) => keyFor(what, sync.id, new Date(sync.created_at).getTime(), ...said);

// The tag's id in Mailchimp: the one kept, else one of that name, else a new
// one (`gone`: the id of one that was deleted there, when this replaces it).
const segmentOf = async (db, sync, gone = '') => {
  if (sync.segment_id) return sync.segment_id;
  const base = `/lists/${sync.audience_id}/segments`;
  const have = (await pages(base, 'segments', { type: 'static', fields: 'segments.id,segments.name,total_items' })).find((s) => s?.name === sync.tag);
  const made = have || await mailchimp('POST', base, { body: { name: sync.tag, static_segment: [] }, idempotencyKey: keyOf(sync, 'newtag', sync.tag, gone) });
  if (made?.id == null) throw new MailchimpError('Mailchimp made the tag but didn’t say which it is');
  await patch(db, sync, 'segment_id = $3', [String(made.id)]);
  return String(made.id);
};
// Who is in the tag now — everyone: Mailchimp lists a tag's members without
// the unsubscribed, the cleaned and the transactional unless asked, and
// whoever left must still be found here to be taken out of the tag (or seen
// to be in it already). A tag deleted in Mailchimp is made again.
const EVERYONE = { include_unsubscribed: true, include_cleaned: true, include_transactional: true };
// What is in the tag is read once for each run of a sync, then kept here and
// brought up to date by the run's own adds and removes: a big list goes in
// many parts, and reading the whole tag again for each part would spend more
// calls than the sync itself. In memory only — after a restart it is read
// again — and dropped when the run ends (a few at most at once).
const kept = new Map(); // `${sync id}:${run}` → { segment, have }
const runOf = (sync) => `${sync.id}:${new Date(sync.created_at).getTime()}`;
const keep = (sync, tag) => {
  kept.delete(runOf(sync));
  kept.set(runOf(sync), tag);
  while (kept.size > 20) kept.delete(kept.keys().next().value);
  return tag;
};
const inTag = async (db, sync) => {
  const read = async (segment) => new Set((await pages(`/lists/${sync.audience_id}/segments/${segment}/members`, 'members', { ...EVERYONE, fields: 'members.email_address,total_items' }))
    .map((m) => lower(m?.email_address)).filter(Boolean));
  let segment = await segmentOf(db, sync);
  try {
    return { segment, have: await read(segment) };
  } catch (e) {
    if (!(e instanceof MailchimpError && e.httpStatus === 404 && sync.segment_id)) throw e;
    await patch(db, sync, 'segment_id = null');
    segment = await segmentOf(db, { ...sync, segment_id: null }, segment);
    return { segment, have: await read(segment) };
  }
};

const num = (v, otherwise) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : otherwise);
// A batch answer's refusals. Someone already in the audience is not one:
// they were left as they are, which is the point.
const alreadyThere = (e) => e?.error_code === 'ERROR_CONTACT_EXISTS' || /already (a |an? existing )?(list )?member|already exists/i.test(String(e?.error || ''));
const refusedBy = (res) => (Array.isArray(res?.errors) ? res.errors : []).filter((e) => !alreadyThere(e));
const emailsIn = (errors) => errors.flatMap((e) => [e?.email_address, ...(Array.isArray(e?.email_addresses) ? e.email_addresses : [])]).map(lower).filter(Boolean);
// Mailchimp's own words for one refusal, as it gave them.
const wordsOf = (e) => [e?.error, e?.field_message, e?.error_code].find((v) => typeof v === 'string' && v.trim())?.trim().slice(0, 300) || null;

// New addresses into the audience, then into the tag. → what to count once
// the sync is past them: { tagged, skipped, why, into } — why: Mailchimp's
// words about the first address it would not take, when there is one; into:
// the addresses now in the tag.
// skip_merge_validation: an audience may insist on a field of its own for
// every new member (a postal code, a last name). Only the address and the
// two names ever go, so Mailchimp is asked to take a member without it —
// rather than refuse everyone, or have base.win make something up.
const addPart = async (db, sync, segment, part) => {
  const names = new Map((await db.query('select id, first_name, last_name from persons where id = any($1::uuid[])', [part.map((p) => p.id)])).rows.map((r) => [r.id, r]));
  const members = part.map((p) => ({
    email_address: p.as, status: 'subscribed',
    merge_fields: { FNAME: names.get(p.id)?.first_name || '', LNAME: names.get(p.id)?.last_name || '' },
  }));
  const res = await mailchimp('POST', `/lists/${sync.audience_id}`, {
    query: { skip_merge_validation: true }, body: { members, update_existing: false },
    idempotencyKey: keyOf(sync, 'add', ...part.map((p) => p.email)), timeoutMs: 60_000,
  });
  const refused = refusedBy(res);
  const no = new Set(emailsIn(refused));
  // Who is new to the audience is said at once: tried again, this call
  // finds them already there and could never count them.
  await patch(db, sync, 'added = added + $3', [num(res?.total_created, Array.isArray(res?.new_members) ? res.new_members.length : 0)]);
  const skipped = Math.max(refused.length, no.size);
  // What Mailchimp took (or already had) goes into the tag.
  const toTag = part.filter((p) => !no.has(p.email)).map((p) => p.as);
  const why = wordsOf(refused[0]);
  if (!toTag.length) return { tagged: 0, skipped, why, into: [] };
  const tagged = await mailchimp('POST', `/lists/${sync.audience_id}/segments/${segment}`, {
    body: { members_to_add: toTag }, idempotencyKey: keyOf(sync, 'tag', segment, ...toTag.map(lower)), timeoutMs: 60_000,
  });
  // In the audience, and the tag would not take them: not taken either.
  const untagged = Array.isArray(tagged?.errors) ? tagged.errors : [];
  const out = new Set(emailsIn(untagged));
  const missed = out.size;
  return {
    tagged: num(tagged?.total_added, toTag.length - missed), skipped: skipped + missed, why: why || (missed ? wordsOf(untagged[0]) : null),
    into: toTag.map(lower).filter((e) => !out.has(e)),
  };
};

// Why the sync's own pull stopped it before anything went: the question
// came back (pull.js) — the audience in use is another one now, a yes was
// shown fewer than its pull counted, or someone came in since the count
// that showed nobody. Try again asks the question, counted afresh.
const plural = (n, one, many) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const askedWords = (asked, sync) => {
  if (asked.audience !== sync.audience_id) return 'Mailchimp’s audience has changed since — tap Try again';
  const who = [
    asked.unsubscribed ? `${plural(asked.unsubscribed, 'person', 'people')} here unsubscribed in Mailchimp` : null,
    asked.cleaned ? plural(asked.cleaned, 'dead address', 'dead addresses') : null,
  ].filter(Boolean).join(' · ');
  return `${who}${asked.more ? ', more than the question said,' : ' since it was counted,'} so nothing was sent — tap Try again`;
};

// One part of a sync. → true when there is more to do.
const part = async (db, sync) => {
  const ws = sync.workspace_id;
  const cursor = parseJ(sync.cursor, {}) || {};
  if (!cursor.pulled) {
    const gone = await pull(db, ws, { full: true });
    // The first pull from the audience asked instead (nobody has said yes
    // to what it would turn off now): nothing goes.
    if (gone.asked) { await stop(db, sync, askedWords(gone.asked, sync)); return false; }
    cursor.pulled = true;
    await patch(db, sync, 'pulled_unsubscribed = $3, pulled_cleaned = $4, cursor = $5::jsonb', [gone.unsubscribed, gone.cleaned, JSON.stringify(cursor)]);
  }
  const list = await loadList(db, ws, sync.list_id);
  if (!list) { await stop(db, sync, 'The list was deleted'); return false; }
  const want = await whoGoes(db, ws, list, sync.consent);
  const wanted = new Set(want.map((p) => p.email));
  const { segment, have } = kept.get(runOf(sync)) || keep(sync, await inTag(db, sync));
  // In address order, past where the last part got to.
  const toAdd = want.filter((p) => !have.has(p.email) && !(cursor.add && p.email <= cursor.add));
  const toRemove = [...have].filter((e) => !wanted.has(e) && !(cursor.remove && e <= cursor.remove)).sort();
  await patch(db, sync, 'total = $3, todo = $4', [want.length, toAdd.length + toRemove.length]);
  const until = Date.now() + sliceMs;
  const left = () => toAdd.length + toRemove.length;
  while (toAdd.length) {
    const some = toAdd.splice(0, chunkSize);
    const did = await addPart(db, sync, segment, some);
    for (const e of did.into) have.add(e);
    cursor.add = some.at(-1).email;
    // Counted in the same write that moves past them: a part tried again
    // (Mailchimp said "too many" half-way) never counts a refusal twice.
    await patch(db, sync, 'tagged = tagged + $3, skipped = skipped + $4, skipped_why = coalesce(skipped_why, $7), todo = $5, cursor = $6::jsonb',
      [did.tagged, did.skipped, left(), JSON.stringify(cursor), did.why]);
    if (left() && Date.now() >= until) return true;
  }
  while (toRemove.length) {
    const some = toRemove.splice(0, chunkSize);
    const res = await mailchimp('POST', `/lists/${sync.audience_id}/segments/${segment}`, { body: { members_to_remove: some }, idempotencyKey: keyOf(sync, 'untag', segment, ...some), timeoutMs: 60_000 });
    for (const e of some) have.delete(e);
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
      // More to do: the next part (unless one is waiting already — a job the
      // runner took back after ten minutes may be running beside this one),
      // and nothing left of an earlier try's words.
      await patch(db, sync, 'note = null');
      const waiting = (await db.query(
        `select 1 from jobs where workspace_id = $1 and kind = $2 and status = 'pending' and payload->>'sync_id' = $3 limit 1`, [ws, SYNC_JOB, sync.id],
      )).rows.length;
      if (!waiting) await enqueueJob(db, { workspaceId: ws, kind: SYNC_JOB, payload: { sync_id: sync.id } });
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
