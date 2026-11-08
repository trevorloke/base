"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { ActionError, adminAction, multi } from "@/lib/server/actions";
import { audit } from "@/lib/server/audit";
import { markDeskLogged } from "@/lib/server/desk-gifts";

const uuid = z.uuid({ error: "Not a gift id" });

/**
 * "Mark logged": the treasurer has entered these gifts at the desk
 * (Base Ground → Donations → Log a gift). The row's button sends `one`; the
 * bulk button sends the ticked `ids`.
 */
export const markGiftsLogged = adminAction(
  "money",
  z.object({ one: uuid.optional().or(z.literal("")), ids: multi().pipe(z.array(uuid).max(500)) }),
  async ({ one, ids }, { user }) => {
    const chosen = one ? [one] : ids;
    if (chosen.length === 0) throw new ActionError("Tick the gifts you've logged at the desk first.");
    const n = await markDeskLogged(getDb(), chosen, user.id);
    await audit(user, "desk-gifts.mark-logged", { count: n, ids: chosen }, "contribution", chosen.length === 1 ? chosen[0] : undefined);
    revalidatePath("/admin/desk-gifts");
    revalidatePath("/admin");
    return n === 0 ? "Those were already marked logged." : `Marked ${n} gift${n === 1 ? "" : "s"} as logged at the desk.`;
  },
);
