import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, SecretBox, BaseAir, compareArms, type Principal } from "../src/index.ts";

let h: DbHandle;
let m: BaseAir;
let owner: Principal;
let acct: string;
const now = () => new Date("2026-11-02T18:00:00Z");

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
  acct = (await m.accounts.connect(owner, { network: "bluesky", externalId: "did:1", handle: "acme", connector: "mock" })).id;
});
afterAll(() => h.close());

/** Create a post in an arm with a captured 24h outcome of `engagements`. */
async function armPost(expId: string, arm: string, engagements: number) {
  const r = await m.posts.create(owner, { body: arm, variants: [{ socialAccountId: acct, text: `${arm} ${engagements}` }], experimentId: expId, experimentArm: arm });
  const { postOutcomes } = await import("@base-air/db");
  await m.ctx.db.insert(postOutcomes).values({ id: `out_${r.post.id}`, workspaceId: owner.workspaceId, postId: r.post.id, variantId: r.variants[0]!.id, offsetLabel: "24h", dueAt: now(), capturedAt: now(), metrics: { engagements }, status: "captured" });
}

describe("compareArms", () => {
  it("is deterministic and brackets the true ratio", () => {
    const a = [30, 34, 29, 35, 31, 33];
    const b = [15, 17, 14, 16, 15, 18];
    const r1 = compareArms(a, b);
    expect(compareArms(a, b)).toEqual(r1);
    expect(r1.lift).toBeCloseTo(2.0, 1);
    expect(r1.lo).toBeGreaterThan(1.5);
    expect(r1.hi).toBeLessThan(2.5);
    expect(r1.probabilityBetter).toBe(1);
  });
});

describe("experiments", () => {
  it("refuses thin data, then names a winner only when the interval clears 1, and freezes on conclude", async () => {
    const exp = await m.experiments.create(owner, { name: "Hook test", hypothesis: "Naming the trail beats a generic hook", arms: [{ key: "named", description: "name the trail" }, { key: "generic", description: "generic hook" }] });
    await armPost(exp.id, "named", 40);
    await armPost(exp.id, "generic", 20);
    let r = await m.experiments.readout(owner.workspaceId, exp.id);
    expect(r.verdict).toBe("not_enough_data");
    expect(r.summary).toMatch(/named needs 2 more, generic needs 2 more/);

    for (const v of [42, 38, 44]) await armPost(exp.id, "named", v);
    for (const v of [21, 19, 22]) await armPost(exp.id, "generic", v);
    r = await m.experiments.readout(owner.workspaceId, exp.id);
    expect(r.verdict).toBe("winner");
    expect(r.winner).toBe("named");
    expect(r.arms.find((a) => a.key === "named")).toMatchObject({ posts: 4, measured: 4, mean: 41 });
    expect(r.comparisons[0]!.lo).toBeGreaterThan(1);
    expect(r.summary).toMatch(/"named" wins on engagements at 24h/);

    const done = await m.experiments.conclude(owner, exp.id);
    expect(done.status).toBe("concluded");
    expect((done.result as { winner: string }).winner).toBe("named");
    await expect(m.posts.create(owner, { body: "x", variants: [{ socialAccountId: acct, text: "late" }], experimentId: exp.id, experimentArm: "named" })).rejects.toMatchObject({ code: "conflict" });
    const ev = await m.events.list({ workspaceId: owner.workspaceId, types: ["experiment.concluded"] });
    expect(ev[0]?.data).toMatchObject({ verdict: "winner", winner: "named" });
  });

  it("reports no clear winner on overlapping arms and validates arms", async () => {
    const exp = await m.experiments.create(owner, { name: "Time", hypothesis: "Morning beats evening", arms: [{ key: "am", description: "" }, { key: "pm", description: "" }] });
    for (const v of [20, 35, 10, 30]) await armPost(exp.id, "am", v);
    for (const v of [25, 15, 30, 22]) await armPost(exp.id, "pm", v);
    const r = await m.experiments.readout(owner.workspaceId, exp.id);
    expect(r.verdict).toBe("no_clear_winner");
    expect(r.summary).toMatch(/Keep running/);
    await expect(m.posts.create(owner, { body: "x", variants: [{ socialAccountId: acct, text: "x" }], experimentId: exp.id, experimentArm: "noon" })).rejects.toMatchObject({ code: "invalid" });
    await expect(m.experiments.create(owner, { name: "dup", hypothesis: "h", arms: [{ key: "a", description: "" }, { key: "a", description: "" }] })).rejects.toMatchObject({ code: "invalid" });
    await expect(m.experiments.conclude({ ...owner, actor: { type: "mcp", id: "claude" }, role: undefined }, exp.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});
