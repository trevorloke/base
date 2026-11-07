import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { activities, streams, workspaces } from "@base-air/db";
import { StreamQuery, type ActivityInput } from "@base-air/schema";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import { primaryLanguage, sameLanguage } from "../lang.ts";
import { matchesStream } from "./listening.ts";
import type { OpsService } from "./ops.ts";

/**
 * Monitoring across languages. Every inbound message is labelled with its language at ingest; this service turns
 * the ones not in the team's language into the team's language (in batches, under a daily cap and the workspace's
 * model spend cap), re-matches streams against the translation, and expands a stream's keywords into the words
 * people use for the same things in other languages.
 */

const Lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a language code such as en, ja or pt-BR");

export const LanguageSettings = z.object({
  /** The team's language: what everything is translated into. */
  home: Lang.default("en"),
  /** Translate new messages automatically. Off: only on demand from the feed. */
  autoTranslate: z.boolean().default(true),
  /** Most messages translated automatically per workspace per UTC day. */
  dailyLimit: z.number().int().min(0).max(100_000).default(2000),
});
export type LanguageSettings = z.infer<typeof LanguageSettings>;

export interface TranslatorResult {
  translations: Record<string, string>;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}
/** One model call: translate these messages into `to`. Wired to the model gateway by the process that has one. */
export type Translator = (items: { id: string; text: string; lang: string | null }[], to: string) => Promise<TranslatorResult>;
/** One model call: the keywords as people write them in each language. */
export type KeywordExpander = (keywords: string[], languages: string[]) => Promise<{ byLanguage: Record<string, string[]>; costUsd?: number; inputTokens?: number; outputTokens?: number }>;

const BATCH = 25;
/** Longer messages are cut for translation (the original stays whole); keeps one call bounded. */
const MAX_CHARS = 2000;

type Row = typeof activities.$inferSelect;

export class TranslationService {
  /** Called with ids whose translation just landed (the tracker scans translations too). */
  readonly afterTranslate: ((workspaceId: string, activityIds: string[]) => Promise<unknown>)[] = [];

  constructor(
    private readonly ctx: CoreContext,
    private readonly ops: OpsService,
  ) {}

