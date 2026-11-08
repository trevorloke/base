import { useEffect, useState } from "react";
import { appPath, currentAppPath } from "./base";

/**
 * What this deployment knows about the rest of the base suite (SUITE.md): whether "Sign in with base" is set up, and
 * where base ground and base web live. The server writes it into index.html as window.__BASE_SUITE__; the Vite dev
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

/** "Sign in with base": the hand-off starts here and comes back to `next` (a path inside this app). */
export function signInWithBaseHref(next: string = currentAppPath()): string {
  return appPath(`/auth/base?next=${encodeURIComponent(appPath(next.startsWith("/") ? next : "/"))}`);
}

export interface SuiteLink {
  id: "field" | "ground" | "air" | "web";
  name: string;
  detail: string;
  href: string;
  current?: boolean;
}

/** The switcher's list: field and ground (base ground is the hub), this app, and base web's admin when it is set up. */
export function suiteLinks(info: SuiteInfo): SuiteLink[] {
  const out: SuiteLink[] = [];
  const g = info.groundUrl?.replace(/\/+$/, "");
  if (g) {
    out.push({ id: "field", name: "field", detail: "Volunteers and canvassing", href: `${g}/field/` });
    out.push({ id: "ground", name: "ground", detail: "The organizing desk", href: `${g}/ground/` });
  }
  out.push({ id: "air", name: "air", detail: "Attention and social", href: appPath("/"), current: true });
  const w = info.webUrl?.replace(/\/+$/, "");
  if (w) out.push({ id: "web", name: "web", detail: "Website admin", href: `${w}/auth/base?next=${encodeURIComponent("/admin")}` });
  return out;
}
