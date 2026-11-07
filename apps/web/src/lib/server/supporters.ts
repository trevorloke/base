import "server-only";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  authTokens,
  campaignSignatures,
  consentEvents,
  emailLog,
  eventRsvps,
  memberships,
  newsletterSubscribers,
  orders,
  people,
  personNotes,
  promiseFollows,
  smsLog,
  starbaseOutbox,
} from "@/lib/db/schema";
import { escapeLike, PAGE_SIZE, type PeopleQuery } from "@/components/admin/people/query";
import { pacific, PACIFIC } from "./admin-data";
import { ensureReferralCode } from "./people";
import { normalizePhone } from "./sms";
import { forwardConsentWithdrawal } from "./starbase-forward";

const TZ = sql.raw(`'${PACIFIC}'`);
// Raw query results carry timestamps as text, so the timeline's instant is
// rendered as ISO 8601 in SQL and parsed back into a Date.
const ISO = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
const PAID = sql`status in ('succeeded', 'refunded', 'refunded_over_limit')`;
const YEAR_START = sql`date_trunc('year', now() at time zone ${TZ}) at time zone ${TZ}`;

// Membership state is derived, never trusted from the status column alone:
// an "active" row whose expiry has passed is expired.
const ACTIVE_MEMBERSHIP = sql`exists (select 1 from memberships m where m.person_id = p.id and m.status = 'active' and m.expires_at > now())`;
const PAST_MEMBERSHIP = sql`exists (select 1 from memberships m where m.person_id = p.id and (m.status = 'expired' or (m.status = 'active' and m.expires_at <= now())))`;
const PENDING_MEMBERSHIP = sql`exists (select 1 from memberships m where m.person_id = p.id and m.status = 'pending_payment')`;
const DONATED_THIS_YEAR = sql`exists (select 1 from contributions c where c.person_id = p.id and c.${PAID} and c.paid_at >= ${YEAR_START})`;
const NEWSLETTER_STATUS = sql`(select ns.status::text from newsletter_subscribers ns where ns.email = p.email)`;

// ── The list ──────────────────────────────────────────────────────────────

/** WHERE clauses for a list view, over `people p`. */
function conditions(q: PeopleQuery): SQL[] {
  const c: SQL[] = [];
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    const parts = [sql`p.email ilike ${like}`, sql`concat_ws(' ', p.first_name, p.last_name) ilike ${like}`];
    const postal = q.q.replace(/\s+/g, "").toUpperCase();
    if (/^[A-Z0-9]{3,6}$/.test(postal)) parts.push(sql`replace(upper(coalesce(p.postal_code, '')), ' ', '') like ${`${escapeLike(postal)}%`}`);
    const digits = q.q.replace(/[^0-9]/g, "");
    if (digits.length >= 3 && digits.length >= q.q.replace(/[\s()+.-]/g, "").length) {
      parts.push(sql`regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}`);
    }
    c.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (q.membership === "active") c.push(ACTIVE_MEMBERSHIP);
  if (q.membership === "expired") c.push(sql`(not ${ACTIVE_MEMBERSHIP} and ${PAST_MEMBERSHIP})`);
  if (q.membership === "pending") c.push(sql`(not ${ACTIVE_MEMBERSHIP} and ${PENDING_MEMBERSHIP})`);
  if (q.membership === "none") c.push(sql`(not ${ACTIVE_MEMBERSHIP} and not ${PAST_MEMBERSHIP})`);
  if (q.neighbourhood) c.push(sql`p.neighbourhood = ${q.neighbourhood}`);
  if (q.volunteer) c.push(sql`p.interest_volunteer`);
  if (q.lawnsign) c.push(sql`p.interest_lawn_sign`);
  if (q.tag) c.push(sql`p.tags @> array[${q.tag}]::text[]`);
  if (q.source) c.push(sql`p.source = ${q.source}`);
  if (q.newsletter === "none") c.push(sql`${NEWSLETTER_STATUS} is null`);
  else if (q.newsletter) c.push(sql`${NEWSLETTER_STATUS} = ${q.newsletter}`);
  if (q.sms === "yes") c.push(sql`p.sms_consent_at is not null`);
  if (q.sms === "no") c.push(sql`p.sms_consent_at is null`);
  if (q.donated) c.push(DONATED_THIS_YEAR);
  if (q.language) c.push(sql`(${q.language} ilike any(coalesce(p.languages, '{}')) or p.locale = ${q.language})`);
  return c;
}

