// Quick reports: a short fixed menu of ready-made lists of people, each one
// tap from Reports, to print or download. Not a report builder — Lists are
// that. Read live; nothing is stored and nothing is sent.
//
//   GET /quick-reports-menu                 the seven, in order, and which this viewer may pull
//   GET /quick-reports/walk?turf=&doors=    one turf's walking list (Map alone)
//   GET /quick-reports/walk.csv             the same doors as a spreadsheet
//   GET /quick-reports/walk/unplaced        people with an address and no pin, campaign-wide
//   GET /quick-reports/:name/count          { count, extra? }
//   GET /quick-reports/:name?…&after=&limit= one page (at most 2,000), A–Z
//   GET /quick-reports/:name.csv            every row, streamed page by page
//
// Desk roles only (a volunteer granted Data too), then each recipe's areas;
// every one but the walking list also needs Data (lib/perms.js PATH_AREA).
// "Do not contact" comes from lib/reach.js's own reasons, never a list here.
import { z } from 'zod';
import { csvResponse, csvStream } from '../../lib/csv.js';
import { azKey, azAfter } from '../../lib/az.js';
import { areasFor } from '../../lib/perms.js';
import { whyNotSql, person } from '../../lib/reach.js';
import { loadScale } from '../scale/rules.js';
import { todayOf } from '../audience/index.js';
import { VOLUNTEER_IDS_SQL } from '../volunteers/data.js';
import { movedCounts, movedOpenWhere } from '../moves/index.js';
// The walk list's own read (routes/api.js walkFor) is imported when a sheet
// is asked for, not at load: routes import the extensions, so a static
// import here would be a cycle (ext.js: features never import routes/*).
const walkRoute = () => import('../../routes/api.js');
import { walkOrder } from '../../lib/geo.js';
import { civic } from '../../lib/address.js';
import { VOLUNTEER_ROLES, SIGN_KINDS, donorTier } from '@starbase/shared/canvass';
import { preset, brandHas } from '../../lib/preset.js';
import { azSort } from '@starbase/shared/names';

const DESK = ['manager', 'treasurer', 'staff'];
export const PAGE_MAX = 2000;
// A turf whose box holds more people than this is not read for paper.
export const WALK_BOX_MAX = 6000;
// The most doors one sheet (and its CSV) carries.
export const WALK_DOORS_MAX = 1500;
const SIGNS_MAX = 5000;
const CANDIDATE_FIELD = 'interested in being a candidate';

// A refusal with its status and the sentence the screen shows in place.
class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (d) => (d == null ? '' : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const dollars = (cents) => (cents == null ? '' : (Number(cents) / 100).toFixed(2));
const tzOf = (ctx) => ctx.workspace?.settings?.tz || 'America/Vancouver';
const dayIn = (ts, tz) => {
  if (!ts) return '';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)); } catch { return day(ts); }
};
// January 1st of the campaign's year, and of the year before.
const yearStart = (ctx, back = 0) => `${Number(todayOf(ctx).slice(0, 4)) - back}-01-01`;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label || code;
const signLabel = (code) => SIGN_KINDS.find((s) => s.code === code)?.label || code;
// An organisation or a one-word name: the whole name under Last name.
const lastFirst = (r) => (r.last_name ? [r.last_name, r.first_name || ''] : [r.name || '', '']);
const tagsOf = (v) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) || []; } catch { return []; } };

// ── Do not contact (lib/reach.js's reasons, in plain words) ──
// The order the column lists them in; Passed away outranks everything.
const WORDS = [
  ['deceased', 'Passed away'], ['do_not_contact', 'Do not contact'], ['do_not_call', 'Do not call'],
  ['do_not_text', 'Do not text'], ['opted_out', 'Texted STOP'], ['unsubscribed', 'Unsubscribed'],
  ['suppressed', 'Email bounced'], ['do_not_email', 'Do not email'],
];
const WORD = new Map(WORDS);
const PHONE_WORDS = ['deceased', 'do_not_contact', 'do_not_call'];
const EMAIL_WORDS = ['deceased', 'do_not_contact', 'unsubscribed', 'suppressed', 'do_not_email'];
// The three reasons as columns of a page's rows (p: the page, after its
// limit, so they are worked out for those rows only). Calls as the call
// sender; email and text as a send to a list — not the newsletter, whose
// "no consent" would mark everyone not subscribed.
const WHY = `${whyNotSql('call', 'bank', person('p', '$1'))} as why_call,
  ${whyNotSql('email', 'list', person('p', '$1'))} as why_email,
  ${whyNotSql('text', 'list', person('p', '$1'))} as why_text`;
export const noContact = (r) => {
  const codes = [r.why_call, r.why_email, r.why_text].filter((c) => WORD.has(c));
  const words = codes.includes('deceased') ? ['Passed away'] : WORDS.filter(([c]) => codes.includes(c)).map(([, w]) => w);
  return {
    words: words.join('; '),
    phone: PHONE_WORDS.includes(r.why_call) ? WORD.get(r.why_call) : null,
    email: EMAIL_WORDS.includes(r.why_email) ? WORD.get(r.why_email) : null,
  };
};
// A page's rows with the reasons: the recipe's own select (inner, which
// carries id, name, email, phone, tags…) wrapped, then extra columns over
// the page only.
const withWhy = (inner, order, extra = '') => `select p.*${extra ? `, ${extra}` : ''}, ${WHY} from (${inner}) p order by ${order}`;
const BASE = 'p.id, p.name, p.first_name, p.last_name, p.email, p.phone, p.tags, p.address, p.unit, p.city, p.postal';
const AZ = azKey('p');

