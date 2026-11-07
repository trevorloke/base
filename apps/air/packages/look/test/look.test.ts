import { describe, expect, it } from "vitest";
import {
  brandChanges,
  brandCss,
  brandFromPreset,
  brandFromSettings,
  contrastRatio,
  contrastReport,
  DEFAULT_BRAND,
  lowContrast,
  luminance,
  normalizeHex,
  parseBrand,
  PRESETS,
  themeAttr,
} from "../src/index.ts";

describe("base air's look", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(luminance("#ffffff")).toBe(1);
  });

  it("normalizes hex colours and refuses anything else", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("38BDF8")).toBe("#38bdf8");
    for (const bad of ["red", "#12345", "#1234567", "url(x)", "#38bdf8;}body{display:none", 0, null]) expect(normalizeHex(bad)).toBeNull();
  });

  it("ships Air first, dark, sky blue and violet on deep navy, plus at least three others including a light one", () => {
    const air = PRESETS[0]!;
    expect(air.id).toBe("air");
    expect(air.mode).toBe("dark");
    expect(DEFAULT_BRAND.preset).toBe("air");
    expect(luminance(air.palettes.dark.surface)).toBeLessThan(0.02); // deep
    const [r, , b] = [1, 3, 5].map((i) => parseInt(air.palettes.dark.surface.slice(i, i + 2), 16));
    expect(b!).toBeGreaterThan(r!); // navy, not black or green
    expect(PRESETS.length).toBeGreaterThanOrEqual(4);
    expect(PRESETS.some((p) => p.mode === "light")).toBe(true);
    expect(new Set(PRESETS.map((p) => p.palettes.dark.primary)).size).toBe(PRESETS.length); // distinct
  });

  it("every preset passes the contrast check in both schemes", () => {
    for (const p of PRESETS) {
      const report = contrastReport(brandFromPreset(p.id), ["light", "dark"]);
      const bad = report.filter((x) => !x.ok).map((x) => `${p.id} ${x.id} ${x.ratio}`);
      expect(bad).toEqual([]);
    }
  });

  it("flags pairs under 4.5:1 with their ratio, only for the schemes the brand shows", () => {
    const b = brandFromPreset("air");
    b.palettes.dark.onPrimary = "#7dd3fc"; // pale on sky blue
    const low = lowContrast(b);
    expect(low.map((x) => x.id)).toEqual(["dark:button"]);
    expect(low[0]!.ratio).toBeLessThan(4.5);
    b.palettes.light.ink = "#cccccc"; // light is not shown while the brand is pinned to dark
    expect(lowContrast(b).map((x) => x.id)).toEqual(["dark:button"]);
    b.mode = "device";
    expect(lowContrast(b).length).toBeGreaterThan(1);
  });

  it("parses untrusted input field by field and reports what is wrong", () => {
    const { brand, problems } = parseBrand({
      preset: "ember",
      name: "  Imagine Surrey\u0007 ",
      logoUrl: "javascript:alert(1)",
      palettes: { dark: { primary: "#FFF", ink: "expression(alert(1))" } },
      font: "comic-sans",
      corners: "round",
      mode: "device",
    });
    expect(brand.preset).toBe("ember");
    expect(brand.name).toBe("Imagine Surrey");
    expect(brand.palettes.dark.primary).toBe("#ffffff");
    expect(brand.palettes.dark.ink).toBe(DEFAULT_BRAND.palettes.dark.ink);
    expect(brand.corners).toBe("round");
    expect(brand.mode).toBe("device");
    expect(problems.map((p) => p.field).sort()).toEqual(["font", "logoUrl", "palettes.dark.ink"]);
    expect(parseBrand({ logoUrl: "https://cdn.example.org/logo.png" }).brand.logoUrl).toBe("https://cdn.example.org/logo.png");
    expect(parseBrand({ name: "x".repeat(61) }).problems[0]!.field).toBe("name");
  });

  it("writes only validated values into CSS", () => {
    const css = brandCss(brandFromPreset("lagoon"));
    expect(css).toContain(":root{color-scheme:light;");
    expect(css).toContain("--primary:#0f766e");
    expect(css).toContain(':root[data-theme="dark"]{color-scheme:dark;');
    expect(css).toContain("--primary:#2dd4bf");
    expect(css).toContain("--radius:14px");
    expect(css).not.toMatch(/<|url\(|expression/);
    expect(brandCss(DEFAULT_BRAND, ".preview")).toContain('.preview[data-theme="dark"]');
    expect(themeAttr("device")).toBeNull();
    expect(themeAttr("dark")).toBe("dark");
  });

  it("is pre-configured from settings", () => {
    const { brand, problems } = brandFromSettings({ BASE_AIR_BRAND_PRESET: "newsprint", BASE_AIR_BRAND_NAME: "Imagine Surrey", BASE_AIR_BRAND_PRIMARY: "#0b3d91", BASE_AIR_BRAND_MODE: "device" });
    expect(problems).toEqual([]);
    expect(brand.preset).toBe("newsprint");
    expect(brand.font).toBe("source-serif");
    expect(brand.name).toBe("Imagine Surrey");
    expect(brand.palettes.light.primary).toBe("#0b3d91");
    expect(brand.palettes.dark.primary).toBe("#0b3d91");
    expect(brand.mode).toBe("device");
    const bad = brandFromSettings({ BASE_AIR_BRAND_PRESET: "nope", BASE_AIR_BRAND_ACCENT: "violet" });
    expect(bad.brand.preset).toBe("air");
    expect(bad.problems.map((p) => p.field)).toEqual(["BASE_AIR_BRAND_PRESET", "BASE_AIR_BRAND_ACCENT"]);
  });

  it("lists what changed", () => {
    const a = brandFromPreset("air");
    const b = { ...brandFromPreset("air"), name: "X" };
    b.palettes.dark.primary = "#000000";
    expect(brandChanges(a, b)).toEqual(["name", "palettes.dark.primary"]);
  });
});
