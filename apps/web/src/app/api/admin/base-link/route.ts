import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { redirectTo } from "@/lib/redirect";
import { requestMeta } from "@/lib/server/admin-auth";
import { LINK_COOKIE, LINK_PAGE, linkWithPassword } from "@/lib/server/base-link";
import { respondToLink } from "./respond";

export const dynamic = "force-dynamic";

/** The first "Sign in with Base": prove the staff account is yours with its password (SUITE.md, "The hand-off", step 6). */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  try {
    const outcome = await linkWithPassword(getDb(), req.cookies.get(LINK_COOKIE)?.value, password, requestMeta(req));
    return respondToLink(outcome, "password");
  } catch (err) {
    console.error("Linking a Base Ground login failed", err);
    return redirectTo(`${LINK_PAGE}?error=setup`, 303);
  }
}
