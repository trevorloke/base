import "server-only";
import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { contributions, people } from "@/lib/db/schema";
import { csvLine } from "./admin-data";

// Online gifts the treasurer still has to log at the desk (Base Ground →
// Donations → Log a gift), where the contribution limits are checked across
// every channel. Nothing about money is ever sent to Base Ground automatically:
// this list is how online gifts get there, typed in by a person.

// Money that arrived: a succeeded payment, including ones refunded since.
const RECEIVED = ["succeeded", "refunded", "refunded_over_limit"] as const;

const unlogged = and(inArray(contributions.status, [...RECEIVED]), isNotNull(contributions.paidAt), isNull(contributions.deskLoggedAt));

type GiftRow = {
  id: string;
  kind: "donation" | "membership_fee";
  frequency: "one_time" | "monthly";
  slate: "council" | "school_board";
  status: string;
  amountCents: number;
  refundedCents: number;
  refundPendingCents: number;
  contributorName: string;
  contributorAddress: string;
  contributorCity: string;
  contributorPostalCode: string;
  email: string | null;
  paidAt: Date | null;
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  personId: string;
};

export const SLATE_NAMES = { council: "City council", school_board: "School board" } as const;

/** donation / membership fee / monthly payment */
export function giftKind(g: Pick<GiftRow, "kind" | "frequency">): string {
  if (g.kind === "membership_fee") return "Membership fee";
  return g.frequency === "monthly" ? "Monthly payment" : "Donation";
}

/** What was kept: the amount less refunds made and refunds about to be made. */
export function netCents(g: Pick<GiftRow, "amountCents" | "refundedCents" | "refundPendingCents">): number {
  return Math.max(0, g.amountCents - g.refundedCents - g.refundPendingCents);
}

/** Warnings for the treasurer: refunds, and gifts the website found over the annual limit. */
export function giftFlags(g: Pick<GiftRow, "status" | "amountCents" | "refundedCents" | "refundPendingCents">): string[] {
  const flags: string[] = [];
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (g.status === "refunded_over_limit") flags.push("Over the limit: returned in full");
  else if (g.status === "refunded") flags.push("Refunded in full");
  else if (g.refundedCents > 0) flags.push(`Partly refunded (${dollars(g.refundedCents)})`);
  if (g.refundPendingCents > 0) flags.push(`Over the limit: ${dollars(g.refundPendingCents)} being returned`);
  return flags;
}

/** "2026-11-06 14:05" in Pacific time. */
export function pacificDateTime(d: Date | null): string {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** The Stripe reference to quote: the payment, or for a monthly gift its invoice too. */
export function stripeReference(g: Pick<GiftRow, "stripePaymentIntentId" | "stripeInvoiceId">): string {
  return [g.stripePaymentIntentId, g.stripeInvoiceId].filter(Boolean).join(" / ");
}

export type DeskGift = GiftRow & { kindLabel: string; netCents: number; flags: string[]; paidPacific: string; reference: string };

/** Received online gifts not yet logged at the desk, oldest first. */
export async function listDeskGifts(db: Db, limit = 500): Promise<DeskGift[]> {
  const rows = await db
    .select({
      id: contributions.id,
      kind: contributions.kind,
      frequency: contributions.frequency,
      slate: contributions.slate,
      status: contributions.status,
      amountCents: contributions.amountCents,
      refundedCents: contributions.refundedCents,
      refundPendingCents: contributions.refundPendingCents,
      contributorName: contributions.contributorName,
      contributorAddress: contributions.contributorAddress,
      contributorCity: contributions.contributorCity,
      contributorPostalCode: contributions.contributorPostalCode,
      email: people.email,
      paidAt: contributions.paidAt,
      stripePaymentIntentId: contributions.stripePaymentIntentId,
      stripeInvoiceId: contributions.stripeInvoiceId,
      personId: contributions.personId,
    })
    .from(contributions)
    .leftJoin(people, eq(people.id, contributions.personId))
    .where(unlogged)
    .orderBy(asc(contributions.paidAt), asc(contributions.createdAt))
    .limit(limit);
  return rows.map((g) => ({ ...g, kindLabel: giftKind(g), netCents: netCents(g), flags: giftFlags(g), paidPacific: pacificDateTime(g.paidAt), reference: stripeReference(g) }));
}

export async function countDeskGifts(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(contributions).where(unlogged);
  return Number(row?.n ?? 0);
}

/** Mark gifts as logged at the desk. Returns how many changed (already-logged ones are left alone). */
export async function markDeskLogged(db: Db, ids: string[], adminUserId: string | null): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(contributions)
    .set({ deskLoggedAt: new Date(), deskLoggedById: adminUserId })
    .where(and(inArray(contributions.id, ids), isNull(contributions.deskLoggedAt)))
    .returning({ id: contributions.id });
  return rows.length;
}

export const DESK_GIFT_CSV_HEADERS = [
  "Contributor name",
  "Address",
  "City",
  "Postal code",
  "Email",
  "Amount",
  "Net of refunds",
  "Slate",
  "Kind",
  "Paid (Pacific)",
  "Stripe reference",
  "Flags",
  "Website id",
] as const;

/** The unlogged list as CSV, in the columns the desk's Log a gift asks for. */
export function deskGiftsCsv(gifts: DeskGift[]): string {
  const money = (c: number) => (c / 100).toFixed(2);
  const headers = [...DESK_GIFT_CSV_HEADERS];
  const lines = gifts.map((g) =>
    csvLine(headers, {
      "Contributor name": g.contributorName,
      Address: g.contributorAddress,
      City: g.contributorCity,
      "Postal code": g.contributorPostalCode,
      Email: g.email ?? "",
      Amount: money(g.amountCents),
      "Net of refunds": money(g.netCents),
      Slate: SLATE_NAMES[g.slate],
      Kind: g.kindLabel,
      "Paid (Pacific)": g.paidPacific,
      "Stripe reference": g.reference,
      Flags: g.flags.join("; "),
      "Website id": g.id,
    }),
  );
  return headers.join(",") + "\r\n" + lines.join("");
}
