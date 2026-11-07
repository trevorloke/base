import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { volunteerTasks } from "@/lib/db/schema";
import { error, json } from "@/lib/server/api";
import { adminOnly, isUniqueViolation, readJson } from "@/lib/server/admin-api";
import { invalidate, TAGS } from "@/lib/server/cache";
import { idParam, updateTaskSchema } from "@/lib/shift-validation";

export async function PATCH(req: Request, ctx: RouteContext<"/api/admin/tasks/[id]">) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const id = idParam.safeParse((await ctx.params).id);
  if (!id.success) return error("That task no longer exists.", 404);
  const parsed = updateTaskSchema.safeParse(await readJson(req));
  if (!parsed.success) return error("Check the task.", 422);
  try {
    const [row] = await getDb().update(volunteerTasks).set(parsed.data).where(eq(volunteerTasks.id, id.data)).returning();
    if (!row) return error("That task no longer exists.", 404);
    // Task names and colours show on public openings.
    invalidate(TAGS.events);
    return json(row);
  } catch (err) {
    if (isUniqueViolation(err)) return error("There's already a task with that name.", 409);
    throw err;
  }
}

// Shifts with this task stay on the calendar, uncoloured.
export async function DELETE(_req: Request, ctx: RouteContext<"/api/admin/tasks/[id]">) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const id = idParam.safeParse((await ctx.params).id);
  if (!id.success) return error("That task no longer exists.", 404);
  await getDb().delete(volunteerTasks).where(eq(volunteerTasks.id, id.data));
  invalidate(TAGS.events);
  return json({ ok: true });
}
