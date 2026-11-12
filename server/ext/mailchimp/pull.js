// Mailchimp → base.win: who left there, and whose address died there.
//
//   unsubscribed  → email is off here for everyone with that address
//                   (emailOff: off the newsletter list, or do-not-email, and
//                   a no on the consent record, source mailchimp-unsubscribe)
//                   — unless they have said yes HERE THEMSELVES since they
//                   left there (the website's box, their own link): a newer
//                   yes of their own is never undone by an older no.
//   cleaned       → the address goes on the suppression list (ext/mail): it
//                   bounced for good at Mailchimp; nothing emails it again.
// Only addresses this campaign holds are touched: nothing is kept about a
// stranger. Each change is on the event log as the system (mailchimp.pull),
// and none of them is told back to Mailchimp (optout.js skips this action).
//
// Three ways in, one rule — base.win reads the member itself and acts on
// that answer, never on a webhook's word:
//   the member job   a webhook was a hint about one address (webhook.js)
//   the daily job    everything changed since the last pull, less an hour;
//                    once a week, and the first time, everyone unsubscribed
//                    or cleaned — someone added here after they left there
//                    is found then
//   Pull now, and the start of every sync: everyone, now
// The first pull from an audience waits for a person's yes (firstOf,
// below): it turns off here everyone on file who ever left there, and
// nobody here can turn that back. Until someone says yes a pull only counts
// those — and still takes in a no newer than the audience's first count.
import { httpError } from '../../actions/util.js';
import { runAction } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { stillOn, suppress } from '../mail/webhook.js';
import { emailOff } from '../site/consent.js';
import { audienceId, knownAudience, lower, mailchimp, mailchimpOn, MailchimpError, memberHash, pages } from './mailchimp.js';

export const PULL_ACTION = 'mailchimp.pull';
export const PULL_JOB = 'mailchimp.pull';
export const MEMBER_JOB = 'mailchimp.member';
export const OPTOUT_JOB = 'mailchimp.optout';

const DAY_MS = 86400_000;
const SLACK_MS = 3600_000; // "since the last pull, less an hour": clocks differ, and a change may land late
const FULL_EVERY_MS = 7 * DAY_MS;
const DAILY_AT = '10:17:00'; // UTC: the small hours in British Columbia
const TOGETHER = 25; // addresses to one write, so the campaign's lock is never held long

// A member as Mailchimp answers it → what base.win reads of it.
const memberOf = (m, status = null) => ({ email: lower(m?.email_address), status: m?.status || status, changedAt: m?.last_changed || null });
// One member, read now. null: Mailchimp has no such address in the audience.
export const readMember = async (audience, email) => {
  try {
    return memberOf(await mailchimp('GET', `/lists/${audience}/members/${memberHash(email)}`, {
      query: { fields: 'email_address,status,unsubscribe_reason,last_changed' }, timeoutMs: 10_000,
    }));
  } catch (e) {
    if (e instanceof MailchimpError && e.httpStatus === 404) return null;
    throw e;
  }
};

// Of these addresses, the ones email is still on for here…
const stillOnAmong = async (db, ws, emails) => (emails.length ? (await db.query(
  `select e as email from unnest($2::text[]) e
    where exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e and s.status <> 'unsubscribed')
       or (not exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e)
           and exists (select 1 from persons p where p.workspace_id = $1 and lower(p.email) = e and p.deleted_at is null
                         and not (lower(p.tags::text) like '%"do-not-email"%')))`, [ws, emails],
)).rows.map((r) => r.email) : []);
// …and the ones held here that aren't on the suppression list.
const HELD = `(exists (select 1 from persons p where p.workspace_id = $1 and lower(p.email) = e and p.deleted_at is null)
            or exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e))`;
const heldUnsuppressed = async (db, ws, emails) => (emails.length ? (await db.query(
  `select e as email from unnest($2::text[]) e
    where ${HELD} and not exists (select 1 from email_suppressions x where x.workspace_id = $1 and x.email = e and x.lifted_at is null)`, [ws, emails],
)).rows.map((r) => r.email) : []);

