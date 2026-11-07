import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { json, parseBody } from "@/lib/server/api";
import { handle } from "@/lib/server/handle";
import { createOrderCheckout } from "@/lib/server/payments";
import { cartSchema } from "@/lib/validation";

// No human check here (unlike the sign-up forms): this route only starts a
// Stripe Checkout, and Stripe screens the payment itself. A puzzle in front
// of the payment page would cost an order for nothing.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, cartSchema, "shop");
    if (!parsed.ok) return parsed.response;
    return json(await createOrderCheckout(getDb(), parsed.data));
  });
}
