import { describe, expect, it } from "vitest";
import { CreatePostInput, DEFAULT_POLICY, LISTEN_ONLY_NETWORKS, NETWORK_LIMITS, Network, Policy, RedLine } from "../src/index.ts";

describe("schema", () => {
  it("default policy is conservative and valid", () => {
    expect(Policy.parse(DEFAULT_POLICY).autonomy.new_post).toBe("schedule_with_approval");
    expect(DEFAULT_POLICY.autonomy.dm).toBe("suggest");
  });

  it("every publishable network has limits; listening-only networks take no posts", () => {
    for (const n of Network.options) {
      if (LISTEN_ONLY_NETWORKS.has(n)) expect(NETWORK_LIMITS[n].maxText).toBe(0);
      else expect(NETWORK_LIMITS[n].maxText).toBeGreaterThan(0);
    }
    expect([...LISTEN_ONLY_NETWORKS]).toEqual(["news"]);
  });

  it("parses a red line and rejects unknown kinds", () => {
    const rl = RedLine.parse({
      id: "r1",
      kind: "forbidden_phrase",
      description: "no guarantees",
      severity: "block",
      phrases: ["guaranteed"],
    });
    expect(rl.kind).toBe("forbidden_phrase");
    expect(() => RedLine.parse({ id: "x", kind: "nope" })).toThrow();
  });

  it("post input defaults", () => {
    const p = CreatePostInput.parse({ body: "hi", variants: [{ socialAccountId: "a", text: "hi" }] });
    expect(p.actionClass).toBe("new_post");
    expect(p.variants[0]?.media).toEqual([]);
  });
});
