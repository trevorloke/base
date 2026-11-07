import { describe, expect, it } from "vitest";
import { LOCALE_IDS, LOCALES, mergeTracking, pacificWeek, roomLeftCents, safeMemberNext } from "@/lib/engagement";

describe("safeMemberNext", () => {
  it("keeps relative paths on this site", () => {
    expect(safeMemberNext("/me")).toBe("/me");
    expect(safeMemberNext("/me/preferences?tab=1#sms")).toBe("/me/preferences?tab=1#sms");
    expect(safeMemberNext("/stats", "/")).toBe("/stats");
  });

  it("refuses anything that could leave the site", () => {
    expect(safeMemberNext("//evil.example")).toBe("/me");
    expect(safeMemberNext("https://evil.example/me")).toBe("/me");
    expect(safeMemberNext("/\\evil.example")).toBe("/me");
    expect(safeMemberNext("javascript:alert(1)")).toBe("/me");
    expect(safeMemberNext("me")).toBe("/me");
    expect(safeMemberNext("/me\nSet-Cookie: x")).toBe("/me");
    expect(safeMemberNext("")).toBe("/me");
    expect(safeMemberNext(undefined)).toBe("/me");
    expect(safeMemberNext(42)).toBe("/me");
    expect(safeMemberNext("/" + "a".repeat(600))).toBe("/me");
  });

  it("uses the fallback given", () => {
    expect(safeMemberNext(null, "/")).toBe("/");
  });
});

describe("pacificWeek", () => {
  it("runs Sunday to Saturday around any day of the week", () => {
    // November 1, 2026 is a Sunday.
    expect(pacificWeek("2026-11-01")).toEqual({ start: "2026-11-01", end: "2026-11-07" });
    expect(pacificWeek("2026-11-04")).toEqual({ start: "2026-11-01", end: "2026-11-07" });
    expect(pacificWeek("2026-11-07")).toEqual({ start: "2026-11-01", end: "2026-11-07" });
    expect(pacificWeek("2026-11-08")).toEqual({ start: "2026-11-08", end: "2026-11-14" });
  });
  it("crosses month and year ends", () => {
    expect(pacificWeek("2027-01-01")).toEqual({ start: "2026-12-27", end: "2027-01-02" });
  });
});

describe("roomLeftCents", () => {
  const LIMIT = 142970;
  it("is the whole limit for someone who has given nothing", () => {
    expect(roomLeftCents("council", { yearToDate: {}, committed: {}, monthIndex: 0 }, LIMIT)).toBe(LIMIT);
  });
  it("is what the donate form would still accept", () => {
    expect(roomLeftCents("council", { yearToDate: { council: 20000 }, committed: {}, monthIndex: 5 }, LIMIT)).toBe(122970);
    expect(roomLeftCents("school_board", { yearToDate: { council: 20000 }, committed: {}, monthIndex: 5 }, LIMIT)).toBe(LIMIT);
  });
  it("counts the rest of the year's monthly payments as already spoken for", () => {
    expect(roomLeftCents("council", { yearToDate: { council: 0 }, committed: { council: 11900 * 11 }, monthIndex: 0 }, LIMIT)).toBe(12070);
  });
  it("never goes below zero", () => {
    expect(roomLeftCents("council", { yearToDate: { council: 150000 }, committed: {}, monthIndex: 11 }, LIMIT)).toBe(0);
  });
});

describe("mergeTracking", () => {
  it("writes what the link carries", () => {
    expect(mergeTracking(null, { ref: "ABCD2345" })).toBe("ref=ABCD2345");
    expect(mergeTracking(null, { source: "flyer-newton" })).toBe("source=flyer-newton");
    expect(mergeTracking(null, { ref: "ABCD2345", source: "whatsapp" })).toBe("ref=ABCD2345&source=whatsapp");
  });
  it("keeps the referral when a later link only carries a source, and vice versa", () => {
    expect(mergeTracking("ref=ABCD2345", { source: "email-nov" })).toBe("ref=ABCD2345&source=email-nov");
    expect(mergeTracking("source=email-nov", { ref: "ABCD2345" })).toBe("ref=ABCD2345&source=email-nov");
    expect(mergeTracking("ref=OLD12345", { ref: "NEW12345" })).toBe("ref=NEW12345");
  });
  it("is stable, so an unchanged cookie is not rewritten", () => {
    expect(mergeTracking("ref=ABCD2345&source=whatsapp", { ref: "ABCD2345", source: "whatsapp" })).toBe("ref=ABCD2345&source=whatsapp");
  });
  it("drops anything that is not a plain tag", () => {
    expect(mergeTracking(null, { ref: "bad;value", source: "<script>" })).toBeNull();
    expect(mergeTracking("ref=ABCD2345", { source: "a b" })).toBe("ref=ABCD2345");
    expect(mergeTracking(null, {})).toBeNull();
  });
});

describe("locales", () => {
  it("offers the six languages, each labelled in its own script", () => {
    expect(LOCALE_IDS).toEqual(["en", "pa", "hi", "zh-Hans", "zh-Hant", "tl"]);
    const labels = Object.fromEntries(LOCALES.map((l) => [l.id, l.label]));
    expect(labels.pa).toBe("ਪੰਜਾਬੀ");
    expect(labels.hi).toBe("हिन्दी");
    expect(labels["zh-Hans"]).toBe("简体中文");
    expect(labels["zh-Hant"]).toBe("繁體中文");
  });
});

describe("startOfPacificDay", async () => {
  const { startOfPacificDay } = await import("@/lib/dates");
  it("is local midnight under daylight time (UTC-7)", () => {
    expect(startOfPacificDay(new Date("2026-07-15T18:00:00Z")).toISOString()).toBe("2026-07-15T07:00:00.000Z");
    // 01:30 UTC on the 16th is still the evening of the 15th in Surrey.
    expect(startOfPacificDay(new Date("2026-07-16T01:30:00Z")).toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });
  it("is local midnight under standard time (UTC-8), before BC's switch", () => {
    expect(startOfPacificDay(new Date("2025-12-01T20:00:00Z")).toISOString()).toBe("2025-12-01T08:00:00.000Z");
    expect(startOfPacificDay(new Date("2025-12-02T07:59:00Z")).toISOString()).toBe("2025-12-01T08:00:00.000Z");
  });
  it("is local midnight on BC's permanent UTC-7 from November 2026", () => {
    expect(startOfPacificDay(new Date("2026-12-01T20:00:00Z")).toISOString()).toBe("2026-12-01T07:00:00.000Z");
    expect(startOfPacificDay(new Date("2026-12-02T06:59:00Z")).toISOString()).toBe("2026-12-01T07:00:00.000Z");
  });
  it("handles the days the clocks change", () => {
    // 2026-03-08: midnight is still PST; 2026-11-01: midnight is still PDT.
    expect(startOfPacificDay(new Date("2026-03-08T20:00:00Z")).toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(startOfPacificDay(new Date("2026-11-01T20:00:00Z")).toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });
});
