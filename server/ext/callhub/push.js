// A list or a phone bank becomes a CallHub phonebook.
//
//   preparePush / startPush   the tap (callhub.push): who goes is worked out
//                             before the write, then the push, its numbers
//                             and its job are stored in one write. Nothing
//                             is sent to CallHub inside the tap.
//   runPushJob                the job: the phonebook once, then the
//                             campaign's do-not-call numbers (dnc.js; the
//                             push says so while that goes), then one
//                             contact a second, fifty to a run, the next
//                             run queued straight away — so receipts and
//                             ladder steps are never kept waiting behind a
//                             big list.
//
// Every call to CallHub is made outside any transaction; each contact
// CallHub takes is recorded in its own short write (the cursor), so a crash,
// a deploy or a wait loses nothing and nobody is sent twice. A throttle or
// CallHub's daily limit (3,600 contacts) waits and carries on by itself; a
// number CallHub won't take is left out and counted — whose it was is kept
// and named on the push — and the rest go on; a
// refusal of the push itself stops it with CallHub's words, and "Carry on"
// (callhub.resume) picks up where it stopped. Writes are the sender's,
// labelled callhub.push.
import { runAction, newId } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { httpError } from '../../actions/util.js';
import { azKey } from '../../lib/az.js';
import { timeZone } from '../../lib/org.js';
import { toLocal } from '../../lib/tzsql.js';
import { callhub, callhubOn, CallHubError, idOf, pause } from './callhub.js';
import { dncDid, dncListOf, dncOnLog, newTally, syncDnc } from './dnc.js';
import { audienceOf, contactBody, noCalls, notToBeCalled, notToCall, sourceOf } from './people.js';

export const PUSH_JOB = 'callhub.push';
export const PUSH_ACTION = 'callhub.push';
const PER_RUN = 50;
const TRIES = 3;                  // a run that CallHub didn't answer, before it stops
const INSERT_BATCH = 500;
// CallHub won't take a number: it is left out. This many in a row (fewer
// while nothing has gone yet) is not the numbers, it is the push: it stops.
const REFUSALS_IN_A_ROW = 10;
const REFUSALS_AT_THE_START = 5;
// CallHub's documented limit on contacts a day.
let dailyLimit = 3600;
export const _setDailyLimitForTest = (n) => { dailyLimit = n; };

export const pushOut = (p) => ({
  id: p.id, name: p.name, status: p.status, total: p.total, sent: p.sent, skipped: p.skipped,
  refused: p.refused || 0, refused_note: p.refused_note || null,
  note: p.note || null, resume_at: p.resume_at || null, created_at: p.created_at, sent_at: p.sent_at || null,
});

// ── The tap ──
// Before the write (no lock held): who the list or bank names, and who of
// them goes.
export const preparePush = async (db, ctx, input) => {
  if (!callhubOn()) throw httpError(409, 'CallHub isn’t connected');
  const src = await sourceOf(db, ctx, input);
  return { src: { kind: src.kind, id: src.id, name: src.name }, ...audienceOf(src.rows, await notToCall(db, ctx.workspaceId)) };
};

