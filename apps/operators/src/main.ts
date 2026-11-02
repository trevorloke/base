import { AnthropicGateway, FakeGateway, defaultFakeHandlers, type ModelGateway } from "@starsign/ai";
import { Starsign, SecretBox, TimerScheduler, type Scheduler } from "@starsign/core";
import { createDb, migrate } from "@starsign/db";
import { runAnalyst } from "./operators/analyst.ts";
import { stewardClassifier } from "./operators/steward.ts";
import { runWatch } from "./operators/watch.ts";
import { buildRegistry } from "./registry.ts";
import { serve } from "./schedule.ts";

const USAGE = `usage:
  operators serve                                  run Watch every 30 min and the Analyst weekly, for every workspace
  operators watch --workspace <slug>               one Watch run now
  operators analyst --workspace <slug> [--days 7]  one weekly brief now

env: DATABASE_URL (unset = PGlite at ./.pglite), REDIS_URL (set = the workers app owns publishing),
     STARSIGN_MASTER_KEY, STARSIGN_MODEL (default claude-opus-5-5), STARSIGN_FAKE_AI=1 (no model calls),
     ANTHROPIC_API_KEY or an \`ant auth login\` profile for the real gateway.`;

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a?.startsWith("--")) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = "true";
    }
  }
  return out;
}

/** When Redis is present the workers app owns publishing (BullMQ); this process never arms a publish itself. */
class NoopScheduler implements Scheduler {
  async schedulePublish(): Promise<void> {}
  async cancelPublish(): Promise<void> {}
}

const [command = "serve", ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
  process.exit(0);
}

const handle = await createDb({ url: process.env.DATABASE_URL, pglitePath: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_PATH ?? ".pglite") });
await migrate(handle);

const gw: ModelGateway = process.env.STARSIGN_FAKE_AI === "1" ? new FakeGateway(defaultFakeHandlers()) : new AnthropicGateway({ log: (l) => console.log(l) });
// The Steward: semantic red lines consult this synchronous cache; the Watch primes it before every draft hits the gate.
const steward = stewardClassifier(gw);

// Operators propose; humans approve through the API, which arms its own scheduler. The scheduler here only matters
// for anything this process schedules directly, which is nothing by default. Without Redis, in-process timers publish
// (single-node dev); with Redis, the workers app owns publishing and this one records intent only.
let m: Starsign;
const scheduler: Scheduler = process.env.REDIS_URL
  ? new NoopScheduler()
  : new TimerScheduler(async (postId) => {
      await m.publishing.publishPost(postId);
    });
m = new Starsign({ handle, connectors: buildRegistry(), scheduler, secrets: SecretBox.fromEnv(), classifyTopic: steward.classify });

const describeGateway = gw instanceof AnthropicGateway ? `anthropic:${gw.model}` : "fake";

async function workspaceId(slug: string | undefined): Promise<string> {
  if (!slug) {
    console.error("--workspace <slug> is required\n" + USAGE);
    process.exit(2);
  }
  const ws = await m.workspaces.bySlug(slug);
  if (!ws) {
    console.error(`no workspace with slug "${slug}"`);
    process.exit(2);
  }
  return ws.id;
}

const shutdown = async (stop?: () => void) => {
  stop?.();
  await steward.settle().catch(() => {});
  await handle.close();
  process.exit(0);
};

switch (command) {
  case "serve": {
    const h = serve(m, gw, { log: (l) => console.log(l) });
    console.log(`[operators] up: db=${handle.kind} gateway=${describeGateway} publishing=${process.env.REDIS_URL ? "workers (redis)" : "in-process timers"}`);
    process.on("SIGINT", () => void shutdown(h.stop));
    process.on("SIGTERM", () => void shutdown(h.stop));
    break;
  }
  case "watch": {
    const id = await workspaceId(flags.workspace);
    const summary = await runWatch(m, gw, id, { classifier: steward, log: (l) => console.log(l) });
    console.log(JSON.stringify(summary, null, 2));
    await shutdown();
    break;
  }
  case "analyst": {
    const id = await workspaceId(flags.workspace);
    const days = flags.days ? Number(flags.days) : 7;
    if (!Number.isFinite(days) || days <= 0) {
      console.error("--days must be a positive number");
      process.exit(2);
    }
    const result = await runAnalyst(m, gw, id, { periodDays: days, log: (l) => console.log(l) });
    console.log(JSON.stringify(result, null, 2));
    await shutdown();
    break;
  }
  default:
    console.error(`unknown command "${command}"\n${USAGE}`);
    process.exit(2);
}
