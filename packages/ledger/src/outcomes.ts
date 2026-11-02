import { and, eq, lte } from "drizzle-orm";
import { postOutcomes, type Db } from "@starsign/db";
import { OUTCOME_OFFSETS, type Actor } from "@starsign/schema";
import { newId } from "./ids.ts";
import type { EventStore } from "./store.ts";

/**
 * Outcome snapshots: every published variant gets a row per fixed offset (1h ... 30d).
 * Workers capture them when due. This is the spine of the outcome ledger.
 */
export class OutcomeScheduler {
  constructor(
    private readonly db: Db,
    private readonly events: EventStore,
  ) {}

  async schedule(params: { workspaceId: string; postId: string; variantId: string; publishedAt: Date; actor: Actor }): Promise<string[]> {
    const ids: string[] = [];
    await this.db
      .insert(postOutcomes)
      .values(
        OUTCOME_OFFSETS.map((o) => {
          const id = newId("out");
          ids.push(id);
          return {
            id,
            workspaceId: params.workspaceId,
            postId: params.postId,
            variantId: params.variantId,
            offsetLabel: o.label,
            dueAt: new Date(params.publishedAt.getTime() + o.minutes * 60_000),
            status: "due" as const,
          };
        }),
      )
      .onConflictDoNothing();
    await this.events.append({
      workspaceId: params.workspaceId,
      type: "outcome.scheduled",
      subjectType: "post_variant",
      subjectId: params.variantId,
      actor: params.actor,
      data: { offsets: OUTCOME_OFFSETS.map((o) => o.label), publishedAt: params.publishedAt.toISOString() },
    });
    return ids;
  }

  async due(now: Date, limit = 200) {
    return this.db
      .select()
      .from(postOutcomes)
      .where(and(eq(postOutcomes.status, "due"), lte(postOutcomes.dueAt, now)))
      .orderBy(postOutcomes.dueAt)
      .limit(limit);
  }

  async capture(params: { outcomeId: string; metrics: Record<string, number>; capturedAt: Date; actor: Actor }): Promise<void> {
    const [row] = await this.db
      .update(postOutcomes)
      .set({ status: "captured", metrics: params.metrics, capturedAt: params.capturedAt })
      .where(eq(postOutcomes.id, params.outcomeId))
      .returning();
    if (!row) return;
    await this.events.append({
      workspaceId: row.workspaceId,
      type: "outcome.captured",
      subjectType: "post_variant",
      subjectId: row.variantId,
      actor: params.actor,
      data: { offset: row.offsetLabel, metrics: params.metrics, outcomeId: row.id },
    });
  }

  async skip(outcomeId: string): Promise<void> {
    await this.db.update(postOutcomes).set({ status: "skipped" }).where(eq(postOutcomes.id, outcomeId));
  }
}
