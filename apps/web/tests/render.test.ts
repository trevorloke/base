// Running on Render: who may call the daily jobs, when the database is
// migrated before the server starts, the health check, and the files the
// Docker image and the cron jobs depend on.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { cronAllowed } = await import("@/lib/server/cron");
const { shouldMigrate } = await import("../scripts/predeploy");
const { GET: health } = await import("@/app/api/health/route");

const root = path.resolve(import.meta.dirname, "..");

describe("the daily jobs' check", () => {
  it("accepts exactly Authorization: Bearer <CRON_SECRET>", () => {
    expect(cronAllowed("Bearer s3cret", "s3cret", true)).toBe(true);
    expect(cronAllowed("Bearer s3cret", "s3cret", false)).toBe(true);
  });
  it("refuses a wrong, missing or differently written secret", () => {
    expect(cronAllowed("Bearer wrong!", "s3cret", true)).toBe(false);
    expect(cronAllowed(null, "s3cret", true)).toBe(false);
    expect(cronAllowed("s3cret", "s3cret", true)).toBe(false);
    expect(cronAllowed("bearer s3cret", "s3cret", true)).toBe(false);
    expect(cronAllowed("Bearer s3cret ", "s3cret", true)).toBe(false);
  });
  it("without CRON_SECRET, refuses everyone on a hosted copy and lets a local copy through", () => {
    expect(cronAllowed("Bearer anything", undefined, true)).toBe(false);
    expect(cronAllowed(null, undefined, false)).toBe(true);
  });
});

describe("migrations and the seed before the server starts", () => {
  it("run on a Render deploy", () => {
    expect(shouldMigrate({ RENDER: "true" }).run).toBe(true);
  });
  it("skip Render pull-request previews and anywhere else unless asked", () => {
    expect(shouldMigrate({ RENDER: "true", IS_PULL_REQUEST: "true" }).run).toBe(false);
    expect(shouldMigrate({}).run).toBe(false);
    expect(shouldMigrate({ BASE_WEB_MIGRATE: "1" }).run).toBe(true);
  });
  it("respect SKIP_DB_MIGRATE=1 everywhere", () => {
    expect(shouldMigrate({ RENDER: "true", SKIP_DB_MIGRATE: "1" })).toEqual({ run: false, why: "SKIP_DB_MIGRATE=1" });
    expect(shouldMigrate({ BASE_WEB_MIGRATE: "1", SKIP_DB_MIGRATE: "1" }).run).toBe(false);
  });
});

describe("/api/health", () => {
  it("answers { ok, service: 'base-web', commit }, never cached", async () => {
    vi.stubEnv("RENDER_GIT_COMMIT", "0123abc");
    const res = health();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, service: "base-web", commit: "0123abc" });
    vi.unstubAllEnvs();
  });
  it("falls back to the commit baked into the image, then null", async () => {
    vi.stubEnv("RENDER_GIT_COMMIT", "");
    vi.stubEnv("BASE_WEB_COMMIT", "feed42");
    expect((await health().json()).commit).toBe("feed42");
    vi.stubEnv("BASE_WEB_COMMIT", "");
    expect((await health().json()).commit).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("the image", () => {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  it("is Node 22, standalone, with current time-zone rules, migrations and the migrate step", () => {
    expect(dockerfile).toMatch(/^FROM node:22/m);
    expect(readFileSync(path.join(root, "next.config.ts"), "utf8")).toMatch(/output: "standalone"/);
    expect(dockerfile).toMatch(/ICU_TIMEZONE_FILES_DIR=\/app\/tzdata/);
    for (const copied of ["/app/tzdata", "/app/drizzle", "/app/.next/static", "/app/public", "/app/dist/predeploy.mjs"]) expect(dockerfile).toContain(copied);
    expect(dockerfile).toMatch(/node predeploy\.mjs && exec node server\.js/);
  });
  it("declares no secret as a build argument", () => {
    const args = [...dockerfile.matchAll(/^ARG (\w+)/gm)].map((m) => m[1]);
    expect(args.every((a) => a.startsWith("NEXT_PUBLIC_") || a.startsWith("BASE_WEB_") || a === "RENDER_GIT_COMMIT")).toBe(true);
    expect(args).toEqual(expect.arrayContaining(["BASE_WEB_CLIENT", "BASE_WEB_JURISDICTION"]));
  });
  it("leaves Vercel behind: no vercel.json, no vercel-build script", () => {
    expect(existsSync(path.join(root, "vercel.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts["vercel-build"]).toBeUndefined();
  });
});
