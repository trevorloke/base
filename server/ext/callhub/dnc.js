// The campaign's own do-not-call list, kept at CallHub too: the numbers of
// people tagged do-not-contact or do-not-call, and numbers that replied STOP
// to a text, go to a CallHub do-not-call list named "base.win" — so a number
// already in a CallHub phonebook is not dialled there either.
//
//   with each push        the push's job tells CallHub first (push.js)
//   someone newly marked  an events hook queues the callhub.dnc job, so it
//   — or no longer —      does not wait for the next push — once this
//                         campaign has sent CallHub anything
//
// What CallHub was told is remembered (callhub_dnc), so no number is sent
// twice; a number that must now get less (calls as well as texts) has its
// entry at CallHub changed to both. The list follows base.win the other way
// too: a number nobody here blocks any more (the tag taken off again, a
// result's "do not call" put back) comes off CallHub's list, by the entry
// CallHub named for it. A number CallHub won't take is remembered with its
// words and asked about again with the next push — it never stops the rest.
// Only when CallHub takes none of a campaign's numbers at all (five refused
// in a row before any was ever taken) does a push stop, once, with
// CallHub's words; Carry on goes on without them. Numbers only ever leave
// here: never a name.
import { runAction } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { e164, NO_CALL_TAG, NO_CONTACT_TAG } from '../texting/rules.js';
import { apiBase, callhub, callhubOn, CallHubError, idOf, listAll, pause } from './callhub.js';
import { notToCall, notToCallAmong } from './people.js';
import { forgetHolders } from './results.js';

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

const REFUSALS_IN_A_ROW = 5;
// What a run did: numbers told, numbers CallHub would not take, numbers
// taken off again, numbers CallHub would not let go.
export const newTally = () => ({ told: 0, refused: 0, freed: 0, kept: 0 });
export const dncDid = (t) => t.told + t.refused + t.freed + t.kept;
const did = dncDid;
const told = async (db, ws) => new Map((await db.query(
  'select phone, category, entry, refused, extract(epoch from sent_at)::float8 as asked from callhub_dnc where workspace_id = $1', [ws],
)).rows.map((r) => [r.phone, r]));
// A refusal that is about the one number (or entry), not a throttle and not the key.
const plainNo = (e) => e instanceof CallHubError && !e.throttled && e.httpStatus >= 400 && e.httpStatus < 500 && ![401, 403, 429].includes(e.httpStatus);
// What a remembered refusal was about: CallHub asked to hold a number for
// more than it does (calls as well as texts) — or, when not, to let go.
export const askedMore = (row) => row.refused != null && (Number(row.refused) | Number(row.category)) !== Number(row.category);

// The numbers CallHub has not been told, or not everything about:
// [[number, what it must not get — 1 calls, 2 texts, 3 both —, CallHub's
// entry for it when it has one already, and whether CallHub refused it
// before]]. What CallHub refused is left out until `again` (the next push
// asks once more).
export const untoldOf = async (db, ws, blocked = null, { again = false } = {}) => {
  const all = blocked || await notToCall(db, ws);
  const had = await told(db, ws);
  const out = [];
  for (const [phone, category] of all) {
    const row = had.get(phone);
    const has = Number(row?.category) || 0;
    const want = has | category;
    if (want === has) continue;
    if (!again && row?.refused != null && (Number(row.refused) | want) === Number(row.refused)) continue;
    out.push([phone, want, row?.entry || null, row?.refused != null, Number(row?.asked) || 0]);
  }
  // Never asked first; then what CallHub refused before, longest ago first —
  // so asking a few of them again each push gets round to every one.
  return out.sort((x, y) => Number(x[3]) - Number(y[3]) || x[4] - y[4]);
};

// The numbers CallHub holds for more than base.win blocks now: [[number,
// what it should still not get (0: nothing — it comes off), CallHub's
// entry]]. Only an entry CallHub named can be changed; one it would not
// change is left until `again`.
export const overToldOf = async (db, ws, blocked = null, { again = false } = {}) => {
  const all = blocked || await notToCall(db, ws);
  const out = [];
  for (const [phone, row] of await told(db, ws)) {
    const has = Number(row.category) || 0;
    const keep = all.get(phone) || 0;
    if (!has || !row.entry || (has | keep) !== has || has === keep) continue;
    if (!again && row.refused != null && Number(row.refused) === keep) continue;
    out.push([phone, keep, row.entry]);
  }
  return out;
};
// The numbers CallHub still holds that nobody here blocks any more and that
// base.win cannot take off itself: one CallHub never named, or would not
// let go (Check says how many, a list's page whose). One the job is about
// to take off is not among them. Asked often (a list's page reads it), so
// who is blocked is worked out for the few numbers that may be held —
// never by a pass over everyone on file.
export const heldNumbers = async (db, ws) => {
  const rows = (await db.query(
    'select phone, category, entry, refused from callhub_dnc where workspace_id = $1 and category > 0 and (entry is null or refused is not null)', [ws],
  )).rows.filter((r) => !r.entry || !askedMore(r));
  if (!rows.length) return [];
  const blocked = await notToCallAmong(db, ws, rows.map((r) => r.phone));
  return rows.filter((r) => Number(r.category) & ~(blocked.get(r.phone) || 0)).map((r) => r.phone);
};

