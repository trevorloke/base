// The pure rules behind checkout and the limit, and the request plumbing the
// public money routes share. Nothing here touches the database or Stripe.
import { describe, expect, it, vi } from "vitest";
import {
  allocatePayment,
  allocateRefund,
  checkAnnualLimit,
  membershipTerm,
  recurringStatusFor,
  remainingMonthlyPayments,
  subscriptionEndsBeforeNextPayment,
} from "@/lib/contributions";
import { membershipFeeReturnedEmail } from "@/lib/email/membership-fee";

vi.mock("server-only", () => ({}));
const { overLimitMessage } = await import("@/lib/server/limits");
const { membershipMinimums, publicFormContext } = await import("@/lib/server/payments");
const { NextRequest } = await import("next/server");

const LIMIT = 142970;

describe("remainingMonthlyPayments (what an active monthly gift still reserves)", () => {
  it("counts this month's payment until it has arrived", () => {
    expect(remainingMonthlyPayments(0, false)).toBe(12);
    expect(remainingMonthlyPayments(0, true)).toBe(11);
    expect(remainingMonthlyPayments(10, false)).toBe(2);
    expect(remainingMonthlyPayments(10, true)).toBe(1);
  });
  it("never goes negative in December", () => {
    expect(remainingMonthlyPayments(11, true)).toBe(0);
  });
});

describe("checkAnnualLimit with monthly gifts already running", () => {
  const base = { yearToDate: {}, committed: {}, limitCents: LIMIT, monthIndex: 10 };

  it("refuses a new monthly gift that would not fit beside the active ones for a full year", () => {
    // $119 a month alone fits ($1,428 a year); beside an active $10 a month it would be $1,548.
    expect(checkAnnualLimit({ ...base, frequency: "monthly", slateAmounts: { council: 11900 } }).ok).toBe(true);
    const r = checkAnnualLimit({ ...base, frequency: "monthly", slateAmounts: { council: 11900 }, monthlyActive: { council: 1000 } });
    expect(r).toMatchObject({ ok: false, slate: "council" });
  });

  it("allows a second monthly gift that fits for a full year", () => {
    expect(checkAnnualLimit({ ...base, frequency: "monthly", slateAmounts: { council: 5000 }, monthlyActive: { council: 6000 } }).ok).toBe(true);
    expect(checkAnnualLimit({ ...base, frequency: "monthly", slateAmounts: { council: 6000 }, monthlyActive: { council: 6000 } }).ok).toBe(false);
  });

  it("only counts the active gifts for the same slate", () => {
    expect(checkAnnualLimit({ ...base, frequency: "monthly", slateAmounts: { council: 11900 }, monthlyActive: { school_board: 11900 } }).ok).toBe(true);
  });

  it("does not apply the full-year rule to one-time gifts", () => {
    expect(checkAnnualLimit({ ...base, frequency: "one_time", slateAmounts: { council: 100000 }, monthlyActive: { council: 11900 } }).ok).toBe(true);
  });
});

