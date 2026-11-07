// The home page is a list of modules an organizer can show, hide, reorder,
// add and remove from Admin → Home page. Built-in modules render the
// existing sections (their words come from Site settings); "custom" modules
// are text blocks written right in the list. Pure: used by the page, the
// admin and the settings schema.

export const BUILT_IN_MODULES = [
  { kind: "hero", label: "Hero", description: "The big headline, rotating words and buttons at the top." },
  { kind: "actNow", label: "Act now", description: "Live numbers, the next event and shift, and the latest tracker changes." },
  { kind: "pillars", label: "What we stand for", description: "The pillars (Site settings → Pillars)." },
  { kind: "news", label: "News", description: "The three latest news posts." },
  { kind: "join", label: "Become a member", description: "The membership form and the newsletter sign-up." },
  { kind: "pledge", label: "Stop the chaos pledge", description: "The pledge and its sign-up form." },
  { kind: "donate", label: "Chip in", description: "The donation widget." },
  { kind: "skytrain", label: "SkyTrain petition", description: "The SkyTrain map and petition." },
  { kind: "organize", label: "Organize", description: "The yellow call to organize." },
  { kind: "board", label: "Board", description: "The board members." },
  { kind: "committees", label: "Neighbourhood committees", description: "The committees by town centre." },
  { kind: "events", label: "Events", description: "The next upcoming events." },
  { kind: "shop", label: "Shop", description: "Products from the shop." },
  { kind: "social", label: "Follow along", description: "The social media accounts." },
] as const;

export type BuiltInKind = (typeof BUILT_IN_MODULES)[number]["kind"];
export type ModuleKind = BuiltInKind | "custom";
export const MODULE_KINDS = ["custom", ...BUILT_IN_MODULES.map((m) => m.kind)] as [ModuleKind, ...ModuleKind[]];

export const CUSTOM_TONES = ["white", "grey", "navy", "yellow"] as const;
export type CustomTone = (typeof CUSTOM_TONES)[number];

export type HomeModule = {
  kind: ModuleKind;
  enabled: boolean;
  /** Custom modules only. */
  heading: string;
  body: string;
  buttonLabel: string;
  buttonHref: string;
  tone: CustomTone;
};

const blank = { heading: "", body: "", buttonLabel: "", buttonHref: "", tone: "white" as CustomTone };

/** Today's page, in today's order, everything shown. */
export const DEFAULT_MODULES: HomeModule[] = BUILT_IN_MODULES.map((m) => ({ kind: m.kind, enabled: true, ...blank }));

export function moduleLabel(m: Pick<HomeModule, "kind" | "heading">): string {
  if (m.kind === "custom") return m.heading ? `Text block: ${m.heading}` : "Text block";
  return BUILT_IN_MODULES.find((b) => b.kind === m.kind)?.label ?? m.kind;
}

/**
 * Make a saved list safe to render: each built-in at most once (the first
 * wins), and any built-in missing from an older saved list is added at the
 * end, hidden, so new modules appear in the admin without showing up on the
 * live page unannounced.
 */
export function normalizeModules(list: HomeModule[]): HomeModule[] {
  const seen = new Set<string>();
  const out: HomeModule[] = [];
  for (const m of list) {
    if (m.kind !== "custom") {
      if (seen.has(m.kind)) continue;
      seen.add(m.kind);
    }
    out.push(m);
  }
  for (const b of BUILT_IN_MODULES) if (!seen.has(b.kind)) out.push({ kind: b.kind, enabled: false, ...blank });
  return out;
}