// Tell CallHub, one a second, `budget` at most; each is remembered as it
// goes, and counted on `tally` (so a caller stopped part-way still knows how
// many went). `act` is the caller's write (the push's sender, or the
// system). A number CallHub won't take is remembered with its words, and
// the rest go on. Five refused in a row is looked at:
//   · all of them refused before (a push asking again): still refused —
//     the rest of those are left as they are
//   · CallHub has taken this campaign's numbers before (`everTaken`): they
//     are the numbers' own, remembered like any other
//   · it never has: it is not the numbers. The push stops with CallHub's
//     words and nothing is written off; carried on (`lenient`), they and
//     the rest are left as not taken, unasked, and the push goes on
// A throttle, or anything else, is the caller's to handle.
// → how many it left unasked.
export const tellCallHub = async (ws, { list, untold, budget, act, tally, everTaken = true, lenient = false }) => {
  const streak = [];
  let taken = everTaken;
  let stillRefused = false;
  let unasked = 0;
  const NOT_TAKEN = `insert into callhub_dnc (workspace_id, phone, category, refused, refused_note)
    select $1, x.phone, 0, x.category, $4 from unnest($2::text[], $3::int[]) as x(phone, category)
    on conflict (workspace_id, phone) do update set refused = excluded.refused, refused_note = excluded.refused_note, sent_at = now()`;
  const notTaken = (rows, words) => act((tx) => tx.query(NOT_TAKEN, [ws, rows.map((r) => r[0]), rows.map((r) => r[1]), words]));
  const writeOff = async () => {
    const rows = streak.splice(0);
    if (!rows.length) return;
    await notTaken(rows, rows.at(-1)[2]);
    tally.refused += rows.length;
  };
  for (const [i, [phone, category, had, before]] of untold.entries()) {
    if (before && stillRefused) { unasked += 1; continue; }
    if (did(tally) + streak.length >= budget) break;
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
        const there = e instanceof CallHubError && e.httpStatus === 400 && /already|exist|unique|duplicate/i.test(e.message);
        if (!there && !(plainNo(e) && e.httpStatus === 400)) throw e;
        if (!there) {
          const words = String(e.message).slice(0, 300);
          streak.push([phone, category, words, before]);
          if (streak.length >= REFUSALS_IN_A_ROW) {
            if (streak.every((r) => r[3])) {
              // Asked again, refused again: remembered already (when is noted, so others get their turn next time).
              const again = streak.splice(0);
              await act((tx) => tx.query('update callhub_dnc set sent_at = now() where workspace_id = $1 and phone = any($2::text[])', [ws, again.map((r) => r[0])]));
              tally.refused += again.length;
              stillRefused = true;
            } else if (taken) {
              await writeOff();
            } else if (lenient) {
              const rest = untold.slice(i + 1);
              await writeOff();
              if (rest.length) await notTaken(rest, words);
              return unasked + rest.length;
            } else {
              throw new CallHubError(`CallHub wouldn’t take ${streak.length} do-not-call numbers in a row. It said “${words.slice(0, 240)}”`, { status: 400 });
            }
          }
          await pause();
          continue;
        }
      }
    }
    await writeOff();
    await act(async (tx) => {
      await tx.query(
        `insert into callhub_dnc (workspace_id, phone, category, entry) values ($1, $2, $3, $4)
         on conflict (workspace_id, phone) do update set category = excluded.category, entry = coalesce(excluded.entry, callhub_dnc.entry),
           refused = null, refused_note = null, sent_at = now()`,
        [ws, phone, category, entry],
      );
    });
    taken = true;
    tally.told += 1;
    await pause();
  }
  await writeOff();
  return unasked;
};

