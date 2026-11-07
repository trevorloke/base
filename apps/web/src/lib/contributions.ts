// Pure contribution rules shared by the donate widget, the API, the Stripe
// webhook and the supporter portal. No server-only imports so the client can
// use them too, and every function is exported so tests can cover it.

import { formatCents } from "./money";

export type Frequency = "one_time" | "monthly";
export type Tier = "standard" | "star" | "superstar";
export type Slate = "council" | "school_board";
export type SlateAmounts = Partial<Record<Slate, number>>;

/** Slates in the order money is allocated to them (refunds come off council first). */
export const SLATES: readonly Slate[] = ["council", "school_board"];

export const MIN_DONATION_CENTS = 500;

export const PRESETS_CENTS: Record<Frequency, number[]> = {
  one_time: [2500, 5000, 10000, 25000],
  monthly: [1000, 2500, 5000, 10000],
};

export const DEFAULT_CENTS: Record<Frequency, number> = { one_time: 5000, monthly: 2500 };

/** The Star Club gives the yearly maximum: at once, or across twelve months in whole dollars. */
export function starClubCents(frequency: Frequency, limitCents: number): number {
  return frequency === "monthly" ? Math.floor(limitCents / 12 / 100) * 100 : limitCents;
}

/**
 * How a donation splits across slates. The Superstar Club is the maximum to
 * both the council and the school board slates: two contributions, one payment.
 */
export function slateAmountsFor(tier: Tier, frequency: Frequency, amountCents: number, limitCents: number): SlateAmounts {
  if (tier === "standard") return { council: amountCents };
  const star = starClubCents(frequency, limitCents);
  return tier === "star" ? { council: star } : { council: star, school_board: star };
}

export function totalCents(amounts: SlateAmounts): number {
  return (amounts.council ?? 0) + (amounts.school_board ?? 0);
}

/** Monthly payments still to come this calendar year, counting the current month (0 = January). */
export function paymentsLeftThisYear(monthIndex: number): number {
  return 12 - monthIndex;
}

/**
 * Payments an active monthly gift will still make this year. This month's
 * payment is counted until it has actually arrived, so a gift billed on the
 * 20th still reserves its room on the 5th.
 */
export function remainingMonthlyPayments(monthIndex: number, paidThisMonth: boolean): number {
  return Math.max(0, paymentsLeftThisYear(monthIndex) - (paidThisMonth ? 1 : 0));
}

const PACIFIC = "America/Vancouver";

/** The Pacific calendar date of an instant, as YYYY-MM-DD. */
export function pacificDateIso(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** The contribution year an instant falls in: the Pacific calendar year, so it turns over at midnight on January 1 in Surrey. */
export function pacificYear(date: Date): number {
  return Number(pacificDateIso(date).slice(0, 4));
}

/** Year and month in Pacific time, which is how contribution years are counted. */
export function pacificYearMonth(date: Date): { year: number; monthIndex: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "numeric" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), monthIndex: get("month") - 1 };
}

/** Pacific wall-clock time minus UTC at `date`, in milliseconds (negative, e.g. -8h in winter). */
function pacificOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight on the first of a month in Pacific time, as an instant. Handles daylight-saving changes. */
export function pacificMonthStart(year: number, monthIndex: number): Date {
  const wall = Date.UTC(year, monthIndex, 1);
  let utc = wall + 8 * 3600_000;
  // Two passes settle the offset when the guess lands on the other side of a clock change.
  for (let i = 0; i < 2; i++) utc = wall - pacificOffsetMs(new Date(utc));
  return new Date(utc);
}

/** [start, end) of a contribution year: Jan 1 in Pacific time. */
export function pacificYearBounds(year: number): [Date, Date] {
  return [pacificMonthStart(year, 0), pacificMonthStart(year + 1, 0)];
}

/** [start, end) of a calendar month in Pacific time. */
export function pacificMonthBounds(year: number, monthIndex: number): [Date, Date] {
  const next = monthIndex === 11 ? pacificMonthStart(year + 1, 0) : pacificMonthStart(year, monthIndex + 1);
  return [pacificMonthStart(year, monthIndex), next];
}

export interface LimitCheckInput {
  frequency: Frequency;
  slateAmounts: SlateAmounts;
  /** Accepted contributions so far this calendar year, per slate. */
  yearToDate: SlateAmounts;
  /** Payments already scheduled for the rest of this year by active monthly gifts, per slate. */
  committed: SlateAmounts;
  /** Monthly amounts of the active monthly gifts, per slate: a new monthly gift must fit beside them for a full year. */
  monthlyActive?: SlateAmounts;
  limitCents: number;
  /** The current month in Pacific time, 0 = January. */
  monthIndex: number;
}