// A finished row: the head's keys, the Do not contact column, and what the
// screen shows in place of a number or address (mask).
const finish = (r, cols) => {
  const nc = noContact(r);
  const [last, first] = lastFirst(r);
  return { id: r.id, last_name: last, first_name: first, ...cols, no_contact: nc.words, mask: { phone: nc.phone, email: nc.email } };
};

// One keyset page of people in A–Z order: rows after the person `after`.
const azPage = (n) => `and (${azAfter('p', n, '>')})`;
const pageOf = (rows, limit, key = (r) => r.id) => ({ rows, next: rows.length === limit && rows.length ? key(rows[rows.length - 1]) : null });

// ── The choices ──
// Each option: its choices in order ([code, words]) and the default; the
// words make "said", the file name and the 400's "Pick one of".
const opt = (choices, dflt, { file = true } = {}) => ({ choices, dflt, file });
const optionsOf = (recipe) => recipe.choices || {};
const parseOptions = (recipe, query) => {
  const shape = {};
  for (const [k, o] of Object.entries(optionsOf(recipe))) {
    shape[k] = z.enum(o.choices.map(([c]) => c)).default(o.dflt);
  }
  const vals = {};
  for (const k of Object.keys(shape)) if (query[k] != null && query[k] !== '') vals[k] = query[k];
  const r = z.object(shape).safeParse(vals);
  if (!r.success) {
    const k = r.error.issues[0]?.path?.[0];
    const o = optionsOf(recipe)[k];
    throw new Refusal(400, `Pick one of: ${o ? o.choices.map(([, w]) => w).join(', ') : 'the choices shown'}`);
  }
  return r.data;
};
const wordsOf = (recipe, opts, { forFile = false } = {}) => Object.entries(optionsOf(recipe))
  .filter(([k, o]) => !forFile || o.file || opts[k] !== o.dflt)
  .map(([k, o]) => o.choices.find(([c]) => c === opts[k])?.[1]).filter(Boolean);

// ── The recipes ──
const live = 'p.workspace_id = $1 and p.deleted_at is null';

