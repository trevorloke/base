import "server-only";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, notInArray, notLike, or, sql, type SQL } from "drizzle-orm";
import { after } from "next/server";
import type { Db } from "@/lib/db";
import { people, deskOutbox } from "@/lib/db/schema";
import { env } from "@/lib/env";
import {
  afterAttempt,
  cleanConsentPayload,
  cleanDeskPerson,
  CONSENT_ENDPOINT,
  NOT_SUPPORTED_YET,
  PEOPLE_ENDPOINT,
  sendToDesk,
  deskUrlProblem,
  stopsRun,
  type ConsentPayload,
  type OutboxPatch,
  type OutboxStatus,
  type DeskAnswer,
  type DeskEndpoint,
  type DeskPerson,
} from "./desk";

// The outbox between the website and base.win. A public route only writes a
// row (enqueueDesk) and asks for delivery after its response
// (deliverSoon); the daily job and the admin "Send now" deliver the rest. So
// base.win being slow, down or misconfigured never fails or slows a form.
//
// Without BASE_WIN_URL and BASE_WIN_KEY rows are still written, as
// "skipped": the admin can see what would have gone, and connecting base.win
// later sends only what comes in from then on instead of a flood of old
// sign-ups (any of them can still be sent one at a time with Retry).

export type OutboxKind = "petition" | "pledge" | "newsletter" | "volunteer-shift" | "membership" | "deletion-request" | "rsvp" | "order" | "follow" | "portal" | "consent";
export const OUTBOX_KINDS: OutboxKind[] = ["petition", "pledge", "newsletter", "volunteer-shift", "membership", "deletion-request", "rsvp", "order", "follow", "portal", "consent"];
export const OUTBOX_STATUSES: OutboxStatus[] = ["pending", "sent", "failed", "skipped"];

export type OutboxRow = typeof deskOutbox.$inferSelect;

const NOT_CONNECTED = "base.win isn't connected (BASE_WIN_URL and BASE_WIN_KEY), so this wasn't sent.";

/**
 * Write one person for base.win. Never throws and returns the row id (the
 * Idempotency-Key), or null when nothing was written: the payload couldn't
 * be sent (no email or phone) or the write itself failed.
 */
export async function enqueueDesk(db: Db, entry: { kind: OutboxKind; personId?: string | null; person: DeskPerson | null }): Promise<string | null> {
  return enqueue(db, entry.kind, PEOPLE_ENDPOINT, entry.personId ?? null, entry.person);
}

/** Write one consent withdrawal for POST /in/v1/consent. Never throws; the row id or null. */
export async function enqueueConsent(db: Db, entry: { personId?: string | null; consent: ConsentPayload | null }): Promise<string | null> {
  return enqueue(db, "consent", CONSENT_ENDPOINT, entry.personId ?? null, entry.consent);
}

async function enqueue(db: Db, kind: OutboxKind, endpoint: DeskEndpoint, personId: string | null, payload: DeskPerson | ConsentPayload | null): Promise<string | null> {
  if (!payload) return null;
  try {
    const enabled = env.deskEnabled;
    const [row] = await db
      .insert(deskOutbox)
      .values({
        kind,
        endpoint,
        personId,
        payload: payload as Record<string, unknown>,
        status: enabled ? "pending" : "skipped",
        lastError: enabled ? null : NOT_CONNECTED,
        nextAttemptAt: enabled ? new Date() : null,
      })
      .returning({ id: deskOutbox.id });
    return row?.id ?? null;
  } catch (err) {
    console.error(`Could not queue a ${kind} for base.win`, err);
    return null;
  }
}

/** Deliver what is due once the response has gone. Outside a request (tests, scripts) the daily job picks it up. */
export function deliverSoon(db: Db): void {
  if (!env.deskEnabled) return;
  try {
    after(async () => {
      await deliverOutbox(db, 8_000);
    });
  } catch {
    // No request scope: nothing to hang it on.
  }
}

