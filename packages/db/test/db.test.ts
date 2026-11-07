import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "../src/test-utils.ts";
import { ledgerEvents, rawEvents, workspaces } from "../src/schema.ts";

describe("db", () => {
  it("migrates, inserts, and enforces append-only logs", async () => {
    const h = await createTestDb();
    await h.db.insert(workspaces).values({ id: "w1", slug: "acme", name: "Acme" });
    await h.db.insert(rawEvents).values({ id: "r1", source: "test", kind: "ping", workspaceId: "w1", externalId: null, payload: { a: 1 }, hash: "x" });
    await h.db.insert(ledgerEvents).values({ id: "l1", workspaceId: "w1", type: "workspace.created", subjectType: "workspace", subjectId: "w1", actor: { type: "system", id: "test" }, data: {} });

    const appendOnly = (e: unknown) => /append-only/.test(String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));
    await expect(h.db.execute(sql`UPDATE raw_events SET kind = 'pong' WHERE id = 'r1'`).catch((e) => Promise.reject(appendOnly(e)))).rejects.toBe(true);
    await expect(h.db.execute(sql`DELETE FROM ledger_events WHERE id = 'l1'`).catch((e) => Promise.reject(appendOnly(e)))).rejects.toBe(true);

    const rows = await h.db.select().from(rawEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(1);

    // migrate is idempotent
    const { migrate } = await import("../src/migrate.ts");
    expect(await migrate(h)).toEqual([]);
    await h.close();
  });

  it("has pgvector available", async () => {
    const h = await createTestDb();
    const { rowsOf } = await import("../src/client.ts");
    const r = rowsOf<{ d: number }>(await h.db.execute(sql`SELECT '[1,2,3]'::vector(3) <-> '[1,2,4]'::vector(3) AS d`));
    expect(Number(r[0]?.d)).toBeCloseTo(1);
    await h.close();
  });
});
