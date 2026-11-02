/** Escape a string for use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive, word-boundary regex for a phrase. Handles hashtags and @handles. */
export function phraseRegex(phrase: string): RegExp {
  const trimmed = phrase.trim();
  const startsWord = /^[\p{L}\p{N}]/u.test(trimmed);
  const endsWord = /[\p{L}\p{N}]$/u.test(trimmed);
  const lead = startsWord ? "(?<![\\p{L}\\p{N}])" : "";
  const tail = endsWord ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${lead}${escapeRegex(trimmed)}${tail}`, "iu");
}

export function findPhrases(text: string, phrases: readonly string[]): string[] {
  const hits: string[] = [];
  for (const p of phrases) {
    const m = text.match(phraseRegex(p));
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
