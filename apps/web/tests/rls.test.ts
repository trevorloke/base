import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every table the website creates must have row-level security turned on, or
// on Supabase it would be readable through the project's public API key.
describe("row-level security", () => {
  it("is enabled for every table in the schema", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const schema = readFileSync(path.join(root, "src/lib/db/schema.ts"), "utf8");
    const tables = [...schema.matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const migrations = readdirSync(path.join(root, "drizzle"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(path.join(root, "drizzle", f), "utf8"))
      .join("\n");
    const locked = new Set([...migrations.matchAll(/ALTER TABLE "([a-z_]+)" ENABLE ROW LEVEL SECURITY/g)].map((m) => m[1]));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((t) => !locked.has(t))).toEqual([]);
  });
});