// When the person last said yes to email here THEMSELVES: a yes on the
// consent record with the words they saw — a box they ticked on the
// campaign's website, or their own link from an email. An address the team
// typed in or imported is the team's word, not theirs, and never undoes
// their no.
const latestOwnYes = async (tx, ws, email) => (await tx.query(
  `select max(created_at) as at from consent_events
    where workspace_id = $1 and channel = 'email' and granted and wording is not null and address = $2`, [ws, email],
)).rows[0]?.at || null;
const after = (a, b) => new Date(a).getTime() > new Date(b).getTime();
// How many people an address's no turns off here (`e`: the address, in SQL):
// everyone on file with it whose email is on — a household shares one — or,
// with no such record, the one who subscribed.
const PEOPLE = (e) => `greatest(1, (select count(*) from persons p where p.workspace_id = $1 and lower(p.email) = ${e}
                                   and p.deleted_at is null and not (lower(p.tags::text) like '%"do-not-email"%')))`;

// What Mailchimp says about one address, taken here (inside a write; every
// check is made again under the campaign's lock). → [what, how many]:
// ['unsubscribed', people turned off] | ['cleaned', 1] | null (nothing to do)
const takeMember = async (tx, emit, ws, m) => {
  if (m.status === 'unsubscribed') {
    if (!(await stillOn(tx, ws, m.email))) return null;
    const yes = await latestOwnYes(tx, ws, m.email);
    if (yes && m.changedAt && !after(m.changedAt, yes)) return null;
    const who = (await tx.query(
      'select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null order by created_at, id limit 1', [ws, m.email],
    )).rows[0];
    const people = (await tx.query(`select ${PEOPLE('$2')}::int as n`, [ws, m.email])).rows[0].n;
    await emailOff(tx, ws, { personId: who?.id || null, email: m.email, source: 'mailchimp-unsubscribe' }, emit);
    return ['unsubscribed', people];
  }
  if (m.status === 'cleaned') {
    const cur = (await tx.query('select lifted_at from email_suppressions where workspace_id = $1 and email = $2', [ws, m.email])).rows[0];
    // The desk put the address back after Mailchimp cleaned it: the desk's word stands.
    if (cur?.lifted_at && m.changedAt && !after(m.changedAt, cur.lifted_at)) return null;
    const changed = await suppress(tx, emit, ws, { email: m.email, reason: 'bounce', source: 'mailchimp', detail: 'Mailchimp cleaned it: it bounced for good there' });
    return changed ? ['cleaned', 1] : null;
  }
  return null;
};

// Members as Mailchimp has them, taken in: first narrowed to the addresses
// a change could matter for (two reads), then a few to a write. → how many
// were turned off here: { unsubscribed (people), cleaned (addresses) }
export const takeIn = async (db, ws, members) => {
  const by = new Map(members.filter((m) => m.email).map((m) => [m.email, m]));
  const of = (status) => [...by.values()].filter((m) => m.status === status).map((m) => m.email);
  const todo = [...await stillOnAmong(db, ws, of('unsubscribed')), ...await heldUnsuppressed(db, ws, of('cleaned'))].map((e) => by.get(e));
  const out = { unsubscribed: 0, cleaned: 0 };
  for (let i = 0; i < todo.length; i += TOGETHER) {
    const part = todo.slice(i, i + TOGETHER);
    const { result } = await runAction(db, { workspaceId: ws, actorId: null, action: PULL_ACTION }, async (tx, emit) => {
      const did = [];
      for (const m of part) did.push(await takeMember(tx, emit, ws, m));
      return did;
    });
    for (const d of result) if (d) out[d[0]] += d[1];
  }
  return out;
};

export const plural = (n, one, many) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const wordsFor = (out) => [
  out.unsubscribed ? `${out.unsubscribed.toLocaleString('en-CA')} unsubscribed` : null,
  out.cleaned ? plural(out.cleaned, 'dead address', 'dead addresses') : null,
].filter(Boolean).join(' · ') || 'Nothing new';
const said = (db, ws, ok, note) => db.query(
  `insert into mailchimp_state (workspace_id, pull_ok, pull_note) values ($1, $2, $3)
   on conflict (workspace_id) do update set pull_ok = excluded.pull_ok, pull_note = excluded.pull_note`, [ws, ok, String(note).slice(0, 300)],
);

