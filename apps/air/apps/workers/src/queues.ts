import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import type { Scheduler } from "@base-air/core";

export const PUBLISH_QUEUE = "base-air-publish";
export const MAINTENANCE_QUEUE = "base-air-maintenance";
/** Queue names from before Starsign became Base Air. Nothing listens on them any more. */
export const LEGACY_QUEUES = ["starsign-publish", "starsign-maintenance"] as const;

/** The little of a BullMQ Queue that retiring an old one needs (a fake in tests). */
export interface RetirableQueue {
  obliterate(opts: { force: boolean }): Promise<void>;
  close(): Promise<void>;
}

/**
 * Empty the pre-rename queues. Call it after `publishing.rearm`, which has already put every scheduled post on the new
 * publish queue from the database, so a post waiting in the old queue is not lost and cannot be published twice.
 * The old maintenance schedule is dropped; the new one is set up by startWorkers. Failures are logged, never fatal.
 */
export async function retireLegacyQueues(open: (name: string) => RetirableQueue, log: (line: string) => void = console.log): Promise<string[]> {
  const retired: string[] = [];
  for (const name of LEGACY_QUEUES) {
    const q = open(name);
    try {
      await q.obliterate({ force: true });
      retired.push(name);
    } catch (e) {
      log(`[workers] could not empty the old queue ${name}: ${(e as Error).message}`);
    } finally {
      await q.close().catch(() => {});
    }
  }
  return retired;
}

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
