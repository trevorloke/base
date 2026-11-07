import { NextResponse } from "next/server";

/**
 * Redirect to a path on this site with a relative Location header.
 *
 * Behind a hosting proxy (Render, Docker, a load balancer) the server sees
 * its own internal address, e.g. http://localhost:10000, so an absolute URL
 * built from `req.url` would send the visitor there. A relative Location is
 * resolved by the browser against the address it actually used.
 */
export function redirectTo(target: string | URL, status: 302 | 303 | 307 = 303): NextResponse {
  const location = typeof target === "string" ? target : `${target.pathname}${target.search}${target.hash}`;
  if (!location.startsWith("/") || location.startsWith("//")) throw new Error(`redirectTo needs a path on this site, got ${location}`);
  return new NextResponse(null, { status, headers: { Location: location } });
}