export const startPush = async (tx, ctx, emit, { src, numbers, leftOut }) => {
  const ws = ctx.workspaceId;
  const busy = (await tx.query(
    `select id from callhub_pushes where workspace_id = $1 and source_kind = $2 and source_id = $3 and status in ('queued', 'sending')
      order by created_at desc limit 1`,
    [ws, src.kind, src.id],
  )).rows[0];
  // On its way — or left part-way with no job behind it: then nothing is on its way, and Carry on is the way on.
  if (busy) throw httpError(409, await jobLive(tx, ws, busy.id) ? 'This is already on its way to CallHub' : 'The last send stopped part-way — Carry on finishes it');
  if (!numbers.length) throw httpError(409, 'No one here to send: no numbers left to call');
  // The phonebook's name in CallHub: the list's, and when it was sent
  // (campaign time), so the right one is easy to pick there.
  const stamp = (await tx.query(`select to_char(${toLocal('now()', '$1::text')}, 'Mon FMDD, FMHH12:MI am') as s`, [timeZone()])).rows[0].s;
  let name = `${String(src.name).slice(0, 110)} — ${stamp}`;
  const same = (await tx.query(
    `select count(*)::int as n from callhub_pushes where workspace_id = $1 and (name = $2 or left(name, length($2) + 2) = $2 || ' (')`, [ws, name],
  )).rows[0].n;
  if (same) name = `${name} (${same + 1})`;
  // How the last push's results were read is how this one starts.
  const prev = (await tx.query('select outcomes, rating_map from callhub_pushes where workspace_id = $1 order by created_at desc limit 1', [ws])).rows[0];
  const asJson = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const id = newId();
  const row = (await tx.query(
    `insert into callhub_pushes (id, workspace_id, source_kind, source_id, name, total, skipped, outcomes, rating_map, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), $9::jsonb, $10) returning *`,
    [id, ws, src.kind, src.id, name, numbers.length, leftOut, asJson(prev?.outcomes), asJson(prev?.rating_map), ctx.user.id],
  )).rows[0];
  const rows = numbers.flatMap((n, i) => n.people.map((p, k) => [p.id, n.phone, k === 0, i]));
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const part = rows.slice(i, i + INSERT_BATCH);
    const col = (k) => part.map((r) => r[k]);
    await tx.query(
      `insert into callhub_contacts (push_id, workspace_id, person_id, phone, first_on_number, position)
       select $1, $2, x.person_id, x.phone, x.first_on_number, x.position
         from unnest($3::uuid[], $4::text[], $5::boolean[], $6::int[]) as x(person_id, phone, first_on_number, position)`,
      [id, ws, col(0), col(1), col(2), col(3)],
    );
  }
  await enqueueJob(tx, { workspaceId: ws, kind: PUSH_JOB, payload: { push_id: id } });
  emit('callhub_push', id, 'create', { source_kind: src.kind, source_id: src.id, name, total: numbers.length, skipped: leftOut });
  return { push: pushOut(row) };
};

// "Carry on": a push that stopped (or whose job is gone) starts again where
// it was.
export const resumePush = async (tx, ctx, emit, id) => {
  const ws = ctx.workspaceId;
  const p = (await tx.query('select * from callhub_pushes where id = $1 and workspace_id = $2 for update', [id, ws])).rows[0];
  if (!p) throw httpError(404, 'not found');
  if (p.status === 'sent' || (p.status !== 'failed' && await jobLive(tx, ws, id))) throw httpError(409, 'Nothing to carry on');
  if (!callhubOn()) throw httpError(409, 'CallHub isn’t connected');
  const row = (await tx.query(
    `update callhub_pushes set status = 'queued', note = null, resume_at = null where id = $1 and workspace_id = $2 returning *`, [id, ws],
  )).rows[0];
  // carry: someone looked at why it stopped and said go on (dnc.js is lenient then).
  await enqueueJob(tx, { workspaceId: ws, kind: PUSH_JOB, payload: { push_id: id, carry: true } });
  emit('callhub_push', id, 'update', { status: 'queued' });
  return { push: pushOut(row) };
};
// Whether a job is still going to work on this push.
export const jobLive = async (q, ws, id) => (await q.query(
  `select 1 from jobs where workspace_id = $1 and kind = $2 and status in ('pending', 'running') and payload @> $3::jsonb limit 1`,
  [ws, PUSH_JOB, JSON.stringify({ push_id: id })],
)).rows.length > 0;