// ── Delivery ───────────────────────────────────────────────────────────────

export type DeliveryReport = { sent: number; failed: number; retrying: number; problem: string | null; unsupported: number };

/** What delivery needs from the database, so the loop can be tested without one. */
export interface OutboxStore {
  /** The oldest due pending row (or one of `ids`), leased so no other run sends it at the same time. */
  claimNext(options: { ignoreBackoff: boolean; ids?: string[]; exclude: string[]; excludeEndpoints: string[] }): Promise<OutboxRow | null>;
  save(row: OutboxRow, patch: OutboxPatch): Promise<void>;
}

export type DeliverOptions = {
  /** "Send now" in the admin: pending rows go now, whatever their backoff. */
  ignoreBackoff?: boolean;
  /** Only these rows. */
  ids?: string[];
  send?: (payload: Record<string, unknown>, idempotencyKey: string, endpoint: string) => Promise<DeskAnswer>;
  now?: () => Date;
};

/**
 * Send due pending rows, oldest first, until none are left or `budgetMs` has
 * passed. Stops at the first wrong-key, rate-limit or outage answer (it would
 * be the same for every row). An endpoint base.win doesn't have yet is left
 * out for the rest of the run, and everything else still goes. Never throws.
 */
export async function deliverWith(store: OutboxStore, budgetMs: number, options: DeliverOptions = {}): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, retrying: 0, problem: null, unsupported: 0 };
  const send = options.send ?? ((payload, key, endpoint) => sendToDesk(endpoint, payload, key));
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const tried: string[] = [];
  const unsupported: string[] = [];
  try {
    while (Date.now() - started < budgetMs) {
      const row = await store.claimNext({ ignoreBackoff: Boolean(options.ignoreBackoff), ids: options.ids, exclude: tried, excludeEndpoints: unsupported });
      if (!row) break;
      tried.push(row.id);
      let answer: DeskAnswer;
      try {
        answer = await send(row.payload, row.id, row.endpoint || PEOPLE_ENDPOINT);
      } catch (err) {
        answer = { kind: "retry", status: null, error: err instanceof Error ? err.message : String(err) };
      }
      const patch = afterAttempt(row, answer, now());
      await store.save(row, patch);
      if (patch.status === "sent") report.sent += 1;
      else if (patch.status === "failed") report.failed += 1;
      else if (answer.kind === "retry") report.retrying += 1;
      else if (answer.kind === "unsupported") {
        report.unsupported += 1;
        unsupported.push(row.endpoint);
      }
      if (stopsRun(answer)) {
        report.problem = patch.lastError;
        break;
      }
    }
  } catch (err) {
    console.error("base.win delivery stopped", err);
    report.problem = err instanceof Error ? err.message : String(err);
  }
  return report;
}

// A claimed row is pushed this far ahead while it is being sent; if the
// process dies mid-send the row simply becomes due again.
const LEASE = sql`now() + interval '5 minutes'`;

