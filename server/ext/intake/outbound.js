// base.win → the campaign's website: someone said no here, so the website
// stops emailing or texting them too. An events hook reads every write as it
// commits and queues a job (in the write's own transaction: the job commits
// with the no, or not at all) for what it turned off:
//
//   a subscription ended      their unsubscribe link, a ladder's or a list
//                             email's, the desk's Remove, a no from
//                             Mailchimp, a spam complaint     → email
//   a number was stopped      a STOP text, the carrier's "they stopped",
//                             the Inbox's one tap, texts off  → sms
//   a person was newly tagged do-not-email or do-not-contact → email;
//                             do-not-text or do-not-contact  → sms
//
// What the website itself said (the write's action is intake.consent) is
// never sent back to it. Only a no is ever sent: never a yes, a START, a
// bounce, a press release's own unsubscribe, do-not-call, or anything of the
// sample campaign. Only six fields leave: action, at, channel, email, phone,
// reason — never a name, a tag, a rating, an id or a note.
//
// The job tells the website one item at a time, 60 a minute at most (half
// what it takes), each with its own Idempotency-Key and the same bytes on
// every try. An item is given up only for a fault of its own (the website
// refused that one body, five times); when the website is down, refuses the
// key or is busy, everything waits and is tried again — for ever.
// What happened before the two settings were set is not sent by itself: a
// manager sends it once (intake.website.backfill), with the count shown first.
import { z } from 'zod';
import { inWrite, newId } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { e164 } from '../texting/rules.js';
import { e164Sql, dialable } from '../../lib/reach.js';
// (Nothing here imports consent.js or index.js: this file is also read by
// ext/connections, which loads before ext/intake.)
import { WEBSITE_KEYWORD, WEBSITE_SOURCES, websiteKey, websiteOn, websiteState, withoutKey } from './website.js';

export const INBOUND_ACTION = 'intake.consent';
export const CONSENT_JOB = 'website.consent';
export const BACKFILL_JOB = 'website.backfill';
export const BACKFILL_KEY = 'website.backfill';
// Writes that never speak for a person: the sample campaign's made-up people.
const QUIET = new Set(['sample.load', 'sample.clear']);
const PER_JOB = 50;
export const PER_MINUTE = 60;
let timeoutMs = 10_000;
export const _setTimeoutForTest = (ms) => { timeoutMs = ms || 10_000; };
// After a fault that is not the item's own: 1 min, 5 min, 30 min, 2 h, then every 6 h.
export const WAITS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const waitFor = (tries) => WAITS_MS[Math.min(Math.max(tries, 1), WAITS_MS.length) - 1];

const NO_EMAIL = 'do-not-email';
const NO_TEXT = 'do-not-text';
const NO_CONTACT = 'do-not-contact';
const lower = (s) => String(s ?? '').trim().toLowerCase();
const parseJ = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
// A do-not tag counts whatever its capitals, as everywhere else (lib/reach.js).
const has = (tags, ...which) => Array.isArray(tags) && tags.some((t) => which.includes(String(t).toLowerCase()));
const emailOffBy = (tags) => has(tags, NO_EMAIL, NO_CONTACT);
const textOffBy = (tags) => has(tags, NO_TEXT, NO_CONTACT);
const anEmail = z.string().email().max(320);
const goodEmail = (s) => (anEmail.safeParse(lower(s)).success ? lower(s) : null);

// ── The hook ──
export const liveKey = async (tx, ws) => (await tx.query(
  'select 1 from intake_keys where workspace_id = $1 and revoked_at is null limit 1', [ws],
)).rows.length > 0;

// Which of a write's events could be a no (the rest pass with no query at all).
const speaks = (e) => {
  const p = e.payload || {};
  if (e.entityType === 'subscription') return e.op === 'void' || p.status === 'unsubscribed';
  if (e.entityType === 'texting_optout') return p.opted_out === true;
  if (e.entityType === 'person' && (e.op === 'create' || e.op === 'update')) {
    // Tags with one of the three; or, for someone already on file, a new address or number.
    return (Array.isArray(p.tags) || e.op === 'create') ? (emailOffBy(p.tags) || textOffBy(p.tags)) : Boolean(p.email || p.phone);
  }
  return false;
};

