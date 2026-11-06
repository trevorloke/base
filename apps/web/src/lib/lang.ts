// Language names and codes. Codes are ISO 639-1 ("ja", "es"), sometimes with a region ("pt-BR").

/** Languages offered first in pickers, in the order people most often need them. */
export const COMMON_LANGUAGES: string[] = ["en", "es", "pt", "fr", "de", "it", "nl", "ja", "ko", "zh", "ar", "hi", "id", "th", "vi", "tr", "pl", "ru", "uk", "sv"];

/** What the server accepts as a language code: "en", "ja", "pt-BR". */
export const LANG_CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

let names: Intl.DisplayNames | null | undefined;
function displayNames(): Intl.DisplayNames | null {
  if (names !== undefined) return names;
  try {
    names = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "language", fallback: "code" }) : null;
  } catch {
    names = null;
  }
  return names;
}

/** "ja" → "Japanese", "pt-BR" → "Brazilian Portuguese"; null → "Unknown". An unreadable code comes back as written. */
export function languageName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  try {
    const n = displayNames()?.of(code);
    if (n && n.toLowerCase() !== code.toLowerCase()) return n;
  } catch {
    // not a valid tag: show it as written
  }
  return code;
}

/** "pt-BR" → "pt". */
export function primaryLanguage(code: string): string {
  return code.split("-")[0]!.toLowerCase();
}

/** True when two codes name the same language ("pt" and "pt-BR" do). */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && primaryLanguage(a) === primaryLanguage(b);
}

/** "ja" → "JA": the short tag on a feed item. */
export function languageTag(code: string): string {
  return primaryLanguage(code).toUpperCase();
}
