import { z } from "zod";
import type { Network } from "@meridian/schema";
import { COMMON_RULES, renderBrandContext, renderNetworkLimits, type BrandContext } from "./context.ts";
import { VariantOutput } from "./shared.ts";
import { definePrompt } from "./types.ts";

export type AdaptForNetworkVars = {
  brand: BrandContext;
  /** The one idea, in the brand's words or a human's rough note. */
  idea: string;
  networks: Network[];
  /** Anything the requester wants honoured (a link to include, a tone to hit, a hook to keep). */
  notes?: string;
};

export const AdaptForNetworkOutput = z.object({
  variants: z.array(VariantOutput).describe("Exactly one variant per requested network"),
  notes: z.string().describe("Judgment calls, trade-offs, and anything that could not be honoured and why"),
});
export type AdaptForNetworkOutput = z.infer<typeof AdaptForNetworkOutput>;

export const adaptForNetwork = definePrompt<AdaptForNetworkVars, AdaptForNetworkOutput>({
  name: "adaptForNetwork",
  version: "1.0.0",
  description: "One idea becomes per-network variants that obey each network's hard limits and the brand's voice.",
  effort: "medium",
  system: (v) =>
    [
      `You are the Studio operator for ${v.brand.workspace.name}. You turn one idea into ready-to-review variants, one per requested network, in the brand's voice.`,
      renderBrandContext(v.brand),
      COMMON_RULES,
      `Variant rules:
- Produce exactly one variant per requested network and no others.
- Respect the hard limits above. Count carefully and leave headroom: aim under 90% of the limit for every segment.
- Use a thread only when the network supports threads and the idea genuinely needs more than one segment; each segment must fit on its own.
- Text only. Do not describe or reference images or videos that do not exist.
- Keep the substance identical across networks; adapt length, register and formatting to each network's norms.`,
    ].join("\n\n"),
  user: (v) =>
    [
      `Idea to adapt:\n${v.idea}`,
      `Target networks and limits:\n${renderNetworkLimits(v.networks)}`,
      v.notes ? `Notes from the requester:\n${v.notes}` : null,
      "Return the variants and your notes.",
    ]
      .filter((s): s is string => s !== null)
      .join("\n\n"),
  schema: AdaptForNetworkOutput,
});
