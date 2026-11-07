import { getDb } from "@/lib/db";
import { adminOnly } from "@/lib/server/admin-api";
import { PACIFIC } from "@/lib/server/admin-data";
import { audit } from "@/lib/server/audit";
import { deskGiftsCsv, listDeskGifts } from "@/lib/server/desk-gifts";

/** The online gifts still to log at the desk, as CSV (money permission). */
export async function GET() {
  const auth = await adminOnly("money");
  if (!auth.ok) return auth.response;
  const gifts = await listDeskGifts(getDb(), 5_000);
  await audit(auth.user, "export", { dataset: "desk-gifts", rows: gifts.length });
  const date = new Date().toLocaleDateString("en-CA", { timeZone: PACIFIC });
  return new Response(deskGiftsCsv(gifts), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="imagine-surrey-gifts-to-log-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
}
