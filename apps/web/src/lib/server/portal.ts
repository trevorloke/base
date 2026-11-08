import "server-only";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { headers } from "next/headers";
import type { z } from "zod";
import type { Db } from "@/lib/db";
import {
  campaignSignatures,
  campaigns,
  contributions,
  emailLog,
  eventRsvps,
  events,
  memberships,
  newsletterSubscribers,
  people,
  personNotes,
  recurringDonations,
  shiftOpenings,
  shifts,
  volunteerTasks,
} from "@/lib/db/schema";
import { pacificYearMonth, type Slate } from "@/lib/contributions";
import { startOfPacificDay } from "@/lib/dates";
import { esc, layout, paragraph, textVersion } from "@/lib/email/templates";
import { roomLeftCents } from "@/lib/engagement";
import { env } from "@/lib/env";
import { googleCalendarUrl, pacificDate, SLOT_HOURS, type IcsEvent } from "@/lib/ics";
import { todayInSurrey } from "@/lib/shifts";
import { fieldErrors } from "@/lib/validation";
import { ActionError, formToObject, formValues, type ActionState } from "./actions";
import { consentHistory } from "./consent";
import { sendEmail } from "./email";
import { requireMember } from "./member-auth";
import { contributionTotals } from "./payments";
import { limitForYear } from "./limits";
import { ensureReferralCode, type Person } from "./people";
import { getSettings } from "./settings";
import { clientProfile } from "@/seeds/client";

// ── Server actions for supporters ──────────────────────────────────────────

export type RequestMeta = { ip: string | null; userAgent: string | null };

/** The request details worth keeping as proof of consent, from a server action or page. */
export async function requestMetaFromHeaders(): Promise<RequestMeta> {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent")?.slice(0, 300) || null,
  };
}

type Handler<T> = (data: T, ctx: { person: Person; meta: RequestMeta }) => Promise<ActionState | string | void>;

/**
 * Build a server action for the signed-in supporter, the member-side twin of
 * `adminAction`: it loads the session (redirecting to sign-in when there is
 * none), validates the FormData against the schema, and turns thrown errors
 * into form messages instead of a crashed page. No audit log and no
 * permissions: a supporter can only ever touch their own row.
 *
 *   export const savePreferences = memberAction("/me/preferences", schema, async (data, { person }) => "Saved.")
 */
export function memberAction<S extends z.ZodType>(nextPath: string, schema: S, handler: Handler<z.output<S>>) {
  return async (_prev: ActionState, form: FormData): Promise<ActionState> => {
    const person = await requireMember(nextPath);
    const parsed = schema.safeParse(formToObject(form));
    if (!parsed.success) return { ok: false, error: "Please check the highlighted fields.", fields: fieldErrors(parsed.error), values: formValues(form) };
    try {
      const result = await handler(parsed.data, { person, meta: await requestMetaFromHeaders() });
      // Successful saves give the values back too, so the form shows what was saved.
      if (typeof result === "string") return { ok: true, message: result, values: formValues(form) };
      return result ?? { ok: true, values: formValues(form) };
    } catch (err) {
      if (err instanceof ActionError) return { ok: false, error: err.message, fields: err.fields, values: formValues(form) };
      console.error(err);
      return { ok: false, error: "Something went wrong saving that. Nothing was changed. Please try again.", values: formValues(form) };
    }
  };
}

// ── The dashboard ──────────────────────────────────────────────────────────
// Every query here is scoped to one person id. Nothing reads another
// supporter's row, and the referral count is a number, never names.

const ACTIVE_SHIFT = ["scheduled", "confirmed"] as const;

export type MembershipSummary =
  | { status: "active" | "expired"; expiresAt: Date | null; votingEligible: boolean }
  | { status: "none"; pending: boolean };

