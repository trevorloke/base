import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { json, parseBody } from "@/lib/server/api";
import { handle } from "@/lib/server/handle";
import { createDonationCheckout, publicFormContext } from "@/lib/server/payments";
import { donationSchema } from "@/lib/validation";

// No human check here (unlike the sign-up forms): this route only starts a
// Stripe Checkout, and Stripe screens the payment itself. A puzzle in front
// of the payment page would cost a gift for nothing.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, donationSchema, "donations");
    if (!parsed.ok) return parsed.response;
    return json(await createDonationCheckout(getDb(), parsed.data, publicFormContext(req, parsed.data)));
  });
}
