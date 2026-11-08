import { useEffect, useState } from "react";
import { appPath, currentAppPath } from "./base";

/**
 * What this deployment knows about the rest of the Base suite (SUITE.md): whether "Sign in with Base" is set up, and
 * where Base Ground and Base Web live. The server writes it into index.html as window.__BASE_SUITE__; the Vite dev
 * server does not, so the hook asks GET /api/suite then.
 */
export interface SuiteInfo {
  signInWithBase: boolean;
  groundUrl: string | null;
  webUrl: string | null;
}

declare global {
  interface Window {
    __BASE_SUITE__?: SuiteInfo;
  }
}

const NONE: SuiteInfo = { signInWithBase: false, groundUrl: null, webUrl: null };
let cached: SuiteInfo | null = typeof window !== "undefined" && window.__BASE_SUITE__ ? window.__BASE_SUITE__ : null;
let pending: Promise<SuiteInfo> | null = null;

function load(): Promise<SuiteInfo> {
  pending ??= fetch(appPath("/api/suite"), { credentials: "include" })
    .then((r) => (r.ok ? (r.json() as Promise<SuiteInfo>) : NONE))
    .catch(() => NONE)
    .then((s) => (cached = s));
  return pending;
}

export function useSuite(): SuiteInfo {
  const [info, setInfo] = useState<SuiteInfo>(cached ?? NONE);
  useEffect(() => {
    if (cached) return;
    let live = true;
    void load().then((s) => live && setInfo(s));
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/** "Sign in with Base": the hand-off starts here and comes back to `next` (a path inside this app). */
export function signInWithBaseHref(next: string = currentAppPath()): string {
  return appPath(`/auth/base?next=${encodeURIComponent(appPath(next.startsWith("/") ? next : "/"))}`);
}

export interface SuiteLink {
  id: "field" | "ground" | "air" | "web";
  /** The product's name as people read it: Base Ground, Base Air, Base Web. */
  name: string;
  /** Which face of it, when it has two (Base Ground's field and ground). */
  face?: string;
  detail: string;
  href: string;
  current?: boolean;
}

/** The switcher's list: field and ground (Base Ground is the hub), this app, and Base Web's admin when it is set up. */
export function suiteLinks(info: SuiteInfo): SuiteLink[] {
  const out: SuiteLink[] = [];
  const g = info.groundUrl?.replace(/\/+$/, "");
  if (g) {
    out.push({ id: "field", name: "Base Ground", face: "field", detail: "Volunteers and canvassing", href: `${g}/field/` });
    out.push({ id: "ground", name: "Base Ground", face: "ground", detail: "The organizing desk", href: `${g}/ground/` });
  }
  out.push({ id: "air", name: "Base Air", detail: "Attention and social", href: appPath("/"), current: true });
  const w = info.webUrl?.replace(/\/+$/, "");
  if (w) out.push({ id: "web", name: "Base Web", detail: "Website admin", href: `${w}/auth/base?next=${encodeURIComponent("/admin")}` });
  return out;
}
