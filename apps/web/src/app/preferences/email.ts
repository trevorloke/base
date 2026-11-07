// The one-time link email for the preference centre.
import type { MessageContext } from "@/lib/email/messages";
import { button, esc, layout, paragraph, textVersion } from "@/lib/email/templates";

export function preferencesLinkEmail(ctx: MessageContext, link: string, minutes: number) {
  const subject = `Your ${ctx.orgName} email and text preferences`;
  const bodyHtml =
    paragraph(`Use the button to choose what ${esc(ctx.orgName)} sends you: email updates, texts, and the language you prefer.`) +
    button(link, "Open my preferences", "navy") +
    paragraph(`The link works once and expires in ${minutes} minutes. If you didn’t ask for it, ignore this email: nothing changes.`);
  return {
    subject,
    html: layout({
      title: "Your preferences",
      bodyHtml,
      siteUrl: ctx.siteUrl,
      orgName: ctx.orgName,
      orgEmail: ctx.orgEmail,
      reason: "Someone asked for a preferences link for this address on our website.",
    }),
    text: textVersion([`Choose what ${ctx.orgName} sends you (link works once, expires in ${minutes} minutes):`, link, "", "If you didn’t ask for this, ignore this email: nothing changes."], {
      orgName: ctx.orgName,
    }),
  };
}
