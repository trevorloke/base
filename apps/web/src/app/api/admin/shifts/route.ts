import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { shifts } from "@/lib/db/schema";
import { error, json } from "@/lib/server/api";
import { adminOnly, readJson } from "@/lib/server/admin-api";
import { boardShiftColumns } from "@/lib/server/shifts";
import { createShiftSchema } from "@/lib/shift-validation";

// Put someone on a shift. If they're already on it, this just updates the task.
export async function POST(req: Request) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const parsed = createShiftSchema.safeParse(await readJson(req));
  if (!parsed.success) return error("Invalid shift.", 422);
  const [row] = await getDb()
    .insert(shifts)
    .values(parsed.data)
    .onConflictDoUpdate({ target: [shifts.personId, shifts.date, shifts.slot], set: { taskId: sql`excluded.task_id` } })
    .returning(boardShiftColumns);
  return json(row);
}
