import { createDb, migrate, type DbHandle } from "@starsign/db";
import { Starsign, SecretBox, TimerScheduler, type Scheduler } from "@starsign/core";
import { BullMQScheduler, buildRegistry, createRedis } from "@starsign/workers";

export interface Booted {
  handle: DbHandle;
  m: Starsign;
  close(): Promise<void>;
}

/** Shared boot for the API process: database, migrations, connectors, scheduler, Starsign. */
export async function boot(env: NodeJS.ProcessEnv = process.env): Promise<Booted> {
  const handle = await createDb({ url: env.DATABASE_URL, pglitePath: env.DATABASE_URL ? undefined : env.PGLITE_PATH ?? ".pglite" });
  const applied = await migrate(handle);
  if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);

  let scheduler: Scheduler;
  let closeScheduler = async () => {};
  let m: Starsign;
  if (env.REDIS_URL) {
    const redis = createRedis(env.REDIS_URL);
    const bull = new BullMQScheduler(redis);
    scheduler = bull;
    closeScheduler = async () => {
      await bull.close();
      await redis.quit();
    };
    m = new Starsign({ handle, connectors: buildRegistry(env), scheduler, secrets: SecretBox.fromEnv(env) });
  } else {
    // Single-process dev: timers in this process do the publishing; re-armed from the database on boot.
    const timers = new TimerScheduler((postId) => m.publishing.publishPost(postId).then(() => undefined));
    scheduler = timers;
    m = new Starsign({ handle, connectors: buildRegistry(env), scheduler, secrets: SecretBox.fromEnv(env) });
    const n = await m.publishing.rearm((postId, at) => timers.schedulePublish(postId, at));
    if (n) console.log(`[scheduler] re-armed ${n} scheduled post(s) (in-process timers; set REDIS_URL for durable queues)`);
  }
  return {
    handle,
    m,
    close: async () => {
      await closeScheduler();
      await handle.close();
    },
  };
}
