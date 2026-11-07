import { describe, expect, it } from "vitest";
import { pacificDate } from "@/lib/ics";
import { hasCurrentBcRules, vancouverOffsetHours } from "@/lib/tz-check";

describe("time-zone rules (tzdata 2026e)", () => {
  it("keeps BC on UTC-7 from November 1, 2026, with the old changes before it", () => {
    expect(vancouverOffsetHours(new Date("2025-12-15T12:00:00Z"))).toBe(-8);
    expect(vancouverOffsetHours(new Date("2026-07-01T12:00:00Z"))).toBe(-7);
    expect(vancouverOffsetHours(new Date("2026-12-15T12:00:00Z"))).toBe(-7);
    expect(vancouverOffsetHours(new Date("2027-01-15T12:00:00Z"))).toBe(-7);
    expect(hasCurrentBcRules()).toBe(true);
  });
  it("puts a 7 p.m. event in December at 02:00 UTC the next day", () => {
    expect(pacificDate("2026-12-03", 19).toISOString()).toBe("2026-12-04T02:00:00.000Z");
  });
});
