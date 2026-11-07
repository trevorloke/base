import { describe, expect, it } from "vitest";
import { ageOn, neighbourhoodForPostalCode, normalizePostalCode } from "@/lib/neighbourhoods";
import {
  campaignSlugSchema,
  donationSchema,
  fieldErrors,
  localeSchema,
  membershipSchema,
  newsletterSchema,
  preferencesSchema,
  rsvpSchema,
  signatureSchema,
  trackingFields,
} from "@/lib/validation";

const member = {
  firstName: "Asha",
  lastName: "Singh",
  email: "  Asha@Example.com ",
  address: "13450 104 Ave",
  city: "Surrey",
  postalCode: "v3t 1v8",
  neighbourhood: "Whalley",
  birthdate: "1990-04-12",
  citizenshipStatus: "Citizen",
  languages: ["English", "Punjabi"],
  consent: true,
};

describe("membershipSchema", () => {
  it("accepts a complete form and normalizes the email", () => {
    const r = membershipSchema.parse(member);
    expect(r.email).toBe("asha@example.com");
    expect(r.student).toBe(false);
  });
  it("requires consent", () => {
    expect(membershipSchema.safeParse({ ...member, consent: false }).success).toBe(false);
  });
  it("rejects unknown fields", () => {
    expect(membershipSchema.safeParse({ ...member, isAdmin: true }).success).toBe(false);
  });
  it("defaults the marketing ticks to false and accepts them when ticked", () => {
    const r = membershipSchema.parse(member);
    expect(r.updatesConsent).toBe(false);
    expect(r.smsConsent).toBe(false);
    const ticked = membershipSchema.parse({ ...member, updatesConsent: true, smsConsent: true });
    expect(ticked.updatesConsent).toBe(true);
    expect(ticked.smsConsent).toBe(true);
  });
  it("carries source, ref and locale, treating empty strings as absent", () => {
    const r = membershipSchema.parse({ ...member, source: "whatsapp", ref: "ABC234", locale: "pa" });
    expect([r.source, r.ref, r.locale]).toEqual(["whatsapp", "ABC234", "pa"]);
    const blank = membershipSchema.parse({ ...member, source: "", ref: "", locale: "" });
    expect([blank.source, blank.ref, blank.locale]).toEqual([undefined, undefined, undefined]);
    expect(membershipSchema.safeParse({ ...member, locale: "fr" }).success).toBe(false);
  });
  it("allows up to six languages", () => {
    expect(membershipSchema.safeParse({ ...member, languages: ["a", "b", "c", "d", "e", "f"] }).success).toBe(true);
    const r = membershipSchema.safeParse({ ...member, languages: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).languages).toBe("Choose up to 6 languages");
  });
});

describe("donationSchema", () => {
  const donation = {
    frequency: "one_time",
    tier: "standard",
    amountCents: 5000,
    firstName: "Asha",
    lastName: "Singh",
    email: "asha@example.com",
    address: "13450 104 Ave",
    city: "Surrey",
    postalCode: "V3T 1V8",
    attestCitizenOrPR: true,
    attestBcResident: true,
    attestOwnFunds: true,
  };
  it("accepts an eligible contributor", () => {
    expect(donationSchema.safeParse(donation).success).toBe(true);
  });
  it("requires a BC postal code", () => {
    expect(donationSchema.safeParse({ ...donation, postalCode: "M5V 2T6" }).success).toBe(false);
  });
  it("requires every eligibility attestation", () => {
    expect(donationSchema.safeParse({ ...donation, attestOwnFunds: false }).success).toBe(false);
  });
  it("keeps amountCents at zero for the fixed-amount clubs and takes optional source and ref", () => {
    const r = donationSchema.parse({ ...donation, tier: "star", amountCents: 0, source: "share-whatsapp", ref: "ABC234" });
    expect(r.amountCents).toBe(0);
    expect(r.source).toBe("share-whatsapp");
    expect(r.ref).toBe("ABC234");
    expect(donationSchema.safeParse({ ...donation, locale: "en" }).success).toBe(false);
  });
});

