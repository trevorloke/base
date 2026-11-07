import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import type { Permission } from "./admin-auth";

// Every timestamp an export carries is rendered in Pacific time inside SQL,
// so a spreadsheet opened anywhere reads the same as the admin pages.
export const PACIFIC = "America/Vancouver";
// Inlined as a literal rather than bound as a parameter, so Postgres never has
// to guess the parameter's type inside `at time zone`.
const TZ = sql.raw(`'${PACIFIC}'`);

/** `to_char(<column> at time zone Pacific, 'YYYY-MM-DD HH24:MI')` for a raw column reference. */
export function pacific(column: string): SQL {
  return sql`to_char(${sql.raw(column)} at time zone ${TZ}, 'YYYY-MM-DD HH24:MI')`;
}

export type DatasetOptions = {
  /** Shifts only: first date to include (YYYY-MM-DD). */
  from?: string;
  /** Shifts only: last date to include (YYYY-MM-DD). */
  to?: string;
};

// Each dataset is one flat query, shared by the admin tables and CSV export.
// Column names are the CSV header, so keep them stable.
const QUERIES = {
  members: () => sql`
    select p.first_name, p.last_name, p.email, p.phone, p.address, p.city, p.postal_code, p.neighbourhood,
           p.birthdate::text as birthdate, p.citizenship_status, p.gender, array_to_string(p.languages, '; ') as languages,
           p.student, p.campus, p.issue, p.interest_volunteer, p.interest_lawn_sign,
           m.member_name, m.member_address, m.member_city, m.member_postal_code, m.member_neighbourhood,
           case when m.status = 'active' and m.expires_at <= now() then 'expired' else m.status::text end as status,
           m.voting_eligible, m.fee_cents, ${pacific("m.starts_at")} as starts_at, ${pacific("m.expires_at")} as expires_at, ${pacific("m.created_at")} as created_at
    from memberships m join people p on p.id = m.person_id
    order by m.created_at desc`,
  contributions: () => sql`
    select ${pacific("c.paid_at")} as paid_at, c.contributor_name, p.email, c.contributor_address, c.contributor_city, c.contributor_postal_code,
           c.kind, c.frequency, c.slate, c.fund, c.amount_cents, c.refunded_cents, c.status,
           c.stripe_payment_intent_id, ${pacific("c.created_at")} as created_at
    from contributions c join people p on p.id = c.person_id
    order by coalesce(c.paid_at, c.created_at) desc`,
  monthly_donors: () => sql`
    select r.contributor_name, p.email, r.slate_amounts::text as monthly_cents_by_slate, r.status,
           r.stripe_subscription_id, ${pacific("r.created_at")} as created_at, ${pacific("r.cancelled_at")} as cancelled_at
    from recurring_donations r join people p on p.id = r.person_id
    order by r.created_at desc`,
  newsletter: () => sql`
    select email, status, source, ${pacific("subscribed_at")} as subscribed_at, ${pacific("confirmed_at")} as confirmed_at,
           ${pacific("unsubscribed_at")} as unsubscribed_at,
           ${`${env.siteUrl}/newsletter/unsubscribe?token=`}::text || unsubscribe_token as unsubscribe_url
    from newsletter_subscribers order by subscribed_at desc`,
  signatures: () => sql`
    select campaign, first_name, last_name, email, postal_code, neighbourhood, address, phone, answer, source, ${pacific("created_at")} as created_at
    from campaign_signatures order by created_at desc`,
  rsvps: () => sql`
    select e.title as event, ${pacific("e.starts_at")} as starts_at, r.name, r.email, r.guests, r.source,
           ${pacific("r.checked_in_at")} as checked_in_at, ${pacific("r.created_at")} as created_at
    from event_rsvps r join events e on e.id = r.event_id
    order by e.starts_at desc, r.created_at`,
  shifts: (o: DatasetOptions) => sql`
    select s.date::text as date, s.slot, coalesce(nullif(concat_ws(' ', p.first_name, p.last_name), ''), p.email) as volunteer, p.email, p.phone,
           t.name as task, s.status, o.title as opening, ${pacific("s.created_at")} as created_at
    from shifts s join people p on p.id = s.person_id
         left join volunteer_tasks t on t.id = s.task_id
         left join shift_openings o on o.id = s.opening_id
    where (${o.from ?? null}::date is null or s.date >= ${o.from ?? null}::date)
      and (${o.to ?? null}::date is null or s.date <= ${o.to ?? null}::date)
    order by s.date, array_position(array['morning','afternoon','evening'], s.slot::text), volunteer`,
  orders: () => sql`
    select ${pacific("o.created_at")} as created_at, ${pacific("o.paid_at")} as paid_at, o.status, o.email, o.total_cents,
           (select string_agg(i.quantity || ' × ' || i.name, '; ' order by i.name) from order_items i where i.order_id = o.id) as items,
           o.shipping->>'name' as ship_to,
           concat_ws(', ', o.shipping->'address'->>'line1', o.shipping->'address'->>'line2', o.shipping->'address'->>'city',
                     o.shipping->'address'->>'state', o.shipping->'address'->>'postal_code') as ship_address,
           o.shipping->>'phone' as ship_phone, o.stripe_payment_intent_id
    from orders o where o.status <> 'pending_payment'
    order by o.created_at desc`,
} as const;

