import "server-only";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { people, shiftOpenings, shifts, volunteerTasks } from "@/lib/db/schema";
import { addDays } from "@/lib/shifts";

export type RosterPerson = { id: string; name: string; email: string; phone: string | null; neighbourhood: string | null };

const personColumns = {
  id: people.id,
  firstName: people.firstName,
  lastName: people.lastName,
  email: people.email,
  phone: people.phone,
  neighbourhood: people.neighbourhood,
};

function toRoster(p: { id: string; firstName: string | null; lastName: string | null; email: string; phone: string | null; neighbourhood: string | null }): RosterPerson {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email;
  return { id: p.id, name, email: p.email, phone: p.phone, neighbourhood: p.neighbourhood };
}

export async function loadTasks(db: Db) {
  return db.select().from(volunteerTasks).orderBy(asc(volunteerTasks.sortOrder), asc(volunteerTasks.name));
}

/** The columns the board works with; every shift route returns the same shape. */
export const boardShiftColumns = { id: shifts.id, personId: shifts.personId, date: shifts.date, slot: shifts.slot, taskId: shifts.taskId, status: shifts.status, openingId: shifts.openingId };

export async function loadWeekShifts(db: Db, sunday: string) {
  return db
    .select(boardShiftColumns)
    .from(shifts)
    .where(and(gte(shifts.date, sunday), lte(shifts.date, addDays(sunday, 6))));
}

/** People who said they'd volunteer, plus anyone already on a shift this week. */
export async function loadRoster(db: Db, sunday: string): Promise<RosterPerson[]> {
  const scheduled = db
    .select({ personId: shifts.personId })
    .from(shifts)
    .where(and(gte(shifts.date, sunday), lte(shifts.date, addDays(sunday, 6))));
  const rows = await db
    .select(personColumns)
    .from(people)
    .where(or(eq(people.interestVolunteer, true), inArray(people.id, scheduled)))
    .orderBy(asc(people.firstName), asc(people.lastName))
    .limit(2000);
  return rows.map(toRoster);
}

/** Find anyone in the database by name or email, to schedule someone not yet on the roster. */
export async function searchPeople(db: Db, query: string): Promise<RosterPerson[]> {
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select(personColumns)
    .from(people)
    .where(
      or(
        sql`${people.email} ilike ${like}`,
        sql`coalesce(${people.firstName}, '') || ' ' || coalesce(${people.lastName}, '') ilike ${like}`,
      ),
    )
    .orderBy(asc(people.firstName))
    .limit(20);
  return rows.map(toRoster);
}

// ── Openings (what the admin panel manages) ───────────────────────────────

export type AdminOpening = {
  id: string;
  date: string;
  slot: "morning" | "afternoon" | "evening";
  taskId: string | null;
  title: string;
  location: string;
  neighbourhood: string | null;
  capacity: number;
  notes: string;
  published: boolean;
  /** People signed up and not cancelled. */
  signedUp: number;
};

const signedUpCount = sql<number>`(select count(*)::int from ${shifts} where ${shifts.openingId} = ${shiftOpenings.id} and ${shifts.status} <> 'cancelled')`;

/** Openings with their sign-up counts, soonest first. Past openings only on request. */
export async function loadOpenings(db: Db, options: { today: string; includePast?: boolean; limit?: number }): Promise<AdminOpening[]> {
  const { createdAt: _createdAt, ...columns } = getTableColumns(shiftOpenings);
  void _createdAt;
  return db
    .select({ ...columns, signedUp: signedUpCount })
    .from(shiftOpenings)
    .where(options.includePast ? undefined : gte(shiftOpenings.date, options.today))
    .orderBy(options.includePast ? desc(shiftOpenings.date) : asc(shiftOpenings.date), asc(shiftOpenings.slot), asc(shiftOpenings.title))
    .limit(options.limit ?? 200);
}

export async function loadOpening(db: Db, id: string): Promise<AdminOpening | undefined> {
  const { createdAt: _createdAt, ...columns } = getTableColumns(shiftOpenings);
  void _createdAt;
  const [row] = await db
    .select({ ...columns, signedUp: signedUpCount })
    .from(shiftOpenings)
    .where(eq(shiftOpenings.id, id))
    .limit(1);
  return row;
}

export type OpeningSignup = { shiftId: string; personId: string; name: string; email: string; phone: string | null; neighbourhood: string | null; status: string; signedUpAt: string };

/** Who signed up for an opening: the shifts that point at it, with the person behind each. */
export async function loadOpeningSignups(db: Db, openingId: string): Promise<OpeningSignup[]> {
  const rows = await db
    .select({ shiftId: shifts.id, status: shifts.status, createdAt: shifts.createdAt, ...personColumns })
    .from(shifts)
    .innerJoin(people, eq(people.id, shifts.personId))
    .where(eq(shifts.openingId, openingId))
    .orderBy(asc(shifts.createdAt));
  return rows.map((r) => ({ shiftId: r.shiftId, personId: r.id, ...toRoster(r), status: r.status, signedUpAt: r.createdAt.toISOString() }));
}

/** How many non-cancelled sign-ups an opening has, for capacity checks and delete guards. */
export async function countSignups(db: Db, openingId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shifts)
    .where(and(eq(shifts.openingId, openingId), ne(shifts.status, "cancelled")));
  return n;
}
