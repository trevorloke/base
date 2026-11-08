// Starter pages: a privacy policy and an accessibility statement. Loaded by
// the seed script (register this file's `seed` in scripts/seed.ts); both are
// drafts for the organization to review and finish in /admin/pages.
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sitePages } from "../../../lib/db/schema";

const PRIVACY = `> **Draft for review.** This policy was prepared as a starting point for Imagine Surrey's board. Have it reviewed before publishing, fill in the contact details, and keep it current when the way we handle information changes.

Imagine Surrey is an elector organization registered in British Columbia. This policy explains what personal information we collect, why we collect it, how we protect it, and the choices you have. It follows BC's *Personal Information Protection Act* (PIPA), and where the *Local Elections Campaign Financing Act* (LECFA) requires us to disclose information, we say so.

## What we collect

We collect only what we need for the purpose you give it to us for.

- **Members:** your name, address, postal code, neighbourhood, date of birth, citizenship status, email address and, if you share them, your phone number, languages, campus and the issues you care about. Membership requires that you are eligible under our bylaws and BC law, which is why we ask about age, residence and status.
- **Donors:** your name, address, email, the amount and date of each contribution, and your confirmation that you are eligible to contribute under LECFA. Payment card details go directly to our payment processor, Stripe; we never see or store your full card number.
- **Petition and pledge signers:** your name, email, postal code and, if you give them, your address, phone number and your answer to the optional question.
- **Newsletter subscribers:** your email address and where you signed up.
- **Event guests and volunteers:** your name, email, the events you RSVP to, how many guests you bring, whether you checked in, and the volunteer shifts you take.
- **Shoppers:** your name, email, shipping address and what you ordered.
- **Website visitors:** we count visits ourselves, in our own database, with no cookie and no third-party script. For each page view we keep the page, the site that linked to it (just its name, such as facebook.com), the campaign tag on the link if there was one, and a code that tells one day's visitors apart. That code is made from your IP address and browser type mixed with a random value that changes every day and is deleted after a day, so it can't be traced back to you or linked across days. **We never store your IP address or browser details**, and we don't use these counts to identify anyone. Only our staff see the totals. Our hosting provider also keeps short-lived server logs, including IP addresses, to keep the site running and secure.

## Why we collect it

- To run the organization: process memberships, keep the member roll, hold votes and meetings, and tell members what is happening.
- To comply with the law: LECFA requires us to record every contribution with the contributor's name and address and to report contributions to Elections BC. **Contributions of more than $100 in a year are published by Elections BC with the contributor's name and amount.**
- To deliver what you asked for: a newsletter, an RSVP confirmation, a text about a shift, a reminder about an event, or merchandise you ordered.
- To organize: to understand which neighbourhoods and issues our supporters care about, and to invite you to events and actions near you.
- To keep the site working and secure.

## Consent

We ask for your consent when we collect information, and we tell you what it is for. Each form explains what you are signing up for.

- We send email only to people who ticked the box asking for it, and every bulk email carries an unsubscribe link.
- We send text messages only to people who gave express consent to texts. Reply STOP at any time to opt out.
- You may withdraw consent at any time by contacting us or using the unsubscribe links, subject to legal requirements (for example, we must keep contribution records even after you stop hearing from us).

## Who we share it with

We do not sell, rent or trade personal information. We share it only with the service providers who help us run the organization, and only as much as each needs:

- **Stripe** processes payments for memberships, donations and the shop. Stripe receives your name, email, address and payment details under its own privacy policy.
- **Resend** delivers our email.
- **Twilio** delivers our text messages.
- **Supabase** hosts our database and stored images.
- **Render** hosts the website.
- **Cloudflare (Turnstile)** checks that our sign-up forms are filled in by a person and not a bot. When you use one, it sees your IP address and technical details about your browser and device. It doesn't use them for advertising, and most people never see a puzzle.
- **Analytics:** none. We count visits ourselves (see "Website visitors" above). If we ever add an outside analytics service, we will name it here before it is switched on.

Sign-ups from this website (petitions, pledges, the newsletter, volunteer shifts and memberships) are also copied into our own organizing database, Base Ground, so organizers have one record for each supporter: your name, contact details and what you signed up for. We also tell Base Ground when you RSVP to an event, buy from the shop or follow a promise (as a short label, never what you paid), when you change your details in your supporter account, and when you unsubscribe or text STOP, so you stop hearing from us everywhere at once. Our newsletters and group texts are sent from Base Ground; this website sends only receipts, confirmations and reminders. Payment details are never sent to Base Ground; our treasurer records contributions there by hand.

Some of these providers store data outside Canada, including in the United States, where it may be subject to the laws of that country. We also disclose information when the law requires it: contribution records to Elections BC, and information requested under a valid legal order.

Board members and staff who need personal information to do their work have access to it, and they are bound by this policy.

## How long we keep it

- Contribution and membership fee records: as long as LECFA and the *Income Tax Act* require, which is at least five years after the election period they relate to.
- Membership records: while your membership is active and for two years afterwards, so you can renew and so we can answer questions about past votes.
- Petition and pledge signatures: until the campaign ends and its results have been delivered, then for up to two years.
- Newsletter and text subscriptions: until you unsubscribe. We keep a record that you unsubscribed so we do not contact you again by mistake.
- Event and shift records: two years.
- Visit counts: 13 months, then deleted. The daily random value used to tell visitors apart is deleted after one day.
- Our hosting provider's server logs: as set by the provider, typically a few weeks.

When we no longer need information, we delete it or remove anything that identifies you.

## How we protect it

Our website and database are encrypted in transit and at rest. Access to supporter records is limited to staff accounts with individual logins, and every change made in our administration tools is logged. Payment details are handled entirely by Stripe. We review who has access regularly and remove accounts that are no longer needed.

## Your rights

Under PIPA you may ask us:

- what personal information we hold about you, and how we have used and disclosed it;
- to correct information that is inaccurate or incomplete;
- to stop contacting you, or to delete information we do not need to keep by law.

We will respond within 30 business days. If we cannot give you something you asked for, we will tell you why. If you are not satisfied with our response, you may contact the Office of the Information and Privacy Commissioner for British Columbia.

## Children

Membership is open to people aged 14 and over, in line with our bylaws. We do not knowingly collect personal information from anyone younger.

## Changes to this policy

We will post changes here and update the date below. Significant changes will be announced to members by email.

## How to contact us

Our privacy officer is responsible for this policy and for answering questions about your information.

- Email: hello@imaginesurrey.ca
- Mail: Imagine Surrey, [mailing address to confirm], Surrey, BC

*Last reviewed: [date to confirm].*`;

