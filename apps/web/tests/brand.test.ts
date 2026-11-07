// The brand: presets, the tokens the stylesheets read, the contrast check,
// and the look a deployment starts with.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  brandCss,
  brandFromPreset,
  brandSchema,
  brandTokens,
  contrast,
  contrastPairs,
  derivedColors,
  FONTS,
  PRESET_IDS,
  PRESETS,
} from "@/lib/brand";

vi.mock("server-only", () => ({}));
const { defaultBrand, parseStoredBrand } = await import("@/lib/server/brand");

const root = path.resolve(import.meta.dirname, "..");
const globals = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
const rootBlock = /:root \{([\s\S]*?)\n\}/.exec(globals)![1];
const cssDefaults = Object.fromEntries([...rootBlock.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

describe("the Imagine Surrey preset", () => {
  it("is exactly today's look: every token equals the stylesheet's own value", () => {
    const tokens = brandTokens(brandFromPreset("imagine-surrey"));
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(cssDefaults).sort());
    for (const [k, v] of Object.entries(tokens)) expect([k, v.toLowerCase()]).toEqual([k, cssDefaults[k].toLowerCase()]);
  });
  it("keeps the navy, red, yellow, Montserrat and 10px corners documented in CONTRIBUTING.md", () => {
    const t = brandTokens(brandFromPreset("imagine-surrey"));
    expect([t["--primary"], t["--accent"], t["--accent-fill"], t["--highlight"], t["--radius"]]).toEqual(["#003979", "#ef2023", "#d81b1e", "#fff100", "10px"]);
    expect(t["--font"]).toBe('var(--font-montserrat), "Montserrat", system-ui, sans-serif');
  });
  it("uses its hand-tuned shades only while their colours are unchanged", () => {
    const edited = brandFromPreset("imagine-surrey");
    edited.colors.primary = "#1a5c2e";
    const d = derivedColors(edited);
    expect(d.primaryDark).not.toBe("#00285a");
    expect(d.accentFill).toBe("#d81b1e"); // accent untouched
  });
});

describe("presets", () => {
  it("there are at least four, Imagine Surrey and Civic among them, each distinct", () => {
    expect(PRESET_IDS.length).toBeGreaterThanOrEqual(4);
    expect(PRESET_IDS).toEqual(expect.arrayContaining(["imagine-surrey", "civic"]));
    const looks = PRESET_IDS.map((id) => `${PRESETS[id].colors.primary}/${PRESETS[id].colors.accent}/${PRESETS[id].font}`);
    expect(new Set(looks).size).toBe(looks.length);
    expect(new Set(PRESET_IDS.map((id) => PRESETS[id].font)).size).toBeGreaterThanOrEqual(4);
  });
  it.each(PRESET_IDS)("%s passes every pair of the contrast check", (id) => {
    const failing = contrastPairs(brandFromPreset(id)).filter((p) => !p.ok);
    expect(failing).toEqual([]);
  });
  it("only use bundled fonts", () => {
    for (const id of PRESET_IDS) expect(Object.keys(FONTS)).toContain(PRESETS[id].font);
    const fontsTs = readFileSync(path.join(root, "src/app/fonts.ts"), "utf8");
    for (const f of Object.values(FONTS)) expect(fontsTs).toContain(`variable: "${f.cssVar}"`);
    expect(fontsTs).not.toMatch(/next\/font\/google|https?:\/\//);
  });
});

describe("the contrast check", () => {
  it("measures WCAG ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
    expect(contrast("#ffffff", "#ef2023")).toBeCloseTo(4.25, 1);
  });
  it("flags pairs under 4.5:1 with their ratio", () => {
    const pale = brandFromPreset("civic");
    pale.colors.primary = "#9ec5d0";
    const flagged = contrastPairs(pale).filter((p) => !p.ok);
    expect(flagged.map((p) => p.id)).toEqual(expect.arrayContaining(["links", "primary-button"]));
    for (const p of flagged) expect(p.ratio).toBeLessThan(4.5);
  });
  it("darkens the accent fill until its text reads, so the donate button stays legible", () => {
    const b = brandFromPreset("civic");
    b.colors.accent = "#ff8a3d";
    expect(contrast(b.colors.onAccent, derivedColors(b).accentFill)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the stored brand", () => {
  it("normalizes hex colours and refuses anything else", () => {
    const b = { ...brandFromPreset("civic"), colors: { ...brandFromPreset("civic").colors, primary: "0F4C5C" } };
    expect(brandSchema.parse(b).colors.primary).toBe("#0f4c5c");
    expect(brandSchema.safeParse({ ...b, colors: { ...b.colors, ink: "red" } }).success).toBe(false);
    expect(brandSchema.safeParse({ ...b, font: "comic-sans" }).success).toBe(false);
    expect(brandSchema.safeParse({ ...b, preset: "unknown" }).success).toBe(false);
  });
  it("a row that no longer fits is ignored, not fatal", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseStoredBrand({ preset: "civic" })).toBeNull();
    spy.mockRestore();
  });
  it("the CSS written into the page can't break out of its <style> element", () => {
    const b = brandFromPreset("civic");
    expect(brandCss(b)).toMatch(/^:root\{--primary:#0f4c5c;.*\}$/);
    expect(brandCss(b)).not.toMatch(/<|>/);
  });
});

describe("the look a deployment starts with", () => {
  it("Imagine Surrey: its preset and its logos", () => {
    expect(defaultBrand("imagine-surrey", undefined)).toEqual({ ...brandFromPreset("imagine-surrey"), logoUrl: "/images/logo.webp", logoOnDarkUrl: "/images/logo-light.png" });
  });
  it("a new client: Civic, with no logo (the name as a wordmark)", () => {
    expect(defaultBrand(undefined, undefined)).toEqual(brandFromPreset("civic"));
    expect(defaultBrand("default", undefined)).toEqual(brandFromPreset("civic"));
  });
  it("BASE_WEB_BRAND_PRESET picks another preset, keeping the client's logo", () => {
    const b = defaultBrand("imagine-surrey", "heritage");
    expect(b.preset).toBe("heritage");
    expect(b.colors).toEqual(PRESETS.heritage.colors);
    expect(b.logoUrl).toBe("/images/logo.webp");
  });
  it("an unknown preset or client falls back, and says so", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(defaultBrand("nobody", "neon").preset).toBe("civic");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
