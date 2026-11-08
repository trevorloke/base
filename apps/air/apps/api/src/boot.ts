import { normalizeBasePath } from "./base-path.ts";
import { createDb, migrate, type DbHandle } from "@base-air/db";
import { BaseAir, SecretBox, TimerScheduler, type Scheduler } from "@base-air/core";
import { BullMQScheduler, buildRegistry, createRedis, startInProcessJobs } from "@base-air/workers";
import { AnthropicGateway, FakeGateway, defaultFakeHandlers, type ModelGateway } from "@base-air/ai";
import { createDefaultSources, type SourceAdapter } from "@base-air/sources";

export interface Booted {
  handle: DbHandle;
  m: BaseAir;
  gateway: ModelGateway | null;
  sources: SourceAdapter[];
  close(): Promise<void>;
}

/** The model is optional for the API: compose assistance needs it, nothing else does. */
export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): ModelGateway | null {
  if (env.BASE_AIR_FAKE_AI === "1") return new FakeGateway(defaultFakeHandlers());
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return new AnthropicGateway();
  return null;
}

/**
 * The deployment's public address. In the Base suite Base Air is a Render private service behind the front door, with
 * no address of its own, so BASE_AIR_PUBLIC_URL (`https://<client>.base.win/air`) must be set. A standalone Render
 * web service gets RENDER_EXTERNAL_URL; without falling back to it, a deploy that never set BASE_AIR_PUBLIC_URL refuses
 * every OAuth connect (503), mails relative invite and reset links and turns link tracking off. Fills BASE_AIR_PUBLIC_URL in place so every reader (auth, links, media,
 * connector webhooks) sees the same value.
 */
export function applyHostDefaults(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const own = env.BASE_AIR_PUBLIC_URL?.trim();
  // Render's own URL reaches this service directly, so it is served under BASE_PATH there too.
  if (!own && env.RENDER_EXTERNAL_URL?.trim()) env.BASE_AIR_PUBLIC_URL = `${env.RENDER_EXTERNAL_URL.trim().replace(/\/+$/, "")}${normalizeBasePath(env.BASE_PATH)}`;
  return env.BASE_AIR_PUBLIC_URL?.trim() || undefined;
}

/** Shared boot for the API process: database, migrations, connectors, scheduler, Base Air. */
export async function boot(env: NodeJS.ProcessEnv = process.env): Promise<Booted> {
  applyHostDefaults(env);
  const handle = await createDb({ url: env.DATABASE_URL, pglitePath: env.DATABASE_URL ? undefined : env.PGLITE_PATH ?? ".pglite" });
  const applied = await migrate(handle);
  if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);

  let scheduler: Scheduler;
  let closeScheduler = async () => {};
  let m: BaseAir;
  if (env.REDIS_URL) {
    const redis = createRedis(env.REDIS_URL);
    const bull = new BullMQScheduler(redis);
    scheduler = bull;
    closeScheduler = async () => {
      await bull.close();
      await redis.quit();
    };
    m = new BaseAir({ handle, connectors: buildRegistry(env), scheduler, secrets: SecretBox.fromEnv(env) });
  } else {
    // Single-process dev: timers in this process do the publishing; re-armed from the database on boot.
    const timers = new TimerScheduler((postId) => m.publishing.publishPost(postId).then(() => undefined));
    scheduler = timers;
    m = new BaseAir({ handle, connectors: buildRegistry(env), scheduler, secrets: SecretBox.fromEnv(env) });
    const n = await m.publishing.rearm((postId, at) => timers.schedulePublish(postId, at));
    if (n) console.log(`[scheduler] re-armed ${n} scheduled post(s) (in-process timers; set REDIS_URL for durable queues)`);
    // No separate workers process: run the background jobs here, or the feed, radar and metrics never fill.
    if (env.BASE_AIR_INPROCESS_JOBS !== "0") {
      const jobs = startInProcessJobs(m);
      const prev = closeScheduler;
      closeScheduler = async () => {
        jobs.stop();
        await prev();
      };
    }
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