// Donors: one group by person over the period's live gifts.
const donorAgg = (opts, ctx, params) => {
  const y0 = yearStart(ctx);
  let where = '';
  let having = '';
  if (opts.period === 'year') { params.push(y0); where = ` and g.date >= $${params.length}::date`; }
  if (opts.period === 'last_year') {
    params.push(yearStart(ctx, 1)); const a = params.length; params.push(y0);
    where = ` and g.date >= $${a}::date and g.date < $${params.length}::date`;
  }
  // A live gift in an earlier year and none yet this year (Stewardship's
  // lapsed; People's gave=lapsed).
  if (opts.period === 'lapsed') { params.push(y0); having = ` having max(g.date) < $${params.length}::date`; }
  // A monthly gift in the last 45 days; their monthly gifts counted.
  if (opts.period === 'monthly') {
    params.push(addDays(todayOf(ctx), -45));
    where = " and g.cadence = 'monthly'";
    having = ` having max(g.date) >= $${params.length}::date`;
  }
  return `select g.person_id, sum(g.amount_cents)::bigint as total, count(*)::int as gifts, min(g.date) as first_gift, max(g.date) as last_gift,
      (array_agg(g.amount_cents order by g.date desc, g.created_at desc))[1]::bigint as last_amount
    from gifts g where g.workspace_id = $1 and g.deleted_at is null${where} group by g.person_id${having}`;
};
const donors = {
  title: 'Donors',
  what: 'Who gave, with totals',
  areas: ['data', 'money'],
  choices: {
    period: opt([['year', 'This year'], ['last_year', 'Last year'], ['all', 'All time'], ['lapsed', 'Lapsed'], ['monthly', 'Monthly']], 'year'),
    order: opt([['az', 'A–Z by last name'], ['largest', 'Largest first']], 'az', { file: false }),
  },
  async count(db, ctx, opts) {
    const params = [ctx.workspaceId];
    const r = (await db.query(
      `select count(*)::int as n, coalesce(sum(g.total), 0)::bigint as cents from (${donorAgg(opts, ctx, params)}) g
        join persons p on p.id = g.person_id and ${live}`, params,
    )).rows[0];
    return { count: r.n, extra: { cents: Number(r.cents) } };
  },
  async rows(db, ctx, opts, { after = null, limit = PAGE_MAX } = {}) {
    const params = [ctx.workspaceId];
    const agg = donorAgg(opts, ctx, params);
    let cond = '';
    const largest = opts.order === 'largest';
    if (after && largest) {
      const m = /^(\d+)\.([0-9a-f-]{36})$/i.exec(after);
      if (!m || !UUID.test(m[2])) throw new Refusal(400, 'That page is gone — start again');
      params.push(m[1]); const c = params.length; params.push(m[2]);
      cond = `and (g.total < $${c}::bigint or (g.total = $${c}::bigint and (${azAfter('p', params.length, '>')})))`;
    } else if (after) {
      if (!UUID.test(after)) throw new Refusal(400, 'That page is gone — start again');
      params.push(after); cond = azPage(params.length);
    }
    const order = largest ? `p.total desc, ${AZ}` : AZ;
    params.push(limit); const lim = params.length;
    params.push(yearStart(ctx)); const y0 = params.length;
    params.push(addDays(todayOf(ctx), -45)); const m45 = params.length;
    const inner = `select ${BASE}, g.total, g.gifts, g.first_gift, g.last_gift, g.last_amount
      from (${agg}) g join persons p on p.id = g.person_id and ${live}
      where true ${cond} order by ${largest ? `g.total desc, ${AZ}` : AZ} limit $${lim}`;
    // This year's total and the latest monthly gift: the tier (shared/canvass.js
    // donorTier), for a campaign that names tiers (lib/preset.js); else no column.
    const extra = `(select coalesce(sum(y.amount_cents), 0) from gifts y where y.workspace_id = $1 and y.person_id = p.id and y.deleted_at is null and y.date >= $${y0}::date)::bigint as year_cents,
      (select y.amount_cents from gifts y where y.workspace_id = $1 and y.person_id = p.id and y.deleted_at is null and y.cadence = 'monthly' and y.date >= $${m45}::date
        order by y.date desc, y.created_at desc limit 1)::bigint as monthly_cents`;
    const rows = (await db.query(withWhy(inner, order, extra), params)).rows;
    const tiers = preset().donorTiers;
    const out = rows.map((r) => {
      const tier = donorTier({ yearCents: Number(r.year_cents || 0), monthlyCents: Number(r.monthly_cents || 0) }, tiers);
      return finish(r, {
        total: dollars(r.total), gifts: r.gifts, first_gift: day(r.first_gift), last_gift: day(r.last_gift), last_amount: dollars(r.last_amount),
        monthly: r.monthly_cents ? 'Yes' : '', ...(tiers.length ? { tier: tiers.find((t) => t.key === tier)?.label || '' } : {}),
        phone: r.phone || '', email: r.email || '', address: r.address || '', unit: r.unit || '', city: r.city || '', postal: r.postal || '',
        _total: Number(r.total),
      });
    });
    return pageOf(out, limit, (r) => (largest ? `${r._total}.${r.id}` : r.id));
  },
  head: () => [
    col('last_name', 'Last name', true), col('first_name', 'First name', true), col('total', 'Total', true, 'money'),
    col('gifts', 'Gifts', true, 'count'), col('first_gift', 'First gift', false, 'date'), col('last_gift', 'Last gift', true, 'date'),
    col('last_amount', 'Last amount', true, 'money'), col('monthly', 'Monthly'), ...(brandHas('donorTiers') ? [col('tier', 'Tier')] : []), col('phone', 'Phone', true),
    col('email', 'Email'), col('address', 'Address'), col('unit', 'Unit'), col('city', 'City'), col('postal', 'Postal code'), col('no_contact', 'Do not contact'),
  ],
  filter: (opts) => (opts.period === 'year' ? 'gave=year' : opts.period === 'lapsed' ? 'gave=lapsed' : null),
};
const col = (key, label, print = false, type = 'text') => ({ key, label, print, type });

// "Interested in being a candidate": the profile field, found by its name
// as the paper membership form finds it. Renamed or retired: unavailable.
// Its Member column is there only for a campaign that has a membership.
const candidateField = async (db, ws) => {
  const f = (await db.query(
    `select id from person_fields where workspace_id = $1 and lower(name) = '${CANDIDATE_FIELD}' and retired_at is null order by created_at limit 1`, [ws],
  )).rows[0];
  if (!f) throw new Refusal(409, 'Unavailable — the profile field “Interested in being a candidate” was renamed or taken off');
  return f.id;
};
const MEMBER = `(select case when t.ends_on >= current_date then 'Current' else 'Lapsed' end from member_terms t
      where t.workspace_id = $1 and t.person_id = p.id and t.voided_at is null order by t.ends_on desc limit 1) as member`;
const ROLES = "(select string_agg(distinct r.role, ',') from volunteer_roles r where r.workspace_id = $1 and r.person_id = p.id) as roles";
const roleWords = (s) => (s ? String(s).split(',').map(roleLabel).join('; ') : '');
const running = {
  title: 'Interested in being a candidate',
  what: 'People who said they’d consider running',
  areas: ['data', 'people'],
  async count(db, ctx) {
    const field = await candidateField(db, ctx.workspaceId);
    return { count: (await db.query(
      `select count(*)::int as n from person_field_values v join persons p on p.id = v.person_id and ${live}
        where v.workspace_id = $1 and v.field_id = $2 and v.value = 'true'::jsonb`, [ctx.workspaceId, field],
    )).rows[0].n };
  },
  async rows(db, ctx, opts, { after = null, limit = PAGE_MAX } = {}) {
    const field = await candidateField(db, ctx.workspaceId);
    const params = [ctx.workspaceId, field];
    let cond = '';
    if (after) { if (!UUID.test(after)) throw new Refusal(400, 'That page is gone — start again'); params.push(after); cond = azPage(params.length); }
    params.push(limit);
    const inner = `select ${BASE}, v.updated_at as said_on from person_field_values v join persons p on p.id = v.person_id and ${live}
      where v.workspace_id = $1 and v.field_id = $2 and v.value = 'true'::jsonb ${cond} order by ${AZ} limit $${params.length}`;
    const members = brandHas('membership');
    const rows = (await db.query(withWhy(inner, AZ, members ? `${MEMBER}, ${ROLES}` : ROLES), params)).rows;
    const tz = tzOf(ctx);
    return pageOf(rows.map((r) => finish(r, {
      phone: r.phone || '', email: r.email || '', address: r.address || '', city: r.city || '', postal: r.postal || '',
      ...(members ? { member: r.member || '' } : {}), volunteers_as: roleWords(r.roles), said_on: dayIn(r.said_on, tz),
    })), limit);
  },
  head: () => [
    col('last_name', 'Last name', true), col('first_name', 'First name', true), col('phone', 'Phone', true), col('email', 'Email', true),
    col('address', 'Address'), col('city', 'City'), col('postal', 'Postal code'), ...(brandHas('membership') ? [col('member', 'Member', true)] : []),
    col('volunteers_as', 'Volunteers as'), col('said_on', 'Said so on', true, 'date'), col('no_contact', 'Do not contact'),
  ],
  filter: async (opts, db, ctx) => `field=${await candidateField(db, ctx.workspaceId)}:yes`,
};

