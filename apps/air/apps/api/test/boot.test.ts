import { describe, expect, it } from "vitest";
import { applyHostDefaults } from "../src/boot.ts";

describe("host defaults", () => {
  it("uses Render's external URL when STARSIGN_PUBLIC_URL is not set, and never overrides an explicit one", () => {
    const render: NodeJS.ProcessEnv = { RENDER_EXTERNAL_URL: "https://starsign-staging.onrender.com" };
    expect(applyHostDefaults(render)).toBe("https://starsign-staging.onrender.com");
    expect(render.STARSIGN_PUBLIC_URL).toBe("https://starsign-staging.onrender.com");
    const own: NodeJS.ProcessEnv = { STARSIGN_PUBLIC_URL: "https://app.example.com", RENDER_EXTERNAL_URL: "https://x.onrender.com" };
    expect(applyHostDefaults(own)).toBe("https://app.example.com");
    expect(applyHostDefaults({})).toBeUndefined();
  });
});
