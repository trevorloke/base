import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { RetryablePublishError, type Starsign } from "@starsign/core";
import { captureOutcomes, ingestAll, refreshForecasts } from "./jobs.ts";
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
export async function startWorkers(m: Starsign, redis: Redis, opts: { ingestEveryMs?: number; outcomesEveryMs?: number; forecastEveryMs?: number } = {}): Promise<WorkerHandles> {
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

  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      switch (job.name) {
        case "ingest":
          return ingestAll(m);
        case "outcomes":
          return captureOutcomes(m);
        case "forecasts":
          return { topics: await refreshForecasts(m) };
        default:
          return null;
      }
    },
    { connection, concurrency: 1 },
  );

  const mq = new Queue(MAINTENANCE_QUEUE, { connection });
  await mq.upsertJobScheduler("ingest", { every: opts.ingestEveryMs ?? 5 * 60_000 }, { name: "ingest" });
  await mq.upsertJobScheduler("outcomes", { every: opts.outcomesEveryMs ?? 10 * 60_000 }, { name: "outcomes" });
  await mq.upsertJobScheduler("forecasts", { every: opts.forecastEveryMs ?? 60 * 60_000 }, { name: "forecasts" });

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
