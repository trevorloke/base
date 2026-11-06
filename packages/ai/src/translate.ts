import { runPrompt, type ModelGateway } from "./gateway.ts";
import { translateKeywords } from "./prompts/translateKeywords.ts";
import { translateMessages } from "./prompts/translateMessages.ts";

/** The model gateway as core's Translator (structurally typed, so ai does not depend on core). */
export function gatewayTranslator(gw: ModelGateway) {
  return async (items: { id: string; text: string; lang: string | null }[], to: string) => {
    const res = await runPrompt(gw, translateMessages, { to, items });
    const wanted = new Set(items.map((i) => i.id));
    const translations: Record<string, string> = {};
    for (const t of res.output.translations) if (wanted.has(t.id)) translations[t.id] = t.text;
    return { translations, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd };
  };
}

/** The model gateway as core's KeywordExpander. */
export function gatewayKeywordExpander(gw: ModelGateway, keepAsIs: string[] = []) {
  return async (keywords: string[], languages: string[]) => {
    const res = await runPrompt(gw, translateKeywords, { keywords, languages, keepAsIs });
    const byLanguage: Record<string, string[]> = {};
    for (const l of res.output.byLanguage) if (languages.includes(l.lang)) byLanguage[l.lang] = l.keywords;
    return { byLanguage, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd };
  };
}
