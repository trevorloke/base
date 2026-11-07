import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords (RFC 6238 on top of RFC 4226 HOTP), the
// codes an authenticator app shows: HMAC-SHA-1, 6 digits, a 30-second step.
// Everything here is pure apart from randomness, so it is unit-tested
// against the RFC's own test vectors.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now, for a phone clock that is a little off. */
export const TOTP_WINDOW = 1;

export type HmacAlgorithm = "sha1" | "sha256" | "sha512";

// ── Base32 (RFC 4648, no padding), the format authenticator apps take ──────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32, ignoring case, spaces, dashes and padding. Throws on any other character. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("Not a base32 string");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret: 160 random bits (RFC 4226's recommended length), as base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** "ABCD EFGH IJKL …", easier to type into an app by hand. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

// ── HOTP and TOTP ──────────────────────────────────────────────────────────

export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS, algorithm: HmacAlgorithm = "sha1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The time step a moment falls in (RFC 6238's T). */
export function totpStep(nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

export function totp(key: Uint8Array, nowMs: number, options: { digits?: number; algorithm?: HmacAlgorithm; stepSeconds?: number } = {}): string {
  return hotp(key, totpStep(nowMs, options.stepSeconds), options.digits ?? TOTP_DIGITS, options.algorithm ?? "sha1");
}

/**
 * Check a code against the steps around now. Returns the step it matched,
 * or null. A step at or before `afterStep` (the last one this account used)
 * is never accepted, so a code that was seen once cannot be replayed.
 */
export function verifyTotp(key: Uint8Array, code: string, options: { nowMs?: number; window?: number; afterStep?: number | null } = {}): number | null {
  const candidate = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) return null;
  const current = totpStep(options.nowMs ?? Date.now());
  const window = options.window ?? TOTP_WINDOW;
  // Now first, then the neighbours: the step recorded is the one the app most likely showed.
  const offsets = [0];
  for (let i = 1; i <= window; i++) offsets.push(-i, i);
  let matched: number | null = null;
  for (const offset of offsets) {
    const step = current + offset;
    if (options.afterStep != null && step <= options.afterStep) continue;
    // Compare every candidate in constant time and keep going, so timing doesn't say which step matched.
    if (safeEqual(hotp(key, step), candidate) && matched === null) matched = step;
  }
  return matched;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The otpauth:// address an authenticator app reads from the QR code. */
export function otpauthUri({ secret, account, issuer }: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, "%20")}`;
}

// ── The secret at rest: AES-256-GCM, key derived from the session secret ──

// A label of its own, so this key is never the one that signs session cookies.
const KEY_INFO = "imagine-surrey/admin-totp-secret/v1";

function secretKey(master: string): Buffer {
  if (!master) throw new Error("ADMIN_SESSION_SECRET is needed to protect two-factor secrets.");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), KEY_INFO, 32));
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64url. */
export function encryptSecret(plain: string, master: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(master), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** The plain secret, or null when the value was tampered with or the session secret changed. */
export function decryptSecret(stored: string, master: string): string | null {
  const [version, iv, tag, body] = stored.split(".");
  if (version !== "v1" || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey(master), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ── Recovery codes ─────────────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;
// No 0/O/1/I/L, so a code copied onto paper reads back the same.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Ten codes like "k7m2q-x9tbn" (about 49 bits each). Shown once; only hashes are kept. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** Case, spaces and dashes don't matter when a recovery code is typed back. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

/** Whether what was typed looks like a recovery code rather than an app code. */
export function looksLikeRecoveryCode(code: string): boolean {
  return normalizeRecoveryCode(code).length === 10;
}
