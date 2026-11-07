"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { trackerAnnouncements, trackerPromises, trackerUpdates } from "@/lib/db/schema";
import { NEIGHBOURHOODS } from "@/lib/neighbourhoods";
import { ActionError, adminAction, httpUrl, multi, optionalText } from "@/lib/server/actions";
import { invalidate, TAGS } from "@/lib/server/cache";
import { insertPromise, notifyStatusChange } from "@/lib/server/tracker";
import { formatIsoDate, STATUS_BY_ID, STATUS_IDS } from "@/lib/tracker";

// Every action: permission check, validation with field errors, audit entry
// and a cache purge, so the public tracker shows the change on the next visit.

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.iso.date("Enter a date like 2027-02-07");
const optionalDate = z
  .union([z.literal(""), z.iso.date("Enter a date like 2027-02-07")])
  .optional()
  .transform((v) => v || null);
const status = z.enum(STATUS_IDS);
const statusOrKeep = z
  .enum([...STATUS_IDS, ""])
  .optional()
  .transform((v) => (v ? v : null));
const neighbourhoods = multi().pipe(z.array(z.enum(NEIGHBOURHOODS)).max(NEIGHBOURHOODS.length));
const sourceList = (label: string | undefined, url: string | null) => (label ? [{ label, ...(url ? { url } : {}) }] : []);

/** Score a promise: log what happened and, optionally, change its status. */
export const addUpdate = adminAction(
  "tracker",
  z.object({ promiseId: z.uuid(), date: isoDate, status: statusOrKeep, note: text(2000).min(1, "Say what happened"), url: httpUrl() }),
  async (data) => {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [promise] = await tx.select({ status: trackerPromises.status }).from(trackerPromises).where(eq(trackerPromises.id, data.promiseId)).for("update");
      if (!promise) throw new ActionError("That promise no longer exists.");
      await tx.insert(trackerUpdates).values({ promiseId: data.promiseId, date: data.date, status: data.status, note: data.note, url: data.url });
      const next = data.status ?? promise.status;
      if (next !== promise.status) {
        await tx.update(trackerPromises).set({ status: next, statusChangedAt: new Date() }).where(eq(trackerPromises.id, data.promiseId));
      }
      return { previous: promise.status, next };
    });
    invalidate(TAGS.tracker);
    await notifyStatusChange(db, { promiseId: data.promiseId, ...result });
    return result.next === result.previous ? "Update added." : `Update added and status set to ${STATUS_BY_ID[result.next].label}.`;
  },
  "tracker.update.add",
);

export const deleteUpdate = adminAction(
  "tracker",
  z.object({ id: z.uuid() }),
  async ({ id }) => {
    await getDb().delete(trackerUpdates).where(eq(trackerUpdates.id, id));
    invalidate(TAGS.tracker);
    return "Update deleted.";
  },
  "tracker.update.delete",
);

/** Set a status without an update, e.g. to correct a mistake. */
export const setStatus = adminAction(
  "tracker",
  z.object({ id: z.uuid(), status }),
  async (data) => {
    const db = getDb();
    const [promise] = await db.select({ status: trackerPromises.status }).from(trackerPromises).where(eq(trackerPromises.id, data.id));
    if (!promise) throw new ActionError("That promise no longer exists.");
    if (promise.status === data.status) return `The status is already ${STATUS_BY_ID[data.status].label}.`;
    await db.update(trackerPromises).set({ status: data.status, statusChangedAt: new Date() }).where(eq(trackerPromises.id, data.id));
    invalidate(TAGS.tracker);
    await notifyStatusChange(db, { promiseId: data.id, previous: promise.status, next: data.status });
    return `Status set to ${STATUS_BY_ID[data.status].label}.`;
  },
  "tracker.status.set",
);

const promiseFields = {
  title: text(400).min(1, "Required"),
  specifics: text(2000),
  area: text(40).min(1, "Required"),
  promisedOn: optionalDate,
  targetDate: optionalDate,
  neighbourhoods,
};

export const editPromise = adminAction(
  "tracker",
  z.object({ id: z.uuid(), ...promiseFields, testKept: optionalText(2000), testPartly: optionalText(2000), testBroken: optionalText(2000), testRecord: optionalText(2000) }),
  async (data) => {
    await getDb()
      .update(trackerPromises)
      .set({
        title: data.title,
        specifics: data.specifics,
        area: data.area,
        testKept: data.testKept ?? null,
        testPartly: data.testPartly ?? null,
        testBroken: data.testBroken ?? null,
        testRecord: data.testRecord ?? null,
        promisedOn: data.promisedOn,
        targetDate: data.targetDate,
        neighbourhoods: data.neighbourhoods,
      })
      .where(eq(trackerPromises.id, data.id));
    invalidate(TAGS.tracker);
    return "Promise saved.";
  },
  "tracker.promise.edit",
);

/** A new commitment made after the campaign. */
export const addPromise = adminAction(
  "tracker",
  z.object({ ...promiseFields, sourceLabel: optionalText(200), sourceUrl: httpUrl() }),
  async (data) => {
    const row = await insertPromise(getDb(), {
      title: data.title,
      specifics: data.specifics,
      area: data.area,
      sources: sourceList(data.sourceLabel, data.sourceUrl),
      promisedOn: data.promisedOn,
      targetDate: data.targetDate,
      neighbourhoods: data.neighbourhoods,
    });
    invalidate(TAGS.tracker);
    return `Promise #${row.number} added.`;
  },
  "tracker.promise.add",
);

export const deletePromise = adminAction(
  "tracker",
  z.object({ id: z.uuid() }),
  async ({ id }) => {
    await getDb().delete(trackerPromises).where(eq(trackerPromises.id, id));
    invalidate(TAGS.tracker);
    return "Promise deleted, with its updates and follows.";
  },
  "tracker.promise.delete",
);

export const addAnnouncement = adminAction(
  "tracker",
  z.object({ date: isoDate, title: text(300).min(1, "Required"), commitments: text(4000).min(1, "Required"), sourceLabel: optionalText(200), sourceUrl: httpUrl() }),
  async (data) => {
    const rows = await getDb()
      .insert(trackerAnnouncements)
      .values({ date: data.date, dateLabel: formatIsoDate(data.date, "short"), title: data.title, commitments: data.commitments, sources: sourceList(data.sourceLabel, data.sourceUrl) })
      .onConflictDoNothing()
      .returning({ id: trackerAnnouncements.id });
    if (rows.length === 0) throw new ActionError("An announcement with that date and title is already in the log.", { title: "Already logged for that date" });
    invalidate(TAGS.tracker);
    return "Announcement added.";
  },
  "tracker.announcement.add",
);

export const deleteAnnouncement = adminAction(
  "tracker",
  z.object({ id: z.uuid() }),
  async ({ id }) => {
    await getDb().delete(trackerAnnouncements).where(eq(trackerAnnouncements.id, id));
    invalidate(TAGS.tracker);
    return "Announcement deleted.";
  },
  "tracker.announcement.delete",
);
