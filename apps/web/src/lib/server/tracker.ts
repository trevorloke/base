import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { after } from "next/server";
import { getDb, type Db } from "@/lib/db";
import { promiseFollows, trackerAnnouncements, trackerPromises, trackerUpdates, type TrackerSource } from "@/lib/db/schema";
import type { MessageContext } from "@/lib/email/messages";
import { button, esc, layout, paragraph, textVersion } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { STATUS_BY_ID, summarize, type PromiseStatus, type PublicPromiseRecord, type PublicUpdate, type TrackerSummary } from "@/lib/tracker";
import { cached, TAGS } from "./cache";
import { sendEmail } from "./email";
import { notifyPromiseStatusChanged } from "./notifications";
import { findOrCreatePerson } from "./people";
import { forwardFollow } from "./base-ground-forward";
import { consumeToken, createToken, tokenUrl } from "./tokens";

// ── Loaders ────────────────────────────────────────────────────────────────
// Public pages, feeds and the API read through `loadTracker`, which is
// cached under TAGS.tracker; every admin write calls invalidate(TAGS.tracker).
// Results are plain JSON (dates as strings) so a cache hit and a cache miss
// return the same shapes.

export type TrackerPromise = PublicPromiseRecord & { createdAt: string };
export type TrackerUpdate = PublicUpdate;
export type TrackerAnnouncement = { id: string; date: string; dateLabel: string; title: string; commitments: string; sources: TrackerSource[]; createdAt: string };
export type TrackerData = { promises: TrackerPromise[]; announcements: TrackerAnnouncement[]; lastUpdated: string | null };

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Everything the tracker shows, straight from the database. The admin reads this. */
export async function loadTrackerFresh(): Promise<TrackerData> {
  const db = getDb();
  const [promises, updates, announcements] = await Promise.all([
    db.select().from(trackerPromises).orderBy(asc(trackerPromises.number)),
    db.select().from(trackerUpdates).orderBy(desc(trackerUpdates.date), desc(trackerUpdates.createdAt)),
    db.select().from(trackerAnnouncements).orderBy(desc(trackerAnnouncements.date), desc(trackerAnnouncements.createdAt)),
  ]);
  const updatesByPromise = new Map<string, TrackerUpdate[]>();
  for (const u of updates) {
    const list = updatesByPromise.get(u.promiseId) ?? [];
    list.push({ id: u.id, date: u.date, status: u.status, note: u.note, url: u.url, createdAt: u.createdAt.toISOString() });
    updatesByPromise.set(u.promiseId, list);
  }
  return {
    promises: promises.map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      specifics: p.specifics,
      area: p.area,
      status: p.status,
      statusChangedAt: iso(p.statusChangedAt),
      sources: p.sources,
      testKept: p.testKept,
      testPartly: p.testPartly,
      testBroken: p.testBroken,
      testRecord: p.testRecord,
      promisedOn: p.promisedOn,
      targetDate: p.targetDate,
      neighbourhoods: p.neighbourhoods,
      createdAt: p.createdAt.toISOString(),
      updates: updatesByPromise.get(p.id) ?? [],
    })),
    announcements: announcements.map((a) => ({ id: a.id, date: a.date, dateLabel: a.dateLabel, title: a.title, commitments: a.commitments, sources: a.sources, createdAt: a.createdAt.toISOString() })),
    lastUpdated: updates[0]?.date ?? null,
  };
}

/** The tracker as the public site shows it: cached for an hour or until an admin writes. */
export const loadTracker = cached("tracker", [TAGS.tracker], loadTrackerFresh);

export async function promiseByNumber(number: number): Promise<TrackerPromise | undefined> {
  if (!Number.isInteger(number) || number < 1) return undefined;
  return (await loadTracker()).promises.find((p) => p.number === number);
}

export async function trackerSummary(): Promise<TrackerSummary> {
  return summarize((await loadTracker()).promises);
}

