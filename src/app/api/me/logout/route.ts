import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { clearMemberSession } from "@/lib/server/member-auth";

export async function POST(req: NextRequest) {
  await clearMemberSession();
  return redirectTo("/", 303);
}
