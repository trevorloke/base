import { describe, expect, it } from "vitest";
import { applyCustomAmount, parseCustomAmount, presetPressed } from "@/components/forms/amount";
import { readTrackingCookie } from "@/components/forms/tracking";
import { formatPostalCodeInput, isCompletePostalCode, postalCodePreview } from "@/lib/postal";
import { localeFromLang } from "@/lib/validation";

const oneTime = { frequency: "one_time" as const, limitCents: 142970 };
const monthly = { frequency: "monthly" as const, limitCents: 142970 };

describe("custom donation amount", () => {
  it("typing a custom amount updates the choice and clears the preset selection", () => {
    const start = { frequency: "one_time" as const, tier: "star" as const, amountCents: 142970 };
    const next = applyCustomAmount(start, "35", oneTime);
    expect(next).toEqual({ frequency: "one_time", tier: "standard", amountCents: 3500 });
    // A preset button is only pressed when the custom box is empty, even if the typed amount matches it.
    expect(presetPressed({ ...next, amountCents: 2500 }, 2500, "25")).toBe(false);
    expect(presetPressed({ ...next, amountCents: 2500 }, 2500, "")).toBe(true);
  });

  it("keeps partial decimals while typing and accepts dollars with symbols", () => {
    expect(parseCustomAmount("35.", oneTime)).toEqual({ cents: 3500, error: null });
    expect(parseCustomAmount("35.5", oneTime)).toEqual({ cents: 3550, error: null });
    expect(parseCustomAmount("$1,000", oneTime)).toEqual({ cents: 100000, error: null });
    expect(parseCustomAmount(" 20 ", oneTime)).toEqual({ cents: 2000, error: null });
    expect(parseCustomAmount("", oneTime)).toEqual({ cents: null, error: null });
  });

  it("rejects non-numbers", () => {
    for (const text of ["abc", "1.2.3", "$", "12a", "1e5", "-5"]) {
      const r = parseCustomAmount(text, oneTime);
      expect(r.cents, text).toBeNull();
      expect(r.error, text).toMatch(/amount in dollars/);
    }
    expect(parseCustomAmount("35.123", oneTime).error).toMatch(/cents/);
  });

  it("validates the minimum and the annual maximum", () => {
    expect(parseCustomAmount("2", oneTime)).toEqual({ cents: 200, error: "The smallest contribution we can take online is $5." });
    expect(parseCustomAmount("0", oneTime).error).toMatch(/smallest/);
    expect(parseCustomAmount("1429.70", oneTime)).toEqual({ cents: 142970, error: null });
    expect(parseCustomAmount("1430", oneTime).error).toBe("The most you can give is $1,429.70 a year under BC law.");
    expect(parseCustomAmount("119", monthly)).toEqual({ cents: 11900, error: null });
    expect(parseCustomAmount("120", monthly).error).toBe("The most you can give monthly is $119 a month ($1,429.70 a year under BC law).");
  });

  it("an invalid custom amount leaves no amount selected, so the form cannot submit it", () => {
    const next = applyCustomAmount({ frequency: "one_time", tier: "standard", amountCents: 5000 }, "abc", oneTime);
    expect(next).toEqual({ frequency: "one_time", tier: "standard", amountCents: 0 });
  });
});

describe("postal code input", () => {
  it("upper-cases and inserts the space", () => {
    expect(formatPostalCodeInput("v3s1a1")).toBe("V3S 1A1");
    expect(formatPostalCodeInput("v3s")).toBe("V3S");
    expect(formatPostalCodeInput("v3s 1")).toBe("V3S 1");
    expect(formatPostalCodeInput("V3S-1A1-extra")).toBe("V3S 1A1");
    expect(isCompletePostalCode("v3s1a1")).toBe(true);
    expect(isCompletePostalCode("v3s1a")).toBe(false);
  });
  it("previews the town centre", () => {
    expect(postalCodePreview("v3w")).toBe("That’s Newton");
    expect(postalCodePreview("V3W 2A1")).toBe("That’s Newton");
    expect(postalCodePreview("v3")).toBeNull();
    expect(postalCodePreview("M5V 2T6")).toBeNull();
  });
});

describe("tracking", () => {
  it("reads ref and source from the tracking cookie", () => {
    expect(readTrackingCookie("a=1; is_track=ref%3DABC234%26source%3Dwhatsapp; b=2")).toEqual({ ref: "ABC234", source: "whatsapp" });
    expect(readTrackingCookie("is_track=source%3Dflyer")).toEqual({ source: "flyer" });
    expect(readTrackingCookie("")).toEqual({});
    expect(readTrackingCookie("other=is_track%3Dref%3DX")).toEqual({});
  });
  it("maps the page language to a site locale", () => {
    expect(localeFromLang("en-CA")).toBe("en");
    expect(localeFromLang("pa")).toBe("pa");
    expect(localeFromLang("zh-TW")).toBe("zh-Hant");
    expect(localeFromLang("zh-CN")).toBe("zh-Hans");
    expect(localeFromLang("zh-Hans")).toBe("zh-Hans");
    expect(localeFromLang("fil-PH")).toBe("tl");
    expect(localeFromLang("fr-CA")).toBeUndefined();
    expect(localeFromLang("")).toBeUndefined();
  });
});
