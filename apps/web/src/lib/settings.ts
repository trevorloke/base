// The editable content of the public site: one section per key, each with a
// zod schema and a default. The admin edits a section; the public pages read
// the merged result through getSettings(). Adding a section means adding it
// here; the admin form and the database row follow from the schema.
import { z } from "zod";
import { CUSTOM_TONES, DEFAULT_MODULES, MODULE_KINDS } from "@/lib/home-modules";
import { board, committees, heroWords, memberBenefits, pillars, site, skytrainAsks, socials, stopItems } from "@/content/site";

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
        .default(DEFAULT_MODULES),
    }),
  },
  org: {
    label: "Organization",
    description: "Name, contact details and links used across the site and in emails.",
    schema: z.object({
      name: text(80).default("Imagine Surrey"),
      shortName: text(40).default("Imagine Surrey"),
      email: z.string().trim().email().default(site.email),
      phone: text(40).default(""),
      address: text(200).default(""),
      platformUrl: url.default(site.platformUrl),
      platformLabel: text(80).default("Read the 2026 election platform"),
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
      titlePrefix: text(60).default("Fighting for"),
      words: z.array(text(40)).min(1).max(30).default(heroWords),
      text: text(600).default(
        "Surrey is the nurse renting in City Centre, the family in Newton, the shop owner in Cloverdale, and the senior in Guildford. They all want the same thing: a City Hall that gets the basics right. Imagine Surrey is residents organizing to make that happen. Become a member and help build it.",
      ),
      primaryCta: z.object({ label: text(40).default("Become a member"), href: url.default("/#join") }).default({ label: "Become a member", href: "/#join" }),
      secondaryCtas: z.array(z.object({ label: text(40), href: url })).max(3).default([
        { label: "Chip in", href: "/donate" },
        { label: "Shop", href: "/shop" },
      ]),
      image: image.default({
        url: "/images/hero-park.jpg",
        alt: "A park in Surrey City Centre on a clear day: a lotus fountain and flower planters in a reflecting pool, with the SkyTrain line and residential towers behind",
      }),
    }),
  },
  pillars: {
    label: "Home: what we stand for",
    description: "The five pillars.",
    schema: z.object({
      title: text(80).default("What we stand for"),
      intro: text(500).default("Surrey has what it takes to be the best place in Canada to raise a family, start a business, or grow old. What it needs is a City Hall that treats the basics as the whole job. That's the work."),
      items: z
        .array(z.object({ icon: z.enum(["shield", "bus", "trend", "tag", "civic"]).default("civic"), title: text(60), body: text(400) }))
        .max(8)
        .default(pillars),
      ctaText: text(120).default("Ready to bring change to Surrey? Become a member!"),
    }),
  },
  membership: {
    label: "Home: become a member",
    description: "The membership section copy and benefits.",
    schema: z.object({
      title: text(80).default("Become a member"),
      intro: text(500).default("Imagine Surrey is residents, not a brand. Members set the priorities, have a direct say in what we stand for, and hear first when something is happening in their neighbourhood."),
      benefits: z.array(z.object({ title: text(60), body: text(300) })).max(6).default(memberBenefits),
      // Membership is by donation; the form adds the minimums from MEMBERSHIP_FEE_CENTS.
      amountTitle: text(80).default("Your membership, by donation"),
      amountNote: text(300).default("Give what you can. Membership runs for a year, and every dollar goes to organizing in Surrey."),
      photo: image.default({ url: "/images/members-rally.jpg", alt: "A packed room of Imagine Surrey supporters cheering and holding up signs that read change that works for you" }),
      newsletterTitle: text(80).default("Not ready to join? Get the newsletter"),
      newsletterText: text(300).default("News and events from around Surrey. By subscribing you agree to receive email from Imagine Surrey. Unsubscribe anytime."),
    }),
  },
  stop: {
    label: "Home: Stop McCallum's chaos",
    description: "The accountability section and the pledge.",
    schema: z.object({
      title: text(80).default("Stop McCallum's chaos"),
      intro: text(500).default("Cuts, fee hikes, and deals for his friends, all at your expense. Imagine Surrey is the organized voice of residents who won't let it happen quietly."),
      items: z.array(z.object({ title: text(60), body: text(300) })).max(6).default(stopItems),
      pledgeEyebrow: text(40).default("The pledge"),
      pledgeTitle: text(120).default("Stop Doug McCallum and Mandeep Nagra"),
      pledgeText: text(600).default(
        "I won't sit back while City Hall gets run for insiders. I'll watch every cut, fee hike, and backroom deal, speak up when it counts, and vote to replace Doug McCallum and Mandeep Nagra at the next election.",
      ),
    }),
  },
  donate: {
    label: "Chip in",
    description: "Donation copy on the home page and /donate.",
    schema: z.object({
      title: text(60).default("Chip in"),
      intro: text(600).default("In BC, elector organizations can only take contributions from individuals. No corporate money, no union money. That's the law, and we're glad of it. It means Imagine Surrey runs on Surrey residents who give what they can."),
      text: text(400).default("Your contribution pays for the unglamorous work: organizers, printing, outreach in every town centre, and keeping the lights on."),
      monthlyNote: text(300).default("Monthly donors automatically support the Imagine Victory Fund, our war chest for the next election."),
      clubNote: text(500).default(
        "The Star Club is our name for donors who give the yearly maximum, all at once or spread across twelve months. The Superstar Club gives the maximum to both our city council and school board slates: two contributions, one payment.",
      ),
    }),
  },
  skytrain: {
    label: "Home: SkyTrain campaign",
    description: "The SkyTrain to South Surrey section.",
    schema: z.object({
      title: text(80).default("Get SkyTrain"),
      highlight: text(80).default("to South Surrey"),
      claim: text(400).default("Doug promised SkyTrain to 64 Avenue. It still stops at King George. Don't worry, Doug. We'll help you finish the job:"),
      claimHighlight: text(120).default("all the way to South Surrey."),
      callout: text(300).default("We're also calling on the province to honour its commitment of"),
      calloutHighlight: text(120).default("$250 million for B-Line expansion."),
      asksIntro: text(200).default("We're calling on Mayor Doug McCallum to keep his promise:"),
      asks: z.array(text(300)).max(6).default(skytrainAsks),
      image: image.default({ url: "/images/skytrain.jpg", alt: "" }),
    }),
  },
  organize: {
    label: "Home: organize banner",
    description: "The yellow banner.",
    schema: z.object({ title: text(80).default("When we organize,"), highlight: text(40).default("Surrey wins"), ctaLabel: text(40).default("Become a member"), ctaHref: url.default("/#join") }),
  },
  board: {
    label: "Board of directors",
    description: "Seats, names and photos. Leave the name blank for an open seat.",
    schema: z.object({
      title: text(80).default("Board of directors"),
      intro: text(500).default("The board keeps Imagine Surrey running and answers to the members. Eight director seats are open: one for each neighbourhood, one for youth and campus clubs, and one for seniors."),
      seats: z
        .array(z.object({ role: text(80), name: text(80).optional().default(""), photo: image.optional(), bio: text(600).optional().default("") }))
        .max(30)
        .default(board.map((b) => ({ role: b.role, name: b.name ?? "", bio: "" }))),
    }),
  },
  committees: {
    label: "Committees",
    description: "Committees, neighbourhood committees and campus clubs.",
    schema: z.object({
      title: text(80).default("Committees"),
      intro: text(500).default("Committees do the work between board meetings. Pick the one that matches what you're good at, the one for your neighbourhood, or the one on your campus."),
      items: z.array(z.object({ title: text(60), body: text(300) })).max(12).default(committees),
      neighbourhoodsTitle: text(80).default("Neighbourhood committees"),
      neighbourhoodsIntro: text(300).default("One for each community, run by the members who live there."),
      campusTitle: text(80).default("Campus clubs"),
      campusIntro: text(300).default("Student-run clubs on Surrey's campuses, represented on the board by the youth and campus clubs director."),
      campuses: z.array(text(60)).max(10).default(["Kwantlen Cloverdale", "Kwantlen Newton", "SFU Surrey"]),
    }),
  },
  socials: {
    label: "Social media",
    description: "Accounts shown in the footer and the Follow along section.",
    schema: z.object({
      intro: text(300).default("The latest from our feeds: events, actions, and news from around Surrey."),
      accounts: z.array(z.object({ name: text(40), short: text(4), handle: text(60), url, cta: text(40) })).max(12).default(socials),
      also: z.array(z.object({ name: text(40), url })).max(6).default([
        { name: "Threads", url: "https://www.threads.com/@imagine.surrey" },
        { name: "Bluesky", url: "https://bsky.app/profile/imagine-surrey.bsky.social" },
      ]),
    }),
  },
  footer: {
    label: "Footer",
    description: "Land acknowledgement and footer links.",
    schema: z.object({
      acknowledgement: text(600).default(
        "We live and work on the shared traditional territories of the Coast Salish peoples, including the Semiahmoo, Katzie, and Kwantlen First Nations. We're committed to relationships built on respect and reconciliation.",
      ),
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
      title: text(80).default("Imagine Surrey"),
      description: text(300).default("Imagine Surrey is residents organizing for a City Hall that gets the basics right: safe streets, fast commutes, smart investments, lower costs and strong services."),
      shareImage: image.default({ url: "/images/members-rally.jpg", alt: "Imagine Surrey supporters" }),
    }),
  },
} as const;

export type SectionKey = keyof typeof sections;
export type SectionValue<K extends SectionKey> = z.output<(typeof sections)[K]["schema"]>;
export type Settings = { [K in SectionKey]: SectionValue<K> };

export const SECTION_KEYS = Object.keys(sections) as SectionKey[];

/** The section's value with defaults filled in; invalid input throws. */
export function parseSection<K extends SectionKey>(key: K, value: unknown): SectionValue<K> {
  return sections[key].schema.parse(value ?? {}) as SectionValue<K>;
}

export function defaultSettings(): Settings {
  const out = {} as Settings;
  for (const key of SECTION_KEYS) (out as Record<string, unknown>)[key] = parseSection(key, {});
  return out;
}
