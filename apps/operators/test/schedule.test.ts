import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGateway, defaultFakeHandlers } from "@starsign/ai";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, Starsign, SecretBox } from "@starsign/core";
import type { DbHandle } from "@starsign/db";
import { createTestDb } from "@starsign/db/test";
import { analystDue, isoWeekKey, localParts, serve, tick, type ServeState } from "../src/index.ts";

// Monday 2026-11-02 17:00Z: 10:00 in Phoenix (UTC-7, no DST), 02:00 Tuesday in Tokyo. Exact-hour assertions use
// zones without DST so they hold whatever tz database the runtime ships (tzdata 2026e moves Vancouver to permanent UTC-7).
const mondayNine = new Date("2026-11-02T17:00:00Z");

describe("calendar helpers", () => {
  it("reads local weekday and hour in the workspace timezone", () => {
    expect(localParts(mondayNine, "America/Phoenix")).toEqual({ year: 2026, month: 11, day: 2, hour: 10, weekday: 1 });
    expect(localParts(mondayNine, "Asia/Tokyo")).toEqual({ year: 2026, month: 11, day: 3, hour: 2, weekday: 2 });
    expect(localParts(new Date("2026-11-02T00:30:00Z"), "UTC").hour).toBe(0);
    const vancouver = localParts(mondayNine, "America/Vancouver");
    expect(vancouver).toMatchObject({ day: 2, weekday: 1 });
    expect(vancouver.hour).toBeGreaterThanOrEqual(9);
  });

  it("computes ISO weeks, including the year boundary", () => {
    expect(isoWeekKey(mondayNine, "UTC")).toBe("2026-W45");
    expect(isoWeekKey(new Date("2026-11-08T23:00:00Z"), "UTC")).toBe("2026-W45"); // Sunday
    expect(isoWeekKey(new Date("2026-11-09T00:00:00Z"), "UTC")).toBe("2026-W46"); // Monday
    expect(isoWeekKey(new Date("2027-01-03T12:00:00Z"), "UTC")).toBe("2026-W53"); // 2026 has 53 ISO weeks
    expect(isoWeekKey(new Date("2027-01-04T12:00:00Z"), "UTC")).toBe("2027-W01");
    expect(isoWeekKey(new Date("2026-11-09T05:00:00Z"), "America/Phoenix")).toBe("2026-W45"); // still Sunday evening locally
  });

  it("the brief is due Monday from 08:00 local, once per ISO week", () => {
    expect(analystDue(mondayNine, "America/Phoenix", null)).toBe(true);
    expect(analystDue(new Date("2026-11-02T14:59:00Z"), "America/Phoenix", null)).toBe(false); // 07:59 local
    expect(analystDue(new Date("2026-11-02T15:00:00Z"), "America/Phoenix", null)).toBe(true); // 08:00 local
    expect(analystDue(new Date("2026-11-03T17:00:00Z"), "America/Phoenix", null)).toBe(false); // Tuesday
    expect(analystDue(mondayNine, "America/Phoenix", new Date("2026-11-02T16:30:00Z"))).toBe(false); // already briefed this week
    expect(analystDue(mondayNine, "America/Phoenix", new Date("2026-10-26T16:30:00Z"))).toBe(true); // last week's brief
    expect(analystDue(mondayNine, "Asia/Tokyo", null)).toBe(false); // Tuesday 02:00 in Tokyo
    expect(analystDue(mondayNine, "America/Phoenix", null, { weekday: 2 })).toBe(false);
    expect(analystDue(mondayNine, "America/Phoenix", null, { hour: 11 })).toBe(false);
  });
});

describe("tick", () => {
  let h: DbHandle;
  let m: Starsign;
  let clock = mondayNine.getTime();
  const gw = new FakeGateway(defaultFakeHandlers());

  beforeAll(async () => {
    h = await createTestDb();
    m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now: () => new Date(clock) });
    await m.workspaces.create({ slug: "tick-co", name: "Tick Co", timezone: "America/Vancouver" }, { type: "human", id: "u" });
    await m.workspaces.create({ slug: "tokyo-co", name: "Tokyo Co", timezone: "Asia/Tokyo" }, { type: "human", id: "u" });
  });
  afterAll(() => h.close());

  it("runs Watch on first sight and the Analyst only where the weekly brief is due, then goes quiet", async () => {
    const state: ServeState = { lastWatchAt: new Map() };
    const first = await tick(m, gw, state, { watchEveryMs: 30 * 60_000 });
    expect(first.watched.sort()).toEqual(["tick-co", "tokyo-co"]);
    expect(first.briefed).toEqual(["tick-co"]); // Monday morning in Vancouver; already Tuesday in Tokyo
    expect(first.errors).toEqual([]);

    clock += 60_000; // one minute later: watch interval not elapsed, brief exists for this ISO week
    const second = await tick(m, gw, state, { watchEveryMs: 30 * 60_000 });
    expect(second).toEqual({ watched: [], briefed: [], capped: [], errors: [] });

    clock += 30 * 60_000;
    const third = await tick(m, gw, state, { watchEveryMs: 30 * 60_000 });
    expect(third.watched.sort()).toEqual(["tick-co", "tokyo-co"]);
    expect(third.briefed).toEqual([]);

    const tickCo = (await m.workspaces.bySlug("tick-co"))!;
    const runs = await m.ops.runs(tickCo.id);
    expect(runs.filter((r) => r.operator === "watch")).toHaveLength(2);
    expect(runs.filter((r) => r.operator === "analyst")).toHaveLength(1);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
    expect(await m.ops.briefs(tickCo.id)).toHaveLength(1);
  });

  it("serve() loops on a timer and stops cleanly", async () => {
    const lines: string[] = [];
    const handle = serve(m, gw, { tickMs: 20, watchEveryMs: 10, log: (l) => lines.push(l) });
    await new Promise((r) => setTimeout(r, 150));
    handle.stop();
    const before = handle.state.lastWatchAt.size;
    await new Promise((r) => setTimeout(r, 60));
    expect(before).toBe(2);
    expect(lines.some((l) => l.includes("watched=[tick-co,tokyo-co]"))).toBe(true);
  });
});
