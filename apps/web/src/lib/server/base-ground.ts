import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { formatLongDate, SLOT_BY_ID, type Slot } from "@/lib/shifts";

// The website's side of base ground ("the desk"), the campaign's database app.
// base ground takes people in through a small JSON API with a website key:
//
//   Authorization: Bearer sbk_…
//   GET  /in/v1/ping     → { ok, campaign, key }
//   POST /in/v1/people   → { ok: true, person_id }   (Idempotency-Key header)
//   POST /in/v1/consent  → { ok: true }              (Idempotency-Key header)
//
// It is called from this server only, never from a visitor's browser, which
// would show the key to anyone. Its body schema is strict: any field outside
// BASE_GROUND_FIELDS, or any value over its length, is refused with a 400, so
// every payload is built by cleanBaseGroundPerson, which mirrors that schema.
// Money, ratings and roles are never sent: gifts are logged at the desk
// (Donations → Log a gift), where the contribution limits are checked. RSVPs,
// paid shop orders and promise follows go as tags on the person, nothing more.
//
// /in/v1/consent carries withdrawals (unsubscribe, text STOP, a preference
// change, a deletion) so both apps stop contacting the person. base ground may
// not have it yet: a 404 there means "not supported yet", and those rows wait.

// ── The payload ────────────────────────────────────────────────────────────

/** Every field POST /in/v1/people accepts, in the order they are sent. */
export const BASE_GROUND_FIELDS = ["name", "first_name", "last_name", "email", "phone", "address", "unit", "city", "postal", "tags", "newsletter", "volunteer", "note", "source"] as const;
export type BaseGroundField = (typeof BASE_GROUND_FIELDS)[number];

/** base ground's own limits (server/ext/intake/index.js), counted after trimming. */
export const BASE_GROUND_LIMITS = {
  name: 300,
  first_name: 150,
  last_name: 150,
  email: 320,
  phone: 40,
  address: 1000,
  unit: 40,
  city: 120,
  postal: 20,
  note: 2000,
  source: 80,
  /** Characters per tag. */
  tag: 40,
  /** Tags per person. */
  tags: 20,
} as const;

export type BaseGroundPerson = {
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  unit?: string;
  city?: string;
  postal?: string;
  tags?: string[];
  newsletter?: true;
  volunteer?: true;
  note?: string;
  source?: string;
};

type Text = string | null | undefined;

/** What a website form gave, in the website's own names. Only these are read. */
export type BaseGroundPersonInput = {
  name?: Text;
  firstName?: Text;
  lastName?: Text;
  email?: Text;
  phone?: Text;
  address?: Text;
  unit?: Text;
  city?: Text;
  postalCode?: Text;
  tags?: Text[];
  newsletter?: boolean | null;
  volunteer?: boolean | null;
  note?: Text;
  source?: Text;
};

/** Trimmed and cut to `max` characters (never through the middle of a character pair); undefined when empty. */
function cap(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let s = value.trim();
  if (s.length > max) {
    s = s.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s || undefined;
}

const emailSchema = z.email();

/** Lower-cased and checked the way base ground checks it; undefined when it would be refused. */
function cleanEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim().toLowerCase();
  if (!s || s.length > BASE_GROUND_LIMITS.email || !emailSchema.safeParse(s).success) return undefined;
  return s;
}

/** "Petition:  Transit " → "Petition: Transit", at most 40 characters. */
function cleanTag(value: unknown): string | undefined {
  return typeof value === "string" ? cap(value.replace(/\s+/g, " "), BASE_GROUND_LIMITS.tag) : undefined;
}

/** A lowercase word for where the person came from: "petition:skytrain" → "petition-skytrain". */
export function sourceWord(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const word = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cap(word, BASE_GROUND_LIMITS.source)?.replace(/-+$/, "") || undefined;
}

