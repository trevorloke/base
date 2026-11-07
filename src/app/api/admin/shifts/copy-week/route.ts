import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { error, json } from "@/lib/server/api";
import { adminOnly, readJson } from "@/lib/server/admin-api";
import { copyWeekSchema } from "@/lib/shift-validation";
import { addDays } from "@/lib/shifts";

// Repeat one week's schedule in another. Shifts already in the target week stay.
export async function POST(req: Request) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const parsed = copyWeekSchema.safeParse(await readJson(req));
  if (!parsed.success) return error("Invalid weeks.", 422);
  const { from, to } = parsed.data;
  const result = await getDb().execute(sql`
    insert into shifts (person_id, date, slot, task_id)
    select person_id, date + (${to}::date - ${from}::date), slot, task_id
    from shifts where date between ${from}::date and ${addDays(from, 6)}::date
    on conflict (person_id, date, slot) do nothing`);
  return json({ copied: result.count ?? 0 });
}