export type Dataset = keyof typeof QUERIES;
export const DATASETS = Object.keys(QUERIES) as Dataset[];

/** Money datasets hold contributor records; the rest are supporter lists. */
export function datasetPermission(dataset: Dataset): Permission {
  return dataset === "contributions" || dataset === "monthly_donors" || dataset === "orders" ? "money" : "people";
}

export function datasetQuery(dataset: Dataset, options: DatasetOptions = {}): SQL {
  return QUERIES[dataset](options);
}

export async function loadDataset(db: Db, dataset: Dataset, limit?: number, options: DatasetOptions = {}): Promise<Record<string, unknown>[]> {
  const base = datasetQuery(dataset, options);
  const query = limit ? sql`select * from (${base}) t limit ${limit}` : base;
  return (await db.execute(query)) as unknown as Record<string, unknown>[];
}

// ── Dashboard ─────────────────────────────────────────────────────────────

export type DashboardTotals = {
  active_members: number;
  monthly_donors: number;
  raised_this_year_cents: number;
  subscribers: number;
  signatures: number;
  volunteers_this_week: number;
  orders_to_fulfil: number;
};

const PAID = sql`status in ('succeeded', 'refunded', 'refunded_over_limit')`;
// Today's date in Surrey, and the Sunday that starts this week.
const TODAY = sql`(now() at time zone ${TZ})::date`;
const WEEK_START = sql`(${TODAY} - extract(dow from ${TODAY})::int)`;
const YEAR_START = sql`date_trunc('year', now() at time zone ${TZ}) at time zone ${TZ}`;

/**
 * The stat tiles. Each is a distinct count of people (one person with two
 * membership rows is one member) and money is net of refunds, for the
 * Pacific calendar year.
 */
export async function dashboardTotals(db: Db): Promise<DashboardTotals> {
  const [row] = (await db.execute(sql`
    select
      (select count(distinct person_id) from memberships where status = 'active' and expires_at > now())::int as active_members,
      (select count(distinct person_id) from recurring_donations where status = 'active')::int as monthly_donors,
      (select coalesce(sum(amount_cents - refunded_cents), 0) from contributions
         where ${PAID} and paid_at >= ${YEAR_START})::bigint as raised_this_year_cents,
      (select count(*) from newsletter_subscribers where status = 'subscribed')::int as subscribers,
      (select count(*) from campaign_signatures)::int as signatures,
      (select count(distinct person_id) from shifts
         where status <> 'cancelled' and date >= ${WEEK_START} and date < ${WEEK_START} + 7)::int as volunteers_this_week,
      (select count(*) from orders where status = 'paid')::int as orders_to_fulfil
  `)) as unknown as Record<string, number | string>[];
  return {
    active_members: Number(row.active_members),
    monthly_donors: Number(row.monthly_donors),
    raised_this_year_cents: Number(row.raised_this_year_cents),
    subscribers: Number(row.subscribers),
    signatures: Number(row.signatures),
    volunteers_this_week: Number(row.volunteers_this_week),
    orders_to_fulfil: Number(row.orders_to_fulfil),
  };
}

export type WeekPoint = { weekStart: string; newSupporters: number; contributions: number; raisedCents: number };

