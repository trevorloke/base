import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { getDb } from "@/lib/db";
import { getMember } from "@/lib/server/member-auth";
import { requestDeletion } from "@/lib/server/portal";
import { forwardDeletionRequest } from "@/lib/server/base-ground-forward";

/**
 * "Ask us to delete my account": tags the record, notes it, emails the
 * office, and files a request at the desk (with the email and name only) so
 * base ground's copy is dealt with too.
 */
export async function POST(req: NextRequest) {
  const person = await getMember();
  if (!person) return redirectTo("/me/login?next=%2Fme%2Fdata", 303);
  try {
    const db = getDb();
    const { first, date } = await requestDeletion(db, person);
    if (first) await forwardDeletionRequest(db, person, date);
    return redirectTo("/me/data?requested=1", 303);
  } catch (err) {
    console.error(err);
    return redirectTo("/me/data?requested=failed", 303);
  }
}
