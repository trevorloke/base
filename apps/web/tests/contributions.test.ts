import { describe, expect, it } from "vitest";
import {
  addYear,
  ageOnDate,
  checkAnnualLimit,
  excessOverLimit,
  isYouthMember,
  limitFromRows,
  limitYearNeeded,
  membershipAmountProblem,
  membershipMinimumFor,
  membershipMinimums,
  membershipSuggestions,
  pacificDateIso,
  pacificMonthBounds,
  pacificMonthStart,
  pacificYear,
  pacificYearBounds,
  pacificYearMonth,
  slateAmountsFor,
  starClubCents,
} from "@/lib/contributions";
import { parseMembershipAmount } from "@/components/forms/amount";
import { formatCents } from "@/lib/money";

const LIMIT = 142970;

describe("formatCents", () => {
  it("drops cents on whole dollars and groups thousands", () => {
    expect(formatCents(5000)).toBe("$50");
    expect(formatCents(142970)).toBe("$1,429.70");
    expect(formatCents(285940)).toBe("$2,859.40");
    expect(formatCents(11900)).toBe("$119");
  });
});

describe("Star and Superstar clubs", () => {
  it("matches the design's amounts", () => {
    expect(starClubCents("one_time", LIMIT)).toBe(142970);
    expect(starClubCents("monthly", LIMIT)).toBe(11900);
  });
  it("splits Superstar across both slates", () => {
    expect(slateAmountsFor("superstar", "one_time", 0, LIMIT)).toEqual({ council: 142970, school_board: 142970 });
    expect(slateAmountsFor("star", "monthly", 0, LIMIT)).toEqual({ council: 11900 });
    expect(slateAmountsFor("standard", "one_time", 2500, LIMIT)).toEqual({ council: 2500 });
  });
});

describe("checkAnnualLimit", () => {
  const base = { yearToDate: {}, committed: {}, limitCents: LIMIT, monthIndex: 0 };

  it("allows the Star Club maximum for a new donor", () => {
    expect(checkAnnualLimit({ ...base, frequency: "one_time", slateAmounts: { council: LIMIT } }).ok).toBe(true);
  });

  it("refuses a gift that would cross the limit and reports how much is left (for the portal, never a public message)", () => {
    const r = checkAnnualLimit({ ...base, frequency: "one_time", slateAmounts: { council: 50000 }, yearToDate: { council: 100000 } });
    expect(r).toEqual({ ok: false, slate: "council", remainingCents: 42970 });
  });

  it("counts the rest of the year's payments for a monthly gift", () => {
    // In July there are six payments left: 6 × $119 = $714 fits beside $700.
    expect(checkAnnualLimit({ ...base, monthIndex: 6, frequency: "monthly", slateAmounts: { council: 11900 }, yearToDate: { council: 70000 } }).ok).toBe(true);
    // …but not beside $800.
    expect(checkAnnualLimit({ ...base, monthIndex: 6, frequency: "monthly", slateAmounts: { council: 11900 }, yearToDate: { council: 80000 } }).ok).toBe(false);
  });

  it("refuses a monthly gift bigger than a twelfth of the limit, even in December", () => {
    expect(checkAnnualLimit({ ...base, monthIndex: 11, frequency: "monthly", slateAmounts: { council: 12000 } }).ok).toBe(false);
  });

  it("counts payments already scheduled by an active monthly gift", () => {
    const r = checkAnnualLimit({ ...base, frequency: "one_time", slateAmounts: { council: 100000 }, committed: { council: 11900 * 11 } });
    expect(r.ok).toBe(false);
  });

  it("checks each slate separately", () => {
    const r = checkAnnualLimit({
      ...base,
      frequency: "one_time",
      slateAmounts: { council: LIMIT, school_board: LIMIT },
      yearToDate: { council: 0, school_board: 100 },
    });
    expect(r).toMatchObject({ ok: false, slate: "school_board" });
  });
});

describe("excessOverLimit", () => {
  it("returns only the part over the limit", () => {
    expect(excessOverLimit(140000, 5000, LIMIT)).toBe(2030);
    expect(excessOverLimit(0, 5000, LIMIT)).toBe(0);
    expect(excessOverLimit(LIMIT, 5000, LIMIT)).toBe(5000);
  });
});