// What was last written down about a person before this write: whether their
// tags turned email or texts off, their address and their number. Read from
// the event log, where every change to a person's tags carries all of them
// and every change of address or number the new one — this write's own
// events join the log only after the hooks (as ext/mailchimp/optout.js).
const before = async (tx, ws, personId) => {
  const rows = (await tx.query(
    `select seq, jsonb_typeof(payload->'tags') = 'array' as has_tags, payload->'tags' as tags,
            (payload->'email') is not null as has_email, payload->>'email' as email,
            (payload->'phone') is not null as has_phone, payload->>'phone' as phone
       from events where workspace_id = $1 and entity_type = 'person' and entity_id = $2
        and (jsonb_typeof(payload->'tags') = 'array' or (payload->'email') is not null or (payload->'phone') is not null)`, [ws, personId],
  )).rows.sort((a, b) => Number(a.seq) - Number(b.seq));
  const tags = parseJ(rows.filter((r) => r.has_tags).at(-1)?.tags);
  return {
    emailOff: emailOffBy(tags), textOff: textOffBy(tags),
    email: lower(rows.filter((r) => r.has_email).at(-1)?.email), phone: e164(rows.filter((r) => r.has_phone).at(-1)?.phone) || '',
  };
};

// What this write newly turned off for one person: the tag was put on (their
// own link, the desk, an import, a merge), or someone already tagged was
// given another address or number. A change that says nothing new (another
// tag beside it, the same address again) is told to nobody.
// `known`: what this write has already been seen to leave, by person.
const newlyOff = async (tx, ws, e, known) => {
  const row = (await tx.query('select email, phone, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null', [e.entityId, ws])).rows[0];
  if (!row) return null;
  const tags = parseJ(row.tags);
  const now = { emailOff: emailOffBy(tags), textOff: textOffBy(tags), email: lower(row.email), phone: e164(row.phone) || '' };
  if (!now.emailOff && !now.textOff) return null;
  const was = e.op === 'create' ? null : known.get(e.entityId) || await before(tx, ws, e.entityId);
  known.set(e.entityId, now);
  return {
    email: now.emailOff && now.email && !(was?.emailOff && was.email === now.email) ? now.email : null,
    text: now.textOff && (now.phone || now.email) && !(was?.textOff && was.phone === now.phone) ? { phone: now.phone, email: now.email } : null,
  };
};

// One item per channel and address per write (a STOP emits both a
// texting_optout and a tagged person: the STOP is what is said).
const itemsOf = async (tx, ws, events) => {
  const items = new Map();
  const at = new Date().toISOString();
  const add = (channel, { email = null, phone = null }, reason) => {
    // An address that isn't one, or a number that can't be dialled, is not
    // sent as that; with neither there is nothing to say.
    const em = goodEmail(email);
    const num = channel === 'sms' ? e164(phone) : null;
    if (channel === 'email' ? !em : !num && !em) return;
    const key = channel === 'email' ? `email|${em}` : `sms|${num || em}`;
    if (items.has(key)) return;
    items.set(key, { id: newId(), channel, ...(em ? { email: em } : {}), ...(num ? { phone: num } : {}), reason, at });
  };
  const why = (p) => (p.source === 'preferences' ? 'preference' : 'unsubscribe');
  for (const e of events.filter((x) => x.entityType === 'subscription')) {
    const p = e.payload || {};
    const email = p.email || (await tx.query('select email from subscriptions where id = $1 and workspace_id = $2', [e.entityId, ws])).rows[0]?.email;
    add('email', { email }, why(p));
  }
  for (const e of events.filter((x) => x.entityType === 'texting_optout')) add('sms', { phone: e.payload.phone }, 'stop');
  const known = new Map();
  for (const e of events.filter((x) => x.entityType === 'person')) {
    const off = await newlyOff(tx, ws, e, known);
    if (off?.email) add('email', { email: off.email }, why(e.payload || {}));
    if (off?.text) add('sms', off.text, 'preference');
  }
  return [...items.values()];
};

// Every write in base.win passes here. Most have nothing for the website (no
// query at all); what does is done inside a savepoint, so a fault here never
// costs someone their unsubscribe — it is logged, and the write goes on.
export const onEvents = async (tx, meta, events) => {
  if (!websiteOn()) return;
  const action = String(meta.action || '');
  // What the website itself said is never sent back to it.
  if (action === INBOUND_ACTION || QUIET.has(action)) return;
  const said = events.filter(speaks);
  if (!said.length) return;
  const ws = meta.workspaceId;
  await tx.query('savepoint website_hook');
  try {
    // The sync belongs to the campaign the website's key belongs to.
    if (await liveKey(tx, ws)) {
      const items = await itemsOf(tx, ws, said);
      for (let i = 0; i < items.length; i += PER_JOB) {
        await enqueueJob(tx, { workspaceId: ws, kind: CONSENT_JOB, payload: { items: items.slice(i, i + PER_JOB), tries: 0 } });
      }
    }
    await tx.query('release savepoint website_hook');
  } catch (e) {
    await tx.query('rollback to savepoint website_hook');
    console.error(`intake: an unsubscribe was not queued for the website (${action}): ${withoutKey(e.message)}`);
  }
};

