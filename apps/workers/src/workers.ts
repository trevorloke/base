import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { RetryablePublishError, type Starsign } from "@starsign/core";
import { maintenanceJobs } from "./maintenance.ts";
import { connectionFor, MAINTENANCE_QUEUE, PUBLISH_QUEUE } from "./queues.ts";

export interface WorkerHandles {
  publish: Worker;
  maintenance: Worker;
  close(): Promise<void>;
}

/**
 * Start the publish worker and the maintenance schedules.
 * Publishing retries on RetryablePublishError only; everything else is final and recorded in the ledger.
 */
export async function startWorkers(m: Starsign, redis: Redis, opts: { ingestEveryMs?: number; outcomesEveryMs?: number; forecastEveryMs?: number; sourcesEveryMs?: number } = {}): Promise<WorkerHandles> {
  const connection = connectionFor(redis);

  const publish = new Worker(
    PUBLISH_QUEUE,
    async (job) => {
      const { postId } = job.data as { postId: string };
      try {
        return await m.publishing.publishPost(postId);
      } catch (e) {
        if (e instanceof RetryablePublishError) throw e; // BullMQ backs off and retries
        console.error(`[publish] ${postId} failed permanently:`, (e as Error).message);
        return { status: "error", error: (e as Error).message };
      }
    },
    { connection, concurrency: 4 },
  );

  const jobs = maintenanceJobs(opts);
  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      const j = jobs.find((x) => x.name === job.name);
      return j ? j.run(m) : null;
    },
    { connection, concurrency: 1 },
  );

  const mq = new Queue(MAINTENANCE_QUEUE, { connection });
  for (const j of jobs) await mq.upsertJobScheduler(j.name, { every: j.everyMs }, { name: j.name });

  for (const w of [publish, maintenance]) {
    w.on("failed", (job, err) => console.error(`[${w.name}] job ${job?.name} ${job?.id} failed: ${err.message}`));
  }

  return {
    publish,
    maintenance,
    close: async () => {
      await Promise.all([publish.close(), maintenance.close(), mq.close()]);
    },
  };
}
