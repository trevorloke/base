import { z } from "zod";
import { definePrompt } from "./types.ts";

export type TranslateKeywordsVars = {
  /** What the stream watches, in the language the team wrote it in. */
  keywords: string[];
  /** BCP-47 codes to expand into. */
  languages: string[];
  /** Brand and product names that must not be translated. */
  keepAsIs?: string[];
};

export const TranslateKeywordsOutput = z.object({
  byLanguage: z.array(
    z.object({
      lang: z.string(),
      keywords: z.array(z.string()).describe("How people actually write these terms in this language: translations, common spellings, slang and local names. 1-4 per input keyword."),
    }),
  ),
});
export type TranslateKeywordsOutput = z.infer<typeof TranslateKeywordsOutput>;

export const translateKeywords = definePrompt<TranslateKeywordsVars, TranslateKeywordsOutput>({
  name: "translateKeywords",
  version: "1.0.0",
  description: "Expand a monitoring stream's keywords into the words people use for the same things in other languages.",
  effort: "low",
  system: () =>
    `You help a social listening team monitor conversations in several languages. For each target language, give the words and short phrases native speakers actually type for each keyword: the standard translation, common alternative spellings (including romanisation where people use it, e.g. pinyin or romaji), and everyday slang. Keep brand and product names exactly as given. Prefer short terms that would appear verbatim in a post; never return sentences. Do not include the original keyword unless people in that language really use it as-is.`,
  user: (v) =>
    [
      `Keywords: ${JSON.stringify(v.keywords)}`,
      `Target languages (BCP-47): ${JSON.stringify(v.languages)}`,
      v.keepAsIs?.length ? `Never translate: ${JSON.stringify(v.keepAsIs)}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join("\n"),
  schema: TranslateKeywordsOutput,
});
