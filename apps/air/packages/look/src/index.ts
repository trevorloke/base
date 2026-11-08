/**
 * Base Air's look (SUITE.md, "Look and brand"): presets, the brand a workspace saves, the design tokens it becomes,
 * and the contrast check. Pure and dependency-free: the server writes the tokens into the HTML it sends (no flash of
 * the default look) and the room uses the same code for the Brand page's live preview.
 *
 * Only validated values ever reach CSS: colours are #rrggbb, fonts and corners come from fixed lists. The brand's
 * name and logo URL are never written into CSS.
 */

export type Scheme = "light" | "dark";
export type BrandMode = "light" | "dark" | "device";
export type Corners = "sharp" | "soft" | "round";

export interface Palette {
  /** Buttons, links, the selected tab. */
  primary: string;
  /** Text on primary. */
  onPrimary: string;
  /** Highlights: the switcher, focus rings, the second chart series. */
  accent: string;
  /** Text on accent. */
  onAccent: string;
  /** The background everything sits on. */
  surface: string;
  /** Text. */
  ink: string;
}
export const PALETTE_KEYS = ["primary", "onPrimary", "accent", "onAccent", "surface", "ink"] as const satisfies readonly (keyof Palette)[];
export const PALETTE_LABELS: Record<keyof Palette, string> = {
  primary: "Primary",
  onPrimary: "Text on primary",
  accent: "Accent",
  onAccent: "Text on accent",
  surface: "Background",
  ink: "Text",
};