export type FeedEntry = TrackerUpdate & { promiseId: string; promiseNumber: number; promiseTitle: string; area: string };

/** The newest updates across every promise, for the RSS feed. */
export async function latestUpdates(limit = 50): Promise<FeedEntry[]> {
  const { promises } = await loadTracker();
  const all: FeedEntry[] = [];
  for (const p of promises) for (const u of p.updates) all.push({ ...u, promiseId: p.id, promiseNumber: p.number, promiseTitle: p.title, area: p.area });
  all.sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));
  return all.slice(0, limit);
}

// ── Admin writes ───────────────────────────────────────────────────────────

/** True for a Postgres unique-constraint error, wrapped by the query builder or not. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

type PromiseInsert = typeof trackerPromises.$inferInsert;

/**
 * Add a promise with the next free number. Two admins adding at once would
 * both compute the same number; the unique index rejects the loser, who
 * simply tries again with the next one.
 */
export async function insertPromise(db: Db, values: Omit<PromiseInsert, "number" | "id" | "createdAt">): Promise<{ id: string; number: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${trackerPromises.number}), 0)::int` }).from(trackerPromises);
    try {
      const [row] = await db
        .insert(trackerPromises)
        .values({ ...values, number: max + 1 })
        .returning({ id: trackerPromises.id, number: trackerPromises.number });
      return row;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("Could not allocate a promise number: too many promises were added at the same time.");
}

/** Tell followers. Never throws: a failed email must not undo the score. */
export async function notifyStatusChange(db: Db, input: { promiseId: string; previous: PromiseStatus; next: PromiseStatus }): Promise<void> {
  if (input.previous === input.next) return;
  try {
    await notifyPromiseStatusChanged(db, input);
  } catch (err) {
    console.error("promise status notification failed", err);
  }
}

// ── Follows ────────────────────────────────────────────────────────────────

const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address"));

/** The follow form, exactly: promise, email, the person's own tick, and the honeypot. */
export const followSchema = z
  .object({
    promiseId: z.uuid("Choose a promise"),
    email,
    consent: z.literal(true, { error: "Please tick the box so we can email you" }),
    website: z.string().max(0).optional(),
  })
  .strict();

export type FollowStatus = "confirmed" | "pending";

/** The one-click unfollow link carried by every follow email (served by the newsletter module). */
export function unfollowUrl(token: string): string {
  return `${env.siteUrl}/api/newsletter/unfollow?token=${encodeURIComponent(token)}`;
}

export function promiseFollowConfirmEmail(ctx: MessageContext, o: { number: number; title: string; confirmUrl: string; unfollowUrl: string }) {
  const subject = `Confirm: follow promise ${o.number} on the ${ctx.orgName} tracker`;
  const bodyHtml =
    paragraph(`You asked to be told when the score of <strong>promise ${o.number}</strong> changes: ${esc(o.title)}.`) +
    button(o.confirmUrl, "Confirm and follow", "navy") +
    paragraph(`One click confirms it. We'll email you only when the score changes, with a link to the record behind it. If you didn't ask for this, ignore this email and nothing more will be sent.`);
  return {
    subject,
    html: layout({
      title: `Follow promise ${o.number}`,
      bodyHtml,
      siteUrl: ctx.siteUrl,
      orgName: ctx.orgName,
      orgEmail: ctx.orgEmail,
      reason: "Someone entered this address on the promise tracker.",
      unsubscribeUrl: o.unfollowUrl,
      preheader: `Confirm that you want updates on promise ${o.number}.`,
    }),
    text: textVersion([`Confirm that you want an email when promise ${o.number} (${o.title}) changes status:`, o.confirmUrl, "", "If you didn't ask for this, ignore this email."], {
      orgName: ctx.orgName,
      unsubscribeUrl: o.unfollowUrl,
    }),
  };
}

/**
 * Record a follow. With email configured the follow waits for a click on a
 * confirmation link (double opt-in); without it the follow is confirmed at
 * once. Following twice is harmless: a pending follow gets a fresh link.
 *
 * The confirmed follow row is the consent for this one narrow purpose, so the
 * person's general email consent (contactConsentAt) is left alone. With email
 * configured the answer is always "pending" and the email goes out after the
 * response, so the reply never shows whether the address already follows.
 */
export async function followPromise(db: Db, input: { promise: { id: string; number: number; title: string }; email: string }, ctx: MessageContext): Promise<{ status: FollowStatus }> {
  const address = input.email.trim().toLowerCase();
  const person = await findOrCreatePerson(db, address, {}, { source: "tracker-follow" });
  const confirmNow = !env.emailEnabled;
  const [inserted] = await db
    .insert(promiseFollows)
    .values({ promiseId: input.promise.id, email: address, personId: person.id, token: randomBytes(24).toString("base64url"), confirmedAt: confirmNow ? new Date() : null })
    .onConflictDoNothing({ target: [promiseFollows.promiseId, promiseFollows.email] })
    .returning();
  const follow = inserted ?? (await db.query.promiseFollows.findFirst({ where: and(eq(promiseFollows.promiseId, input.promise.id), eq(promiseFollows.email, address)) }));
  if (!follow) throw new Error("Could not record the follow.");
  if (confirmNow) {
    // A new follow is inserted already confirmed; an older pending one is confirmed now. Either is new to the desk.
    const newlyConfirmed = Boolean(inserted) || !follow.confirmedAt;
    if (!follow.confirmedAt) await db.update(promiseFollows).set({ confirmedAt: new Date() }).where(eq(promiseFollows.id, follow.id));
    if (newlyConfirmed) await forwardFollow(db, { personId: person.id, email: address, number: input.promise.number });
    return { status: "confirmed" };
  }
  // Already confirmed: nothing to send, and the same answer as a new follow.
  if (follow.confirmedAt) return { status: "pending" };
  after(async () => {
    try {
      const raw = await createToken(db, "promise-follow", address, { ttlMinutes: 3 * 24 * 60, data: { followId: follow.id } });
      const unfollow = unfollowUrl(follow.token);
      const message = promiseFollowConfirmEmail(ctx, { number: input.promise.number, title: input.promise.title, confirmUrl: tokenUrl("/api/tracker/follow/confirm", raw), unfollowUrl: unfollow });
      await sendEmail(db, { to: address, subject: message.subject, html: message.html, text: message.text, kind: "promise-follow-confirm", personId: person.id, unsubscribeUrl: unfollow });
    } catch (err) {
      console.error("promise follow confirmation failed", err);
    }
  });
  return { status: "pending" };
}

/**
 * Redeem a confirmation link. Returns the promise number to send the person
 * back to. The first confirmation goes to the desk as a "Follows: promise
 * <n>" tag.
 */
export async function confirmFollow(db: Db, raw: string): Promise<{ ok: true; number: number } | { ok: false }> {
  const token = await consumeToken(db, "promise-follow", raw);
  const followId = token?.data && typeof token.data.followId === "string" ? token.data.followId : null;
  if (!followId) return { ok: false };
  const [newly] = await db
    .update(promiseFollows)
    .set({ confirmedAt: sql`now()` })
    .where(and(eq(promiseFollows.id, followId), isNull(promiseFollows.confirmedAt)))
    .returning({ promiseId: promiseFollows.promiseId, email: promiseFollows.email, personId: promiseFollows.personId });
  const row = newly ?? (await db.query.promiseFollows.findFirst({ where: eq(promiseFollows.id, followId), columns: { promiseId: true } }));
  if (!row) return { ok: false };
  const promise = await db.query.trackerPromises.findFirst({ where: eq(trackerPromises.id, row.promiseId), columns: { number: true } });
  if (!promise) return { ok: false };
  if (newly) await forwardFollow(db, { personId: newly.personId, email: newly.email, number: promise.number });
  return { ok: true, number: promise.number };
}

export const statusLabel = (status: PromiseStatus) => STATUS_BY_ID[status].label;
