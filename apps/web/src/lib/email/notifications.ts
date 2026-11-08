// Builders for the emails and texts the site sends after a supporter does
// something: joining, giving, signing, RSVPing, taking a shift, and the
// reminders that follow. Pure functions: the hooks in
// src/lib/server/notifications.ts load the data and call these.
import { formatCents } from "@/lib/money";
import { formatDate, formatEventTime, timeOnly } from "@/lib/dates";
import { googleCalendarUrl, icsCalendar, pacificDate, SLOT_HOURS, type IcsEvent } from "@/lib/ics";
import { shareLinks, withRef, type ShareLinks } from "@/lib/share";
import { STATUS_BY_ID, type PromiseStatus } from "@/lib/tracker";
import type { MessageContext } from "./messages";
import { button, esc, layout, paragraph, textVersion } from "./templates";
import { clientProfile } from "@/seeds/client";
import { jurisdiction } from "@/lib/jurisdiction";

export type EmailAttachment = { filename: string; /** base64 */ content: string; contentType?: string };
export type BuiltEmail = { subject: string; html: string; text: string; attachments?: EmailAttachment[] };

export const STOP_LINE = "Reply STOP to opt out";

type Slate = "council" | "school_board";
const SLATE_LABEL: Record<Slate, string> = { council: "city council slate", school_board: "school board slate" };

const greet = (first: string | null | undefined) => (first ? `Hi ${esc(first)},` : "Hi there,");
const heading = (text: string) => `<h2 style="margin:24px 0 10px;font-size:19px;line-height:1.3;color:#003979">${esc(text)}</h2>`;
const bullets = (items: string[]) => `<ul style="margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.55;color:#0F1E33">${items.map((i) => `<li style="margin:0 0 6px">${i}</li>`).join("")}</ul>`;
const link = (url: string, label: string) => `<a href="${esc(url)}" style="color:#003979;font-weight:700">${esc(label)}</a>`;

/** "Share with a neighbour": WhatsApp first, then text, email and the bare link. */
export function shareBlock(title: string, links: ShareLinks): { html: string; text: string[] } {
  const html =
    heading(title) +
    paragraph(`${link(links.whatsapp, "WhatsApp")} &nbsp;·&nbsp; ${link(links.sms, "Text message")} &nbsp;·&nbsp; ${link(links.email, "Email")}`) +
    paragraph(`Or copy your link: ${link(links.copy, links.copy)}`);
  return { html, text: [title, `Your link: ${links.copy}`] };
}

function icsAttachment(filename: string, event: IcsEvent): EmailAttachment {
  return { filename, content: Buffer.from(icsCalendar([event]), "utf8").toString("base64"), contentType: "text/calendar" };
}

const ICS_DOMAIN = clientProfile.uidDomain;

export function eventToIcs(ctx: MessageContext, event: { id: string; slug: string; title: string; startsAt: Date; endsAt?: Date | null; location: string; address?: string | null; summary: string }): IcsEvent {
  return {
    uid: `event-${event.id}@${ICS_DOMAIN}`,
    title: event.title,
    start: event.startsAt,
    end: event.endsAt ?? undefined,
    location: [event.location, event.address].filter(Boolean).join(", "),
    description: event.summary,
    url: `${ctx.siteUrl}/events/${event.slug}`,
  };
}

// ── Membership ────────────────────────────────────────────────────────────

