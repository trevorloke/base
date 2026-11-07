import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { twiml, twilioSignatureMatches } from "@/lib/email/inbound-sms";
import { handleInboundSms } from "@/lib/server/comms";
import { emailContext } from "@/lib/server/email";
import { getSettings } from "@/lib/server/settings";

// Twilio posts every text sent to our number here. Point the number's
// "A message comes in" webhook at https://<site>/api/sms/inbound (POST).
// With TWILIO_AUTH_TOKEN set, the X-Twilio-Signature header is checked
// against the URL as Twilio sees it and as the site is configured.
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return new Response("Expected a form body.", { status: 400 });
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") params[key] = value;

  const authToken = env.twilioAuthToken;
  if (authToken) {
    const asSeen = req.url;
    const asConfigured = `${env.siteUrl}${req.nextUrl.pathname}${req.nextUrl.search}`;
    if (!twilioSignatureMatches(authToken, req.headers.get("x-twilio-signature"), [asSeen, asConfigured], params)) {
      return new Response("Bad signature.", { status: 403 });
    }
  }

  const from = params.From ?? "";
  const body = params.Body ?? "";
  if (!from) return new Response("Missing From.", { status: 400 });

  const ctx = await emailContext();
  let orgPhone: string | undefined;
  try {
    orgPhone = (await getSettings()).org.phone || undefined;
  } catch {
    orgPhone = undefined;
  }
  try {
    const { reply } = await handleInboundSms(getDb(), { ...ctx, orgPhone }, { from, body, messageSid: params.MessageSid ?? null });
    return new Response(twiml(reply), { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
  } catch (err) {
    console.error("inbound SMS failed", err);
    // Twilio retries on errors; answer with an empty TwiML instead so the sender isn't spammed.
    return new Response(twiml(null), { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
  }
}
