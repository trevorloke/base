import { createHash, randomBytes } from "node:crypto";

/**
 * Nostr cryptography without dependencies: secp256k1 point arithmetic over BigInt, BIP-340 Schnorr signatures,
 * NIP-01 event ids, and bech32 / NIP-19 encodings (npub, nsec, note, nevent).
 *
 * Node's crypto has secp256k1 ECDSA but no Schnorr, so signing is implemented here per BIP-340
 * (https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki) and checked against its official test vectors.
 * Not constant-time: BigInt arithmetic leaks timing. Acceptable for a server that signs its own notes; do not reuse
 * this for anything where an attacker can time many signatures with the same key on shared hardware.
 */

// ---- field and curve -----------------------------------------------------------------------

export const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P = SECP256K1_P;
const N = SECP256K1_N;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function invert(a: bigint, m: bigint = P): bigint {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("secp256k1: value has no inverse");
  return mod(oldS, m);
}

function powMod(base: bigint, exp: bigint, m: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** Jacobian point (X/Z², Y/Z³); Z = 0 is the point at infinity. */
interface Jacobian {
  x: bigint;
  y: bigint;
  z: bigint;
}
interface Affine {
  x: bigint;
  y: bigint;
}

const INFINITY: Jacobian = { x: 0n, y: 1n, z: 0n };
const G: Jacobian = { x: GX, y: GY, z: 1n };

function double(p: Jacobian): Jacobian {
  if (p.z === 0n || p.y === 0n) return INFINITY;
  const a = mod(p.x * p.x);
  const b = mod(p.y * p.y);
  const c = mod(b * b);
  const d = mod(2n * (mod((p.x + b) * (p.x + b)) - a - c));
  const e = mod(3n * a);
  const f = mod(e * e);
  const x3 = mod(f - 2n * d);
  const y3 = mod(e * (d - x3) - 8n * c);
  const z3 = mod(2n * p.y * p.z);
  return { x: x3, y: y3, z: z3 };
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1z1 = mod(p.z * p.z);
  const z2z2 = mod(q.z * q.z);
  const u1 = mod(p.x * z2z2);
  const u2 = mod(q.x * z1z1);
  const s1 = mod(p.y * q.z * z2z2);
  const s2 = mod(q.y * p.z * z1z1);
  if (u1 === u2) return s1 === s2 ? double(p) : INFINITY;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const h2 = mod(h * h);
  const h3 = mod(h * h2);
  const u1h2 = mod(u1 * h2);
  const x3 = mod(r * r - h3 - 2n * u1h2);
  const y3 = mod(r * (u1h2 - x3) - s1 * h3);
  const z3 = mod(h * p.z * q.z);
  return { x: x3, y: y3, z: z3 };
}

function multiply(p: Jacobian, k: bigint): Jacobian {
  let result = INFINITY;
  let addend = p;
  let n = mod(k, N);
  while (n > 0n) {
    if (n & 1n) result = add(result, addend);
    addend = double(addend);
    n >>= 1n;
  }
  return result;
}

function toAffine(p: Jacobian): Affine | null {
  if (p.z === 0n) return null;
  const zi = invert(p.z);
  const zi2 = mod(zi * zi);
  return { x: mod(p.x * zi2), y: mod(p.y * zi2 * zi) };
}

/** BIP-340 lift_x: the point with x and an even y, or null when x is not on the curve. */
function liftX(x: bigint): Affine | null {
  if (x >= P) return null;
  const c = mod(x * x * x + 7n);
  const y = powMod(c, (P + 1n) / 4n);
  if (mod(y * y) !== c) return null;
  return { x, y: y % 2n === 0n ? y : P - y };
}

// ---- bytes ----------------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function bytesToBigInt(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt(`0x${bytesToHex(b)}`);
}