// Take off CallHub's list (or lower: both → texts only) what base.win no
// longer blocks, by CallHub's own entry. Gone there already is what we
// wanted; an entry CallHub won't change is remembered and left (Check
// counts it) — it never stops the push. Several refused in a row is CallHub
// not letting numbers go at all: the rest are left as they are, unasked.
export const freeAtCallHub = async (ws, { list, over, budget, act, tally }) => {
  let inARow = 0;
  for (const [i, [phone, keep, entry]] of over.entries()) {
    if (did(tally) >= budget) break;
    const at = `/dnc_contacts/${encodeURIComponent(entry)}/`;
    const idempotencyKey = `base-callhub-dnc-${ws}-${phone}-${keep}`;
    let gone = !keep;
    let no = null;
    try {
      if (keep) await callhub('PUT', at, { body: { dnc: list, phone_number: phone, category: keep }, idempotencyKey });
      else await callhub('DELETE', at, { idempotencyKey });
    } catch (e) {
      if (!plainNo(e)) throw e;
      if (e.httpStatus === 404) gone = true; else no = String(e.message).slice(0, 300);
    }
    await act(async (tx) => {
      if (no) await tx.query('update callhub_dnc set refused = $3, refused_note = $4 where workspace_id = $1 and phone = $2', [ws, phone, keep, no]);
      else if (gone) await tx.query('delete from callhub_dnc where workspace_id = $1 and phone = $2', [ws, phone]);
      else await tx.query('update callhub_dnc set category = $3, refused = null, refused_note = null, sent_at = now() where workspace_id = $1 and phone = $2', [ws, phone, keep]);
    });
    if (no) { tally.kept += 1; inARow += 1; } else { tally.freed += 1; inARow = 0; }
    if (inARow >= REFUSALS_IN_A_ROW) {
      const rest = over.slice(i + 1);
      await act(async (tx) => {
        for (const k of new Set(rest.map((r) => r[1]))) {
          await tx.query(
            'update callhub_dnc set refused = $3, refused_note = $4 where workspace_id = $1 and phone = any($2::text[])',
            [ws, rest.filter((r) => r[1] === k).map((r) => r[0]), k, no],
          );
        }
      });
      tally.kept += rest.length;
      break;
    }
    await pause();
  }
};

// One run of both, for the push's job and the newly-marked job. `book`
// finds (or makes) CallHub's list once it is needed; `lenient`: a push that
// was carried on (tellCallHub). → how many are left.
export const syncDnc = async (db, ws, { blocked = null, again = false, lenient = false, budget, act, tally, book }) => {
  const all = blocked || await notToCall(db, ws);
  // What CallHub would not take, for a number nobody blocks any more:
  // forgotten. So is a refusal nobody needs lifted now — the tag came off
  // again before CallHub took the change, or went back on before it let go.
  const stale = [];
  const moot = [];
  for (const [phone, row] of await told(db, ws)) {
    const has = Number(row.category) || 0;
    const want = all.get(phone) || 0;
    if (!has) { if (!want) stale.push(phone); continue; }
    if (row.refused != null && (askedMore(row) ? (want | has) === has : (has & ~want) === 0)) moot.push(phone);
  }
  if (stale.length) await act((tx) => tx.query('delete from callhub_dnc where workspace_id = $1 and category = 0 and phone = any($2::text[])', [ws, stale]));
  if (moot.length) await act((tx) => tx.query('update callhub_dnc set refused = null, refused_note = null where workspace_id = $1 and phone = any($2::text[])', [ws, moot]));
  const untold = await untoldOf(db, ws, all, { again });
  const over = await overToldOf(db, ws, all, { again });
  if (!untold.length && !over.length) return 0;
  const list = untold.length || over.some(([, keep]) => keep) ? await book(untold.length + over.length) : null;
  const everTaken = (await db.query('select 1 from callhub_dnc where workspace_id = $1 and category > 0 limit 1', [ws])).rows.length > 0;
  const unasked = await tellCallHub(ws, { list, untold, budget, act, tally, everTaken, lenient });
  await freeAtCallHub(ws, { list, over, budget, act, tally });
  return Math.max(0, untold.length + over.length - did(tally) - unasked);
};

// One line on the log for a run: how many, never which.
export const dncOnLog = (act, ws, t) => act(async (tx, emit) => {
  emit('callhub', ws, 'update', {
    ...(t.told ? { do_not_call_told: t.told } : {}), ...(t.refused ? { do_not_call_not_taken: t.refused } : {}),
    ...(t.freed ? { do_not_call_freed: t.freed } : {}), ...(t.kept ? { do_not_call_not_freed: t.kept } : {}),
  });
});

