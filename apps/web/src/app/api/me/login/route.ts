import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { memberMagicLinkEmail } from "@/lib/email/messages";
import { safeMemberNext } from "@/lib/engagement";
import { env } from "@/lib/env";
import { error, json, keyRateLimited, parseBody, rateLimited } from "@/lib/server/api";
import { sendEmail } from "@/lib/server/email";
import { handle } from "@/lib/server/handle";
import { findPersonByEmail } from "@/lib/server/people";
import { getSettings } from "@/lib/server/settings";
import { createToken, tokenUrl } from "@/lib/server/tokens";

const LINK_MINUTES = 30;

const schema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address")),
    next: z.string().max(500).optional(),
    website: z.string().max(0).optional(),
  })
  .strict();

/**
 * Ask for a sign-in link. The answer is {ok:true} whether or not the address
 * has an account, so the form can't be used to find out who is a supporter:
 * the lookup and the email happen after the response, so neither timing nor a
 * mail failure gives it away. Limited per IP and per address.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    // Five requests a minute per address: tighter than the usual form limit.
    if (rateLimited(req, "member-login", 5)) return error("Too many requests. Please wait a minute and try again.", 429);
    const parsed = await parseBody(req, schema, "member-login-body", { human: true });
    if (!parsed.ok) return parsed.response;
    const { email } = parsed.data;
    // Five links an hour per address, whichever IPs ask: no flooding someone's inbox.
    if (keyRateLimited(`member-login-email:${email}`, 5, 60 * 60_000)) return error("Too many sign-in links were asked for. Please wait an hour and try again.", 429);
    const next = safeMemberNext(parsed.data.next);
    after(async () => {
      try {
        const db = getDb();
        const person = await findPersonByEmail(db, email);
        if (!person) return;
        const raw = await createToken(db, "member-login", email, { ttlMinutes: LINK_MINUTES, data: { next } });
        const link = new URL(tokenUrl("/me/verify", raw));
        link.searchParams.set("next", next);
        const { org } = await getSettings();
        const message = memberMagicLinkEmail({ siteUrl: env.siteUrl, orgName: org.name, orgEmail: org.email }, link.toString(), LINK_MINUTES);
        await sendEmail(db, { to: email, kind: "member-magic-link", personId: person.id, ...message });
      } catch (err) {
        console.error("member sign-in link failed", err);
      }
    });
    return json({ ok: true });
  });
}