// ── The first pull from an audience: a door, opened only by a person ──
// It would turn email off here for everyone on file who left that audience,
// however long ago, and set aside every address that died there. Only they
// can turn their email back on, so until someone says yes for this audience
// (Settings → Services, or a list's "Send to Mailchimp") every pull counts
// first — the audience's name, and how many on file it would turn off — and
// takes none of that in. When that is nobody there is nothing to ask, and
// the door stays shut all the same: the file may come in tomorrow, so the
// next pull counts again and asks the first time it would turn someone off.
// What the door holds back is the past. A no Mailchimp dates after the
// audience was first counted is new — what a webhook brings — and is taken
// in as the webhook takes it, yes or no: a webhook that never came is still
// caught by the nightly pull.
// A yes is for the numbers it was shown: the first pull after it — one that
// began after it — counts again, and asks again rather than turn off more
// (an import since). Once that pull is done, later pulls run as built.
// A webhook is not a pull: it is about one person who has just left there,
// and is taken in as always.
export const STILL_COUNTING = 'Still counting who unsubscribed in Mailchimp — try again in a moment';
export const COUNT_CHANGED = 'The count has changed since — look again';

// What the first pull from the audience in use would do, while nobody has
// said yes to it: { audience, name, unsubscribed, cleaned, counted_at,
// counting } — the numbers once counted (null before) and when, the name
// when there is someone to ask about, counting while a pull is under way —
// or null: someone has said yes. `audience`: the one in use, when known (an
// action has just asked); else the one named or last found, or failing that
// the last one counted.
export const firstOf = async (q, ws, audience = knownAudience()) => {
  const s = (await q.query('select agreed_for, ask_for, ask_name, ask_unsubscribed, ask_cleaned, asked_at from mailchimp_state where workspace_id = $1', [ws])).rows[0];
  const id = audience || s?.ask_for || s?.agreed_for || null;
  if (id && s?.agreed_for === id) return null;
  const counted = Boolean(id) && s?.ask_for === id;
  return {
    audience: id,
    name: counted ? s.ask_name : null,
    unsubscribed: counted ? s.ask_unsubscribed : null,
    cleaned: counted ? s.ask_cleaned : null,
    counted_at: counted && s.asked_at ? new Date(s.asked_at).toISOString() : null,
    counting: await pulling(q, ws),
  };
};

// A person's yes to the first pull from `audience` (inside their write), for
// the numbers the question showed them (`shown`; a screen that sends none
// means the count as it stands). A yes to anything but the count as it
// stands is refused — look again; a question about nobody has no yes, and
// the door stays shut. Kept, and on the log with what they were shown.
export const sayYes = async (tx, emit, ws, audience, shown = null) => {
  const first = await firstOf(tx, ws, audience);
  if (!first) return; // someone has said yes already
  if (first.unsubscribed == null) throw httpError(409, STILL_COUNTING);
  if (shown && (shown.unsubscribed !== first.unsubscribed || shown.cleaned !== first.cleaned)) throw httpError(409, COUNT_CHANGED);
  if (!first.unsubscribed && !first.cleaned) return;
  await tx.query(
    `insert into mailchimp_state (workspace_id, agreed_for, agreed_unsubscribed, agreed_cleaned) values ($1, $2, $3, $4)
     on conflict (workspace_id) do update set agreed_for = excluded.agreed_for,
       agreed_unsubscribed = excluded.agreed_unsubscribed, agreed_cleaned = excluded.agreed_cleaned`,
    [ws, audience, first.unsubscribed, first.cleaned],
  );
  emit('mailchimp', ws, 'update', { first_pull: 'yes', audience, name: first.name, unsubscribed: first.unsubscribed, cleaned: first.cleaned });
};

