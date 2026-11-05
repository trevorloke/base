import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { mediaAssets } from "@starsign/db";
import type { MediaFetcher } from "@starsign/connectors";
import { newId } from "@starsign/ledger";
import type { Media } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import { mp4DurationFromRanges, mp4DurationSeconds, probe } from "../media/probe.ts";
import type { MediaStorage } from "../media/storage.ts";

/**
 * Uploads are held in memory while they are checked and stored, so the cap must fit the instance. The default
 * (100 MB) is safe on a 512 MB instance; raise STARSIGN_MAX_UPLOAD_MB on bigger machines. With S3 storage, larger
 * files go straight to the bucket (createDirectUpload / completeDirectUpload) and never pass through the API.
 */
export const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.STARSIGN_MAX_UPLOAD_MB ?? 100)) * 1024 * 1024;
export const MEDIA_LIMITS = {
  imageBytes: Math.min(30 * 1024 * 1024, MAX_UPLOAD_BYTES),
  videoBytes: Math.min(1024 * 1024 * 1024, MAX_UPLOAD_BYTES),
  documentBytes: Math.min(100 * 1024 * 1024, MAX_UPLOAD_BYTES),
};

/** Direct-to-bucket caps: the networks' own ceilings (TikTok and Instagram take up to 4 GB video), not the instance's. */
export const DIRECT_LIMITS = { imageBytes: 30 * 1024 * 1024, videoBytes: 4 * 1024 * 1024 * 1024, documentBytes: 100 * 1024 * 1024 };
const DIRECT_TTL_SECONDS = 3600;
const DIRECT_TYPES: Record<string, { kind: "image" | "video" | "gif" | "document"; ext: string }> = {
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/gif": { kind: "gif", ext: "gif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/quicktime": { kind: "video", ext: "mov" },
  "video/webm": { kind: "video", ext: "webm" },
  "application/pdf": { kind: "document", ext: "pdf" },
};

interface DirectTicket {
  ws: string;
  key: string;
  mime: string;
  max: number;
  exp: number;
  name?: string;
}

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

  /** What this deployment accepts, so clients pick the right upload path. */
  limits() {
    return { maxUploadBytes: MAX_UPLOAD_BYTES, direct: Boolean(this.storage.presignPut && this.storage.head && this.storage.getRange), directLimits: DIRECT_LIMITS, types: Object.keys(DIRECT_TYPES) };
  }

  /**
   * Step 1 of a direct upload: a presigned PUT for an unguessable key in this workspace. The returned uploadId is a
   * sealed ticket (workspace, key, type, size cap, expiry), so completing needs no server-side state.
   */
  async createDirectUpload(p: Principal, input: { mime: string; bytes: number; filename?: string }) {
    if (p.actor.type === "human" && p.role === "viewer") throw new CoreError("forbidden", "viewers cannot upload media");
    if (!this.storage.presignPut) throw new CoreError("unavailable", "direct uploads need S3-compatible storage (STARSIGN_S3_*); use POST /v1/media");
    const type = DIRECT_TYPES[input.mime];
    if (!type) throw new CoreError("invalid", "unsupported type: upload JPEG, PNG, GIF, WebP, MP4, MOV, WebM or PDF");
    const max = type.kind === "video" ? DIRECT_LIMITS.videoBytes : type.kind === "document" ? DIRECT_LIMITS.documentBytes : DIRECT_LIMITS.imageBytes;
    if (!Number.isFinite(input.bytes) || input.bytes <= 0) throw new CoreError("invalid", "bytes must be the file size");
    if (input.bytes > max) throw new CoreError("invalid", `file is ${Math.round(input.bytes / 1e6)}MB; the limit for ${type.kind} is ${Math.round(max / 1e6)}MB`);
    const key = `${p.workspaceId.slice(-12)}/${randomBytes(16).toString("hex")}.${type.ext}`;
    const exp = this.ctx.now().getTime() + DIRECT_TTL_SECONDS * 1000;
    const signed = this.storage.presignPut(key, input.mime, DIRECT_TTL_SECONDS);
    const ticket: DirectTicket = { ws: p.workspaceId, key, mime: input.mime, max, exp, ...(input.filename ? { name: input.filename.slice(0, 255) } : {}) };
    return { uploadId: this.ctx.secrets.encrypt(ticket), method: "PUT" as const, url: signed.url, headers: signed.headers, expiresAt: new Date(exp).toISOString(), maxBytes: max };
  }

  /**
   * Step 2: after the browser's PUT, check what actually landed (size from HEAD, type and dimensions from the first
   * 64 KB, MP4 duration from ranged reads) and add it to the library. A file that is not what it claimed is deleted.
   */
  async completeDirectUpload(p: Principal, input: { uploadId: string; alt?: string }): Promise<MediaRow> {
    if (p.actor.type === "human" && p.role === "viewer") throw new CoreError("forbidden", "viewers cannot upload media");
    const { head, getRange } = this.storage;
    if (!head || !getRange) throw new CoreError("unavailable", "direct uploads need S3-compatible storage");
    let t: DirectTicket;
    try {
      t = this.ctx.secrets.decrypt<DirectTicket>(input.uploadId);
    } catch {
      throw new CoreError("invalid", "unknown upload");
    }
    if (t.ws !== p.workspaceId) throw new CoreError("not_found", "upload");
    // Completing is allowed for a while after the PUT URL expires (a slow upload that started in time).
    if (this.ctx.now().getTime() > t.exp + 6 * 3_600_000) throw new CoreError("invalid", "upload expired; start again");
    const [existing] = await this.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.storageKey, t.key)).limit(1);
    if (existing) return existing;
    const obj = await head.call(this.storage, t.key);
    if (!obj || obj.bytes === 0) throw new CoreError("invalid", "nothing was uploaded for this upload id");
    const reject = async (why: string): Promise<never> => {
      await this.storage.delete(t.key);
      throw new CoreError("invalid", why);
    };
    if (obj.bytes > t.max) await reject(`file is ${Math.round(obj.bytes / 1e6)}MB; the limit is ${Math.round(t.max / 1e6)}MB`);
    const headBytes = await getRange.call(this.storage, t.key, 0, 64 * 1024);
    const info = probe(headBytes);
    if (!info) return reject("unsupported file: upload JPEG, PNG, GIF, WebP, MP4, MOV, WebM or PDF");
    if (info.kind !== DIRECT_TYPES[t.mime]?.kind) return reject(`the file is ${info.mime}, not ${t.mime}`);
    const duration =
      info.kind === "video" && info.mime !== "video/webm" ? await mp4DurationFromRanges((start, length) => getRange.call(this.storage, t.key, start, length), obj.bytes).catch(() => null) : null;
    const [row] = await this.ctx.db
      .insert(mediaAssets)
      .values({
        id: newId("med"),
        workspaceId: p.workspaceId,
        storageKey: t.key,
        url: this.storage.publicUrl(t.key),
        kind: info.kind,
        mime: info.mime,
        bytes: obj.bytes,
        width: info.width ?? null,
        height: info.height ?? null,
        durationSeconds: duration,
        // The whole file is never read here; the bucket's ETag stands in for the hash (no dedupe for direct uploads).
        sha256: `etag:${obj.etag ?? t.key}`,
        originalName: t.name ?? null,
        alt: input.alt?.slice(0, 1000) ?? null,
        uploadedBy: p.actor,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [raced] = await this.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.storageKey, t.key)).limit(1);
    return raced!;
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
