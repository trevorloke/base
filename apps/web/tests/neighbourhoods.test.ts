import { describe, expect, it } from "vitest";
import {
  fsasForNeighbourhood,
  NEIGHBOURHOOD_FSAS,
  NEIGHBOURHOOD_SLUGS,
  NEIGHBOURHOODS,
  neighbourhoodForPostalCode,
  neighbourhoodFromSlug,
  neighbourhoodSlug,
} from "@/lib/neighbourhoods";
import { createOpeningSchema, rsvpRequestSchema, updateOpeningSchema, updateShiftSchema, volunteerSignupSchema } from "@/lib/shift-validation";
import { formatLongDate, groupByWeek, isFull, nextSaturday, spotsLeft } from "@/lib/shifts";

describe("neighbourhood slugs", () => {
  it("has one slug per town centre, both ways", () => {
    expect(NEIGHBOURHOOD_SLUGS).toHaveLength(NEIGHBOURHOODS.length);
    for (const name of NEIGHBOURHOODS) {
      const slug = neighbourhoodSlug(name);
      expect(slug).toBeDefined();
      expect(NEIGHBOURHOOD_SLUGS).toContain(slug);
      expect(neighbourhoodFromSlug(slug!)).toBe(name);
      expect(slug).toBe(name.toLowerCase().replace(/\s+/g, "-"));
    }
  });
  it("is forgiving about case and spacing but not about unknown places", () => {
    expect(neighbourhoodSlug("south surrey")).toBe("south-surrey");
    expect(neighbourhoodFromSlug("South-Surrey")).toBe("South Surrey");
    expect(neighbourhoodSlug("Langley")).toBeUndefined();
    expect(neighbourhoodFromSlug("langley")).toBeUndefined();
    expect(neighbourhoodSlug(null)).toBeUndefined();
  });
});

describe("forward sortation areas", () => {
  it("lists every FSA under its town centre and maps each back", () => {
    expect(NEIGHBOURHOOD_FSAS.Newton).toEqual(["V3W", "V3X"]);
    expect(NEIGHBOURHOOD_FSAS["South Surrey"]).toEqual(["V3Z", "V4A", "V4P"]);
    expect(fsasForNeighbourhood("Whalley")).toEqual(["V3T", "V3V"]);
    expect(fsasForNeighbourhood("Nowhere")).toEqual([]);
    for (const name of NEIGHBOURHOODS) {
      expect(NEIGHBOURHOOD_FSAS[name].length).toBeGreaterThan(0);
      for (const fsa of NEIGHBOURHOOD_FSAS[name]) expect(neighbourhoodForPostalCode(`${fsa} 1A1`)).toBe(name);
    }
  });
  it("sends V3T 1V8 to Whalley and knows nothing about Vancouver", () => {
    expect(neighbourhoodSlug(neighbourhoodForPostalCode("v3t1v8"))).toBe("whalley");
    expect(neighbourhoodForPostalCode("V6B 1A1")).toBeUndefined();
  });
});

describe("spots and weeks", () => {
  it("counts spots left and never goes negative", () => {
    expect(spotsLeft(6, 2)).toBe(4);
    expect(spotsLeft(6, 6)).toBe(0);
    expect(spotsLeft(6, 9)).toBe(0);
    expect(spotsLeft(3, -1)).toBe(3);
    expect(isFull(6, 6)).toBe(true);
    expect(isFull(6, 5)).toBe(false);
    expect(isFull(null, 100)).toBe(false);
  });
  it("groups openings by the Sunday that starts their week", () => {
    const weeks = groupByWeek([
      { id: "c", date: "2026-11-14" },
      { id: "a", date: "2026-11-07" },
      { id: "b", date: "2026-11-08" },
    ]);
    expect(weeks.map((w) => w.sunday)).toEqual(["2026-11-01", "2026-11-08"]);
    expect(weeks[0].items.map((i) => i.id)).toEqual(["a"]);
    expect(weeks[1].items.map((i) => i.id)).toEqual(["b", "c"]);
    expect(weeks[0].label).toBe("November 1 – November 7, 2026");
  });
  it("finds the next Saturday, a week ahead on a Saturday", () => {
    expect(nextSaturday("2026-11-02")).toBe("2026-11-07"); // a Monday
    expect(nextSaturday("2026-11-07")).toBe("2026-11-14"); // a Saturday
    expect(nextSaturday("2026-11-08")).toBe("2026-11-14"); // a Sunday
    expect(formatLongDate("2026-11-07")).toBe("Saturday, November 7");
  });
});

describe("sign-up and opening schemas", () => {
  const signup = { openingId: "5b1d3a0e-0f4c-4d3b-9c3a-1f2e3d4c5b6a", name: "Priya Sandhu", email: "Priya@Example.com", postalCode: "v3w 2a1", website: "" };
  it("accepts a sign-up, lowercases the email and drops blanks", () => {
    const r = volunteerSignupSchema.parse({ ...signup, phone: "", source: "", ref: "" });
    expect(r.email).toBe("priya@example.com");
    expect(r.phone).toBeUndefined();
    expect(r.source).toBeUndefined();
    expect(r.smsConsent).toBe(false);
    expect(r.updatesConsent).toBe(false);
  });
  it("books without any marketing tick, needs a phone for texts, and nothing extra", () => {
    expect(volunteerSignupSchema.safeParse(signup).success).toBe(true);
    expect(volunteerSignupSchema.parse({ ...signup, updatesConsent: true }).updatesConsent).toBe(true);
    // The old required tick is gone; sending it is an unknown field.
    expect(volunteerSignupSchema.safeParse({ ...signup, consent: true }).success).toBe(false);
    const sms = volunteerSignupSchema.safeParse({ ...signup, smsConsent: true });
    expect(sms.success).toBe(false);
    expect(volunteerSignupSchema.safeParse({ ...signup, smsConsent: true, phone: "604-555-0101" }).success).toBe(true);
    expect(volunteerSignupSchema.safeParse({ ...signup, admin: true }).success).toBe(false);
    expect(volunteerSignupSchema.safeParse({ ...signup, openingId: "nope" }).success).toBe(false);
  });
  it("fills opening defaults on create and keeps updates strict", () => {
    const created = createOpeningSchema.parse({ date: "2026-11-07", slot: "morning", title: "Door-knocking" });
    expect(created).toMatchObject({ capacity: 6, published: true, location: "", notes: "", neighbourhood: null, taskId: null });
    expect(createOpeningSchema.safeParse({ date: "2026-11-07", slot: "morning", title: "x", capacity: 0 }).success).toBe(false);
    expect(createOpeningSchema.safeParse({ date: "2026-11-07", slot: "morning", title: "x", neighbourhood: "Langley" }).success).toBe(false);
    expect(updateOpeningSchema.parse({ published: false })).toEqual({ published: false });
    expect(updateOpeningSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });
  it("lets the board set a status but only a real one", () => {
    expect(updateShiftSchema.parse({ status: "confirmed" })).toEqual({ status: "confirmed" });
    expect(updateShiftSchema.safeParse({ status: "late" }).success).toBe(false);
  });
  it("accepts tracking on an RSVP without loosening the contract", () => {
    const r = rsvpRequestSchema.parse({ name: "Raj", email: "raj@example.com", source: "whatsapp", ref: "ABCDEF23" });
    expect(r).toMatchObject({ guests: 0, newsletter: false, source: "whatsapp", ref: "ABCDEF23" });
    expect(rsvpRequestSchema.safeParse({ name: "Raj", email: "raj@example.com", extra: true }).success).toBe(false);
  });
});