// ── The job ──
// CallHub's own words are quoted as its; ours (no answer, no key) stand alone.
const said = (e) => (e?.theirs ? `CallHub said “${String(e.message).slice(0, 300)}”` : String(e?.message || e).slice(0, 300));
const untilWords = (e) => `CallHub asked us to wait: “${String(e.message).slice(0, 300)}”`;
const plural = (n, one) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : `${one}s`}`;

export const runPushJob = async (db, job) => {
  const ws = job.workspace_id;
  const id = job.payload?.push_id;
  const load = async () => (await db.query('select * from callhub_pushes where id = $1 and workspace_id = $2', [id, ws])).rows[0];
  let push = await load();
  // Sent, or stopped (only Carry on starts it again): nothing to do.
  if (!push || push.status === 'sent' || push.status === 'failed') return;
  const act = (fn) => runAction(db, { workspaceId: ws, actorId: push.created_by || null, action: PUSH_ACTION }, fn);
  const set = (fields, payload) => act(async (tx, emit) => {
    const keys = Object.keys(fields);
    await tx.query(
      `update callhub_pushes set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where id = $1 and workspace_id = $2`,
      [id, ws, ...keys.map((k) => fields[k])],
    );
    if (payload) emit('callhub_push', id, 'update', payload);
  });
  // The next run: now, or when CallHub will take more.
  const carry = Boolean(job.payload?.carry);
  const again = (at = null) => act(async (tx) => {
    await enqueueJob(tx, { workspaceId: ws, kind: PUSH_JOB, payload: { push_id: id, ...(carry ? { carry } : {}) }, ...(at ? { runAt: at.toISOString() } : {}) });
  });
  const waitUntil = async (at, note) => {
    await set({ note, resume_at: at.toISOString() }, { waiting_until: at.toISOString() });
    await again(at);
  };
  // A number that is not going after all (marked do-not-call since the
  // tap): never sent, so a result can never land there.
  const leaveOut = (phone, people) => act(async (tx) => {
    await tx.query('delete from callhub_contacts where push_id = $1 and phone = $2', [id, phone]);
    await tx.query('update callhub_pushes set total = total - 1, skipped = skipped + $3 where id = $1 and workspace_id = $2', [id, ws, people]);
  });
  // A number CallHub won't take: not sent either, but whose it was is kept
  // (with CallHub's words) and named on the log — never the number — so the
  // desk can find it and fix it.
  const refuse = (phone, personId, words) => act(async (tx, emit) => {
    await tx.query('update callhub_contacts set refused = $3 where push_id = $1 and phone = $2 and sent_at is null', [id, phone, words]);
    await tx.query('update callhub_pushes set total = total - 1, refused = refused + 1, refused_note = $3 where id = $1 and workspace_id = $2', [id, ws, words]);
    emit('callhub_contact', personId, 'update', { push_id: id, refused: true });
  });
  const dncTally = newTally();

  try {
    if (!callhubOn()) throw new CallHubError('CALLHUB_API_KEY isn’t set on this server', { status: 400 });
    if (push.status !== 'sending' || push.note || push.resume_at) {
      await set({ status: 'sending', note: null, resume_at: null }, push.status === 'sending' ? null : { status: 'sending' });
    }
    // The first run of a push asks CallHub once more about what it refused before.
    const fresh = !push.phonebook_id;
    if (fresh) {
      const made = await callhub('POST', '/phonebooks/', {
        body: { name: push.name, description: 'Sent from base.win' }, idempotencyKey: `base-callhub-book-${id}`,
      });
      const book = idOf(made);
      if (!book) throw new CallHubError('CallHub made the phonebook but didn’t say which one', { status: 400 });
      await set({ phonebook_id: book });
      push = await load();
    }
    let left = PER_RUN;

    // People not to call, first: once each, by kind (callhub_dnc remembers),
    // and whoever is no longer blocked comes off. While that goes the push
    // says so, instead of "0 of N" with no words.
    const blocked = await notToCall(db, ws);
    let said = false;
    const book = async (toGo) => {
      await set({ note: `Telling CallHub who not to call first · ${toGo.toLocaleString('en-CA')} to go` });
      said = true;
      if (push.dnc_list) return push.dnc_list;
      const list = await dncListOf();
      if (!list) throw new CallHubError('CallHub’s do-not-call list couldn’t be found or made', { status: 400 });
      await set({ dnc_list: list });
      return list;
    };
    const dncLeft = await syncDnc(db, ws, { blocked, again: fresh, lenient: carry, budget: left, act, tally: dncTally, book });
    left -= dncDid(dncTally);
    if (dncLeft) { await again(); runJobsSoon(); return; }
    if (said) await set({ note: null });

    // Then the contacts, where the last run stopped. A number is one
    // contact, whoever on the list shares it.
    let today = (await db.query(
      `select count(*)::int as n from (select distinct push_id, phone from callhub_contacts where sent_at > now() - interval '24 hours') x`,
    )).rows[0].n;
    let went = Number(push.sent);
    let refusedInARow = 0;
    while (left > 0) {
      const next = (await db.query(
        `select phone from callhub_contacts where push_id = $1 and sent_at is null and refused is null group by phone order by min(position) limit $2`, [id, left],
      )).rows.map((r) => r.phone);
      if (!next.length) break;
      // Everyone on those numbers, as they are now: someone marked
      // do-not-call (or taken off the file) since the tap doesn't go.
      const people = (await db.query(
        `select c.person_id, c.phone, c.first_on_number, p.kind, p.name, p.first_name, p.last_name, p.city, p.tags, p.deleted_at
           from callhub_contacts c join persons p on p.id = c.person_id
          where c.push_id = $1 and c.phone = any($2::text[]) order by c.position, c.first_on_number desc, ${azKey('p')}`, [id, next],
      )).rows;
      for (const phone of next) {
        if (left <= 0) break;
        const here = people.filter((p) => p.phone === phone);
        const live = here.filter((p) => !p.deleted_at);
        if (!live.length || live.some(notToBeCalled) || noCalls(blocked, phone)) {
          await leaveOut(phone, here.length);
          continue;
        }
        if (today >= dailyLimit) {
          const free = (await db.query(
            `select min(sent_at) + interval '24 hours 1 minute' as at from callhub_contacts where sent_at > now() - interval '24 hours'`,
          )).rows[0].at;
          await waitUntil(free ? new Date(free) : new Date(Date.now() + 3_600_000),
            `CallHub takes ${dailyLimit.toLocaleString('en-CA')} contacts a day. The rest carry on by themselves.`);
          return;
        }
        const first = live[0];
        try {
          await callhub('POST', `/phonebooks/${encodeURIComponent(push.phonebook_id)}/upsert_contact/`, {
            body: contactBody(phone, first), idempotencyKey: `base-callhub-${id}-${phone}`,
          });
        } catch (e) {
          // A plain refusal (400) is about this one number: it is left out
          // and counted, with CallHub's words. Several in a row is the push.
          if (!(e instanceof CallHubError && e.httpStatus === 400 && !e.throttled)) throw e;
          refusedInARow += 1;
          if (refusedInARow >= (went ? REFUSALS_IN_A_ROW : REFUSALS_AT_THE_START)) {
            throw new CallHubError(`CallHub wouldn’t take ${plural(refusedInARow, 'number')} in a row. It said “${String(e.message).slice(0, 240)}”`, { status: 400 });
          }
          await refuse(phone, first.person_id, String(e.message).slice(0, 300));
          left -= 1;
          await pause();
          continue;
        }
        refusedInARow = 0;
        await act(async (tx, emit) => {
          // Everyone on the number is marked sent; the one whose name went
          // is the one results are filed on. Counted once, whatever ran twice.
          const r = await tx.query(
            'update callhub_contacts set first_on_number = (person_id = $3), sent_at = now() where push_id = $1 and phone = $2 and sent_at is null', [id, phone, first.person_id],
          );
          if (!(r.affectedRows ?? r.rowCount ?? 0)) return;
          await tx.query('update callhub_pushes set sent = sent + 1 where id = $1 and workspace_id = $2', [id, ws]);
          emit('callhub_contact', first.person_id, 'create', { push_id: id });
        });
        went += 1;
        today += 1;
        left -= 1;
        await pause();
      }
    }
    const more = (await db.query('select 1 from callhub_contacts where push_id = $1 and sent_at is null and refused is null limit 1', [id])).rows.length > 0;
    if (more) { await again(); runJobsSoon(); return; }
    const done = await load();
    await set({ status: 'sent', sent_at: new Date().toISOString(), note: null, resume_at: null },
      { status: 'sent', sent: done.sent, total: done.total, ...(done.refused ? { refused: done.refused } : {}) });
  } catch (e) {
    if (e instanceof CallHubError && e.throttled) {
      // CallHub says when it will take the next one; a minute when it doesn't.
      const seconds = Math.min(Math.max(Number(e.retryAfter) || 60, 5), 26 * 3600);
      await waitUntil(new Date(Date.now() + seconds * 1000), untilWords(e));
      return;
    }
    // No answer at all (or CallHub's own fault): tried again by the job
    // runner, with its backoff, before anyone is asked to.
    const noAnswer = e instanceof CallHubError && (e.httpStatus === 0 || e.httpStatus >= 500);
    if (noAnswer && job.attempts < TRIES) {
      await set({ note: `${said(e)} — trying again shortly` });
      throw e;
    }
    await set({ status: 'failed', note: e instanceof CallHubError ? said(e) : 'Something went wrong on our side', resume_at: null },
      { status: 'failed', note: e instanceof CallHubError ? String(e.message).slice(0, 300) : 'error' });
    if (!(e instanceof CallHubError)) console.error('callhub: push stopped:', e);
  } finally {
    // On the log: how many do-not-call numbers CallHub was told, never which.
    if (dncDid(dncTally)) await dncOnLog(act, ws, dncTally).catch(() => {});
  }
};
