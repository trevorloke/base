"use server";

import { z } from "zod";
import { getDb } from "@/lib/db";
import { ActionError, adminAction } from "@/lib/server/actions";
import { resetSection, saveSection } from "@/lib/server/settings";
import { SECTION_KEYS, type SectionKey } from "@/lib/settings";
import { fieldErrors } from "@/lib/validation";

const keySchema = z.enum(SECTION_KEYS as [SectionKey, ...SectionKey[]]);

/** The form sends the whole section as one JSON field; the section's own schema validates it. */
export const saveSettings = adminAction(
  "settings",
  z.object({ key: keySchema, value: z.string().max(500_000) }),
  async (d, { user }) => {
    let value: unknown;
    try {
      value = JSON.parse(d.value);
    } catch {
      throw new ActionError("The form data could not be read. Reload the page and try again.");
    }
    try {
      await saveSection(getDb(), d.key, value, user.id);
    } catch (err) {
      if (err instanceof z.ZodError) throw new ActionError("Please check the highlighted fields.", fieldErrors(err));
      throw err;
    }
    return "Saved. The public site shows the change on its next visit.";
  },
  "settings.save",
);

export const resetSettings = adminAction(
  "settings",
  z.object({ key: keySchema }),
  async (d) => {
    await resetSection(getDb(), d.key);
    return "Reset to the built-in defaults.";
  },
  "settings.reset",
);