const ACCESSIBILITY = `Imagine Surrey wants everyone in Surrey to be able to read this site, join, donate, sign a petition and come to an event, whatever device or assistive technology they use.

## Our aim

We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA. In practice that means:

- every image that carries meaning has a text description;
- every page can be used with a keyboard alone, with a visible focus indicator;
- text and background colours meet the AA contrast ratio;
- forms label every field and announce errors to screen readers;
- the site works at 400% zoom and on a phone without sideways scrolling;
- nothing flashes, and moving content can be paused;
- pages are organized with headings and landmarks so you can jump around them.

We test with keyboard navigation, screen readers and automated checks, and we fix problems as we find them.

## Known limitations

- PDF documents linked from this site, such as the platform, may not be fully accessible. Ask us for the information in another format.
- Content embedded from social media sites is controlled by those services.

## Report a barrier

If something on this site is hard to use, tell us. Say which page it was, what you were trying to do and, if you can, which browser or assistive technology you were using. We will reply within five business days and fix what we can.

- Email: hello@imaginesurrey.ca
- Or use the contact details in the footer of every page.

If you need information from this site in a different format, such as large print or plain text, ask and we will provide it.

*Last reviewed: [date to confirm].*`;

export const seedPages = [
  {
    slug: "privacy",
    title: "Privacy policy",
    summary: "What personal information Imagine Surrey collects, why, who sees it, how long we keep it, and your rights under BC's Personal Information Protection Act.",
    body: PRIVACY,
    published: true,
    showInFooter: true,
  },
  {
    slug: "accessibility",
    title: "Accessibility",
    summary: "Our aim is WCAG 2.2 AA. How to report a barrier and get information in another format.",
    body: ACCESSIBILITY,
    published: true,
    showInFooter: false,
  },
];

/**
 * The same drafts for another organization: its name, email and mailing line
 * in place of Imagine Surrey's. Still drafts for its own board to review.
 */
export function pagesFor(org: { name: string; email: string; placeLine: string }): typeof seedPages {
  const swap = (text: string) =>
    text
      .replaceAll("hello@imaginesurrey.ca", org.email)
      .replaceAll("everyone in Surrey", "everyone")
      .replaceAll(", Surrey, BC", `, ${org.placeLine || "[city and province to confirm]"}`)
      .replaceAll("Imagine Surrey", org.name);
  return seedPages.map((p) => ({ ...p, summary: swap(p.summary), body: swap(p.body) }));
}

/** Add the starter pages. Existing pages with the same address are left alone. */
export async function seed(db: Pick<PostgresJsDatabase<Record<string, unknown>>, "insert">, pages = seedPages): Promise<void> {
  await db.insert(sitePages).values(pages).onConflictDoNothing({ target: sitePages.slug });
}
