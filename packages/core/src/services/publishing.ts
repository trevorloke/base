import { eq } from "drizzle-orm";
import { posts, postVariants, socialAccounts } from "@starsign/db";
import { ConnectorError, validateVariant } from "@starsign/connectors";
import type { Media, Network } from "@starsign/schema";
import { SYSTEM, type CoreContext } from "../context.ts";
import { RetryablePublishError } from "../errors.ts";
import type { AccountService } from "./accounts.ts";

const MAX_ATTEMPTS = 5;

/**
 * Executes scheduled posts. Idempotent per variant: a retry never double-posts, because
 * published variants are skipped and connectors receive the variant id as idempotency key.
 */
export class PublishingService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly accounts: AccountService,
  ) {}

  async publishPost(postId: string): Promise<{ status: string; published: number; failed: number }> {
    const [post] = await this.ctx.db.select().from(posts).where(eq(posts.id, postId)).limit(1);
    if (!post) return { status: "missing", published: 0, failed: 0 };
    if (!["scheduled", "publishing", "partially_published", "failed"].includes(post.status)) {
      return { status: post.status, published: 0, failed: 0 };
    }
    const workspaceId = post.workspaceId;
    await this.ctx.db.update(posts).set({ status: "publishing", updatedAt: this.ctx.now() }).where(eq(posts.id, postId));
    await this.ctx.events.append({ workspaceId, type: "post.publish_started", subjectType: "post", subjectId: postId, actor: SYSTEM });

    const variants = await this.ctx.db.select().from(postVariants).where(eq(postVariants.postId, postId));
    const retryable: string[] = [];

    for (const v of variants) {
      if (v.status === "published" || v.status === "skipped") continue;
      if (v.attemptCount >= MAX_ATTEMPTS) continue;
      const [account] = await this.ctx.db.select().from(socialAccounts).where(eq(socialAccounts.id, v.socialAccountId)).limit(1);
      if (!account || account.status !== "active") {
        await this.fail(workspaceId, v, `account ${v.socialAccountId} is not active`, false);
        continue;
      }
      const ref = this.accounts.toRef(account);
      let connector;
      try {
        connector = this.ctx.connectors.resolve(account.connector, account.network as Network);
      } catch (e) {
        await this.fail(workspaceId, v, (e as Error).message, false);
        continue;
      }
      const issues = [
        ...validateVariant(account.network as Network, v.text, v.media as Media[], v.thread),
        ...(connector.validate?.(ref, { variantId: v.id, text: v.text, media: v.media as Media[], thread: v.thread, idempotencyKey: v.id }) ?? []),
      ];
      if (issues.length) {
        await this.fail(workspaceId, v, issues.map((i) => i.message).join("; "), false);
        continue;
      }
      await this.ctx.db.update(postVariants).set({ status: "publishing", attemptCount: v.attemptCount + 1 }).where(eq(postVariants.id, v.id));
      try {
        const result = await connector.publish(ref, { variantId: v.id, text: v.text, media: v.media as Media[], thread: v.thread, idempotencyKey: v.id });
        const publishedAt = this.ctx.now();
        await this.ctx.db
          .update(postVariants)
          .set({ status: "published", externalId: result.externalId, externalUrl: result.url, publishedAt, error: null })
          .where(eq(postVariants.id, v.id));
        await this.ctx.events.append({
          workspaceId,
          type: "variant.published",
          subjectType: "post_variant",
          subjectId: v.id,
          actor: SYSTEM,
          data: { postId, network: v.network, externalId: result.externalId, url: result.url, attempt: v.attemptCount + 1 },
        });
        await this.ctx.outcomes.schedule({ workspaceId, postId, variantId: v.id, publishedAt, actor: SYSTEM });
      } catch (e) {
        const ce = e instanceof ConnectorError ? e : new ConnectorError((e as Error).message ?? String(e), "unknown", true, e);
        if (ce.kind === "auth") await this.accounts.markReauth(account.id);
        const canRetry = ce.retryable && v.attemptCount + 1 < MAX_ATTEMPTS;
        await this.fail(workspaceId, { ...v, attemptCount: v.attemptCount + 1 }, `${ce.kind}: ${ce.message}`, canRetry);
        if (canRetry) retryable.push(v.id);
      }
    }

    const fresh = await this.ctx.db.select().from(postVariants).where(eq(postVariants.postId, postId));
    const published = fresh.filter((v) => v.status === "published").length;
    const failed = fresh.filter((v) => v.status === "failed").length;
    const pending = fresh.filter((v) => v.status === "pending" || v.status === "publishing").length;
    let status: string;
    if (published === fresh.length) status = "published";
    else if (published > 0) status = retryable.length ? "publishing" : "partially_published";
    else status = retryable.length || pending ? "publishing" : "failed";

    await this.ctx.db
      .update(posts)
      .set({ status, publishedAt: published > 0 ? (post.publishedAt ?? this.ctx.now()) : null, updatedAt: this.ctx.now() })
      .where(eq(posts.id, postId));
    if (status === "published" || status === "partially_published") {
      await this.ctx.events.append({ workspaceId, type: "post.published", subjectType: "post", subjectId: postId, actor: SYSTEM, data: { published, failed } });
    } else if (status === "failed") {
      await this.ctx.events.append({ workspaceId, type: "post.failed", subjectType: "post", subjectId: postId, actor: SYSTEM, data: { failed } });
    }
    this.ctx.emitter.emit("post", { workspaceId, postId, status });
    if (retryable.length) throw new RetryablePublishError(postId, retryable);
    return { status, published, failed };
  }

  private async fail(workspaceId: string, v: typeof postVariants.$inferSelect, error: string, willRetry: boolean) {
    await this.ctx.db
      .update(postVariants)
      .set({ status: willRetry ? "pending" : "failed", error, attemptCount: v.attemptCount })
      .where(eq(postVariants.id, v.id));
    await this.ctx.events.append({
      workspaceId,
      type: "variant.failed",
      subjectType: "post_variant",
      subjectId: v.id,
      actor: SYSTEM,
      data: { postId: v.postId, network: v.network, error, willRetry, attempt: v.attemptCount },
    });
  }

  /** On boot: re-arm every scheduled post with the scheduler (timers are not durable). */
  async rearm(schedule: (postId: string, at: Date) => Promise<void>): Promise<number> {
    const rows = await this.ctx.db.select({ id: posts.id, at: posts.scheduledAt }).from(posts).where(eq(posts.status, "scheduled"));
    let n = 0;
    for (const r of rows) {
      if (!r.at) continue;
      await schedule(r.id, r.at);
      n++;
    }
    return n;
  }
}