export interface LimitCheckResult {
  ok: boolean;
  /** The slate that would go over, when not ok. */
  slate?: Slate;
  /** The most this person can still give to that slate this year. */
  remainingCents?: number;
}

/**
 * Would this gift take the contributor over the annual limit for any slate?
 * A monthly gift counts every payment left in the year, and together with the
 * monthly gifts already running must also fit within a full year on its own.
 */
export function checkAnnualLimit(input: LimitCheckInput): LimitCheckResult {
  const { frequency, slateAmounts, yearToDate, committed, monthlyActive = {}, limitCents, monthIndex } = input;
  for (const slate of SLATES) {
    const amount = slateAmounts[slate] ?? 0;
    if (amount <= 0) continue;
    const used = (yearToDate[slate] ?? 0) + (committed[slate] ?? 0);
    const remaining = Math.max(0, limitCents - used);
    const thisYear = frequency === "monthly" ? amount * paymentsLeftThisYear(monthIndex) : amount;
    const fullYear = frequency === "monthly" ? (amount + (monthlyActive[slate] ?? 0)) * 12 : amount;
    if (thisYear > remaining || fullYear > limitCents) return { ok: false, slate, remainingCents: remaining };
  }
  return { ok: true };
}

/** The part of a payment that would exceed the limit and must be returned. */
export function excessOverLimit(acceptedSoFarCents: number, paymentCents: number, limitCents: number): number {
  return Math.max(0, Math.min(paymentCents, acceptedSoFarCents + paymentCents - limitCents));
}

export interface RefundableRow {
  id: string;
  slate: Slate;
  amountCents: number;
  refundedCents: number;
  /** Decided by the webhook but not yet confirmed by Stripe. */
  refundPendingCents?: number;
  /** Refunds Stripe lists for this very row (by the contribution id in their metadata). */
  confirmedCents?: number;
  createdAt?: Date;
}

export interface RefundChange {
  id: string;
  /** The row's new refunded total. */
  refundedCents: number;
  /** What the row still waits to send Stripe, after what Stripe has returned is counted. */
  refundPendingCents: number;
  /** True once nothing of the row is left with us. */
  fullyRefunded: boolean;
  /**
   * The status a fully refunded row takes: refunded_over_limit when the
   * refund we decided on completed it, refunded when a dashboard refund did.
   */
  status: "refunded" | "refunded_over_limit" | null;
}

/**
 * Reconcile our rows for one payment with what Stripe says has been refunded
 * on it, so that the rows' refunded totals add up to Stripe's figure. Money
 * Stripe has returned beyond what we recorded first settles the refunds we
 * had decided on but not yet confirmed (a refund of ours that went through
 * unrecorded, or an operator returning the same money from the dashboard),
 * refunds Stripe attributes to a row before anything else and council
 * first; only what is left is a dashboard refund, taken off each row's
 * remaining balance council first. Returns only the rows that change.
 */
export function allocateRefund(rows: RefundableRow[], amountRefundedCents: number): RefundChange[] {
  const recorded = rows.reduce((sum, r) => sum + r.refundedCents, 0);
  let delta = amountRefundedCents - recorded;
  if (delta <= 0) return [];
  const ordered = [...rows].sort(
    (a, b) => SLATES.indexOf(a.slate) - SLATES.indexOf(b.slate) || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
  );
  const state = new Map<string, { refunded: number; pending: number; dashboard: boolean }>();
  const of = (row: RefundableRow) => state.get(row.id) ?? { refunded: row.refundedCents, pending: row.refundPendingCents ?? 0, dashboard: false };
  const settle = (row: RefundableRow, upTo: number) => {
    const s = of(row);
    const take = Math.min(s.pending, upTo, delta);
    if (take <= 0) return;
    s.pending -= take;
    s.refunded += take;
    delta -= take;
    state.set(row.id, s);
  };
  for (const row of ordered) settle(row, row.confirmedCents ?? 0);
  for (const row of ordered) settle(row, Infinity);
  for (const row of ordered) {
    if (delta <= 0) break;
    const s = of(row);
    const room = row.amountCents - s.refunded - s.pending;
    if (room <= 0) continue;
    const take = Math.min(room, delta);
    s.refunded += take;
    s.dashboard = true;
    delta -= take;
    state.set(row.id, s);
  }
  return ordered
    .filter((row) => state.has(row.id))
    .map((row) => {
      const s = state.get(row.id)!;
      const fullyRefunded = s.refunded >= row.amountCents;
      return {
        id: row.id,
        refundedCents: s.refunded,
        refundPendingCents: s.pending,
        fullyRefunded,
        status: fullyRefunded ? (s.dashboard ? "refunded" : "refunded_over_limit") : null,
      };
    });
}