/**
 * A body POST /in/v1/people will accept, from one in its own field names:
 * trimmed, empty values dropped, every text cut to base ground's limit, the
 * email lower-cased (and dropped if base ground would refuse it), at most 20
 * tags of 40 characters, the two flags sent only when true, and nothing
 * outside BASE_GROUND_FIELDS. Null when it can't be sent: base ground needs an
 * email or a phone, and a name or an email.
 */
export function cleanBaseGroundPerson(raw: Record<string, unknown> | null | undefined): BaseGroundPerson | null {
  if (!raw || typeof raw !== "object") return null;
  const out: BaseGroundPerson = {};
  const text = (field: Exclude<BaseGroundField, "email" | "tags" | "newsletter" | "volunteer" | "source">) => {
    const v = cap(raw[field], BASE_GROUND_LIMITS[field]);
    if (v) out[field] = v;
  };
  text("name");
  text("first_name");
  text("last_name");
  const email = cleanEmail(raw.email);
  if (email) out.email = email;
  text("phone");
  text("address");
  text("unit");
  text("city");
  text("postal");
  if (Array.isArray(raw.tags)) {
    const tags = [...new Set(raw.tags.map(cleanTag).filter((t): t is string => Boolean(t)))].slice(0, BASE_GROUND_LIMITS.tags);
    if (tags.length) out.tags = tags;
  }
  if (raw.newsletter === true && out.email) out.newsletter = true;
  if (raw.volunteer === true) out.volunteer = true;
  text("note");
  const source = sourceWord(raw.source);
  if (source) out.source = source;

  if (!out.email && !out.phone) return null;
  if (!out.name && !out.first_name && !out.last_name && !out.email) return null;
  // Rebuilt in the fixed field order, so the same person always serializes the same way.
  return Object.fromEntries(BASE_GROUND_FIELDS.filter((f) => out[f] !== undefined).map((f) => [f, out[f]])) as BaseGroundPerson;
}

/** The payload for one website submission, from the website's field names. See cleanBaseGroundPerson. */
export function toBaseGroundPerson(input: BaseGroundPersonInput): BaseGroundPerson | null {
  return cleanBaseGroundPerson({
    name: input.name,
    first_name: input.firstName,
    last_name: input.lastName,
    email: input.email,
    phone: input.phone,
    address: input.address,
    unit: input.unit,
    city: input.city,
    postal: typeof input.postalCode === "string" ? input.postalCode.toUpperCase() : input.postalCode,
    tags: input.tags,
    newsletter: input.newsletter === true,
    volunteer: input.volunteer === true,
    note: input.note,
    source: input.source,
  });
}

// ── What each form forwards ────────────────────────────────────────────────
// Only what the person typed into that form, and only once the website has
// accepted it.

/** A petition or pledge signature. `newsletter` only when the consent grant was recorded. */
export function signaturePerson(s: {
  kind: "petition" | "pledge";
  slug: string;
  title: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: Text;
  address?: Text;
  postalCode?: Text;
  newsletter: boolean;
}): BaseGroundPerson | null {
  return toBaseGroundPerson({
    firstName: s.firstName,
    lastName: s.lastName,
    email: s.email,
    phone: s.phone,
    address: s.address,
    postalCode: s.postalCode,
    tags: [`${s.kind === "pledge" ? "Pledge" : "Petition"}: ${s.title}`],
    source: `petition-${s.slug}`,
    newsletter: s.newsletter,
  });
}

/** A newsletter address that has just become subscribed on the website. */
export function newsletterPerson(s: { email: string; source?: Text }): BaseGroundPerson | null {
  return toBaseGroundPerson({ email: s.email, newsletter: true, source: `newsletter-${s.source || "website"}` });
}

/** "Signed up for Door-knocking in Newton, Saturday, November 7, 9 a.m.–12 p.m. at Newton Library" */
export function shiftNote(opening: { title: string; date: string; slot: Slot; location?: string | null }): string {
  const where = opening.location?.trim() ? ` at ${opening.location.trim()}` : "";
  return `Signed up for ${opening.title}, ${formatLongDate(opening.date)}, ${SLOT_BY_ID[opening.slot].hours}${where}`;
}

