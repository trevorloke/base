"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { media } from "@/lib/db/schema";
import { ActionError, adminAction } from "@/lib/server/actions";

export const updateMediaAlt = adminAction(
  "content",
  z.object({ id: z.uuid(), alt: z.string().trim().max(300) }),
  async (d) => {
    const [row] = await getDb().update(media).set({ alt: d.alt }).where(eq(media.id, d.id)).returning({ id: media.id });
    if (!row) throw new ActionError("That file is no longer in the library.");
    revalidatePath(ADMIN_PATHS.media);
    return "Alt text saved.";
  },
  "media.alt",
);

/** Removes the library entry only; the stored file stays where it is. */
export const deleteMedia = adminAction(
  "content",
  z.object({ id: z.uuid() }),
  async (d) => {
    await getDb().delete(media).where(eq(media.id, d.id));
    revalidatePath(ADMIN_PATHS.media);
    return "Removed from the library.";
  },
  "media.delete",
);