describe("allocateRefund (reconciling with what Stripe says is refunded)", () => {
  const rows = [
    { id: "sb", slate: "school_board" as const, amountCents: 142970, refundedCents: 0, createdAt: new Date(1) },
    { id: "c", slate: "council" as const, amountCents: 142970, refundedCents: 0, createdAt: new Date(2) },
  ];
  const settled = { refundPendingCents: 0 };

  it("takes a partial refund off council first", () => {
    expect(allocateRefund(rows, 50000)).toEqual([{ id: "c", refundedCents: 50000, ...settled, fullyRefunded: false, status: null }]);
  });

  it("fills council then spills into the school board slate", () => {
    expect(allocateRefund(rows, 200000)).toEqual([
      { id: "c", refundedCents: 142970, ...settled, fullyRefunded: true, status: "refunded" },
      { id: "sb", refundedCents: 57030, ...settled, fullyRefunded: false, status: null },
    ]);
  });

  it("only adds the difference when some of it is already recorded", () => {
    const partly = [
      { ...rows[1], refundedCents: 50000 },
      { ...rows[0], refundedCents: 0 },
    ];
    expect(allocateRefund(partly, 50000)).toEqual([]);
    expect(allocateRefund(partly, 60000)).toEqual([{ id: "c", refundedCents: 60000, ...settled, fullyRefunded: false, status: null }]);
  });

  it("settles our own pending refund once Stripe shows the money returned, however it was returned", () => {
    const pending = [{ id: "c", slate: "council" as const, amountCents: 1000, refundedCents: 0, refundPendingCents: 1000 }];
    expect(allocateRefund(pending, 1000)).toEqual([{ id: "c", refundedCents: 1000, refundPendingCents: 0, fullyRefunded: true, status: "refunded_over_limit" }]);
    // A dashboard refund of part of it leaves the rest to send.
    const partOf = [{ id: "c", slate: "council" as const, amountCents: 10000, refundedCents: 0, refundPendingCents: 7030 }];
    expect(allocateRefund(partOf, 3000)).toEqual([{ id: "c", refundedCents: 3000, refundPendingCents: 4030, fullyRefunded: false, status: null }]);
    // More than the pending amount is a dashboard refund on top.
    expect(allocateRefund(partOf, 9000)).toEqual([{ id: "c", refundedCents: 9000, refundPendingCents: 0, fullyRefunded: false, status: null }]);
    expect(allocateRefund(partOf, 10000)).toEqual([{ id: "c", refundedCents: 10000, refundPendingCents: 0, fullyRefunded: true, status: "refunded" }]);
  });

  it("gives a refund Stripe attributes to a row to that row before settling council first", () => {
    const two = [
      { id: "c", slate: "council" as const, amountCents: 142970, refundedCents: 0, refundPendingCents: 2000 },
      { id: "sb", slate: "school_board" as const, amountCents: 142970, refundedCents: 0, refundPendingCents: 3000, confirmedCents: 3000 },
    ];
    expect(allocateRefund(two, 3000)).toEqual([{ id: "sb", refundedCents: 3000, refundPendingCents: 0, fullyRefunded: false, status: null }]);
    expect(allocateRefund(two, 5000)).toEqual([
      { id: "c", refundedCents: 2000, refundPendingCents: 0, fullyRefunded: false, status: null },
      { id: "sb", refundedCents: 3000, refundPendingCents: 0, fullyRefunded: false, status: null },
    ]);
  });

  it("marks a row refunded only when nothing of it is left", () => {
    const one = [{ id: "c", slate: "council" as const, amountCents: 5000, refundedCents: 0 }];
    expect(allocateRefund(one, 4999)).toEqual([{ id: "c", refundedCents: 4999, ...settled, fullyRefunded: false, status: null }]);
    expect(allocateRefund(one, 5000)).toEqual([{ id: "c", refundedCents: 5000, ...settled, fullyRefunded: true, status: "refunded" }]);
  });

  it("never allocates more than the rows hold, and nothing for a smaller figure than recorded", () => {
    const one = [{ id: "c", slate: "council" as const, amountCents: 5000, refundedCents: 5000 }];
    expect(allocateRefund(one, 9000)).toEqual([]);
    expect(allocateRefund(one, 100)).toEqual([]);
  });
});

describe("recurringStatusFor", () => {
  it("cancels gifts Stripe has stopped collecting on and keeps past_due active", () => {
    expect(recurringStatusFor("canceled")).toBe("cancelled");
    expect(recurringStatusFor("unpaid")).toBe("cancelled");
    expect(recurringStatusFor("paused")).toBe("cancelled");
    expect(recurringStatusFor("past_due")).toBe("active");
    expect(recurringStatusFor("active")).toBe("active");
    expect(recurringStatusFor("something_new")).toBeNull();
  });

  it("cancels a gift that will take no further payment, and brings it back when the donor changes their mind", () => {
    expect(recurringStatusFor("active", true)).toBe("cancelled");
    expect(recurringStatusFor("trialing", true)).toBe("cancelled");
    expect(recurringStatusFor("past_due", true)).toBe("cancelled");
    expect(recurringStatusFor("active", false)).toBe("active");
    expect(recurringStatusFor("past_due", false)).toBe("active");
    expect(recurringStatusFor("incomplete", true)).toBeNull();
  });
});

