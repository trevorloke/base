// The campaign's own do-not-call list, kept at CallHub too: the numbers of
// people tagged do-not-contact or do-not-call, and numbers that replied STOP
// to a text, go to a CallHub do-not-call list named "base.win" — so a number
// already in a CallHub phonebook is not dialled there either.
//
//   with each push        the push's job tells CallHub first (push.js)
//   someone newly marked  an events hook queues the callhub.dnc job, so it
//                         does not wait for the next push — once this
//                         campaign has sent CallHub anything
//
// What CallHub was told is remembered (callhub_dnc), so no number is sent
// twice; a number that must now get less (calls as well as texts) has its
// entry at CallHub changed to both. Numbers only ever leave here: never a
// name.
import { runAction } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { NO_CALL_TAG, NO_CONTACT_TAG } from '../texting/rules.js';
import { apiBase, callhub, callhubOn, CallHubError, idOf, listAll, pause } from './callhub.js';
import { notToCall } from './people.js';

export const DNC_LIST = 'base.win';
export const DNC_JOB = 'callhub.dnc';
export const DNC_ACTION = 'callhub.dnc';
const PER_RUN = 50;

// CallHub's do-not-call list named base.win: found, or made once. → its
// address (how a do-not-call number says which list it is on), or null.
export const dncListOf = async () => {
  const lists = await listAll('/dnc_lists/');
  const found = lists.find((l) => String(l?.name || '').trim() === DNC_LIST)
    || await callhub('POST', '/dnc_lists/', { body: { name: DNC_LIST }, idempotencyKey: 'base-callhub-dnc-list' });
  return found?.url || (idOf(found) ? `${apiBase()}/v1/dnc_lists/${idOf(found)}/` : null);
};

// The numbers CallHub has not been told, or not everything about:
// [[number, what it must not get — 1 calls, 2 texts, 3 both — and CallHub's
// entry for it, when it has one already]].
export const untoldOf = async (db, ws, blocked = null) => {
  const all = blocked || await notToCall(db, ws);
  const told = new Map((await db.query('select phone, category, entry from callhub_dnc where workspace_id = $1', [ws])).rows.map((r) => [r.phone, r]));
  const out = [];
  for (const [phone, category] of all) {
    const had = Number(told.get(phone)?.category) || 0;
    if ((had | category) !== had) out.push([phone, had | category, told.get(phone)?.entry || null]);
  }
  return out;
};

// Tell CallHub, one a second, `budget` at most; each is remembered as it
// goes, and counted on `tally.told` (so a caller stopped part-way still
// knows how many went). `act` is the caller's write (the push's sender, or
// the system). A throttle or a refusal is the caller's to handle.
export const tellCallHub = async (ws, { list, untold, budget, act, tally }) => {
  for (const [phone, category, had] of untold) {
    if (tally.told >= budget) break;
    const body = { dnc: list, phone_number: phone, category };
    const idempotencyKey = `base-callhub-dnc-${ws}-${phone}-${category}`;
    let entry = had || null;
    let changed = false;
    // A number CallHub already has for less (texts only, now calls too):
    // its own entry is changed. Where CallHub never said which entry it
    // was, or won't change it, a new one is made as for any other number.
    if (entry) {
      try {
        await callhub('PUT', `/dnc_contacts/${encodeURIComponent(entry)}/`, { body, idempotencyKey });
        changed = true;
      } catch (e) {
        if (!(e instanceof CallHubError) || e.throttled || e.httpStatus === 0 || e.httpStatus >= 500) throw e;
      }
    }
    if (!changed) {
      try {
        entry = idOf(await callhub('POST', '/dnc_contacts/', { body, idempotencyKey })) || entry;
      } catch (e) {
        // Already on CallHub's list: what we wanted.
        if (!(e instanceof CallHubError && e.httpStatus === 400 && /already|exist|unique|duplicate/i.test(e.message))) throw e;
      }
    }
    await act(async (tx) => {
      await tx.query(
        `insert into callhub_dnc (workspace_id, phone, category, entry) values ($1, $2, $3, $4)
         on conflict (workspace_id, phone) do update set category = excluded.category, entry = coalesce(excluded.entry, callhub_dnc.entry), sent_at = now()`,
        [ws, phone, category, entry],
      );
    });
    tally.told += 1;
    await pause();
  }
};

// One line on the log for the numbers told in a run: how many, never which.
export const toldOnLog = (act, ws, told) => act(async (tx, emit) => { emit('callhub', ws, 'update', { do_not_call_told: told }); });

// ── Someone newly marked ──
const marks = (e) => e.entityType === 'person' && (e.op === 'create' || e.op === 'update')
  && Array.isArray(e.payload?.tags) && e.payload.tags.some((t) => t === NO_CALL_TAG || t === NO_CONTACT_TAG);

// Events hook (lib/hooks.js): a write that tags someone do-not-call or
// do-not-contact queues the job below — only where CallHub is on and this
// campaign has sent it a phonebook, and only one job at a time. A fault here
// never costs the write itself (a savepoint, skipped as a whole).
export const onEvents = async (tx, meta, events) => {
  if (!callhubOn() || !events.some(marks)) return;
  await tx.query('savepoint callhub_dnc_hook');
  try {
    const ws = meta.workspaceId;
    const sent = (await tx.query('select 1 from callhub_pushes where workspace_id = $1 and phonebook_id is not null limit 1', [ws])).rows[0];
    const queued = sent && (await tx.query(`select 1 from jobs where workspace_id = $1 and kind = $2 and status = 'pending' limit 1`, [ws, DNC_JOB])).rows[0];
    if (sent && !queued) await enqueueJob(tx, { workspaceId: ws, kind: DNC_JOB });
    await tx.query('release savepoint callhub_dnc_hook');
  } catch (err) {
    await tx.query('rollback to savepoint callhub_dnc_hook');
    await tx.query('release savepoint callhub_dnc_hook');
    console.error('callhub: do-not-call numbers not queued —', err.message);
  }
};

// The job: what CallHub has not been told yet, fifty to a run, as the
// system. A throttle waits as long as CallHub says; anything else is the
// job runner's to try again (and the next push sends them in any case).
export const runDncJob = async (db, job) => {
  const ws = job.workspace_id;
  if (!callhubOn()) return;
  const act = (fn) => runAction(db, { workspaceId: ws, actorId: null, action: DNC_ACTION }, fn);
  const again = (at = null) => act((tx) => enqueueJob(tx, { workspaceId: ws, kind: DNC_JOB, ...(at ? { runAt: at.toISOString() } : {}) }));
  const untold = await untoldOf(db, ws);
  if (!untold.length) return;
  const tally = { told: 0 };
  try {
    const list = await dncListOf();
    if (!list) throw new CallHubError('CallHub’s do-not-call list couldn’t be found or made', { status: 400 });
    await tellCallHub(ws, { list, untold, budget: PER_RUN, act, tally });
    if (untold.length > tally.told) { await again(); runJobsSoon(); }
  } catch (e) {
    if (!(e instanceof CallHubError && e.throttled)) throw e;
    const seconds = Math.min(Math.max(Number(e.retryAfter) || 60, 5), 26 * 3600);
    await again(new Date(Date.now() + seconds * 1000));
  } finally {
    // On the log: how many, never which.
    if (tally.told) await toldOnLog(act, ws, tally.told);
  }
};
