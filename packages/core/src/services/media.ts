import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { mediaAssets } from "@starsign/db";
import type { MediaFetcher } from "@starsign/connectors";
import { newId } from "@starsign/ledger";
import type { Media } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import { mp4DurationSeconds, probe } from "../media/probe.ts";
import type { MediaStorage } from "../media/storage.ts";

export const MEDIA_LIMITS = { imageBytes: 30 * 1024 * 1024, videoBytes: 1024 * 1024 * 1024, documentBytes: 100 * 1024 * 1024 };

export type MediaRow = typeof mediaAssets.$inferSelect;

/**
 * The media library. Files are sniffed (never trusting the client), deduplicated per workspace by hash, stored
 * under unguessable keys, and exposed by public URL so networks that pull media (Instagram, Threads, TikTok,
 * Pinterest, Facebook) can fetch them. Upload-style networks read bytes through the MediaFetcher.
 */
export class MediaService {
  constructor(
    private readonly ctx: CoreContext,
    readonly storage: MediaStorage,
  ) {}

  async upload(p: Principal, input: { bytes: Uint8Array; filename?: string; alt?: string }): Promise<MediaRow> {
    if (p.actor.type === "human" && p.role === "viewer") throw new CoreError("forbidden", "viewers cannot upload media");
    const info = probe(input.bytes);
    if (!info) throw new CoreError("invalid", "unsupported file: upload JPEG, PNG, GIF, WebP, MP4, MOV, WebM or PDF");
    const cap = info.kind === "video" ? MEDIA_LIMITS.videoBytes : info.kind === "document" ? MEDIA_LIMITS.documentBytes : MEDIA_LIMITS.imageBytes;
    if (input.bytes.length > cap) throw new CoreError("invalid", `file is ${Math.round(input.bytes.length / 1e6)}MB; the limit for ${info.kind} is ${Math.round(cap / 1e6)}MB`);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const [dupe] = await this.ctx.db.select().from(mediaAssets).where(and(eq(mediaAssets.workspaceId, p.workspaceId), eq(mediaAssets.sha256, sha256))).limit(1);
    if (dupe) return dupe;
    const key = `${p.workspaceId.slice(-12)}/${randomBytes(16).toString("hex")}.${info.ext}`;
    await this.storage.put(key, input.bytes, info.mime);
    const duration = info.kind === "video" && info.mime !== "video/webm" ? mp4DurationSeconds(input.bytes) : null;
    const [row] = await this.ctx.db
      .insert(mediaAssets)
      .values({
        id: newId("med"),
        workspaceId: p.workspaceId,
        storageKey: key,
        url: this.storage.publicUrl(key),
        kind: info.kind,
        mime: info.mime,
        bytes: input.bytes.length,
        width: info.width ?? null,
        height: info.height ?? null,
        durationSeconds: duration,
        sha256,
        originalName: input.filename?.slice(0, 255) ?? null,
        alt: input.alt?.slice(0, 1000) ?? null,
        uploadedBy: p.actor,
      })
      .returning();
    return row!;
  }

  async list(workspaceId: string, limit = 100) {
    return this.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.workspaceId, workspaceId)).orderBy(desc(mediaAssets.createdAt)).limit(Math.min(limit, 500));
  }

  async get(workspaceId: string, id: string) {
    const [row] = await this.ctx.db.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.workspaceId, workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `media ${id}`);
    return row;
  }

  async remove(p: Principal, id: string) {
    if (p.actor.type !== "human" || !p.role || p.role === "viewer") throw new CoreError("forbidden", "a person removes media");
    const row = await this.get(p.workspaceId, id);
    await this.ctx.db.delete(mediaAssets).where(eq(mediaAssets.id, id));
    await this.storage.delete(row.storageKey);
  }

  /** As a post media item. */
  toMedia(row: MediaRow): Media {
    return {
      kind: row.kind,
      url: row.url,
      mime: row.mime,
      bytes: row.bytes,
      assetId: row.id,
      ...(row.alt ? { alt: row.alt } : {}),
      ...(row.width ? { width: row.width } : {}),
      ...(row.height ? { height: row.height } : {}),
      ...(row.durationSeconds ? { durationSeconds: row.durationSeconds } : {}),
    };
  }

  /** Bytes for connectors: from storage when the item is ours, else by URL. */
  fetcher(fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init)): MediaFetcher {
    return {
      fetch: async (media) => {
        if (media.assetId) {
          const [row] = await this.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, media.assetId)).limit(1);
          if (row) return { bytes: await this.storage.get(row.storageKey), mime: row.mime };
        }
        const res = await fetchImpl(media.url);
        if (!res.ok) throw new Error(`media ${media.url}: HTTP ${res.status}`);
        return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? media.mime ?? "application/octet-stream" };
      },
    };
  }
}
