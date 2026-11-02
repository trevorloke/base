import { createDb, migrate, type DbHandle } from "@starsign/db";
import { Starsign, SecretBox, TimerScheduler, type Scheduler } from "@starsign/core";
import { BullMQScheduler, buildRegistry, createRedis } from "@starsign/workers";
import { AnthropicGateway, FakeGateway, defaultFakeHandlers, type ModelGateway } from "@starsign/ai";
import { createDefaultSources, type SourceAdapter } from "@starsign/sources";

export interface Booted {
  handle: DbHandle;
  m: Starsign;
  gateway: ModelGateway | null;
  sources: SourceAdapter[];
  close(): Promise<void>;
}

/** The model is optional for the API: compose assistance needs it, nothing else does. */
export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): ModelGateway | null {
  if (env.STARSIGN_FAKE_AI === "1") return new FakeGateway(defaultFakeHandlers());
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return new AnthropicGateway();
  return null;
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
    gateway: gatewayFromEnv(env),
    sources: createDefaultSources(env),
    close: async () => {
      await closeScheduler();
      await handle.close();
    },
  };
}
