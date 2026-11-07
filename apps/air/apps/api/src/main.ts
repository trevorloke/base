import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, VERSION } from "./app.ts";
import { boot } from "./boot.ts";

const { m, handle, close, gateway, sources } = await boot();
const app = createApp(m, { devWorkspace: process.env.BASE_AIR_DEV_WORKSPACE, gateway, sources, publicUrl: process.env.BASE_AIR_PUBLIC_URL });

// Serve the built web app from the same process when it exists (single-container deploys).
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "web", "dist");
if (existsSync(dist)) {
  const root = relative(process.cwd(), dist) || ".";
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: join(root, "index.html") }));
  console.log(`[web] serving ${root}`);
}

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`[api] base air ${VERSION} on http://localhost:${port} (db=${handle.kind}${process.env.BASE_AIR_DEV_WORKSPACE ? `, dev workspace=${process.env.BASE_AIR_DEV_WORKSPACE}` : ""})`);
});

const shutdown = async () => {
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