// An id set already in A–Z order (Volunteers, Moved): read once per request
// (azIds); a page is the slice after `after`, its rows read a thousand ids
// at a time — never the whole set in one query, which a big campaign's
// volunteers would make a very long one.
const ID_CHUNK = 1000;
const azIds = async (db, where, params) => (await db.query(
  `select p.id from persons p where ${live} and ${where} order by ${AZ}`, params,
)).rows.map((r) => r.id);
// Where a page starts: after `after`. A Sheets export reads the set again
// for each part, and the row it stopped at may have left it since (a new
// address, a role taken off): then the set's rows that sort before it, in
// the set's own order (order: ids → that order, with `after` among them).
const GONE = 'That page is gone — start again';
const startAfter = async (ids, after, order) => {
  if (!after) return 0;
  const at = ids.indexOf(after);
  if (at >= 0) return at + 1;
  const all = await order([...ids, after]);
  const place = all.indexOf(after);
  if (place < 0) throw new Refusal(400, GONE);
  return place;
};
const inAz = (db, ctx) => async (ids) => (await db.query(
  `select p.id from persons p where p.workspace_id = $1 and p.id = any($2::uuid[]) order by ${AZ}`, [ctx.workspaceId, ids],
)).rows.map((r) => r.id);
const idPage = async (db, ctx, ids, { after, limit }, extra) => {
  const from = await startAfter(ids, after, inAz(db, ctx));
  const slice = ids.slice(from, from + limit);
  const rows = [];
  for (let i = 0; i < slice.length; i += ID_CHUNK) {
    const inner = `select ${BASE} from persons p where ${live} and p.id = any($2::uuid[])`;
    rows.push(...(await db.query(withWhy(inner, AZ, extra), [ctx.workspaceId, slice.slice(i, i + ID_CHUNK)])).rows);
  }
  return { rows, next: from + limit < ids.length && slice.length ? slice[slice.length - 1] : null };
};

const volunteers = {
  title: 'Volunteers',
  what: 'Names, phones and what they do',
  areas: ['data', 'shifts'],
  choices: { role: opt([['all', 'Everyone'], ...VOLUNTEER_ROLES.map((r) => [r.code, r.label])], 'all') },
  // The chips: Everyone, then the roles someone holds (and the one in
  // force), in VOLUNTEER_ROLES order. Any role is still a valid choice.
  async chipsFor(db, ctx, opts) {
    const held = new Set((await db.query('select distinct role from volunteer_roles where workspace_id = $1', [ctx.workspaceId])).rows.map((r) => r.role));
    held.add(opts.role);
    const o = this.choices.role;
    return { role: { ...o, choices: o.choices.filter(([c]) => c === 'all' || held.has(c)) } };
  },
  // The roster's own union (ext/volunteers VOLUNTEER_IDS_SQL), with no cap.
  // Its tag arm reads persons once; a role reads volunteer_roles alone.
  idsFor: (db, ctx, opts) => (opts.role === 'all'
    ? azIds(db, `p.id in (${VOLUNTEER_IDS_SQL})`, [ctx.workspaceId])
    : azIds(db, 'p.id in (select r.person_id from volunteer_roles r where r.workspace_id = $1 and r.role = $2)', [ctx.workspaceId, opts.role])),
  async count(db, ctx, opts) { return { count: (await this.idsFor(db, ctx, opts)).length }; },
  async rows(db, ctx, opts, { after = null, limit = PAGE_MAX, ids } = {}) {
    const set = ids || await this.idsFor(db, ctx, opts);
    const { rows, next } = await idPage(db, ctx, set, { after, limit }, `${ROLES},
      (select count(*)::int from shift_assignments a where a.workspace_id = $1 and a.person_id = p.id and a.status = 'completed') as shifts_done,
      (select s.starts_at from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
        where a.workspace_id = $1 and a.person_id = p.id and a.status in ('assigned', 'confirmed') and s.starts_at > now() order by s.starts_at limit 1) as next_at,
      (select s.title from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
        where a.workspace_id = $1 and a.person_id = p.id and a.status in ('assigned', 'confirmed') and s.starts_at > now() order by s.starts_at limit 1) as next_title`);
    const tz = tzOf(ctx);
    return { next, rows: rows.map((r) => finish(r, {
      phone: r.phone || '', email: r.email || '', roles: roleWords(r.roles), shifts_done: r.shifts_done,
      next_shift: r.next_at ? `${dayIn(r.next_at, tz)} ${r.next_title}` : '',
    })) };
  },
  head: () => [
    col('last_name', 'Last name', true), col('first_name', 'First name', true), col('phone', 'Phone', true), col('email', 'Email'),
    col('roles', 'Roles', true), col('shifts_done', 'Shifts done', false, 'count'), col('next_shift', 'Next shift', true), col('no_contact', 'Do not contact'),
  ],
};