// ── The job ──
// The body, in the same key order every time: a retry must be the same
// bytes, or the website answers 409. These six fields and nothing else.
export const bodyOf = (item) => JSON.stringify({
  action: 'withdraw', at: item.at, channel: item.channel,
  ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), reason: item.reason,
});

// One call. → { status, body } — status 0: no answer (words in `said`).
export const callWebsite = async (target, { body, idempotencyKey = null, timeout = timeoutMs }) => {
  if (inWrite()) throw new Error('the website is never called inside a write');
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${websiteKey()}`, 'content-type': 'application/json', accept: 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body,
      // Never followed: the key goes to the address that was set, and nowhere else.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { status: 0, body: null, said: timedOut ? `No answer in ${Math.max(1, Math.round(timeout / 1000))} seconds` : 'The website can’t be reached' };
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json && typeof json === 'object' ? json : null };
};
const theirWords = (r) => withoutKey(typeof r.body?.error === 'string' && r.body.error ? r.body.error : '').slice(0, 200);
// A fault that is not the item's own, in plain words.
const faultWords = (r) => {
  if (r.status === 0) return r.said;
  if (r.status === 401) return 'The website refused the key';
  if (r.status === 503) return theirWords(r) ? `The website said: ${theirWords(r)}` : 'The website isn’t ready (503)';
  if (r.status === 404) return 'No such address on the website';
  if (r.status >= 300 && r.status < 400) return `The website sent us on to another address (${r.status}): set its final https:// address`;
  if (r.status >= 200 && r.status < 300) return 'The website answered, but not with ok';
  return `The website answered ${r.status}${theirWords(r) ? `: ${theirWords(r)}` : ''}`;
};
// About this one body: it will never be taken as it is.
const REFUSED = new Set([400, 409, 413, 415, 422]);

// 60 a minute for the whole server, however many jobs are waiting: the
// website takes 120 a minute from one caller.
let pace = { start: 0, n: 0 };
const room = () => {
  if (Date.now() - pace.start >= 60_000) pace = { start: Date.now(), n: 0 };
  return PER_MINUTE - pace.n;
};
const untilRoom = () => Math.max(1000, pace.start + 60_000 - Date.now());
// Down until: after no answer or a 5xx, the other website jobs wait out a
// minute without calling it (each keeps its own tries). The jobs run one after another, so a
// website that hangs would otherwise hold every other background job (a
// ladder's next email, a send, Mailchimp) for its timeout once per job.
let downUntil = 0;
export const _resetPaceForTest = () => { pace = { start: 0, n: 0 }; downUntil = 0; };
// A job that found no room at all comes back a little apart from the others
// waiting with it (a big import queues many at once), so they are not all
// due in the same moment, ahead of the campaign's other background work.
const apart = async (db) => {
  const n = (await db.query(`select count(*)::int as n from jobs where kind = $1 and status = 'pending'`, [CONSENT_JOB])).rows[0].n;
  return Math.round(Math.random() * Math.min(n * 10_000, 600_000));
};
// One run never holds the queue long: after this it hands the rest back.
let runMs = 25_000;
export const _setRunMsForTest = (ms) => { runMs = ms ?? 25_000; };

