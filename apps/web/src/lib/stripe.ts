import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

let client: Stripe | undefined;

export function getStripe(): Stripe {
  // STRIPE_API_BASE points the SDK at stripe-mock or another local stand-in for testing.
  const base = process.env.STRIPE_API_BASE ? new URL(process.env.STRIPE_API_BASE) : undefined;
  client ??= new Stripe(env.stripeSecretKey, {
    appInfo: { name: "imagine-surrey-web" },
    ...(base && { host: base.hostname, port: Number(base.port), protocol: base.protocol.replace(":", "") as "http" | "https" }),
  });
  return client;
}

export type { Stripe };
