import { describe, expect, it } from "vitest";
import { BUILT_IN_MODULES, DEFAULT_MODULES, moduleLabel, normalizeModules, type HomeModule } from "@/lib/home-modules";
import { parseSection } from "@/lib/settings";

const text = (heading: string): HomeModule => ({ kind: "custom", enabled: true, heading, body: "", buttonLabel: "", buttonHref: "", tone: "white" });

describe("home page modules", () => {
  it("defaults to today's page: every built-in, in order, shown", () => {
    expect(DEFAULT_MODULES.map((m) => m.kind)).toEqual(BUILT_IN_MODULES.map((m) => m.kind));
    expect(DEFAULT_MODULES.every((m) => m.enabled)).toBe(true);
    expect(parseSection("homeModules", {}).modules).toEqual(DEFAULT_MODULES);
  });
  it("keeps the saved order and any number of text blocks", () => {
    const list = [text("A"), DEFAULT_MODULES[3], text("B"), ...DEFAULT_MODULES.filter((_, i) => i !== 3)];
    expect(normalizeModules(list).map((m) => (m.kind === "custom" ? m.heading : m.kind))).toEqual(["A", "news", "B", ...BUILT_IN_MODULES.filter((_, i) => i !== 3).map((m) => m.kind)]);
  });
  it("shows a built-in at most once and adds missing ones hidden at the end", () => {
    const out = normalizeModules([DEFAULT_MODULES[0], { ...DEFAULT_MODULES[0], enabled: false }]);
    expect(out.filter((m) => m.kind === "hero")).toHaveLength(1);
    expect(out[0].enabled).toBe(true);
    expect(out).toHaveLength(BUILT_IN_MODULES.length);
    expect(out.slice(1).every((m) => !m.enabled)).toBe(true);
  });
  it("rejects unknown module kinds and too-long text", () => {
    expect(() => parseSection("homeModules", { modules: [{ kind: "carousel" }] })).toThrow();
    expect(() => parseSection("homeModules", { modules: [{ ...text("x"), heading: "x".repeat(121) }] })).toThrow();
  });
  it("labels text blocks by their heading", () => {
    expect(moduleLabel(text("Town halls"))).toBe("Text block: Town halls");
    expect(moduleLabel(DEFAULT_MODULES[1])).toBe("Act now");
  });
});

describe("title bar", () => {
  it("defaults to no extra links and a Donate button, and allows at most three links", () => {
    expect(parseSection("header", {})).toEqual({ links: [], ctaLabel: "Donate", ctaHref: "/donate" });
    const four = Array.from({ length: 4 }, (_, i) => ({ label: `L${i}`, href: "/" }));
    expect(() => parseSection("header", { links: four })).toThrow();
  });
});