describe("Pacific calendar", () => {
  it("counts New Year's Eve evening in Surrey as the old year", () => {
    expect(pacificYearMonth(new Date("2027-01-01T05:00:00Z"))).toEqual({ year: 2026, monthIndex: 11 });
    expect(pacificYearMonth(new Date("2027-01-01T09:00:00Z"))).toEqual({ year: 2027, monthIndex: 0 });
  });

  it("starts months at Pacific midnight on either side of a clock change", () => {
    expect(pacificMonthStart(2026, 0).toISOString()).toBe("2026-01-01T08:00:00.000Z"); // PST
    expect(pacificMonthStart(2026, 6).toISOString()).toBe("2026-07-01T07:00:00.000Z"); // PDT
    expect(pacificMonthStart(2026, 10).toISOString()).toBe("2026-11-01T07:00:00.000Z"); // BC stays on UTC-7 from this day
    expect(pacificMonthStart(2026, 2).toISOString()).toBe("2026-03-01T08:00:00.000Z"); // clocks go forward later that month
  });

  it("bounds a contribution year and a month", () => {
    // BC is on permanent UTC-7 from November 1, 2026 (tzdata 2026e), so 2027 starts at 07:00 UTC.
    expect(pacificYearBounds(2026).map((d) => d.toISOString())).toEqual(["2026-01-01T08:00:00.000Z", "2027-01-01T07:00:00.000Z"]);
    expect(pacificMonthBounds(2026, 11).map((d) => d.toISOString())).toEqual(["2026-12-01T07:00:00.000Z", "2027-01-01T07:00:00.000Z"]);
    expect(pacificMonthBounds(2026, 9).map((d) => d.toISOString())).toEqual(["2026-10-01T07:00:00.000Z", "2026-11-01T07:00:00.000Z"]);
  });

  it("adds a year to a date", () => {
    expect(addYear(new Date("2026-02-28T20:00:00Z")).toISOString()).toBe("2027-02-28T20:00:00.000Z");
  });
});

// ── Contribution limits by year ─────────────────────────────────────────────

describe("the contribution year switches at midnight Pacific on January 1", () => {
  // Midnight on January 1, 2027 in Surrey is 07:00 UTC (BC's permanent UTC-7 from November 2026).
  const lastSecond = new Date("2027-01-01T06:59:59Z");
  const firstSecond = new Date("2027-01-01T07:00:00Z");

  it("counts the last second of December 31 in the old year and midnight in the new one", () => {
    expect(pacificYear(lastSecond)).toBe(2026);
    expect(pacificYear(firstSecond)).toBe(2027);
    expect(pacificDateIso(lastSecond)).toBe("2026-12-31");
    expect(pacificDateIso(firstSecond)).toBe("2027-01-01");
  });

  it("uses each year's stored limit, switching with the year", () => {
    const rows = [
      { year: 2026, cents: 142970 },
      { year: 2027, cents: 145000 },
    ];
    expect(limitFromRows(rows, pacificYear(lastSecond), 100000)).toBe(142970);
    expect(limitFromRows(rows, pacificYear(firstSecond), 100000)).toBe(145000);
  });

  it("falls back to the configured limit for a year with no row", () => {
    expect(limitFromRows([{ year: 2026, cents: 142970 }], 2027, 142970)).toBe(142970);
    expect(limitFromRows([], 2026, 150000)).toBe(150000);
  });
});

describe("limitYearNeeded (the dashboard nudge)", () => {
  it("says nothing before December 1 when this year is stored", () => {
    expect(limitYearNeeded(new Date("2026-11-30T12:00:00Z"), [2026])).toBeNull();
    // 23:59 on November 30 in Surrey is still November.
    expect(limitYearNeeded(new Date("2026-12-01T06:59:00Z"), [2026])).toBeNull();
  });

  it("asks for next year from December 1, Pacific, until it is stored", () => {
    expect(limitYearNeeded(new Date("2026-12-01T07:00:00Z"), [2026])).toBe(2027);
    expect(limitYearNeeded(new Date("2026-12-31T20:00:00Z"), [2026])).toBe(2027);
    expect(limitYearNeeded(new Date("2026-12-15T20:00:00Z"), [2026, 2027])).toBeNull();
  });

  it("asks for this year whenever it is missing", () => {
    expect(limitYearNeeded(new Date("2027-01-01T07:00:00Z"), [2026])).toBe(2027);
    expect(limitYearNeeded(new Date("2026-06-01T12:00:00Z"), [])).toBe(2026);
  });
});

// ── Membership by donation ─────────────────────────────────────────────────

describe("membership minimums", () => {
  it("makes the youth minimum half the standard one by default", () => {
    expect(membershipMinimums(1000)).toEqual({ standardCents: 1000, youthCents: 500 });
    expect(membershipMinimums(1001)).toEqual({ standardCents: 1001, youthCents: 501 });
  });

  it("uses MEMBERSHIP_YOUTH_MIN_CENTS when set, never above the standard minimum", () => {
    expect(membershipMinimums(1000, 300)).toEqual({ standardCents: 1000, youthCents: 300 });
    expect(membershipMinimums(1000, 0)).toEqual({ standardCents: 1000, youthCents: 0 });
    expect(membershipMinimums(1000, 5000)).toEqual({ standardCents: 1000, youthCents: 1000 });
  });

  it("keeps a free membership free", () => {
    expect(membershipMinimums(0)).toEqual({ standardCents: 0, youthCents: 0 });
    expect(membershipMinimums(0, 500)).toEqual({ standardCents: 0, youthCents: 0 });
  });

  it("applies the minimum for the person", () => {
    const m = membershipMinimums(1000);
    expect(membershipMinimumFor(m, false)).toBe(1000);
    expect(membershipMinimumFor(m, true)).toBe(500);
  });
});

