import type { Meridian } from "@meridian/core";
import type { Network } from "@meridian/schema";

const X_READ_PRICE_USD = 0.005; // per post object returned by a metered read

/** Pull activity for every active account across workspaces, honoring per-workspace metered-read caps. */
export async function ingestAll(m: Meridian): Promise<{ accounts: number; ingested: number }> {
  let ingested = 0;
  let accounts = 0;
  for (const ws of await m.workspaces.list()) {
    const policy = await m.policy.getActive(ws.id);
    const monthStart = new Date(Date.UTC(m.ctx.now().getUTCFullYear(), m.ctx.now().getUTCMonth(), 1));
    const spentOnX = await meteredSpendSince(m, ws.id, monthStart);
    for (const acc of await m.accounts.list(ws.id)) {
      if (acc.status !== "active") continue;
      let connector;
      try {
        connector = m.ctx.connectors.resolve(acc.connector, acc.network as Network);
      } catch {
        continue;
      }
      const caps = connector.capabilities(acc.network as Network);
      if (!caps.fetchActivity) continue;
      if (caps.meteredReads && spentOnX >= policy.spendCaps.xReadsUsdMonthly) {
        console.warn(`[ingest] ${ws.slug}/${acc.handle}: metered reads paused, monthly cap $${policy.spendCaps.xReadsUsdMonthly} reached`);
        continue;
      }
      const before = readsUsed(connector);
      try {
        const r = await m.listening.ingestAccount(acc.id);
        ingested += r.ingested;
        accounts++;
        if (caps.meteredReads) {
          const cost = (readsUsed(connector) - before) * X_READ_PRICE_USD;
          if (cost > 0) {
            await m.events.append({
              workspaceId: ws.id,
              type: "metric.observed",
              subjectType: "social_account",
              subjectId: acc.id,
              actor: { type: "system", id: "workers" },
              data: { metric: "metered_read_cost_usd", value: cost, network: acc.network },
            });
          }
        }
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

export async function meteredSpendSince(m: Meridian, workspaceId: string, since: Date): Promise<number> {
  const events = await m.events.list({ workspaceId, types: ["metric.observed"], limit: 1000 });
  return events
    .filter((e) => new Date(e.occurredAt) >= since && e.data.metric === "metered_read_cost_usd")
    .reduce((a, e) => a + Number(e.data.value ?? 0), 0);
}

export async function captureOutcomes(m: Meridian) {
  return m.metrics.captureDueOutcomes();
}

export async function refreshForecasts(m: Meridian): Promise<number> {
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
