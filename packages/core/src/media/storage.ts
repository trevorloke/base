import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Where uploaded files live. Keys are unguessable; URLs are public so networks that pull media can fetch them. */
export interface MediaStorage {
  readonly name: string;
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

/** Local disk, served by the API at /media/:key. Fine for one machine and for development. */
export class LocalStorage implements MediaStorage {
  readonly name = "local";
  private readonly root: string;
  constructor(
    root: string,
    private readonly baseUrl: string,
  ) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes("..")) throw new Error("bad media key");
    return join(this.root, key);
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async delete(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => {});
  }
  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/media/${key}`;
  }
}

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.us-west-2.amazonaws.com */
  endpoint: string;
  /** "auto" for R2 */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL objects are served from (R2 public bucket / custom domain / CloudFront). */
  publicBaseUrl: string;
}

/**
 * Any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2) with path-style requests signed by
 * AWS Signature V4. No SDK: three verbs are all Starsign needs.
 */
export class S3Storage implements MediaStorage {
  readonly name = "s3";
  constructor(
    private readonly cfg: S3Config,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    private readonly now: () => Date = () => new Date(),
  ) {}

  url(key: string): URL {
    return new URL(`${this.cfg.endpoint.replace(/\/+$/, "")}/${this.cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  }

  /** AWS SigV4 headers for a request. */
  sign(method: string, url: URL, payload: Uint8Array, extra: Record<string, string> = {}): Record<string, string> {
    const t = this.now();
    const amzDate = t.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...lower(extra) };
    const names = Object.keys(headers).sort();
    const canonical = [method, url.pathname, url.searchParams.toString(), names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join(""), names.join(";"), payloadHash].join("\n");
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const { host: _host, ...rest } = headers;
    return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
  }

  async put(key: string, bytes: Uint8Array, mime: string): Promise<void> {
    const url = this.url(key);
    const res = await this.fetchImpl(url, { method: "PUT", headers: this.sign("PUT", url, bytes, { "content-type": mime }), body: bytes });
    if (!res.ok) throw new Error(`s3 put ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  async get(key: string): Promise<Uint8Array> {
    const url = this.url(key);
    const res = await this.fetchImpl(url, { method: "GET", headers: this.sign("GET", url, new Uint8Array()) });
    if (!res.ok) throw new Error(`s3 get ${key}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    const url = this.url(key);
    await this.fetchImpl(url, { method: "DELETE", headers: this.sign("DELETE", url, new Uint8Array()) });
  }
  publicUrl(key: string): string {
    return `${this.cfg.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
  }
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

/** STARSIGN_S3_* selects S3; otherwise local disk under STARSIGN_MEDIA_DIR served from STARSIGN_PUBLIC_URL. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStorage {
  if (env.STARSIGN_S3_BUCKET && env.STARSIGN_S3_ACCESS_KEY_ID && env.STARSIGN_S3_SECRET_ACCESS_KEY && env.STARSIGN_S3_ENDPOINT && env.STARSIGN_S3_PUBLIC_URL) {
    return new S3Storage({
      endpoint: env.STARSIGN_S3_ENDPOINT,
      region: env.STARSIGN_S3_REGION ?? "auto",
      bucket: env.STARSIGN_S3_BUCKET,
      accessKeyId: env.STARSIGN_S3_ACCESS_KEY_ID,
      secretAccessKey: env.STARSIGN_S3_SECRET_ACCESS_KEY,
      publicBaseUrl: env.STARSIGN_S3_PUBLIC_URL,
    });
  }
  return new LocalStorage(env.STARSIGN_MEDIA_DIR ?? ".media", env.STARSIGN_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4000}`);
}