/** The last 12 weeks (Sunday to Saturday, Pacific), oldest first, for the sparklines. */
export async function weeklyTrend(db: Db, weeks = 12): Promise<WeekPoint[]> {
  const rows = (await db.execute(sql`
    with weeks as (
      select (${WEEK_START} - 7 * s)::date as week_start from generate_series(${weeks - 1}::int, 0, -1) as s
    )
    select w.week_start::text as week_start,
      (select count(*) from people p
         where (p.created_at at time zone ${TZ})::date >= w.week_start
           and (p.created_at at time zone ${TZ})::date < w.week_start + 7)::int as new_supporters,
      (select count(*) from contributions c
         where c.${PAID} and (c.paid_at at time zone ${TZ})::date >= w.week_start
           and (c.paid_at at time zone ${TZ})::date < w.week_start + 7)::int as contributions,
      (select coalesce(sum(c.amount_cents - c.refunded_cents), 0) from contributions c
         where c.${PAID} and (c.paid_at at time zone ${TZ})::date >= w.week_start
           and (c.paid_at at time zone ${TZ})::date < w.week_start + 7)::bigint as raised_cents
    from weeks w order by w.week_start
  `)) as unknown as Record<string, string | number>[];
  return rows.map((r) => ({
    weekStart: String(r.week_start),
    newSupporters: Number(r.new_supporters),
    contributions: Number(r.contributions),
    raisedCents: Number(r.raised_cents),
  }));
}

export type Attention = { failedEmailsToday: number; ordersToFulfil: number; stalePendingMemberships: number; overduePromises: number; deskGiftsToLog: number; starbaseFailed: number };

/** Things an organizer should look at today. */
export async function needsAttention(db: Db): Promise<Attention> {
  const [row] = (await db.execute(sql`
    select
      (select count(*) from email_log where status = 'failed' and created_at >= (${TODAY}::timestamp at time zone ${TZ}))::int as failed_emails_today,
      (select count(*) from orders where status = 'paid')::int as orders_to_fulfil,
      (select count(*) from memberships where status = 'pending_payment' and created_at < now() - interval '1 hour')::int as stale_pending_memberships,
      (select count(*) from tracker_promises where target_date < ${TODAY} and status not in ('kept', 'broken'))::int as overdue_promises,
      (select count(*) from contributions where status in ('succeeded', 'refunded', 'refunded_over_limit') and paid_at is not null and desk_logged_at is null)::int as desk_gifts_to_log,
      (select count(*) from starbase_outbox where status = 'failed')::int as starbase_failed
  `)) as unknown as Record<string, number>[];
  return {
    failedEmailsToday: Number(row.failed_emails_today),
    ordersToFulfil: Number(row.orders_to_fulfil),
    stalePendingMemberships: Number(row.stale_pending_memberships),
    overduePromises: Number(row.overdue_promises),
    deskGiftsToLog: Number(row.desk_gifts_to_log),
    starbaseFailed: Number(row.starbase_failed),
  };
}

// ── Website visits ────────────────────────────────────────────────────────

export type VisitWeek = { visitors: number; views: number };
export type VisitStats = {
  /** The Sunday that starts this week (Pacific), YYYY-MM-DD. */
  weekStart: string;
  thisWeek: VisitWeek;
  lastWeek: VisitWeek;
  /** Last 30 days, by the ?source tag the visit carried: visitors and new supporters recorded with that source. */
  bySource: { source: string; visitors: number; signups: number }[];
  /** Last 30 days, every visit and every new supporter, tagged or not. */
  all30: { visitors: number; signups: number };
  topPages: { path: string; views: number; visitors: number }[];
  referrers: { host: string; visitors: number; views: number }[];
};

/** The window the source, page and referrer tiles cover. */
export const VISIT_DAYS = 30;

// A visitor is one visitor hash on one day: the salt changes daily, so the
// same person on two days counts twice. Counted as distinct (day, hash).
const VISITOR = sql`count(distinct (pv.day::text || pv.visitor_hash))::int`;
const SINCE_DAY = sql`(${TODAY} - ${VISIT_DAYS - 1}::int)`;

/**
 * The four website-visit tiles on the dashboard. Sign-ups by source match a
 * visit's ?source tag against people.source, which the forms record either as
 * the tag itself, "<form>/<tag>" or "volunteer:<tag>".
 */