function where(q: PeopleQuery): SQL {
  const c = conditions(q);
  return c.length ? sql`where ${sql.join(c, sql` and `)}` : sql``;
}

const NAME_ORDER = sql`lower(coalesce(p.first_name, '')), lower(coalesce(p.last_name, '')), p.email`;

function orderBy(q: PeopleQuery): SQL {
  switch (q.sort) {
    case "oldest":
      return sql`order by p.created_at asc, p.id`;
    case "name":
      return sql`order by ${NAME_ORDER}, p.id`;
    case "email":
      return sql`order by p.email, p.id`;
    case "neighbourhood":
      return sql`order by p.neighbourhood nulls last, ${NAME_ORDER}, p.id`;
    case "updated":
      return sql`order by p.updated_at desc, p.id`;
    default:
      return sql`order by p.created_at desc, p.id`;
  }
}

export type PersonRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  neighbourhood: string | null;
  tags: string[];
  source: string | null;
  interest_volunteer: boolean;
  interest_lawn_sign: boolean;
  /** Pacific, YYYY-MM-DD. */
  created: string;
  /** Pacific, YYYY-MM-DD, when an active membership runs out; null otherwise. */
  active_until: string | null;
  past_member: boolean;
  pending_membership: boolean;
  newsletter_status: string | null;
};

export async function searchSupporters(db: Db, q: PeopleQuery): Promise<{ rows: PersonRow[]; total: number }> {
  const filter = where(q);
  const [rows, [count]] = await Promise.all([
    db.execute(sql`
      select p.id, p.first_name, p.last_name, p.email, p.phone, p.neighbourhood, p.tags, p.source,
             p.interest_volunteer, p.interest_lawn_sign, to_char(p.created_at at time zone ${TZ}, 'YYYY-MM-DD') as created,
             (select to_char(max(m.expires_at) at time zone ${TZ}, 'YYYY-MM-DD') from memberships m
                where m.person_id = p.id and m.status = 'active' and m.expires_at > now()) as active_until,
             ${PAST_MEMBERSHIP} as past_member,
             ${PENDING_MEMBERSHIP} as pending_membership,
             ${NEWSLETTER_STATUS} as newsletter_status
      from people p ${filter} ${orderBy(q)}
      limit ${PAGE_SIZE} offset ${(q.page - 1) * PAGE_SIZE}`),
    db.execute(sql`select count(*)::int as n from people p ${filter}`),
  ]);
  return { rows: rows as unknown as PersonRow[], total: Number((count as unknown as { n: number }).n) };
}

export type Facets = { tags: string[]; sources: string[]; languages: string[] };

/** The values the filter selects offer: every tag, source and language in use. */
export async function filterFacets(db: Db): Promise<Facets> {
  const [tags, sources, languages] = await Promise.all([
    db.execute(sql`select distinct unnest(tags) as v from people order by 1 limit 500`),
    db.execute(sql`select distinct source as v from people where source is not null order by 1 limit 200`),
    db.execute(sql`select distinct v from (select unnest(languages) as v from people union select locale from people where locale is not null) l order by 1 limit 200`),
  ]);
  const values = (rows: unknown) => (rows as { v: string }[]).map((r) => r.v);
  return { tags: values(tags), sources: values(sources), languages: values(languages) };
}

