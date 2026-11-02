import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { approvals, posts, postVariants, socialAccounts, trendActions, trendForecasts } from "@starsign/db";
import { validateVariant } from "@starsign/connectors";
import { newId } from "@starsign/ledger";
import { gatePost, type Subject } from "@starsign/policy";
import { CreatePostInput, type Actor, type Network, type Policy, type PostStatus, type TrendStage } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import type { PolicyService } from "./policy.ts";

export type PostRow = typeof posts.$inferSelect;
export type VariantRow = typeof postVariants.$inferSelect;

export interface PostDetail {
  post: PostRow;
  variants: VariantRow[];
  approvals: (typeof approvals.$inferSelect)[];
}

const OPEN_STATUSES: PostStatus[] = ["draft", "pending_approval", "approved", "scheduled"];

export class PostService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly policy: PolicyService,
  ) {}

  /**
   * Create a post through the single gate. Whoever asks (human, operator, MCP agent),
   * red lines and autonomy decide where it lands: draft, pending approval, scheduled, or blocked.
   */
  async create(p: Principal, rawInput: unknown): Promise<PostDetail & { refused?: string }> {
    const input = CreatePostInput.parse(rawInput);
    const accounts = await this.loadAccounts(p.workspaceId, input.variants.map((v) => v.socialAccountId));

    // Generic per-network validation (lengths, media rules) before anything is stored.
    const issues = input.variants.flatMap((v) => {
      const acc = accounts.get(v.socialAccountId)!;
      return validateVariant(acc.network as Network, v.text, v.media, v.thread).map((i) => ({ ...i, socialAccountId: v.socialAccountId, network: acc.network }));
    });
    if (issues.length) throw new CoreError("invalid", "variant validation failed", issues);

    const policy = await this.policy.getActive(p.workspaceId);
    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const subjects: Subject[] = input.variants.map((v) => ({
      text: [v.text, ...v.thread].join("\n"),
      network: accounts.get(v.socialAccountId)!.network,
      scheduledAt,
      disclosure: input.disclosure ?? null,
      flags: input.flags,
    }));
    const gate = gatePost({
      policy,
      actionClass: input.actionClass,
      actorType: p.actor.type,
      role: p.role,
      subjects,
      wantsSchedule: !!scheduledAt,
      ctx: {
        postsToday: await this.policy.postsToday(p.workspaceId, policy.timezone, scheduledAt ?? this.ctx.now()),
        classifyTopic: this.ctx.classifyTopic,
        now: this.ctx.now(),
      },
    });

    if (gate.initialStatus === null) {
      throw new CoreError("forbidden", gate.refusedReason ?? "not permitted", gate.decision);
    }

    const postId = newId("pst");
    const now = this.ctx.now();
    const [post] = await this.ctx.db
      .insert(posts)
      .values({
        id: postId,
        workspaceId: p.workspaceId,
        status: gate.initialStatus,
        title: input.title ?? null,
        body: input.body,
        media: input.media,
        scheduledAt,
        actionClass: input.actionClass,
        createdBy: p.actor,
        trendTopicId: input.trendTopicId ?? null,
        trendStageAtCreation: input.trendStageAtCreation ?? null,
        trendForecastId: input.trendForecastId ?? null,
        experimentId: input.experimentId ?? null,
        experimentArm: input.experimentArm ?? null,
        disclosure: input.disclosure ?? null,
        evidence: input.evidence,
        policyDecision: gate.decision,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const variantRows = await this.ctx.db
      .insert(postVariants)
      .values(
        input.variants.map((v) => ({
          id: newId("var"),
          postId,
          socialAccountId: v.socialAccountId,
          network: accounts.get(v.socialAccountId)!.network,
          text: v.text,
          media: v.media,
          thread: v.thread,
        })),
      )
      .returning();

    await this.policy.recordDecision(p.workspaceId, "post", postId, gate.decision, p.actor);
    await this.ctx.events.append({
      workspaceId: p.workspaceId,
      type: "post.created",
      subjectType: "post",
      subjectId: postId,
      actor: p.actor,
      data: {
        status: gate.initialStatus,
        actionClass: input.actionClass,
        networks: variantRows.map((v) => v.network),
        scheduledAt: scheduledAt?.toISOString() ?? null,
        trendTopicId: input.trendTopicId ?? null,
        trendStage: input.trendStageAtCreation ?? null,
        verdict: gate.decision.verdict,
        violations: gate.decision.violations.length,
      },
    });
    if (gate.decision.verdict === "block") {
      await this.ctx.events.append({
        workspaceId: p.workspaceId,
        type: "policy.blocked",
        subjectType: "post",
        subjectId: postId,
        actor: p.actor,
        data: { violations: gate.decision.violations },
      });
    }

    if (input.trendTopicId) {
      let stage: TrendStage | null = input.trendStageAtCreation ?? null;
      let forecastId: string | null = input.trendForecastId ?? null;
      if (!stage || !forecastId) {
        const [latest] = await this.ctx.db
          .select()
          .from(trendForecasts)
          .where(eq(trendForecasts.topicId, input.trendTopicId))
          .orderBy(desc(trendForecasts.computedAt))
          .limit(1);
        stage = stage ?? ((latest?.stage as TrendStage | undefined) ?? "dormant");
        forecastId = forecastId ?? latest?.id ?? null;
      }
      await this.ctx.db.insert(trendActions).values({ id: newId("ta"), workspaceId: p.workspaceId, postId, topicId: input.trendTopicId, stageAtAction: stage!, forecastId });
      await this.ctx.events.append({
        workspaceId: p.workspaceId,
        type: "trend.action_recorded",
        subjectType: "post",
        subjectId: postId,
        actor: p.actor,
        data: { topicId: input.trendTopicId, stage, forecastId },
      });
    }

    let approvalRows: (typeof approvals.$inferSelect)[] = [];
    if (gate.initialStatus === "pending_approval") {
      approvalRows = await this.requestApproval(p.workspaceId, postId, p.actor);
    }
    if (gate.initialStatus === "scheduled" && scheduledAt) {
      await this.arm(p.workspaceId, postId, scheduledAt, p.actor);
    }
    this.ctx.emitter.emit("post", { workspaceId: p.workspaceId, postId, status: gate.initialStatus });
    return { post: post!, variants: variantRows, approvals: approvalRows };
  }

  async requestApproval(workspaceId: string, postId: string, actor: Actor) {
    const rows = await this.ctx.db.insert(approvals).values({ id: newId("apr"), postId, workspaceId, state: "requested", requestedBy: actor }).returning();
    await this.ctx.events.append({ workspaceId, type: "post.approval_requested", subjectType: "post", subjectId: postId, actor });
    return rows;
  }

  /** Hand the post to the scheduler and record it. */
  async arm(workspaceId: string, postId: string, at: Date, actor: Actor) {
    await this.ctx.db.update(posts).set({ status: "scheduled", scheduledAt: at, updatedAt: this.ctx.now() }).where(eq(posts.id, postId));
    await this.ctx.scheduler.schedulePublish(postId, at);
    await this.ctx.events.append({ workspaceId, type: "post.scheduled", subjectType: "post", subjectId: postId, actor, data: { at: at.toISOString() } });
  }

  async get(workspaceId: string, postId: string): Promise<PostDetail> {
    const [post] = await this.ctx.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)))
      .limit(1);
    if (!post) throw new CoreError("not_found", `post ${postId}`);
    const variants = await this.ctx.db.select().from(postVariants).where(eq(postVariants.postId, postId));
    const approvalRows = await this.ctx.db.select().from(approvals).where(eq(approvals.postId, postId)).orderBy(desc(approvals.createdAt));
    return { post, variants, approvals: approvalRows };
  }

  async list(workspaceId: string, opts: { status?: PostStatus[]; limit?: number; before?: Date } = {}) {
    const conds = [eq(posts.workspaceId, workspaceId)];
    if (opts.status?.length) conds.push(inArray(posts.status, opts.status));
    if (opts.before) conds.push(lt(posts.createdAt, opts.before));
    const rows = await this.ctx.db
      .select()
      .from(posts)
      .where(and(...conds))
      .orderBy(desc(posts.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200));
    if (rows.length === 0) return [];
    const vars = await this.ctx.db
      .select()
      .from(postVariants)
      .where(inArray(postVariants.postId, rows.map((r) => r.id)));
    return rows.map((post) => ({ post, variants: vars.filter((v) => v.postId === post.id) }));
  }

  /** The approval queue: everything waiting on a human, oldest first. */
  async queue(workspaceId: string) {
    const rows = await this.list(workspaceId, { status: ["pending_approval"], limit: 200 });
    return rows.reverse();
  }

  /** Schedule (or reschedule) an open post. Re-runs the gate: policy may have changed since the draft. */
  async schedule(p: Principal, postId: string, at: Date) {
    const detail = await this.get(p.workspaceId, postId);
    if (!OPEN_STATUSES.includes(detail.post.status as PostStatus)) throw new CoreError("conflict", `post is ${detail.post.status}`);
    const policy = await this.policy.getActive(p.workspaceId);
    const gate = this.regate(policy, detail, p, at);
    if (gate.initialStatus === null) throw new CoreError("forbidden", gate.refusedReason ?? "not permitted");
    if (gate.initialStatus === "blocked") {
      await this.ctx.db.update(posts).set({ status: "blocked", policyDecision: gate.decision, updatedAt: this.ctx.now() }).where(eq(posts.id, postId));
      await this.ctx.events.append({ workspaceId: p.workspaceId, type: "policy.blocked", subjectType: "post", subjectId: postId, actor: p.actor, data: { violations: gate.decision.violations } });
      return this.get(p.workspaceId, postId);
    }
    if (gate.initialStatus === "pending_approval") {
      await this.ctx.db.update(posts).set({ status: "pending_approval", scheduledAt: at, policyDecision: gate.decision, updatedAt: this.ctx.now() }).where(eq(posts.id, postId));
      if (detail.post.status !== "pending_approval") await this.requestApproval(p.workspaceId, postId, p.actor);
      return this.get(p.workspaceId, postId);
    }
    await this.arm(p.workspaceId, postId, at, p.actor);
    return this.get(p.workspaceId, postId);
  }

  async publishNow(p: Principal, postId: string) {
    return this.schedule(p, postId, this.ctx.now());
  }

  async cancel(p: Principal, postId: string) {
    const detail = await this.get(p.workspaceId, postId);
    if (!OPEN_STATUSES.includes(detail.post.status as PostStatus)) throw new CoreError("conflict", `post is ${detail.post.status}`);
    await this.ctx.scheduler.cancelPublish(postId);
    await this.ctx.db.update(posts).set({ status: "cancelled", updatedAt: this.ctx.now() }).where(eq(posts.id, postId));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "post.cancelled", subjectType: "post", subjectId: postId, actor: p.actor });
    this.ctx.emitter.emit("post", { workspaceId: p.workspaceId, postId, status: "cancelled" });
    return this.get(p.workspaceId, postId);
  }

  /** Edit text of a draft's variants (human or operator). Approval edits go through ApprovalService so diffs are recorded. */
  async updateVariants(p: Principal, postId: string, edits: Record<string, string>) {
    const detail = await this.get(p.workspaceId, postId);
    if (detail.post.status !== "draft") throw new CoreError("conflict", `only drafts can be edited directly (post is ${detail.post.status})`);
    for (const [variantId, text] of Object.entries(edits)) {
      const v = detail.variants.find((x) => x.id === variantId);
      if (!v) throw new CoreError("not_found", `variant ${variantId}`);
      const issues = validateVariant(v.network as Network, text, v.media as never, v.thread);
      if (issues.length) throw new CoreError("invalid", "variant validation failed", issues);
      await this.ctx.db.update(postVariants).set({ text }).where(eq(postVariants.id, variantId));
    }
    await this.ctx.db.update(posts).set({ updatedAt: this.ctx.now() }).where(eq(posts.id, postId));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "post.updated", subjectType: "post", subjectId: postId, actor: p.actor, data: { variants: Object.keys(edits) } });
    return this.get(p.workspaceId, postId);
  }

  regate(policy: Policy, detail: PostDetail, p: Principal, at: Date | null) {
    return gatePost({
      policy,
      actionClass: detail.post.actionClass as never,
      actorType: p.actor.type,
      role: p.role,
      subjects: detail.variants.map((v) => ({
        text: [v.text, ...v.thread].join("\n"),
        network: v.network,
        scheduledAt: at,
        disclosure: (detail.post.disclosure as never) ?? null,
      })),
      wantsSchedule: !!at,
      ctx: { classifyTopic: this.ctx.classifyTopic, now: this.ctx.now() },
    });
  }

  private async loadAccounts(workspaceId: string, ids: string[]) {
    const rows = await this.ctx.db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.workspaceId, workspaceId), inArray(socialAccounts.id, [...new Set(ids)])));
    const map = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const acc = map.get(id);
      if (!acc) throw new CoreError("not_found", `social account ${id}`);
      if (acc.status === "disabled") throw new CoreError("conflict", `account ${acc.handle} is disabled`);
    }
    return map;
  }
}
