// The editable content of the public site: one section per key, each with a
// zod schema and a default. The admin edits a section; the public pages read
// the merged result through getSettings(). Adding a section means adding it
// here; the admin form and the database row follow from the schema.
import { z } from "zod";
import { CUSTOM_TONES, DEFAULT_MODULES as ALL_MODULES, MODULE_KINDS } from "@/lib/home-modules";
import { clientSettings } from "@/seeds/client";
import { profile as defaultProfile } from "@/seeds/default/profile";

// The neutral defaults below are what a new client's fresh deployment shows
// (BASE_WEB_CLIENT unset). A client's own copy (src/seeds/<client>/settings.ts)
// is laid over them, and Admin → Site settings over that.
const ORG_NAME = defaultProfile.orgName;
const ORG_EMAIL = defaultProfile.email;

// A new client's home page: the modules that make sense without its own
// campaigns, board or shop yet. The rest are in Admin → Home page, hidden.
const NEUTRAL_MODULES = ALL_MODULES.map((m) => ({ ...m, enabled: !["pledge", "skytrain", "board", "committees", "shop"].includes(m.kind) }));

const NEUTRAL_PILLARS: { icon: "shield" | "bus" | "trend" | "tag" | "civic"; title: string; body: string }[] = [
  { icon: "shield", title: "Safe streets", body: "A police service focused on the crimes that hurt families, and prevention that is funded properly." },
  { icon: "bus", title: "Getting around", body: "Synchronized lights, frequent buses, and sidewalks on the streets that have none today." },
  { icon: "trend", title: "Smart investments", body: "Big projects judged on value, not headlines, and a City Hall that buys local whenever it can." },
  { icon: "tag", title: "Lower costs", body: "Taxes held in line with inflation, fair recreation fees, and homes that the people who keep this city running can afford." },
  { icon: "civic", title: "Strong services", body: "Services that show up when people need them, with no quiet cuts." },
];
const NEUTRAL_BENEFITS = [
  { title: "Set the priorities", body: "Members have a direct say in what we stand for and take on next." },
  { title: "Organize where you live", body: "Connect with members near you and take on local issues together." },
  { title: "Hear it first", body: "Events, actions and news before anyone else, and a direct line to the people doing the work." },
];
const NEUTRAL_STOP_ITEMS = [
  { title: "Cuts", body: "Fewer staff, longer waits, and services that quietly disappear. We'll track every cut and name it." },
  { title: "Fee hikes", body: "When City Hall can't balance the books, families pay first. We'll fight every fee increase that lands on residents." },
  { title: "Deals for friends", body: "Contracts and land deals that work for insiders, not for you. We'll demand that every deal is public before it's signed." },
];
const NEUTRAL_COMMITTEES = [
  { title: "Communications", body: "The website, the newsletter, social media, and getting the message out." },
  { title: "Outreach", body: "Events, door-knocking, and showing up where people already gather." },
  { title: "Membership", body: "Signing up new members, welcoming them in, and keeping renewals on track." },
  { title: "Fundraising", body: "Donors, events, and the Star Club. Keeping the lights on." },
  { title: "Policy", body: "Digging into local issues and turning them into positions the board can act on." },
];

const text = (max: number) => z.string().trim().max(max);
const url = z.string().trim().max(500);
const image = z.object({ url: url.optional().default(""), alt: text(300).optional().default("") });

