import { getDb } from "@/lib/db";
import { error } from "@/lib/server/api";
import { getMember } from "@/lib/server/member-auth";
import { exportPersonData } from "@/lib/server/portal";

/** Everything we hold about the signed-in supporter, as a JSON download (PIPA access request). */
export async function GET() {
  const person = await getMember();
  if (!person) return error("Sign in to download your data.", 401);
  const data = await exportPersonData(getDb(), person);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="my-imagine-surrey-data.json"',
      "cache-control": "private, no-store",
    },
  });
}
