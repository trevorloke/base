import { NextResponse, type NextRequest } from "next/server";
import { adminPreviewAllowed } from "@/lib/preview-mode";

// First gate for the admin: every /admin and /api/admin request needs a
// session cookie with a valid signature and expiry. Pages and actions then
// check the session row in the database (revocation, deactivated accounts).
// Runs without a database so it stays fast and can run at the edge.

const OPEN = ["/admin/login", "/api/admin/login", "/api/admin/logout", "/api/admin/magic-link", "/api/admin/preview"];
const COOKIE = "is_admin_session";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();

  const secret = process.env.ADMIN_SESSION_SECRET;
  const cookie = req.cookies.get(COOKIE)?.value;
  if (secret && cookie && (await verify(cookie, secret))) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  // Preview mode on a local copy: sign in automatically (see src/lib/preview-mode.ts).
  if (adminPreviewAllowed()) {
    const preview = new URL("/api/admin/preview", publicOrigin(req));
    preview.searchParams.set("next", pathname);
    return NextResponse.redirect(preview);
  }
  const login = new URL("/admin/login", publicOrigin(req));
  if (pathname !== "/admin") login.searchParams.set("next", pathname);
  const res = NextResponse.redirect(login);
  if (cookie) res.cookies.delete(COOKIE);
  return res;
}

/**
 * The address the visitor used. Behind a hosting proxy (Render, Docker) the
 * request URL carries the server's internal address (http://localhost:10000),
 * so prefer the host and scheme the proxy forwards. A redirect here must be
 * absolute, so the relative-path helper used by route handlers can't be.
 */
function publicOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  if (!host || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return req.nextUrl.origin;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.nextUrl.protocol.replace(":", "");
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

async function verify(value: string, secret: string): Promise<boolean> {
  const [id, expires, mac] = value.split(".");
  if (!id || !expires || !mac || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${expires}`)));
  return constantTimeEqual(base64url(sig), mac);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