/** A volunteer shift sign-up: a "Wants to volunteer" request at the desk, with the shift in the note. */
export function shiftPerson(s: {
  name: string;
  email: string;
  phone?: Text;
  postalCode?: Text;
  opening: { title: string; date: string; slot: Slot; location?: string | null };
  newsletter: boolean;
}): BaseGroundPerson | null {
  return toBaseGroundPerson({
    name: s.name,
    email: s.email,
    phone: s.phone,
    postalCode: s.postalCode,
    volunteer: true,
    note: shiftNote(s.opening),
    source: "volunteer-shift",
    newsletter: s.newsletter,
  });
}

export const MEMBER_TAG = "Member (joined online)";

/**
 * A membership that has become active, from the details given on its form
 * (the membership snapshot). Deliberately takes no fee: nothing about money
 * ever goes to base ground.
 */
export function membershipPerson(m: {
  memberName: Text;
  email: string;
  memberPhone?: Text;
  memberAddress?: Text;
  memberCity?: Text;
  memberPostalCode?: Text;
  interestVolunteer: boolean;
  interestLawnSign: boolean;
  updatesConsent: boolean;
}): BaseGroundPerson | null {
  const note = m.interestLawnSign ? (m.interestVolunteer ? "Wants to volunteer. Asked for a lawn sign" : "Asked for a lawn sign") : undefined;
  return toBaseGroundPerson({
    name: m.memberName,
    email: m.email,
    phone: m.memberPhone,
    address: m.memberAddress,
    city: m.memberCity,
    postalCode: m.memberPostalCode,
    tags: [MEMBER_TAG],
    source: "membership",
    volunteer: m.interestVolunteer,
    note,
    newsletter: m.updatesConsent,
  });
}

/** "Delete my account" from the supporter portal: a request for the desk, with the email and name only. */
export function deletionRequestPerson(p: { firstName?: Text; lastName?: Text; email: string; date: string }): BaseGroundPerson | null {
  return toBaseGroundPerson({
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    note: `Asked us to delete their data (supporter portal, ${p.date}). Please action it in base ground too.`,
    source: "supporter-portal",
  });
}

// ── Engagement tags ────────────────────────────────────────────────────────
// So the desk sees who is engaged. A tag on the person and nothing else: no
// amounts, items, guests or anything about payment.

export const MERCH_TAG = "Bought merch";

/** "RSVP: Town hall in Newton" for an event RSVP. */
export function rsvpPerson(r: { name?: Text; email: string; eventTitle: string }): BaseGroundPerson | null {
  return toBaseGroundPerson({ name: r.name, email: r.email, tags: [`RSVP: ${r.eventTitle}`], source: "rsvp" });
}

/** A paid shop order: the "Bought merch" tag. Deliberately takes no amount or items. */
export function orderPerson(o: { firstName?: Text; lastName?: Text; email: string }): BaseGroundPerson | null {
  return toBaseGroundPerson({ firstName: o.firstName, lastName: o.lastName, email: o.email, tags: [MERCH_TAG], source: "shop" });
}

/** A confirmed promise-tracker follow: "Follows: promise 12". */
export function followPerson(f: { email: string; number: number }): BaseGroundPerson | null {
  return toBaseGroundPerson({ email: f.email, tags: [`Follows: promise ${f.number}`], source: "tracker" });
}

/**
 * Details a signed-in supporter changed in the portal (/me/preferences).
 * base ground fills blanks only, the same rule as every sign-up, so what is on
 * file there is never overwritten.
 */
export function portalPerson(p: { firstName?: Text; lastName?: Text; email: string; phone?: Text; address?: Text; postalCode?: Text }): BaseGroundPerson | null {
  return toBaseGroundPerson({ firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone, address: p.address, postalCode: p.postalCode, source: "portal" });
}

