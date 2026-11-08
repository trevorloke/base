import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * WeChat Official Account message crypto and XML, with no dependencies.
 *
 * - Signatures: sha1 over the lexicographically sorted parts joined with "" (token, timestamp, nonce[, Encrypt]).
 * - Safe mode (安全模式): AES-256-CBC, key = base64(EncodingAESKey + "="), IV = key[0..16], PKCS#7 padding to a
 *   32-byte block, plaintext = 16 random bytes + 4-byte big-endian length + message XML + AppID.
 *   Source: developers.weixin.qq.com/doc/subscription/guide/dev/push/encryption (and the official sample code).
 */

/** sha1 hex of the sorted parts, as WeChat signs server URLs and encrypted messages. */
export function wechatSignature(parts: readonly string[]): string {
  return createHash("sha1").update([...parts].sort().join("")).digest("hex");
}

/** Constant-time comparison of two signature strings (case-insensitive hex). */
export function signatureMatches(expected: string, got: string | undefined): boolean {
  if (typeof got !== "string") return false;
  const a = Buffer.from(expected.toLowerCase());
  const b = Buffer.from(got.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** EncodingAESKey (43 chars) → the 32-byte AES key. Throws on a malformed key. */
export function decodeAesKey(encodingAesKey: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey)) throw new Error("EncodingAESKey must be 43 letters and digits");
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("EncodingAESKey does not decode to 32 bytes");
  return key;
}

const BLOCK = 32;

/** Decrypt the `Encrypt` field and check the trailing AppID. Returns the inner message XML. */
export function wechatDecrypt(encrypt: string, encodingAesKey: string, appId: string): string {
  const key = decodeAesKey(encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(Buffer.from(encrypt, "base64")), decipher.final()]);
  const pad = padded[padded.length - 1] ?? 0;
  if (pad < 1 || pad > BLOCK || pad > padded.length) throw new Error("bad padding");
  const plain = padded.subarray(0, padded.length - pad);
  if (plain.length < 20) throw new Error("message too short");
  const len = plain.readUInt32BE(16);
  if (20 + len > plain.length) throw new Error("bad message length");
  const xml = plain.subarray(20, 20 + len).toString("utf8");
  const from = plain.subarray(20 + len).toString("utf8");
  const a = Buffer.from(from);
  const b = Buffer.from(appId);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("message was encrypted for another AppID");
  return xml;
}

/** Encrypt a message XML the way WeChat does (used for encrypted passive replies and in tests). */
export function wechatEncrypt(xml: string, encodingAesKey: string, appId: string, random: Buffer = randomBytes(16)): string {
  const key = decodeAesKey(encodingAesKey);
  const body = Buffer.from(xml, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const plain = Buffer.concat([random.subarray(0, 16), len, body, Buffer.from(appId, "utf8")]);
  const pad = BLOCK - (plain.length % BLOCK);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
}

// ---- XML ------------------------------------------------------------------------------------

/** A WeChat message: leaf elements are strings, nested elements (e.g. ScanCodeInfo) are objects. */
export interface WeChatXml {
  [key: string]: string | WeChatXml;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text of a leaf: CDATA sections verbatim, everything else entity-decoded. */
function leafText(inner: string): string {
  let out = "";
  let i = 0;
  while (i < inner.length) {
    const c = inner.indexOf("<![CDATA[", i);
    if (c < 0) {
      out += decodeEntities(inner.slice(i));
      break;
    }
    out += decodeEntities(inner.slice(i, c));
    const end = inner.indexOf("]]>", c + 9);
    if (end < 0) throw new Error("unterminated CDATA");
    out += inner.slice(c + 9, end);
    i = end + 3;
  }
  return out;
}

const OPEN = /<([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(\/?)>/y;

/** Skip whitespace, the XML declaration, comments and stray text between elements. */
function skipMisc(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s.startsWith("<?", i)) {
      const e = s.indexOf("?>", i);
      i = e < 0 ? s.length : e + 2;
    } else if (s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i);
      i = e < 0 ? s.length : e + 3;
    } else return i;
  }
}

/** Where the element named `name` that starts its content at `from` ends (index of its closing tag). */
function closingIndex(s: string, name: string, from: number): number {
  let depth = 0;
  let j = from;
  const close = `</${name}>`;
  while (j < s.length) {
    if (s.startsWith("<![CDATA[", j)) {
      const e = s.indexOf("]]>", j + 9);
      if (e < 0) throw new Error("unterminated CDATA");
      j = e + 3;
      continue;
    }
    if (s.startsWith(close, j)) {
      if (depth === 0) return j;
      depth--;
      j += close.length;
      continue;
    }
    if (s[j] === "<" && s.startsWith(name, j + 1) && /[\s>/]/.test(s[j + 1 + name.length] ?? "")) {
      const gt = s.indexOf(">", j);
      if (gt > 0 && s[gt - 1] !== "/") depth++;
      j = gt < 0 ? s.length : gt + 1;
      continue;
    }
    j++;
  }
  throw new Error(`unclosed <${name}>`);
}

function parseElements(s: string): WeChatXml {
  const out: WeChatXml = {};
  let i = skipMisc(s, 0);
  while (i < s.length) {
    OPEN.lastIndex = i;
    const m = OPEN.exec(s);
    if (!m) {
      // Stray text between elements: skip to the next tag.
      const next = s.indexOf("<", i + 1);
      if (next < 0) break;
      i = skipMisc(s, next);
      continue;
    }
    const name = m[1]!;
    const start = i + m[0].length;
    let value: string | WeChatXml = "";
    let after = start;
    if (m[2] !== "/") {
      const end = closingIndex(s, name, start);
      const inner = s.slice(start, end);
      const trimmed = inner.trim();
      value = trimmed.startsWith("<") && !trimmed.startsWith("<![CDATA[") ? parseElements(inner) : leafText(inner);
      after = end + name.length + 3;
    }
    // Repeated elements (e.g. <item> lists) keep the first; Base Air does not read those events.
    if (!(name in out)) out[name] = value;
    i = skipMisc(s, after);
  }
  return out;
}

/**
 * Parse WeChat's flat message XML (`<xml><ToUserName><![CDATA[gh_..]]></ToUserName>...</xml>`) into the fields of
 * the root element. Throws on malformed input.
 */
export function parseWeChatXml(xml: string): WeChatXml {
  const top = parseElements(xml);
  const root = top.xml;
  if (root === undefined) throw new Error("not a WeChat XML message (no <xml> root)");
  return typeof root === "string" ? {} : root;
}

/** A leaf field as a string, or undefined when absent or nested. */
export function field(x: WeChatXml, key: string): string | undefined {
  const v = x[key];
  return typeof v === "string" ? v : undefined;
}

/** Serialize flat fields as WeChat XML with CDATA (for encrypted replies and tests). */
export function toWeChatXml(fields: Record<string, string | number>): string {
  const cdata = (v: string) => `<![CDATA[${v.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
  return `<xml>${Object.entries(fields)
    .map(([k, v]) => `<${k}>${typeof v === "number" ? String(v) : cdata(v)}</${k}>`)
    .join("")}</xml>`;
}
