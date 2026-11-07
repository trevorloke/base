import "server-only";
import { currentLimit, membershipMinimums } from "@/lib/server/payments";
import { getSettings } from "@/lib/server/settings";
import { MembershipFormClient } from "./MembershipFormClient";

/**
 * The membership application, with what it needs from the server: the
 * minimums (MEMBERSHIP_FEE_CENTS, and the youth minimum), this year's
 * contribution limit as the most anyone can give, and the section's copy.
 * The minimums are read here, so the form and the route always agree.
 */
export async function MembershipForm() {
  const [{ cents: maxCents }, { membership }] = await Promise.all([currentLimit(), getSettings()]);
  return <MembershipFormClient minimums={membershipMinimums()} maxCents={maxCents} amountTitle={membership.amountTitle} amountNote={membership.amountNote} />;
}
