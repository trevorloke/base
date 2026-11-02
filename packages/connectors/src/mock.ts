import { Network, type ActivityInput, type MetricInput } from "@meridian/schema";
import type { AccountRef, Connector, ConnectorCapabilities, PublishInput, PublishResult } from "./types.ts";
import { ConnectorError } from "./types.ts";

interface MockPost {
  externalId: string;
  accountId: string;
  text: string;
  publishedAt: Date;
  idempotencyKey: string;
}

/**
 * In-memory connector for development and tests. Deterministic metrics that grow with age,
 * optional failure injection, and synthetic inbound activity.
 */
export class MockConnector implements Connector {
  readonly name = "mock";
  readonly networks: readonly Network[] = Network.options;
  readonly posts: MockPost[] = [];
  readonly inbox = new Map<string, ActivityInput[]>();
  failNext: { kind: ConnectorError["kind"]; retryable: boolean } | null = null;
  private counter = 0;
  now: () => Date = () => new Date();

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false };
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      throw new ConnectorError(`mock failure (${f.kind})`, f.kind, f.retryable);
    }
    const existing = this.posts.find((p) => p.idempotencyKey === input.idempotencyKey);
    if (existing) return { externalId: existing.externalId, url: `https://mock.social/${account.handle}/${existing.externalId}` };
    const externalId = `mock-${account.network}-${++this.counter}`;
    this.posts.push({ externalId, accountId: account.id, text: input.text, publishedAt: this.now(), idempotencyKey: input.idempotencyKey });
    return { externalId, url: `https://mock.social/${account.handle}/${externalId}` };
  }

  /** Queue synthetic inbound items for an account (tests/dev). */
  enqueueActivity(accountId: string, items: ActivityInput[]): void {
    this.inbox.set(accountId, [...(this.inbox.get(accountId) ?? []), ...items]);
  }

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const items = this.inbox.get(account.id) ?? [];
    return since ? items.filter((i) => new Date(i.occurredAt) > since) : items;
  }

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const out: MetricInput[] = [];
    const now = this.now();
    for (const id of externalIds) {
      const p = this.posts.find((x) => x.externalId === id && x.accountId === account.id);
      if (!p) continue;
      const ageH = Math.max(0, (now.getTime() - p.publishedAt.getTime()) / 3_600_000);
      // Saturating growth: impressions ~ 1000 * (1 - e^{-age/12}); engagements ~ 4% of impressions.
      const impressions = Math.round(1000 * (1 - Math.exp(-ageH / 12)) + p.text.length);
      const engagements = Math.round(impressions * 0.04);
      const at = now.toISOString();
      out.push(
        { entityType: "post_variant", entityId: id, metric: "impressions", value: impressions, observedAt: at, source: "mock" },
        { entityType: "post_variant", entityId: id, metric: "engagements", value: engagements, observedAt: at, source: "mock" },
        { entityType: "post_variant", entityId: id, metric: "likes", value: Math.round(engagements * 0.7), observedAt: at, source: "mock" },
        { entityType: "post_variant", entityId: id, metric: "replies", value: Math.round(engagements * 0.1), observedAt: at, source: "mock" },
      );
    }
    return out;
  }
}