// payload { items: [{ id, channel, email?, phone?, reason, at, said? }], tries, last? }
// Safe to run again from the start: an item already taken is answered as a replay.
export const runConsentJob = async (db, job) => {
  // The settings were taken away: the website was disconnected on purpose.
  const { on, target } = websiteState();
  if (!on) return undefined;
  // Spread a little, so the ones held back are not all due together again.
  if (Date.now() < downUntil) return { again: downUntil - Date.now() + Math.round(Math.random() * 5000) };
  const items = job.payload?.items || [];
  const started = Date.now();
  const left = [];
  let sent = 0;
  let stop = null; // { again } | { last }
  for (const [i, item] of items.entries()) {
    const rest = () => left.push(...items.slice(i));
    if (room() <= 0) { rest(); stop = { again: untilRoom() + (i === 0 ? await apart(db) : 0) }; break; }
    if (Date.now() - started > runMs) { rest(); stop = { again: 1000 }; break; }
    pace.n += 1;
    const r = await callWebsite(target, { body: bodyOf(item), idempotencyKey: item.id });
    if (r.status >= 200 && r.status < 300 && r.body?.ok === true) { sent += 1; continue; }
    // About this one body: kept with the website's words; the others still go.
    if (REFUSED.has(r.status)) { left.push({ ...item, said: `${r.status}: ${theirWords(r) || 'refused'}` }); continue; }
    rest();
    stop = r.status === 429 ? { again: 60_000 } : { last: { status: r.status, said: faultWords(r), at: new Date().toISOString() } };
    break;
  }
  const payload = { ...job.payload, items: left };
  if (stop?.last) {
    // Not the items' fault (the website is down, or refuses the key): they
    // wait, and no try is counted — a no is never given up for it.
    payload.tries = (Number(job.payload?.tries) || 0) + 1;
    payload.last = stop.last;
    stop.again = waitFor(payload.tries);
    // A minute at most: a no queued since still goes soon after it answers.
    if (stop.last.status === 0 || stop.last.status >= 500) downUntil = Date.now() + Math.min(stop.again, WAITS_MS[0]);
  } else if (sent) { payload.tries = 0; delete payload.last; downUntil = 0; }
  if (JSON.stringify(payload) !== JSON.stringify(job.payload)) await db.query('update jobs set payload = $2 where id = $1', [job.id, JSON.stringify(payload)]);
  if (stop) return { again: stop.again };
  // Only refused items are left: the job fails, is tried again, and after
  // five tries is kept as failed with the website's words.
  if (left.length) throw new Error(`The website refused ${left.length === 1 ? 'one' : left.length}: ${left[0].said}`);
  return undefined;
};

// ── What Settings → Services says ──
const itemsIn = (rows) => rows.flatMap((r) => (parseJ(r.payload)?.items || []).map((x) => ({ ...x, job: r })));
// → { key, waiting, waitingSaid, waitingSince, refused, refusedSaid }
export const websiteCounts = async (q, ws) => {
  const rows = (await q.query(
    `select status, payload, last_error, created_at from jobs where workspace_id = $1 and kind = $2 and status in ('pending', 'running', 'failed')
      order by created_at`, [ws, CONSENT_JOB],
  )).rows;
  const all = itemsIn(rows);
  const refused = all.filter((x) => x.said);
  const waiting = all.filter((x) => !x.said);
  // The last answer that held things up, and since when.
  const held = rows.map((r) => parseJ(r.payload)).filter((p) => p?.last && (p.items || []).some((x) => !x.said));
  const last = held.sort((a, b) => String(b.last.at).localeCompare(String(a.last.at)))[0]?.last || null;
  const since = held.length ? rows.filter((r) => parseJ(r.payload)?.last).map((r) => r.created_at).sort((a, b) => new Date(a) - new Date(b))[0] : null;
  return {
    key: await liveKey(q, ws),
    waiting: waiting.length, waitingSaid: last ? withoutKey(last.said) : null, waitingSince: since ? new Date(since).toISOString() : null,
    refused: refused.length, refusedSaid: refused.length ? withoutKey(String(refused.at(-1).said).replace(/^\d+:\s*/, '')) : null,
  };
};

// "Send again": every job back to the front of the queue — the ones given up
// on too, with their refused items tried once more; and the run that sends
// what was already off, if it stopped partway. → { items, backfill }
export const resend = async (tx, ws) => {
  const rows = (await tx.query(
    `select id, payload from jobs where workspace_id = $1 and kind = $2 and status in ('pending', 'failed') for update`, [ws, CONSENT_JOB],
  )).rows;
  let n = 0;
  for (const r of rows) {
    const p = parseJ(r.payload) || {};
    const items = (p.items || []).map(({ said, ...x }) => x);
    n += items.length;
    await tx.query(
      `update jobs set status = 'pending', attempts = 0, run_at = now(), done_at = null, last_error = null, payload = $2 where id = $1`,
      [r.id, JSON.stringify({ ...p, items, tries: 0, last: undefined })],
    );
  }
  const again = await tx.query(
    `update jobs set status = 'pending', attempts = 0, run_at = now(), done_at = null, last_error = null
      where workspace_id = $1 and key = $2 and status = 'failed'`, [ws, BACKFILL_KEY],
  );
  return { items: n, backfill: again.affectedRows > 0 };
};

