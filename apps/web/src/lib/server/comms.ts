import "server-only";
import { and, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { emailCampaigns, emailLog, eventRsvps, events, people, shiftOpenings, shifts, smsLog, volunteerTasks } from "@/lib/db/schema";
import { classifyInbound, type InboundIntent } from "@/lib/email/inbound-sms";
import { eventReminderEmail, eventReminderText, shiftReminderEmail, shiftReminderText, STOP_LINE, type ShiftForEmail } from "@/lib/email/notifications";
import type { MessageContext } from "@/lib/email/messages";
import { pacificDate } from "@/lib/ics";
import { addDays, todayInSurrey } from "@/lib/shifts";
import { recordConsent } from "./consent";
import { emailContext, queueEmails, sendQueued, type OutgoingEmail } from "./email";
import { normalizePhone, sendSms } from "./sms";
import { forwardConsentWithdrawal } from "./base-ground-forward";

// What the website still sends itself: transactional email and texts
// (confirmations, receipts, reminders, tracker alerts, sign-in links), the
// replies to inbound texts (STOP and START are consent), and the log of all
// of it. Newsletters, campaign emails and text blasts go out from Base Ground,
// which holds the full list.

// ── Texts ─────────────────────────────────────────────────────────────────

/** People whose phone number, in any format, is this E.164 number. */
async function peopleByPhone(db: Db, phone: string) {
  const digits = phone.replace(/\D/g, "").replace(/^1/, "");
  return db
    .select({ id: people.id, email: people.email, smsConsentAt: people.smsConsentAt })
    .from(people)
    .where(sql`regexp_replace(coalesce(${people.phone}, ''), '\\D', '', 'g') in (${digits}, ${"1" + digits})`);
}

/**
 * Handle a text sent to our number. STOP words withdraw consent; START
 * words restore it; language words set the person's locale. Everything is
 * logged, and the reply goes back as TwiML.
 */
export async function handleInboundSms(db: Db, ctx: MessageContext & { orgPhone?: string }, input: { from: string; body: string; messageSid?: string | null }): Promise<{ intent: InboundIntent; reply: string }> {
  const phone = normalizePhone(input.from);
  const intent = classifyInbound(input.body);
  const matches = phone ? await peopleByPhone(db, phone) : [];
  const ids = matches.map((m) => m.id);
  const now = new Date();
  let reply: string;
  switch (intent.kind) {
    case "stop":
      // Each withdrawal goes to the consent ledger, which also clears smsConsentAt.
      for (const m of matches) await recordConsent(db, { personId: m.id, email: m.email, channel: "sms", purpose: "sms", action: "withdraw", wording: `Texted "${input.body.trim().slice(0, 40)}"`, source: "sms-stop" });
      // Base Ground texts too: the number is opted out there as well, whether or not anyone here has it.
      if (phone) await forwardConsentWithdrawal(db, { personId: matches.length === 1 ? matches[0].id : null, phone, channel: "sms", reason: "stop" });
      reply = `You're opted out of ${ctx.orgName} texts and won't get any more. Reply START to opt back in.`;
      break;
    case "start":
      // A text from the number is proof of control of it, so START may undo an earlier STOP.
      if (ids.length) {
        for (const m of matches) await recordConsent(db, { personId: m.id, email: m.email, channel: "sms", purpose: "sms", action: "grant", wording: `Texted "${input.body.trim().slice(0, 40)}"`, source: "sms-start", verified: true });
        reply = `You're opted in to ${ctx.orgName} texts about events and actions near you. ${STOP_LINE}`;
      } else {
        reply = `Thanks! We don't have this number on file yet. Join at ${ctx.siteUrl}/#join and tick texts to get updates. ${STOP_LINE}`;
      }
      break;
    case "help":
      reply = `${ctx.orgName}: email ${ctx.orgEmail}${ctx.orgPhone ? ` or call ${ctx.orgPhone}` : ""}. More at ${ctx.siteUrl}. ${STOP_LINE}`;
      break;
    case "join":
      reply = `Become a member of ${ctx.orgName}: ${ctx.siteUrl}/#join ${STOP_LINE}`;
      break;
    case "language":
      if (ids.length) await db.update(people).set({ locale: intent.locale, updatedAt: now }).where(inArray(people.id, ids));
      reply = `Got it. We'll send you ${ctx.orgName} updates in ${intent.language} whenever we can. ${STOP_LINE}`;
      break;
    default:
      reply = `Thanks for your message! Find out more at ${ctx.siteUrl}, or reply HELP. ${STOP_LINE}`;
  }
  await db.insert(smsLog).values({
    to: phone ?? input.from.slice(0, 40),
    personId: ids[0] ?? null,
    kind: `inbound-${intent.kind}`,
    body: `Received: ${input.body.trim().slice(0, 500)}\nReplied: ${reply}`,
    status: "sent",
    providerId: input.messageSid ?? null,
    sentAt: now,
  });
  return { intent, reply };
}

// ── Reminders ─────────────────────────────────────────────────────────────


/**
 * The day-before reminders: RSVPs for events starting 20 to 28 hours from
 * now, and shifts dated tomorrow (Pacific). Rows are claimed by setting
 * reminderSentAt first, so two overlapping runs never send twice. Emails
 * are queued and the first batch sent at once; texts go to people who said
 * yes to them.
 */
export async function sendReminders(db: Db, now = new Date()): Promise<{ events: number; shifts: number; texts: number; emails: number }> {
  const ctx = await emailContext();
  const emails: OutgoingEmail[] = [];
  let texts = 0;

  const due = await db
    .select({ rsvp: eventRsvps, event: events, person: { id: people.id, phone: people.phone, smsConsentAt: people.smsConsentAt } })
    .from(eventRsvps)
    .innerJoin(events, eq(events.id, eventRsvps.eventId))
    .leftJoin(people, eq(people.id, eventRsvps.personId))
    // Events on tomorrow's date in Surrey, so a once-a-day run reminds everyone
    // (and the email can honestly say "tomorrow"); more frequent runs are harmless.
    .where(and(isNull(eventRsvps.reminderSentAt), eq(events.published, true), gte(events.startsAt, pacificDate(addDays(todayInSurrey(now), 1), 0)), lt(events.startsAt, pacificDate(addDays(todayInSurrey(now), 2), 0))));
  const claimedRsvps = due.length
    ? new Set(
        (
          await db
            .update(eventRsvps)
            .set({ reminderSentAt: now })
            .where(and(inArray(eventRsvps.id, due.map((d) => d.rsvp.id)), isNull(eventRsvps.reminderSentAt)))
            .returning({ id: eventRsvps.id })
        ).map((r) => r.id),
      )
    : new Set<string>();
  let eventCount = 0;
  for (const d of due) {
    if (!claimedRsvps.has(d.rsvp.id)) continue;
    eventCount += 1;
    const built = eventReminderEmail(ctx, { name: d.rsvp.name, guests: d.rsvp.guests, event: d.event });
    emails.push({ to: d.rsvp.email, ...built, kind: "event-reminder", personId: d.rsvp.personId });
    const phone = d.person?.smsConsentAt ? normalizePhone(d.person.phone) : null;
    if (phone) {
      await sendSms(db, { to: phone, body: eventReminderText(ctx, d.event), kind: "event-reminder", personId: d.rsvp.personId });
      texts += 1;
    }
  }

  const tomorrow = addDays(todayInSurrey(now), 1);
  const dueShifts = await db
    .select({ shift: shifts, person: { id: people.id, email: people.email, firstName: people.firstName, phone: people.phone, smsConsentAt: people.smsConsentAt }, opening: shiftOpenings, task: { name: volunteerTasks.name } })
    .from(shifts)
    .innerJoin(people, eq(people.id, shifts.personId))
    .leftJoin(shiftOpenings, eq(shiftOpenings.id, shifts.openingId))
    .leftJoin(volunteerTasks, eq(volunteerTasks.id, shifts.taskId))
    .where(and(eq(shifts.date, tomorrow), inArray(shifts.status, ["scheduled", "confirmed"]), isNull(shifts.reminderSentAt)));
  const claimedShifts = dueShifts.length
    ? new Set(
        (
          await db
            .update(shifts)
            .set({ reminderSentAt: now })
            .where(and(inArray(shifts.id, dueShifts.map((d) => d.shift.id)), isNull(shifts.reminderSentAt)))
            .returning({ id: shifts.id })
        ).map((r) => r.id),
      )
    : new Set<string>();
  let shiftCount = 0;
  for (const d of dueShifts) {
    if (!claimedShifts.has(d.shift.id)) continue;
    shiftCount += 1;
    const shift: ShiftForEmail = { id: d.shift.id, date: d.shift.date, slot: d.shift.slot, title: d.opening?.title ?? d.task?.name ?? "Volunteer", location: d.opening?.location || null, notes: d.opening?.notes || null };
    const built = shiftReminderEmail(ctx, { firstName: d.person.firstName, shift });
    emails.push({ to: d.person.email, ...built, kind: "shift-reminder", personId: d.person.id });
    const phone = d.person.smsConsentAt ? normalizePhone(d.person.phone) : null;
    if (phone) {
      await sendSms(db, { to: phone, body: shiftReminderText(ctx, shift), kind: "shift-reminder", personId: d.person.id });
      texts += 1;
    }
  }

  await queueEmails(db, emails);
  if (emails.length) await sendQueued(db, 100);
  return { events: eventCount, shifts: shiftCount, texts, emails: emails.length };
}

// ── The log ───────────────────────────────────────────────────────────────

export type LogFilter = { status?: string; kind?: string; q?: string; limit?: number };

const STATUSES = ["queued", "sent", "failed", "skipped"] as const;
type Status = (typeof STATUSES)[number];
const isStatus = (s: string | undefined): s is Status => (STATUSES as readonly string[]).includes(s ?? "");

export async function loadEmailLog(db: Db, f: LogFilter = {}) {
  const conds: SQL[] = [];
  if (isStatus(f.status)) conds.push(eq(emailLog.status, f.status));
  if (f.kind) conds.push(eq(emailLog.kind, f.kind));
  if (f.q) conds.push(or(ilike(emailLog.to, `%${f.q}%`), ilike(emailLog.subject, `%${f.q}%`))!);
  return db
    .select({ id: emailLog.id, to: emailLog.to, kind: emailLog.kind, subject: emailLog.subject, status: emailLog.status, error: emailLog.error, attempts: emailLog.attempts, campaignId: emailLog.campaignId, sentAt: emailLog.sentAt, createdAt: emailLog.createdAt, hasBody: sql<boolean>`${emailLog.html} is not null` })
    .from(emailLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(emailLog.createdAt))
    .limit(f.limit ?? 100);
}

export async function loadSmsLog(db: Db, f: LogFilter = {}) {
  const conds: SQL[] = [];
  if (isStatus(f.status)) conds.push(eq(smsLog.status, f.status));
  if (f.kind) conds.push(eq(smsLog.kind, f.kind));
  if (f.q) conds.push(or(ilike(smsLog.to, `%${f.q}%`), ilike(smsLog.body, `%${f.q}%`))!);
  return db
    .select()
    .from(smsLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(smsLog.createdAt))
    .limit(f.limit ?? 100);
}

export async function logKinds(db: Db): Promise<string[]> {
  const rows = await db.execute<{ kind: string }>(sql`select kind from email_log union select kind from sms_log order by kind`);
  return rows.map((r) => r.kind);
}

/** Campaign emails sent from here before Base Ground took over bulk sending, newest first (read-only history). */
export async function pastCampaigns(db: Db, limit = 50) {
  return db
    .select({ id: emailCampaigns.id, subject: emailCampaigns.subject, status: emailCampaigns.status, recipientCount: emailCampaigns.recipientCount, sentCount: emailCampaigns.sentCount, failedCount: emailCampaigns.failedCount, sentAt: emailCampaigns.sentAt, updatedAt: emailCampaigns.updatedAt })
    .from(emailCampaigns)
    .where(ne(emailCampaigns.status, "draft"))
    .orderBy(desc(emailCampaigns.updatedAt))
    .limit(limit);
}

export async function commsTotals(db: Db) {
  const [row] = (await db.execute(sql`
    select
      (select count(*) from newsletter_subscribers where status = 'subscribed' and confirmed_at is not null)::int as confirmed,
      (select count(*) from newsletter_subscribers where status = 'pending')::int as pending,
      (select count(*) from newsletter_subscribers where status = 'unsubscribed')::int as unsubscribed,
      (select count(*) from people where sms_consent_at is not null and phone is not null)::int as sms_opt_ins,
      (select count(*) from email_log where status = 'queued')::int as queued,
      (select count(*) from email_log where status = 'failed')::int as failed
  `)) as unknown as { confirmed: number; pending: number; unsubscribed: number; sms_opt_ins: number; queued: number; failed: number }[];
  return row;
}