/** Add or remove a tag on everyone a list view matches. Returns how many rows changed. */
export async function bulkTag(db: Db, q: PeopleQuery, tag: string, mode: "add" | "remove"): Promise<number> {
  const has = sql`p.tags @> array[${tag}]::text[]`;
  // Only rows that actually change are touched, so the count is honest.
  const filter = sql.join([...conditions(q), mode === "add" ? sql`not ${has}` : has], sql` and `);
  const result =
    mode === "add"
      ? await db.execute(sql`update people p set tags = array_append(p.tags, ${tag}), updated_at = now() where ${filter}`)
      : await db.execute(sql`update people p set tags = array_remove(p.tags, ${tag}), updated_at = now() where ${filter}`);
  return Number((result as unknown as { count?: number }).count ?? 0);
}

/**
 * The CSV of a list view: the same filter and sort, every matching row,
 * Pacific timestamps. The amount given this year is a column only for
 * viewers with the money permission.
 */
export function supportersExportQuery(q: PeopleQuery, options: { money: boolean } = { money: false }): SQL {
  const donated = options.money
    ? sql`(select coalesce(sum(c.amount_cents - c.refunded_cents), 0) from contributions c
              where c.person_id = p.id and c.${PAID} and c.paid_at >= ${YEAR_START})::int as donated_this_year_cents,`
    : sql``;
  return sql`
    select p.first_name, p.last_name, p.email, p.phone, p.address, p.city, p.province, p.postal_code, p.neighbourhood,
           case when ${ACTIVE_MEMBERSHIP} then 'active' when ${PAST_MEMBERSHIP} then 'expired' when ${PENDING_MEMBERSHIP} then 'pending_payment' else '' end as membership,
           (select to_char(max(m.expires_at) at time zone ${TZ}, 'YYYY-MM-DD') from memberships m
              where m.person_id = p.id and m.status = 'active' and m.expires_at > now()) as membership_expires,
           array_to_string(p.tags, '; ') as tags, p.source, coalesce(${NEWSLETTER_STATUS}, '') as newsletter,
           ${pacific("p.contact_consent_at")} as email_consent_at, ${pacific("p.sms_consent_at")} as sms_consent_at,
           p.interest_volunteer, p.interest_lawn_sign, array_to_string(p.languages, '; ') as languages, p.locale,
           ${donated}
           p.referral_code, ${pacific("p.created_at")} as created_at
    from people p ${where(q)} ${orderBy(q)}`;
}

// ── One supporter ─────────────────────────────────────────────────────────

export type Person = typeof people.$inferSelect;
export type Note = { id: string; body: string; authorName: string | null; createdAt: Date };
export type TimelineEntry = {
  kind: "membership" | "contribution" | "recurring" | "signature" | "rsvp" | "shift" | "order" | "email" | "sms";
  at: Date;
  title: string;
  detail: string | null;
  status: string | null;
  amount_cents: number | null;
  refunded_cents: number | null;
};
export type Referral = { id: string; name: string; email: string; createdAt: Date };
export type PersonProfile = {
  person: Person;
  notes: Note[];
  newsletter: { status: string; subscribedAt: Date; confirmedAt: Date | null; unsubscribedAt: Date | null } | null;
  membership: { status: "active" | "expired" | "pending" | "none"; expiresAt: Date | null; votingEligible: boolean | null };
  donatedThisYearCents: number;
  referralCode: string;
  referredBy: Referral | null;
  referrals: Referral[];
  timeline: TimelineEntry[];
};