export const sections = {
  header: {
    label: "Title bar",
    description: "The bar across the top of every page: the logo, up to three links, the Donate button and the Menu. Keep it short.",
    schema: z.object({
      links: z.array(z.object({ label: text(30), href: url })).max(3).default([]),
      ctaLabel: text(30).default("Donate"),
      ctaHref: url.default("/donate"),
    }),
  },
  homeModules: {
    label: "Home page modules",
    description: "Which sections the home page shows, in what order, plus your own text blocks. Easiest to change in Admin → Home page.",
    schema: z.object({
      modules: z
        .array(
          z.object({
            kind: z.enum(MODULE_KINDS),
            enabled: z.boolean().default(true),
            heading: text(120).default(""),
            body: text(4000).default(""),
            buttonLabel: text(40).default(""),
            buttonHref: url.default(""),
            tone: z.enum(CUSTOM_TONES).default("white"),
          }),
        )
        .max(40)
        .default(NEUTRAL_MODULES),
    }),
  },
  org: {
    label: "Organization",
    description: "Name, contact details and links used across the site and in emails.",
    schema: z.object({
      name: text(80).default(ORG_NAME),
      shortName: text(40).default(ORG_NAME),
      email: z.string().trim().email().default(ORG_EMAIL),
      phone: text(40).default(""),
      address: text(200).default(""),
      platformUrl: url.default(""),
      platformLabel: text(80).default("Read our platform"),
      privacyUrl: url.default("/privacy"),
      authorizationLine: text(200).default(""),
    }),
  },
  announcement: {
    label: "Announcement bar",
    description: "A one-line notice at the top of every page, e.g. the next big event.",
    schema: z.object({ enabled: z.boolean().default(false), text: text(160).default(""), linkLabel: text(40).default(""), linkHref: url.default("") }),
  },
  hero: {
    label: "Home: hero",
    description: "The first thing visitors see.",
    schema: z.object({
      titlePrefix: text(60).default("Working for"),
      words: z.array(text(40)).min(1).max(30).default(["our community", "safer streets", "affordable homes", "better transit", "strong services", "lower costs"]),
      text: text(600).default("We're neighbours organizing for a local government that gets the basics right. Become a member and help build it."),
      primaryCta: z.object({ label: text(40).default("Become a member"), href: url.default("/#join") }).default({ label: "Become a member", href: "/#join" }),
      secondaryCtas: z.array(z.object({ label: text(40), href: url })).max(3).default([{ label: "Chip in", href: "/donate" }]),
      image: image.default({ url: "", alt: "" }),
    }),
  },
  pillars: {
    label: "Home: what we stand for",
    description: "The five pillars.",
    schema: z.object({
      title: text(80).default("What we stand for"),
      intro: text(500).default("The priorities our members chose, and the work we do on each of them."),
      items: z
        .array(z.object({ icon: z.enum(["shield", "bus", "trend", "tag", "civic"]).default("civic"), title: text(60), body: text(400) }))
        .max(8)
        .default(NEUTRAL_PILLARS),
      ctaText: text(120).default("Ready to help? Become a member!"),
    }),
  },
  membership: {
    label: "Home: become a member",
    description: "The membership section copy and benefits.",
    schema: z.object({
      title: text(80).default("Become a member"),
      intro: text(500).default("Members set the priorities, have a direct say in what we stand for, and hear first when something is happening near them."),
      benefits: z.array(z.object({ title: text(60), body: text(300) })).max(6).default(NEUTRAL_BENEFITS),
      // Membership is by donation; the form adds the minimums from MEMBERSHIP_FEE_CENTS.
      amountTitle: text(80).default("Your membership, by donation"),
      amountNote: text(300).default("Give what you can. Membership runs for a year, and every dollar goes to organizing."),
      photo: image.default({ url: "", alt: "" }),
      newsletterTitle: text(80).default("Not ready to join? Get the newsletter"),
      newsletterText: text(300).default("News and events, a couple of times a month. Unsubscribe anytime."),
    }),
  },
  stop: {
    label: "Home: accountability and the pledge",
    description: "The accountability section and the pledge.",
    schema: z.object({
      title: text(80).default("Hold City Hall to account"),
      intro: text(500).default("Cuts, fee hikes and backroom deals happen quietly. We watch every decision made in your name and speak up when it counts."),
      items: z.array(z.object({ title: text(60), body: text(300) })).max(6).default(NEUTRAL_STOP_ITEMS),
      pledgeEyebrow: text(40).default("The pledge"),
      pledgeTitle: text(120).default("Take the pledge"),
      pledgeText: text(600).default("I'll watch every cut, fee hike and backroom deal, speak up when it counts, and vote at the next election."),
    }),
  },
  donate: {
    label: "Chip in",
    description: "Donation copy on the home page and /donate.",
    schema: z.object({
      title: text(60).default("Chip in"),
      intro: text(600).default("We run on contributions from people who give what they can."),
      text: text(400).default("Your contribution pays for the unglamorous work: organizers, printing, outreach and keeping the lights on."),
      monthlyNote: text(300).default("Monthly donors let us plan ahead and keep organizing all year."),
      clubNote: text(500).default("The Star Club is our name for donors who give the yearly maximum, all at once or spread across twelve months. The Superstar Club gives the maximum to both of our slates: two contributions, one payment."),
    }),
  },
  skytrain: {
    label: "Home: campaign petition",
    description: "The campaign section with its map and petition (Imagine Surrey: SkyTrain to South Surrey).",
    schema: z.object({
      title: text(80).default("Our campaign"),
      highlight: text(80).default(""),
      claim: text(400).default(""),
      claimHighlight: text(120).default(""),
      callout: text(300).default(""),
      calloutHighlight: text(120).default(""),
      asksIntro: text(200).default(""),
      asks: z.array(text(300)).max(6).default([]),
      image: image.default({ url: "", alt: "" }),
    }),
  },
  organize: {
    label: "Home: organize banner",
    description: "The yellow banner.",
    schema: z.object({ title: text(80).default("When we organize,"), highlight: text(40).default("we win"), ctaLabel: text(40).default("Become a member"), ctaHref: url.default("/#join") }),
  },
  board: {
    label: "Board of directors",
    description: "Seats, names and photos. Leave the name blank for an open seat.",
    schema: z.object({
      title: text(80).default("Board of directors"),
      intro: text(500).default("The board keeps the organization running and answers to the members."),
      seats: z
        .array(z.object({ role: text(80), name: text(80).optional().default(""), photo: image.optional(), bio: text(600).optional().default("") }))
        .max(30)
        .default([{ role: "President", name: "", bio: "" }, { role: "Vice-President", name: "", bio: "" }, { role: "Secretary-Treasurer", name: "", bio: "" }]),
    }),
  },
  committees: {
    label: "Committees",
    description: "Committees, neighbourhood committees and campus clubs.",
    schema: z.object({
      title: text(80).default("Committees"),
      intro: text(500).default("Committees do the work between board meetings. Pick the one that matches what you're good at, the one for your neighbourhood, or the one on your campus."),
      items: z.array(z.object({ title: text(60), body: text(300) })).max(12).default(NEUTRAL_COMMITTEES),
      neighbourhoodsTitle: text(80).default("Neighbourhood committees"),
      neighbourhoodsIntro: text(300).default("One for each community, run by the members who live there."),
      campusTitle: text(80).default("Campus clubs"),
      campusIntro: text(300).default("Student-run clubs on local campuses, represented on the board."),
      campuses: z.array(text(60)).max(10).default([]),
    }),
  },
  socials: {
    label: "Social media",
    description: "Accounts shown in the footer and the Follow along section.",
    schema: z.object({
      intro: text(300).default("The latest from our feeds: events, actions and news."),
      accounts: z.array(z.object({ name: text(40), short: text(4), handle: text(60), url, cta: text(40) })).max(12).default([]),
      also: z.array(z.object({ name: text(40), url })).max(6).default([]),
    }),
  },
  footer: {
    label: "Footer",
    description: "Land acknowledgement and footer links.",
    schema: z.object({
      acknowledgement: text(600).default(""),
      links: z.array(z.object({ label: text(40), href: url })).max(12).default([
        { label: "About", href: "/#about" },
        { label: "News", href: "/news" },
        { label: "Events", href: "/events" },
        { label: "Promise tracker", href: "/tracker" },
        { label: "Shop", href: "/shop" },
        { label: "Donate", href: "/donate" },
      ]),
    }),
  },
  seo: {
    label: "Search and sharing",
    description: "The default title, description and share image.",
    schema: z.object({
      title: text(80).default(ORG_NAME),
      description: text(300).default("Neighbours organizing for a local government that gets the basics right."),
      shareImage: image.default({ url: "", alt: "" }),
    }),
  },
} as const;

export type SectionKey = keyof typeof sections;
export type SectionValue<K extends SectionKey> = z.output<(typeof sections)[K]["schema"]>;
export type Settings = { [K in SectionKey]: SectionValue<K> };

export const SECTION_KEYS = Object.keys(sections) as SectionKey[];

/**
 * The section's value with defaults filled in, field by field: the client's
 * own copy first, then the neutral defaults. Invalid input throws.
 */
export function parseSection<K extends SectionKey>(key: K, value: unknown): SectionValue<K> {
  const clientCopy = (clientSettings as Partial<Record<SectionKey, Record<string, unknown>>>)[key] ?? {};
  const given = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return sections[key].schema.parse({ ...clientCopy, ...given }) as SectionValue<K>;
}

export function defaultSettings(): Settings {
  const out = {} as Settings;
  for (const key of SECTION_KEYS) (out as Record<string, unknown>)[key] = parseSection(key, {});
  return out;
}
