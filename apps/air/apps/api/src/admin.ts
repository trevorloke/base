/**
 * Owner recovery from a shell on the server (Render: the service's Shell tab), for deployments without mail.
 *
 *   node --import tsx src/admin.ts users                 # who is on this deployment and who can sign in
 *   node --import tsx src/admin.ts reset-link <email>    # a one-time link (1 hour) to set a new password
 *
 * Locally: pnpm --filter @base-air/api admin users
 */
import { createDb, migrate } from "@base-air/db";
import { ConnectorRegistry } from "@base-air/connectors";
import { InMemoryScheduler, SecretBox, BaseAir } from "@base-air/core";

const [command, arg] = process.argv.slice(2);
const usage = "usage: admin users | admin reset-link <email>";
if (!command || (command === "reset-link" && !arg) || !["users", "reset-link"].includes(command)) {
  console.error(usage);
  process.exit(2);
}

const handle = await createDb({ url: process.env.DATABASE_URL, pglitePath: process.env.DATABASE_URL ? undefined : process.env.PGLITE_PATH ?? ".pglite" });
let code = 0;
try {
  await migrate(handle);
  const m = new BaseAir({ handle, connectors: new ConnectorRegistry(), scheduler: new InMemoryScheduler(), secrets: SecretBox.fromEnv() });
  if (command === "users") {
    const rows = await m.auth.listUsers();
    if (rows.length === 0) console.log("No users yet. The first person to open the app creates the owner account.");
    for (const u of rows) console.log(`${u.email}\t${u.canSignIn ? "can sign in" : "no password (cannot sign in)"}\t${u.name ?? ""}`);
  } else {
    const base = process.env.BASE_AIR_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL;
    if (!base) console.warn("BASE_AIR_PUBLIC_URL is not set; put this deployment's address in front of the link below.");
    const link = await m.auth.adminResetLink(arg!, base);
    console.log(`Open this within an hour to set a new password for ${arg} (it works once):\n${link}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  code = 1;
} finally {
  await handle.close();
}
process.exit(code);
