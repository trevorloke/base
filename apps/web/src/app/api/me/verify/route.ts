import { NextResponse, type NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { getDb } from "@/lib/db";
import { safeMemberNext } from "@/lib/engagement";
import { env } from "@/lib/env";
import { setMemberSession } from "@/lib/server/member-auth";
import { findPersonByEmail } from "@/lib/server/people";
import { consumeToken } from "@/lib/server/tokens";

/**
 * Links already sent point here. Opening a link must not sign anyone in:
 * mail scanners follow links, and a GET that starts a session lets another
 * site sign a visitor into someone else's account. So GET only forwards to
 * the /me/verify page, whose button POSTs back here.
 */
export async function GET(req: NextRequest) {
  const url = new URL("/me/verify", "http://site.invalid");
  const token = req.nextUrl.searchParams.get("token");
  const next = req.nextUrl.searchParams.get("next");
  if (token) url.searchParams.set("token", token);
  if (next) url.searchParams.set("next", next);
  const res = redirectTo(url, 303);
  res.headers.set("Referrer-Policy", "same-origin");
  return res;
}

/** The "Sign in" button: redeem the token once, start the session, carry on to `next`. */
export async function POST(req: NextRequest) {
  const expired = () => redirectTo("/me/login?error=expired", 303);
  if (!sameSite(req)) return NextResponse.json({ error: "Sign in from the link in your email." }, { status: 403 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return expired();
  }
  const raw = String(form.get("token") ?? "");
  const db = getDb();
  const token = await consumeToken(db, "member-login", raw);
  if (!token) return expired();
  const person = await findPersonByEmail(db, token.email);
  if (!person) return expired();
  await setMemberSession(person.id);
  const next = safeMemberNext(form.get("next") ?? token.data?.next);
  return redirectTo(next, 303);
}

/** Only this site's own page may submit a token, so no other site can sign a visitor in. */
function sameSite(req: NextRequest): boolean {
  // Browsers say where a request came from; anything but this site (or a typed URL) is refused.
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const allowed = new Set([new URL(req.url).origin, new URL(env.siteUrl).origin]);
  return allowed.has(origin);
}
