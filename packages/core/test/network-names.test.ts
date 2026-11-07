import { describe, expect, it } from "vitest";
import { LISTEN_ONLY_NETWORKS, Network, NETWORK_LABEL, NETWORK_LIMITS, networkLabel } from "@starsign/schema";
import { networkName } from "../src/services/analytics-shared.ts";

// The web app is built by Vite with its own module settings, so it is loaded at run time rather than type-checked here.
const WEB_FORMAT = new URL("../../../apps/web/src/lib/format.ts", import.meta.url).href;
const { NETWORK_LABEL: WEB_LABEL, NETWORK_MAX_TEXT, NETWORK_MAX_MEDIA, NETWORK_NEEDS_MEDIA } = (await import(WEB_FORMAT)) as {
  NETWORK_LABEL: Record<string, string>;
  NETWORK_MAX_TEXT: Record<string, number>;
  NETWORK_MAX_MEDIA: Record<string, number>;
  NETWORK_NEEDS_MEDIA: ReadonlySet<string>;
};

// Client reports, the web app and briefs each name networks. They are separate lists for good reasons (the report
// renderer and the web app are import-free), so this pins them together: a network added to the schema must be named
// everywhere, or a client report says "Vk" and "Wecom".
describe("network names", () => {
  it("names every network the same way in the schema, client reports and the web app", () => {
    for (const n of Network.options) {
      expect(NETWORK_LABEL[n], n).toBeTruthy();
      expect(networkName(n), n).toBe(NETWORK_LABEL[n]);
      expect(WEB_LABEL[n], n).toBe(NETWORK_LABEL[n]);
    }
    expect(Object.keys(WEB_LABEL).sort()).toEqual([...Network.options].sort());
  });

  it("humanises an unknown id instead of showing it raw", () => {
    expect(networkLabel("some_new_thing")).toBe("Some new thing");
    expect(networkName("some_new_thing")).toBe("Some new thing");
  });

  it("gives the web composer the server's text and media limits and media requirement for every network you can post to", () => {
    for (const n of Network.options) {
      if (LISTEN_ONLY_NETWORKS.has(n)) continue;
      expect(NETWORK_MAX_TEXT[n], n).toBe(NETWORK_LIMITS[n].maxText);
      expect(NETWORK_MAX_MEDIA[n], n).toBe(NETWORK_LIMITS[n].maxMedia);
      expect(NETWORK_NEEDS_MEDIA.has(n), n).toBe(NETWORK_LIMITS[n].requiresMedia);
    }
  });
});
