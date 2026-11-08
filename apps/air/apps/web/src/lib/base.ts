/**
 * Where the room lives on its host. The server writes `window.__BASE_PATH__` (and `<base href>`) into index.html, e.g.
 * "/air" on imaginesurrey.base.win; "" at the root (local development). Every absolute path the browser builds (API
 * calls, the live stream, links, sign-in hand-offs) goes through `appPath`, so nothing escapes the prefix.
 */

declare global {
  interface Window {
    __BASE_PATH__?: string;
  }
}

/** "" or "/a/b": one leading slash, no trailing slash. */
export function normalizeBasePath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const parts = raw.split("/").filter((p) => p && p !== "." && p !== "..");
  return parts.length ? `/${parts.join("/")}` : "";
}

export const BASE_PATH: string = normalizeBasePath(typeof window !== "undefined" ? window.__BASE_PATH__ : "");

/** `/v1/me` → `/air/v1/me`. Paths are always given from the app's root. */
export function joinBase(base: string, path: string): string {
  return `${normalizeBasePath(base)}${path.startsWith("/") ? path : `/${path}`}`;
}

/** An absolute path inside this app, under its prefix. */
export function appPath(path: string): string {
  return joinBase(BASE_PATH, path);
}

/** The same, with this page's origin: for snippets and links meant to be pasted elsewhere. */
export function appUrl(path: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${appPath(path)}`;
}

/** The current path within the app (without the prefix), for `next=` after signing in. */
export function currentAppPath(): string {
  if (typeof window === "undefined") return "/";
  const { pathname, search, hash } = window.location;
  const inside = BASE_PATH && pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || "/" : pathname;
  return `${inside}${search}${hash}`;
}