// What taking these members in would turn off here: the checks takeMember
// makes (still on here, and no newer yes of their own; held here, and not
// set aside already or put back by the desk since), in two reads. →
// { unsubscribed (people), cleaned (addresses), emails (the addresses) }
const isoOf = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : v ? new Date(0).toISOString() : null);
const COUNT_OFF = {
  unsubscribed: `(exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e and s.status <> 'unsubscribed')
       or (not exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e)
           and exists (select 1 from persons p where p.workspace_id = $1 and lower(p.email) = e and p.deleted_at is null
                         and not (lower(p.tags::text) like '%"do-not-email"%'))))
     and not exists (select 1 from consent_events c where c.workspace_id = $1 and c.channel = 'email' and c.granted
                       and c.wording is not null and c.address = e and changed is not null and c.created_at >= changed)`,
  cleaned: `${HELD} and not exists (select 1 from email_suppressions x where x.workspace_id = $1 and x.email = e
                                     and (x.lifted_at is null or (changed is not null and changed <= x.lifted_at)))`,
};
const wouldTurnOff = async (db, ws, members) => {
  const out = { unsubscribed: 0, cleaned: 0, emails: new Set() };
  for (const status of ['unsubscribed', 'cleaned']) {
    const rows = members.filter((m) => m.status === status);
    if (!rows.length) continue;
    const { rows: off } = await db.query(
      `select e, ${status === 'unsubscribed' ? PEOPLE('e') : '1'}::int as n
         from (select e, max(changed) as changed from unnest($2::text[], $3::timestamptz[]) as x(e, changed) group by e) m
        where ${COUNT_OFF[status]}`,
      [ws, rows.map((m) => m.email), rows.map((m) => isoOf(m.changedAt))],
    );
    for (const r of off) { out[status] += r.n; out.emails.add(r.e); }
  }
  return out;
};

// The door shut, or a yes whose first pull is still to come: what this pull
// would turn off is counted before anything is taken in, and kept — the
// question's words, and (the first time for this audience) when the count
// began: `started`. → the question to ask, { unsubscribed, cleaned, more,
// audience } (more: a yes was shown fewer), or null: go on.
const askFirst = async (db, ws, audience, state, would, started) => {
  const agreed = state?.agreed_for === audience;
  if (agreed && would.unsubscribed <= (state.agreed_unsubscribed ?? 0) && would.cleaned <= (state.agreed_cleaned ?? 0)) return null;
  const any = Boolean(would.unsubscribed || would.cleaned);
  let name = null;
  if (any) {
    const a = await mailchimp('GET', `/lists/${audience}`, { query: { fields: 'id,name' }, timeoutMs: 10_000 });
    name = typeof a?.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 200) : audience;
  }
  // Mailchimp answered: an earlier "the last pull stopped" is no longer so.
  // When the audience was first counted stays what it was; another audience
  // starts afresh.
  const keep = (q) => q.query(
    `insert into mailchimp_state (workspace_id, ask_for, ask_name, ask_unsubscribed, ask_cleaned, asked_at, first_counted_at) values ($1, $2, $3, $4, $5, now(), $6)
     on conflict (workspace_id) do update set ask_for = excluded.ask_for, ask_name = excluded.ask_name,
       ask_unsubscribed = excluded.ask_unsubscribed, ask_cleaned = excluded.ask_cleaned, asked_at = excluded.asked_at,
       first_counted_at = case when mailchimp_state.ask_for = excluded.ask_for
                               then coalesce(mailchimp_state.first_counted_at, excluded.first_counted_at) else excluded.first_counted_at end,
       pull_ok = nullif(mailchimp_state.pull_ok, false),
       pull_note = case when mailchimp_state.pull_ok = false then null else mailchimp_state.pull_note end`,
    [ws, audience, name, would.unsubscribed, would.cleaned, started],
  );
  if (!agreed) {
    await keep(db);
    return any ? { unsubscribed: would.unsubscribed, cleaned: would.cleaned, more: false, audience } : null;
  }
  // More than the yes was shown: it is set aside, and the question is asked
  // again with the new numbers — on the log, as the system.
  await runAction(db, { workspaceId: ws, actorId: null, action: PULL_ACTION }, async (tx, emit) => {
    const s = (await tx.query('select agreed_for, agreed_unsubscribed, agreed_cleaned from mailchimp_state where workspace_id = $1', [ws])).rows[0];
    await keep(tx);
    // Only the yes this pull counted against is set aside, and said, once:
    // one another pull has set aside or closed meanwhile stays as it is, and
    // so does a newer yes — its own first pull counts for it.
    if (s?.agreed_for !== audience || s.agreed_unsubscribed !== state.agreed_unsubscribed || s.agreed_cleaned !== state.agreed_cleaned) return;
    await tx.query('update mailchimp_state set agreed_for = null, agreed_unsubscribed = null, agreed_cleaned = null where workspace_id = $1', [ws]);
    emit('mailchimp', ws, 'update', {
      first_pull: 'asked again', audience,
      shown: { unsubscribed: s.agreed_unsubscribed, cleaned: s.agreed_cleaned }, counted: { unsubscribed: would.unsubscribed, cleaned: would.cleaned },
    });
  });
  return { unsubscribed: would.unsubscribed, cleaned: would.cleaned, more: true, audience };
};