// ── Consent withdrawals (POST /in/v1/consent) ──────────────────────────────

export const CONSENT_CHANNELS = ["email", "sms"] as const;
export type ConsentSyncChannel = (typeof CONSENT_CHANNELS)[number];
export const CONSENT_REASONS = ["unsubscribe", "stop", "preference", "deletion"] as const;
export type ConsentReason = (typeof CONSENT_REASONS)[number];

/** The body of POST /in/v1/consent, both ways. Only withdrawals are ever sent. */
export type ConsentPayload = {
  email?: string;
  phone?: string;
  channel: ConsentSyncChannel;
  action: "withdraw";
  reason: ConsentReason;
  /** When it happened on this side, ISO 8601. */
  at: string;
};

/**
 * A withdrawal base ground can match: the email (checked and lower-cased) or the
 * phone, the channel, the reason and the time. Null when there is nothing to
 * match on, or the channel or reason is unknown.
 */
export function cleanConsentPayload(raw: Record<string, unknown> | null | undefined): ConsentPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const channel = CONSENT_CHANNELS.find((c) => c === raw.channel);
  const reason = CONSENT_REASONS.find((r) => r === raw.reason);
  if (!channel || !reason || raw.action !== "withdraw") return null;
  const email = cleanEmail(raw.email);
  const phone = cap(raw.phone, BASE_GROUND_LIMITS.phone);
  if (!email && !phone) return null;
  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : new Date().toISOString();
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}), channel, action: "withdraw", reason, at };
}

/** A withdrawal recorded on the website, for base ground. */
export function consentPayload(w: { email?: Text; phone?: Text; channel: ConsentSyncChannel; reason: ConsentReason; at?: Date }): ConsentPayload | null {
  return cleanConsentPayload({ email: w.email, phone: w.phone, channel: w.channel, action: "withdraw", reason: w.reason, at: (w.at ?? new Date()).toISOString() });
}

