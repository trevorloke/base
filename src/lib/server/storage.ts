import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Where uploaded images live. With SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * set, files go to a public Supabase Storage bucket (SUPABASE_MEDIA_BUCKET,
 * default "site-media"); otherwise, on a machine that keeps its disk (a
 * laptop, a server of your own), to public/uploads. Vercel's disk is
 * read-only and Render wipes its disk on every deploy and restart, so there
 * local uploads are refused instead of disappearing later.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "application/pdf": "pdf" };

export class StorageError extends Error {}

/** Why uploads can't be saved to this machine's disk, naming what to set; null when they can (or Supabase is set). */
export function localUploadProblem(host: "Vercel" | "Render" | null = env.ephemeralDiskHost, storageEnabled = env.storageEnabled): string | null {
  if (storageEnabled || !host) return null;
  const why = host === "Render" ? "Render wipes this server's disk on every deploy and restart, so an uploaded file would disappear" : "Vercel's disk is read-only";
  return `Uploads need Supabase Storage here: ${why}. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_MEDIA_BUCKET if the public bucket isn't named site-media), then redeploy.`;
}

export async function storeFile(bytes: Uint8Array, filename: string, mime: string): Promise<{ url: string; path: string }> {
  const ext = ALLOWED_IMAGE_TYPES[mime];
  if (!ext) throw new StorageError("Only JPEG, PNG, WebP, GIF, SVG and PDF files can be uploaded.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new StorageError("Files must be 8 MB or smaller.");
  const safe = filename
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "file";
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomBytes(6).toString("hex")}-${safe}.${ext}`;

  if (env.storageEnabled) {
    const res = await fetch(`${env.supabaseUrl}/storage/v1/object/${env.mediaBucket}/${key}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.supabaseServiceRoleKey}`, apikey: env.supabaseServiceRoleKey!, "content-type": mime, "x-upsert": "false", "cache-control": "max-age=31536000" },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new StorageError(`Upload failed (${res.status}): ${text.slice(0, 200) || "check the bucket exists and is public"}`);
    }
    return { url: `${env.supabaseUrl}/storage/v1/object/public/${env.mediaBucket}/${key}`, path: key };
  }

  const problem = localUploadProblem();
  if (problem) throw new StorageError(problem);
  const dir = path.join(process.cwd(), "public", "uploads", path.dirname(key));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(process.cwd(), "public", "uploads", key), bytes);
  return { url: `/uploads/${key}`, path: key };
}

/** Width and height of a PNG, JPEG, GIF or WebP from its header bytes; null if unknown. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.toString("ascii", 1, 4) === "PNG") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: (b.readUIntLE(24, 3) & 0xffffff) + 1, height: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