describe("signatureSchema", () => {
  const sig = { campaign: "skytrain-south-surrey", firstName: "A", lastName: "B", email: "a@b.ca", postalCode: "V4A 1A1" };
  it("accepts any well-formed slug; the route checks it against the campaigns table", () => {
    expect(signatureSchema.safeParse(sig).success).toBe(true);
    expect(signatureSchema.safeParse({ ...sig, campaign: "save-the-pool-2027" }).success).toBe(true);
    expect(signatureSchema.safeParse({ ...sig, campaign: "Not A Slug" }).success).toBe(false);
    expect(signatureSchema.safeParse({ ...sig, campaign: "" }).success).toBe(false);
    expect(campaignSlugSchema.safeParse("a".repeat(61)).success).toBe(false);
  });
  it("defaults both consent ticks to false and never derives the neighbourhood from the body", () => {
    const r = signatureSchema.parse(sig);
    expect(r.updatesConsent).toBe(false);
    expect(r.smsConsent).toBe(false);
    expect("neighbourhood" in r).toBe(false);
    expect(signatureSchema.safeParse({ ...sig, neighbourhood: "Newton" }).success).toBe(false);
  });
  it("still accepts the first form's consent field without acting on it", () => {
    const r = signatureSchema.parse({ ...sig, consent: true });
    expect(r.updatesConsent).toBe(false);
  });
  it("carries tracking fields", () => {
    const r = signatureSchema.parse({ ...sig, source: "whatsapp", ref: "ABC234", locale: "zh-Hant", updatesConsent: true });
    expect([r.source, r.ref, r.locale, r.updatesConsent]).toEqual(["whatsapp", "ABC234", "zh-Hant", true]);
    expect(signatureSchema.safeParse({ ...sig, source: "x".repeat(81) }).success).toBe(false);
    expect(signatureSchema.safeParse({ ...sig, ref: "x".repeat(21) }).success).toBe(false);
  });
});

describe("newsletterSchema and rsvpSchema", () => {
  it("newsletter takes source and ref", () => {
    const r = newsletterSchema.parse({ email: "A@b.ca", source: "home", ref: "ABC234" });
    expect(r).toEqual({ email: "a@b.ca", source: "home", ref: "ABC234" });
    expect(newsletterSchema.safeParse({ email: "a@b.ca", locale: "en" }).success).toBe(false);
  });
  it("rsvp keeps its fields and takes the optional extras", () => {
    const r = rsvpSchema.parse({ name: "Raj Patel", email: "raj@example.com", guests: 2, newsletter: true, phone: "604-555-0100", postalCode: "V3W 2A1", smsConsent: true, source: "event-email", ref: "" });
    expect(r.guests).toBe(2);
    expect(r.smsConsent).toBe(true);
    expect(r.postalCode).toBe("V3W 2A1");
    expect(r.ref).toBeUndefined();
    expect(rsvpSchema.parse({ name: "Raj", email: "raj@example.com" }).guests).toBe(0);
    expect(rsvpSchema.safeParse({ name: "Raj", email: "raj@example.com", guests: 11 }).success).toBe(false);
    expect(rsvpSchema.safeParse({ name: "Raj", email: "raj@example.com", postalCode: "12345" }).success).toBe(false);
    expect(rsvpSchema.parse({ name: "Raj", email: "raj@example.com", postalCode: "" }).postalCode).toBeUndefined();
  });
});

describe("preferencesSchema", () => {
  it("needs a token and treats the ticks as booleans", () => {
    const r = preferencesSchema.parse({ token: "abc", updates: true, locale: "hi", postalCode: "V3S 1A1", phone: "" });
    expect(r.updates).toBe(true);
    expect(r.sms).toBe(false);
    expect(r.locale).toBe("hi");
    expect(r.phone).toBeUndefined();
    expect(preferencesSchema.safeParse({ updates: true }).success).toBe(false);
  });
});

describe("shared fragments", () => {
  it("localeSchema lists the site languages", () => {
    expect(localeSchema.options).toEqual(["en", "pa", "hi", "zh-Hans", "zh-Hant", "tl"]);
  });
  it("trackingFields can be spread into another schema", () => {
    expect(Object.keys(trackingFields)).toEqual(["source", "ref", "locale"]);
  });
});

describe("neighbourhood helpers", () => {
  it("maps postal codes to town centres", () => {
    expect(neighbourhoodForPostalCode("v3w 2a1")).toBe("Newton");
    expect(neighbourhoodForPostalCode("V5K 0A1")).toBeUndefined();
    expect(normalizePostalCode("v3t1v8")).toBe("V3T 1V8");
  });
  it("computes age on a date", () => {
    expect(ageOn("2012-10-24", new Date(2026, 9, 23))).toBe(13);
    expect(ageOn("2012-10-23", new Date(2026, 9, 23))).toBe(14);
  });
});