export async function visitStats(db: Db, limit = 10): Promise<VisitStats> {
  const [[weeks], bySource, [all30], topPages, referrers] = (await Promise.all([
    db.execute(sql`
      select ${WEEK_START}::text as week_start,
        count(distinct (pv.day::text || pv.visitor_hash)) filter (where pv.day >= ${WEEK_START})::int as this_visitors,
        count(*) filter (where pv.day >= ${WEEK_START})::int as this_views,
        count(distinct (pv.day::text || pv.visitor_hash)) filter (where pv.day < ${WEEK_START})::int as last_visitors,
        count(*) filter (where pv.day < ${WEEK_START})::int as last_views
      from page_views pv where pv.day >= ${WEEK_START} - 7 and pv.day < ${WEEK_START} + 7`),
    db.execute(sql`
      with v as (
        select pv.source, ${VISITOR} as visitors from page_views pv
        where pv.day >= ${SINCE_DAY} and pv.source is not null group by pv.source
      )
      select v.source, v.visitors,
        (select count(*) from people p
          where p.created_at >= (${SINCE_DAY}::timestamp at time zone ${TZ})
            and (p.source = v.source or p.source = 'volunteer:' || v.source or right(p.source, length(v.source) + 1) = '/' || v.source))::int as signups
      from v order by v.visitors desc, v.source limit ${limit}`),
    db.execute(sql`
      select (select ${VISITOR} from page_views pv where pv.day >= ${SINCE_DAY}) as visitors,
        (select count(*) from people p where p.created_at >= (${SINCE_DAY}::timestamp at time zone ${TZ}))::int as signups`),
    db.execute(sql`
      select pv.path, count(*)::int as views, ${VISITOR} as visitors from page_views pv
      where pv.day >= ${SINCE_DAY} group by pv.path order by views desc, pv.path limit ${limit}`),
    db.execute(sql`
      select pv.referrer_host as host, ${VISITOR} as visitors, count(*)::int as views from page_views pv
      where pv.day >= ${SINCE_DAY} and pv.referrer_host is not null group by pv.referrer_host order by visitors desc, host limit ${limit}`),
  ])) as unknown as [Record<string, string | number>[], Record<string, string | number>[], Record<string, number>[], Record<string, string | number>[], Record<string, string | number>[]];
  return {
    weekStart: String(weeks.week_start),
    thisWeek: { visitors: Number(weeks.this_visitors), views: Number(weeks.this_views) },
    lastWeek: { visitors: Number(weeks.last_visitors), views: Number(weeks.last_views) },
    bySource: bySource.map((r) => ({ source: String(r.source), visitors: Number(r.visitors), signups: Number(r.signups) })),
    all30: { visitors: Number(all30.visitors), signups: Number(all30.signups) },
    topPages: topPages.map((r) => ({ path: String(r.path), views: Number(r.views), visitors: Number(r.visitors) })),
    referrers: referrers.map((r) => ({ host: String(r.host), visitors: Number(r.visitors), views: Number(r.views) })),
  };
}

// ── CSV ───────────────────────────────────────────────────────────────────

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Neutralize spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvLine(headers: string[], row: Record<string, unknown>): string {
  return headers.map((h) => csvCell(row[h])).join(",") + "\r\n";
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return headers.join(",") + "\r\n" + rows.map((r) => csvLine(headers, r)).join("");
}

const dialect = new PgDialect();
const CURSOR_ROWS = 500;

/**
 * Run a query through a server-side cursor and write it out as CSV, a batch
 * at a time, so an export of the whole supporter list never sits in memory.
 * The statement is described first: a bad query fails here, before any
 * response headers go out, and the header row is known even for no rows.
 */
export async function csvStream(db: Db, query: SQL): Promise<ReadableStream<Uint8Array>> {
  const { sql: text, params } = dialect.sqlToQuery(query);
  const client = (db as unknown as { $client: Sql }).$client;
  const parameters = params as Parameters<Sql["unsafe"]>[1];
  const headers = (await client.unsafe(text, parameters).describe()).columns.map((c) => c.name);
  const encoder = new TextEncoder();
  let batches: AsyncIterator<Record<string, unknown>[]> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(headers.join(",") + "\r\n"));
    },
    async pull(controller) {
      batches ??= client.unsafe(text, parameters).cursor(CURSOR_ROWS)[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>[]>;
      const next = await batches.next();
      if (next.done) {
        controller.close();
        return;
      }
      let chunk = "";
      for (const row of next.value) chunk += csvLine(headers, row);
      controller.enqueue(encoder.encode(chunk));
    },
    async cancel() {
      await batches?.return?.();
    },
  });
}

export function csvResponse(stream: ReadableStream<Uint8Array>, name: string): Response {
  const date = new Date().toLocaleDateString("en-CA", { timeZone: PACIFIC });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="imagine-surrey-${name}-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
}
