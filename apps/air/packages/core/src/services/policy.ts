import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { policies, policyDecisions, posts, postVariants } from "@base-air/db";
import { newId } from "@base-air/ledger";
import { DEFAULT_POLICY, Policy, type Actor, type PolicyDecision } from "@base-air/schema";
import type { CoreContext, Principal } from "../context.ts";
import { localDayRange } from "../time.ts";

export class PolicyService {
  constructor(private readonly ctx: CoreContext) {}

  async getActive(workspaceId: string): Promise<Policy> {
    const [row] = await this.ctx.db
      .select()
      .from(policies)
      .where(and(eq(policies.workspaceId, workspaceId), eq(policies.active, true)))
      .orderBy(desc(policies.version))
      .limit(1);
    return row ? Policy.parse(row.document) : DEFAULT_POLICY;
  }

  async history(workspaceId: string) {
    return this.ctx.db.select().from(policies).where(eq(policies.workspaceId, workspaceId)).orderBy(desc(policies.version));
  }

  /** Replace the policy with a new version. The old one stays in history; the ledger records the change. */
  async update(p: Principal, document: unknown): Promise<Policy> {
    const current = await this.getActive(p.workspaceId);
    const parsed = Policy.parse({ ...(document as object), version: current.version + 1 });
    await this.ctx.db.update(policies).set({ active: false }).where(eq(policies.workspaceId, p.workspaceId));
    await this.ctx.db.insert(policies).values({ id: newId("pol"), workspaceId: p.workspaceId, version: parsed.version, document: parsed, active: true, createdBy: p.actor });
    await this.ctx.events.append({
      workspaceId: p.workspaceId,
      type: "policy.updated",
      subjectType: "policy",
      subjectId: p.workspaceId,
      actor: p.actor,
      data: { version: parsed.version, redLines: parsed.redLines.length, autonomy: parsed.autonomy },
    });
    return parsed;
  }

  async recordDecision(workspaceId: string, subjectType: string, subjectId: string, decision: PolicyDecision, actor: Actor) {
    await this.ctx.db.insert(policyDecisions).values({
      id: newId("dec"),
      workspaceId,
      policyVersion: decision.policyVersion,
      subjectType,
      subjectId,
      verdict: decision.verdict,
      violations: decision.violations,
      actor,
    });
  }

  /** Posts already committed today per network, for cadence red lines. "*" is the total. */
  async postsToday(workspaceId: string, timezone: string, at: Date): Promise<Record<string, number>> {
    const { start, end } = localDayRange(at, timezone);
    const rows = await this.ctx.db
      .select({ network: postVariants.network, n: sql<number>`count(*)` })
      .from(postVariants)
      .innerJoin(posts, eq(posts.id, postVariants.postId))
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          inArray(posts.status, ["scheduled", "publishing", "published", "partially_published"]),
          gte(sql`coalesce(${posts.publishedAt}, ${posts.scheduledAt})`, start),
          lt(sql`coalesce(${posts.publishedAt}, ${posts.scheduledAt})`, end),
        ),
      )
      .groupBy(postVariants.network);
    const out: Record<string, number> = { "*": 0 };
    for (const r of rows) {
      out[r.network] = Number(r.n);
      out["*"] = (out["*"] ?? 0) + Number(r.n);
    }
    return out;
  }
}