export function membershipWelcomeEmail(ctx: MessageContext, m: { firstName?: string | null; expiresAt?: Date | null; votingEligible: boolean; referralCode: string }): BuiltEmail {
  const org = ctx.orgName;
  const subject = m.firstName ? `Welcome to ${org}, ${m.firstName}!` : `Welcome to ${org}!`;
  const until = m.expiresAt ? formatDate(m.expiresAt) : null;
  const portal = `${ctx.siteUrl}/me`;
  const joinLink = withRef(`${ctx.siteUrl}/#join`, m.referralCode);
  const share = shareBlock("Bring a neighbour", shareLinks({ url: joinLink, text: `I just joined ${org}, residents organizing for a City Hall that gets the basics right. Join me:`, subject: `Join me in ${org}` }));

  const bodyHtml =
    paragraph(greet(m.firstName)) +
    paragraph(`Thanks for joining ${esc(org)}. You're one of the residents making sure City Hall gets the basics right.`) +
    paragraph(until ? `Your membership runs until <strong>${esc(until)}</strong>. ` : "") +
    paragraph(m.votingEligible ? `As a member you have a vote at member meetings and a say in what we stand for.` : `Because you live outside ${clientProfile.place} you can take part in everything but the votes at member meetings.`) +
    heading("What happens next") +
    bullets([
      `We'll email you about member meetings, your neighbourhood committee and ways to help.`,
      `Watch for events near you on the events page, and bring a friend.`,
      `Keep your details and preferences up to date in your supporter portal.`,
    ]) +
    button(portal, "Open your supporter portal", "navy") +
    share.html +
    heading("Prefer texts?") +
    paragraph(`Turn on text updates in your supporter portal and we'll text you about events near you, never more than a few times a month. Reply STOP at any time to opt out.`);

  const html = layout({ title: `Welcome to ${org}`, bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: "You're getting this because you became a member.", unsubscribeUrl: null });
  const text = textVersion(
    [
      `Thanks for joining ${org}.`,
      until ? `Your membership runs until ${until}.` : "",
      m.votingEligible ? "As a member you have a vote at member meetings." : `Because you live outside ${clientProfile.place} you can take part in everything but the votes at member meetings.`,
      "",
      "What happens next: we'll email you about member meetings, your neighbourhood committee and ways to help.",
      `Your supporter portal: ${portal}`,
      "",
      ...share.text,
      "",
      "Prefer texts? Turn on text updates in your supporter portal. Reply STOP at any time to opt out.",
    ],
    { orgName: org },
  );
  return { subject, html, text };
}

// ── Contributions ─────────────────────────────────────────────────────────

export function donationThanksEmail(ctx: MessageContext, d: { firstName?: string | null; frequency: "one_time" | "monthly"; amounts: Partial<Record<Slate, number>>; refundedOverLimit?: boolean }): BuiltEmail {
  const org = ctx.orgName;
  const monthly = d.frequency === "monthly";
  const subject = monthly ? `Thank you for your monthly gift to ${org}` : `Thank you for chipping in to ${org}`;
  const parts = (Object.keys(d.amounts) as Slate[]).filter((s) => d.amounts[s]).map((s) => `${formatCents(d.amounts[s]!)}${monthly ? " a month" : ""} to the ${SLATE_LABEL[s]}`);
  const amounts = parts.join(" and ");
  const upsell = `${ctx.siteUrl}/donate?frequency=monthly`;

  const bodyHtml =
    paragraph(greet(d.firstName)) +
    paragraph(`Thank you. Your contribution of <strong>${esc(amounts)}</strong> is recorded. It pays for organizers, printing and outreach${clientProfile.places.names.length ? " in every town centre" : ""}.`) +
    paragraph(`Stripe emails your receipt separately. Contributions to an elector organization aren't tax deductible.`) +
    (d.refundedOverLimit ? paragraph(`Any part of a gift over the yearly limit set by ${jurisdiction.authority} is refunded to your card automatically.`) : "") +
    (monthly
      ? paragraph(`${clientProfile.fundName ? `Monthly gifts support the ${clientProfile.fundName}, our war chest for the next election. ` : ""}To change or cancel, email ${link(`mailto:${ctx.orgEmail}`, ctx.orgEmail)}.`)
      : heading("Make it monthly?") + paragraph(`A monthly gift, even a small one, lets us plan ahead${clientProfile.fundName ? ` and builds the ${clientProfile.fundName} for the next election` : ""}.`) + button(upsell, "Give monthly"));

  const html = layout({ title: "Thank you", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: "You're getting this because you made a contribution.", unsubscribeUrl: null });
  const text = textVersion(
    [
      `Thank you. Your contribution of ${amounts} is recorded.`,
      "Stripe emails your receipt separately. Contributions to an elector organization aren't tax deductible.",
      ...(monthly ? [`To change or cancel your monthly gift, email ${ctx.orgEmail}.`] : ["", `Make it monthly: ${upsell}`]),
    ],
    { orgName: org },
  );
  return { subject, html, text };
}

