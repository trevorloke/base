import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox } from "@base-air/core";
import { brandFromSettings } from "@base-air/look";
import { createApp } from "../src/app.ts";
import { withBasePath } from "../src/base-path.ts";
import { brandHead } from "../src/routes-brand.ts";
import { registerWebApp } from "../src/web-app.ts";

const ORIGIN = "https://imaginesurrey.base.win";
const BASE = "/air";
let h: DbHandle;
let m: BaseAir;
let fetchApp: (r: Request) => Promise<Response>;
let owner = "";
let viewer = "";
let wsId = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  h = await createTestDb();
  // Pre-configured by settings: what the client sees before anyone saves a brand.
  const defaults = brandFromSettings({ BASE_AIR_BRAND_PRESET: "lagoon" }).brand;
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), defaultBrand: defaults });
  const signed = await m.auth.signup({ email: "ann@imaginesurrey.ca", password: "correct horse 1", name: "Ann", workspaceName: "Imagine Surrey" }, {});
  wsId = signed.view.currentWorkspaceId!;
  owner = signed.token;
  const viewerKey = await m.workspaces.createApiKey({ workspaceId: wsId, name: "v", actorType: "human", actorId: "u2", role: "viewer" });
  viewer = viewerKey.secret;
  const dist = mkdtempSync(join(tmpdir(), "air-brand-dist-"));
  writeFileSync(join(dist, "index.html"), '<!doctype html><html lang="en"><head><title>Base Air</title><link rel="stylesheet" href="./assets/app.css"></head><body><div id="root"></div></body></html>');
  const opts = { basePath: BASE, publicUrl: `${ORIGIN}${BASE}` };
  const app = createApp(m, opts);
  registerWebApp(app, { dist, basePath: BASE, head: brandHead(m, { ...opts, sso: null, suite: {} }) });
  fetchApp = async (r) => withBasePath(app.fetch, BASE)(r) as Promise<Response>;
});
afterAll(async () => h.close());

const call = (method: string, path: string, o: { body?: unknown; cookie?: string | null; key?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.cookie !== null) headers.cookie = `base_air_session=${o.cookie ?? owner}`;
  if (o.key) {
    headers.authorization = `Bearer ${o.key}`;
    delete headers.cookie;
  }
  if (method !== "GET") headers["x-base-air-csrf"] = "1";
  return fetchApp(new Request(`${ORIGIN}${BASE}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
};

describe("the Brand page's API", () => {
  it("starts from the pre-configured preset, named after the workspace", async () => {
    const r = await json(await call("GET", "/v1/brand"));
    expect(r.saved).toBe(false);
    expect(r.brand.preset).toBe("lagoon");
    expect(r.brand.name).toBe("Imagine Surrey");
    expect(r.choices.presets.map((p: { id: string }) => p.id)).toEqual(["air", "daylight", "ember", "lagoon", "newsprint"]);
    expect(r.contrast.every((p: { ok: boolean }) => p.ok)).toBe(true);
  });

  it("refuses a low-contrast brand until the owner confirms, naming each pair and its ratio", async () => {
    const brand = { preset: "air", mode: "dark", palettes: { dark: { primary: "#1e293b" } } }; // dark blue on deep navy
    const refused = await call("PUT", "/v1/brand", { body: { brand } });
    expect(refused.status).toBe(409);
    const err = (await json(refused)).error;
    const pairs = err.details.lowContrast.map((p: { id: string; ratio: number }) => p.id);
    expect(pairs).toContain("dark:link");
    expect(err.details.lowContrast[0].ratio).toBeLessThan(4.5);
    expect((await json(await call("GET", "/v1/brand"))).saved).toBe(false);

    const ok = await call("PUT", "/v1/brand", { body: { brand, confirmLowContrast: true } });
    expect(ok.status).toBe(200);
    const saved = await json(ok);
    expect(saved.saved).toBe(true);
    expect(saved.brand.palettes.dark.primary).toBe("#1e293b");
    expect(saved.lowContrast.length).toBeGreaterThan(0);
  });

  it("saves a good brand, and records each save in the ledger", async () => {
    const r = await call("PUT", "/v1/brand", { body: { brand: { preset: "ember", name: "Imagine Surrey Air", palettes: { dark: { primary: "#ff8a4c" } }, font: "space-grotesk", corners: "sharp", mode: "dark" } } });
    expect(r.status).toBe(200);
    const events = await m.events.list({ workspaceId: wsId, types: ["brand.updated"], afterSeq: 0 });
    expect(events).toHaveLength(2);
    const last = events.at(-1)!;
    expect(last.actor.type).toBe("human");
    expect((last.data as { changed: string[] }).changed).toEqual(expect.arrayContaining(["preset", "name", "palettes.dark.primary", "font", "corners"]));
  });

  it("is for owners: viewers and agents are refused; bad values are explained", async () => {
    expect((await call("PUT", "/v1/brand", { key: viewer, body: { brand: { mode: "light" } } })).status).toBe(403);
    const bad = await call("PUT", "/v1/brand", { body: { brand: { palettes: { light: { ink: "black;}body{" } }, font: "papyrus" } } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.details.problems.map((p: { field: string }) => p.field)).toEqual(["palettes.light.ink", "font"]);
  });

  it("writes the brand into the HTML so the first paint is already right", async () => {
    const r = await fetchApp(new Request(`${ORIGIN}${BASE}/`, { headers: { cookie: `base_air_session=${owner}` } }));
    const html = await r.text();
    expect(html).toContain('<html lang="en" data-brand-mode="dark" data-theme="dark">');
    expect(html).toMatch(/<link rel="stylesheet"[^>]*>\s*<style id="base-air-brand">/); // after the stylesheet it overrides
    expect(html).toContain("--primary:#ff8a4c");
    expect(html).toContain("<title>Imagine Surrey Air · Base Air</title>");
    expect(html).toContain('window.__BASE_AIR_BRAND__={"preset":"ember"');
    // Signed out: the deployment's (first workspace's) brand, so the sign-in screen matches.
    const anon = await (await fetchApp(new Request(`${ORIGIN}${BASE}/`))).text();
    expect(anon).toContain("--primary:#ff8a4c");
  });

  it("never lets a name break out of the title", async () => {
    await call("PUT", "/v1/brand", { body: { brand: { name: "</title><script>alert(1)</script>" } } });
    const html = await (await fetchApp(new Request(`${ORIGIN}${BASE}/`, { headers: { cookie: `base_air_session=${owner}` } }))).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;");
  });
});