/**
 * Whether a subscription will take no further payment: the donor has set it
 * to cancel at the end of the period already paid for, or Stripe will cancel
 * it (cancel_at) on or before the date its next payment is due. A cancel_at
 * further out still lets the payments before it happen, so the gift keeps
 * reserving room (the webhook backstop returns anything that turns out over
 * the limit). `periodEnd` is when the next payment is due, in seconds.
 */
export function subscriptionEndsBeforeNextPayment(s: { cancelAtPeriodEnd?: boolean | null; cancelAt?: number | null; periodEnd?: number | null }): boolean {
  if (s.cancelAtPeriodEnd) return true;
  return typeof s.cancelAt === "number" && typeof s.periodEnd === "number" && s.cancelAt <= s.periodEnd;
}

/**
 * What a Stripe subscription status means for a recurring gift. Stripe stops
 * collecting on canceled, unpaid and paused subscriptions, so they must stop
 * reserving the donor's limit; so must one that ends before its next payment
 * (see subscriptionEndsBeforeNextPayment), since no further payment will
 * come, and taking that back makes it active again. past_due keeps retrying
 * and stays active. Null means leave the gift as it is.
 */
export function recurringStatusFor(stripeStatus: string, endsBeforeNextPayment = false): "active" | "cancelled" | null {
  switch (stripeStatus) {
    case "canceled":
    case "unpaid":
    case "paused":
    case "incomplete_expired":
      return "cancelled";
    case "active":
    case "trialing":
    case "past_due":
      return endsBeforeNextPayment ? "cancelled" : "active";
    default:
      return null;
  }
}

/**
 * What one monthly payment actually brought in, per slate. The gift's slate
 * amounts are what was asked for; a coupon, credit or price change in the
 * Stripe dashboard can make the invoice's amount_paid differ, and only money
 * received may be recorded. The amount paid is shared in proportion to the
 * gift's amounts, rounding down, and the cents left by rounding go to the
 * council slate first. Slates that come to nothing are left out.
 */
export function allocatePayment(configured: SlateAmounts, paidCents: number): SlateAmounts {
  const slates = SLATES.filter((slate) => (configured[slate] ?? 0) > 0);
  const total = slates.reduce((sum, slate) => sum + configured[slate]!, 0);
  const paid = Math.max(0, Math.floor(paidCents));
  if (total <= 0 || paid <= 0) return {};
  if (paid === total) return Object.fromEntries(slates.map((slate) => [slate, configured[slate]!]));
  const shares = new Map(slates.map((slate) => [slate, Math.floor((paid * configured[slate]!) / total)]));
  let left = paid - [...shares.values()].reduce((a, b) => a + b, 0);
  for (const slate of slates) {
    if (left <= 0) break;
    shares.set(slate, shares.get(slate)! + 1);
    left -= 1;
  }
  const out: SlateAmounts = {};
  for (const slate of slates) if (shares.get(slate)! > 0) out[slate] = shares.get(slate)!;
  return out;
}

