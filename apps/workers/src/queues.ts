import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import type { Scheduler } from "@starsign/core";

export const PUBLISH_QUEUE = "starsign-publish";
export const MAINTENANCE_QUEUE = "starsign-maintenance";

export function createRedis(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"): Redis {
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export function connectionFor(redis: Redis): ConnectionOptions {
  return redis as unknown as ConnectionOptions;
}

/** Durable scheduling through Redis. One delayed job per post; rescheduling replaces it. */
export class BullMQScheduler implements Scheduler {
  readonly queue: Queue;
  constructor(
    redis: Redis,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.queue = new Queue(PUBLISH_QUEUE, { connection: connectionFor(redis) });
  }

  static jobId(postId: string): string {
    return `publish-${postId}`; // BullMQ custom ids may not contain ":"
  }

  async schedulePublish(postId: string, at: Date): Promise<void> {
    await this.cancelPublish(postId);
    const delay = Math.max(0, at.getTime() - this.now().getTime());
    await this.queue.add(
      "publish",
      { postId },
      {
        jobId: BullMQScheduler.jobId(postId),
        delay,
        attempts: 5,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  }

  async cancelPublish(postId: string): Promise<void> {
    const job = await this.queue.getJob(BullMQScheduler.jobId(postId));
    if (job) {
      try {
        await job.remove();
      } catch {
        // an active job cannot be removed; publishing checks the post status anyway
      }
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
