import { describe, expect, it, vi } from "vitest";
import { DEFAULT_QUERY, describeQuery, escapeLike, hasFilters, normalizeTag, parsePeopleQuery, peopleHref, peopleParams } from "@/components/admin/people/query";
import { sparklinePath, sparklinePoints } from "@/components/admin/people/Sparkline";

vi.mock("server-only", () => ({}));
const { csvCell, csvLine, datasetPermission, DATASETS } = await import("@/lib/server/admin-data");
const { describeUserAgent, generatePassword, parseAuditFilters } = await import("@/lib/server/staff");

describe("supporter list query", () => {
  it("reads every filter from the URL and ignores junk", () => {
    const q = parsePeopleQuery({ q: "  asha   singh ", membership: "active", neighbourhood: "Newton", volunteer: "1", tag: "canvasser", newsletter: "bogus", sms: "yes", donated: "on", language: "Punjabi", sort: "name", page: "3" }, { money: true });
    expect(q).toMatchObject({ q: "asha singh", membership: "active", neighbourhood: "Newton", volunteer: true, lawnsign: false, tag: "canvasser", newsletter: "", sms: "yes", donated: true, language: "Punjabi", sort: "name", page: 3 });
    expect(parsePeopleQuery({ page: "-2", sort: ["email", "name"] })).toMatchObject({ page: 1, sort: "email" });
    expect(parsePeopleQuery(new URLSearchParams("q=x&membership=none"))).toMatchObject({ q: "x", membership: "none" });
  });

  it("drops the donor filter for anyone without the money permission", () => {
    expect(parsePeopleQuery({ donated: "1" }).donated).toBe(false);
    expect(parsePeopleQuery({ donated: "1" }, { money: false }).donated).toBe(false);
    expect(parsePeopleQuery({ donated: "1" }, { money: true }).donated).toBe(true);
  });

  it("round-trips through the URL and leaves defaults out", () => {
    const q = parsePeopleQuery({ membership: "expired", tag: "lawn sign", page: "2" });
    expect(peopleHref(q)).toBe("/admin/people?membership=expired&tag=lawn+sign&page=2");
    expect(parsePeopleQuery(peopleParams(q))).toEqual(q);
    expect(peopleHref(DEFAULT_QUERY)).toBe("/admin/people");
    expect(peopleHref(q, { page: 1 }, "/api/admin/export/people")).toBe("/api/admin/export/people?membership=expired&tag=lawn+sign");
  });

  it("knows when filters are active and describes them", () => {
    expect(hasFilters(DEFAULT_QUERY)).toBe(false);
    expect(hasFilters({ ...DEFAULT_QUERY, sort: "name", page: 4 })).toBe(false);
    expect(hasFilters({ ...DEFAULT_QUERY, donated: true })).toBe(true);
    expect(describeQuery({ ...DEFAULT_QUERY, q: "raj", membership: "active", sms: "no" })).toEqual(["Search: raj", "Membership: Active member", "No text consent"]);
  });

  it("escapes ILIKE wildcards and normalizes tags", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(normalizeTag("  door,  knocker ")).toBe("door knocker");
    expect(normalizeTag("x".repeat(60))).toHaveLength(40);
  });
});

describe("sparkline", () => {
  it("scales values to the box with the baseline at the bottom", () => {
    const points = sparklinePoints([0, 5, 10], 100, 50, 5);
    expect(points).toEqual([
      { x: 5, y: 45 },
      { x: 50, y: 25 },
      { x: 95, y: 5 },
    ]);
    expect(sparklinePath([0, 5, 10], 100, 50)).toBe("M6 44 L50 25 L94 6");
  });

  it("draws a flat line for no activity and nothing for no data", () => {
    expect(sparklinePoints([0, 0], 100, 50, 5).every((p) => p.y === 45)).toBe(true);
    expect(sparklinePath([])).toBe("");
  });
});

describe("CSV", () => {
  it("formats cells and lines in header order", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-11-02T18:30:00Z"))).toBe("2026-11-02T18:30:00.000Z");
    expect(csvCell(["a", "b"])).toBe("a; b");
    expect(csvCell("+1 604")).toBe("'+1 604");
    expect(csvLine(["b", "a"], { a: 1, b: 'say "hi", ok' })).toBe('"say ""hi"", ok",1\r\n');
  });

  it("maps every dataset to a permission", () => {
    expect(DATASETS).toEqual(["members", "contributions", "monthly_donors", "newsletter", "signatures", "rsvps", "shifts", "orders"]);
    expect(DATASETS.map(datasetPermission)).toEqual(["people", "money", "money", "people", "people", "people", "people", "money"]);
  });
});

describe("staff helpers", () => {
  it("generates long, unambiguous one-time passwords", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(20);
    expect(generatePassword(4)).toHaveLength(12);
  });

  it("describes browsers and reads audit filters", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(parseAuditFilters({ user: "system", action: ["export"], page: "x" })).toEqual({ user: "system", action: "export", entity: "", page: 1 });
  });
});