function bigIntTo32(n: bigint): Uint8Array {
  return hexToBytes(n.toString(16).padStart(64, "0"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

const tagCache = new Map<string, Uint8Array>();
/** BIP-340 tagged hash: sha256(sha256(tag) || sha256(tag) || msg). */
export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  let th = tagCache.get(tag);
  if (!th) {
    th = sha256(tag);
    tagCache.set(tag, th);
  }
  return sha256(concat(th, th, ...msgs));
}

// ---- BIP-340 Schnorr ------------------------------------------------------------------------

function secretScalar(secretKey: Uint8Array): bigint {
  if (secretKey.length !== 32) throw new Error("secret key must be 32 bytes");
  const d = bytesToBigInt(secretKey);
  if (d <= 0n || d >= N) throw new Error("secret key is out of range");
  return d;
}

/** The x-only (32-byte) public key of a secret key. */
export function getPublicKey(secretKey: Uint8Array): Uint8Array {
  const p = toAffine(multiply(G, secretScalar(secretKey)));
  if (!p) throw new Error("secret key is out of range");
  return bigIntTo32(p.x);
}

/** BIP-340 sign. `auxRand` is 32 bytes of fresh randomness (default: crypto.randomBytes). */
export function schnorrSign(message: Uint8Array, secretKey: Uint8Array, auxRand: Uint8Array = new Uint8Array(randomBytes(32))): Uint8Array {
  if (auxRand.length !== 32) throw new Error("aux_rand must be 32 bytes");
  const d0 = secretScalar(secretKey);
  const pt = toAffine(multiply(G, d0));
  if (!pt) throw new Error("secret key is out of range");
  const d = pt.y % 2n === 0n ? d0 : N - d0;
  const px = bigIntTo32(pt.x);
  const t = bigIntTo32(d ^ bytesToBigInt(taggedHash("BIP0340/aux", auxRand)));
  const k0 = mod(bytesToBigInt(taggedHash("BIP0340/nonce", t, px, message)), N);
  if (k0 === 0n) throw new Error("schnorr: nonce is zero; retry with other aux_rand");
  const r = toAffine(multiply(G, k0));
  if (!r) throw new Error("schnorr: nonce point at infinity");
  const k = r.y % 2n === 0n ? k0 : N - k0;
  const rx = bigIntTo32(r.x);
  const e = mod(bytesToBigInt(taggedHash("BIP0340/challenge", rx, px, message)), N);
  const sig = concat(rx, bigIntTo32(mod(k + e * d, N)));
  if (!schnorrVerify(sig, message, px)) throw new Error("schnorr: produced an invalid signature");
  return sig;
}

/** BIP-340 verify. Never throws: malformed input is simply invalid. */
export function schnorrVerify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  const pt = liftX(bytesToBigInt(publicKey));
  if (!pt) return false;
  const r = bytesToBigInt(signature.subarray(0, 32));
  const s = bytesToBigInt(signature.subarray(32, 64));
  if (r >= P || s >= N) return false;
  const e = mod(bytesToBigInt(taggedHash("BIP0340/challenge", signature.subarray(0, 32), publicKey, message)), N);
  const sG = multiply(G, s);
  const eP = multiply({ x: pt.x, y: pt.y, z: 1n }, N - e);
  const rPoint = toAffine(add(sG, eP));
  if (!rPoint || rPoint.y % 2n !== 0n || rPoint.x !== r) return false;
  return true;
}

// ---- bech32 (BIP-173) and NIP-19 -------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i] ?? 0;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i] ?? 0;
    if (value < 0 || value >> from !== 0) throw new Error("bech32: invalid data");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("bech32: invalid padding");
  }
  return out;
}

/** bech32 encode bytes under a human-readable prefix. No 90-character cap: NIP-19 TLV entities are longer. */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  const values = [...hrpExpand(hrp), ...data];
  const mod32 = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod32 >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

export function bech32Decode(str: string): { hrp: string; bytes: Uint8Array } {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error("bech32: mixed case");
  const s = str.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length || s.length > 5000) throw new Error("bech32: malformed string");
  const hrp = s.slice(0, pos);
  const data: number[] = [];
  for (const c of s.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d === -1) throw new Error("bech32: invalid character");
    data.push(d);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bech32: bad checksum");
  return { hrp, bytes: new Uint8Array(convertBits(data.slice(0, -6), 5, 8, false)) };
}

export const npubEncode = (pubkeyHex: string): string => bech32Encode("npub", hexToBytes(pubkeyHex));
export const nsecEncode = (secretHex: string): string => bech32Encode("nsec", hexToBytes(secretHex));
export const noteEncode = (eventIdHex: string): string => bech32Encode("note", hexToBytes(eventIdHex));

/** NIP-19 nevent: TLV 0 = event id, 1 = relay (repeatable), 2 = author, 3 = kind (u32 big-endian). */
export function neventEncode(p: { id: string; relays?: string[]; author?: string; kind?: number }): string {
  const parts: Uint8Array[] = [];
  const tlv = (type: number, value: Uint8Array) => parts.push(new Uint8Array([type, value.length]), value);
  tlv(0, hexToBytes(p.id));
  for (const r of p.relays ?? []) tlv(1, new TextEncoder().encode(r));
  if (p.author) tlv(2, hexToBytes(p.author));
  if (p.kind !== undefined) {
    const k = new Uint8Array(4);
    new DataView(k.buffer).setUint32(0, p.kind);
    tlv(3, k);
  }
  return bech32Encode("nevent", concat(...parts));
}

export type Nip19 =
  | { type: "npub"; data: string }
  | { type: "nsec"; data: string }
  | { type: "note"; data: string }
  | { type: "nevent"; data: { id: string; relays: string[]; author?: string; kind?: number } };