// Members: each person's latest live term.
const termWhere = (opts, params, ctx) => {
  params.push(todayOf(ctx)); const t = params.length;
  if (opts.who === 'current') return `t.ends_on >= $${t}::date`;
  if (opts.who === 'lapsed') return `t.ends_on < $${t}::date`;
  params.push(addDays(todayOf(ctx), 60));
  return `t.ends_on >= $${t}::date and t.ends_on < $${params.length}::date`;
};
const LATEST_TERM = `(select distinct on (t.person_id) t.person_id, t.ends_on, t.youth, t.source from member_terms t
    where t.workspace_id = $1 and t.voided_at is null order by t.person_id, t.ends_on desc, t.created_at desc) t`;
const members = {
  title: 'Members',
  what: 'Who’s a member and when it ends',
  areas: ['data', 'money'],
  choices: { who: opt([['current', 'Current'], ['ending', 'Ending in 60 days'], ['lapsed', 'Lapsed']], 'current') },
  async count(db, ctx, opts) {
    const params = [ctx.workspaceId];
    const w = termWhere(opts, params, ctx);
    return { count: (await db.query(
      `select count(*)::int as n from ${LATEST_TERM} join persons p on p.id = t.person_id and ${live} where ${w}`, params,
    )).rows[0].n };
  },
  async rows(db, ctx, opts, { after = null, limit = PAGE_MAX } = {}) {
    const params = [ctx.workspaceId];
    const w = termWhere(opts, params, ctx);
    params.push(todayOf(ctx)); const today = params.length;
    let cond = '';
    if (after) { if (!UUID.test(after)) throw new Refusal(400, 'That page is gone — start again'); params.push(after); cond = azPage(params.length); }
    params.push(limit);
    const inner = `select ${BASE}, t.ends_on, t.youth, t.source, (t.ends_on >= $${today}::date) as current
      from ${LATEST_TERM} join persons p on p.id = t.person_id and ${live} where ${w} ${cond} order by ${AZ} limit $${params.length}`;
    const rows = (await db.query(withWhy(inner, AZ), params)).rows;
    return pageOf(rows.map((r) => finish(r, {
      phone: r.phone || '', email: r.email || '', address: r.address || '', city: r.city || '', postal: r.postal || '',
      ends_on: day(r.ends_on), status: r.current ? 'Current' : 'Lapsed', youth: r.youth ? 'Yes' : '',
      joined_by: r.source === 'website' ? 'Website' : r.source === 'paper' ? 'Paper' : '',
    })), limit);
  },
  head: () => [
    col('last_name', 'Last name', true), col('first_name', 'First name', true), col('phone', 'Phone', true), col('email', 'Email'),
    col('address', 'Address'), col('city', 'City'), col('postal', 'Postal code'), col('ends_on', 'Ends on', true, 'date'),
    col('status', 'Status', true), col('youth', 'Youth'), col('joined_by', 'Joined by'), col('no_contact', 'Do not contact'),
  ],
};

// Signs waiting to go up, in walking order (lib/geo.js walkOrder: street by
// street, odd numbers up, even back). The set (at most 5,000) is sorted
// once per request; each page is a slice of it.
const signs = {
  title: 'Signs to put up',
  what: 'Addresses in street order, for the crew',
  areas: ['data', 'signs'],
  choices: { kind: opt([['all', 'All'], ...SIGN_KINDS.map((s) => [s.code, s.label])], 'all') },
  async idsFor(db, ctx, opts) {
    const params = [ctx.workspaceId];
    if (opts.kind !== 'all') params.push(opts.kind);
    const rows = (await db.query(
      `select s.id, s.address from signs s where s.workspace_id = $1 and s.status = 'requested'${opts.kind !== 'all' ? ' and s.kind = $2' : ''}
        order by s.created_at, s.id limit ${SIGNS_MAX + 1}`, params,
    )).rows;
    if (rows.length > SIGNS_MAX) throw new Refusal(409, 'Too many to print at once — choose a kind of sign');
    return walkOrder(rows.map((s) => ({ address: s.address || '', id: s.id }))).map((d) => d.id);
  },
  async count(db, ctx, opts) {
    const params = [ctx.workspaceId];
    if (opts.kind !== 'all') params.push(opts.kind);
    return { count: (await db.query(
      `select count(*)::int as n from signs s where s.workspace_id = $1 and s.status = 'requested'${opts.kind !== 'all' ? ' and s.kind = $2' : ''}`, params,
    )).rows[0].n };
  },
  async rows(db, ctx, opts, { after = null, limit = PAGE_MAX, ids } = {}) {
    const set = ids || await this.idsFor(db, ctx, opts);
    const from = await startAfter(set, after, async (some) => walkOrder((await db.query(
      'select s.id, s.address from signs s where s.workspace_id = $1 and s.id = any($2::uuid[]) order by s.created_at, s.id',
      [ctx.workspaceId, some],
    )).rows.map((x) => ({ address: x.address || '', id: x.id }))).map((d) => d.id));
    const slice = set.slice(from, from + limit);
    if (!slice.length) return { rows: [], next: null };
    const rows = (await db.query(
      `select p.*, ${WHY} from (select s.id as sign_id, s.address as sign_address, s.kind, s.note, s.created_at,
          x.id, x.name, x.email, x.phone, x.tags
        from signs s left join persons x on x.id = s.person_id and x.workspace_id = s.workspace_id and x.deleted_at is null
        where s.workspace_id = $1 and s.id = any($2::uuid[])) p`,
      [ctx.workspaceId, slice],
    )).rows;
    const byId = new Map(rows.map((r) => [r.sign_id, r]));
    const tz = tzOf(ctx);
    const out = slice.map((id) => byId.get(id)).filter(Boolean).map((r) => {
      const nc = noContact(r);
      return {
        id: r.sign_id, person_id: r.id || null, address: r.sign_address || '', kind: signLabel(r.kind), name: r.name || '',
        phone: r.phone || '', note: r.note || '', asked_on: dayIn(r.created_at, tz), no_contact: nc.words, mask: { phone: nc.phone, email: nc.email },
      };
    });
    return { rows: out, next: from + limit < set.length ? slice[slice.length - 1] : null };
  },
  head: () => [
    col('address', 'Address', true), col('kind', 'Kind', true), col('name', 'Name', true), col('phone', 'Phone', true),
    col('note', 'Note', true), col('asked_on', 'Asked on', false, 'date'), col('no_contact', 'Do not contact'),
  ],
};

