// Imagine Surrey's own content, used by its site copy (./settings.ts).
import type { PillarIcon } from "@/content/site";

export const site = {
  name: "Imagine Surrey",
  email: "hello@imaginesurrey.ca",
  platformUrl: "https://issuu.com/imaginesurrey/docs/imagine_surrey_platform_2026_-_signed",
  privacyUrl: "https://imaginesurrey.ca/privacy/",
};

export const heroWords = [
  "Surrey",
  "affordability",
  "SkyTrain",
  "commuter rail",
  "faster buses",
  "affordable homes",
  "lower fees",
  "faster permits",
  "safer streets",
  "no service cuts",
  "better services",
  "child care",
  "more parks",
  "community centres",
  "more sidewalks",
];

export const pillars: { icon: PillarIcon; title: string; body: string }[] = [
  {
    icon: "shield",
    title: "Safe streets",
    body: "A police service focused on the crimes hurting Surrey families, from extortion to street racing, and a Crime Prevention Society with its funding restored.",
  },
  {
    icon: "bus",
    title: "Fast commutes",
    body: "Synchronized traffic lights, expanded key roads, a $70 monthly transit pass for Surrey residents, and 50 km of new sidewalk on streets that have none today.",
  },
  {
    icon: "trend",
    title: "Smart investments",
    body: "Big projects judged on value, not headlines: an arena on the right land at the right price, three new community centres, and a City Hall that buys from Surrey businesses whenever it can.",
  },
  {
    icon: "tag",
    title: "Lower costs",
    body: "Property taxes held at or below inflation, recreation fees cut in half, and at least 1,000 affordable homes a year so the people who keep Surrey running can afford to live here.",
  },
  {
    icon: "civic",
    title: "Strong services",
    body: "Services that show up: more public washrooms, free programs for seniors, one SurreyPass card for every City service, and no cuts to the services people count on.",
  },
];

export const memberBenefits = [
  { title: "Set the priorities", body: "Members have a direct say in what Imagine Surrey stands for and takes on next." },
  {
    title: "Organize where you live",
    body: "Connect with members in your town centre and take on local issues together, from a missing sidewalk to a closed washroom.",
  },
  { title: "Hear it first", body: "Events, actions, and news before anyone else, and a direct line to the people doing the work." },
];

export const stopItems = [
  { title: "Cuts", body: "Fewer staff, longer waits, and services that quietly disappear. We'll track every cut and name it." },
  {
    title: "Fee hikes",
    body: "When City Hall can't balance the books, families pay first. We'll fight every fee increase that lands on residents.",
  },
  {
    title: "Deals for friends",
    body: "Contracts and land deals that work for insiders, not for you. We'll demand that every deal is public before it's signed.",
  },
];

export const skytrainAsks = [
  "Commit in writing to SkyTrain reaching at least 64 Avenue, with a target year",
  "Get the extension into TransLink's next investment plan with a route, a cost, and a funding ask to the province and Ottawa",
  "Report to residents every year on what's funded, what's designed, and what's built",
];

// A seat with no name shows as open, with a link to put your name forward.
export const board: { role: string; name?: string; initials?: string }[] = [
  { role: "President", name: "Anne Blunt", initials: "AB" },
  { role: "Vice-President" },
  { role: "Vice-President" },
  { role: "Secretary-Treasurer", name: "[Name to confirm]" },
  { role: "Director, Newton" },
  { role: "Director, Whalley" },
  { role: "Director, Fleetwood" },
  { role: "Director, Cloverdale" },
  { role: "Director, Guildford" },
  { role: "Director, South Surrey" },
  { role: "Director, Youth and campus clubs" },
  { role: "Director, Seniors" },
];

export const committees = [
  { title: "Communications", body: "The website, the newsletter, social media, and getting the message out." },
  { title: "Outreach", body: "Events, door-knocking, and showing up where people already gather." },
  { title: "Membership", body: "Signing up new members, welcoming them in, and keeping renewals on track." },
  { title: "Fundraising", body: "Donors, events, and the Star Club. Keeping the lights on." },
  { title: "Nominations", body: "Board nominations, bylaws, and keeping the organization accountable to its members." },
  { title: "Policy", body: "Digging into Surrey's issues and turning them into positions the board can act on." },
];

export const socials = [
  { name: "Instagram", short: "IG", handle: "@imagine.surrey", url: "https://www.instagram.com/imagine.surrey", cta: "Follow on Instagram" },
  { name: "Facebook", short: "FB", handle: "Imagine Surrey", url: "https://www.facebook.com/profile.php?id=61578371604513", cta: "Follow on Facebook" },
  { name: "X", short: "X", handle: "@imaginesurrey", url: "https://x.com/imaginesurrey", cta: "Follow on X" },
  { name: "TikTok", short: "TT", handle: "@imagine.surrey", url: "https://www.tiktok.com/@imagine.surrey", cta: "Follow on TikTok" },
  { name: "LinkedIn", short: "IN", handle: "Imagine Surrey", url: "https://www.linkedin.com/in/imaginesurrey", cta: "Follow on LinkedIn" },
  { name: "Threads", short: "TH", handle: "@imagine.surrey", url: "https://www.threads.com/@imagine.surrey", cta: "Follow on Threads" },
  { name: "Bluesky", short: "BS", handle: "@imagine-surrey", url: "https://bsky.app/profile/imagine-surrey.bsky.social", cta: "Follow on Bluesky" },
];
