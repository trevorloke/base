import { describe, expect, it } from "vitest";
import { dateToPacificLocal, dollarsToCents, humanize, pacificLocalToDate, parseEmailList, publishStatus, slugify } from "@/components/admin/content/fields";
import { describeSchema, fieldKinds, toFormState, toJson } from "@/components/admin/content/schema-form";
import { defaultSettings, parseSection, SECTION_KEYS, sections } from "@/lib/settings";

describe("settings form", () => {
  it("round-trips every seeded default through form values and back unchanged", () => {
    const defaults = defaultSettings();
    for (const key of SECTION_KEYS) {
      const spec = describeSchema(sections[key].schema);
      const form = toFormState(spec, defaults[key]);
      const json = toJson(spec, form);
      expect(parseSection(key, json), key).toEqual(defaults[key]);
    }
  });

  it("describes every field with a kind the form knows how to render", () => {
    for (const key of SECTION_KEYS) {
      const kinds = fieldKinds(describeSchema(sections[key].schema));
      expect([...kinds].includes("unknown"), key).toBe(false);
    }
  });

  it("recognizes text lengths, images, enums, lists, booleans and email", () => {
    const hero = describeSchema(sections.hero.schema);
    expect(hero.kind).toBe("group");
    if (hero.kind !== "group") return;
    const h = Object.fromEntries(hero.fields.map((f) => [f.key, f.spec]));
    expect(h.image.kind).toBe("image");
    expect(h.words).toMatchObject({ kind: "list", min: 1, max: 30 });
    expect(h.text).toMatchObject({ kind: "text", multiline: true, max: 600 });
    expect(h.titlePrefix).toMatchObject({ kind: "text", multiline: false, max: 60 });
    expect(h.primaryCta.kind).toBe("group");

    const pillars = describeSchema(sections.pillars.schema);
    if (pillars.kind !== "group") throw new Error("pillars should be a group");
    const items = pillars.fields.find((f) => f.key === "items")!.spec;
    if (items.kind !== "list" || items.item.kind !== "group") throw new Error("items should be a list of groups");
    const icon = items.item.fields.find((f) => f.key === "icon")!.spec;
    expect(icon).toMatchObject({ kind: "enum", options: ["shield", "bus", "trend", "tag", "civic"] });

    const org = describeSchema(sections.org.schema);
    if (org.kind !== "group") throw new Error("org should be a group");
    expect(org.fields.find((f) => f.key === "email")!.spec).toMatchObject({ kind: "text", format: "email" });
    expect(org.fields.find((f) => f.key === "name")!.label).toBe("Name");

    const announcement = describeSchema(sections.announcement.schema);
    if (announcement.kind !== "group") throw new Error("announcement should be a group");
    expect(announcement.fields.find((f) => f.key === "enabled")!.spec.kind).toBe("boolean");
  });

  it("fills blanks for the form and omits optional fields left empty", () => {
    const board = describeSchema(sections.board.schema);
    const form = toFormState(board, { seats: [{ role: "President" }] }) as { seats: { role: string; name: string; photo: { url: string; alt: string }; bio: string }[] };
    expect(form.seats[0]).toEqual({ role: "President", name: "", photo: { url: "", alt: "" }, bio: "" });
    const json = toJson(board, form) as { seats: Record<string, unknown>[] };
    expect("photo" in json.seats[0]).toBe(false);
    expect(parseSection("board", json).seats[0]).toEqual({ role: "President", name: "", bio: "" });

    const withPhoto = toJson(board, toFormState(board, { seats: [{ role: "Chair", name: "A", photo: { url: "/x.jpg", alt: "A" } }] })) as { seats: Record<string, unknown>[] };
    expect(withPhoto.seats[0].photo).toEqual({ url: "/x.jpg", alt: "A" });
  });

  it("keeps typed numbers and drops blank ones so the schema reports them", () => {
    const spec = describeSchema(sections.hero.schema);
    const state = toFormState(spec, {}) as Record<string, unknown>;
    expect(Array.isArray(state.words)).toBe(true);
    const json = toJson(spec, { ...state, words: ["a", "b"] }) as Record<string, unknown>;
    expect(json.words).toEqual(["a", "b"]);
  });
});

describe("pacific time", () => {
  it("converts Surrey wall-clock times in winter and summer", () => {
    expect(pacificLocalToDate("2026-01-15T19:00").toISOString()).toBe("2026-01-16T03:00:00.000Z");
    expect(pacificLocalToDate("2026-07-15T19:00").toISOString()).toBe("2026-07-16T02:00:00.000Z");
  });
  it("round-trips datetime-local strings, including across the DST changes", () => {
    for (const s of ["2026-01-15T19:00", "2026-07-15T08:30", "2026-03-08T12:00", "2026-11-01T12:00", "2026-11-01T00:30"]) {
      expect(dateToPacificLocal(pacificLocalToDate(s))).toBe(s);
    }
  });
});

describe("content helpers", () => {
  it("slugifies titles", () => {
    expect(slugify("Town hall in Newton!")).toBe("town-hall-in-newton");
    expect(slugify("  Café — été 2026 ")).toBe("cafe-ete-2026");
    expect(slugify("---")).toBe("");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(80);
  });
  it("parses dollar amounts to cents", () => {
    expect(dollarsToCents("20")).toBe(2000);
    expect(dollarsToCents("12.5")).toBe(1250);
    expect(dollarsToCents("$1,234.56")).toBe(123456);
    expect(dollarsToCents("0")).toBeNull();
    expect(dollarsToCents("1.234")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents("-5")).toBeNull();
  });
  it("parses email lists", () => {
    expect(parseEmailList("A@Example.com\nb@example.com, a@example.com; nope")).toEqual({ emails: ["a@example.com", "b@example.com"], invalid: ["nope"] });
  });
  it("derives publish status", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(publishStatus(null, now)).toBe("draft");
    expect(publishStatus(new Date("2026-07-01T00:00:00Z"), now)).toBe("scheduled");
    expect(publishStatus("2026-05-01T00:00:00Z", now)).toBe("published");
  });
  it("humanizes keys", () => {
    expect(humanize("titlePrefix")).toBe("Title prefix");
    expect(humanize("primaryCta")).toBe("Primary CTA");
    expect(humanize("shareImage")).toBe("Share image");
  });
});
