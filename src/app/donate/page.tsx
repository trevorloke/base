import type { Metadata } from "next";
import { connection } from "next/server";
import { DonateForm } from "@/components/forms/DonateForm";
import type { Choice } from "@/components/forms/AmountPicker";
import { PageHead } from "@/components/PageHead";
import { Alert } from "@/components/forms/Field";
import { DEFAULT_CENTS, starClubCents } from "@/lib/contributions";
import { formatCents } from "@/lib/money";
import { currentLimit } from "@/lib/server/limits";
import { getSettings } from "@/lib/server/settings";

export const metadata: Metadata = { title: "Chip in", description: "Contribute to Imagine Surrey, one-time or monthly." };

export default async function DonatePage({ searchParams }: PageProps<"/donate">) {
  await connection();
  // This Pacific year's limit, so the page changes over at midnight on January 1.
  const [sp, settings, { year, cents: limitCents }] = await Promise.all([searchParams, getSettings(), currentLimit()]);
  const { donate, org } = settings;
  // One-time is the default. Monthly is only selected here when the person
  // chose it themselves on the home page widget, which links with ?frequency=.
  const frequency = sp.frequency === "monthly" ? "monthly" : "one_time";
  const tier = sp.tier === "star" || sp.tier === "superstar" ? sp.tier : "standard";
  const amount = Number(sp.amount);
  const initial: Choice = {
    frequency,
    tier,
    amountCents:
      tier === "standard"
        ? Number.isInteger(amount) && amount > 0
          ? amount
          : DEFAULT_CENTS[frequency]
        : starClubCents(frequency, limitCents) * (tier === "superstar" ? 2 : 1),
  };

  return (
    <>
      <PageHead title={donate.title}>{donate.intro}</PageHead>
      <section className="section">
        <div className="container split">
          <div className="stack" style={{ flex: "1 1 320px", gap: 16 }}>
            {sp.cancelled && <Alert tone="note">Your payment was cancelled and you haven’t been charged. You can try again whenever you’re ready.</Alert>}
            <h2 className="h3" style={{ fontSize: 26 }}>
              Where your money goes
            </h2>
            <p className="body">{donate.text}</p>
            <h2 className="h3" style={{ fontSize: 26, marginTop: 12 }}>
              Who can give
            </h2>
            <p className="body">
              Contributions must come from an individual who lives in BC and is a Canadian citizen or permanent resident, using their own money. The limit
              under BC’s Local Elections Campaign Financing Act is {formatCents(limitCents)} per person in {year}. Memberships count toward it.
              Contributions aren’t tax deductible.
            </p>
            <p className="body">If a payment ever takes you over the annual limit, we return the extra automatically.</p>
            {org.authorizationLine && <p className="small">{org.authorizationLine}</p>}
          </div>
          <DonateForm initial={initial} limitCents={limitCents} year={year} monthlyNote={donate.monthlyNote} clubNote={donate.clubNote} />
        </div>
      </section>
    </>
  );
}
