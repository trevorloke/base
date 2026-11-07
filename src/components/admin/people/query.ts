// The supporter list's search, filters, sort and page live in the URL, so a
// view can be bookmarked, shared with another organizer, and exported as it
// stands. This module is pure (no server imports) so pages, the export route
// and the unit tests all agree on how a URL reads.

export const MEMBERSHIP_FILTERS = [
  { id: "", label: "Any" },
  { id: "active", label: "Active member" },
  { id: "expired", label: "Expired member" },
  { id: "pending", label: "Pending payment" },
  { id: "none", label: "Never a member" },
] as const;
export type MembershipFilter = (typeof MEMBERSHIP_FILTERS)[number]["id"];

export const NEWSLETTER_FILTERS = [
  { id: "", label: "Any" },
  { id: "subscribed", label: "Subscribed" },
  { id: "pending", label: "Waiting for confirmation" },
  { id: "unsubscribed", label: "Unsubscribed" },
  { id: "none", label: "Not on the list" },
] as const;
export type NewsletterFilter = (typeof NEWSLETTER_FILTERS)[number]["id"];

export const SMS_FILTERS = [
  { id: "", label: "Any" },
  { id: "yes", label: "Consented to texts" },
  { id: "no", label: "No text consent" },
] as const;
export type SmsFilter = (typeof SMS_FILTERS)[number]["id"];

export const SORTS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "name", label: "Name A to Z" },
  { id: "email", label: "Email A to Z" },
  { id: "neighbourhood", label: "Neighbourhood" },
  { id: "updated", label: "Recently updated" },
] as const;
export type Sort = (typeof SORTS)[number]["id"];

/** Preferred language for emails and texts (people.locale). */
export const LOCALES = [
  { id: "", label: "Not set" },
  { id: "en", label: "English" },
  { id: "pa", label: "Punjabi" },
  { id: "hi", label: "Hindi" },
  { id: "zh-Hans", label: "Chinese (Simplified)" },
  { id: "zh-Hant", label: "Chinese (Traditional)" },
  { id: "tl", label: "Tagalog" },
] as const;

export const PAGE_SIZE = 50;
export const MAX_QUERY_LENGTH = 80;
export const MAX_TAG_LENGTH = 40;

export type PeopleQuery = {
  q: string;
  membership: MembershipFilter;
  neighbourhood: string;
  volunteer: boolean;
  lawnsign: boolean;
  tag: string;
  source: string;
  newsletter: NewsletterFilter;
  sms: SmsFilter;
  donated: boolean;
  language: string;
  sort: Sort;
  page: number;
};

export const DEFAULT_QUERY: PeopleQuery = {
  q: "",
  membership: "",
  neighbourhood: "",
  volunteer: false,
  lawnsign: false,
  tag: "",
  source: "",
  newsletter: "",
  sms: "",
  donated: false,
  language: "",
  sort: "newest",
  page: 1,
};

/** The URL keys, which are also the form field names and the bulk-action hidden fields. */
export const QUERY_KEYS = Object.keys(DEFAULT_QUERY) as (keyof PeopleQuery)[];

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function read(sp: Params, key: string): string {
  const v = sp instanceof URLSearchParams ? sp.get(key) : sp[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first : "";
}

const oneOf = <T extends string>(value: string, allowed: readonly { id: T }[]): T => (allowed.some((a) => a.id === value) ? (value as T) : allowed[0].id);
const flag = (value: string) => value === "1" || value === "on" || value === "true";
const text = (value: string, max: number) => value.trim().replace(/\s+/g, " ").slice(0, max);

/**
 * Read a list view from search params; anything unexpected falls back to the
 * default. The "donated this year" filter is money data: it is read only when
 * the viewer has the money permission, so nobody can list donors through the
 * URL (or a bulk action or export carrying the same query) without it.
 */
export function parsePeopleQuery(sp: Params, options: { money: boolean } = { money: false }): PeopleQuery {
  const page = Number.parseInt(read(sp, "page"), 10);
  return {
    q: text(read(sp, "q"), MAX_QUERY_LENGTH),
    membership: oneOf(read(sp, "membership"), MEMBERSHIP_FILTERS),
    neighbourhood: text(read(sp, "neighbourhood"), 40),
    volunteer: flag(read(sp, "volunteer")),
    lawnsign: flag(read(sp, "lawnsign")),
    tag: text(read(sp, "tag"), MAX_TAG_LENGTH),
    source: text(read(sp, "source"), 80),
    newsletter: oneOf(read(sp, "newsletter"), NEWSLETTER_FILTERS),
    sms: oneOf(read(sp, "sms"), SMS_FILTERS),
    donated: options.money && flag(read(sp, "donated")),
    language: text(read(sp, "language"), 40),
    sort: oneOf(read(sp, "sort"), SORTS),
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
  };
}

/** Only the parts that differ from the default go in the URL, so it stays short. */
export function peopleParams(query: PeopleQuery, overrides: Partial<PeopleQuery> = {}): URLSearchParams {
  const q = { ...query, ...overrides };
  const out = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = q[key];
    if (value === DEFAULT_QUERY[key]) continue;
    out.set(key, typeof value === "boolean" ? "1" : String(value));
  }
  return out;
}

export function peopleHref(query: PeopleQuery, overrides: Partial<PeopleQuery> = {}, path = "/admin/people"): string {
  const params = peopleParams(query, overrides).toString();
  return params ? `${path}?${params}` : path;
}

export function hasFilters(query: PeopleQuery): boolean {
  return QUERY_KEYS.some((key) => key !== "page" && key !== "sort" && query[key] !== DEFAULT_QUERY[key]);
}

/** Human-readable chips for the active filters, e.g. "Tag: lawn-sign-2026". */
export function describeQuery(query: PeopleQuery): string[] {
  const out: string[] = [];
  if (query.q) out.push(`Search: ${query.q}`);
  if (query.membership) out.push(`Membership: ${MEMBERSHIP_FILTERS.find((m) => m.id === query.membership)?.label}`);
  if (query.neighbourhood) out.push(`Neighbourhood: ${query.neighbourhood}`);
  if (query.volunteer) out.push("Wants to volunteer");
  if (query.lawnsign) out.push("Wants a lawn sign");
  if (query.tag) out.push(`Tag: ${query.tag}`);
  if (query.source) out.push(`Source: ${query.source}`);
  if (query.newsletter) out.push(`Newsletter: ${NEWSLETTER_FILTERS.find((n) => n.id === query.newsletter)?.label}`);
  if (query.sms) out.push(SMS_FILTERS.find((s) => s.id === query.sms)?.label ?? "");
  if (query.donated) out.push("Donated this year");
  if (query.language) out.push(`Language: ${query.language}`);
  return out.filter(Boolean);
}

/** Escape a search term for ILIKE, so "100%" matches a literal percent sign. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A tag as stored: trimmed, single spaces, no commas, at most 40 characters. */
export function normalizeTag(raw: string): string {
  return raw.replace(/,/g, " ").trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH);
}
