import { describe, expect, it } from "vitest";
import { MODEL_PRICES, estimateCostUsd, knownModels, priceFor } from "../src/index.ts";

const M = 1_000_000;

describe("pricing", () => {
  it("prices the three current models per the skill's table", () => {
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: M, outputTokens: M })).toBeCloseTo(24, 6);
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: M, outputTokens: M })).toBeCloseTo(12, 6);
    expect(estimateCostUsd("claude-haiku-5-5", { inputTokens: M, outputTokens: M })).toBeCloseTo(0.6, 6);
  });

  it("scales linearly and accounts cache reads and writes separately", () => {
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.004 + 0.004, 9);
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: M })).toBeCloseTo(0.2, 9);
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: M })).toBeCloseTo(5, 9);
  });

  it("resolves served ids by exact match, then longest known prefix", () => {
    expect(priceFor("claude-opus-5-5")).toBe(MODEL_PRICES["claude-opus-5-5"]);
    expect(priceFor("claude-opus-5-5-20260401")).toBe(MODEL_PRICES["claude-opus-5-5"]);
    expect(priceFor("claude-opus-5-20260101")).toBe(MODEL_PRICES["claude-opus-5"]);
    expect(priceFor("claude-opus-55")).toBeNull();
    expect(priceFor("gpt-9")).toBeNull();
  });

  it("never guesses a price for an unknown model", () => {
    expect(estimateCostUsd("some-other-model", { inputTokens: M, outputTokens: M })).toBe(0);
    expect(knownModels()).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]));
  });
});
