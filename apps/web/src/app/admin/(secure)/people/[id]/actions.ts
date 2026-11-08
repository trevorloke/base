"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LOCALES, normalizeTag } from "@/components/admin/people/query";
import { getDb } from "@/lib/db";
import { CAMPUSES, choices, NEIGHBOURHOODS, normalizePostalCode, OUTSIDE_SURREY, POSTAL_CODE_RE } from "@/lib/neighbourhoods";
import { ActionError, adminAction, checkbox, optionalText } from "@/lib/server/actions";
import { audit } from "@/lib/server/audit";
import { updatePerson } from "@/lib/server/people";
import { addNote, addTag, anonymizePerson, removeTag } from "@/lib/server/supporters";

// Handlers write their own audit entry so it names the supporter (entity
// "person" + id); adminAction's auditAction argument is left out so there is
// one entry per action, not two.

function refresh(id: string) {
  revalidatePath(`/admin/people/${id}`);
  revalidatePath("/admin/people");
}

const uuid = z.uuid({ error: "Not a supporter id" });
const orNull = (v: string | undefined) => v ?? null;

/** Overwrite a supporter's details (an admin edit, unlike public forms which only fill blanks). */
export const savePerson = adminAction(
  "people",
  z.object({
    id: uuid,
    firstName: optionalText(80),
    lastName: optionalText(80),
    phone: optionalText(30),
    address: optionalText(200),
    city: optionalText(80),
    province: optionalText(40),
    postalCode: optionalText(10).refine((v) => !v || POSTAL_CODE_RE.test(v), "Enter a postal code like A1A 1A1"),
    neighbourhood: z.enum(choices(NEIGHBOURHOODS, ...(OUTSIDE_SURREY ? [OUTSIDE_SURREY] : []), "")),
    birthdate: z.union([z.literal(""), z.iso.date("Enter a date like 1990-04-12")]),
    citizenshipStatus: z.enum(["Citizen", "Permanent resident", "Other", ""]),
    gender: optionalText(40),
    languages: optionalText(300),
    student: checkbox(),
    campus: z.enum(choices(CAMPUSES, "")),
    issue: optionalText(200),
    interestVolunteer: checkbox(),
    interestLawnSign: checkbox(),
    locale: z.enum(LOCALES.map((l) => l.id) as [string, ...string[]]),
    source: optionalText(80),
  }),
  async (data, { user }) => {
    const row = await updatePerson(getDb(), data.id, {
      firstName: orNull(data.firstName),
      lastName: orNull(data.lastName),
      phone: orNull(data.phone),
      address: orNull(data.address),
      city: orNull(data.city),
      province: orNull(data.province),
      postalCode: data.postalCode ? normalizePostalCode(data.postalCode) : null,
      neighbourhood: data.neighbourhood || null,
      birthdate: data.birthdate || null,
      citizenshipStatus: data.citizenshipStatus || null,
      gender: orNull(data.gender),
      languages: data.languages
        ? data.languages
            .split(/[,;]/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 20)
        : null,
      student: data.student,
      campus: data.campus || null,
      issue: orNull(data.issue),
      interestVolunteer: data.interestVolunteer,
      interestLawnSign: data.interestLawnSign,
      locale: data.locale || null,
      source: orNull(data.source),
    });
    if (!row) throw new ActionError("That supporter no longer exists.");
    await audit(user, "person.update", { fields: Object.keys(data).filter((k) => k !== "id") }, "person", data.id);
    refresh(data.id);
    return "Details saved.";
  },
);

const tagSchema = z.object({ id: uuid, tag: z.string().trim().min(1, "Enter a tag").max(40, "Tags are at most 40 characters") });

export const addTagAction = adminAction("people", tagSchema, async (data, { user }) => {
  const tag = normalizeTag(data.tag);
  if (!tag) throw new ActionError("Please check the highlighted fields.", { tag: "Enter a tag" });
  await addTag(getDb(), data.id, tag);
  await audit(user, "person.tag.add", { tag }, "person", data.id);
  refresh(data.id);
  return `Tagged "${tag}".`;
});

export const removeTagAction = adminAction("people", tagSchema, async (data, { user }) => {
  await removeTag(getDb(), data.id, data.tag);
  await audit(user, "person.tag.remove", { tag: data.tag }, "person", data.id);
  refresh(data.id);
  return `Removed the tag "${data.tag}".`;
});

export const addNoteAction = adminAction(
  "people",
  z.object({ id: uuid, body: z.string().trim().min(1, "Write a note first").max(4000, "Notes are at most 4,000 characters") }),
  async (data, { user }) => {
    await addNote(getDb(), data.id, { id: user.id, name: user.name }, data.body);
    await audit(user, "person.note.add", { length: data.body.length }, "person", data.id);
    refresh(data.id);
    return "Note added.";
  },
);

/** A PIPA deletion request. Irreversible, so it needs the tick box and a confirmation. */
export const anonymizeAction = adminAction("people", z.object({ id: uuid, confirm: checkbox() }), async (data, { user }) => {
  if (!data.confirm) throw new ActionError("Please check the highlighted fields.", { confirm: "Tick the box to confirm" });
  const result = await anonymizePerson(getDb(), data.id);
  if (!result) throw new ActionError("That supporter no longer exists.");
  // The previous email is personal information being erased, so it is not logged.
  await audit(user, "person.anonymize", { reason: "PIPA deletion request" }, "person", data.id);
  refresh(data.id);
  return "Personal details removed. Contribution records are kept as the law requires.";
});