describe("subscriptionEndsBeforeNextPayment", () => {
  const periodEnd = 1_800_000_000;

  it("is true when the donor cancels at the end of the period already paid for", () => {
    expect(subscriptionEndsBeforeNextPayment({ cancelAtPeriodEnd: true, cancelAt: null, periodEnd })).toBe(true);
    expect(subscriptionEndsBeforeNextPayment({ cancelAtPeriodEnd: true })).toBe(true);
  });

  it("is true when Stripe cancels on or before the next payment is due", () => {
    expect(subscriptionEndsBeforeNextPayment({ cancelAtPeriodEnd: false, cancelAt: periodEnd, periodEnd })).toBe(true);
    expect(subscriptionEndsBeforeNextPayment({ cancelAtPeriodEnd: false, cancelAt: periodEnd - 3600, periodEnd })).toBe(true);
  });

  it("keeps reserving while further payments will still happen", () => {
    expect(subscriptionEndsBeforeNextPayment({ cancelAtPeriodEnd: false, cancelAt: periodEnd + 86400 * 40, periodEnd })).toBe(false);
    expect(subscriptionEndsBeforeNextPayment({ cancelAtPeriodEnd: false, cancelAt: null, periodEnd })).toBe(false);
    // Without the period end we can't tell, so the gift keeps its room (the webhook backstop covers the rest).
    expect(subscriptionEndsBeforeNextPayment({ cancelAtPeriodEnd: false, cancelAt: periodEnd, periodEnd: null })).toBe(false);
  });
});

describe("allocatePayment (recording what a monthly invoice actually collected)", () => {
  const superstar = { council: 11900, school_board: 11900 };

  it("records the gift's amounts when the invoice was paid in full", () => {
    expect(allocatePayment(superstar, 23800)).toEqual(superstar);
    expect(allocatePayment({ council: 2500 }, 2500)).toEqual({ council: 2500 });
  });

  it("shares a smaller payment in proportion, with rounding cents going to council first", () => {
    expect(allocatePayment(superstar, 11900)).toEqual({ council: 5950, school_board: 5950 });
    expect(allocatePayment(superstar, 11901)).toEqual({ council: 5951, school_board: 5950 });
    expect(allocatePayment({ council: 3000, school_board: 1000 }, 999)).toEqual({ council: 750, school_board: 249 });
    expect(allocatePayment({ council: 2500 }, 1250)).toEqual({ council: 1250 });
  });

  it("never records more than was paid, and nothing for a payment of nothing", () => {
    for (const paid of [1, 2, 3, 777, 12345, 23799]) {
      const out = allocatePayment(superstar, paid);
      expect((out.council ?? 0) + (out.school_board ?? 0)).toBe(paid);
      expect(out.council ?? 0).toBeGreaterThanOrEqual(out.school_board ?? 0);
    }
    expect(allocatePayment(superstar, 1)).toEqual({ council: 1 });
    expect(allocatePayment(superstar, 0)).toEqual({});
    expect(allocatePayment(superstar, -5)).toEqual({});
    expect(allocatePayment({}, 1000)).toEqual({});
  });

  it("records the money actually received when it is more than the gift's amounts", () => {
    expect(allocatePayment(superstar, 30000)).toEqual({ council: 15000, school_board: 15000 });
  });
});

describe("membershipTerm", () => {
  const now = new Date("2026-11-02T18:00:00Z");

  it("starts a first membership now and runs it for a year", () => {
    expect(membershipTerm(null, now)).toEqual({ startsAt: now, expiresAt: new Date("2027-11-02T18:00:00Z") });
  });

  it("extends an active membership from when it ends, however far off", () => {
    const expiry = new Date("2027-06-01T07:00:00Z");
    expect(membershipTerm(expiry, now)).toEqual({ startsAt: expiry, expiresAt: new Date("2028-06-01T07:00:00Z") });
  });

  it("ignores an expiry already in the past", () => {
    expect(membershipTerm(new Date("2026-01-01T08:00:00Z"), now).startsAt).toEqual(now);
  });
});

