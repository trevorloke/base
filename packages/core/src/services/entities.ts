import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { activities, entityMentions, trackedEntities, trendTopics } from "@starsign/db";
import { findPhrases } from "@starsign/policy";
import { Network } from "@starsign/schema";
import { newId } from "@starsign/ledger";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import type { TrendService } from "./trends.ts";
import type { ListeningService } from "./listening.ts";
import type { MentionSearch } from "@starsign/sources";

/**
 * The tracker. Named organisations (a party, a brand, a company) and people (a candidate, a spokesperson, a creator,
 * an individual's own brand), each with every way people write them: aliases in other languages and scripts,
 * nicknames, abbreviations, and social handles. Every message Starsign ingests (inboxes, chat groups, public search,
 * translations) is scanned for them; people roll up into the organisation they belong to.
 */

const Term = z.string().trim().min(1).max(120);
const Handle = z.string().trim().min(1).max(120).transform((h) => h.replace(/^@/, ""));

export const EntityKind = z.enum(["organization", "person"]);
export const EntityRelation = z.enum(["own", "client", "prospect", "competitor", "opponent", "watch"]);

export const EntityInput = z.object({
  kind: EntityKind,
  name: z.string().trim().min(1).max(200),
  /** What it is, in the team's words: party, brand, candidate, spokesperson, creator, company... */
  role: z.string().trim().max(60).optional(),
  /** The organisation this belongs to: a candidate's party, an individual's brand, a brand's parent company. */
  parentId: z.string().optional(),
  relation: EntityRelation.default("watch"),
  /** Other ways it is written: other languages and scripts, nicknames, abbreviations, old names. */
  aliases: z.array(Term).max(60).default([]),
  /** Its own accounts, per network: messages from these are "by" the entity; @mentions of them count as mentions. */
  handles: z.partialRecord(Network, z.array(Handle).max(20)).default({}),
  /** For ambiguous names: a name match counts only when one of these words also appears. */
  context: z.array(Term).max(40).default([]),
  /** Never count a name match when one of these appears (a namesake, a common phrase). */
  exclude: z.array(Term).max(40).default([]),
  /** Wikipedia article titles, for the attention forecast ("Justin_Trudeau"). */
  wikipedia: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  /** Forecast its momentum on the radar (creates a trend topic). */
  trackTrend: z.boolean().default(true),
  /** Search public posts and news for it, not only the workspace's own inboxes and chats. */
  scanPublic: z.boolean().default(true),
  notes: z.string().max(4000).optional(),
});
export type EntityInput = z.input<typeof EntityInput>;
export type EntityRow = typeof trackedEntities.$inferSelect;

export interface MentionMatch {
  how: "name" | "handle" | "author";
  term: string;
}

const norm = (h: string) => h.replace(/^@/, "").toLowerCase();

/**
 * Whether a message is by or about an entity. Checked in order: written by one of its handles; an @mention of one;
 * its name or an alias in the text or the translation (subject to context and exclusion words).
 */
export function matchEntity(
  e: Pick<EntityRow, "name" | "aliases" | "handles" | "context" | "exclude">,
  item: { network: string; text: string | null; translation?: string | null; authorHandle: string | null },
): MentionMatch | null {
  const handles = (e.handles[item.network] ?? []).map(norm);
  if (item.authorHandle && handles.includes(norm(item.authorHandle))) return { how: "author", term: `@${norm(item.authorHandle)}` };
  const texts = [item.text, item.translation].filter((t): t is string => !!t);
  if (texts.length === 0) return null;
  // @mentions of the entity's handle on any network it is known on.
  const allHandles = Object.values(e.handles).flat();
  for (const t of texts) {
    const hit = findPhrases(t, allHandles.map((h) => `@${norm(h)}`))[0];
    if (hit) return { how: "handle", term: hit };
  }
  const names = [e.name, ...e.aliases];
  for (const t of texts) {
    const hit = findPhrases(t, names)[0];
    if (!hit) continue;
    if (e.exclude.length && texts.some((x) => findPhrases(x, e.exclude).length > 0)) return null;
    if (e.context.length && !texts.some((x) => findPhrases(x, e.context).length > 0)) continue;
    return { how: "name", term: hit };
  }
  return null;
}

type ActivityRow = typeof activities.$inferSelect;

export interface PublicScanResult {
  entities: number;
  found: number;
  stored: number;
  errors: string[];
}

/** First scan of a new entity looks back this far; later scans continue from the last run per source. */
const FIRST_SCAN_LOOKBACK_MS = 24 * 3_600_000;