export function recurringStartedEmail(ctx: MessageContext, r: { firstName?: string | null; slateAmounts: Partial<Record<Slate, number>> }): BuiltEmail {
  const org = ctx.orgName;
  const subject = `Your monthly gift to ${org} is set up`;
  const parts = (Object.keys(r.slateAmounts) as Slate[]).filter((s) => r.slateAmounts[s]).map((s) => `${formatCents(r.slateAmounts[s]!)} a month to the ${SLATE_LABEL[s]}`);
  const bodyHtml =
    paragraph(greet(r.firstName)) +
    paragraph(`Thank you. Your monthly gift of <strong>${esc(parts.join(" and "))}</strong> is set up${clientProfile.fundName ? ` and supports the ${clientProfile.fundName}` : ""}.`) +
    paragraph(`Each payment is recorded as a contribution under BC's campaign financing rules, and Stripe emails a receipt every month.`) +
    heading("Changing or cancelling") +
    paragraph(`Email us at ${link(`mailto:${ctx.orgEmail}`, ctx.orgEmail)} any time and we'll change the amount or stop the gift, no questions asked.`);
  const html = layout({ title: "Your monthly gift", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: "You're getting this because you started a monthly gift.", unsubscribeUrl: null });
  const text = textVersion([`Thank you. Your monthly gift of ${parts.join(" and ")} is set up.`, `To change or cancel it, email ${ctx.orgEmail}.`], { orgName: org });
  return { subject, html, text };
}

// ── Shop ──────────────────────────────────────────────────────────────────

export type OrderShipping = { name?: string | null; address?: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null } | null } | null;

export function orderPaidEmail(ctx: MessageContext, o: { firstName?: string | null; items: { name: string; quantity: number; unitPriceCents: number }[]; totalCents: number; shipping: OrderShipping }): BuiltEmail {
  const org = ctx.orgName;
  const subject = `Your ${org} order`;
  const rows = o.items
    .map((i) => `<tr><td style="padding:6px 0;font-size:15px;color:#0F1E33">${i.quantity} × ${esc(i.name)}</td><td align="right" style="padding:6px 0;font-size:15px;color:#0F1E33">${esc(formatCents(i.unitPriceCents * i.quantity))}</td></tr>`)
    .join("");
  const table = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;border-top:1px solid #E3E7EF;border-bottom:1px solid #E3E7EF">${rows}<tr><td style="padding:10px 0;font-weight:700;color:#003979">Total</td><td align="right" style="padding:10px 0;font-weight:700;color:#003979">${esc(formatCents(o.totalCents))}</td></tr></table>`;
  const addr = o.shipping?.address;
  const addressLines = addr ? [o.shipping?.name, addr.line1, addr.line2, [addr.city, addr.state, addr.postal_code].filter(Boolean).join(" ")].filter(Boolean) as string[] : [];
  const bodyHtml =
    paragraph(greet(o.firstName)) +
    paragraph(`Thanks for your order. Here's what you bought:`) +
    table +
    (addressLines.length ? heading("Shipping to") + paragraph(addressLines.map(esc).join("<br>")) : "") +
    paragraph(`Stripe emails your receipt. We'll be in touch when your order is on its way. Questions? Reply to this email.`);
  const html = layout({ title: "Order confirmed", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: "You're getting this because you placed an order.", unsubscribeUrl: null });
  const text = textVersion(
    ["Thanks for your order.", ...o.items.map((i) => `${i.quantity} × ${i.name}: ${formatCents(i.unitPriceCents * i.quantity)}`), `Total: ${formatCents(o.totalCents)}`, ...(addressLines.length ? ["", "Shipping to:", ...addressLines] : [])],
    { orgName: org },
  );
  return { subject, html, text };
}

// ── Petitions and pledges ─────────────────────────────────────────────────