// Marked Moved at the door with no new address yet: ext/moves's own set
// ("Needs an address"), read once per request and paged A–Z.
const moved = {
  title: 'Moved — needs an address',
  what: 'Marked Moved at the door, no new address yet',
  areas: ['data', 'people'],
  // movedOpenWhere is the one fragment behind movedOpenIds, People's
  // moved=open and movedCounts; read here in A–Z order.
  idsFor: (db, ctx) => azIds(db, movedOpenWhere('p', '$1'), [ctx.workspaceId]),
  async count(db, ctx) { return { count: (await movedCounts(db, ctx.workspaceId)).open }; },
  async rows(db, ctx, opts, { after = null, limit = PAGE_MAX, ids } = {}) {
    const set = ids || await this.idsFor(db, ctx, opts);
    const { rows, next } = await idPage(db, ctx, set, { after, limit }, `(select max(c.created_at) from contacts c
        where c.workspace_id = $1 and c.person_id = p.id and c.outcome = 'moved' and c.source is null) as marked_at`);
    const tz = tzOf(ctx);
    return { next, rows: rows.map((r) => finish(r, {
      address: [r.unit, r.address].filter(Boolean).join('-'), phone: r.phone || '', marked_on: dayIn(r.marked_at, tz),
    })) };
  },
  head: () => [
    col('last_name', 'Last name', true), col('first_name', 'First name', true), col('address', 'Address on file', true),
    col('phone', 'Phone', true), col('marked_on', 'Marked Moved on', true, 'date'), col('no_contact', 'Do not contact'),
  ],
  filter: () => 'moved=open',
};

// The walking list has its own read (below); here for the menu.
const walk = { title: 'Walking list', what: 'A turf’s doors in walking order, to print', areas: ['map'] };

export const RECIPES = { walk, donors, running, volunteers, members, signs, moved };
// The reports this campaign has: Members only where there is a membership
// (lib/preset.js), asked each time. Every read below goes through these two.
const hasRecipe = (name) => Object.hasOwn(RECIPES, name) && (name !== 'members' || brandHas('membership'));
const recipesNow = () => Object.entries(RECIPES).filter(([name]) => hasRecipe(name));

// ── Who may pull what ──
const mayPull = (ctx, recipe) => {
  const mine = areasFor(ctx);
  return recipe.areas.every((a) => mine.includes(a));
};
const guard = (c, recipe) => {
  const ctx = c.get('ctx');
  if (!DESK.includes(ctx.role)) return c.json({ error: 'desk only' }, 403);
  if (recipe && !mayPull(ctx, recipe)) return c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);
  return null;
};
const answer = (c, e) => {
  if (e instanceof Refusal) return c.json({ error: e.message }, e.status);
  throw e;
};

