import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { shiftOpenings } from "@/lib/db/schema";
import { error, json } from "@/lib/server/api";
import { adminOnly, readJson } from "@/lib/server/admin-api";
import { audit } from "@/lib/server/audit";
import { invalidate, TAGS } from "@/lib/server/cache";
import { countSignups, loadOpening, loadOpeningSignups } from "@/lib/server/shifts";
import { idParam, updateOpeningSchema } from "@/lib/shift-validation";
import { fieldErrors } from "@/lib/validation";

const GONE = "That opening no longer exists.";

/** The opening with everyone who signed up for it. */
export async function GET(_req: Request, ctx: RouteContext<"/api/admin/openings/[id]">) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const id = idParam.safeParse((await ctx.params).id);
  if (!id.success) return error(GONE, 404);
  const db = getDb();
  const opening = await loadOpening(db, id.data);
  if (!opening) return error(GONE, 404);
  return json({ ...opening, signups: await loadOpeningSignups(db, id.data) });
}

// Edit, publish or unpublish. Shifts already booked through it are untouched.
export async function PATCH(req: Request, ctx: RouteContext<"/api/admin/openings/[id]">) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const id = idParam.safeParse((await ctx.params).id);
  if (!id.success) return error(GONE, 404);
  const parsed = updateOpeningSchema.safeParse(await readJson(req));
  if (!parsed.success) return error("Please check the highlighted fields.", 422, fieldErrors(parsed.error));
  if (Object.keys(parsed.data).length === 0) return error("Nothing to change.", 422);
  const db = getDb();
  const [row] = await db.update(shiftOpenings).set(parsed.data).where(eq(shiftOpenings.id, id.data)).returning({ id: shiftOpenings.id });
  if (!row) return error(GONE, 404);
  await audit(auth.user, "opening.update", parsed.data, "shift_openings", row.id);
  invalidate(TAGS.events, TAGS.counters);
  return json(await loadOpening(db, row.id));
}

// Delete only an opening nobody has signed up for; otherwise unpublish it so
// the people already booked keep their shifts.
export async function DELETE(_req: Request, ctx: RouteContext<"/api/admin/openings/[id]">) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const id = idParam.safeParse((await ctx.params).id);
  if (!id.success) return error(GONE, 404);
  const db = getDb();
  if ((await countSignups(db, id.data)) > 0) {
    return error("People have signed up for this opening. Unpublish it instead, or remove their shifts from the board first.", 409);
  }
  const [row] = await db.delete(shiftOpenings).where(eq(shiftOpenings.id, id.data)).returning({ id: shiftOpenings.id, title: shiftOpenings.title });
  if (!row) return error(GONE, 404);
  await audit(auth.user, "opening.delete", { title: row.title }, "shift_openings", row.id);
  invalidate(TAGS.events, TAGS.counters);
  return json({ ok: true });
}