export function signatureEmail(
  ctx: MessageContext,
  s: { firstName: string; lastName?: string | null; campaign: { slug: string; title: string; kind: "petition" | "pledge"; shareText: string; statement: string; targetEmails: string[] }; referralCode: string },
): BuiltEmail {
  const org = ctx.orgName;
  const c = s.campaign;
  const subject = `Thanks for signing: ${c.title}`;
  const url = withRef(`${ctx.siteUrl}/act/${c.slug}`, s.referralCode);
  const shareText = c.shareText || `I signed "${c.title}". Add your name:`;
  const share = shareBlock("Share it with a neighbour", shareLinks({ url, text: shareText, subject: c.title }));
  const name = [s.firstName, s.lastName].filter(Boolean).join(" ");
  const mailto = c.targetEmails.length
    ? `mailto:${c.targetEmails.join(",")}?subject=${encodeURIComponent(c.title)}&body=${encodeURIComponent(`${c.statement || c.title}\n\n${name}\n${clientProfile.place ? `${clientProfile.place} resident` : "Resident"}`)}`
    : null;
  const joinUrl = withRef(`${ctx.siteUrl}/#join`, s.referralCode);
  const donateUrl = `${ctx.siteUrl}/donate`;

  const bodyHtml =
    paragraph(greet(s.firstName)) +
    paragraph(`Thanks for adding your name to <strong>${esc(c.title)}</strong>. ${c.kind === "petition" ? "Every signature makes it harder to ignore." : "Every pledge makes the next election count."}`) +
    share.html +
    (mailto ? heading("Tell council directly") + paragraph(`A short email in your own words carries weight. We've drafted one for you to edit and send.`) + button(mailto, "Email council", "navy") : "") +
    heading("Take the next step") +
    paragraph(`${esc(org)} is residents organizing for a City Hall that gets the basics right. Join as a member, or chip in to keep the work going.`) +
    button(joinUrl, "Become a member") +
    paragraph(link(donateUrl, "Chip in instead"));
  const html = layout({ title: `Thanks for signing`, bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: `You're getting this because you signed ${c.title}.`, unsubscribeUrl: null });
  const text = textVersion(
    [`Thanks for adding your name to ${c.title}.`, "", ...share.text, ...(mailto ? ["", `Email council: ${c.targetEmails.join(", ")}`] : []), "", `Become a member: ${joinUrl}`, `Chip in: ${donateUrl}`],
    { orgName: org },
  );
  return { subject, html, text };
}

// ── Events ────────────────────────────────────────────────────────────────

export type EventForEmail = { id: string; slug: string; title: string; startsAt: Date; endsAt?: Date | null; location: string; address?: string | null; summary: string };

function eventWhenWhere(e: EventForEmail): { when: string; where: string } {
  const when = e.endsAt ? `${formatEventTime(e.startsAt)} to ${timeOnly(e.endsAt)}` : formatEventTime(e.startsAt);
  return { when, where: [e.location, e.address].filter(Boolean).join(", ") };
}

export function rsvpEmail(ctx: MessageContext, r: { name: string; guests: number; event: EventForEmail; referralCode: string }): BuiltEmail {
  const org = ctx.orgName;
  const e = r.event;
  const subject = `You're in: ${e.title}`;
  const { when, where } = eventWhenWhere(e);
  const ics = eventToIcs(ctx, e);
  const google = googleCalendarUrl(ics);
  const eventUrl = withRef(`${ctx.siteUrl}/events/${e.slug}`, r.referralCode);
  const share = shareBlock("Bring a neighbour", shareLinks({ url: eventUrl, text: `Join me at ${e.title} on ${formatDate(e.startsAt)}:`, subject: e.title }));
  const first = r.name.split(/\s+/)[0];

  const bodyHtml =
    paragraph(greet(first)) +
    paragraph(`You're on the list for <strong>${esc(e.title)}</strong>${r.guests ? ` with ${r.guests} guest${r.guests === 1 ? "" : "s"}` : ""}. See you there.`) +
    bullets([`<strong>When:</strong> ${esc(when)}`, `<strong>Where:</strong> ${esc(where)}`]) +
    paragraph(esc(e.summary)) +
    button(google, "Add to Google Calendar", "navy") +
    paragraph(`A calendar file is attached for Apple Calendar and Outlook. ${link(eventUrl, "Event details")}.`) +
    share.html;
  const html = layout({ title: "You're in", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: `You're getting this because you RSVPed to ${e.title}.`, unsubscribeUrl: null });
  const text = textVersion([`You're on the list for ${e.title}.`, `When: ${when}`, `Where: ${where}`, "", `Add to Google Calendar: ${google}`, `Details: ${eventUrl}`, "", ...share.text], { orgName: org });
  return { subject, html, text, attachments: [icsAttachment(`${e.slug}.ics`, ics)] };
}

