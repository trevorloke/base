// Transactional email builders shared across features. Feature code may add
// its own builders in its own file; keep these generic.
import { button, esc, layout, paragraph, textVersion } from "./templates";

export type MessageContext = { siteUrl: string; orgName: string; orgEmail: string };

export function adminMagicLinkEmail(ctx: MessageContext, link: string, minutes: number) {
  const subject = `Your ${ctx.orgName} admin sign-in link`;
  const bodyHtml = paragraph(`Click the button to sign in to the ${esc(ctx.orgName)} admin. The link works once and expires in ${minutes} minutes.`) + button(link, "Sign in", "navy") + paragraph(`If you didn't ask for this, you can ignore this email.`);
  return {
    subject,
    html: layout({ title: "Sign in to the admin", bodyHtml, siteUrl: ctx.siteUrl, orgName: ctx.orgName, orgEmail: ctx.orgEmail }),
    text: textVersion([`Sign in to the ${ctx.orgName} admin (link works once, expires in ${minutes} minutes):`, link], { orgName: ctx.orgName }),
  };
}

export function memberMagicLinkEmail(ctx: MessageContext, link: string, minutes: number) {
  const subject = `Your ${ctx.orgName} sign-in link`;
  const bodyHtml = paragraph(`Click the button to open your ${esc(ctx.orgName)} account. The link works once and expires in ${minutes} minutes.`) + button(link, "Open my account") + paragraph(`If you didn't ask for this, you can ignore this email.`);
  return {
    subject,
    html: layout({ title: "Your sign-in link", bodyHtml, siteUrl: ctx.siteUrl, orgName: ctx.orgName, orgEmail: ctx.orgEmail, reason: "You asked for a sign-in link on our website." }),
    text: textVersion([`Open your ${ctx.orgName} account (link works once, expires in ${minutes} minutes):`, link], { orgName: ctx.orgName }),
  };
}

export function newsletterConfirmEmail(ctx: MessageContext, link: string) {
  const subject = `Confirm your ${ctx.orgName} newsletter`;
  const bodyHtml = paragraph(`One click and you're on the list for news and events from around Surrey.`) + button(link, "Confirm my subscription") + paragraph(`If you didn't sign up, ignore this email and nothing more will be sent.`);
  return {
    subject,
    html: layout({ title: "Confirm your subscription", bodyHtml, siteUrl: ctx.siteUrl, orgName: ctx.orgName, orgEmail: ctx.orgEmail, reason: "Someone entered this address on our website." }),
    text: textVersion([`Confirm your ${ctx.orgName} newsletter subscription:`, link, "", "If you didn't sign up, ignore this email."], { orgName: ctx.orgName }),
  };
}