export function nip19Decode(str: string): Nip19 {
  const { hrp, bytes } = bech32Decode(str);
  if (hrp === "npub" || hrp === "nsec" || hrp === "note") {
    if (bytes.length !== 32) throw new Error(`${hrp}: expected 32 bytes`);
    return { type: hrp, data: bytesToHex(bytes) };
  }
  if (hrp === "nevent") {
    let id: string | undefined;
    let author: string | undefined;
    let kind: number | undefined;
    const relays: string[] = [];
    for (let i = 0; i + 2 <= bytes.length; ) {
      const t = bytes[i] ?? 0;
      const l = bytes[i + 1] ?? 0;
      const v = bytes.subarray(i + 2, i + 2 + l);
      if (v.length !== l) throw new Error("nevent: truncated TLV");
      if (t === 0 && l === 32) id = bytesToHex(v);
      else if (t === 1) relays.push(new TextDecoder().decode(v));
      else if (t === 2 && l === 32) author = bytesToHex(v);
      else if (t === 3 && l === 4) kind = new DataView(v.buffer, v.byteOffset, 4).getUint32(0);
      i += 2 + l;
    }
    if (!id) throw new Error("nevent: missing event id");
    return { type: "nevent", data: { id, relays, ...(author ? { author } : {}), ...(kind !== undefined ? { kind } : {}) } };
  }
  throw new Error(`nip19: unsupported prefix "${hrp}"`);
}

// ---- NIP-01 events --------------------------------------------------------------------------

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Omit<NostrEvent, "id" | "sig" | "pubkey">;

/** NIP-01 string escaping: only \n " \\ \r \t \b \f are escaped; everything else is verbatim. */
function nip01String(s: string): string {
  return `"${s.replace(/[\n"\\\r\t\b\f]/g, (c) => ({ "\n": "\\n", '"': '\\"', "\\": "\\\\", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" })[c] ?? c)}"`;
}

/** The canonical serialization `[0, pubkey, created_at, kind, tags, content]` whose sha256 is the event id. */
export function serializeEvent(ev: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  const tags = `[${ev.tags.map((t) => `[${t.map(nip01String).join(",")}]`).join(",")}]`;
  return `[0,${nip01String(ev.pubkey)},${ev.created_at},${ev.kind},${tags},${nip01String(ev.content)}]`;
}

export function getEventHash(ev: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return bytesToHex(sha256(serializeEvent(ev)));
}

/** Fill pubkey, id and sig. */
export function finalizeEvent(template: UnsignedEvent, secretKey: Uint8Array, auxRand?: Uint8Array): NostrEvent {
  const pubkey = bytesToHex(getPublicKey(secretKey));
  const base = { pubkey, created_at: template.created_at, kind: template.kind, tags: template.tags, content: template.content };
  const id = getEventHash(base);
  return { ...base, id, sig: bytesToHex(schnorrSign(hexToBytes(id), secretKey, auxRand)) };
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * Check shape, id and signature. Events whose content holds control characters other than the seven NIP-01 escapes
 * are hashed by most clients with JSON.stringify (which writes \u00XX), so that form is accepted as a fallback.
 */
export function verifyEvent(ev: unknown): ev is NostrEvent {
  const e = ev as Partial<NostrEvent> | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.id !== "string" || !HEX64.test(e.id) || typeof e.pubkey !== "string" || !HEX64.test(e.pubkey) || typeof e.sig !== "string" || !HEX128.test(e.sig)) return false;
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at) || typeof e.kind !== "number" || typeof e.content !== "string") return false;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return false;
  const fields = { pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content };
  const okId = getEventHash(fields) === e.id || bytesToHex(sha256(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))) === e.id;
  if (!okId) return false;
  return schnorrVerify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
}

/** Parse "nsec1..." or 64 hex characters into a 32-byte secret key (hex). Throws on anything else or out of range. */
export function parseSecretKey(input: string): string {
  const s = input.trim();
  let hex: string;
  if (/^nsec1/i.test(s)) {
    const d = nip19Decode(s);
    if (d.type !== "nsec") throw new Error("not an nsec key");
    hex = d.data;
  } else if (/^[0-9a-fA-F]{64}$/.test(s)) hex = s.toLowerCase();
  else throw new Error("expected an nsec1... key or 64 hex characters");
  secretScalar(hexToBytes(hex));
  return hex;
}

/** Parse "npub1..." or 64 hex characters into a public key (hex). */
export function parsePublicKey(input: string): string {
  const s = input.trim();
  if (/^npub1/i.test(s)) {
    const d = nip19Decode(s);
    if (d.type !== "npub") throw new Error("not an npub key");
    return d.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  throw new Error("expected an npub1... key or 64 hex characters");
}