export function eventReminderEmail(ctx: MessageContext, r: { name: string; guests: number; event: EventForEmail }): BuiltEmail {
  const org = ctx.orgName;
  const e = r.event;
  const subject = `Tomorrow: ${e.title}`;
  const { when, where } = eventWhenWhere(e);
  const google = googleCalendarUrl(eventToIcs(ctx, e));
  const eventUrl = `${ctx.siteUrl}/events/${e.slug}`;
  const bodyHtml =
    paragraph(greet(r.name.split(/\s+/)[0])) +
    paragraph(`A reminder that <strong>${esc(e.title)}</strong> is tomorrow${r.guests ? `, and you're bringing ${r.guests}` : ""}.`) +
    bullets([`<strong>When:</strong> ${esc(when)}`, `<strong>Where:</strong> ${esc(where)}`]) +
    button(eventUrl, "Event details", "navy") +
    paragraph(`${link(google, "Add it to Google Calendar")}. Can't make it after all? Just reply to this email.`);
  const html = layout({ title: "See you tomorrow", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: `You're getting this because you RSVPed to ${e.title}.`, unsubscribeUrl: null });
  const text = textVersion([`Reminder: ${e.title} is tomorrow.`, `When: ${when}`, `Where: ${where}`, `Details: ${eventUrl}`], { orgName: org });
  return { subject, html, text };
}

export function eventReminderText(ctx: MessageContext, e: EventForEmail): string {
  return `${ctx.orgName}: ${e.title} is tomorrow, ${timeOnly(e.startsAt)} at ${e.location}. Details: ${ctx.siteUrl}/events/${e.slug} ${STOP_LINE}`;
}

// ── Volunteer shifts ──────────────────────────────────────────────────────

export type ShiftForEmail = { id: string; date: string; slot: keyof typeof SLOT_HOURS; title: string; location?: string | null; notes?: string | null };

export function shiftWindow(s: Pick<ShiftForEmail, "date" | "slot">): { start: Date; end: Date; label: string } {
  const hours = SLOT_HOURS[s.slot];
  const start = pacificDate(s.date, hours.start);
  const end = pacificDate(s.date, hours.end);
  return { start, end, label: `${formatEventTime(start)} to ${timeOnly(end)}` };
}

function shiftIcs(ctx: MessageContext, s: ShiftForEmail): IcsEvent {
  const { start, end } = shiftWindow(s);
  return { uid: `shift-${s.id}@${ICS_DOMAIN}`, title: `${s.title} (${ctx.orgName} volunteer shift)`, start, end, location: s.location ?? undefined, description: s.notes ?? undefined, url: `${ctx.siteUrl}/me` };
}

export function shiftConfirmationEmail(ctx: MessageContext, r: { firstName?: string | null; shift: ShiftForEmail }): BuiltEmail {
  const org = ctx.orgName;
  const s = r.shift;
  const { label } = shiftWindow(s);
  const subject = `Your volunteer shift: ${s.title}, ${formatDate(shiftWindow(s).start)}`;
  const ics = shiftIcs(ctx, s);
  const bodyHtml =
    paragraph(greet(r.firstName)) +
    paragraph(`Thanks for taking a shift. Here are the details:`) +
    bullets([`<strong>What:</strong> ${esc(s.title)}`, `<strong>When:</strong> ${esc(label)}`, ...(s.location ? [`<strong>Where:</strong> ${esc(s.location)}`] : [])]) +
    (s.notes ? paragraph(esc(s.notes)) : "") +
    button(googleCalendarUrl(ics), "Add to Google Calendar", "navy") +
    paragraph(`A calendar file is attached. We'll send a reminder the day before. Can't make it? Reply to this email so we can fill the spot.`);
  const html = layout({ title: "You're on the team", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: "You're getting this because you signed up for a volunteer shift.", unsubscribeUrl: null });
  const text = textVersion([`Thanks for taking a shift.`, `What: ${s.title}`, `When: ${label}`, ...(s.location ? [`Where: ${s.location}`] : []), ...(s.notes ? ["", s.notes] : [])], { orgName: org });
  return { subject, html, text, attachments: [icsAttachment("shift.ics", ics)] };
}

export function shiftReminderEmail(ctx: MessageContext, r: { firstName?: string | null; shift: ShiftForEmail }): BuiltEmail {
  const org = ctx.orgName;
  const s = r.shift;
  const { label } = shiftWindow(s);
  const subject = `Tomorrow: your ${s.title} shift`;
  const bodyHtml =
    paragraph(greet(r.firstName)) +
    paragraph(`A reminder that your <strong>${esc(s.title)}</strong> shift is tomorrow.`) +
    bullets([`<strong>When:</strong> ${esc(label)}`, ...(s.location ? [`<strong>Where:</strong> ${esc(s.location)}`] : [])]) +
    (s.notes ? paragraph(esc(s.notes)) : "") +
    paragraph(`Can't make it after all? Reply to this email so we can fill the spot.`);
  const html = layout({ title: "See you tomorrow", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: "You're getting this because you signed up for a volunteer shift.", unsubscribeUrl: null });
  const text = textVersion([`Reminder: your ${s.title} shift is tomorrow.`, `When: ${label}`, ...(s.location ? [`Where: ${s.location}`] : [])], { orgName: org });
  return { subject, html, text };
}

export function shiftReminderText(ctx: MessageContext, s: ShiftForEmail): string {
  const { start, end } = shiftWindow(s);
  return `${ctx.orgName}: your ${s.title} shift is tomorrow, ${timeOnly(start)} to ${timeOnly(end)}${s.location ? ` at ${s.location}` : ""}. Can't make it? Email ${ctx.orgEmail}. ${STOP_LINE}`;
}

// ── Promise tracker ───────────────────────────────────────────────────────

export function promiseStatusEmail(ctx: MessageContext, p: { promise: { number: number; title: string }; previous: string; next: string; note?: string | null; unfollowUrl: string }): BuiltEmail {
  const org = ctx.orgName;
  const label = (s: string) => STATUS_BY_ID[s as PromiseStatus]?.label ?? s.replace(/_/g, " ");
  const subject = `Promise #${p.promise.number} is now ${label(p.next).toLowerCase()}`;
  const url = `${ctx.siteUrl}/tracker#promise-${p.promise.number}`;
  const bodyHtml =
    paragraph(`You asked to hear when this promise changes.`) +
    heading(`#${p.promise.number}: ${p.promise.title}`) +
    paragraph(`Status: <strong>${esc(label(p.previous))}</strong> → <strong>${esc(label(p.next))}</strong>`) +
    (p.note ? paragraph(esc(p.note)) : "") +
    button(url, "See the record", "navy") +
    paragraph(`Don't want these any more? ${link(p.unfollowUrl, "Stop following this promise")}.`);
  const html = layout({ title: "A promise changed status", bodyHtml, siteUrl: ctx.siteUrl, orgName: org, orgEmail: ctx.orgEmail, reason: "You're getting this because you followed this promise on our tracker.", unsubscribeUrl: null });
  const text = textVersion([`Promise #${p.promise.number}: ${p.promise.title}`, `Status: ${label(p.previous)} → ${label(p.next)}`, ...(p.note ? ["", p.note] : []), "", `See the record: ${url}`, `Stop following this promise: ${p.unfollowUrl}`], { orgName: org });
  return { subject, html, text };
}
