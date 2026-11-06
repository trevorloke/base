import { z } from "zod";
import { definePrompt } from "./types.ts";

export type SuggestAliasesVars = {
  name: string;
  kind: "organization" | "person";
  /** party, brand, candidate, spokesperson, creator... */
  role?: string;
  /** The organisation a person belongs to, to tell namesakes apart. */
  parent?: string;
  /** BCP-47 codes of the languages the team monitors. */
  languages: string[];
  /** What the team already has. */
  existing: string[];
};

export const SuggestAliasesOutput = z.object({
  aliases: z.array(z.object({ text: z.string(), lang: z.string().describe("BCP-47 code, or 'und' for language-neutral forms like hashtags"), why: z.string().describe("A few words: transliteration, short form, nickname, hashtag, former name") })),
  ambiguous: z.array(z.string()).describe("Forms that are also common words or other people's names, which need context words to avoid false matches"),
});
export type SuggestAliasesOutput = z.infer<typeof SuggestAliasesOutput>;

export const suggestAliases = definePrompt<SuggestAliasesVars, SuggestAliasesOutput>({
  name: "suggestAliases",
  version: "1.0.0",
  description: "How a party, brand or person is written across languages and scripts, so the tracker finds every mention.",
  effort: "low",
  system: () =>
    `You help a media-monitoring team track mentions of an organisation or a person across languages. List the forms people actually write: the name in each requested language's script (transliterations such as katakana, hangul, Chinese characters, Cyrillic, Arabic script), the official local name when one exists, common short forms and abbreviations, widely used nicknames that are not insults, and common hashtags. Only include forms you are confident are used for this specific organisation or person; never invent. Do not repeat forms the team already has. Flag forms that are also everyday words or common names of other people as ambiguous.`,
  user: (v) =>
    [
      `${v.kind === "person" ? "Person" : "Organisation"}: ${v.name}${v.role ? ` (${v.role})` : ""}${v.parent ? `, of ${v.parent}` : ""}`,
      `Languages monitored: ${JSON.stringify(v.languages)}`,
      `Already tracked: ${JSON.stringify(v.existing)}`,
    ].join("\n"),
  schema: SuggestAliasesOutput,
});
