import type { Context, Hono } from "hono";
import { z } from "zod";
import { CORNERS, contrastReport, FONTS, MODES, PRESETS, brandCss, themeAttr, type Brand } from "@base-air/look";
import { CoreError, type BaseAir } from "@base-air/core";
import type { Env } from "./app.ts";
import { readSessionCookie, type AuthRouteOptions } from "./auth-routes.ts";
import { suiteInfo, type SsoConfig, type SuiteLinks } from "./sso.ts";
import { inlineJson, type IndexHead } from "./web-app.ts";

/** The Brand page's API: the workspace's look, the presets and choices, and the contrast check. */
export function registerBrandRoutes(app: Hono<Env>, m: BaseAir): void {
  const choices = {
    presets: PRESETS,
    fonts: FONTS.map(({ id, label }) => ({ id, label })),
    corners: Object.entries(CORNERS).map(([id, c]) => ({ id, label: c.label })),
    modes: Object.entries(MODES).map(([id, label]) => ({ id, label })),
  };

  app.get("/v1/brand", async (c) => {
    const view = await m.look.view(c.get("principal").workspaceId);
    return c.json({ ...view, contrast: contrastReport(view.brand), choices });
  });

  app.put("/v1/brand", async (c) => {
    const p = c.get("principal");
    if (p.actor.type !== "human") throw new CoreError("forbidden", "only people change the brand");
    const body = z.object({ brand: z.record(z.string(), z.unknown()), confirmLowContrast: z.boolean().optional() }).parse(await c.req.json());
    const saved = await m.look.save(p, body.brand, { confirmLowContrast: body.confirmLowContrast === true });
    return c.json({ ...saved, contrast: contrastReport(saved.brand), choices });
  });
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface BrandHeadOptions extends AuthRouteOptions {
  devWorkspace?: string;
  sso: SsoConfig | null;
  suite: SuiteLinks;
}

/**
 * What index.html carries for this request: the brand of the workspace the person is signed in to (else the dev
 * workspace, else the deployment's first workspace, else the default look) as CSS custom properties, the mode as
 * data-theme, and what the browser needs to know about the suite. Written by the server, so there is no flash.
 */
export function brandHead(m: BaseAir, opts: BrandHeadOptions) {
  const suite = inlineJson(suiteInfo(opts.sso, opts.suite));
  return async (c: Context<Env>): Promise<IndexHead> => {
    let brand: Brand = m.look.defaults;
    try {
      const workspaceId = await workspaceFor(m, c, opts);
      if (workspaceId) brand = await m.look.effective(workspaceId);
    } catch (e) {
      console.error("[brand] falling back to the default look:", (e as Error).message);
    }
    const theme = themeAttr(brand.mode);
    return {
      head: [
        `<style id="base-air-brand">${brandCss(brand)}</style>`,
        `<script>window.__BASE_SUITE__=${suite};window.__BASE_AIR_BRAND__=${inlineJson(brand)};</script>`,
      ].join("\n    "),
      title: brand.name ? `${escText(brand.name)} · Base Air` : "Base Air",
      htmlAttrs: { "data-brand-mode": brand.mode, ...(theme ? { "data-theme": theme } : {}) },
    };
  };
}

async function workspaceFor(m: BaseAir, c: Context<Env>, opts: BrandHeadOptions): Promise<string | null> {
  const token = readSessionCookie(c, opts);
  if (token) {
    const s = await m.auth.resolveSession(token);
    if (s?.currentWorkspaceId) return s.currentWorkspaceId;
  }
  if (opts.devWorkspace) {
    const ws = await m.workspaces.bySlug(opts.devWorkspace);
    if (ws) return ws.id;
  }
  return m.look.homeWorkspaceId();
}