describe("overLimitMessage", () => {
  it("names the limit and the slate but never what this person has given", () => {
    expect(overLimitMessage("school_board", LIMIT)).toBe(
      "That would take you over this year's $1,429.70 contribution limit for our school board slate. Try a smaller amount, or email hello@imaginesurrey.ca if you think this is a mistake.",
    );
    expect(overLimitMessage("council", LIMIT)).toContain("for our city council slate.");
  });
});

describe("publicFormContext", () => {
  const request = (headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost/api/membership", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

  it("takes source and ref from the body first, then the tracking cookie", () => {
    const req = request({ cookie: "other=1; is_track=ref%3DCOOKIE1%26source%3Dcookie-src", "x-forwarded-for": "10.1.2.3, 10.0.0.1", "user-agent": "test-agent" });
    expect(publicFormContext(req, { source: "flyer", ref: "BODYREF1" })).toEqual({ tracking: { ref: "BODYREF1", source: "flyer" }, meta: { ip: "10.1.2.3", userAgent: "test-agent" } });
    expect(publicFormContext(req, {}).tracking).toEqual({ ref: "COOKIE1", source: "cookie-src" });
  });

  it("ignores values that aren't safe tags", () => {
    expect(publicFormContext(request(), { source: "<script>", ref: 12 }).tracking).toEqual({ ref: null, source: null });
  });
});

describe("membershipFeeReturnedEmail", () => {
  const ctx = { siteUrl: "https://example.org", orgName: "Imagine Surrey", orgEmail: "hello@imaginesurrey.ca" };

  it("tells the payer the fee went back and how to sort it out, without any amounts, and escapes their name", () => {
    const message = membershipFeeReturnedEmail(ctx, { firstName: "A<b>" });
    expect(message.subject).toBe("About your Imagine Surrey membership");
    expect(message.html).toContain("A&lt;b&gt;");
    expect(message.html).not.toContain("A<b>");
    expect(message.html).toContain("mailto:hello@imaginesurrey.ca");
    expect(message.html).toContain("refunded your fee in full");
    expect(message.html).not.toMatch(/\$\d/);
    expect(message.text).toContain("hello@imaginesurrey.ca");
    expect(message.text).toContain("refunded your fee in full");
    expect(message.text).not.toMatch(/\$\d/);
  });

  it("greets someone without a first name on file", () => {
    expect(membershipFeeReturnedEmail(ctx, { firstName: " " }).text).toMatch(/^Hi, thanks for joining/m);
  });
});

describe("membershipMinimums (from the environment)", () => {
  const set = (fee: string | undefined, youth: string | undefined) => {
    vi.stubEnv("MEMBERSHIP_FEE_CENTS", fee as string);
    vi.stubEnv("MEMBERSHIP_YOUTH_MIN_CENTS", youth as string);
  };

  it("defaults to $10, and $5 for youth members", () => {
    set(undefined, undefined);
    expect(membershipMinimums()).toEqual({ standardCents: 1000, youthCents: 500 });
    vi.unstubAllEnvs();
  });

  it("makes MEMBERSHIP_FEE_CENTS the minimum and halves it for youth", () => {
    set("2000", "");
    expect(membershipMinimums()).toEqual({ standardCents: 2000, youthCents: 1000 });
    vi.unstubAllEnvs();
  });

  it("takes MEMBERSHIP_YOUTH_MIN_CENTS when it is set", () => {
    set("1000", "300");
    expect(membershipMinimums()).toEqual({ standardCents: 1000, youthCents: 300 });
    vi.unstubAllEnvs();
  });

  it("keeps free membership free", () => {
    set("0", "500");
    expect(membershipMinimums()).toEqual({ standardCents: 0, youthCents: 0 });
    vi.unstubAllEnvs();
  });
});
