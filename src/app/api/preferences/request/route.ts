import { after, type NextRequest } from "next/server";
import { preferencesLinkEmail } from "@/app/preferences/email";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { json, parseBody } from "@/lib/server/api";
import { sendEmail } from "@/lib/server/email";
import { handle } from "@/lib/server/handle";
import { findPersonByEmail } from "@/lib/server/people";
import { getSettings } from "@/lib/server/settings";
import { createToken, tokenUrl } from "@/lib/server/tokens";
import { preferencesRequestSchema } from "@/lib/validation";

const TTL_MINUTES = 60;

/**
 * "Send me a link": public, always answers {ok:true} so it never reveals
 * whether an address is on file. When it is, a one-time preferences link
 * goes out after the response is sent.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, preferencesRequestSchema, "preferences", { human: true });
    if (!parsed.ok) return parsed.response;
    const email = parsed.data.email;
    after(async () => {
      try {
        const db = getDb();
        const person = await findPersonByEmail(db, email);
        if (!person) return;
        const raw = await createToken(db, "preferences", person.email, { ttlMinutes: TTL_MINUTES });
        const settings = await getSettings();
        const message = preferencesLinkEmail({ siteUrl: env.siteUrl, orgName: settings.org.name, orgEmail: settings.org.email }, tokenUrl("/preferences", raw), TTL_MINUTES);
        await sendEmail(db, { to: person.email, subject: message.subject, html: message.html, text: message.text, kind: "preferences-link", personId: person.id });
      } catch (err) {
        console.error("preferences link failed", err);
      }
    });
    return json({ ok: true });
  });
}
