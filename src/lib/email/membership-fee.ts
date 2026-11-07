// Sent when a membership fee is returned because it would take the payer over
// this year's contribution limit. The membership form gives everyone the same
// answer, so this email is the only place that says so, and it goes only to
// the person who paid. No amounts: what they have given is their business.
import type { MessageContext } from "./messages";
import { esc, layout, paragraph, textVersion } from "./templates";

export function membershipFeeReturnedEmail(ctx: MessageContext, member: { firstName: string }) {
  const subject = `About your ${ctx.orgName} membership`;
  const name = member.firstName.trim();
  const greeting = `${name ? `Hi ${name}` : "Hi"}, thanks for joining ${ctx.orgName}.`;
  const why =
    "Membership fees count as political contributions under BC law, and under this year's contribution limit we can't take a membership fee from you this calendar year. We've refunded your fee in full, so your membership hasn't started. The refund can take 5 to 10 business days to reach your card.";
  const next = (email: string) => `Reply to this email, or write to ${email}, and we'll sort out your membership.`;
  const bodyHtml =
    paragraph(esc(greeting)) +
    paragraph(esc(why)) +
    paragraph(`Reply to this email, or write to <a href="mailto:${esc(ctx.orgEmail)}">${esc(ctx.orgEmail)}</a>, and we'll sort out your membership.`);
  return {
    subject,
    html: layout({
      title: "About your membership",
      bodyHtml,
      siteUrl: ctx.siteUrl,
      orgName: ctx.orgName,
      orgEmail: ctx.orgEmail,
      reason: "You paid a membership fee on our website.",
    }),
    text: textVersion([greeting, "", why, "", next(ctx.orgEmail)], { orgName: ctx.orgName }),
  };
}
