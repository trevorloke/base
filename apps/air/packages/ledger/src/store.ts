import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { ledgerEvents, rawEvents, type Db } from "@base-air/db";
import type { LedgerEvent, LedgerEventInput, RawEventInput } from "@base-air/schema";
import { newId } from "./ids.ts";

/** Stable JSON for hashing: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export interface LedgerQuery {
  workspaceId: string;
  types?: string[];
  subjectType?: string;
  subjectId?: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

/**
 * The event store. Two append-only logs; the database refuses UPDATE/DELETE on both.
 * Everything else in base air is a derivation that could be rebuilt from here.
 */
export class EventStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Append a raw payload. Returns the id, or the existing id when an identical payload was already stored. */
  async appendRaw(input: RawEventInput): Promise<{ id: string; duplicate: boolean }> {
    const hash = hashPayload({ workspaceId: input.workspaceId, source: input.source, kind: input.kind, externalId: input.externalId, payload: input.payload });
    const existing = await this.db.select({ id: rawEvents.id }).from(rawEvents).where(eq(rawEvents.hash, hash)).limit(1);
    if (existing[0]) return { id: existing[0].id, duplicate: true };
    const id = newId("raw");
    await this.db.insert(rawEvents).values({
      id,
      source: input.source,
      kind: input.kind,
      workspaceId: input.workspaceId,
      externalId: input.externalId,
      payload: input.payload as object,
      hash,
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : this.now(),
    });
    return { id, duplicate: false };
  }

  /** Assert a domain fact. */
  async append(input: LedgerEventInput): Promise<LedgerEvent> {
    const id = newId("evt");
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : this.now();
    const [row] = await this.db
      .insert(ledgerEvents)
      .values({
        id,
        workspaceId: input.workspaceId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        actor: input.actor,
        data: input.data ?? {},
        occurredAt,
      })
      .returning();
    return toLedgerEvent(row!);
  }

  async appendMany(inputs: LedgerEventInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db.insert(ledgerEvents).values(
      inputs.map((input) => ({
        id: newId("evt"),
        workspaceId: input.workspaceId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        actor: input.actor,
        data: input.data ?? {},
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : this.now(),
      })),
    );
  }

  async list(q: LedgerQuery): Promise<LedgerEvent[]> {
    const conds = [eq(ledgerEvents.workspaceId, q.workspaceId)];
    if (q.types?.length) conds.push(sql`${ledgerEvents.type} IN (${sql.join(q.types.map((t) => sql`${t}`), sql`, `)})`);
    if (q.subjectType) conds.push(eq(ledgerEvents.subjectType, q.subjectType));
    if (q.subjectId) conds.push(eq(ledgerEvents.subjectId, q.subjectId));
    if (q.afterSeq !== undefined) conds.push(gt(ledgerEvents.seq, q.afterSeq));
    if (q.beforeSeq !== undefined) conds.push(lt(ledgerEvents.seq, q.beforeSeq));
    // Forward paging (afterSeq) reads oldest-first so a cursor walks the log; otherwise newest-first.
    const rows = await this.db
      .select()
      .from(ledgerEvents)
      .where(and(...conds))
      .orderBy(q.afterSeq !== undefined ? asc(ledgerEvents.seq) : desc(ledgerEvents.seq))
      .limit(Math.min(q.limit ?? 100, 1000));
    return rows.map(toLedgerEvent);
  }

  async history(subjectType: string, subjectId: string): Promise<LedgerEvent[]> {
    const rows = await this.db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.subjectType, subjectType), eq(ledgerEvents.subjectId, subjectId)))
      .orderBy(ledgerEvents.seq);
    return rows.map(toLedgerEvent);
  }
}

function toLedgerEvent(row: typeof ledgerEvents.$inferSelect): LedgerEvent {
  return {
    id: row.id,
    seq: Number(row.seq),
    workspaceId: row.workspaceId,
    type: row.type as LedgerEvent["type"],
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    actor: row.actor,
    data: row.data,
    occurredAt: row.occurredAt.toISOString(),
  };
}
