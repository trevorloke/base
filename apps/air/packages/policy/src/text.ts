/** Escape a string for use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scripts written without spaces between words: a phrase there is found inside longer runs of letters. */
const UNSPACED_CLASS = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]";
const UNSPACED = new RegExp(UNSPACED_CLASS, "u");
/** A letter or digit of a spaced script: what may not touch a word's edge ("cat" in "scatter"; "Acme" in "Acme咖啡" is fine). */
const SPACED_WORD_CHAR = `(?!${UNSPACED_CLASS})[\\p{L}\\p{N}]`;

/**
 * Build a case-insensitive, word-boundary regex for a phrase. Handles hashtags and @handles. In Chinese, Japanese,
 * Thai and other unspaced scripts there are no word boundaries to require, so those edges match anywhere.
 */
export function phraseRegex(phrase: string): RegExp {
  const trimmed = phrase.normalize("NFKC").trim();
  const first = trimmed.slice(0, 1);
  const last = [...trimmed].at(-1) ?? "";
  const startsWord = /^[\p{L}\p{N}]/u.test(first) && !UNSPACED.test(first);
  const endsWord = /[\p{L}\p{N}]$/u.test(last) && !UNSPACED.test(last);
  const lead = startsWord ? `(?<!${SPACED_WORD_CHAR})` : "";
  const tail = endsWord ? `(?!${SPACED_WORD_CHAR})` : "";
  return new RegExp(`${lead}${escapeRegex(trimmed)}${tail}`, "iu");
}

export function findPhrases(text: string, phrases: readonly string[]): string[] {
  const hits: string[] = [];
  // NFKC folds full-width letters and digits (ＡＣＭＥ, １００) into the forms people type as keywords.
  const normalized = text.normalize("NFKC");
  for (const p of phrases) {
    if (!p.trim()) continue;
    const m = normalized.match(phraseRegex(p));
    if (m && m[0]) hits.push(m[0]);
  }
  return hits;
}

export function findPatterns(text: string, patterns: readonly string[], flags = "iu"): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, flags.includes("u") ? flags : flags + "u");
    } catch {
      continue; // invalid pattern: ignore rather than fail closed on the author's typo
    }
    const m = text.match(re);
    if (m && m[0]) hits.push(m[0]);
  }
  return hits;
}
