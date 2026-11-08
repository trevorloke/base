import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, LocalStorage, S3Storage, SecretBox, BaseAir, mp4DurationFromRanges, type Principal } from "../src/index.ts";

/** An S3-compatible bucket in memory: PUT, HEAD, ranged GET, DELETE. Counts bytes served so tests can check reads stay small. */
class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; type: string }>();
  served = 0;
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")) return new Response("unsigned", { status: 403 });
    const obj = this.objects.get(key);
    if (method === "HEAD") return obj ? new Response(null, { status: 200, headers: { "content-length": String(obj.bytes.length), "content-type": obj.type, etag: '"abc123"' } }) : new Response(null, { status: 404 });
    if (method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      if (!obj) return new Response("missing", { status: 404 });
      const m = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
      const part = m ? obj.bytes.subarray(Number(m[1]), Math.min(obj.bytes.length, Number(m[2]) + 1)) : obj.bytes;
      this.served += part.length;
      return new Response(part, { status: m ? 206 : 200 });
    }
    return new Response("unsupported", { status: 400 });
  };
  /** What the browser's presigned PUT would do. */
  upload(presignedUrl: string, bytes: Uint8Array, type: string) {
    const url = new URL(presignedUrl);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    this.objects.set(decodeURIComponent(url.pathname.split("/").slice(2).join("/")), { bytes, type });
  }
}

const box = (type: string, body: Uint8Array | number[]) => {
  const b = body instanceof Uint8Array ? body : Uint8Array.from(body);
  const size = 8 + b.length;
  return Uint8Array.from([(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...Buffer.from(type), ...b]);
};
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
/** A 90-second MP4 whose moov sits after 300 KB of media data, as phones write them. */
function phoneVideo(): Uint8Array {
  const mvhd = box("mvhd", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0xe8, 0, 0x01, 0x5f, 0x90]); // timescale 1000, duration 90000
  return concat(box("ftyp", [...Buffer.from("isom"), 0, 0, 0, 0]), box("mdat", new Uint8Array(300 * 1024)), box("moov", mvhd));
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0, 8, 2, 0, 0, 0]);

let h: DbHandle;
let m: BaseAir;
let bucket: FakeBucket;
let owner: Principal;

beforeAll(async () => {
  h = await createTestDb();
  bucket = new FakeBucket();
  const s3 = new S3Storage({ endpoint: "https://r2.example", region: "auto", bucket: "media", accessKeyId: "AK", secretAccessKey: "SK", publicBaseUrl: "https://cdn.acme.test" }, bucket.fetch);
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), mediaStorage: s3 });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
});
afterAll(() => h.close());

describe("S3 presigning", () => {
  it("matches AWS's documented presigned URL example", () => {
    const s3 = new S3Storage(
      { endpoint: "https://s3.amazonaws.com", region: "us-east-1", bucket: "examplebucket", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", publicBaseUrl: "https://cdn.example" },
      undefined,
      () => new Date("2013-05-24T00:00:00Z"),
    );
    const url = s3.presign("GET", new URL("https://examplebucket.s3.amazonaws.com/test.txt"), 86400);
    expect(url.searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
  });
});

describe("direct uploads", () => {
  it("presigns, then checks what landed: type, size, and MP4 duration from small ranged reads", async () => {
    expect(m.media.limits()).toMatchObject({ direct: true });
    const video = phoneVideo();
    const up = await m.media.createDirectUpload(owner, { mime: "video/mp4", bytes: video.length, filename: "trail.mp4" });
    expect(up).toMatchObject({ method: "PUT", headers: { "content-type": "video/mp4" } });
    expect(up.url).toMatch(/^https:\/\/r2\.example\/media\/[0-9a-z]{12}\/[0-9a-f]{32}\.mp4\?/);
    await expect(m.media.completeDirectUpload(owner, { uploadId: up.uploadId })).rejects.toMatchObject({ code: "invalid" }); // nothing uploaded yet

    bucket.upload(up.url, video, "video/mp4");
    bucket.served = 0;
    const row = await m.media.completeDirectUpload(owner, { uploadId: up.uploadId, alt: "trail" });
    expect(row).toMatchObject({ kind: "video", mime: "video/mp4", bytes: video.length, durationSeconds: 90, originalName: "trail.mp4", alt: "trail" });
    expect(row.url).toMatch(/^https:\/\/cdn\.acme\.test\//);
    expect(bucket.served).toBeLessThan(100 * 1024); // never read the 300 KB of media data
    expect((await m.media.completeDirectUpload(owner, { uploadId: up.uploadId })).id).toBe(row.id); // completing twice is harmless
  });

  it("deletes a file that is not what it claimed, and refuses other workspaces, viewers and bad sizes", async () => {
    const up = await m.media.createDirectUpload(owner, { mime: "video/mp4", bytes: PNG.length });
    bucket.upload(up.url, PNG, "video/mp4");
    await expect(m.media.completeDirectUpload(owner, { uploadId: up.uploadId })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/image\/png, not video\/mp4/) });
    expect(bucket.objects.size).toBe(1); // only the good video remains

    const img = await m.media.createDirectUpload(owner, { mime: "image/png", bytes: PNG.length });
    bucket.upload(img.url, PNG, "image/png");
    await expect(m.media.completeDirectUpload({ ...owner, workspaceId: "ws_other" }, { uploadId: img.uploadId })).rejects.toMatchObject({ code: "not_found" });
    await expect(m.media.completeDirectUpload(owner, { uploadId: "forged" })).rejects.toMatchObject({ code: "invalid" });
    expect(await m.media.completeDirectUpload(owner, { uploadId: img.uploadId })).toMatchObject({ kind: "image", width: 1024, height: 768 });

    await expect(m.media.createDirectUpload({ ...owner, role: "viewer" }, { mime: "image/png", bytes: 10 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.media.createDirectUpload(owner, { mime: "image/png", bytes: 31 * 1024 * 1024 })).rejects.toMatchObject({ code: "invalid" });
    await expect(m.media.createDirectUpload(owner, { mime: "application/x-sh", bytes: 10 })).rejects.toMatchObject({ code: "invalid" });
    // 3 GB video is fine to start: the networks take up to 4 GB.
    await expect(m.media.createDirectUpload(owner, { mime: "video/quicktime", bytes: 3 * 1024 ** 3 })).resolves.toMatchObject({ method: "PUT" });
  });

  it("is unavailable on local disk, where the regular upload is the path", async () => {
    const local = new BaseAir({ handle: h, connectors: new ConnectorRegistry(), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), mediaStorage: new LocalStorage(mkdtempSync(join(tmpdir(), "ss-")), "http://localhost:4000") });
    expect(local.media.limits().direct).toBe(false);
    await expect(local.media.createDirectUpload(owner, { mime: "image/png", bytes: 10 })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("gives up cleanly on files without a moov box", async () => {
    const noMoov = concat(box("ftyp", [...Buffer.from("isom"), 0, 0, 0, 0]), box("mdat", new Uint8Array(64)));
    expect(await mp4DurationFromRanges(async (s, n) => noMoov.subarray(s, s + n), noMoov.length)).toBeNull();
  });
});
