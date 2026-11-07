import { z } from "zod";
import { CAMPUSES, NEIGHBOURHOODS, OUTSIDE_SURREY, POSTAL_CODE_RE, BC_POSTAL_CODE_RE } from "./neighbourhoods";

const trimmed = (max: number) => z.string().trim().max(max);
const name = trimmed(80).min(1, "Required");
const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address"));
const optional = (max: number) =>
  trimmed(max)
    .optional()
    .transform((v) => (v ? v : undefined));
const postalCode = z.string().trim().regex(POSTAL_CODE_RE, "Enter a postal code like A1A 1A1");
const optionalPostalCode = optional(10).refine((v) => v === undefined || POSTAL_CODE_RE.test(v), "Enter a postal code like A1A 1A1");
const consent = z.literal(true, { error: "Please tick the box to continue" });
const checkbox = z.boolean().optional().default(false);

// Every public form carries a hidden "website" field. People never fill it in; bots do.
const honeypot = { website: z.string().max(0).optional() };

// ── Attribution and language ──────────────────────────────────────────────
// Public forms carry three hidden fields filled on the client: where the visit
// came from (?source=), who shared the link (?ref=) and the page language.
export const LOCALES = ["en", "pa", "hi", "zh-Hans", "zh-Hant", "tl"] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

/** The site locale for a BCP 47 language tag ("en-CA" → "en", "zh-TW" → "zh-Hant"); undefined if the site has no such language. */
export function localeFromLang(lang: string | null | undefined): Locale | undefined {
  if (!lang) return undefined;
  const tag = lang.trim();
  if ((LOCALES as readonly string[]).includes(tag)) return tag as Locale;
  const [base, ...rest] = tag.toLowerCase().split("-");
  if (base === "zh") {
    const subtags = rest.join("-");
    return /hant|tw|hk|mo/.test(subtags) ? "zh-Hant" : "zh-Hans";
  }
  if (base === "fil") return "tl";
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : undefined;
}

/** Spread into a form schema: optional `source`, `ref` and `locale`. Empty strings count as absent. */
export const trackingFields = {
  source: optional(80),
  ref: optional(20),
  locale: z
    .union([localeSchema, z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined)),
};

export const membershipSchema = z
  .object({
    firstName: name,
    lastName: name,
    email,
    phone: optional(30),
    address: trimmed(200).min(1, "Required"),
    city: trimmed(80).min(1, "Required"),
    postalCode,
    neighbourhood: z.enum([...NEIGHBOURHOODS, OUTSIDE_SURREY], { error: "Choose your neighbourhood" }),
    birthdate: z.iso.date("Enter your date of birth"),
    citizenshipStatus: z.enum(["Citizen", "Permanent resident", "Other"], { error: "Choose one" }),
    gender: z.enum(["Male", "Female", "Other", ""]).optional(),
    languages: z.array(trimmed(40)).max(6, "Choose up to 6 languages").optional().default([]),
    student: checkbox,
    campus: z.enum([...CAMPUSES, ""]).optional(),
    issue: optional(200),
    interestVolunteer: checkbox,
    interestLawnSign: checkbox,
    // Membership is by donation: the amount chosen, in cents. Without one the
    // minimum that applies is charged. The route checks it against the minimum
    // (the youth one from the birthdate) and the year's contribution limit.
    amountCents: z.number({ error: "Choose an amount" }).int("Choose an amount in dollars and cents").min(0).max(100_000_000).optional(),
    // The membership application itself (accurate details, privacy policy read).
    consent,
    // Express consent to marketing email and to texts: each is its own unchecked box.
    updatesConsent: checkbox,
    smsConsent: checkbox,
    ...trackingFields,
    ...honeypot,
  })
  .strict();
export type MembershipInput = z.input<typeof membershipSchema>;

export const newsletterSchema = z.object({ email, source: trackingFields.source, ref: trackingFields.ref, ...honeypot }).strict();

/** @deprecated Campaigns live in the `campaigns` table; routes validate the slug against it. Kept for older imports. */
export const CAMPAIGNS = {
  "stop-mccallum-pledge": { title: "Stop Doug McCallum and Mandeep Nagra pledge" },
  "skytrain-south-surrey": { title: "SkyTrain to South Surrey petition" },
} as const;
/** @deprecated Use `string`: any active campaign slug is valid. */
export type CampaignSlug = keyof typeof CAMPAIGNS;

export const CAMPAIGN_SLUG_RE = /^[a-z0-9-]{1,60}$/;
export const campaignSlugSchema = z.string().trim().regex(CAMPAIGN_SLUG_RE, "Unknown campaign");

export const signatureSchema = z
  .object({
    campaign: campaignSlugSchema,
    firstName: name,
    lastName: name,
    email,
    postalCode,
    address: optional(200),
    phone: optional(30),
    answer: optional(200),
    // The first form had one required tick that doubled as email consent. It
    // is accepted and ignored: signing is the button, consent is its own box.
    consent: z.boolean().optional(),
    updatesConsent: checkbox,
    smsConsent: checkbox,
    ...trackingFields,
    ...honeypot,
  })
  .strict();
export type SignatureInput = z.input<typeof signatureSchema>;

export const donationSchema = z
  .object({
    frequency: z.enum(["one_time", "monthly"]),
    tier: z.enum(["standard", "star", "superstar"]),
    // Ignored for the Star and Superstar clubs, which are fixed amounts.
    amountCents: z.number().int().min(0).max(100_000_000),
    firstName: name,
    lastName: name,
    email,
    phone: optional(30),
    address: trimmed(200).min(1, "Required"),
    city: trimmed(80).min(1, "Required"),
    postalCode: z.string().trim().regex(BC_POSTAL_CODE_RE, "Contributors must live in BC: enter a BC postal code"),
    attestCitizenOrPR: z.literal(true, { error: "Required to contribute under BC law" }),
    attestBcResident: z.literal(true, { error: "Required to contribute under BC law" }),
    attestOwnFunds: z.literal(true, { error: "Required to contribute under BC law" }),
    newsletter: checkbox,
    source: trackingFields.source,
    ref: trackingFields.ref,
    ...honeypot,
  })
  .strict();
export type DonationInput = z.input<typeof donationSchema>;

export const rsvpSchema = z
  .object({
    name: trimmed(120).min(1, "Required"),
    email,
    guests: z.number().int().min(0, "Between 0 and 10").max(10, "Between 0 and 10").optional().default(0),
    newsletter: checkbox,
    phone: optional(30),
    postalCode: optionalPostalCode,
    smsConsent: checkbox,
    source: trackingFields.source,
    ref: trackingFields.ref,
    ...honeypot,
  })
  .strict();
export type RsvpInput = z.input<typeof rsvpSchema>;

export const cartSchema = z
  .object({
    items: z
      .array(z.object({ slug: trimmed(80).min(1), quantity: z.number().int().min(1).max(50) }).strict())
      .min(1, "Your cart is empty")
      .max(20),
  })
  .strict();

// ── Preference centre ─────────────────────────────────────────────────────
export const preferencesRequestSchema = z.object({ email, ...honeypot }).strict();

export const preferencesSchema = z
  .object({
    token: z.string().min(1, "This link is incomplete").max(200),
    updates: checkbox,
    sms: checkbox,
    locale: trackingFields.locale,
    postalCode: optionalPostalCode,
    phone: optional(30),
    ...honeypot,
  })
  .strict();
export type PreferencesInput = z.input<typeof preferencesSchema>;

/** Flatten zod issues to { field: message } for the forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    out[key] ??= issue.message;
  }
  return out;
}