  async settings(workspaceId: string): Promise<LanguageSettings> {
    const [ws] = await this.ctx.db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) throw new CoreError("not_found", "workspace");
    return LanguageSettings.parse((ws.settings as { languages?: unknown }).languages ?? {});
  }

  async updateSettings(p: Principal, patch: unknown): Promise<LanguageSettings> {
    if (p.actor.type !== "human" || p.role !== "owner") throw new CoreError("forbidden", "only an owner changes language settings");
    const next = LanguageSettings.parse({ ...(await this.settings(p.workspaceId)), ...LanguageSettings.partial().parse(patch) });
    await this.ctx.db
      .update(workspaces)
      .set({ settings: sql`jsonb_set(${workspaces.settings}, '{languages}', ${JSON.stringify(next)}::jsonb, true)` })
      .where(eq(workspaces.id, p.workspaceId));
    return next;
  }

  /** Which languages the feed has seen lately, most common first: drives the language filter. */
  async languagesSeen(workspaceId: string, since: Date) {
    const rows = await this.ctx.db
      .select({ lang: activities.lang, n: sql<number>`count(*)` })
      .from(activities)
      .where(and(eq(activities.workspaceId, workspaceId), gte(activities.occurredAt, since)))
      .groupBy(activities.lang)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ lang: r.lang, n: Number(r.n) }));
  }

  private async translatedToday(workspaceId: string): Promise<number> {
    const now = this.ctx.now();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [r] = await this.ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(activities)
      .where(and(eq(activities.workspaceId, workspaceId), gte(activities.translatedAt, dayStart), isNotNull(activities.translation)));
    return Number(r?.n ?? 0);
  }

  /**
   * Translate what is waiting in one workspace. Messages already in the home language leave the queue without a
   * model call. Returns how many were translated; records the model cost as a "translator" operator run.
   */
  async translateWorkspace(workspaceId: string, translate: Translator, opts: { max?: number } = {}): Promise<{ translated: number; skipped: number; costUsd: number }> {
    const settings = await this.settings(workspaceId);
    const now = this.ctx.now();
    // Same-language messages: done, nothing to translate.
    const done = await this.ctx.db
      .update(activities)
      .set({ translatedAt: now })
      .where(
        and(
          eq(activities.workspaceId, workspaceId),
          isNull(activities.translatedAt),
          isNotNull(activities.lang),
          sql`split_part(${activities.lang}, '-', 1) = ${primaryLanguage(settings.home)}`,
        ),
      )
      .returning({ id: activities.id });
    if (!settings.autoTranslate) return { translated: 0, skipped: done.length, costUsd: 0 };
    const budget = Math.max(0, Math.min(opts.max ?? 200, settings.dailyLimit - (await this.translatedToday(workspaceId))));
    if (budget === 0) return { translated: 0, skipped: done.length, costUsd: 0 };
    const rows = await this.ctx.db
      .select()
      .from(activities)
      .where(and(eq(activities.workspaceId, workspaceId), isNull(activities.translatedAt), isNotNull(activities.lang), isNotNull(activities.text)))
      .orderBy(desc(activities.ingestedAt))
      .limit(budget);
    if (rows.length === 0) return { translated: 0, skipped: done.length, costUsd: 0 };
    const r = await this.run(workspaceId, rows, settings.home, translate);
    return { translated: r.translated, skipped: done.length, costUsd: r.costUsd };
  }

  /** Translate one message now, whatever its detected language (the feed's "Translate" button). */
  async translateOne(p: Principal, activityId: string, translate: Translator): Promise<Row> {
    const [row] = await this.ctx.db.select().from(activities).where(and(eq(activities.id, activityId), eq(activities.workspaceId, p.workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `activity ${activityId}`);
    if (!row.text) throw new CoreError("invalid", "this item has no text to translate");
    const settings = await this.settings(p.workspaceId);
    if (row.translation && row.translationLang === settings.home) return row;
    await this.run(p.workspaceId, [row], settings.home, translate);
    const [fresh] = await this.ctx.db.select().from(activities).where(eq(activities.id, activityId)).limit(1);
    return fresh!;
  }

  private async run(workspaceId: string, rows: Row[], to: string, translate: Translator): Promise<{ translated: number; costUsd: number }> {
    const runId = await this.ops.startRun(workspaceId, "translator");
    let translated = 0;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const res = await translate(
          batch.map((r) => ({ id: r.id, text: r.text!.slice(0, MAX_CHARS), lang: r.lang })),
          to,
        );
        costUsd += res.costUsd ?? 0;
        inputTokens += res.inputTokens ?? 0;
        outputTokens += res.outputTokens ?? 0;
        for (const r of batch) {
          const text = res.translations[r.id];
          if (typeof text !== "string") continue; // left in the queue for the next run
          const unchanged = text.trim() === r.text!.trim() || sameLanguage(r.lang, to);
          await this.ctx.db
            .update(activities)
            .set({ translation: unchanged ? null : text, translationLang: unchanged ? null : to, translatedAt: this.ctx.now() })
            .where(eq(activities.id, r.id));
          if (!unchanged) {
            translated++;
            await this.rematch(workspaceId, r, text);
            this.ctx.emitter.emit("activity", { workspaceId, id: r.id, network: r.network, kind: r.kind, matchedStreams: r.matchedStreams, translated: true });
          }
        }
      }
      const done = rows.map((r) => r.id);
      for (const hook of this.afterTranslate) await hook(workspaceId, done).catch((e) => console.error("[translation] after-translate hook failed:", (e as Error).message));
      await this.ops.finishRun(runId, { status: "succeeded", summary: `translated ${translated} message(s) into ${to}`, inputTokens, outputTokens, costUsd });
    } catch (e) {
      await this.ops.finishRun(runId, { status: "failed", error: (e as Error).message, summary: `translated ${translated} before failing`, inputTokens, outputTokens, costUsd });
      throw e;
    }
    return { translated, costUsd };
  }

  /** A translation can bring a message into streams whose keywords are in the team's language. */
  private async rematch(workspaceId: string, row: Row, translation: string): Promise<void> {
    const wsStreams = await this.ctx.db.select().from(streams).where(eq(streams.workspaceId, workspaceId));
    const item: ActivityInput = {
      network: row.network as ActivityInput["network"],
      kind: row.kind as ActivityInput["kind"],
      externalId: row.externalId,
      authorHandle: row.authorHandle,
      authorName: row.authorName,
      text: row.text,
      url: row.url,
      parentExternalId: row.parentExternalId,
      occurredAt: row.occurredAt.toISOString(),
      raw: null,
    };
    const added = wsStreams.filter((s) => !row.matchedStreams.includes(s.id) && matchesStream(StreamQuery.parse(s.query), item, { lang: row.lang, translation })).map((s) => s.id);
    if (added.length) await this.ctx.db.update(activities).set({ matchedStreams: [...row.matchedStreams, ...added] }).where(eq(activities.id, row.id));
  }

  /** Every workspace with messages waiting. */
  async workspacesWithPending(): Promise<string[]> {
    const rows = await this.ctx.db
      .selectDistinct({ id: activities.workspaceId })
      .from(activities)
      .where(and(isNull(activities.translatedAt), isNotNull(activities.lang), isNotNull(activities.text)))
      .limit(500);
    return rows.map((r) => r.id);
  }

  /**
   * Add the stream's keywords as people write them in other languages. Stored on the stream (query.translations),
   * shown to the team, editable like any keyword; matching uses them from then on.
   */
  async expandStream(p: Principal, streamId: string, languages: string[], expand: KeywordExpander) {
    if (p.actor.type === "human" && p.role === "viewer") throw new CoreError("forbidden", "viewers cannot change streams");
    const [row] = await this.ctx.db.select().from(streams).where(and(eq(streams.id, streamId), eq(streams.workspaceId, p.workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `stream ${streamId}`);
    const query = StreamQuery.parse(row.query);
    if (query.keywords.length === 0) throw new CoreError("invalid", "this stream has no keywords to translate");
    const langs = [...new Set(languages.map((l) => primaryLanguage(Lang.parse(l))))].slice(0, 12);
    if (langs.length === 0) throw new CoreError("invalid", "name at least one language");
    const runId = await this.ops.startRun(p.workspaceId, "translator");
    try {
      const res = await expand(query.keywords, langs);
      const translations = { ...query.translations };
      for (const lang of langs) {
        const terms = [...new Set((res.byLanguage[lang] ?? []).map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 80))].slice(0, 40);
        if (terms.length) translations[lang] = terms;
      }
      const next = { ...query, translations };
      const [updated] = await this.ctx.db.update(streams).set({ query: next }).where(eq(streams.id, streamId)).returning();
      await this.ops.finishRun(runId, { status: "succeeded", summary: `expanded "${row.name}" into ${langs.join(", ")}`, costUsd: res.costUsd ?? 0, inputTokens: res.inputTokens ?? 0, outputTokens: res.outputTokens ?? 0 });
      return updated!;
    } catch (e) {
      await this.ops.finishRun(runId, { status: "failed", error: (e as Error).message });
      throw e;
    }
  }
}
