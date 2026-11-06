import { detectAll } from "tinyld";

/**
 * Language of a short social or chat message. Returns null rather than guess: very short Latin-script text ("ok",
 * "Merci", "mantap gan") is often ambiguous, and a wrong label would hide a message behind the wrong filter.
 */
export function detectLanguage(text: string | null | undefined): { lang: string; confidence: number } | null {
  if (!text) return null;
  const cleaned = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@][\p{L}\p{N}_.]+/gu, " ") // handles are names, not language
    .replace(/#/g, " ") // hashtag words are language, the sign is not
    .replace(/\s+/g, " ")
    .trim();
  const letters = cleaned.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return null;
  const ranked = detectAll(cleaned);
  const top = ranked[0];
  if (!top) return null;
  const second = ranked[1]?.accuracy ?? 0;
  const words = cleaned.split(" ").filter((w) => /\p{L}/u.test(w)).length;
  const confident = top.accuracy >= 0.5 || (top.accuracy >= 0.12 && words >= 3 && top.accuracy >= second * 1.5);
  return confident ? { lang: top.lang, confidence: Math.round(top.accuracy * 100) / 100 } : null;
}

/** "pt-BR" and "pt" are the same language for filtering and translation. */
export function primaryLanguage(tag: string): string {
  return tag.toLowerCase().split("-")[0]!;
}

export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && primaryLanguage(a) === primaryLanguage(b);
}

const NAMES = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
/** "ja" → "Japanese", for prompts and plain-language messages. */
export function languageName(tag: string): string {
  try {
    return NAMES?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}