describe("the youth age rule (14 to 30 on the Pacific day they join)", () => {
  // Noon in Surrey on November 7, 2026.
  const now = new Date("2026-11-07T20:00:00Z");

  it("counts whole years by calendar date", () => {
    expect(ageOnDate("1996-11-07", "2026-11-07")).toBe(30);
    expect(ageOnDate("1996-11-08", "2026-11-07")).toBe(29);
    expect(ageOnDate("2000-02-29", "2026-02-28")).toBe(25);
    expect(ageOnDate("2000-02-29", "2026-03-01")).toBe(26);
    expect(ageOnDate("not a date", "2026-11-07")).toBeUndefined();
  });

  it("includes 14 and 30, and excludes 13 and 31", () => {
    expect(isYouthMember("2012-11-07", now)).toBe(true); // 14 today
    expect(isYouthMember("2012-11-08", now)).toBe(false); // 13
    expect(isYouthMember("1996-11-08", now)).toBe(true); // 30 until tomorrow
    expect(isYouthMember("1995-11-08", now)).toBe(true); // 30, turning 31 tomorrow
    expect(isYouthMember("1995-11-07", now)).toBe(false); // 31 today
    expect(isYouthMember("1960-01-01", now)).toBe(false);
  });

  it("uses the Pacific date, not UTC: a 31st birthday starts at midnight in Surrey", () => {
    // 23:30 on November 6 in Surrey is already November 7 in UTC.
    const lateEvening = new Date("2026-11-07T06:30:00Z");
    expect(isYouthMember("1995-11-07", lateEvening)).toBe(true);
    expect(isYouthMember("1995-11-07", new Date("2026-11-07T07:00:00Z"))).toBe(false);
  });
});

describe("membership amounts", () => {
  const m = membershipMinimums(1000);

  it("suggests amounts starting at the minimum", () => {
    expect(membershipSuggestions(1000)).toEqual([1000, 2500, 5000, 10000]);
    expect(membershipSuggestions(500)).toEqual([500, 1000, 2500, 5000]);
    expect(membershipSuggestions(2000)).toEqual([2000, 2500, 5000, 10000]);
  });

  it("refuses less than the minimum, naming the youth minimum", () => {
    expect(membershipAmountProblem(999, m, false, LIMIT)).toBe("The smallest membership is $10 a year ($5 for members aged 14 to 30).");
    expect(membershipAmountProblem(499, m, true, LIMIT)).toBe("The smallest youth membership (ages 14 to 30) is $5 a year.");
    expect(membershipAmountProblem(0, m, false, LIMIT)).not.toBeNull();
  });

  it("takes the minimum and anything up to the year's limit", () => {
    expect(membershipAmountProblem(1000, m, false, LIMIT)).toBeNull();
    expect(membershipAmountProblem(500, m, true, LIMIT)).toBeNull();
    expect(membershipAmountProblem(2550, m, false, LIMIT)).toBeNull();
    expect(membershipAmountProblem(LIMIT, m, false, LIMIT)).toBeNull();
    expect(membershipAmountProblem(LIMIT + 1, m, false, LIMIT)).toBe("The most you can give is $1,429.70 a year under BC law.");
  });

  it("refuses fractions of a cent", () => {
    expect(membershipAmountProblem(1000.5, m, false, LIMIT)).not.toBeNull();
  });

  it("parses the other-amount box", () => {
    const rules = { minimums: m, youth: false, maxCents: LIMIT };
    expect(parseMembershipAmount("", rules)).toEqual({ cents: null, error: null });
    expect(parseMembershipAmount("35", rules)).toEqual({ cents: 3500, error: null });
    expect(parseMembershipAmount("$12.50", rules)).toEqual({ cents: 1250, error: null });
    expect(parseMembershipAmount("7", rules)).toEqual({ cents: 700, error: "The smallest membership is $10 a year ($5 for members aged 14 to 30)." });
    expect(parseMembershipAmount("7", { ...rules, youth: true })).toEqual({ cents: 700, error: null });
    expect(parseMembershipAmount("4.99", { ...rules, youth: true }).error).toBe("The smallest youth membership (ages 14 to 30) is $5 a year.");
    expect(parseMembershipAmount("ten", rules).error).toBe("Enter an amount in dollars, like 35.");
    expect(parseMembershipAmount("2,000", rules).error).toBe("The most you can give is $1,429.70 a year under BC law.");
  });
});