// ── What is already off, sent once (a manager's tap) ──
// Every address and number that is off here now: list rows that say
// unsubscribed, records tagged do-not-email or do-not-contact with an email,
// numbers that texted STOP, records tagged do-not-text or do-not-contact
// with a number that can be dialled. Not what the website itself told us.
const tagged = (...tags) => `(${tags.map((t) => `lower(p.tags::text) like '%"${t}"%'`).join(' or ')})`;
const OFF_SQL = `
  select channel, address, max(at) as at from (
    select 'email' as channel, lower(s.email) as address, s.unsubscribed_at as at from subscriptions s
     where s.workspace_id = $1 and s.status = 'unsubscribed'
       and not exists (select 1 from consent_events c where c.workspace_id = s.workspace_id and c.channel = 'email'
                        and c.address = lower(s.email) and not c.granted and c.source = any($2::text[]))
    union all
    select 'email', lower(btrim(p.email)), null::timestamptz from persons p
     where p.workspace_id = $1 and p.deleted_at is null and btrim(coalesce(p.email, '')) <> '' and ${tagged(NO_EMAIL, NO_CONTACT)}
       and not exists (select 1 from consent_events c where c.workspace_id = p.workspace_id and c.channel = 'email'
                        and c.address = lower(btrim(p.email)) and not c.granted and c.source = any($2::text[]))
    union all
    select 'sms', o.phone, o.changed_at from texting_optouts o
     where o.workspace_id = $1 and o.opted_out and o.keyword is distinct from $3
    union all
    select 'sms', ${e164Sql('p.phone')}, null::timestamptz from persons p
     where p.workspace_id = $1 and p.deleted_at is null and ${dialable('p.phone')} and ${tagged(NO_TEXT, NO_CONTACT)}
       and not exists (select 1 from texting_optouts o where o.workspace_id = p.workspace_id and o.phone = ${e164Sql('p.phone')}
                        and o.opted_out and o.keyword = $3)
  ) off where address is not null and address <> '' group by channel, address`;
const offArgs = (ws) => [ws, WEBSITE_SOURCES, WEBSITE_KEYWORD];
export const offCount = async (q, ws) => (await q.query(`select count(*)::int as n from (${OFF_SQL}) x`, offArgs(ws))).rows[0].n;

// Where the one run is: null (never asked for) | { status, sent, total, at }
export const backfillOf = async (q, ws) => {
  const r = (await q.query('select status, payload, created_at, done_at from jobs where workspace_id = $1 and key = $2', [ws, BACKFILL_KEY])).rows[0];
  if (!r) return null;
  const p = parseJ(r.payload) || {};
  return { status: r.status, queued: Number(p.queued) || 0, total: Number(p.total) || 0, at: new Date(r.done_at || r.created_at).toISOString() };
};
// One run per campaign (the job's key): a second tap adds nothing. → queued?
export const startBackfill = async (tx, ws) => Boolean(await enqueueJob(tx, {
  workspaceId: ws, kind: BACKFILL_JOB, key: BACKFILL_KEY, payload: { after: null, queued: 0, total: await offCount(tx, ws) },
}));

// payload { after: [channel, address] | null, queued, total }. Each run
// queues the next fifty and steps on, at the pace the website takes them;
// the place it has reached is saved with the jobs it queued, so a run that
// is cut short never sends anyone twice.
export const runBackfillJob = async (db, job) => {
  if (!websiteOn()) return undefined;
  const ws = job.workspace_id;
  const p = job.payload || {};
  // Not ahead of the sender: a page is queued only once the last has mostly gone.
  const ahead = itemsIn((await db.query(`select payload from jobs where workspace_id = $1 and kind = $2 and status in ('pending', 'running')`, [ws, CONSENT_JOB])).rows)
    .filter((x) => !x.said).length;
  if (ahead > PER_JOB) return { again: 30_000 };
  const [ch, addr] = p.after || ['', ''];
  const rows = (await db.query(
    `select channel, address, at from (${OFF_SQL}) x where (channel, address) > ($4::text, $5::text) order by channel, address limit ${PER_JOB}`,
    [...offArgs(ws), ch, addr],
  )).rows;
  if (!rows.length) return undefined;
  const now = new Date().toISOString();
  const items = rows.map((r) => ({
    id: newId(), channel: r.channel, ...(r.channel === 'email' ? { email: goodEmail(r.address) } : { phone: e164(r.address) }),
    reason: r.channel === 'email' ? 'unsubscribe' : 'stop', at: r.at ? new Date(r.at).toISOString() : now,
  })).filter((x) => x.email || x.phone);
  const last = rows.at(-1);
  await db.transaction(async (tx) => {
    if (items.length) await enqueueJob(tx, { workspaceId: ws, kind: CONSENT_JOB, payload: { items, tries: 0 } });
    await tx.query('update jobs set payload = $2 where id = $1', [job.id, JSON.stringify({ ...p, after: [last.channel, last.address], queued: (Number(p.queued) || 0) + items.length })]);
  });
  return rows.length < PER_JOB ? undefined : { again: 1000 };
};
