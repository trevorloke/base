"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { ActionError, adminAction } from "@/lib/server/actions";
import { requeueEmail, sendQueued } from "@/lib/server/email";

// Newsletters, campaign emails and text blasts go out from Base Ground, so the
// only thing done from the log is sending a failed one-off email again.

export const resendEmailAction = adminAction(
  "comms",
  z.object({ id: z.uuid() }),
  async (data) => {
    const db = getDb();
    const id = await requeueEmail(db, data.id);
    if (!id) throw new ActionError("Only failed one-off emails whose body is still stored can be re-sent.");
    after(async () => {
      try {
        await sendQueued(db, 10);
      } catch (err) {
        console.error("sendQueued failed", err);
      }
    });
    revalidatePath("/admin/comms");
    return "Queued again. It goes out with the next batch.";
  },
  "email.resend",
);
