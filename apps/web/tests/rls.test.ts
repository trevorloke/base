import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB } from "@/lib/old-names";

// Every table the website creates must have row-level security turned on, or
// on Supabase it would be readable through the project's public API key.
describe("row-level security", () => {
  it("is enabled for every table in the schema", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const schema = readFileSync(path.join(root, "src/lib/db/schema.ts"), "utf8");
    // A table named from src/lib/old-names.ts (pgTable(DB.outbox, …)) counts by its database name.
    const tables = [...schema.matchAll(/pgTable\(\s*(?:"([a-z_]+)"|DB\.(\w+))/g)].map((m) => m[1] ?? (DB as Record<string, unknown>)[m[2]]);
    const migrations = readdirSync(path.join(root, "drizzle"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(path.join(root, "drizzle", f), "utf8"))
      .join("\n");
    const locked = new Set([...migrations.matchAll(/ALTER TABLE "([a-z_]+)" ENABLE ROW LEVEL SECURITY/g)].map((m) => m[1]));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables).toContain(DB.outbox);
    expect(tables.filter((t) => !locked.has(t))).toEqual([]);
  });
});
