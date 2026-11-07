// The engagement ladder and other pure portal helpers. No server imports, so
// the client, the server and the unit tests can all use them.
import { checkAnnualLimit, type Slate, type SlateAmounts } from "./contributions";
import { withSource } from "./share";

// ── The ladder ─────────────────────────────────────────────────────────────
// Each action a supporter takes ends with the next rung up. The order is the
// order of commitment: a signature, the newsletter, a shift, a membership, a
// monthly gift, and at the top, bringing a neighbour in.
export const RUNGS = ["pledge", "petition", "newsletter", "shift", "member", "monthly", "recruit"] as const;
export type Rung = (typeof RUNGS)[number];

export type EngagementState = {
  signedPledge: boolean;
  signedPetition: boolean;
  newsletterConfirmed: boolean;
  hasShift: boolean;
  memberActive: boolean;
  monthlyDonor: boolean;
  hasReferred: boolean;
};

export const EMPTY_STATE: EngagementState = {
  signedPledge: false,
  signedPetition: false,
  newsletterConfirmed: false,
  hasShift: false,
  memberActive: false,
  monthlyDonor: false,
  hasReferred: false,
};

/** What the person just did, so the card never asks for it again. */
export type Completed = "pledge" | "petition" | "newsletter" | "rsvp" | "shift" | "member" | "donation" | "order";

export type NextStep = {
  rung: Rung;
  title: string;
  body: string;
  cta: { label: string; href: string };
  secondary?: { label: string; href: string };
};

export const CAMPAIGN_SLUGS = { pledge: "stop-mccallum-pledge", petition: "skytrain-south-surrey" } as const;

const SOURCE = "next-step";
const link = (path: string) => withSource(path, SOURCE);

const RUNG_DONE: Record<Rung, (s: EngagementState) => boolean> = {
  pledge: (s) => s.signedPledge,
  petition: (s) => s.signedPetition,
  newsletter: (s) => s.newsletterConfirmed,
  shift: (s) => s.hasShift,
  member: (s) => s.memberActive,
  monthly: (s) => s.monthlyDonor,
  // The top rung is never "done": there is always another neighbour.
  recruit: () => false,
};

/** The state after an action, so a card shown on a thank-you page moves on from it. */
export function applyCompleted(state: EngagementState, completed?: Completed): EngagementState {
  switch (completed) {
    case "pledge":
      return { ...state, signedPledge: true };
    case "petition":
      return { ...state, signedPetition: true };
    case "newsletter":
      // A pending double opt-in still counts: asking again would be nagging.
      return { ...state, newsletterConfirmed: true };
    case "shift":
      return { ...state, hasShift: true };
    case "member":
      return { ...state, memberActive: true };
    default:
      return state;
  }
}

const STEPS: Record<Rung, (s: EngagementState) => NextStep> = {
  pledge: () => ({
    rung: "pledge",
    title: "Sign the pledge",
    body: "Add your name to the residents who won't let City Hall be run for insiders.",
    cta: { label: "Sign the pledge", href: link(`/act/${CAMPAIGN_SLUGS.pledge}`) },
    secondary: { label: "Or get the newsletter", href: link("/#newsletter") },
  }),
  petition: () => ({
    rung: "petition",
    title: "Sign the SkyTrain petition",
    body: "Call on the mayor to keep his promise and bring SkyTrain all the way to South Surrey.",
    cta: { label: "Sign the petition", href: link(`/act/${CAMPAIGN_SLUGS.petition}`) },
  }),
  newsletter: () => ({
    rung: "newsletter",
    title: "Get the newsletter",
    body: "News and events from around Surrey, a couple of times a month. Unsubscribe any time.",
    cta: { label: "Get the newsletter", href: link("/#newsletter") },
  }),
  shift: () => ({
    rung: "shift",
    title: "Take a shift",
    body: "A morning on the doors or an evening on the phones in your own neighbourhood. We'll show you how.",
    cta: { label: "See volunteer shifts", href: link("/volunteer") },
    secondary: { label: "Come to an event instead", href: link("/events") },
  }),
  member: () => ({
    rung: "member",
    title: "Become a member",
    body: "Members set the priorities and vote on who runs for council. It's $10 a year.",
    cta: { label: "Become a member", href: link("/join") },
    secondary: { label: "Chip in instead", href: link("/donate") },
  }),
  monthly: () => ({
    rung: "monthly",
    title: "Give monthly",
    body: "A monthly gift pays for organizers and outreach all year, and supports the Imagine Victory Fund.",
    cta: { label: "Give monthly", href: link("/donate") },
  }),
  recruit: (s) => ({
    rung: "recruit",
    title: s.hasReferred ? "Bring another neighbour" : "Bring a neighbour",
    body: s.hasReferred
      ? "You've already brought people in. One more conversation on your street is how this grows."
      : "The most useful thing you can do now is tell one neighbour. Share your personal link and we'll credit the people you bring in.",
    cta: { label: "Get your personal link", href: link("/me") },
  }),
};

