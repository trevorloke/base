import "./shifts.css";
import { ShiftBoard } from "@/components/admin/ShiftBoard";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { addDays, ISO_DATE_RE, todayInSurrey, weekStart } from "@/lib/shifts";
import { loadOpenings, loadRoster, loadTasks, loadWeekShifts } from "@/lib/server/shifts";
import { OpeningsPanel } from "./OpeningsPanel";

export default async function ShiftsPage({ searchParams }: PageProps<"/admin/shifts">) {
  await requireAdmin("shifts");
  const { week } = await searchParams;
  const today = todayInSurrey();
  const sunday = weekStart(typeof week === "string" && ISO_DATE_RE.test(week) ? week : today);
  const db = getDb();
  const [shifts, tasks, roster, openings] = await Promise.all([loadWeekShifts(db, sunday), loadTasks(db), loadRoster(db, sunday), loadOpenings(db, { today })]);
  const palette = tasks.map(({ id, name, color }) => ({ id, name, color }));
  const saturday = addDays(sunday, 6);
  const thisWeek = openings.filter((o) => o.date >= sunday && o.date <= saturday);

  return (
    <>
      <ShiftBoard key={sunday} sunday={sunday} today={today} initialShifts={shifts} initialTasks={palette} initialRoster={roster} openings={thisWeek} />
      <OpeningsPanel initialOpenings={openings} tasks={palette} today={today} />
    </>
  );
}
