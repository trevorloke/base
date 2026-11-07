import type { Starsign } from "@starsign/core";
import type { Network } from "@starsign/schema";
import { createDefaultSources, type SourceAdapter } from "@starsign/sources";

/** Pull activity for every active account across workspaces, honoring per-workspace metered-read caps. */
export async function ingestAll(m: Starsign): Promise<{ accounts: number; ingested: number }> {
  let ingested = 0;
  let accounts = 0;
  for (const ws of await m.workspaces.list()) {
    for (const acc of await m.accounts.list(ws.id)) {
      if (acc.status !== "active") continue;
      let connector;
      try {
        connector = m.ctx.connectors.resolve(acc.connector, acc.network as Network);
      } catch (e) {
        console.warn(`[ingest] ${ws.slug}/${acc.handle}: ${(e as Error).message}`);
        continue;
      }
      const caps = connector.capabilities(acc.network as Network);
      if (!caps.fetchActivity) continue;
      if (caps.meteredReads && !(await m.metrics.underMeteredCap(ws.id))) {
        console.warn(`[ingest] ${ws.slug}/${acc.handle}: metered reads paused, monthly cap reached`);
        continue;
      }
      const before = readsUsed(connector);
      try {
        const r = await m.listening.ingestAccount(acc.id);
        ingested += r.ingested;
        accounts++;
        if (caps.meteredReads) await m.metrics.recordMeteredReads(ws.id, acc.id, acc.network, readsUsed(connector) - before);
      } catch (e) {
        console.error(`[ingest] ${ws.slug}/${acc.handle} failed:`, (e as Error).message);
      }
    }
  }
  return { accounts, ingested };
}

function readsUsed(connector: unknown): number {
  const v = (connector as { readsUsed?: unknown }).readsUsed;
  return typeof v === "number" ? v : 0;
}

export async function captureOutcomes(m: Starsign) {
  return m.metrics.captureDueOutcomes();
}

export async function refreshForecasts(m: Starsign): Promise<number> {
  const seen = new Set<string>();
  for (const ws of await m.workspaces.list()) {
    for (const t of await m.trends.listTopics(ws.id)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      try {
        await m.trends.computeForecast(t.id);
      } catch (e) {
        console.error(`[forecast] ${t.name} failed:`, (e as Error).message);
      }
    }
  }
  return seen.size;
}

/** Sample every topic from every configured trend source, and store what is trending now for the Scout. */
export async function pullSources(m: Starsign, sources: SourceAdapter[] = createDefaultSources(), region = process.env.STARSIGN_TRENDS_REGION ?? "US") {
  const results = await m.sources.pull(sources, { region });
  for (const r of results) if (r.error) console.warn(`[sources] ${r.source}: ${r.error}`);
  return results;
}
