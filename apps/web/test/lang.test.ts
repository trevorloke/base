import { describe, expect, it } from "vitest";
import { mayNeedTranslating } from "../src/lib/lang.ts";

describe("when the feed offers Translate", () => {
  it("offers it for a known foreign language and never for the team's own", () => {
    expect(mayNeedTranslating("ja", "新しいジャケットはいつ？", "en")).toBe(true);
    expect(mayNeedTranslating("en-GB", "Brilliant jacket", "en")).toBe(false);
    expect(mayNeedTranslating("en", "Great jacket", "ja")).toBe(true);
  });

  it("skips short plain English an English-speaking team can read, but not accented or non-Latin text", () => {
    expect(mayNeedTranslating(null, "the foam sit pad is elite, agreed", "en")).toBe(false);
    expect(mayNeedTranslating(null, "lol same 👍", "en")).toBe(false);
    expect(mayNeedTranslating(null, "ça marche", "en")).toBe(true);
    expect(mayNeedTranslating(null, "好的", "en")).toBe(true);
    expect(mayNeedTranslating(null, "ok gracias", "ja")).toBe(true); // a Japanese team gets the offer
    expect(mayNeedTranslating(null, "", "en")).toBe(false);
  });
});
