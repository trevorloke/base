// Two sample openings next Saturday, so a fresh site has something on
// /volunteer. Only runs when the table is empty: organizers' own openings are
// never touched. Wire it into scripts/seed.ts as `await seedOpenings(db)`.
import { sql } from "drizzle-orm";
import type { Db } from "../../lib/db";
import { shiftOpenings, volunteerTasks } from "../../lib/db/schema";
import { nextSaturday, todayInSurrey } from "../../lib/shifts";

/** The parts of the database handle the seed uses, so a schema-less drizzle(client) works too. */
type SeedDb = Pick<Db, "select" | "insert">;

export async function seed(db: SeedDb): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(shiftOpenings);
  if (n > 0) return 0;
  const tasks = await db.select({ id: volunteerTasks.id, name: volunteerTasks.name }).from(volunteerTasks);
  const taskId = (name: string) => tasks.find((t) => t.name === name)?.id ?? null;
  const date = nextSaturday(todayInSurrey());
  await db.insert(shiftOpenings).values([
    {
      date,
      slot: "morning",
      taskId: taskId("Door-knocking"),
      title: "Door-knocking in Newton",
      location: "Newton Seniors Centre, 13775 70 Ave",
      neighbourhood: "Newton",
      capacity: 8,
      notes: "Meet at 9 a.m. for a 20-minute training, then knock in pairs until noon. Wear comfortable shoes; we bring the clipboards.",
      published: true,
    },
    {
      date,
      slot: "afternoon",
      taskId: taskId("Phone bank"),
      title: "Phone bank",
      location: "Online from home",
      neighbourhood: null,
      capacity: 10,
      notes: "Call members and supporters across Surrey from your own phone. We send the script and a short how-to video the day before.",
      published: true,
    },
  ]);
  return 2;
}

export { seed as seedOpenings };
