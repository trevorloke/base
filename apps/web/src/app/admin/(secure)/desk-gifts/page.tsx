import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { requireAdmin } from "@/lib/server/admin-auth";
import { listDeskGifts, SLATE_NAMES } from "@/lib/server/desk-gifts";
import { markGiftsLogged } from "./actions";
import { DeskGiftsForm, type DeskGiftView } from "./DeskGiftsForm";
import "../people/people.css";

/**
 * Online gifts to log at the desk. base ground is where the contribution limits
 * are checked across every channel, so each gift taken here is typed into
 * base ground → Donations → Log a gift by the treasurer, then marked logged.
 * Nothing about money is sent to base ground automatically.
 */
export default async function DeskGiftsPage() {
  await requireAdmin("money");
  const gifts = await listDeskGifts(getDb());
  const view: DeskGiftView[] = gifts.map((g) => ({
    id: g.id,
    name: g.contributorName,
    email: g.email ?? "",
    address: g.contributorAddress,
    city: g.contributorCity,
    postalCode: g.contributorPostalCode,
    amount: formatCents(g.amountCents),
    net: g.netCents === g.amountCents ? null : formatCents(g.netCents),
    slate: SLATE_NAMES[g.slate],
    kind: g.kindLabel,
    paid: g.paidPacific,
    reference: g.reference,
    flags: g.flags,
    personId: g.personId,
  }));

  return (
    <>
      <div className="crm-head">
        <h1 className="h3">Gifts to log at the desk</h1>
        <nav className="crm-sub" aria-label="Related">
          {gifts.length > 0 && <a href="/api/admin/desk-gifts">Download this list (CSV)</a>}
          <Link href="/admin/exports">Exports</Link>
        </nav>
      </div>
      <p style={{ maxWidth: 760 }}>
        Contribution limits are checked at the desk, across every way people give. Each online gift below goes into base ground by hand: open{" "}
        <strong>Donations → Log a gift</strong>, enter what the row shows, then mark it logged here. Oldest first; times are Pacific. Nothing about money is ever sent to
        base ground by the website.
      </p>
      <DeskGiftsForm gifts={view} action={markGiftsLogged} />
    </>
  );
}