export class EntityService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly trends: TrendService,
    private readonly listening: ListeningService,
  ) {}

  /**
   * Search public posts and news for every tracked name, in every workspace (or one). Only results that pass the
   * entity's own rules (name or alias present, context words when set, no exclusion words) are stored, as feed items
   * with no connected account; storing them runs the tracker's normal scan, so mentions and roll-ups follow.
   */
  async scanPublic(searches: MentionSearch[], opts: { workspaceId?: string; entityId?: string; perEntityLimit?: number; maxEntities?: number } = {}): Promise<PublicScanResult> {
    const result: PublicScanResult = { entities: 0, found: 0, stored: 0, errors: [] };
    if (searches.length === 0) return result;
    const conds = [isNull(trackedEntities.archivedAt), eq(trackedEntities.scanPublic, true)];
    if (opts.workspaceId) conds.push(eq(trackedEntities.workspaceId, opts.workspaceId));
    if (opts.entityId) conds.push(eq(trackedEntities.id, opts.entityId));
    const rows = await this.ctx.db.select().from(trackedEntities).where(and(...conds)).orderBy(trackedEntities.updatedAt).limit(opts.maxEntities ?? 200);
    const now = this.ctx.now();
    for (const e of rows) {
      result.entities++;
      // The name and the most distinctive aliases; hashtags and other scripts are often the best search terms.
      const terms = [e.name, ...e.aliases].slice(0, 5);
      const state = { ...e.scanState };
      for (const s of searches) {
        const last = state[s.name] ? new Date(state[s.name]!) : new Date(now.getTime() - FIRST_SCAN_LOOKBACK_MS);
        try {
          const items = await s.search({ terms, since: last, now, limit: opts.perEntityLimit ?? 50 });
          result.found += items.length;
          const relevant = items.filter((it) => matchEntity(e, { network: it.network, text: it.text, authorHandle: it.authorHandle }));
          if (relevant.length) result.stored += (await this.listening.ingestItems(e.workspaceId, null, relevant)).ingested;
          state[s.name] = now.toISOString();
        } catch (err) {
          result.errors.push(`${e.name} / ${s.name}: ${(err as Error).message}`);
        }
      }
      await this.ctx.db.update(trackedEntities).set({ scanState: state }).where(eq(trackedEntities.id, e.id));
    }
    return result;
  }

  private canEdit(p: Principal) {
    if (p.actor.type === "human" && (!p.role || p.role === "viewer")) throw new CoreError("forbidden", "viewers cannot change the tracker");
  }

  async list(workspaceId: string, opts: { includeArchived?: boolean } = {}): Promise<EntityRow[]> {
    const conds = [eq(trackedEntities.workspaceId, workspaceId)];
    if (!opts.includeArchived) conds.push(isNull(trackedEntities.archivedAt));
    return this.ctx.db.select().from(trackedEntities).where(and(...conds)).orderBy(trackedEntities.kind, trackedEntities.name);
  }

  async get(workspaceId: string, id: string): Promise<EntityRow> {
    const [row] = await this.ctx.db.select().from(trackedEntities).where(and(eq(trackedEntities.id, id), eq(trackedEntities.workspaceId, workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `entity ${id}`);
    return row;
  }

  private async checkParent(workspaceId: string, parentId: string | undefined, selfId?: string) {
    if (!parentId) return;
    const parent = await this.get(workspaceId, parentId);
    if (parent.kind !== "organization") throw new CoreError("invalid", "a person or organisation can only belong to an organisation");
    // No cycles: walk up from the parent.
    let cursor: EntityRow | undefined = parent;
    for (let depth = 0; cursor && depth < 10; depth++) {
      if (cursor.id === selfId) throw new CoreError("invalid", "that would make the organisation part of itself");
      cursor = cursor.parentId ? await this.get(workspaceId, cursor.parentId) : undefined;
    }
  }

  private topicKeywords(e: Pick<EntityRow, "name" | "aliases" | "wikipedia">): string[] {
    return [...new Set([e.name, ...e.aliases.slice(0, 6), ...e.wikipedia.map((w) => `wiki:${w}`)])];
  }

  async create(p: Principal, raw: unknown): Promise<EntityRow> {
    this.canEdit(p);
    const input = EntityInput.parse(raw);
    await this.checkParent(p.workspaceId, input.parentId);
    const id = newId("ent");
    let trendTopicId: string | null = null;
    if (input.trackTrend) {
      const topic = await this.trends.createTopic({ workspaceId: p.workspaceId, name: input.name, keywords: this.topicKeywords(input), relevance: 1, actor: p.actor, why: "tracked entity" });
      trendTopicId = topic.id;
    }
    const [row] = await this.ctx.db
      .insert(trackedEntities)
      .values({
        id,
        workspaceId: p.workspaceId,
        kind: input.kind,
        name: input.name,
        role: input.role ?? null,
        parentId: input.parentId ?? null,
        relation: input.relation,
        aliases: dedupe(input.aliases),
        handles: input.handles as Record<string, string[]>,
        context: dedupe(input.context),
        exclude: dedupe(input.exclude),
        wikipedia: dedupe(input.wikipedia),
        trendTopicId,
        notes: input.notes ?? null,
        scanPublic: input.scanPublic,
        createdBy: p.actor,
      })
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "entity.created", subjectType: "tracked_entity", subjectId: id, actor: p.actor, data: { kind: input.kind, name: input.name, role: input.role ?? null, relation: input.relation, parentId: input.parentId ?? null } });
    await this.backfill(p.workspaceId, row!);
    return row!;
  }

  async update(p: Principal, id: string, raw: unknown): Promise<EntityRow> {
    this.canEdit(p);
    await this.get(p.workspaceId, id);
    const patch = EntityInput.partial().parse(raw);
    if (patch.parentId !== undefined) await this.checkParent(p.workspaceId, patch.parentId || undefined, id);
    const next = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.role !== undefined ? { role: patch.role || null } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId || null } : {}),
      ...(patch.relation !== undefined ? { relation: patch.relation } : {}),
      ...(patch.aliases !== undefined ? { aliases: dedupe(patch.aliases) } : {}),
      ...(patch.handles !== undefined ? { handles: patch.handles as Record<string, string[]> } : {}),
      ...(patch.context !== undefined ? { context: dedupe(patch.context) } : {}),
      ...(patch.exclude !== undefined ? { exclude: dedupe(patch.exclude) } : {}),
      ...(patch.wikipedia !== undefined ? { wikipedia: dedupe(patch.wikipedia) } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
      ...(patch.scanPublic !== undefined ? { scanPublic: patch.scanPublic } : {}),
      updatedAt: this.ctx.now(),
    };
    const [row] = await this.ctx.db.update(trackedEntities).set(next).where(eq(trackedEntities.id, id)).returning();
    if (row!.trendTopicId) await this.ctx.db.update(trendTopics).set({ name: row!.name, keywords: this.topicKeywords(row!) }).where(eq(trendTopics.id, row!.trendTopicId));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "entity.updated", subjectType: "tracked_entity", subjectId: id, actor: p.actor, data: { changed: Object.keys(patch) } });
    // How it is matched may have changed: rebuild its mentions from what is stored.
    const matchingChanged = ["name", "aliases", "handles", "context", "exclude"].some((k) => k in patch);
    if (matchingChanged) {
      await this.ctx.db.delete(entityMentions).where(eq(entityMentions.entityId, id));
      await this.backfill(p.workspaceId, row!);
    }
    return row!;
  }

  /** Stop tracking; history stays (mentions and the ledger), the entity leaves lists and reports. */
  async archive(p: Principal, id: string): Promise<void> {
    this.canEdit(p);
    const e = await this.get(p.workspaceId, id);
    await this.ctx.db.update(trackedEntities).set({ archivedAt: this.ctx.now() }).where(eq(trackedEntities.id, id));
    if (e.trendTopicId) await this.ctx.db.update(trendTopics).set({ relevance: 0 }).where(eq(trendTopics.id, e.trendTopicId));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "entity.archived", subjectType: "tracked_entity", subjectId: id, actor: p.actor, data: { name: e.name } });
  }

  // ------------------------------------------------------------ scanning

  /** Scan freshly ingested or freshly translated messages against every tracked entity in the workspace. */
  async scanActivities(workspaceId: string, activityIds: string[]): Promise<number> {
    if (activityIds.length === 0) return 0;
    const entities = await this.list(workspaceId);
    if (entities.length === 0) return 0;
    const rows = await this.ctx.db.select().from(activities).where(and(eq(activities.workspaceId, workspaceId), inArray(activities.id, activityIds)));
    return this.record(workspaceId, entities, rows);
  }

  /** A new or changed entity: find it in the last 90 days of stored messages. */
  private async backfill(workspaceId: string, e: EntityRow): Promise<number> {
    const since = new Date(this.ctx.now().getTime() - 90 * 86_400_000);
    let total = 0;
    let before: Date | null = null;
    for (let page = 0; page < 20; page++) {
      const conds = [eq(activities.workspaceId, workspaceId), gte(activities.occurredAt, since)];
      if (before) conds.push(sql`${activities.occurredAt} < ${before}`);
      const rows = await this.ctx.db.select().from(activities).where(and(...conds)).orderBy(desc(activities.occurredAt)).limit(1000);
      if (rows.length === 0) break;
      total += await this.record(workspaceId, [e], rows);
      before = rows.at(-1)!.occurredAt;
      if (rows.length < 1000) break;
    }
    return total;
  }

  private async record(workspaceId: string, entities: EntityRow[], rows: ActivityRow[]): Promise<number> {
    const values: (typeof entityMentions.$inferInsert)[] = [];
    for (const r of rows) {
      for (const e of entities) {
        const m = matchEntity(e, r);
        if (!m) continue;
        values.push({ id: newId("emn"), workspaceId, entityId: e.id, activityId: r.id, how: m.how, term: m.term.slice(0, 200), network: r.network, lang: r.lang, authorHandle: r.authorHandle, occurredAt: r.occurredAt });
      }
    }
    if (values.length === 0) return 0;
    let inserted = 0;
    for (let i = 0; i < values.length; i += 500) {
      const res = await this.ctx.db.insert(entityMentions).values(values.slice(i, i + 500)).onConflictDoNothing().returning({ id: entityMentions.id, entityId: entityMentions.entityId });
      inserted += res.length;
      for (const r of res) this.ctx.emitter.emit("mention", { workspaceId, entityId: r.entityId });
    }
    return inserted;
  }

  // ------------------------------------------------------------ reading

  /** The entity and everything that belongs to it (its candidates, its sub-brands), for roll-ups. */
  private family(all: EntityRow[], rootId: string): string[] {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) for (const e of all) if (e.parentId === out[i] && !out.includes(e.id)) out.push(e.id);
    return out;
  }

  /** Activity ids for the feed's entity filter (with or without the people who belong to it). */
  async activityIdsFor(workspaceId: string, entityId: string, opts: { includeChildren?: boolean; limit?: number } = {}): Promise<string[]> {
    const all = await this.list(workspaceId, { includeArchived: true });
    const ids = opts.includeChildren ? this.family(all, entityId) : [entityId];
    const rows = await this.ctx.db
      .selectDistinct({ id: entityMentions.activityId, at: entityMentions.occurredAt })
      .from(entityMentions)
      .where(and(eq(entityMentions.workspaceId, workspaceId), inArray(entityMentions.entityId, ids)))
      .orderBy(desc(entityMentions.occurredAt))
      .limit(Math.min(opts.limit ?? 500, 2000));
    return rows.map((r) => r.id);
  }

  /**
   * Who is being talked about, and how much. Per entity: mentions by others, messages by the entity itself, distinct
   * people talking, by network, by language and by day; organisations also carry the totals of everyone who belongs
   * to them. Share of voice compares top-level entities with each other and people within each organisation.
   */
  async report(workspaceId: string, from: Date, to: Date, timezone = "UTC") {
    const all = await this.list(workspaceId);
    const base = and(eq(entityMentions.workspaceId, workspaceId), gte(entityMentions.occurredAt, from), lte(entityMentions.occurredAt, to));
    const counts = await this.ctx.db
      .select({
        entityId: entityMentions.entityId,
        mentions: sql<number>`count(*) FILTER (WHERE ${entityMentions.how} <> 'author')`,
        authored: sql<number>`count(*) FILTER (WHERE ${entityMentions.how} = 'author')`,
        people: sql<number>`count(DISTINCT ${entityMentions.authorHandle}) FILTER (WHERE ${entityMentions.how} <> 'author')`,
        sentiment: sql<number | null>`avg(${activities.sentiment}) FILTER (WHERE ${entityMentions.how} <> 'author')`,
      })
      .from(entityMentions)
      .innerJoin(activities, eq(activities.id, entityMentions.activityId))
      .where(base)
      .groupBy(entityMentions.entityId);
    const byNetwork = await this.ctx.db
      .select({ entityId: entityMentions.entityId, key: entityMentions.network, n: sql<number>`count(*)` })
      .from(entityMentions)
      .where(and(base, sql`${entityMentions.how} <> 'author'`))
      .groupBy(entityMentions.entityId, entityMentions.network);
    const byLanguage = await this.ctx.db
      .select({ entityId: entityMentions.entityId, key: entityMentions.lang, n: sql<number>`count(*)` })
      .from(entityMentions)
      .where(and(base, sql`${entityMentions.how} <> 'author'`))
      .groupBy(entityMentions.entityId, entityMentions.lang);
    // Inlined (not a parameter) so SELECT, GROUP BY and ORDER BY are the same expression; the name is checked first.
    const tz = /^[A-Za-z0-9_+\-/]{1,64}$/.test(timezone) ? timezone : "UTC";
    const day = sql<string>`to_char(${entityMentions.occurredAt} AT TIME ZONE ${sql.raw(`'${tz}'`)}, 'YYYY-MM-DD')`;
    const byDay = await this.ctx.db
      .select({ entityId: entityMentions.entityId, key: day, n: sql<number>`count(*)` })
      .from(entityMentions)
      .where(and(base, sql`${entityMentions.how} <> 'author'`))
      .groupBy(entityMentions.entityId, day)
      .orderBy(day);

    const own = new Map(counts.map((c) => [c.entityId, { mentions: Number(c.mentions), authored: Number(c.authored), people: Number(c.people), sentiment: c.sentiment === null ? null : Number(c.sentiment) }]));
    const group = <T extends { entityId: string; key: string | null; n: number }>(rows: T[]) => {
      const m = new Map<string, { key: string | null; n: number }[]>();
      for (const r of rows) m.set(r.entityId, [...(m.get(r.entityId) ?? []), { key: r.key, n: Number(r.n) }]);
      return m;
    };
    const nets = group(byNetwork);
    const langs = group(byLanguage);
    const days = group(byDay);
    const empty = { mentions: 0, authored: 0, people: 0, sentiment: null as number | null };

    const entities = all.map((e) => {
      const fam = this.family(all, e.id);
      const self = own.get(e.id) ?? empty;
      const familyMentions = fam.reduce((s, id) => s + (own.get(id)?.mentions ?? 0), 0);
      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        role: e.role,
        relation: e.relation,
        parentId: e.parentId,
        trendTopicId: e.trendTopicId,
        ...self,
        familyMentions,
        byNetwork: (nets.get(e.id) ?? []).map((x) => ({ network: x.key, n: x.n })).sort((a, b) => b.n - a.n),
        byLanguage: (langs.get(e.id) ?? []).map((x) => ({ lang: x.key, n: x.n })).sort((a, b) => b.n - a.n),
        byDay: (days.get(e.id) ?? []).map((x) => ({ day: x.key!, n: x.n })),
      };
    });
    const share = (ids: string[], value: (id: string) => number) => {
      const total = ids.reduce((s, id) => s + value(id), 0);
      return Object.fromEntries(ids.map((id) => [id, total ? Math.round((value(id) / total) * 1000) / 10 : 0]));
    };
    const byId = new Map(entities.map((e) => [e.id, e]));
    const topLevel = entities.filter((e) => !e.parentId || !byId.has(e.parentId)).map((e) => e.id);
    const topShare = share(topLevel, (id) => byId.get(id)!.familyMentions);
    const withinParent: Record<string, number> = {};
    for (const parent of entities) {
      const kids = entities.filter((e) => e.parentId === parent.id).map((e) => e.id);
      Object.assign(withinParent, share(kids, (id) => byId.get(id)!.mentions));
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      entities: entities.map((e) => ({ ...e, shareOfVoice: topShare[e.id] ?? null, shareWithinParent: withinParent[e.id] ?? null })),
    };
  }

  /** The latest messages about an entity (and, for an organisation, its people), with how each matched. */
  async mentions(workspaceId: string, entityId: string, opts: { includeChildren?: boolean; limit?: number } = {}) {
    await this.get(workspaceId, entityId);
    const all = await this.list(workspaceId, { includeArchived: true });
    const ids = opts.includeChildren ? this.family(all, entityId) : [entityId];
    return this.ctx.db
      .select({ mention: entityMentions, activity: activities })
      .from(entityMentions)
      .innerJoin(activities, eq(activities.id, entityMentions.activityId))
      .where(and(eq(entityMentions.workspaceId, workspaceId), inArray(entityMentions.entityId, ids)))
      .orderBy(desc(entityMentions.occurredAt))
      .limit(Math.min(opts.limit ?? 50, 500));
  }
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.normalize("NFKC").toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}
