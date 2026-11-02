import { and, desc, eq, isNull } from "drizzle-orm";
import { alerts, briefs, operatorRuns } from "@meridian/db";
import { newId } from "@meridian/ledger";
import type { Actor } from "@meridian/schema";
import type { CoreContext, Principal } from "../context.ts";

/** Storage for what operators produce: runs, alerts, briefs. The operators app does the thinking. */
export class OpsService {
  constructor(private readonly ctx: CoreContext) {}

  async startRun(workspaceId: string, operator: string) {
    const id = newId("run");
    await this.ctx.db.insert(operatorRuns).values({ id, workspaceId, operator, startedAt: this.ctx.now() });
    await this.ctx.events.append({ workspaceId, type: "operator.run_started", subjectType: "operator_run", subjectId: id, actor: { type: "operator", id: operator } });
    return id;
  }

  async finishRun(runId: string, result: { status: "succeeded" | "failed"; summary?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; error?: string }) {
    const [row] = await this.ctx.db
      .update(operatorRuns)
      .set({ status: result.status, summary: result.summary ?? null, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0, costUsd: result.costUsd ?? 0, error: result.error ?? null, finishedAt: this.ctx.now() })
      .where(eq(operatorRuns.id, runId))
      .returning();
    if (row) {
      await this.ctx.events.append({
        workspaceId: row.workspaceId,
        type: "operator.run_finished",
        subjectType: "operator_run",
        subjectId: runId,
        actor: { type: "operator", id: row.operator },
        data: { status: result.status, summary: result.summary ?? null, costUsd: result.costUsd ?? 0 },
      });
    }
    return row ?? null;
  }

  async runs(workspaceId: string, limit = 50) {
    return this.ctx.db.select().from(operatorRuns).where(eq(operatorRuns.workspaceId, workspaceId)).orderBy(desc(operatorRuns.startedAt)).limit(limit);
  }

  async raiseAlert(workspaceId: string, actor: Actor, input: { kind: string; severity?: "info" | "attention" | "urgent"; title: string; body: string; evidence?: unknown[]; topicId?: string | null }) {
    const [row] = await this.ctx.db
      .insert(alerts)
      .values({ id: newId("alt"), workspaceId, kind: input.kind, severity: input.severity ?? "attention", title: input.title, body: input.body, evidence: input.evidence ?? [], topicId: input.topicId ?? null })
      .returning();
    await this.ctx.events.append({ workspaceId, type: "operator.alert", subjectType: "alert", subjectId: row!.id, actor, data: { kind: input.kind, severity: input.severity ?? "attention", title: input.title, topicId: input.topicId ?? null } });
    this.ctx.emitter.emit("alert", { workspaceId, id: row!.id, title: input.title, severity: input.severity ?? "attention" });
    return row!;
  }

  async alerts(workspaceId: string, opts: { unacknowledgedOnly?: boolean; limit?: number } = {}) {
    const conds = [eq(alerts.workspaceId, workspaceId)];
    if (opts.unacknowledgedOnly) conds.push(isNull(alerts.acknowledgedAt));
    return this.ctx.db.select().from(alerts).where(and(...conds)).orderBy(desc(alerts.createdAt)).limit(opts.limit ?? 50);
  }

  async acknowledge(p: Principal, alertId: string) {
    await this.ctx.db.update(alerts).set({ acknowledgedAt: this.ctx.now() }).where(and(eq(alerts.id, alertId), eq(alerts.workspaceId, p.workspaceId)));
  }

  async saveBrief(workspaceId: string, actor: Actor, input: { periodStart: Date; periodEnd: Date; contentMd: string; evidence?: unknown[]; runId?: string }) {
    const [row] = await this.ctx.db
      .insert(briefs)
      .values({ id: newId("brf"), workspaceId, periodStart: input.periodStart, periodEnd: input.periodEnd, contentMd: input.contentMd, evidence: input.evidence ?? [], runId: input.runId ?? null })
      .returning();
    await this.ctx.events.append({ workspaceId, type: "brief.written", subjectType: "brief", subjectId: row!.id, actor, data: { periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString() } });
    return row!;
  }

  async briefs(workspaceId: string, limit = 12) {
    return this.ctx.db.select().from(briefs).where(eq(briefs.workspaceId, workspaceId)).orderBy(desc(briefs.periodEnd)).limit(limit);
  }
}
