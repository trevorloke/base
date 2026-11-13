// Reports and whole tables as rows: what the CSV downloads give
// (ext/reports/api.js) and what "Send to Google Sheets" writes (ext/drive).
//
//   REPORTS[name](db, ws, ctx) → { head, rows }     small: read at once
//   datasetRows(db, ws, name)  → { head, rows }     the whole table (CSV)
//   datasetPage(db, ws, name, { cursor, limit }) → { head, rows, next }
//       one page: people by name (keyset, so a city's voter file pages as
//       fast at the end as at the start); the others, far smaller, by
//       limit/offset over an order with a tie-breaker, so no row is read
//       twice or missed
//   datasetCount(db, ws, name) → rows
// Cells are as read (a Date stays a Date): the CSV and the Sheet each
// write them their own way.
import { loadScale } from '../scale/rules.js';

const j = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const ratingWord = (scale, code) => scale?.steps?.find((s) => s.code === code)?.word || scale?.candidates?.find((x) => x.code === code)?.name || code;

export const REPORTS = {
  // People by rating, the campaign's words on each.
  rating: async (db, ws, ctx) => {
    const scale = await loadScale(db, ws).catch(() => null);
    const rows = (await db.query(
      `select coalesce(rating, 'unrated') as code, count(*)::int as n from persons where workspace_id = $1 and deleted_at is null group by 1 order by 1`, [ws],
    )).rows;
    return { head: ['Rating', 'Code', 'People'], rows: rows.map((r) => [r.code === 'unrated' ? 'Not rated' : ratingWord(scale, r.code), r.code, r.n]) };
  },
  tags: async (db, ws) => ({
    head: ['Tag', 'People'],
    rows: (await db.query(
      `select t.tag, count(*)::int as n from persons p, jsonb_array_elements_text(p.tags) t(tag)
       where p.workspace_id = $1 and p.deleted_at is null group by t.tag order by n desc, t.tag limit 100`, [ws],
    )).rows.map((r) => [r.tag, r.n]),
  }),
  cities: async (db, ws) => ({
    head: ['City', 'People'],
    rows: (await db.query(
      `select coalesce(nullif(trim(city), ''), '(no city)') as city, count(*)::int as n from persons
       where workspace_id = $1 and deleted_at is null group by 1 order by n desc limit 30`, [ws],
    )).rows.map((r) => [r.city, r.n]),
  }),
  'people-by-week': async (db, ws) => ({
    head: ['Week of', 'People added'],
    rows: (await db.query(
      `select date_trunc('week', created_at)::date as week, count(*)::int as n from persons
       where workspace_id = $1 and deleted_at is null and created_at > now() - interval '12 weeks' group by 1 order by 1`, [ws],
    )).rows.map((r) => [day(r.week), r.n]),
  }),
  contacts: async (db, ws) => ({
    head: ['Week of', 'Doors', 'Calls', 'Texts', 'Mainstreeting', 'Reached', 'No answer', 'Refused', 'Lit'],
    rows: (await db.query(
      `select date_trunc('week', created_at)::date as week,
         (count(*) filter (where channel = 'door'))::int as doors, (count(*) filter (where channel = 'phone'))::int as calls,
         (count(*) filter (where channel = 'text'))::int as texts, (count(*) filter (where channel = 'mainstreet'))::int as mainstreet,
         (count(*) filter (where outcome = 'contacted'))::int as reached,
         (count(*) filter (where outcome = 'no_answer'))::int as no_answer, (count(*) filter (where outcome = 'refused'))::int as refused,
         (count(*) filter (where outcome = 'left_lit'))::int as lit
       from contacts where workspace_id = $1 and created_at > now() - interval '8 weeks' group by 1 order by 1`, [ws],
    )).rows.map((r) => [day(r.week), r.doors, r.calls, r.texts, r.mainstreet, r.reached, r.no_answer, r.refused, r.lit]),
  }),
  donations: async (db, ws) => ({
    head: ['Month', 'Gifts', 'Donors', 'Total ($)'],
    rows: (await db.query(
      `select to_char(date, 'YYYY-MM') as month, count(*)::int as gifts, count(distinct person_id)::int as donors, (sum(amount_cents) / 100.0)::numeric(12,2) as total
       from gifts where workspace_id = $1 and deleted_at is null and date >= date_trunc('year', current_date) - interval '1 year' group by 1 order by 1`, [ws],
    )).rows.map((r) => [r.month, r.gifts, r.donors, Number(r.total)]),
  }),
  subscribers: async (db, ws) => ({
    head: ['Month', 'Joined', 'Left'],
    rows: (await db.query(
      `select to_char(created_at, 'YYYY-MM') as month, count(*)::int as joined,
         (count(*) filter (where status = 'unsubscribed'))::int as left_
       from subscriptions where workspace_id = $1 and created_at > now() - interval '12 months' group by 1 order by 1`, [ws],
    )).rows.map((r) => [r.month, r.joined, r.left_]),
  }),
  sends: async (db, ws) => ({
    head: ['Sent', 'Kind', 'Subject', 'To', 'Reached', 'Failed', 'Status'],
    rows: (await db.query(
      `select b.created_at, b.kind, b.subject, b.audience_count, b.status,
         (select count(*) from blast_recipients r where r.blast_id = b.id and r.status = 'sent')::int as sent,
         (select count(*) from blast_recipients r where r.blast_id = b.id and r.status = 'failed')::int as failed
       from blasts b where b.workspace_id = $1 order by b.created_at desc limit 50`, [ws],
    )).rows.map((r) => [r.created_at, r.kind, r.subject, r.audience_count, r.sent, r.failed, r.status]),
  }),
};