export async function membershipSummary(db: Db, personId: string, now = new Date()): Promise<MembershipSummary> {
  const rows = await db.select().from(memberships).where(eq(memberships.personId, personId)).orderBy(desc(memberships.createdAt));
  const active = rows.find((m) => m.status === "active" && (!m.expiresAt || m.expiresAt > now));
  if (active) return { status: "active", expiresAt: active.expiresAt, votingEligible: active.votingEligible };
  const past = rows.find((m) => m.status !== "pending_payment");
  if (past) return { status: "expired", expiresAt: past.expiresAt, votingEligible: past.votingEligible };
  return { status: "none", pending: rows.length > 0 };
}

export type GivingSummary = {
  year: number;
  limitCents: number;
  slates: { slate: Slate; givenCents: number; roomLeftCents: number }[];
  rows: { id: string; kind: "donation" | "membership_fee"; frequency: "one_time" | "monthly"; slate: Slate; netCents: number; status: string; paidAt: Date | null }[];
};

/** What this person gave in the current contribution year, Pacific time, net of refunds. */
export async function givingSummary(db: Db, personId: string, now = new Date()): Promise<GivingSummary> {
  const { year } = pacificYearMonth(now);
  const start = pacificDate(`${year}-01-01`, 0);
  const end = pacificDate(`${year + 1}-01-01`, 0);
  const rows = await db
    .select({
      id: contributions.id,
      kind: contributions.kind,
      frequency: contributions.frequency,
      slate: contributions.slate,
      amountCents: contributions.amountCents,
      refundedCents: contributions.refundedCents,
      status: contributions.status,
      paidAt: contributions.paidAt,
    })
    .from(contributions)
    .where(and(eq(contributions.personId, personId), inArray(contributions.status, ["succeeded", "refunded_over_limit", "refunded"]), gte(contributions.paidAt, start), lt(contributions.paidAt, end)))
    .orderBy(desc(contributions.paidAt));
  const given: Record<Slate, number> = { council: 0, school_board: 0 };
  for (const r of rows) given[r.slate] += Math.max(0, r.amountCents - r.refundedCents);

  // The same totals and rule the donate form uses, so "room left" here is what it will accept.
  const totals = await contributionTotals(db, personId, now);
  const limitCents = await limitForYear(year, db);
  const slates = (["council", "school_board"] as Slate[])
    .filter((s) => s === "council" || given[s] > 0 || (totals.yearToDate[s] ?? 0) > 0 || (totals.committed[s] ?? 0) > 0)
    .map((slate) => ({ slate, givenCents: given[slate], roomLeftCents: roomLeftCents(slate, totals, limitCents) }));
  return {
    year,
    limitCents,
    slates,
    rows: rows.map((r) => ({ id: r.id, kind: r.kind, frequency: r.frequency, slate: r.slate, netCents: Math.max(0, r.amountCents - r.refundedCents), status: r.status, paidAt: r.paidAt })),
  };
}

export type MonthlyGift = { monthlyCents: number; canManageBilling: boolean };

export async function monthlyGift(db: Db, person: Person): Promise<MonthlyGift> {
  const rows = await db
    .select({ amounts: recurringDonations.slateAmounts })
    .from(recurringDonations)
    .where(and(eq(recurringDonations.personId, person.id), eq(recurringDonations.status, "active")));
  const monthlyCents = rows.reduce((sum, r) => sum + (r.amounts.council ?? 0) + (r.amounts.school_board ?? 0), 0);
  return { monthlyCents, canManageBilling: Boolean(person.stripeCustomerId) && person.stripeCustomerMode === env.stripeMode };
}

const uidHost = () => new URL(env.siteUrl).hostname;

export type UpcomingShift = {
  id: string;
  date: string;
  slot: "morning" | "afternoon" | "evening";
  status: string;
  title: string;
  task: string | null;
  location: string;
  neighbourhood: string | null;
  start: Date;
  end: Date;
  calendarUrl: string;
};