// Mailchimp is answering: an unsubscribe that could not be told to it
// earlier goes again, now — one given up on, and one waiting its turn to be
// tried again.
const tellAgain = async (db, ws) => {
  const again = await db.query(
    `update jobs set status = 'pending', attempts = 0, run_at = now(), last_error = null, done_at = null
      where workspace_id = $1 and kind = $2 and (status = 'failed' or (status = 'pending' and attempts > 0))`, [ws, OPTOUT_JOB],
  );
  if (again.affectedRows) runJobsSoon();
};

// Read who left and whose address died, and take it in. → { unsubscribed,
// cleaned }: how many were turned off here — and asked (askFirst) when the
// door asked instead: then only a no newer than the first count was taken in.
export const pull = async (db, ws, { full = false } = {}) => {
  const audience = await audienceId();
  const state = (await db.query('select * from mailchimp_state where workspace_id = $1', [ws])).rows[0];
  // Someone said yes for this audience; open once the first pull after it is done.
  const agreed = state?.agreed_for === audience;
  const open = agreed && state.agreed_unsubscribed == null && state.agreed_cleaned == null;
  // This is that first pull (it began after the yes): the numbers it counts against.
  const yes = agreed && !open ? { unsubscribed: state.agreed_unsubscribed, cleaned: state.agreed_cleaned } : null;
  const known = open && state?.audience_id === audience && state.pulled_through && state.full_at;
  const everything = full || !known || Date.now() - new Date(state.full_at).getTime() > FULL_EVERY_MS;
  // As Mailchimp writes a time: 2026-11-10T17:35:00+00:00.
  const since = everything ? null : new Date(new Date(state.pulled_through).getTime() - SLACK_MS).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const started = new Date().toISOString();
  const left = [];
  for (const status of ['unsubscribed', 'cleaned']) {
    const rows = await pages(`/lists/${audience}/members`, 'members', {
      status, since_last_changed: since, fields: 'members.email_address,members.status,members.last_changed,total_items',
    });
    left.push(...rows.map((m) => memberOf(m, status)).filter((m) => m.status === status));
  }
  let take = left;
  let asked = null;
  if (!open) {
    // A no Mailchimp dates after the audience was first counted is new — what
    // its webhook would have brought — and is taken in, yes or no. Only the
    // older ones are counted, and wait for the question. (Not counted yet, or
    // a date that can't be read: older.)
    const from = state?.ask_for === audience && state.first_counted_at ? new Date(state.first_counted_at).getTime() : NaN;
    const isNew = (m) => Date.parse(m.changedAt) > from;
    const would = await wouldTurnOff(db, ws, left.filter((m) => !isNew(m)));
    asked = await askFirst(db, ws, audience, state, would, started);
    // Of the older ones the first pull after a yes takes in only who was
    // counted: never more than the yes was shown (someone who came in
    // meanwhile waits for the next pull). With the door shut, none of them.
    take = left.filter((m) => isNew(m) || (yes && !asked && would.emails.has(m.email)));
  }
  const out = await takeIn(db, ws, take);
  // It asked, and found nothing new: it only counted, and the line under the
  // buttons stays as it was.
  if (!asked || out.unsubscribed || out.cleaned) {
    // Only the yes this pull counted against is closed (agreed_* back to null:
    // from now on pulls run as built) — a pull already on its way when the
    // yes was given never stands in for the count that yes was promised.
    const closes = `$6::boolean and mailchimp_state.agreed_for = excluded.audience_id
      and mailchimp_state.agreed_unsubscribed is not distinct from $7::int and mailchimp_state.agreed_cleaned is not distinct from $8::int`;
    await db.query(
      `insert into mailchimp_state (workspace_id, audience_id, pulled_through, full_at, pulled_at, pull_ok, pull_note)
       values ($1, $2, $3, $4, now(), true, $5)
       on conflict (workspace_id) do update set audience_id = excluded.audience_id, pulled_through = excluded.pulled_through,
         full_at = coalesce(excluded.full_at, case when mailchimp_state.audience_id = excluded.audience_id then mailchimp_state.full_at end),
         pulled_at = excluded.pulled_at, pull_ok = true, pull_note = excluded.pull_note,
         agreed_unsubscribed = case when ${closes} then null else mailchimp_state.agreed_unsubscribed end,
         agreed_cleaned = case when ${closes} then null else mailchimp_state.agreed_cleaned end`,
      [ws, audience, started, everything ? started : null, wordsFor(out), Boolean(yes) && !asked, yes?.unsubscribed ?? null, yes?.cleaned ?? null],
    );
  }
  await tellAgain(db, ws);
  return asked ? { ...out, asked } : out;
};

