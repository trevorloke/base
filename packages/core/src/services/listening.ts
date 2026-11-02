import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { activities, socialAccounts, streams } from "@meridian/db";
import { newId } from "@meridian/ledger";
import { findPhrases } from "@meridian/policy";
import { ActivityInput, StreamQuery, type ActivityKind, type Network } from "@meridian/schema";
import { SYSTEM, type CoreContext, type Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import type { AccountService } from "./accounts.ts";

export type StreamRow = typeof streams.$inferSelect;

/** The live feed: every inbound item from every connected account, raw first, normalized second, matched to streams third. */
export class ListeningService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly accounts: AccountService,
  ) {}

  async createStream(p: Principal, input: { name: string; query: unknown }): Promise<StreamRow> {
    const query = StreamQuery.parse(input.query);
    const [row] = await this.ctx.db.insert(streams).values({ id: newId("str"), workspaceId: p.workspaceId, name: input.name, query }).returning();
    return row!;
  }

  async listStreams(workspaceId: string): Promise<StreamRow[]> {
    return this.ctx.db.select().from(streams).where(eq(streams.workspaceId, workspaceId));
  }

  async deleteStream(p: Principal, streamId: string) {
    await this.ctx.db.delete(streams).where(and(eq(streams.id, streamId), eq(streams.workspaceId, p.workspaceId)));
  }

  /** Pull new activity for one account. Returns how many new items landed. */
  async ingestAccount(accountId: string): Promise<{ ingested: number; duplicates: number }> {
    const [account] = await this.ctx.db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1);
    if (!account) throw new CoreError("not_found", `account ${accountId}`);
    if (account.status !== "active") return { ingested: 0, duplicates: 0 };
    const connector = this.ctx.connectors.resolve(account.connector, account.network as Network);
    if (!connector.capabilities(account.network as Network).fetchActivity) return { ingested: 0, duplicates: 0 };
    const items = await connector.fetchActivity(this.accounts.toRef(account), account.lastIngestAt);
    const result = await this.ingestItems(account.workspaceId, account.id, items);
    await this.ctx.db.update(socialAccounts).set({ lastIngestAt: this.ctx.now() }).where(eq(socialAccounts.id, accountId));
    return result;
  }

  /** Store items from any source (connector poll, webhook, historical import). */
  async ingestItems(workspaceId: string, socialAccountId: string | null, rawItems: unknown[]): Promise<{ ingested: number; duplicates: number }> {
    const wsStreams = await this.listStreams(workspaceId);
    let ingested = 0;
    let duplicates = 0;
    const ids: string[] = [];
    for (const raw of rawItems) {
      const item = ActivityInput.parse(raw);
      const rawEvent = await this.ctx.events.appendRaw({
        source: `connector:${item.network}`,
        kind: `activity.${item.kind}`,
        workspaceId,
        externalId: item.externalId,
        payload: item.raw ?? item,
      });
      const matched = wsStreams.filter((s) => matchesStream(StreamQuery.parse(s.query), item)).map((s) => s.id);
      const id = newId("act");
      const inserted = await this.ctx.db
        .insert(activities)
        .values({
          id,
          workspaceId,
          socialAccountId,
          network: item.network,
          kind: item.kind,
          externalId: item.externalId,
          authorHandle: item.authorHandle,
          authorName: item.authorName,
          text: item.text,
          url: item.url,
          parentExternalId: item.parentExternalId,
          occurredAt: new Date(item.occurredAt),
          ingestedAt: this.ctx.now(),
          matchedStreams: matched,
          rawEventId: rawEvent.id,
        })
        .onConflictDoNothing()
        .returning({ id: activities.id });
      if (inserted.length === 0) {
        duplicates++;
        continue;
      }
      ingested++;
      ids.push(id);
      this.ctx.emitter.emit("activity", { workspaceId, id, network: item.network, kind: item.kind, matchedStreams: matched });
    }
    if (ingested > 0) {
      await this.ctx.events.append({
        workspaceId,
        type: "activity.ingested",
        subjectType: "social_account",
        subjectId: socialAccountId ?? "import",
        actor: SYSTEM,
        data: { count: ingested, duplicates, ids: ids.slice(0, 50) },
      });
    }
    return { ingested, duplicates };
  }

  async feed(
    workspaceId: string,
    opts: { streamId?: string; networks?: Network[]; kinds?: ActivityKind[]; accountId?: string; since?: Date; before?: Date; limit?: number; q?: string } = {},
  ) {
    const conds = [eq(activities.workspaceId, workspaceId)];
    if (opts.streamId) conds.push(sql`${activities.matchedStreams} @> ${JSON.stringify([opts.streamId])}::jsonb`);
    if (opts.networks?.length) conds.push(inArray(activities.network, opts.networks));
    if (opts.kinds?.length) conds.push(inArray(activities.kind, opts.kinds));
    if (opts.accountId) conds.push(eq(activities.socialAccountId, opts.accountId));
    if (opts.since) conds.push(gt(activities.occurredAt, opts.since));
    if (opts.before) conds.push(lt(activities.occurredAt, opts.before));
    if (opts.q) conds.push(sql`${activities.text} ILIKE ${"%" + opts.q + "%"}`);
    return this.ctx.db
      .select()
      .from(activities)
      .where(and(...conds))
      .orderBy(desc(activities.occurredAt))
      .limit(Math.min(opts.limit ?? 100, 500));
  }

  async counts(workspaceId: string, since: Date) {
    const rows = await this.ctx.db
      .select({ network: activities.network, kind: activities.kind, n: sql<number>`count(*)` })
      .from(activities)
      .where(and(eq(activities.workspaceId, workspaceId), gt(activities.occurredAt, since)))
      .groupBy(activities.network, activities.kind);
    return rows.map((r) => ({ ...r, n: Number(r.n) }));
  }
}

export function matchesStream(q: StreamQuery, item: ActivityInput): boolean {
  if (q.networks.length && !q.networks.includes(item.network)) return false;
  if (q.kinds.length && !q.kinds.includes(item.kind)) return false;
  const authorOk = q.authors.length === 0 || (item.authorHandle ? q.authors.some((a) => a.replace(/^@/, "").toLowerCase() === item.authorHandle!.replace(/^@/, "").toLowerCase()) : false);
  const keywordOk = q.keywords.length === 0 || (item.text ? findPhrases(item.text, q.keywords).length > 0 : false);
  if (q.authors.length && q.keywords.length) return authorOk || keywordOk;
  return authorOk && keywordOk;
}