export async function upcomingShifts(db: Db, personId: string, now = new Date()): Promise<UpcomingShift[]> {
  const rows = await db
    .select({
      id: shifts.id,
      date: shifts.date,
      slot: shifts.slot,
      status: shifts.status,
      task: volunteerTasks.name,
      title: shiftOpenings.title,
      location: shiftOpenings.location,
      neighbourhood: shiftOpenings.neighbourhood,
    })
    .from(shifts)
    .leftJoin(volunteerTasks, eq(volunteerTasks.id, shifts.taskId))
    .leftJoin(shiftOpenings, eq(shiftOpenings.id, shifts.openingId))
    .where(and(eq(shifts.personId, personId), gte(shifts.date, todayInSurrey(now)), inArray(shifts.status, [...ACTIVE_SHIFT])))
    .orderBy(asc(shifts.date), asc(shifts.slot));
  return rows.map((r) => {
    const title = r.title ?? r.task ?? "Volunteer shift";
    const shift = { ...r, title, location: r.location ?? "", start: pacificDate(r.date, SLOT_HOURS[r.slot].start), end: pacificDate(r.date, SLOT_HOURS[r.slot].end) };
    return { ...shift, calendarUrl: googleCalendarUrl(shiftToIcs(shift)) };
  });
}

export function shiftToIcs(s: Omit<UpcomingShift, "calendarUrl">): IcsEvent {
  return {
    uid: `shift-${s.id}@${uidHost()}`,
    title: `${s.title} (${clientProfile.orgName})`,
    start: s.start,
    end: s.end,
    location: s.location || undefined,
    description: [s.task ? `Task: ${s.task}` : null, s.neighbourhood ? `Town centre: ${s.neighbourhood}` : null].filter(Boolean).join("\n") || undefined,
    url: `${env.siteUrl}/me`,
  };
}

export type UpcomingRsvp = { id: string; guests: number; eventId: string; slug: string; title: string; startsAt: Date; endsAt: Date | null; location: string; address: string | null; calendarUrl: string };

export async function upcomingRsvps(db: Db, personId: string, now = new Date()): Promise<UpcomingRsvp[]> {
  const rows = await db
    .select({
      id: eventRsvps.id,
      guests: eventRsvps.guests,
      eventId: events.id,
      slug: events.slug,
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      location: events.location,
      address: events.address,
    })
    .from(eventRsvps)
    .innerJoin(events, eq(events.id, eventRsvps.eventId))
    // Keep today's events (Surrey's day) until the day is over.
    .where(and(eq(eventRsvps.personId, personId), gte(events.startsAt, startOfPacificDay(now))))
    .orderBy(asc(events.startsAt));
  return rows.map((r) => ({ ...r, calendarUrl: googleCalendarUrl(rsvpToIcs(r)) }));
}

export function rsvpToIcs(r: Omit<UpcomingRsvp, "calendarUrl">): IcsEvent {
  return {
    uid: `event-${r.eventId}@${uidHost()}`,
    title: r.title,
    start: r.startsAt,
    end: r.endsAt ?? undefined,
    location: [r.location, r.address].filter(Boolean).join(", ") || undefined,
    description: r.guests > 0 ? `You and ${r.guests} guest${r.guests === 1 ? "" : "s"}.` : undefined,
    url: `${env.siteUrl}/events/${r.slug}`,
  };
}

export type SignedCampaign = { campaign: string; title: string; kind: "petition" | "pledge" | null; createdAt: Date };

export async function signedCampaigns(db: Db, personId: string): Promise<SignedCampaign[]> {
  const rows = await db
    .select({ campaign: campaignSignatures.campaign, createdAt: campaignSignatures.createdAt, title: campaigns.title, kind: campaigns.kind })
    .from(campaignSignatures)
    .leftJoin(campaigns, eq(campaigns.slug, campaignSignatures.campaign))
    .where(eq(campaignSignatures.personId, personId))
    .orderBy(desc(campaignSignatures.createdAt));
  return rows.map((r) => ({ campaign: r.campaign, title: r.title ?? r.campaign, kind: r.kind ?? null, createdAt: r.createdAt }));
}