export function addYear(date: Date): Date {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

/**
 * When a new membership runs. Joining while a membership is still active
 * extends it: the new term starts when the latest active one ends.
 */
export function membershipTerm(latestActiveExpiry: Date | null | undefined, now: Date): { startsAt: Date; expiresAt: Date } {
  const startsAt = latestActiveExpiry && latestActiveExpiry.getTime() > now.getTime() ? new Date(latestActiveExpiry) : new Date(now);
  return { startsAt, expiresAt: addYear(startsAt) };
}

// ── Contribution limits by year ─────────────────────────────────────────────

export type YearLimit = { year: number; cents: number };

/**
 * The annual limit for a contribution year: the figure stored for that year,
 * else the configured fallback (CONTRIBUTION_LIMIT_CENTS).
 */
export function limitFromRows(rows: readonly YearLimit[], year: number, fallbackCents: number): number {
  const row = rows.find((r) => r.year === year);
  return row && row.cents > 0 ? row.cents : fallbackCents;
}

/**
 * The year whose limit the admin should be asked for, or null: next year's
 * from December 1 (Pacific) when none is stored yet, and this year's whenever
 * none is stored (gifts are then checked against CONTRIBUTION_LIMIT_CENTS,
 * which may be last year's figure).
 */
export function limitYearNeeded(now: Date, storedYears: readonly number[]): number | null {
  const { year, monthIndex } = pacificYearMonth(now);
  if (!storedYears.includes(year)) return year;
  if (monthIndex === 11 && !storedYears.includes(year + 1)) return year + 1;
  return null;
}

// ── Membership by donation ─────────────────────────────────────────────────
// Membership is pay what you can, renewed every year. MEMBERSHIP_FEE_CENTS is
// the minimum; youth members (14 to 30 on the day they join) have half of it,
// or MEMBERSHIP_YOUTH_MIN_CENTS when that is set.

export const YOUTH_MIN_AGE = 14;
export const YOUTH_MAX_AGE = 30;

/** Suggested amounts on the join form, from which the minimum and the next three above it are shown. */
export const MEMBERSHIP_SUGGESTED_CENTS = [1000, 2500, 5000, 10000];

export type MembershipMinimums = {
  /** The minimum for everyone else. 0 means membership is free. */
  standardCents: number;
  /** The minimum for youth members. */
  youthCents: number;
};

/** The two minimums from the configured standard minimum and the optional youth minimum (never above the standard one). */
export function membershipMinimums(standardCents: number, youthCents?: number | null): MembershipMinimums {
  const standard = Math.max(0, Math.floor(standardCents));
  if (standard === 0) return { standardCents: 0, youthCents: 0 };
  const youth = typeof youthCents === "number" && Number.isFinite(youthCents) ? Math.max(0, Math.floor(youthCents)) : Math.ceil(standard / 2);
  return { standardCents: standard, youthCents: Math.min(youth, standard) };
}

/** Whole years of age on a calendar date (YYYY-MM-DD), or undefined when the birthdate isn't one. */
export function ageOnDate(birthdate: string, onIso: string): number | undefined {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onIso);
  if (!b || !d) return undefined;
  let age = Number(d[1]) - Number(b[1]);
  if (d[2] + d[3] < b[2] + b[3]) age -= 1;
  return age;
}

/** Youth membership: aged 14 to 30, inclusive, on the Pacific day they join. */
export function isYouthMember(birthdate: string, now: Date): boolean {
  const age = ageOnDate(birthdate, pacificDateIso(now));
  return age !== undefined && age >= YOUTH_MIN_AGE && age <= YOUTH_MAX_AGE;
}

/** The minimum that applies to this person. */
export function membershipMinimumFor(minimums: MembershipMinimums, youth: boolean): number {
  return youth ? minimums.youthCents : minimums.standardCents;
}

/** The suggested amounts for a minimum: the minimum itself, then the usual amounts above it, four in all. */
export function membershipSuggestions(minCents: number): number[] {
  return [minCents, ...MEMBERSHIP_SUGGESTED_CENTS.filter((c) => c > minCents)].slice(0, 4);
}

/** What the form and the server say about an amount under the minimum. It names the youth minimum when it applies. */
export function membershipMinimumMessage(minimums: MembershipMinimums, youth: boolean): string {
  if (youth) return `The smallest youth membership (ages ${YOUTH_MIN_AGE} to ${YOUTH_MAX_AGE}) is ${formatCents(minimums.youthCents)} a year.`;
  const youthNote = minimums.youthCents < minimums.standardCents ? ` (${formatCents(minimums.youthCents)} for members aged ${YOUTH_MIN_AGE} to ${YOUTH_MAX_AGE})` : "";
  return `The smallest membership is ${formatCents(minimums.standardCents)} a year${youthNote}.`;
}

/** What the form and the server say about an amount over the most anyone can give in a year. */
export function membershipMaximumMessage(maxCents: number): string {
  return `The most you can give is ${formatCents(maxCents)} a year under BC law.`;
}

/**
 * Check a chosen membership amount: whole cents, at least the minimum that
 * applies, and no more than the year's contribution limit (a membership is a
 * contribution). Returns the message to show, or null when it is fine.
 */
export function membershipAmountProblem(amountCents: number, minimums: MembershipMinimums, youth: boolean, maxCents: number): string | null {
  if (!Number.isInteger(amountCents) || amountCents < membershipMinimumFor(minimums, youth)) return membershipMinimumMessage(minimums, youth);
  if (amountCents > maxCents) return membershipMaximumMessage(maxCents);
  return null;
}
