import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac } from "node:crypto";

/** AES-256-GCM for credentials at rest. Ciphertext = base64(iv(12) | tag(16) | data). */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("SecretBox key must be 32 bytes");
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
    const raw = env.STARSIGN_MASTER_KEY;
    if (raw) return new SecretBox(Buffer.from(raw, "base64"));
    console.warn("[starsign] STARSIGN_MASTER_KEY is not set; using an ephemeral key. Stored credentials will not survive a restart.");
    return new SecretBox(randomBytes(32));
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, data]).toString("base64");
  }

  /** A keyed hash for a purpose (e.g. a daily visitor salt). Deterministic per key; never reversible. */
  derive(label: string): Buffer {
    return createHmac("sha256", this.key).update(label).digest();
  }

  decrypt<T = Record<string, unknown>>(ciphertext: string): T {
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as T;
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}