// ── The walking list ──
const noContactTag = (tags) => (tagsOf(tags).some((t) => String(t).toLowerCase() === 'do-not-contact') ? 'Do not contact' : null);
// Street and Number the way the People export takes them: the address
// minus its house number, capitals kept.
const streetOf = (address, number) => {
  const a = String(address || '');
  return number && a.startsWith(`${number} `) ? a.slice(String(number).length + 1) : a;
};
const ratingText = (scale, code) => {
  if (!code) return null;
  const step = scale?.steps?.find((s) => s.code === code);
  if (step) return step.word;
  const cand = scale?.candidates?.find((x) => x.code === code);
  return cand ? `Voting for ${cand.name}` : code;
};
const walkSheet = async (db, ctx, query) => {
  const id = String(query.turf || '');
  if (!UUID.test(id)) throw new Refusal(404, 'not found');
  const t = (await db.query('select * from turfs where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId])).rows[0];
  if (!t) throw new Refusal(404, 'not found');
  const doorsOpt = String(query.doors || '');
  if (doorsOpt && !['left', 'all'].includes(doorsOpt)) throw new Refusal(400, 'Pick one of: Still to knock, Every door');
  const polygon = typeof t.polygon === 'string' ? JSON.parse(t.polygon) : (t.polygon || []);
  const { walkFor, boxOf } = await walkRoute();
  const box = boxOf(polygon);
  // The map's own box count first, so a turf drawn round the city is
  // refused before anyone in it is read.
  if (box) {
    const n = (await db.query(
      'select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and lat between $2 and $4 and lng between $3 and $5',
      [ctx.workspaceId, ...box],
    )).rows[0].n;
    if (n > WALK_BOX_MAX) throw new Refusal(409, 'This turf is too big to print — split it on the map');
  }
  const w = box ? await walkFor(db, ctx, t, { names: true }) : { doors: [], pass: null };
  const scale = await loadScale(db, ctx.workspaceId).catch(() => null);
  // Still to knock is the default while a pass is open; with none, every door.
  const doors = w.pass ? (doorsOpt || 'left') : 'all';
  const kept = w.doors.filter((d) => doors === 'all' || d.state === 'open' || d.state === 'again');
  const shown = kept.slice(0, WALK_DOORS_MAX);
  const out = shown.map((d) => {
    // The stored number, else the one on the front of the address: people
    // saved before the column existed (and the sample data) have only that.
    const number = d.persons.find((p) => p.house_number)?.house_number || civic({ address: d.address }).house_number || '';
    return {
      address: d.address || '', unit: d.unit || '', house_number: number, street: streetOf(d.address, number), state: d.state,
      // Never an email, a phone, a tag or a contact column on paper.
      persons: d.persons.map((p) => ({
        id: p.id, name: p.name, first_name: p.first_name || '', last_name: p.last_name || '',
        rating: p.rating || null, rating_word: ratingText(scale, p.rating), voted_at: p.voted_at || null, no_contact: noContactTag(p.tags),
      })),
    };
  });
  return {
    turf: { id: t.id, name: t.name },
    pass: w.pass ? { id: w.pass.id, name: w.pass.name } : null,
    doors_shown: doors,
    doors: out,
    more: kept.length > shown.length ? kept.length - shown.length : 0,
    counts: { doors: out.length, people: out.reduce((n, d) => n + d.persons.length, 0) },
    scale: {
      steps: (scale?.steps || []).map((s) => ({ code: s.code, word: s.word })),
      candidates: (scale?.candidates || []).filter((x) => !x.off).map((x) => ({ code: x.code, name: x.name })),
    },
    printed_at: new Date().toISOString(),
    campaign: ctx.workspace?.name || '',
  };
};
const DOOR_WORDS = { open: 'To knock', again: 'Try again', done: 'Done' };
const WALK_HEAD = ['Street', 'Number', 'Unit', 'Last name', 'First name', 'Support', 'Support code', 'Voted', 'Do not contact', 'Door'];

// ── The routes ──
export const mountQuick = (api) => {
  api.get('/quick-reports-menu', (c) => {
    const no = guard(c); if (no) return no;
    const ctx = c.get('ctx');
    return c.json({ reports: recipesNow().map(([name, r]) => ({ name, title: r.title, what: r.what, can: mayPull(ctx, r) })) });
  });

  // The walking list (Map alone: no phone, no email, one turf).
  api.get('/quick-reports/walk', async (c) => {
    const no = guard(c, walk); if (no) return no;
    try { return c.json(await walkSheet(c.get('db'), c.get('ctx'), c.req.query())); } catch (e) { return answer(c, e); }
  });
  api.get('/quick-reports/walk.csv', async (c) => {
    const no = guard(c, walk); if (no) return no;
    const ctx = c.get('ctx');
    let s;
    try { s = await walkSheet(c.get('db'), ctx, c.req.query()); } catch (e) { return answer(c, e); }
    const rows = s.doors.flatMap((d) => [...d.persons].sort(azSort).map((p) => {
      const [last, first] = lastFirst(p);
      return [d.street, d.house_number, d.unit, last, first, p.rating_word || '', p.rating || '', p.voted_at ? 'Yes' : '', p.no_contact || '', DOOR_WORDS[d.state] || ''];
    }));
    // A cut file never looks whole.
    // The turf's name cut short, so the ending always fits csvFileName's 60.
    const name = `walking-list-${String(s.turf.name).slice(0, s.more ? 17 : 36)}-${todayOf(ctx)}${s.more ? '-first-1500-doors' : ''}`;
    return csvResponse(c, name, WALK_HEAD, rows);
  });
  api.get('/quick-reports/walk/unplaced', async (c) => {
    const no = guard(c, walk); if (no) return no;
    // The map's own "not on the map" count, campaign-wide.
    return c.json({ count: (await c.get('db').query(
      'select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and address is not null and lat is null',
      [c.get('ctx').workspaceId],
    )).rows[0].n });
  });

  const recipeOf = (c) => {
    const name = c.req.param('name').replace(/\.csv$/, '');
    return name !== 'walk' && hasRecipe(name) ? [name, RECIPES[name]] : [name, null];
  };

  api.get('/quick-reports/:name/count', async (c) => {
    const [, r] = recipeOf(c);
    if (!r) { const no = guard(c); return no || c.json({ error: 'no such report' }, 404); }
    const no = guard(c, r); if (no) return no;
    try {
      const opts = parseOptions(r, c.req.query());
      return c.json(await r.count(c.get('db'), c.get('ctx'), opts));
    } catch (e) { return answer(c, e); }
  });

  api.get('/quick-reports/:name', async (c) => {
    const [name, r] = recipeOf(c);
    if (!r) { const no = guard(c); return no || c.json({ error: 'no such report' }, 404); }
    const no = guard(c, r); if (no) return no;
    const db = c.get('db'); const ctx = c.get('ctx');
    const csv = c.req.param('name').endsWith('.csv');
    try {
      const opts = parseOptions(r, c.req.query());
      const head = r.head(opts);
      if (csv) {
        const gen = pages(db, ctx, r, opts);
        // The first page before the response, so a refusal (a renamed
        // field, too many signs) is its own answer, not a broken file.
        const first = await gen.next();
        const rest = (async function* () { if (!first.done) { yield first.value; yield* gen; } })();
        const file = [r.title, ...wordsOf(r, opts, { forFile: true }), todayOf(ctx)].join('-');
        return csvStream(c, file, head.map((h) => h.label), (async function* () {
          for await (const rows of rest) yield rows.map((x) => head.map((h) => x[h.key] ?? ''));
        })());
      }
      const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(c.req.query('limit')) || PAGE_MAX)));
      const after = c.req.query('after') || null;
      const ids = r.idsFor ? await r.idsFor(db, ctx, opts) : undefined;
      const page = await r.rows(db, ctx, opts, { after, limit, ids });
      const total = ids ? ids.length : (await r.count(db, ctx, opts)).count;
      const said = wordsOf(r, opts).join(' · ');
      return c.json({
        name, title: r.title, said, head, total, next: page.next,
        // The chips: each option's choices in words, and the one in force.
        options: Object.entries(r.chipsFor ? await r.chipsFor(db, ctx, opts) : optionsOf(r)).map(([key, o]) => ({ key, value: opts[key], choices: o.choices.map(([code, words]) => ({ code, words })) })),
        // On screen, the words in place of a number or address someone
        // asked not to be reached at (the CSV keeps them, with the column).
        rows: page.rows.map(({ mask, _total, ...x }) => ({
          ...x,
          ...(mask?.phone && 'phone' in x ? { phone: mask.phone } : {}),
          ...(mask?.email && 'email' in x ? { email: mask.email } : {}),
        })),
        filter: r.filter ? await r.filter(opts, db, ctx) : null,
      });
    } catch (e) { return answer(c, e); }
  });
};

