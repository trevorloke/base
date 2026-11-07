import { NextResponse, type NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { getDb } from "@/lib/db";
import { consentMeta } from "@/lib/server/consent";
import { unsubscribeByToken } from "@/lib/server/newsletter";

// Works for the button on /newsletter/unsubscribe and for one-click
// List-Unsubscribe-Post from mail clients (token in the query string). The
// withdrawal is recorded in the consent ledger with the request details.
export async function POST(req: NextRequest) {
  let token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    const form = await req.formData().catch(() => null);
    token = String(form?.get("token") ?? "");
  }
  if (token) {
    try {
      await unsubscribeByToken(getDb(), token, consentMeta(req));
    } catch (err) {
      console.error("unsubscribe failed", err);
      return new NextResponse("Something went wrong. Please try the link again in a minute.", { status: 500 });
    }
  }
  return redirectTo("/newsletter/unsubscribe?done=1", 303);
}

// A plain link to this route (older emails, link scanners, prefetching)
// changes nothing, so it records nothing: it shows the page with the button,
// whose POST does both.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const url = new URL("/newsletter/unsubscribe", "http://site.invalid");
  if (token) url.searchParams.set("token", token);
  return redirectTo(url, 303);
}