export const FONTS = [
  { id: "plex-sans", label: "IBM Plex Sans", stack: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "inter", label: "Inter", stack: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "space-grotesk", label: "Space Grotesk", stack: '"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "source-serif", label: "Source Serif 4", stack: '"Source Serif 4", Georgia, "Times New Roman", serif' },
  { id: "system", label: "The device's own", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
] as const;
export type FontId = (typeof FONTS)[number]["id"];
/** Figures (counts, percentages, times) are always set in IBM Plex Mono: tabular and calm. */
export const FIGURES_STACK = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const CORNERS: Record<Corners, { label: string; radius: number; small: number; large: number }> = {
  sharp: { label: "Sharp", radius: 2, small: 2, large: 3 },
  soft: { label: "Soft", radius: 8, small: 5, large: 12 },
  round: { label: "Round", radius: 14, small: 9, large: 20 },
};

export const MODES: Record<BrandMode, string> = { light: "Light", dark: "Dark", device: "Follow the device" };

export interface Preset {
  id: string;
  label: string;
  description: string;
  font: FontId;
  corners: Corners;
  mode: BrandMode;
  palettes: Record<Scheme, Palette>;
}

/** Air comes first: the default look. Every preset passes the contrast check in both schemes (tested). */
export const PRESETS: readonly Preset[] = [
  {
    id: "air",
    label: "Air",
    description: "Dark by default: sky blue and violet on deep navy, mono figures.",
    font: "plex-sans",
    corners: "soft",
    mode: "dark",
    palettes: {
      dark: { primary: "#38bdf8", onPrimary: "#03131f", accent: "#a78bfa", onAccent: "#150a33", surface: "#0a1022", ink: "#e8eeff" },
      light: { primary: "#0369a1", onPrimary: "#ffffff", accent: "#6d28d9", onAccent: "#ffffff", surface: "#f3f6fc", ink: "#0c1530" },
    },
  },
  {
    id: "daylight",
    label: "Daylight",
    description: "Light and plain: paper white, ink, a confident blue.",
    font: "inter",
    corners: "soft",
    mode: "light",
    palettes: {
      light: { primary: "#1f4fd8", onPrimary: "#ffffff", accent: "#c2410c", onAccent: "#ffffff", surface: "#f6f5f1", ink: "#1b1c1f" },
      dark: { primary: "#7aa2ff", onPrimary: "#0b1020", accent: "#ff9b5e", onAccent: "#1f0d02", surface: "#111214", ink: "#ebebe8" },
    },
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm night: charcoal, ember orange and gold, sharp corners.",
    font: "space-grotesk",
    corners: "sharp",
    mode: "dark",
    palettes: {
      dark: { primary: "#ff8a4c", onPrimary: "#1d0b02", accent: "#f5c451", onAccent: "#241a02", surface: "#15100e", ink: "#f6ede6" },
      light: { primary: "#b4410c", onPrimary: "#ffffff", accent: "#7c5200", onAccent: "#ffffff", surface: "#fbf6f1", ink: "#23160f" },
    },
  },
  {
    id: "lagoon",
    label: "Lagoon",
    description: "Teal and magenta, round corners; follows the device's light or dark.",
    font: "inter",
    corners: "round",
    mode: "device",
    palettes: {
      light: { primary: "#0f766e", onPrimary: "#ffffff", accent: "#be185d", onAccent: "#ffffff", surface: "#f1f7f6", ink: "#0b2422" },
      dark: { primary: "#2dd4bf", onPrimary: "#032320", accent: "#f472b6", onAccent: "#2a0716", surface: "#071a19", ink: "#def5f1" },
    },
  },
  {
    id: "newsprint",
    label: "Newsprint",
    description: "Editorial: serif type, crimson and navy on newsprint.",
    font: "source-serif",
    corners: "sharp",
    mode: "light",
    palettes: {
      light: { primary: "#9f1239", onPrimary: "#ffffff", accent: "#1e3a8a", onAccent: "#ffffff", surface: "#fbfaf7", ink: "#141414" },
      dark: { primary: "#fb7185", onPrimary: "#2a0510", accent: "#93c5fd", onAccent: "#0a1a33", surface: "#121212", ink: "#f1efe9" },
    },
  },
];
export const DEFAULT_PRESET = "air";

export function presetById(id: string | null | undefined): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** What a workspace saves. */
export interface Brand {
  /** The preset it started from (kept after adjustments; "Reset to preset" goes back to it). */
  preset: string;
  /** Shown in the app. Empty: the workspace's (organization's) name. */
  name: string;
  /** An uploaded image or an https URL. Empty: Base Air's own mark. */
  logoUrl: string;
  palettes: Record<Scheme, Palette>;
  font: FontId;
  corners: Corners;
  mode: BrandMode;
}

/** A preset as a brand: fills every field below the preset; name and logo stay as they are. */
export function brandFromPreset(id: string, keep: Pick<Brand, "name" | "logoUrl"> = { name: "", logoUrl: "" }): Brand {
  const p = presetById(id) ?? presetById(DEFAULT_PRESET)!;
  return { preset: p.id, name: keep.name, logoUrl: keep.logoUrl, palettes: { light: { ...p.palettes.light }, dark: { ...p.palettes.dark } }, font: p.font, corners: p.corners, mode: p.mode };
}

export const DEFAULT_BRAND: Brand = brandFromPreset(DEFAULT_PRESET);

// ---------------------------------------------------------------- colour

/** "#abc" or "#aabbcc" (any case, optional #) → "#aabbcc"; null when it is not a hex colour. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  return null;
}

function rgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? "#000000";
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
const toHex = (c: [number, number, number]) => `#${c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;

/** `a` moved `t` of the way towards `b` (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------------------------------------------------------------- tokens

/** The colours the room's CSS uses, all derived from the six a brand sets. */
export function colorTokens(p: Palette, scheme: Scheme): Record<string, string> {
  const dark = scheme === "dark";
  const panel = dark ? mix(p.surface, p.ink, 0.05) : mix(p.surface, "#ffffff", 0.75);
  return {
    "--surface": p.surface,
    "--ink": p.ink,
    "--primary": p.primary,
    "--on-primary": p.onPrimary,
    "--highlight": p.accent,
    "--on-highlight": p.onAccent,
    "--highlight-soft": rgba(p.accent, dark ? 0.18 : 0.12),
    "--bg": p.surface,
    "--panel": panel,
    "--sunken": dark ? mix(p.surface, p.ink, 0.085) : mix(p.surface, p.ink, 0.04),
    "--hover": dark ? mix(p.surface, p.ink, 0.075) : mix(p.surface, p.ink, 0.03),
    "--border": mix(p.surface, p.ink, dark ? 0.14 : 0.11),
    "--border-strong": mix(p.surface, p.ink, dark ? 0.27 : 0.25),
    "--fg": p.ink,
    "--fg-muted": mutedInk(p, scheme),
    "--fg-faint": mix(p.ink, p.surface, 0.5),
    "--accent": p.primary,
    "--accent-fg": p.onPrimary,
    "--accent-soft": rgba(p.primary, dark ? 0.16 : 0.1),
    "--focus": p.accent,
    "--shadow": dark ? "0 12px 40px rgba(0, 0, 0, 0.6)" : "0 12px 40px rgba(16, 24, 40, 0.16)",
    ...STATUS[scheme],
  };
}

/** Status colours do not follow the brand: red means the same thing in every workspace. */
const STATUS: Record<Scheme, Record<string, string>> = {
  light: {
    "--danger": "#c7322b",
    "--danger-soft": "rgba(199, 50, 43, 0.1)",
    "--warn": "#a35f00",
    "--warn-soft": "rgba(178, 106, 0, 0.12)",
    "--good": "#1d8a4e",
    "--good-soft": "rgba(29, 138, 78, 0.12)",
  },
  dark: {
    "--danger": "#ff6b63",
    "--danger-soft": "rgba(255, 107, 99, 0.14)",
    "--warn": "#e0a24a",
    "--warn-soft": "rgba(224, 162, 74, 0.16)",
    "--good": "#3ecf7f",
    "--good-soft": "rgba(62, 207, 127, 0.14)",
  },
};

/** Secondary text: ink moved towards the background, never further than keeps it readable. */
export function mutedInk(p: Palette, scheme: Scheme): string {
  return mix(p.ink, p.surface, scheme === "dark" ? 0.3 : 0.34);
}
export const panelOf = (p: Palette, scheme: Scheme) => colorTokens(p, scheme)["--panel"]!;

export function shapeTokens(b: Pick<Brand, "font" | "corners">): Record<string, string> {
  const font = FONTS.find((f) => f.id === b.font) ?? FONTS[0];
  const c = CORNERS[b.corners] ?? CORNERS.soft;
  return {
    "--font-ui": font.stack,
    "--font-mono": FIGURES_STACK,
    "--radius": `${c.radius}px`,
    "--radius-sm": `${c.small}px`,
    "--radius-lg": `${c.large}px`,
  };
}

const decl = (t: Record<string, string>) =>
  Object.entries(t)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

/**
 * The brand as CSS custom properties. `scope` is the selector for the light scheme (":root" for the app, a class for a
 * preview); the dark scheme applies under [data-theme="dark"], or with the device's dark preference unless the page
 * is pinned to light. The mode itself is the `data-theme` attribute (see `themeAttr`).
 */
export function brandCss(b: Brand, scope = ":root"): string {
  const light = colorTokens(b.palettes.light, "light");
  const dark = colorTokens(b.palettes.dark, "dark");
  const darkSel = scope === ":root" ? ':root[data-theme="dark"]' : `${scope}[data-theme="dark"]`;
  const deviceSel = scope === ":root" ? ':root:not([data-theme="light"])' : `${scope}:not([data-theme="light"])`;
  return [
    `${scope}{color-scheme:light;${decl(shapeTokens(b))};${decl(light)}}`,
    `${darkSel}{color-scheme:dark;${decl(dark)}}`,
    `@media (prefers-color-scheme: dark){${deviceSel}{color-scheme:dark;${decl(dark)}}}`,
  ].join("\n");
}

/** The `data-theme` the page starts with: pinned for light or dark, absent when following the device. */
export function themeAttr(mode: BrandMode): Scheme | null {
  return mode === "device" ? null : mode;
}

/** The schemes a brand can actually show: its pinned mode, or both when it follows the device. */
export function schemesShown(mode: BrandMode): Scheme[] {
  return mode === "device" ? ["light", "dark"] : [mode];
}

// ---------------------------------------------------------------- contrast

export const MIN_CONTRAST = 4.5;

export interface ContrastPair {
  id: string;
  label: string;
  scheme: Scheme;
  fg: string;
  bg: string;
  ratio: number;
  ok: boolean;
}

/** Every text-and-background pair the room shows, in each scheme the brand can show. */
export function contrastReport(b: Brand, schemes: Scheme[] = schemesShown(b.mode)): ContrastPair[] {
  const out: ContrastPair[] = [];
  for (const scheme of schemes) {
    const p = b.palettes[scheme];
    const panel = panelOf(p, scheme);
    const pairs: [string, string, string, string][] = [
      ["body", "Text on the background", p.ink, p.surface],
      ["card", "Text on cards", p.ink, panel],
      ["muted", "Secondary text on cards", mutedInk(p, scheme), panel],
      ["link", "Links on the background", p.primary, p.surface],
      ["link-card", "Links on cards", p.primary, panel],
      ["button", "Text on primary buttons", p.onPrimary, p.primary],
      ["accent", "Text on accent", p.onAccent, p.accent],
      ["accent-text", "Accent as text on the background", p.accent, p.surface],
    ];
    for (const [id, label, fg, bg] of pairs) {
      const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
      out.push({ id: `${scheme}:${id}`, label, scheme, fg, bg, ratio, ok: ratio >= MIN_CONTRAST });
    }
  }
  return out;
}

export const lowContrast = (b: Brand) => contrastReport(b).filter((p) => !p.ok);

// ---------------------------------------------------------------- parsing

export interface BrandProblem {
  field: string;
  message: string;
}

const NAME_MAX = 60;
const LOGO_MAX = 2048;

/** A logo is an http(s) URL (an upload's URL is one) or nothing. */
export function normalizeLogoUrl(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return "";
  if (s.length > LOGO_MAX) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Read a brand from untrusted input (a request body, a setting). Missing fields come from `base`; anything invalid is
 * reported, never guessed.
 */
export function parseBrand(input: unknown, base: Brand = DEFAULT_BRAND): { brand: Brand; problems: BrandProblem[] } {
  const problems: BrandProblem[] = [];
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const brand: Brand = { ...base, palettes: { light: { ...base.palettes.light }, dark: { ...base.palettes.dark } } };

  if (o.preset !== undefined) {
    if (typeof o.preset === "string" && presetById(o.preset)) brand.preset = o.preset;
    else problems.push({ field: "preset", message: `unknown preset; choose one of ${PRESETS.map((p) => p.id).join(", ")}` });
  }
  if (o.name !== undefined) {
    // eslint-disable-next-line no-control-regex
    const name = typeof o.name === "string" ? o.name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : null;
    if (name === null || name.length > NAME_MAX) problems.push({ field: "name", message: `the name is text of at most ${NAME_MAX} characters` });
    else brand.name = name;
  }
  if (o.logoUrl !== undefined) {
    const logo = normalizeLogoUrl(o.logoUrl);
    if (logo === null) problems.push({ field: "logoUrl", message: "the logo is an https address or an uploaded image" });
    else brand.logoUrl = logo;
  }
  if (o.palettes !== undefined) {
    const pal = (o.palettes && typeof o.palettes === "object" ? o.palettes : null) as Record<string, unknown> | null;
    if (!pal) problems.push({ field: "palettes", message: "colours are given per scheme: light and dark" });
    for (const scheme of ["light", "dark"] as const) {
      const given = pal?.[scheme];
      if (given === undefined) continue;
      const g = (given && typeof given === "object" ? given : {}) as Record<string, unknown>;
      for (const key of PALETTE_KEYS) {
        if (g[key] === undefined) continue;
        const hex = normalizeHex(g[key]);
        if (!hex) problems.push({ field: `palettes.${scheme}.${key}`, message: `${PALETTE_LABELS[key]} (${scheme}) is a hex colour like #38bdf8` });
        else brand.palettes[scheme][key] = hex;
      }
    }
  }
  if (o.font !== undefined) {
    if (FONTS.some((f) => f.id === o.font)) brand.font = o.font as FontId;
    else problems.push({ field: "font", message: `choose a font from the list: ${FONTS.map((f) => f.id).join(", ")}` });
  }
  if (o.corners !== undefined) {
    if (typeof o.corners === "string" && o.corners in CORNERS) brand.corners = o.corners as Corners;
    else problems.push({ field: "corners", message: "corners are sharp, soft or round" });
  }
  if (o.mode !== undefined) {
    if (typeof o.mode === "string" && o.mode in MODES) brand.mode = o.mode as BrandMode;
    else problems.push({ field: "mode", message: "mode is light, dark or device" });
  }
  return { brand, problems };
}

/**
 * The look a deployment starts with before anyone saves one: BASE_AIR_BRAND_PRESET, then optional
 * BASE_AIR_BRAND_NAME, _LOGO_URL, _MODE, _FONT, _CORNERS, and _PRIMARY / _ACCENT (applied to both schemes).
 * Invalid settings are reported and skipped.
 */
export function brandFromSettings(env: Record<string, string | undefined>): { brand: Brand; problems: BrandProblem[] } {
  const presetId = env.BASE_AIR_BRAND_PRESET?.trim();
  const problems: BrandProblem[] = [];
  if (presetId && !presetById(presetId)) problems.push({ field: "BASE_AIR_BRAND_PRESET", message: `unknown preset "${presetId}"` });
  const base = brandFromPreset(presetId && presetById(presetId) ? presetId : DEFAULT_PRESET);
  const input: Record<string, unknown> = {};
  if (env.BASE_AIR_BRAND_NAME !== undefined) input.name = env.BASE_AIR_BRAND_NAME;
  if (env.BASE_AIR_BRAND_LOGO_URL !== undefined) input.logoUrl = env.BASE_AIR_BRAND_LOGO_URL;
  if (env.BASE_AIR_BRAND_MODE) input.mode = env.BASE_AIR_BRAND_MODE.trim();
  if (env.BASE_AIR_BRAND_FONT) input.font = env.BASE_AIR_BRAND_FONT.trim();
  if (env.BASE_AIR_BRAND_CORNERS) input.corners = env.BASE_AIR_BRAND_CORNERS.trim();
  const colors: Partial<Record<keyof Palette, string>> = {};
  if (env.BASE_AIR_BRAND_PRIMARY) colors.primary = env.BASE_AIR_BRAND_PRIMARY;
  if (env.BASE_AIR_BRAND_ACCENT) colors.accent = env.BASE_AIR_BRAND_ACCENT;
  if (Object.keys(colors).length) input.palettes = { light: colors, dark: colors };
  const parsed = parseBrand(input, base);
  for (const p of parsed.problems) {
    const field = `BASE_AIR_BRAND_${p.field.split(".").pop()!.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    if (!problems.some((x) => x.field === field)) problems.push({ field, message: p.message });
  }
  return { brand: parsed.brand, problems };
}

/** Fields that differ between two brands (for the audit log). */
export function brandChanges(before: Brand, after: Brand): string[] {
  const out: string[] = [];
  for (const k of ["preset", "name", "logoUrl", "font", "corners", "mode"] as const) if (before[k] !== after[k]) out.push(k);
  for (const scheme of ["light", "dark"] as const) for (const k of PALETTE_KEYS) if (before.palettes[scheme][k] !== after.palettes[scheme][k]) out.push(`palettes.${scheme}.${k}`);
  return out;
}