export function dbOutboxStore(db: Db): OutboxStore {
  return {
    async claimNext({ ignoreBackoff, ids, exclude, excludeEndpoints }) {
      const conditions: (SQL | undefined)[] = [eq(deskOutbox.status, "pending")];
      if (excludeEndpoints.length) conditions.push(notInArray(deskOutbox.endpoint, excludeEndpoints));
      if (!ignoreBackoff) conditions.push(or(isNull(deskOutbox.nextAttemptAt), lte(deskOutbox.nextAttemptAt, sql`now()`)));
      if (ids) conditions.push(ids.length ? inArray(deskOutbox.id, ids) : sql`false`);
      if (exclude.length) conditions.push(notInArray(deskOutbox.id, exclude));
      const next = db
        .select({ id: deskOutbox.id })
        .from(deskOutbox)
        .where(and(...conditions))
        .orderBy(asc(deskOutbox.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      const [row] = await db.update(deskOutbox).set({ nextAttemptAt: LEASE }).where(inArray(deskOutbox.id, next)).returning();
      return row ?? null;
    },
    async save(row, patch) {
      await db.update(deskOutbox).set({ ...patch, ...(patch.status === "sent" ? scrubbedOnceSent(row) : {}) }).where(eq(deskOutbox.id, row.id));
      if (patch.deskPersonId && row.personId) {
        await db.update(people).set({ deskPersonId: patch.deskPersonId }).where(eq(people.id, row.personId));
      }
    },
  };
}

/**
 * A deletion's withdrawal carries the address and number the person asked us
 * to erase, only so base.win can stop contacting them too. Once base.win has
 * it, they are removed from the row here.
 */
export function scrubbedOnceSent(row: Pick<OutboxRow, "endpoint" | "payload">): { payload: Record<string, unknown> } | null {
  if (row.endpoint !== CONSENT_ENDPOINT || row.payload?.reason !== "deletion") return null;
  const { email, phone, ...rest } = row.payload;
  return { payload: { ...rest, ...(email ? { email: "(removed after sending)" } : {}), ...(phone ? { phone: "(removed after sending)" } : {}) } };
}

/** Deliver from the database. Without base.win configured it sends nothing and says why. Never throws. */
export async function deliverOutbox(db: Db, budgetMs = 8_000, options: DeliverOptions = {}): Promise<DeliveryReport> {
  if (!env.deskEnabled) return { sent: 0, failed: 0, retrying: 0, problem: NOT_CONNECTED, unsupported: 0 };
  const problem = deskUrlProblem(env.deskUrl);
  if (problem) return { sent: 0, failed: 0, retrying: 0, problem, unsupported: 0 };
  return deliverWith(dbOutboxStore(db), budgetMs, options);
}

// ── Admin ──────────────────────────────────────────────────────────────────

/** Failed or skipped → pending again with a clean slate, then one attempt now. */
export async function retryOutboxRow(db: Db, id: string): Promise<{ row: OutboxRow | null; report: DeliveryReport | null }> {
  const current = await db.query.deskOutbox.findFirst({ where: eq(deskOutbox.id, id) });
  if (!current) return { row: null, report: null };
  // Cleaned again in case it was written by an older version of the site.
  const clean = current.endpoint === CONSENT_ENDPOINT ? cleanConsentPayload(current.payload) : cleanDeskPerson(current.payload);
  const payload = (clean ?? current.payload) as Record<string, unknown>;
  const [row] = await db
    .update(deskOutbox)
    .set({ status: "pending", attempts: 0, lastError: null, nextAttemptAt: new Date(), payload })
    .where(and(eq(deskOutbox.id, id), inArray(deskOutbox.status, ["failed", "skipped"])))
    .returning();
  if (!row) return { row: current, report: null };
  const report = env.deskEnabled ? await deliverOutbox(db, 15_000, { ids: [id] }) : null;
  const fresh = await db.query.deskOutbox.findFirst({ where: eq(deskOutbox.id, id) });
  return { row: fresh ?? row, report };
}

/** Pending or failed → skipped: staff decided it shouldn't go. */
export async function skipOutboxRow(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(deskOutbox)
    .set({ status: "skipped", nextAttemptAt: null, lastError: sql`coalesce(${deskOutbox.lastError}, 'Skipped by staff')` })
    .where(and(eq(deskOutbox.id, id), inArray(deskOutbox.status, ["pending", "failed"])))
    .returning({ id: deskOutbox.id });
  return rows.length > 0;
}

export type OutboxStats = {
  counts: Record<OutboxStatus, number>;
  lastError: { message: string; at: Date | null; status: OutboxStatus } | null;
  oldestPendingAt: Date | null;
  lastSentAt: Date | null;
  /** Consent withdrawals: waiting in all, and of those, waiting because base.win answered "not supported yet". */
  consent: { pending: number; notSupported: number; sent: number };
};

export async function outboxStats(db: Db): Promise<OutboxStats> {
  const counts: Record<OutboxStatus, number> = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  const byStatus = await db.select({ status: deskOutbox.status, n: count() }).from(deskOutbox).groupBy(deskOutbox.status);
  for (const r of byStatus) counts[r.status] = Number(r.n);
  const [problem] = await db
    .select({ message: deskOutbox.lastError, at: deskOutbox.lastAttemptAt, status: deskOutbox.status })
    .from(deskOutbox)
    .where(
      and(
        isNotNull(deskOutbox.lastError),
        isNotNull(deskOutbox.lastAttemptAt),
        inArray(deskOutbox.status, ["pending", "failed"]),
        // "Not supported yet" is shown on its own line, not as the last problem.
        notLike(deskOutbox.lastError, `${NOT_SUPPORTED_YET}%`),
      ),
    )
    .orderBy(desc(deskOutbox.lastAttemptAt))
    .limit(1);
  const [times] = await db
    .select({
      oldestPending: sql<Date | string | null>`min(${deskOutbox.createdAt}) filter (where ${deskOutbox.status} = 'pending')`,
      lastSent: sql<Date | string | null>`max(${deskOutbox.sentAt})`,
      consentPending: sql<number>`count(*) filter (where ${deskOutbox.endpoint} = ${CONSENT_ENDPOINT} and ${deskOutbox.status} = 'pending')::int`,
      consentNotSupported: sql<number>`count(*) filter (where ${deskOutbox.endpoint} = ${CONSENT_ENDPOINT} and ${deskOutbox.status} = 'pending' and ${deskOutbox.lastError} like ${`${NOT_SUPPORTED_YET}%`})::int`,
      consentSent: sql<number>`count(*) filter (where ${deskOutbox.endpoint} = ${CONSENT_ENDPOINT} and ${deskOutbox.status} = 'sent')::int`,
    })
    .from(deskOutbox);
  const toDate = (v: Date | string | null | undefined) => (v ? (v instanceof Date ? v : new Date(v)) : null);
  return {
    counts,
    lastError: problem?.message ? { message: problem.message, at: problem.at, status: problem.status } : null,
    oldestPendingAt: toDate(times?.oldestPending),
    lastSentAt: toDate(times?.lastSent),
    consent: { pending: Number(times?.consentPending ?? 0), notSupported: Number(times?.consentNotSupported ?? 0), sent: Number(times?.consentSent ?? 0) },
  };
}

export const OUTBOX_PAGE_SIZE = 50;

export type OutboxFilters = { status: OutboxStatus | ""; kind: OutboxKind | ""; page: number };

export function parseOutboxFilters(sp: Record<string, string | string[] | undefined>): OutboxFilters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) ?? "";
  const status = OUTBOX_STATUSES.find((s) => s === one("status")) ?? "";
  const kind = OUTBOX_KINDS.find((k) => k === one("kind")) ?? "";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(one("page"), 10) || 1));
  return { status, kind, page };
}

/** The outbox, newest first, with the person's email for the list. */
export async function listOutbox(db: Db, f: OutboxFilters) {
  const where = and(f.status ? eq(deskOutbox.status, f.status) : undefined, f.kind ? eq(deskOutbox.kind, f.kind) : undefined);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ row: deskOutbox, email: people.email })
      .from(deskOutbox)
      .leftJoin(people, eq(people.id, deskOutbox.personId))
      .where(where)
      .orderBy(desc(deskOutbox.createdAt))
      .limit(OUTBOX_PAGE_SIZE)
      .offset((f.page - 1) * OUTBOX_PAGE_SIZE),
    db.select({ total: count() }).from(deskOutbox).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.row, email: r.email })), total: Number(total) };
}

/** One supporter's rows, newest first, for their admin profile. */
export async function outboxForPerson(db: Db, personId: string, limit = 20): Promise<OutboxRow[]> {
  return db.select().from(deskOutbox).where(eq(deskOutbox.personId, personId)).orderBy(desc(deskOutbox.createdAt)).limit(limit);
}
