import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { toCsv } = await import("@/lib/server/admin-data");

describe("toCsv", () => {
  it("quotes commas and neutralizes formulas", () => {
    const csv = toCsv([{ name: "Singh, Asha", note: "=HYPERLINK(1)", n: 3 }]);
    expect(csv).toBe(`name,note,n\r\n"Singh, Asha",'=HYPERLINK(1),3\r\n`);
  });
});