const personName = (p: { firstName: string | null; lastName: string | null; email: string }) => [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email;

export function displayName(p: { firstName: string | null; lastName: string | null; email: string }): string {
  return personName(p);
}

/**
 * One supporter's profile. Without the money permission (`money: false`) the
 * amount given this year is 0 and the timeline leaves out contributions,
 * monthly gifts, orders and membership fee amounts.
 */
export async function loadPerson(db: Db, id: string, options: { money: boolean } = { money: false }): Promise<PersonProfile | null> {
  const person = await db.query.people.findFirst({ where: eq(people.id, id) });
  if (!person) return null;
  const refCols = { id: people.id, firstName: people.firstName, lastName: people.lastName, email: people.email, createdAt: people.createdAt };
  const toReferral = (r: { id: string; firstName: string | null; lastName: string | null; email: string; createdAt: Date }): Referral => ({ id: r.id, name: personName(r), email: r.email, createdAt: r.createdAt });

  const [notes, newsletter, membershipRows, donated, referralCode, referredBy, referrals, timeline] = await Promise.all([
    db
      .select({ id: personNotes.id, body: personNotes.body, authorName: personNotes.authorName, createdAt: personNotes.createdAt })
      .from(personNotes)
      .where(eq(personNotes.personId, id))
      .orderBy(desc(personNotes.createdAt)),
    db.query.newsletterSubscribers.findFirst({ where: eq(newsletterSubscribers.email, person.email) }),
    db
      .select({ status: memberships.status, expiresAt: memberships.expiresAt, votingEligible: memberships.votingEligible })
      .from(memberships)
      .where(eq(memberships.personId, id))
      .orderBy(desc(memberships.createdAt)),
    options.money
      ? db.execute(sql`select coalesce(sum(amount_cents - refunded_cents), 0)::int as n from contributions where person_id = ${id} and ${PAID} and paid_at >= ${YEAR_START}`)
      : Promise.resolve([{ n: 0 }]),
    // An anonymized record gets no new share code.
    person.email.endsWith("@invalid") ? Promise.resolve(person.referralCode ?? "") : ensureReferralCode(db, id),
    person.referredById ? db.select(refCols).from(people).where(eq(people.id, person.referredById)).limit(1) : Promise.resolve([]),
    db.select(refCols).from(people).where(eq(people.referredById, id)).orderBy(desc(people.createdAt)).limit(100),
    loadTimeline(db, person, options.money),
  ]);

  const now = Date.now();
  const active = membershipRows.find((m) => m.status === "active" && m.expiresAt && m.expiresAt.getTime() > now);
  const past = membershipRows.find((m) => m.status === "expired" || (m.status === "active" && m.expiresAt && m.expiresAt.getTime() <= now));
  const pending = membershipRows.find((m) => m.status === "pending_payment");
  const membership: PersonProfile["membership"] = active
    ? { status: "active", expiresAt: active.expiresAt, votingEligible: active.votingEligible }
    : past
      ? { status: "expired", expiresAt: past.expiresAt, votingEligible: past.votingEligible }
      : pending
        ? { status: "pending", expiresAt: null, votingEligible: pending.votingEligible }
        : { status: "none", expiresAt: null, votingEligible: null };

  return {
    person,
    notes,
    newsletter: newsletter ? { status: newsletter.status, subscribedAt: newsletter.subscribedAt, confirmedAt: newsletter.confirmedAt, unsubscribedAt: newsletter.unsubscribedAt } : null,
    membership,
    donatedThisYearCents: Number((donated as unknown as { n: number }[])[0]?.n ?? 0),
    referralCode,
    referredBy: referredBy[0] ? toReferral(referredBy[0]) : null,
    referrals: referrals.map(toReferral),
    timeline,
  };
}

/**
 * Everything that happened with this supporter, from nine tables, newest
 * first. Each source contributes the same columns so one ORDER BY sorts them.
 */
async function loadTimeline(db: Db, person: Person, money: boolean): Promise<TimelineEntry[]> {
  const id = person.id;
  // Money rows only for viewers with the money permission.
  const moneyRows = money ? sql`true` : sql`false`;
  const phoneDigits = person.phone ? person.phone.replace(/[^0-9]/g, "").slice(-10) : "";
  const rows = await db.execute(sql`
    select kind, to_char("at" at time zone 'UTC', ${ISO}) as "at", title, detail, status, amount_cents, refunded_cents from (
      select 'membership' as kind, m.created_at as at, 'Membership' as title,
             concat_ws(' · ', case when m.voting_eligible then 'voting' else 'non-voting' end,
                       case when m.expires_at is not null then 'expires ' || to_char(m.expires_at at time zone ${TZ}, 'YYYY-MM-DD') end) as detail,
             case when m.status = 'active' and m.expires_at <= now() then 'expired' else m.status::text end as status,
             case when ${moneyRows} then m.fee_cents end as amount_cents, null::int as refunded_cents
      from memberships m where m.person_id = ${id}
      union all
      select 'contribution', coalesce(c.paid_at, c.created_at),
             case when c.kind = 'membership_fee' then 'Membership fee' when c.frequency = 'monthly' then 'Monthly gift payment' else 'Donation' end,
             concat_ws(' · ', replace(c.slate::text, '_', ' ') || ' slate', nullif(replace(c.fund, '_', ' '), 'general')),
             c.status::text, c.amount_cents, nullif(c.refunded_cents, 0)
      from contributions c where c.person_id = ${id} and ${moneyRows}
      union all
      select 'recurring', r.created_at, 'Monthly gift started',
             concat_ws(' · ', (select string_agg(replace(e.key, '_', ' ') || ' $' || to_char(e.value::int / 100.0, 'FM999,999,990.00'), ', ') from jsonb_each_text(r.slate_amounts) e) || ' a month',
                       case when r.cancelled_at is not null then 'cancelled ' || to_char(r.cancelled_at at time zone ${TZ}, 'YYYY-MM-DD') end),
             r.status::text, (select sum(e.value::int) from jsonb_each_text(r.slate_amounts) e)::int, null
      from recurring_donations r where r.person_id = ${id} and ${moneyRows}
      union all
      select 'signature', s.created_at, case when cp.kind = 'pledge' then 'Signed the pledge: ' else 'Signed the petition: ' end || coalesce(cp.title, s.campaign),
             concat_ws(' · ', s.answer, case when s.source is not null then 'via ' || s.source end), null, null, null
      from campaign_signatures s left join campaigns cp on cp.slug = s.campaign where s.person_id = ${id}
      union all
      select 'rsvp', r.created_at, 'RSVP: ' || e.title,
             concat_ws(' · ', to_char(e.starts_at at time zone ${TZ}, 'YYYY-MM-DD HH24:MI'), case when r.guests > 0 then r.guests || ' guest(s)' end,
                       case when r.source is not null then 'via ' || r.source end),
             case when r.checked_in_at is not null then 'checked in' else null end, null, null
      from event_rsvps r join events e on e.id = r.event_id where r.person_id = ${id}
      union all
      select 'shift', (s.date::timestamp + case s.slot when 'morning' then interval '9 hours' when 'afternoon' then interval '13 hours' else interval '17 hours' end) at time zone ${TZ},
             'Shift: ' || coalesce(t.name, 'volunteering'), concat_ws(' · ', s.date::text, s.slot::text, o.title), s.status::text, null, null
      from shifts s left join volunteer_tasks t on t.id = s.task_id left join shift_openings o on o.id = s.opening_id where s.person_id = ${id}
      union all
      select 'order', coalesce(o.paid_at, o.created_at), 'Shop order',
             (select string_agg(i.quantity || ' × ' || i.name, ', ' order by i.name) from order_items i where i.order_id = o.id), o.status::text, o.total_cents, null
      from orders o where o.person_id = ${id} and ${moneyRows}
      union all
      select 'email', coalesce(l.sent_at, l.created_at), 'Email: ' || l.subject, concat_ws(' · ', l.kind, l.error), l.status::text, null, null
      from email_log l where l.person_id = ${id} or l."to" = ${person.email}
      union all
      select 'sms', coalesce(l.sent_at, l.created_at), 'Text: ' || left(l.body, 90), concat_ws(' · ', l.kind, l.error), l.status::text, null, null
      from sms_log l where l.person_id = ${id} or (${phoneDigits}::text <> '' and right(regexp_replace(l."to", '[^0-9]', '', 'g'), 10) = ${phoneDigits}::text)
    ) t
    order by "at" desc nulls last
    limit 500`);
  return (rows as unknown as (Omit<TimelineEntry, "at"> & { at: string })[]).map((r) => ({ ...r, at: new Date(r.at) }));
}

// ── Tags, notes, anonymization ────────────────────────────────────────────

export async function addTag(db: Db, id: string, tag: string): Promise<void> {
  await db.execute(sql`update people set tags = array_append(tags, ${tag}), updated_at = now() where id = ${id} and not (tags @> array[${tag}]::text[])`);
}

export async function removeTag(db: Db, id: string, tag: string): Promise<void> {
  await db.execute(sql`update people set tags = array_remove(tags, ${tag}), updated_at = now() where id = ${id}`);
}

export async function addNote(db: Db, id: string, author: { id: string; name: string }, body: string): Promise<void> {
  await db.insert(personNotes).values({ personId: id, authorId: author.id, authorName: author.name, body });
}

/**
 * A PIPA deletion request. Personal details are replaced with placeholders
 * and every consent is withdrawn; contribution and recurring-gift rows keep
 * their contributor snapshot because election-financing law requires it.
 * Everything else that holds the address, phone or what was said is scrubbed
 * in the same transaction: the email and text logs are deleted, the consent
 * ledger keeps only what was decided and when, orders lose the address and
 * shipping details, and outstanding sign-in links are deleted.
 * Starbase is then told to stop emailing and texting them (a "deletion"
 * withdrawal); the address and number in it are removed here once sent.
 * Returns the address the record used to have, for the audit entry.
 */
export async function anonymizePerson(db: Db, id: string): Promise<{ previousEmail: string } | null> {
  const person = await db.query.people.findFirst({ where: eq(people.id, id), columns: { id: true, email: true, phone: true } });
  if (!person) return null;
  const email = `anonymized-${id}@invalid`;
  const phones = [person.phone, normalizePhone(person.phone)].filter((p): p is string => Boolean(p));
  await db.transaction(async (tx) => {
    await tx
      .update(people)
      .set({
        email,
        firstName: "Removed",
        lastName: "Supporter",
        phone: null,
        address: null,
        city: null,
        province: null,
        postalCode: null,
        birthdate: null,
        citizenshipStatus: null,
        gender: null,
        languages: null,
        student: false,
        campus: null,
        issue: null,
        interestVolunteer: false,
        interestLawnSign: false,
        contactConsentAt: null,
        smsConsentAt: null,
        tags: [],
        locale: null,
        neighbourhood: null,
        source: null,
        referralCode: null,
        stripeCustomerId: null,
        stripeCustomerMode: null,
        updatedAt: new Date(),
      })
      .where(eq(people.id, id));
    await tx.delete(personNotes).where(eq(personNotes.personId, id));
    // The row stays, unsubscribed, so the count history holds; the address goes.
    await tx
      .update(newsletterSubscribers)
      .set({ email, status: "unsubscribed", unsubscribedAt: sql`coalesce(${newsletterSubscribers.unsubscribedAt}, now())` })
      .where(eq(newsletterSubscribers.email, person.email));
    await tx.delete(emailLog).where(or(eq(emailLog.personId, id), sql`lower(${emailLog.to}) = ${person.email}`));
    await tx.delete(smsLog).where(phones.length ? or(eq(smsLog.personId, id), inArray(smsLog.to, phones)) : eq(smsLog.personId, id));
    // The ledger keeps what was decided and when; not the address or the device.
    await tx
      .update(consentEvents)
      .set({ email, ip: null, userAgent: null })
      .where(or(eq(consentEvents.personId, id), eq(consentEvents.email, person.email)));
    await tx.update(orders).set({ email, shipping: null }).where(or(eq(orders.personId, id), sql`lower(${orders.email}) = ${person.email}`));
    await tx.delete(authTokens).where(eq(authTokens.email, person.email));
    // postal_code is required on signatures, so it becomes empty rather than null.
    await tx
      .update(campaignSignatures)
      .set({ firstName: "Removed", lastName: "Supporter", email, address: null, phone: null, postalCode: "", neighbourhood: null, answer: null, source: null })
      .where(eq(campaignSignatures.personId, id));
    await tx.update(eventRsvps).set({ name: "Removed Supporter", email }).where(eq(eventRsvps.personId, id));
    await tx.update(memberships).set({ memberName: "Removed Supporter", memberAddress: null, memberCity: null, memberPostalCode: null, memberPhone: null }).where(eq(memberships.personId, id));
    // What was queued for the desk carries their details too. Whatever already
    // reached Starbase is removed there by staff (people.starbase_person_id,
    // kept, says which record).
    await tx.delete(starbaseOutbox).where(or(eq(starbaseOutbox.personId, id), sql`${starbaseOutbox.payload} ->> 'email' = ${person.email}`));
    await tx.delete(promiseFollows).where(sql`${promiseFollows.personId} = ${id} or ${promiseFollows.email} = ${person.email}`);
  });
  // Not for a record that was already anonymized: its address is a placeholder.
  if (!person.email.endsWith("@invalid")) {
    await forwardConsentWithdrawal(db, { personId: id, email: person.email, channel: "email", reason: "deletion" });
    if (person.phone) await forwardConsentWithdrawal(db, { personId: id, email: person.email, phone: person.phone, channel: "sms", reason: "deletion" });
  }
  return { previousEmail: person.email };
}

// ── Sources ───────────────────────────────────────────────────────────────

export type SourceRow = { source: string; people: number; signatures: number; rsvps: number; total: number };
export type ReferrerRow = { id: string; name: string; email: string; code: string; recent: number; allTime: number };

/** Where sign-ups came from over the last `days` days, and who brought in the most people. */
export async function sourcesReport(db: Db, days = 90): Promise<{ sources: SourceRow[]; referrers: ReferrerRow[]; referralSignups: number }> {
  const since = sql`now() - make_interval(days => ${days}::int)`;
  const [sources, referrers, [viaReferral]] = await Promise.all([
    db.execute(sql`
      select source, sum(people)::int as people, sum(signatures)::int as signatures, sum(rsvps)::int as rsvps, sum(people + signatures + rsvps)::int as total
      from (
        select coalesce(nullif(source, ''), '(none recorded)') as source, count(*) as people, 0 as signatures, 0 as rsvps from people where created_at >= ${since} group by 1
        union all
        select coalesce(nullif(source, ''), '(none recorded)'), 0, count(*), 0 from campaign_signatures where created_at >= ${since} group by 1
        union all
        select coalesce(nullif(source, ''), '(none recorded)'), 0, 0, count(*) from event_rsvps where created_at >= ${since} group by 1
      ) s
      group by source order by total desc, source limit 100`),
    db.execute(sql`
      select r.id, coalesce(nullif(concat_ws(' ', r.first_name, r.last_name), ''), r.email) as name, r.email, r.referral_code as code,
             count(*) filter (where p.created_at >= ${since})::int as recent, count(*)::int as all_time
      from people p join people r on r.id = p.referred_by_id
      group by r.id order by recent desc, all_time desc, name limit 50`),
    db.execute(sql`select count(*)::int as n from people where referred_by_id is not null and created_at >= ${since}`),
  ]);
  return {
    sources: (sources as unknown as SourceRow[]).map((r) => ({ ...r, people: Number(r.people), signatures: Number(r.signatures), rsvps: Number(r.rsvps), total: Number(r.total) })),
    referrers: (referrers as unknown as (Omit<ReferrerRow, "allTime"> & { all_time: number })[]).map((r) => ({ id: r.id, name: r.name, email: r.email, code: r.code ?? "", recent: Number(r.recent), allTime: Number(r.all_time) })),
    referralSignups: Number((viaReferral as unknown as { n: number }).n),
  };
}
