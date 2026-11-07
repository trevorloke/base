import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { media } from "@/lib/db/schema";
import { error, json } from "@/lib/server/api";
import { adminOnly } from "@/lib/server/admin-api";
import { audit } from "@/lib/server/audit";
import { listMedia } from "@/lib/server/content-admin";
import { imageSize, StorageError, storeFile } from "@/lib/server/storage";

/** Upload a file (multipart: file + alt) into the media library. */
export async function POST(req: NextRequest) {
  const auth = await adminOnly("content");
  if (!auth.ok) return auth.response;
  const form = await req.formData().catch(() => null);
  if (!form) return error("Expected a multipart form with a file.");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return error("Choose a file to upload.", 422, { file: "Required" });
  const alt = String(form.get("alt") ?? "")
    .trim()
    .slice(0, 300);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let stored: { url: string; path: string };
  try {
    stored = await storeFile(bytes, file.name, file.type);
  } catch (err) {
    if (err instanceof StorageError) return error(err.message, 400);
    console.error(err);
    return error("The upload failed. Please try again.", 500);
  }
  const size = file.type.startsWith("image/") ? imageSize(bytes) : null;
  const [row] = await getDb()
    .insert(media)
    .values({ filename: file.name.slice(0, 200) || "file", url: stored.url, mime: file.type, size: bytes.byteLength, width: size?.width ?? null, height: size?.height ?? null, alt, uploadedById: auth.user.id })
    .returning({ id: media.id, url: media.url, width: media.width, height: media.height });
  await audit(auth.user, "media.upload", { filename: file.name, url: stored.url, size: bytes.byteLength, mime: file.type }, "media", row.id);
  return json({ id: row.id, url: row.url, width: row.width, height: row.height }, 201);
}

/** The library, newest first, for the image picker. ?q= searches file names and alt text; ?images=1 lists images only. */
export async function GET(req: NextRequest) {
  const auth = await adminOnly("content");
  if (!auth.ok) return auth.response;
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 80);
  const imagesOnly = req.nextUrl.searchParams.get("images") === "1";
  const rows = await listMedia(getDb(), { q, limit: 200, imagesOnly });
  return json(rows.map((m) => ({ id: m.id, url: m.url, alt: m.alt, filename: m.filename, mime: m.mime, width: m.width, height: m.height, createdAt: m.createdAt })));
}