// Whole tables, every column a spreadsheet can hold; never a secret token.
// from: the rest of the query after its select list; order: its order,
// ending in a tie-breaker. People's `after` is the keyset ($2, $3).
const PEOPLE_COLS = `p.first_name, p.middle_name, p.last_name, p.name, p.email, p.phone, p.unit, p.house_number,
      case when p.house_number is not null and p.address like p.house_number || ' %' then substr(p.address, length(p.house_number) + 2) else p.address end as street,
      p.address, p.city, p.postal, p.rating, p.rated_at, p.tags, p.lat, p.lng,
      to_char(p.voted_at, 'YYYY-MM-DD') as voted, p.voter_number, p.kind, p.created_at, p.id as _id, lower(p.name) as _key`;
export const DATASETS = {
  // Columns People → Import reads back (a round trip into another campaign).
  people: { sql: `select ${PEOPLE_COLS} from persons p where p.workspace_id = $1 and p.deleted_at is null`,
    order: 'lower(p.name), p.id', keyset: '(lower(p.name), p.id)', tags: true, fields: true,
    count: 'select count(*)::int as n from persons p where p.workspace_id = $1 and p.deleted_at is null' },
  // Everyone who has been a member: each term, paper or website.
  members: { sql: `select p.first_name, p.last_name, p.email, p.phone, p.address, p.city, p.postal,
      m.term_years, to_char(m.starts_on, 'YYYY-MM-DD') as starts_on, to_char(m.ends_on, 'YYYY-MM-DD') as ends_on,
      case when m.ends_on >= current_date then 'current' else 'lapsed' end as status,
      m.youth, m.citizenship, m.source, to_char(m.declaration_on, 'YYYY-MM-DD') as declaration_on
    from member_terms m join persons p on p.id = m.person_id and p.deleted_at is null
    where m.workspace_id = $1 and m.voided_at is null`, order: 'm.ends_on desc, lower(p.name), m.id' },
  volunteers: { sql: `select p.name, p.email, p.phone, string_agg(v.role || coalesce(' (' || nullif(v.detail, '') || ')', ''), '; ' order by v.role) as roles
    from volunteer_roles v join persons p on p.id = v.person_id and p.deleted_at is null where v.workspace_id = $1 group by p.id, p.name, p.email, p.phone`,
  order: 'lower(p.name), p.id' },
  signs: { sql: `select s.address, s.kind, s.status, p.name as supporter, p.phone, s.note, s.lat, s.lng, s.created_at
    from signs s left join persons p on p.id = s.person_id where s.workspace_id = $1`, order: 's.status, s.address, s.id' },
  shifts: { sql: `select s.title, s.starts_at, s.ends_at, s.location, s.role, s.capacity,
      (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status in ('assigned', 'confirmed', 'completed')) as booked
    from shifts s where s.workspace_id = $1 and s.deleted_at is null`, order: 's.starts_at, s.id' },
  // imported: brought in from another tool's file (ext/giftimport) — no receipt was made here; their_receipt: that tool's number for it.
  gifts: { sql: `select p.name as donor, p.email, g.amount_cents / 100.0 as amount, g.date, g.method, g.cadence, coalesce(g.slate, 'council') as slate, g.note, g.flagged, g.flag_reason, g.created_at,
      case when g.attrs->>'source' = 'import' then 'yes' end as imported, g.attrs->>'import_receipt' as their_receipt
    from gifts g join persons p on p.id = g.person_id where g.workspace_id = $1 and g.deleted_at is null`, order: 'g.date desc, g.id' },
  subscribers: { sql: 'select email, name, status, source, created_at, unsubscribed_at from subscriptions where workspace_id = $1', order: 'created_at desc, id' },
  contacts: { sql: `select p.name, c.channel, c.outcome, c.rating, c.note, c.place, u.name as by_name, c.created_at
    from contacts c join persons p on p.id = c.person_id left join users u on u.id = c.created_by where c.workspace_id = $1`, order: 'c.created_at desc, c.id' },
  lists: { sql: `select l.name as list, l.kind, p.name, p.email, p.phone from list_members m join lists l on l.id = m.list_id join persons p on p.id = m.person_id
    where m.workspace_id = $1 and l.deleted_at is null`, order: 'lower(l.name), lower(p.name), m.list_id, m.person_id' },
};
const HIDDEN = ['_id', '_key'];
const cell = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
const fieldCell = (f, v) => (v == null ? '' : Array.isArray(v) ? v.join('; ') : f.kind === 'yesno' ? (v ? 'Yes' : 'No') : cell(v));

