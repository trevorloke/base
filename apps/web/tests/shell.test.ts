import { describe, expect, it } from "vitest";
import { nav } from "@/content/site";
import { defaultSettings } from "@/lib/settings";

describe("site shell", () => {
  it("navigates to the main sections, with Join on the home page anchor", () => {
    expect(nav.map((n) => n.href)).toEqual(["/tracker", "/volunteer", "/events", "/act", "/#join", "/news"]);
  });

  it("has settings defaults for every section the shell reads", () => {
    const s = defaultSettings();
    expect(s.seo.title).toBe("Imagine Surrey");
    expect(s.hero.words.length).toBeGreaterThan(1);
    expect(s.hero.primaryCta.href).toBe("/#join");
    expect(s.organize.ctaHref).toBe("/#join");
    expect(s.announcement.enabled).toBe(false);
    expect(s.footer.acknowledgement).toMatch(/Coast Salish/);
  });
});
