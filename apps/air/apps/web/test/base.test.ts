import { describe, expect, it } from "vitest";
import { BASE_PATH, joinBase, normalizeBasePath } from "../src/lib/base.ts";

describe("the browser's base path helper", () => {
  it("normalizes what the server wrote and joins paths under it", () => {
    expect(BASE_PATH).toBe(""); // no window in tests: the root
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("/air/")).toBe("/air");
    expect(joinBase("/air", "/v1/me")).toBe("/air/v1/me");
    expect(joinBase("/air", "auth/base?next=%2F")).toBe("/air/auth/base?next=%2F");
    expect(joinBase("", "/v1/me")).toBe("/v1/me");
  });
});
