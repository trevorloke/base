// Inbound text handling: keyword classification and Twilio request
// signatures. Pure functions, tested without a database.
import { createHmac, timingSafeEqual } from "node:crypto";

export type InboundIntent =
  | { kind: "stop" }
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "join" }
  | { kind: "language"; locale: string; language: string }
  | { kind: "other" };

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);
const LANGUAGES: Record<string, { locale: string; language: string }> = {
  PUNJABI: { locale: "pa", language: "Punjabi" },
  HINDI: { locale: "hi", language: "Hindi" },
  CHINESE: { locale: "zh-Hans", language: "Chinese" },
  TAGALOG: { locale: "tl", language: "Tagalog" },
};

/** What a text asks for. Keywords match the whole message, case-insensitively, ignoring punctuation. */
export function classifyInbound(body: string): InboundIntent {
  const words = body
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const compact = words.join("");
  if (STOP_WORDS.has(compact) || (words.length > 0 && STOP_WORDS.has(words[0]) && words.length <= 2)) return { kind: "stop" };
  if (START_WORDS.has(compact)) return { kind: "start" };
  if (compact === "HELP" || compact === "INFO") return { kind: "help" };
  if (compact === "JOIN") return { kind: "join" };
  const language = LANGUAGES[compact];
  if (language) return { kind: "language", ...language };
  return { kind: "other" };
}

/**
 * Twilio's request signature: HMAC-SHA1 of the full URL followed by every
 * POST parameter, sorted by name, as name+value, base64 encoded, keyed by
 * the account's auth token.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** True when the signature matches any of the candidate URLs (the request as seen, and the site's public address). */
export function twilioSignatureMatches(authToken: string, signature: string | null, urls: string[], params: Record<string, string>): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return urls.some((url) => {
    const expected = Buffer.from(twilioSignature(authToken, url, params));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** The TwiML reply to an inbound text. */
export function twiml(message: string | null): string {
  const escaped = (message ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${escaped}</Message>` : ""}</Response>`;
}

/** The size of a text in SMS segments (160 GSM-7 characters per segment, or 70 when a character needs UCS-2). */
export function smsSegments(body: string): { characters: number; segments: number; unicode: boolean } {
  // Characters outside GSM-7 (curly quotes, emoji, most non-Latin scripts) force the 70-character UCS-2 encoding.
  const unicode = /[^\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]/.test(body);
  const characters = [...body].length;
  if (characters === 0) return { characters: 0, segments: 0, unicode };
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return { characters, segments: characters <= single ? 1 : Math.ceil(characters / multi), unicode };
}
