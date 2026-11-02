import { eq } from "drizzle-orm";
import { approvals, posts, postVariants } from "@starsign/db";
import { ApprovalDecisionInput } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import type { PolicyService } from "./policy.ts";
import type { PostService } from "./posts.ts";

/**
 * Humans decide. Edits made while approving are recorded as diffs: the training signal for voice.
 * Approving re-runs red lines on the final text, so an edit cannot sneak past them.
 */
export class ApprovalService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly posts: PostService,
    private readonly policy: PolicyService,
  ) {}

  async decide(p: Principal, postId: string, rawInput: unknown) {
    const input = ApprovalDecisionInput.parse(rawInput);
    if (p.actor.type !== "human") throw new CoreError("forbidden", "only humans approve");
    if (!p.role || !["owner", "approver"].includes(p.role)) throw new CoreError("forbidden", "requires owner or approver role");

    const detail = await this.posts.get(p.workspaceId, postId);
    if (detail.post.status !== "pending_approval") throw new CoreError("conflict", `post is ${detail.post.status}, not pending approval`);

    // Apply edits, recording every diff.
    if (input.edits) {
      for (const [variantId, after] of Object.entries(input.edits)) {
        const v = detail.variants.find((x) => x.id === variantId);
        if (!v) throw new CoreError("not_found", `variant ${variantId}`);
        await this.ctx.diffs.record({
          workspaceId: p.workspaceId,
          postId,
          variantId,
          beforeText: v.text,
          afterText: after,
          draftedBy: detail.post.createdBy,
          editedBy: p.actor,
        });
        await this.ctx.db.update(postVariants).set({ text: after }).where(eq(postVariants.id, variantId));
        v.text = after;
      }
    }

    const open = detail.approvals.find((a) => a.state === "requested");
    const decidedAt = this.ctx.now();
    const base = { decidedBy: p.actor, decidedAt, note: input.note ?? null };

    if (input.decision === "reject") {
      if (open) await this.ctx.db.update(approvals).set({ ...base, state: "rejected" }).where(eq(approvals.id, open.id));
      await this.ctx.db.update(posts).set({ status: "cancelled", updatedAt: decidedAt }).where(eq(posts.id, postId));
      await this.record(p, postId, "rejected", input.note);
      return this.posts.get(p.workspaceId, postId);
    }
    if (input.decision === "request_changes") {
      if (open) await this.ctx.db.update(approvals).set({ ...base, state: "changes_requested" }).where(eq(approvals.id, open.id));
      await this.ctx.db.update(posts).set({ status: "draft", updatedAt: decidedAt }).where(eq(posts.id, postId));
      await this.record(p, postId, "changes_requested", input.note);
      return this.posts.get(p.workspaceId, postId);
    }

    // Approve: red lines run again on the final text, as the approving human.
    const policy = await this.policy.getActive(p.workspaceId);
    const gate = this.posts.regate(policy, detail, p, detail.post.scheduledAt);
    if (gate.decision.verdict === "block") {
      await this.policy.recordDecision(p.workspaceId, "post", postId, gate.decision, p.actor);
      await this.ctx.events.append({ workspaceId: p.workspaceId, type: "policy.blocked", subjectType: "post", subjectId: postId, actor: p.actor, data: { violations: gate.decision.violations, during: "approval" } });
      throw new CoreError("policy_blocked", "the edited text crosses a red line", gate.decision.violations);
    }
    if (open) await this.ctx.db.update(approvals).set({ ...base, state: "approved" }).where(eq(approvals.id, open.id));
    await this.record(p, postId, "approved", input.note);
    if (detail.post.scheduledAt) {
      await this.posts.arm(p.workspaceId, postId, detail.post.scheduledAt, p.actor);
    } else {
      await this.ctx.db.update(posts).set({ status: "approved", updatedAt: decidedAt }).where(eq(posts.id, postId));
    }
    this.ctx.emitter.emit("post", { workspaceId: p.workspaceId, postId, status: detail.post.scheduledAt ? "scheduled" : "approved" });
    return this.posts.get(p.workspaceId, postId);
  }

  private async record(p: Principal, postId: string, outcome: string, note?: string) {
    await this.ctx.events.append({
      workspaceId: p.workspaceId,
      type: "post.approval_decided",
      subjectType: "post",
      subjectId: postId,
      actor: p.actor,
      data: { outcome, note: note ?? null },
    });
  }
}
