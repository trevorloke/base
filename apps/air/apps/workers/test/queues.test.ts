import { describe, expect, it } from "vitest";
import { LEGACY_QUEUES, MAINTENANCE_QUEUE, PUBLISH_QUEUE, retireLegacyQueues } from "../src/queues.ts";

describe("queue names after the rename", () => {
  it("uses Base Air's names and empties the pre-rename queues", async () => {
    expect([PUBLISH_QUEUE, MAINTENANCE_QUEUE]).toEqual(["base-air-publish", "base-air-maintenance"]);
    const seen: string[] = [];
    const closed: string[] = [];
    const retired = await retireLegacyQueues((name) => ({
      obliterate: async () => {
        if (name === "starsign-maintenance") throw new Error("redis says no");
        seen.push(name);
      },
      close: async () => void closed.push(name),
    }), () => {});
    expect(LEGACY_QUEUES).toEqual(["starsign-publish", "starsign-maintenance"]);
    expect(retired).toEqual(["starsign-publish"]); // a failure is logged, not thrown
    expect(closed).toEqual(["starsign-publish", "starsign-maintenance"]);
  });
});
