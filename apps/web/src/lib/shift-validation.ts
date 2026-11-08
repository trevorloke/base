import { z } from "zod";
import { choices, NEIGHBOURHOODS, POSTAL_CODE_RE } from "./neighbourhoods";
import { HEX_COLOR_RE, ISO_DATE_RE } from "./shifts";
import { rsvpSchema } from "./validation";

const slot = z.enum(["morning", "afternoon", "evening"]);
const isoDate = z.string().regex(ISO_DATE_RE);
const taskId = z.uuid().nullable();
const status = z.enum(["scheduled", "confirmed", "attended", "no_show", "cancelled"]);

/** Route ids come from the URL; anything that is not a UUID is a 404, not a database error. */
export const idParam = z.uuid();

export const createShiftSchema = z.object({ personId: z.uuid(), date: isoDate, slot, taskId }).strict();
export const updateShiftSchema = z.object({ date: isoDate.optional(), slot: slot.optional(), taskId: taskId.optional(), status: status.optional() }).strict();
export const copyWeekSchema = z.object({ from: isoDate, to: isoDate }).strict();

const name = z.string().trim().min(1, "Give the task a name").max(40);
const color = z.string().regex(HEX_COLOR_RE, "Pick a colour");
export const createTaskSchema = z.object({ name, color }).strict();
export const updateTaskSchema = z.object({ name: name.optional(), color: color.optional() }).strict();

// ── Openings (admin) ──────────────────────────────────────────────────────
const openingFields = {
  date: isoDate,
  slot,
  taskId,
  title: z.string().trim().min(1, "Give the opening a title").max(120),
  location: z.string().trim().max(200),
  neighbourhood: z.enum(choices(NEIGHBOURHOODS)).nullable(),
  capacity: z.number().int("Whole numbers only").min(1, "At least one spot").max(500, "At most 500 spots"),
  notes: z.string().trim().max(2000),
  published: z.boolean(),
};
export const createOpeningSchema = z
  .object({
    ...openingFields,
    taskId: openingFields.taskId.default(null),
    location: openingFields.location.default(""),
    neighbourhood: openingFields.neighbourhood.default(null),
    capacity: openingFields.capacity.default(6),
    notes: openingFields.notes.default(""),
    published: openingFields.published.default(true),
  })
  .strict();
export const updateOpeningSchema = z.object(openingFields).partial().strict();
export type OpeningInput = z.input<typeof createOpeningSchema>;

// ── Public sign-up ────────────────────────────────────────────────────────
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const volunteerSignupSchema = z
  .object({
    openingId: z.uuid(),
    name: z.string().trim().min(1, "Required").max(120),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address")),
    phone: optional(30),
    postalCode: z.string().trim().regex(POSTAL_CODE_RE, "Enter a postal code like V3T 1V8"),
    // Booking a shift needs no marketing consent; these optional ticks are separate.
    updatesConsent: z.boolean().optional().default(false),
    smsConsent: z.boolean().optional().default(false),
    // Where the link was shared and who shared it (?source=, ?ref=), carried by the form.
    source: optional(80),
    ref: optional(20),
    website: z.string().max(0).optional(),
  })
  .strict()
  .refine((v) => !v.smsConsent || Boolean(v.phone), { path: ["phone"], error: "Add a mobile number so we can text you, or untick the text box" });
export type VolunteerSignupInput = z.input<typeof volunteerSignupSchema>;

/** The RSVP body as before, plus where the link came from. Unknown fields are still rejected. */
export const rsvpRequestSchema = rsvpSchema.extend({ source: optional(80), ref: optional(20) });
