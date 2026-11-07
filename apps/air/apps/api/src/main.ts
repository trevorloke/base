import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, VERSION } from "./app.ts";
import { normalizeBasePath, trustedProxiesFromEnv, withBasePath } from "./base-path.ts";
import { boot } from "./boot.ts";
import { ssoConfigFromEnv, suiteInfo, suiteLinksFromEnv } from "./sso.ts";
import { inlineJson, registerWebApp } from "./web-app.ts";

const { m, handle, close, gateway, sources } = await boot();
const basePath = normalizeBasePath(process.env.BASE_PATH);
const sso = ssoConfigFromEnv();
const suite = suiteLinksFromEnv();
const app = createApp(m, {
  devWorkspace: process.env.BASE_AIR_DEV_WORKSPACE,
  gateway,
  sources,
  publicUrl: process.env.BASE_AIR_PUBLIC_URL,
  basePath,
  trustedProxies: trustedProxiesFromEnv(),
  sso,
  suite,
});

// Serve the built web app from the same process when it exists (single-container deploys).
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "web", "dist");
const suiteScript = `<script>window.__BASE_SUITE__=${inlineJson(suiteInfo(sso, suite))};</script>`;
if (registerWebApp(app, { dist, basePath, head: () => ({ head: suiteScript }) })) console.log(`[web] serving ${dist}`);

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: withBasePath(app.fetch, basePath), port }, () => {
  console.log(`[api] base air ${VERSION} on http://localhost:${port}${basePath}/ (db=${handle.kind}${process.env.BASE_AIR_DEV_WORKSPACE ? `, dev workspace=${process.env.BASE_AIR_DEV_WORKSPACE}` : ""})`);
});

const shutdown = async () => {
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