// Every page of a recipe, the id set made once.
async function* pages(db, ctx, r, opts) {
  const ids = r.idsFor ? await r.idsFor(db, ctx, opts) : undefined;
  let after = null;
  do {
    const page = await r.rows(db, ctx, opts, { after, limit: PAGE_MAX, ids });
    yield page.rows;
    after = page.next;
  } while (after);
}

// ── Google Sheets (ext/drive) ──
// A quick report as "Send to Google Sheets"'s fourth source. ref is
// "<name>?<options>" (the screen writes them in the recipe's own order).
// The walking list is paper only. A Sheet fills in the background, part by
// part, so it pages by the A–Z keyset, whose order can't shift under it:
// Largest first is refused. Each cell is the CSV's: the number and address
// as stored and the Do not contact column (mask is the screen's alone).
export const SHEETS_AZ_ONLY = 'Choose A–Z to send to Sheets';
export const quickRef = (name, opts = {}) => {
  const r = RECIPES[name];
  const keys = Object.keys(optionsOf(r || {}));
  const q = new URLSearchParams(keys.filter((k) => opts[k] != null).map((k) => [k, opts[k]])).toString();
  return q ? `${name}?${q}` : name;
};
export const quickSource = (db, ctx, ref) => {
  const s = String(ref || '');
  const at = s.indexOf('?');
  const name = at < 0 ? s : s.slice(0, at);
  const r = name !== 'walk' && hasRecipe(name) ? RECIPES[name] : null;
  if (!r) throw new Refusal(404, 'No such report');
  const opts = parseOptions(r, Object.fromEntries(new URLSearchParams(at < 0 ? '' : s.slice(at + 1))));
  if (opts.order === 'largest') throw new Refusal(400, SHEETS_AZ_ONLY);
  const head = r.head(opts);
  // The id set (Volunteers, Signs, Moved), read once for the whole job.
  let ids;
  const idsOnce = async () => {
    if (r.idsFor && ids === undefined) ids = await r.idsFor(db, ctx, opts);
    return ids;
  };
  return {
    area: r.areas,
    name: [r.title, ...wordsOf(r, opts, { forFile: true })].join(' · '),
    count: async () => (await r.count(db, ctx, opts)).count,
    cols: async () => head.length,
    head: async () => head.map((h) => h.label),
    page: async (cursor, limit) => {
      const p = await r.rows(db, ctx, opts, { after: cursor?.after || null, limit: Math.min(limit, PAGE_MAX), ids: await idsOnce() });
      return { rows: p.rows.map((x) => head.map((h) => x[h.key] ?? '')), next: p.next ? { after: p.next } : null };
    },
  };
};
