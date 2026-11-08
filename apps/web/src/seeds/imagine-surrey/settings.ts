// Imagine Surrey's site copy: the defaults of every Site settings section for
// its deployment (BASE_WEB_CLIENT=imagine-surrey), exactly as the site had
// them before base web became a product. Admin → Site settings overrides any
// section; "Reset" comes back here.
import { DEFAULT_MODULES } from "@/lib/home-modules";
import { board, committees, heroWords, memberBenefits, pillars, site, skytrainAsks, socials, stopItems } from "./site";

export const settings = {
  header: {
    links: [],
    ctaLabel: "Donate",
    ctaHref: "/donate",
  },
  homeModules: {
    modules: DEFAULT_MODULES,
  },
  org: {
    name: "Imagine Surrey",
    shortName: "Imagine Surrey",
    email: site.email,
    phone: "",
    address: "",
    platformUrl: site.platformUrl,
    platformLabel: "Read the 2026 election platform",
    privacyUrl: "/privacy",
    authorizationLine: "",
  },
  announcement: {
    enabled: false,
    text: "",
    linkLabel: "",
    linkHref: "",
  },
  hero: {
    titlePrefix: "Fighting for",
    words: heroWords,
    text: "Surrey is the nurse renting in City Centre, the family in Newton, the shop owner in Cloverdale, and the senior in Guildford. They all want the same thing: a City Hall that gets the basics right. Imagine Surrey is residents organizing to make that happen. Become a member and help build it.",
    primaryCta: { label: "Become a member", href: "/#join" },
    secondaryCtas: [
        { label: "Chip in", href: "/donate" },
        { label: "Shop", href: "/shop" },
      ],
    image: {
        url: "/images/hero-park.jpg",
        alt: "A park in Surrey City Centre on a clear day: a lotus fountain and flower planters in a reflecting pool, with the SkyTrain line and residential towers behind",
      },
  },
  pillars: {
    title: "What we stand for",
    intro: "Surrey has what it takes to be the best place in Canada to raise a family, start a business, or grow old. What it needs is a City Hall that treats the basics as the whole job. That's the work.",
    items: pillars,
    ctaText: "Ready to bring change to Surrey? Become a member!",
  },
  membership: {
    title: "Become a member",
    intro: "Imagine Surrey is residents, not a brand. Members set the priorities, have a direct say in what we stand for, and hear first when something is happening in their neighbourhood.",
    benefits: memberBenefits,
    amountTitle: "Your membership, by donation",
    amountNote: "Give what you can. Membership runs for a year, and every dollar goes to organizing in Surrey.",
    photo: { url: "/images/members-rally.jpg", alt: "A packed room of Imagine Surrey supporters cheering and holding up signs that read change that works for you" },
    newsletterTitle: "Not ready to join? Get the newsletter",
    newsletterText: "News and events from around Surrey. By subscribing you agree to receive email from Imagine Surrey. Unsubscribe anytime.",
  },
  stop: {
    title: "Stop McCallum's chaos",
    intro: "Cuts, fee hikes, and deals for his friends, all at your expense. Imagine Surrey is the organized voice of residents who won't let it happen quietly.",
    items: stopItems,
    pledgeEyebrow: "The pledge",
    pledgeTitle: "Stop Doug McCallum and Mandeep Nagra",
    pledgeText: "I won't sit back while City Hall gets run for insiders. I'll watch every cut, fee hike, and backroom deal, speak up when it counts, and vote to replace Doug McCallum and Mandeep Nagra at the next election.",
  },
  donate: {
    title: "Chip in",
    intro: "In BC, elector organizations can only take contributions from individuals. No corporate money, no union money. That's the law, and we're glad of it. It means Imagine Surrey runs on Surrey residents who give what they can.",
    text: "Your contribution pays for the unglamorous work: organizers, printing, outreach in every town centre, and keeping the lights on.",
    monthlyNote: "Monthly donors automatically support the Imagine Victory Fund, our war chest for the next election.",
    clubNote: "The Star Club is our name for donors who give the yearly maximum, all at once or spread across twelve months. The Superstar Club gives the maximum to both our city council and school board slates: two contributions, one payment.",
  },
  skytrain: {
    title: "Get SkyTrain",
    highlight: "to South Surrey",
    claim: "Doug promised SkyTrain to 64 Avenue. It still stops at King George. Don't worry, Doug. We'll help you finish the job:",
    claimHighlight: "all the way to South Surrey.",
    callout: "We're also calling on the province to honour its commitment of",
    calloutHighlight: "$250 million for B-Line expansion.",
    asksIntro: "We're calling on Mayor Doug McCallum to keep his promise:",
    asks: skytrainAsks,
    image: { url: "/images/skytrain.jpg", alt: "" },
  },
  organize: {
    title: "When we organize,",
    highlight: "Surrey wins",
    ctaLabel: "Become a member",
    ctaHref: "/#join",
  },
  board: {
    title: "Board of directors",
    intro: "The board keeps Imagine Surrey running and answers to the members. Eight director seats are open: one for each neighbourhood, one for youth and campus clubs, and one for seniors.",
    seats: board.map((b) => ({ role: b.role, name: b.name ?? "", bio: "" })),
  },
  committees: {
    title: "Committees",
    intro: "Committees do the work between board meetings. Pick the one that matches what you're good at, the one for your neighbourhood, or the one on your campus.",
    items: committees,
    neighbourhoodsTitle: "Neighbourhood committees",
    neighbourhoodsIntro: "One for each community, run by the members who live there.",
    campusTitle: "Campus clubs",
    campusIntro: "Student-run clubs on Surrey's campuses, represented on the board by the youth and campus clubs director.",
    campuses: ["Kwantlen Cloverdale", "Kwantlen Newton", "SFU Surrey"],
  },
  socials: {
    intro: "The latest from our feeds: events, actions, and news from around Surrey.",
    accounts: socials,
    also: [
        { name: "Threads", url: "https://www.threads.com/@imagine.surrey" },
        { name: "Bluesky", url: "https://bsky.app/profile/imagine-surrey.bsky.social" },
      ],
  },
  footer: {
    acknowledgement: "We live and work on the shared traditional territories of the Coast Salish peoples, including the Semiahmoo, Katzie, and Kwantlen First Nations. We're committed to relationships built on respect and reconciliation.",
    links: [
        { label: "About", href: "/#about" },
        { label: "News", href: "/news" },
        { label: "Events", href: "/events" },
        { label: "Promise tracker", href: "/tracker" },
        { label: "Shop", href: "/shop" },
        { label: "Donate", href: "/donate" },
      ],
  },
  seo: {
    title: "Imagine Surrey",
    description: "Imagine Surrey is residents organizing for a City Hall that gets the basics right: safe streets, fast commutes, smart investments, lower costs and strong services.",
    shareImage: { url: "/images/members-rally.jpg", alt: "Imagine Surrey supporters" },
  },
};