export type Referral = { code: string; url: string; referredCount: number };

export async function referral(db: Db, personId: string): Promise<Referral> {
  const code = await ensureReferralCode(db, personId);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(people).where(eq(people.referredById, personId));
  return { code, url: `${env.siteUrl}/r/${code}`, referredCount: row?.n ?? 0 };
}

export async function loadPortal(db: Db, person: Person, now = new Date()) {
  const [membership, giving, monthly, shiftsAhead, rsvpsAhead, signed, bring] = await Promise.all([
    membershipSummary(db, person.id, now),
    givingSummary(db, person.id, now),
    monthlyGift(db, person),
    upcomingShifts(db, person.id, now),
    upcomingRsvps(db, person.id, now),
    signedCampaigns(db, person.id),
    referral(db, person.id),
  ]);
  return { membership, giving, monthly, shifts: shiftsAhead, rsvps: rsvpsAhead, signed, referral: bring };
}

/** Everything upcoming for this person, for the calendar feed. */
export async function calendarEvents(db: Db, personId: string, now = new Date()): Promise<IcsEvent[]> {
  const [s, r] = await Promise.all([upcomingShifts(db, personId, now), upcomingRsvps(db, personId, now)]);
  return [...s.map(shiftToIcs), ...r.map(rsvpToIcs)];
}

// ── Your data (PIPA access and deletion requests) ──────────────────────────

/** Everything we hold about this person, as plain data. No email bodies, no other people. */
export async function exportPersonData(db: Db, person: Person) {
  const [memberRows, giving, signatures, rsvps, shiftRows, consent, emails, subscriber, referredCount, recurring] = await Promise.all([
    db.select().from(memberships).where(eq(memberships.personId, person.id)).orderBy(desc(memberships.createdAt)),
    db
      .select({
        id: contributions.id,
        kind: contributions.kind,
        frequency: contributions.frequency,
        slate: contributions.slate,
        fund: contributions.fund,
        amountCents: contributions.amountCents,
        refundedCents: contributions.refundedCents,
        status: contributions.status,
        contributorName: contributions.contributorName,
        contributorAddress: contributions.contributorAddress,
        contributorCity: contributions.contributorCity,
        contributorPostalCode: contributions.contributorPostalCode,
        paidAt: contributions.paidAt,
        createdAt: contributions.createdAt,
      })
      .from(contributions)
      .where(eq(contributions.personId, person.id))
      .orderBy(desc(contributions.createdAt)),
    db
      .select({
        campaign: campaignSignatures.campaign,
        firstName: campaignSignatures.firstName,
        lastName: campaignSignatures.lastName,
        postalCode: campaignSignatures.postalCode,
        address: campaignSignatures.address,
        phone: campaignSignatures.phone,
        answer: campaignSignatures.answer,
        neighbourhood: campaignSignatures.neighbourhood,
        source: campaignSignatures.source,
        createdAt: campaignSignatures.createdAt,
      })
      .from(campaignSignatures)
      .where(eq(campaignSignatures.personId, person.id))
      .orderBy(desc(campaignSignatures.createdAt)),
    db
      .select({ event: events.title, startsAt: events.startsAt, name: eventRsvps.name, guests: eventRsvps.guests, source: eventRsvps.source, checkedInAt: eventRsvps.checkedInAt, createdAt: eventRsvps.createdAt })
      .from(eventRsvps)
      .innerJoin(events, eq(events.id, eventRsvps.eventId))
      .where(eq(eventRsvps.personId, person.id))
      .orderBy(desc(events.startsAt)),
    db
      .select({ date: shifts.date, slot: shifts.slot, status: shifts.status, task: volunteerTasks.name, opening: shiftOpenings.title, createdAt: shifts.createdAt })
      .from(shifts)
      .leftJoin(volunteerTasks, eq(volunteerTasks.id, shifts.taskId))
      .leftJoin(shiftOpenings, eq(shiftOpenings.id, shifts.openingId))
      .where(eq(shifts.personId, person.id))
      .orderBy(desc(shifts.date)),
    consentHistory(db, person.id, 500),
    db
      .select({ subject: emailLog.subject, kind: emailLog.kind, status: emailLog.status, sentAt: emailLog.sentAt, createdAt: emailLog.createdAt })
      .from(emailLog)
      .where(eq(emailLog.to, person.email))
      .orderBy(desc(emailLog.createdAt))
      .limit(1000),
    db.query.newsletterSubscribers.findFirst({
      columns: { status: true, source: true, subscribedAt: true, confirmedAt: true, unsubscribedAt: true },
      where: eq(newsletterSubscribers.email, person.email),
    }),
    db.select({ n: sql<number>`count(*)::int` }).from(people).where(eq(people.referredById, person.id)),
    db
      .select({ slateAmounts: recurringDonations.slateAmounts, status: recurringDonations.status, createdAt: recurringDonations.createdAt, cancelledAt: recurringDonations.cancelledAt })
      .from(recurringDonations)
      .where(eq(recurringDonations.personId, person.id)),
  ]);
  // Internal ids and who referred this person stay out: they are about other records, not about them.
  const { referredById: _referredById, ...profile } = person;
  void _referredById;
  return {
    exportedAt: new Date().toISOString(),
    profile: { ...profile, referredBySomeone: Boolean(person.referredById) },
    memberships: memberRows.map(({ personId: _p, ...m }) => {
      void _p;
      return m;
    }),
    contributions: giving,
    monthlyGifts: recurring,
    signatures,
    rsvps,
    shifts: shiftRows,
    newsletter: subscriber ?? null,
    consentHistory: consent.map(({ personId: _p, ...c }) => {
      void _p;
      return c;
    }),
    emails,
    referrals: { code: person.referralCode, peopleBroughtIn: referredCount[0]?.n ?? 0 },
  };
}

