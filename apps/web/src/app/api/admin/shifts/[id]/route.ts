import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { shifts } from "@/lib/db/schema";
import { error, json } from "@/lib/server/api";
import { adminOnly, isUniqueViolation, readJson } from "@/lib/server/admin-api";
import { audit } from "@/lib/server/audit";
import { invalidate, TAGS } from "@/lib/server/cache";
import { boardShiftColumns } from "@/lib/server/shifts";
import { idParam, updateShiftSchema } from "@/lib/shift-validation";

// Move a shift to another day or time, change its task, or set what happened (status).
export async function PATCH(req: Request, ctx: RouteContext<"/api/admin/shifts/[id]">) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const id = idParam.safeParse((await ctx.params).id);
  if (!id.success) return error("That shift no longer exists.", 404);
  const parsed = updateShiftSchema.safeParse(await readJson(req));
  if (!parsed.success) return error("Invalid change.", 422);
  if (Object.keys(parsed.data).length === 0) return error("Nothing to change.", 422);
  const db = getDb();
  const current = await db.query.shifts.findFirst({ where: eq(shifts.id, id.data), columns: { date: true, slot: true, openingId: true } });
  if (!current) return error("That shift no longer exists.", 404);
  // A shift moved to another day or time is no longer on its opening, so it frees that opening's spot.
  const moved = (parsed.data.date !== undefined && parsed.data.date !== current.date) || (parsed.data.slot !== undefined && parsed.data.slot !== current.slot);
  try {
    const [row] = await db
      .update(shifts)
      .set({ ...parsed.data, ...(moved ? { openingId: null } : {}) })
      .where(eq(shifts.id, id.data))
      .returning(boardShiftColumns);
    if (!row) return error("That shift no longer exists.", 404);
    if (parsed.data.status) await audit(auth.user, "shift.status", { status: parsed.data.status }, "shifts", row.id);
    // Sign-ups through an opening count toward its spots left on the public site.
    if (row.openingId || current.openingId) invalidate(TAGS.counters);
    return json(row);
  } catch (err) {
    if (isUniqueViolation(err)) return error("They're already on that shift.", 409);
    throw err;
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/admin/shifts/[id]">) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const id = idParam.safeParse((await ctx.params).id);
  if (!id.success) return error("That shift no longer exists.", 404);
  const [row] = await getDb().delete(shifts).where(eq(shifts.id, id.data)).returning({ id: shifts.id, openingId: shifts.openingId });
  if (!row) return error("That shift no longer exists.", 404);
  if (row.openingId) invalidate(TAGS.counters);
  return json({ ok: true });
}