/**
 * The first rung the person hasn't reached, given what we know about them
 * and what they just did. The top rung, bringing a neighbour, is returned
 * when everything else is done.
 */
export function nextStep(state: EngagementState, completed?: Completed): NextStep {
  const s = applyCompleted(state, completed);
  const rung = RUNGS.find((r) => !RUNG_DONE[r](s)) ?? "recruit";
  return STEPS[rung](s);
}

export const THANKS: Record<Completed, string> = {
  pledge: "Thanks for signing the pledge.",
  petition: "Thanks for adding your name to the petition.",
  newsletter: "Thanks for subscribing. Watch your inbox for the confirmation.",
  rsvp: "You're on the list. See you there.",
  shift: "Thanks for taking a shift. We'll send the details.",
  member: "Welcome aboard. You're a member of Imagine Surrey.",
  donation: "Thank you for chipping in.",
  order: "Thanks for your order. We'll ship it soon.",
};

// ── Sign-in redirects ──────────────────────────────────────────────────────

/**
 * A `next` path we are willing to redirect to after sign-in: a relative path
 * on this site, never a protocol-relative URL, another scheme or anything
 * with a backslash (browsers read `/\evil.com` as `//evil.com`).
 */
export function safeMemberNext(value: unknown, fallback = "/me"): string {
  if (typeof value !== "string" || value.length > 500) return fallback;
  return /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : fallback;
}

// ── Contribution room ──────────────────────────────────────────────────────

export type ContributionTotals = { yearToDate: SlateAmounts; committed: SlateAmounts; monthIndex: number };

/**
 * How much more a person can give to a slate this year, by exactly the rule
 * the donate form enforces: a probe gift of more than the limit is always
 * refused, and the refusal says what is left.
 */
export function roomLeftCents(slate: Slate, totals: ContributionTotals, limitCents: number): number {
  const probe = checkAnnualLimit({ frequency: "one_time", slateAmounts: { [slate]: limitCents + 1 }, limitCents, ...totals });
  return probe.ok ? limitCents : (probe.remainingCents ?? 0);
}

// ── Pacific weeks ──────────────────────────────────────────────────────────

/** The Sunday-to-Saturday week in Surrey that contains a YYYY-MM-DD date. */
export function pacificWeek(isoDate: string): { start: string; end: string } {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const start = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 6);
  return { start, end: d.toISOString().slice(0, 10) };
}

// ── Tracking cookie (client side) ──────────────────────────────────────────

const SAFE = /^[A-Za-z0-9_.:-]+$/;

/** The cookie value for a visit carrying ?ref= and/or ?source=, merged over what the cookie already holds. */
export function mergeTracking(existing: string | null | undefined, incoming: { ref?: string; source?: string }): string | null {
  const current = new URLSearchParams(existing ?? "");
  const out = new URLSearchParams();
  const ref = clean(incoming.ref, 20) ?? clean(current.get("ref"), 20);
  const source = clean(incoming.source, 80) ?? clean(current.get("source"), 80);
  if (ref) out.set("ref", ref);
  if (source) out.set("source", source);
  const value = out.toString();
  return value ? value : null;
}

function clean(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const v = value.trim().slice(0, max);
  return v && SAFE.test(v) ? v : null;
}

// ── Preferences ────────────────────────────────────────────────────────────

/** Languages a supporter can ask to hear from us in, labelled in their own script. */
export const LOCALES = [
  { id: "en", label: "English" },
  { id: "pa", label: "ਪੰਜਾਬੀ" },
  { id: "hi", label: "हिन्दी" },
  { id: "zh-Hans", label: "简体中文" },
  { id: "zh-Hant", label: "繁體中文" },
  { id: "tl", label: "Tagalog" },
] as const;
export type Locale = (typeof LOCALES)[number]["id"];
export const LOCALE_IDS = LOCALES.map((l) => l.id) as [Locale, ...Locale[]];

/** The message a share sheet starts with when a supporter passes on their link. */
export const SHARE_TEXT = "I’m with Imagine Surrey. Join me:";