export const DELETION_TAG = "deletion-requested";

/**
 * Record that the supporter asked for their account to be deleted: a tag
 * staff can filter on, a note on the record, and an email to the office.
 * PIPA gives the organization 30 days to respond. Returns whether this was
 * the first request, so the page can avoid sending the office duplicates.
 */
export async function requestDeletion(db: Db, person: Person, now = new Date()): Promise<{ first: boolean; date: string }> {
  const date = now.toLocaleDateString("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "long", day: "numeric" });
  if (person.tags.includes(DELETION_TAG)) return { first: false, date };
  await db
    .update(people)
    .set({ tags: sql`array_append(${people.tags}, ${DELETION_TAG})`, updatedAt: now })
    .where(and(eq(people.id, person.id), sql`not (${people.tags} @> array[${DELETION_TAG}]::text[])`));
  await db.insert(personNotes).values({ personId: person.id, authorId: null, authorName: "The supporter", body: `Deletion requested by the supporter via /me on ${date}` });

  const { org } = await getSettings();
  const to = env.emailReplyTo ?? org.email;
  const subject = `Account deletion request: ${person.email}`;
  const bodyHtml =
    paragraph(`${esc(person.email)} asked on ${esc(date)} for their account to be deleted, from their supporter page.`) +
    paragraph(`Under PIPA, confirm what was done within 30 days. The record is tagged <strong>${esc(DELETION_TAG)}</strong> in the admin.`);
  await sendEmail(db, {
    to,
    subject,
    kind: "deletion-request",
    personId: person.id,
    html: layout({ title: "Deletion request", bodyHtml, siteUrl: env.siteUrl, orgName: org.name, orgEmail: org.email }),
    text: textVersion([`${person.email} asked on ${date} for their account to be deleted.`, `Confirm within 30 days (PIPA). The record is tagged ${DELETION_TAG}.`], { orgName: org.name }),
  });
  return { first: true, date };
}
