import { createDb } from "./client.ts";
import { migrate } from "./migrate.ts";

const cmd = process.argv[2];
if (cmd !== "migrate") {
  console.error("usage: tsx src/cli.ts migrate");
  process.exit(1);
}
const handle = await createDb({ pglitePath: process.env.DATABASE_URL ? undefined : process.env.PGLITE_PATH ?? ".pglite" });
const done = await migrate(handle);
console.log(done.length ? `applied: ${done.join(", ")}` : "up to date");
await handle.close();