// ── Someone newly marked, or no longer ──
const tagEdit = (e) => e.entityType === 'person' && (e.op === 'create' || e.op === 'update') && Array.isArray(e.payload?.tags);
const marks = (e) => e.payload.tags.some((t) => t === NO_CALL_TAG || t === NO_CONTACT_TAG);

// Events hook (lib/hooks.js): a write that tags someone do-not-call or
// do-not-contact — or changes the tags of someone whose number CallHub was
// told — queues the job below. Only where CallHub is on and this campaign
// has sent it a phonebook, and only one job at a time. And whoever a write
// leaves without the do-not-call tag: no call's result holds that tag for
// them any more (results.js), so a tag the desk took off by hand is never
// brought back, or taken for a result's, by a later change to a push's
// table. (A record made from two settled its calls' holds before anything
// moved: results.js onMerging.) A fault here never costs the write itself
// (a savepoint, skipped as a whole).
export const onEvents = async (tx, meta, events) => {
  const edits = events.filter(tagEdit);
  const off = edits.filter((e) => e.op === 'update' && !e.payload.tags.includes(NO_CALL_TAG)).map((e) => e.entityId);
  if (!edits.length || (!off.length && !callhubOn())) return;
  await tx.query('savepoint callhub_dnc_hook');
  try {
    const ws = meta.workspaceId;
    if (off.length) await forgetHolders(tx, ws, off);
    const sent = callhubOn() && (await tx.query('select 1 from callhub_pushes where workspace_id = $1 and phonebook_id is not null limit 1', [ws])).rows[0];
    let wanted = Boolean(sent) && edits.some(marks);
    if (sent && !wanted) {
      // Nobody newly marked: is one of their numbers on file for CallHub's list (a tag taken off)?
      const phones = (await tx.query(
        'select phone from persons where workspace_id = $1 and id = any($2::uuid[])', [ws, edits.map((e) => e.entityId)],
      )).rows.map((r) => e164(r.phone)).filter(Boolean);
      wanted = phones.length > 0 && (await tx.query(
        'select 1 from callhub_dnc where workspace_id = $1 and phone = any($2::text[]) limit 1', [ws, phones],
      )).rows.length > 0;
    }
    const queued = wanted && (await tx.query(`select 1 from jobs where workspace_id = $1 and kind = $2 and status = 'pending' limit 1`, [ws, DNC_JOB])).rows[0];
    if (wanted && !queued) await enqueueJob(tx, { workspaceId: ws, kind: DNC_JOB });
    await tx.query('release savepoint callhub_dnc_hook');
  } catch (err) {
    await tx.query('rollback to savepoint callhub_dnc_hook');
    await tx.query('release savepoint callhub_dnc_hook');
    console.error('callhub: a change of tags was not followed —', err.message);
  }
};

// The job: what CallHub has not been told yet and what it should let go,
// fifty to a run, as the system. A throttle waits as long as CallHub says;
// anything else is the job runner's to try again (and the next push sends
// them in any case).
export const runDncJob = async (db, job) => {
  const ws = job.workspace_id;
  if (!callhubOn()) return;
  const act = (fn) => runAction(db, { workspaceId: ws, actorId: null, action: DNC_ACTION }, fn);
  const again = (at = null) => act((tx) => enqueueJob(tx, { workspaceId: ws, kind: DNC_JOB, ...(at ? { runAt: at.toISOString() } : {}) }));
  const tally = newTally();
  try {
    const book = async () => {
      const list = await dncListOf();
      if (!list) throw new CallHubError('CallHub’s do-not-call list couldn’t be found or made', { status: 400 });
      return list;
    };
    // Nobody is watching a job: what CallHub won't take is left as not taken and said on the page — it never fails over it.
    let left = await syncDnc(db, ws, { lenient: true, budget: PER_RUN, act, tally, book });
    // Someone's tag may have changed while this ran: one more look.
    if (!left && did(tally)) left = (await untoldOf(db, ws)).length + (await overToldOf(db, ws)).length;
    if (left) { await again(); runJobsSoon(); }
  } catch (e) {
    if (!(e instanceof CallHubError && e.throttled)) throw e;
    const seconds = Math.min(Math.max(Number(e.retryAfter) || 60, 5), 26 * 3600);
    await again(new Date(Date.now() + seconds * 1000));
  } finally {
    // On the log: how many, never which.
    if (did(tally)) await dncOnLog(act, ws, tally);
  }
};
