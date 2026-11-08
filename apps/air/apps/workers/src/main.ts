import { createDb, migrate } from "@base-air/db";
import { BaseAir, SecretBox } from "@base-air/core";
import { Queue } from "bullmq";
import { BullMQScheduler, connectionFor, createRedis, retireLegacyQueues } from "./queues.ts";
import { buildRegistry } from "./registry.ts";
import { startWorkers } from "./workers.ts";

const handle = await createDb({ url: process.env.DATABASE_URL, pglitePath: process.env.DATABASE_URL ? undefined : process.env.PGLITE_PATH ?? ".pglite" });
await migrate(handle);
const redis = createRedis();
const scheduler = new BullMQScheduler(redis);
const m = new BaseAir({ handle, connectors: buildRegistry(), scheduler, secrets: SecretBox.fromEnv() });
const rearmed = await m.publishing.rearm((postId, at) => scheduler.schedulePublish(postId, at));
await retireLegacyQueues((name) => new Queue(name, { connection: connectionFor(redis) }));
const workers = await startWorkers(m, redis);
console.log(`[workers] up: db=${handle.kind} redis=${process.env.REDIS_URL ?? "redis://127.0.0.1:6379"} re-armed=${rearmed}`);

const shutdown = async () => {
  await workers.close();
  await scheduler.close();
  await redis.quit();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
