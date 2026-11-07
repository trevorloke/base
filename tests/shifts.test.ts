import { describe, expect, it } from "vitest";
import { addDays, formatWeekRange, TASK_PALETTE, textColorFor, todayInSurrey, weekDays, weekStart } from "@/lib/shifts";

describe("week helpers", () => {
  it("starts weeks on Sunday", () => {
    expect(weekStart("2026-10-23")).toBe("2026-10-18"); // a Friday
    expect(weekStart("2026-10-18")).toBe("2026-10-18"); // a Sunday
    expect(weekStart("2026-10-24")).toBe("2026-10-18"); // Saturday
  });
  it("runs Sunday to Saturday across month and DST boundaries", () => {
    expect(weekDays("2026-10-25")).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
    expect(addDays("2026-11-01", 7)).toBe("2026-11-08"); // DST ends Nov 1 in BC
    expect(addDays("2026-12-27", 7)).toBe("2027-01-03");
  });
  it("uses Surrey's date, not UTC's", () => {
    expect(todayInSurrey(new Date("2026-10-24T05:00:00Z"))).toBe("2026-10-23");
  });
  it("labels the week", () => {
    expect(formatWeekRange("2026-10-18")).toBe("October 18 – October 24, 2026");
  });
});

describe("textColorFor", () => {
  it("picks readable text on brand colours", () => {
    expect(textColorFor("#003979")).toBe("#FFFFFF");
    expect(textColorFor("#FFF100")).toBe("#0F1E33");
    expect(textColorFor("#EF2023")).toBe("#FFFFFF");
  });
  it("gives every palette colour a text colour", () => {
    for (const c of TASK_PALETTE) expect(["#FFFFFF", "#0F1E33"]).toContain(textColorFor(c));
  });
});