// People: then a column per profile field, named as the field (so People →
// Import maps it back by name); Pick several as "Punjabi; Hindi".
const fieldsOf = async (db, ws) => (await db.query(
  'select id, name, kind from person_fields where workspace_id = $1 and retired_at is null order by position, created_at', [ws],
)).rows;
const valuesOf = async (db, ws, personIds = null) => {
  const valueOf = new Map();
  for (const v of (await db.query(
    `select v.person_id, v.field_id, v.value from person_field_values v
       join person_fields f on f.id = v.field_id and f.retired_at is null
      where v.workspace_id = $1${personIds ? ' and v.person_id = any($2::uuid[])' : ''}`, personIds ? [ws, personIds] : [ws],
  )).rows) valueOf.set(`${v.person_id}|${v.field_id}`, v.value);
  return valueOf;
};
const shape = (ds, raw, extra, valueOf) => {
  const head = raw.length ? Object.keys(raw[0]).filter((k) => !HIDDEN.includes(k)) : [];
  return {
    head: [...head, ...extra.map((f) => f.name)],
    rows: raw.map((r) => [
      ...head.map((k) => (k === 'tags' ? j(r[k], []).join('; ') : cell(r[k]))),
      ...extra.map((f) => fieldCell(f, valueOf.get(`${r._id}|${f.id}`))),
    ]),
  };
};

export const datasetRows = async (db, ws, name) => {
  const ds = DATASETS[name];
  const { rows } = await db.query(`${ds.sql} order by ${ds.order}`, [ws]);
  const extra = ds.fields && rows.length ? await fieldsOf(db, ws) : [];
  return shape(ds, rows, extra, extra.length ? await valuesOf(db, ws) : new Map());
};

// cursor: people's { key, id } after the last row sent; the others' offset.
export const datasetPage = async (db, ws, name, { cursor = null, limit = 1000 } = {}) => {
  const ds = DATASETS[name];
  let rows;
  if (ds.keyset) {
    rows = (await db.query(
      `${ds.sql}${cursor ? ` and ${ds.keyset} > ($3::text, $4::uuid)` : ''} order by ${ds.order} limit $2`,
      cursor ? [ws, limit, cursor.key, cursor.id] : [ws, limit],
    )).rows;
  } else {
    rows = (await db.query(`${ds.sql} order by ${ds.order} limit $2 offset $3`, [ws, limit, Number(cursor?.offset) || 0])).rows;
  }
  const extra = ds.fields && rows.length ? await fieldsOf(db, ws) : [];
  const valueOf = extra.length ? await valuesOf(db, ws, rows.map((r) => r._id)) : new Map();
  const last = rows.at(-1);
  const next = rows.length < limit ? null
    : ds.keyset ? { key: last._key, id: last._id } : { offset: (Number(cursor?.offset) || 0) + rows.length };
  return { ...shape(ds, rows, extra, valueOf), next };
};

export const datasetCount = async (db, ws, name) => {
  const ds = DATASETS[name];
  return (await db.query(ds.count || `select count(*)::int as n from (${ds.sql}) x`, [ws])).rows[0].n;
};
// How many columns a page will have (the head of one row, profile fields included).
export const datasetCols = async (db, ws, name) => (await datasetPage(db, ws, name, { limit: 1 })).head.length;
