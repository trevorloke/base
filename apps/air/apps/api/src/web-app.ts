import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Context, Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Env } from "./app.ts";
import { normalizeBasePath } from "./base-path.ts";

/** What the server writes into index.html for one request (the brand, so the first paint is already right). */
export interface IndexHead {
  /** Extra markup for <head>: a <style> with the brand's custom properties, a <title>. */
  head?: string;
  /** Already-escaped text for <title>. */
  title?: string;
  /** Attributes for <html>, e.g. data-theme. */
  htmlAttrs?: Record<string, string>;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** JSON for an inline <script>: no way to close the tag from inside a string. */
export const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/**
 * index.html as this deployment serves it: `<base href="${BASE_PATH}/">` and `window.__BASE_PATH__` first in <head>
 * (SUITE.md: the browser learns its prefix from the HTML), then whatever the request's brand adds.
 */
export function renderIndexHtml(template: string, basePath: string, extra: IndexHead = {}): string {
  const base = normalizeBasePath(basePath);
  // <base> first, before anything with a URL; the brand last in <head>, after the stylesheet it overrides.
  const inject = `<base href="${escAttr(base)}/" />\n    <script>window.__BASE_PATH__=${inlineJson(base)};</script>`;
  let html = template.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${inject}`);
  if (extra.head) html = html.replace(/<\/head>/i, () => `  ${extra.head}\n  </head>`);
  if (extra.title !== undefined) html = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${extra.title}</title>`);
  const attrs = Object.entries(extra.htmlAttrs ?? {});
  if (attrs.length) {
    html = html.replace(/<html(\s[^>]*)?>/i, (_m, existing: string | undefined) => {
      let a = existing ?? "";
      for (const [k, v] of attrs) {
        a = a.replace(new RegExp(`\\s${k}="[^"]*"`, "i"), "");
        a += ` ${k}="${escAttr(v)}"`;
      }
      return `<html${a}>`;
    });
  }
  return html;
}

export interface WebAppOptions {
  /** The built web app (apps/web/dist). */
  dist: string;
  basePath: string;
  /** Per-request additions to index.html (the brand). */
  head?: (c: Context<Env>) => Promise<IndexHead> | IndexHead;
}

/**
 * Serve the built web app from this process: index.html rendered per request (never cached: it carries the brand),
 * hashed assets as files, and index.html again for any other GET that is not the API (the room's deep links).
 */
export function registerWebApp(app: Hono<Env>, opts: WebAppOptions): boolean {
  const indexPath = join(opts.dist, "index.html");
  if (!existsSync(indexPath)) return false;
  const template = readFileSync(indexPath, "utf8");
  const html = async (c: Context<Env>) => {
    const extra = opts.head ? await opts.head(c) : {};
    return c.html(renderIndexHtml(template, opts.basePath, extra), 200, { "cache-control": "no-store" });
  };
  app.get("/", html);
  app.get("/index.html", html);
  const root = relative(process.cwd(), opts.dist) || ".";
  app.use("/*", serveStatic({ root }));
  app.get("*", (c) => {
    const p = c.req.path;
    if (p.startsWith("/v1/") || p.startsWith("/api/") || p.startsWith("/assets/")) return c.json({ error: { code: "not_found", message: "not found" } }, 404);
    return html(c);
  });
  return true;
}