/**
 * JSON with keys in sorted order at every level. base ground compares the raw
 * body of a retry with the first one (same Idempotency-Key, different body is
 * a 409), and a payload read back from a jsonb column can come back with its
 * keys reordered, so every send serializes this way.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

// ── The client ─────────────────────────────────────────────────────────────

export const BASE_GROUND_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;
export type BaseGroundConfig = { url?: string; key?: string; fetch?: Fetch; timeoutMs?: number };

/** Why the configured address can't be used, or null. The key must never travel unencrypted. */
export function baseGroundUrlProblem(url: string | undefined): string | null {
  if (!url) return "BASE_GROUND_URL is not set.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "BASE_GROUND_URL is not a web address (e.g. https://base.win/imaginesurrey).";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) return "BASE_GROUND_URL must start with https://, so the key is never sent unencrypted.";
  return null;
}

function config(c: BaseGroundConfig = {}) {
  return { url: c.url ?? env.baseGroundUrl, key: c.key ?? env.baseGroundKey, fetch: c.fetch ?? fetch, timeoutMs: c.timeoutMs ?? BASE_GROUND_TIMEOUT_MS };
}

/** base ground's two intake endpoints. Every outbox row names the one it goes to. */
export const PEOPLE_ENDPOINT = "/in/v1/people";
export const CONSENT_ENDPOINT = "/in/v1/consent";
export type BaseGroundEndpoint = typeof PEOPLE_ENDPOINT | typeof CONSENT_ENDPOINT;
export const BASE_GROUND_ENDPOINTS: BaseGroundEndpoint[] = [PEOPLE_ENDPOINT, CONSENT_ENDPOINT];

/** How a waiting row says base ground has no consent endpoint yet (never starts with a status, so it isn't read as a key problem). */
export const NOT_SUPPORTED_YET = "Not supported yet";

/**
 * What one call came to:
 *   ok           base ground took it (a replay of an earlier answer counts)
 *   refused      400, 409, 415 or another 4xx: this body will never be taken as it is
 *   config       401, 403, 404: the key or address is wrong; nothing about the row is
 *   unsupported  a 404 from /in/v1/consent: this base ground doesn't take consent yet
 *   retry        429, 5xx, a timeout, a network error or an answer we can't read
 */
export type BaseGroundAnswer =
  | { kind: "ok"; personId: string | null; replayed: boolean }
  | { kind: "refused"; status: number; error: string }
  | { kind: "config"; status: number; error: string }
  | { kind: "unsupported"; status: number; error: string }
  | { kind: "retry"; status: number | null; error: string };

/** Sort an HTTP answer from one of the intake endpoints into a BaseGroundAnswer. */
export function classifyAnswer(status: number, body: unknown, endpoint: string = PEOPLE_ENDPOINT): BaseGroundAnswer {
  const b = (body && typeof body === "object" ? body : {}) as { ok?: unknown; person_id?: unknown; replayed?: unknown; error?: unknown };
  const message = typeof b.error === "string" && b.error ? b.error.slice(0, 500) : `HTTP ${status}`;
  if (status >= 200 && status < 300) {
    const personId = typeof b.person_id === "string" && b.person_id ? b.person_id : null;
    // A person always comes back with base ground's id; a consent change needs only ok.
    if (b.ok === true && (personId || endpoint === CONSENT_ENDPOINT)) return { kind: "ok", personId, replayed: b.replayed === true };
    return { kind: "retry", status, error: endpoint === CONSENT_ENDPOINT ? "base ground answered without ok" : "base ground answered without a person id" };
  }
  if (status === 404 && endpoint === CONSENT_ENDPOINT) return { kind: "unsupported", status, error: `${NOT_SUPPORTED_YET}: this base ground has no ${CONSENT_ENDPOINT} (404), so the withdrawal waits here until it does` };
  if (status === 401 || status === 403 || status === 404) return { kind: "config", status, error: message };
  if (status === 429 || status === 408 || status >= 500) return { kind: "retry", status, error: message };
  return { kind: "refused", status, error: message };
}

/**
 * POST one body to an intake endpoint. The Idempotency-Key makes a retry
 * safe: base ground answers a repeat of the same key and body with its first
 * answer. Never throws.
 */
export async function sendToBaseGround(endpoint: string, payload: Record<string, unknown>, idempotencyKey: string, c?: BaseGroundConfig): Promise<BaseGroundAnswer> {
  const { url, key, fetch: doFetch, timeoutMs } = config(c);
  const problem = baseGroundUrlProblem(url) ?? (key ? null : "BASE_GROUND_KEY is not set.");
  if (problem) return { kind: "config", status: 0, error: problem };
  if (!(BASE_GROUND_ENDPOINTS as string[]).includes(endpoint)) return { kind: "refused", status: 0, error: `Unknown base ground endpoint ${endpoint}` };
  let res: Response;
  try {
    res = await doFetch(`${url}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": idempotencyKey.slice(0, 200),
      },
      body: stableJson(payload),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { kind: "retry", status: null, error: timedOut ? `No answer within ${Math.round(timeoutMs / 1000)} seconds` : `Could not reach base ground: ${err instanceof Error ? err.message : String(err)}` };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return classifyAnswer(res.status, body, endpoint);
}

/** POST one person to /in/v1/people. Never throws. */
export async function sendPerson(payload: BaseGroundPerson | Record<string, unknown>, idempotencyKey: string, c?: BaseGroundConfig): Promise<BaseGroundAnswer> {
  return sendToBaseGround(PEOPLE_ENDPOINT, payload as Record<string, unknown>, idempotencyKey, c);
}

export type PingResult = { ok: true; campaign: string; key: string } | { ok: false; status: number | null; error: string };

/** GET /in/v1/ping: is the key good, and for which campaign? Never throws. */
export async function ping(c?: BaseGroundConfig): Promise<PingResult> {
  const { url, key, fetch: doFetch, timeoutMs } = config(c);
  const problem = baseGroundUrlProblem(url) ?? (key ? null : "BASE_GROUND_KEY is not set.");
  if (problem) return { ok: false, status: null, error: problem };
  try {
    const res = await doFetch(`${url}/in/v1/ping`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; campaign?: unknown; key?: unknown; error?: unknown } | null;
    if (res.ok && body?.ok === true) return { ok: true, campaign: String(body.campaign ?? ""), key: String(body.key ?? "") };
    return { ok: false, status: res.status, error: typeof body?.error === "string" ? body.error : `HTTP ${res.status}` };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, status: null, error: timedOut ? `No answer within ${Math.round(timeoutMs / 1000)} seconds` : `Could not reach base ground: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Delivery: what happens to an outbox row after one attempt ─────────────

/** Waits after the 1st, 2nd, 3rd, 4th and every later failed attempt. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
/** A row that still can't be delivered after this many attempts is marked failed. */
export const MAX_ATTEMPTS = 8;

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

export type OutboxStatus = "pending" | "sent" | "failed" | "skipped";

export type OutboxPatch = {
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date;
  nextAttemptAt: Date | null;
  baseGroundPersonId?: string;
  sentAt?: Date;
};

/** How long a consent row waits after a "not supported yet" before it is tried again. */
export const UNSUPPORTED_WAIT_MS = 6 * 3_600_000;

/**
 * The row after one attempt:
 *   ok           → sent, with the id base ground answered (people only)
 *   refused      → failed for good, with base ground's message (staff can Retry it)
 *   config       → still pending and due, attempts unchanged: a wrong key or
 *                  address is not the row's fault, and is shown in the admin
 *   unsupported  → still pending, attempts unchanged, tried again in 6 hours
 *                  (or at once with "Send now"): never failed for it
 *   retry        → pending again after 1 min, 5 min, 30 min, 2 h, then every
 *                  12 h; failed once MAX_ATTEMPTS attempts have been made
 */
export function afterAttempt(row: { attempts: number }, answer: BaseGroundAnswer, now: Date): OutboxPatch {
  const attempts = row.attempts + 1;
  switch (answer.kind) {
    case "ok":
      return { status: "sent", attempts, lastError: null, lastAttemptAt: now, nextAttemptAt: null, ...(answer.personId ? { baseGroundPersonId: answer.personId } : {}), sentAt: now };
    case "refused":
      return { status: "failed", attempts, lastError: `${answer.status}: ${answer.error}`, lastAttemptAt: now, nextAttemptAt: null };
    case "config":
      return { status: "pending", attempts: row.attempts, lastError: `${answer.status || "Not configured"}: ${answer.error}`, lastAttemptAt: now, nextAttemptAt: now };
    case "unsupported":
      return { status: "pending", attempts: row.attempts, lastError: answer.error, lastAttemptAt: now, nextAttemptAt: new Date(now.getTime() + UNSUPPORTED_WAIT_MS) };
    case "retry": {
      const lastError = `${answer.status ?? "No answer"}: ${answer.error}`;
      if (attempts >= MAX_ATTEMPTS) return { status: "failed", attempts, lastError: `${lastError} (gave up after ${attempts} attempts)`, lastAttemptAt: now, nextAttemptAt: null };
      return { status: "pending", attempts, lastError, lastAttemptAt: now, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)) };
    }
  }
}

/**
 * A wrong key, a rate limit or an outage affects every row, so the run stops
 * there. "Not supported yet" affects only that endpoint: the run goes on
 * without it.
 */
export function stopsRun(answer: BaseGroundAnswer): boolean {
  return answer.kind === "config" || answer.kind === "retry";
}
