"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { describeQuery, normalizeTag, parsePeopleQuery } from "@/components/admin/people/query";
import { getDb } from "@/lib/db";
import { ActionError, adminAction } from "@/lib/server/actions";
import { can } from "@/lib/server/admin-auth";
import { audit } from "@/lib/server/audit";
import { bulkTag } from "@/lib/server/supporters";

// Handlers write their own audit entry so it can name the entity and say
// how many rows changed; adminAction's auditAction argument is left out so
// there is one entry per action, not two.

/** Add or remove a tag on everyone the current list view matches. The filter travels as hidden fields. */
export const bulkTagAction = adminAction(
  "people",
  z.looseObject({
    // The tag to apply; "tag" itself is the list's filter key and stays a filter.
    bulkTag: z.string().trim().min(1, "Enter a tag").max(40, "Tags are at most 40 characters"),
    mode: z.enum(["add", "remove"]),
  }),
  async (data, { user }) => {
    const tag = normalizeTag(data.bulkTag);
    if (!tag) throw new ActionError("Please check the highlighted fields.", { bulkTag: "Enter a tag" });
    const query = parsePeopleQuery(data as Record<string, string | string[] | undefined>, { money: can(user, "money") });
    const changed = await bulkTag(getDb(), query, tag, data.mode);
    await audit(user, data.mode === "add" ? "people.tag.add" : "people.tag.remove", { tag, changed, filters: describeQuery(query) }, "people");
    revalidatePath("/admin/people");
    const n = `${changed} supporter${changed === 1 ? "" : "s"}`;
    return data.mode === "add" ? `Added the tag "${tag}" to ${n}.` : `Removed the tag "${tag}" from ${n}.`;
  },
);
