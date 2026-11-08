import { describe, expect, it } from "vitest";
import { applyHostDefaults } from "../src/boot.ts";

describe("host defaults", () => {
  it("uses Render's external URL when BASE_AIR_PUBLIC_URL is not set, and never overrides an explicit one", () => {
    const render: NodeJS.ProcessEnv = { RENDER_EXTERNAL_URL: "https://base-air.onrender.com" };
    expect(applyHostDefaults(render)).toBe("https://base-air.onrender.com");
    expect(render.BASE_AIR_PUBLIC_URL).toBe("https://base-air.onrender.com");
    const own: NodeJS.ProcessEnv = { BASE_AIR_PUBLIC_URL: "https://app.example.com", RENDER_EXTERNAL_URL: "https://x.onrender.com" };
    expect(applyHostDefaults(own)).toBe("https://app.example.com");
    expect(applyHostDefaults({})).toBeUndefined();
    // Under a prefix, Render's own URL serves the app under it too.
    const prefixed: NodeJS.ProcessEnv = { RENDER_EXTERNAL_URL: "https://base-air.onrender.com/", BASE_PATH: "/air/" };
    expect(applyHostDefaults(prefixed)).toBe("https://base-air.onrender.com/air");
    // A private service behind the front door has no external URL: BASE_AIR_PUBLIC_URL is the only source.
    const behindFrontDoor: NodeJS.ProcessEnv = { BASE_PATH: "/air", BASE_AIR_PUBLIC_URL: "https://imaginesurrey.base.win/air" };
    expect(applyHostDefaults(behindFrontDoor)).toBe("https://imaginesurrey.base.win/air");
  });
});