// ── The daily pull ──
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
// The next three days, each queued once (a key a campaign day): a run queues
// them before it does anything else, so one bad day never ends them.
export const queueDays = async (q, ws) => {
  for (let n = 1; n <= 3; n += 1) {
    const day = dayOf(Date.now() + n * DAY_MS);
    await enqueueJob(q, { workspaceId: ws, kind: PULL_JOB, runAt: `${day}T${DAILY_AT}Z`, payload: { day }, key: `${PULL_JOB}:${day}` });
  }
};
// Whether a pull is under way (or due): Pull now's "Pulling…".
export const pulling = async (q, ws) => (await q.query(
  `select 1 from jobs where workspace_id = $1 and kind = $2 and (status = 'running' or (status = 'pending' and run_at <= now())) limit 1`, [ws, PULL_JOB],
)).rows.length > 0;

// payload { day } (the daily one) or { full: true } (Pull now).
export const runPullJob = async (db, job) => {
  const ws = job.workspace_id;
  // Mailchimp was taken away: nothing to do, and no more days are queued.
  if (!mailchimpOn()) return;
  await queueDays(db, ws);
  try {
    await pull(db, ws, { full: Boolean(job.payload?.full) });
  } catch (e) {
    // Said on Settings → Services; the job runner tries again by itself.
    await said(db, ws, false, e instanceof MailchimpError ? e.message : 'The pull stopped part-way; it will be tried again');
    throw e;
  }
};

// ── One address a webhook was about ──
// An address changed in Mailchimp (upemail): noted on the log for the
// person who had the old one, once — and only when Mailchimp itself has the
// new address. The person here is not changed.
const noteAddress = async (db, ws, audience, { was, now }) => {
  if (!(await readMember(audience, now))) return;
  const people = (await db.query(
    'select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null order by created_at, id limit 20', [ws, was],
  )).rows;
  if (!people.length) return;
  await runAction(db, { workspaceId: ws, actorId: null, action: PULL_ACTION }, async (tx, emit) => {
    for (const p of people) {
      const seen = (await tx.query(
        `select 1 from events where workspace_id = $1 and entity_type = 'mailchimp_address' and entity_id = $2 and payload->>'now' = $3 limit 1`, [ws, p.id, now],
      )).rows.length;
      if (!seen) emit('mailchimp_address', p.id, 'update', { was, now });
    }
  });
};

// payload { email } or { was, now }.
export const runMemberJob = async (db, job) => {
  if (!mailchimpOn()) return;
  const p = job.payload || {};
  const audience = await audienceId();
  if (p.was && p.now) { await noteAddress(db, job.workspace_id, audience, { was: lower(p.was), now: lower(p.now) }); return; }
  const m = p.email ? await readMember(audience, p.email) : null;
  if (m) await takeIn(db, job.workspace_id, [m]);
};
