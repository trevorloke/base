import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/server/admin-auth";

/** The log used to live here; it is now the Email & texts page itself. Old links keep their filters. */
export default async function OldCommsLog({ searchParams }: PageProps<"/admin/comms/log">) {
  await requireAdmin("comms");
  const sp = await searchParams;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") query.set(k, v);
  const qs = query.toString();
  redirect(qs ? `/admin/comms?${qs}` : "/admin/comms");
}
