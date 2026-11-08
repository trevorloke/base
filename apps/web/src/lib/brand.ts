// The site's look: a brand (preset, name, logo, colours, font, corners) turned
// into the CSS custom properties every page's styles read (SUITE.md, "Look
// and brand"). Shared by the server (which writes the properties into the
// HTML it sends, so there is no flash of another look) and the admin's Brand
// page (live preview and contrast check). No server-only code here.
import { z } from "zod";

// ── Fonts: bundled with the site (src/fonts), never fetched from elsewhere ──

export const FONTS = {
  montserrat: { label: "Montserrat", cssVar: "--font-montserrat", family: '"Montserrat"', fallback: "system-ui, sans-serif", note: "Geometric and bold" },
  "public-sans": { label: "Public Sans", cssVar: "--font-public-sans", family: '"Public Sans"', fallback: "system-ui, sans-serif", note: "Plain and civic" },
  inter: { label: "Inter", cssVar: "--font-inter", family: '"Inter"', fallback: "system-ui, sans-serif", note: "Neutral, made for screens" },
  "source-serif": { label: "Source Serif 4", cssVar: "--font-source-serif", family: '"Source Serif 4"', fallback: "Georgia, serif", note: "An editorial serif" },
  atkinson: { label: "Atkinson Hyperlegible", cssVar: "--font-atkinson", family: '"Atkinson Hyperlegible"', fallback: "system-ui, sans-serif", note: "Designed for low vision" },
} as const;
export type FontId = keyof typeof FONTS;
export const FONT_IDS = Object.keys(FONTS) as FontId[];

// ── Corner styles ──

export const CORNERS = {
  sharp: { label: "Sharp", radius: "3px", md: "2px", sm: "2px", button: "2px" },
  soft: { label: "Soft", radius: "10px", md: "8px", sm: "6px", button: "6px" },
  round: { label: "Round", radius: "20px", md: "14px", sm: "10px", button: "999px" },
} as const;
export type CornerId = keyof typeof CORNERS;
export const CORNER_IDS = Object.keys(CORNERS) as CornerId[];

// ── Colours ──

const hex = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/, "Use a six-digit hex colour, like #003979.")
  .transform((v) => `#${v.replace(/^#/, "").toLowerCase()}`);

export const COLOR_FIELDS = [
  { id: "primary", label: "Primary", help: "Headings, links, the main buttons and dark sections." },
  { id: "onPrimary", label: "Text on primary", help: "Text and icons on primary-coloured buttons and sections." },
  { id: "accent", label: "Accent", help: "The donate button, alerts and highlights that call for action." },
  { id: "onAccent", label: "Text on accent", help: "Text on accent-coloured buttons." },
  { id: "highlight", label: "Highlight", help: "Banners, the selected amount's ring and focus rings. Primary is used for text on it." },
  { id: "background", label: "Background", help: "The page and cards." },
  { id: "surface", label: "Surface", help: "Alternate sections and panels." },
  { id: "ink", label: "Text", help: "Body text." },
] as const;
export type ColorId = (typeof COLOR_FIELDS)[number]["id"];
export type BrandColors = Record<ColorId, string>;

// ── Presets ──

export const PRESET_IDS = ["imagine-surrey", "civic", "commons", "heritage", "clear"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

type DerivedToken = keyof typeof DERIVED;

export type Preset = {
  id: PresetId;
  label: string;
  description: string;
  colors: BrandColors;
  font: FontId;
  corners: CornerId;
  /**
   * Hand-tuned values for derived tokens. Each is used only while the
   * colours it comes from are still the preset's own, so a preset can be
   * exactly what it always was, and an edited colour still derives cleanly.
   */
  exact?: Partial<Record<DerivedToken, string>>;
};

export const PRESETS: Record<PresetId, Preset> = {
  "imagine-surrey": {
    id: "imagine-surrey",
    label: "Imagine Surrey",
    description: "Navy, red and yellow with Montserrat: Imagine Surrey's own look.",
    colors: { primary: "#003979", onPrimary: "#ffffff", accent: "#ef2023", onAccent: "#ffffff", highlight: "#fff100", background: "#ffffff", surface: "#f2f4f8", ink: "#0f1e33" },
    font: "montserrat",
    corners: "soft",
    exact: {
      primaryDark: "#00285a",
      accentHover: "#d81b1e",
      accentFill: "#d81b1e",
      accentFillHover: "#b5151a",
      highlightHover: "#fff766",
      highlightPale: "#fff9b3",
      accentPale: "#fde8e8",
      muted: "#4a5872",
      line: "#e3e7ef",
      fieldBorder: "#7f8ca6",
      primaryPale: "#d3deef",
      primaryWash: "#eaf0f8",
    },
  },
  civic: {
    id: "civic",
    label: "Civic",
    description: "Deep teal and signal orange on clean white, set in Public Sans, with rounded buttons. The default for a new client.",
    colors: { primary: "#0f4c5c", onPrimary: "#ffffff", accent: "#dd5410", onAccent: "#ffffff", highlight: "#ffd8a8", background: "#ffffff", surface: "#f1f5f4", ink: "#14232a" },
    font: "public-sans",
    corners: "round",
  },
  commons: {
    id: "commons",
    label: "Commons",
    description: "Violet and magenta with a sunny highlight, set in Inter: bold and grassroots.",
    colors: { primary: "#3f1d7a", onPrimary: "#ffffff", accent: "#d6246e", onAccent: "#ffffff", highlight: "#ffe066", background: "#ffffff", surface: "#f5f2fb", ink: "#1d1530" },
    font: "inter",
    corners: "soft",
  },
  heritage: {
    id: "heritage",
    label: "Heritage",
    description: "Oxblood and ochre on warm paper, in a serif with sharp corners: established and editorial.",
    colors: { primary: "#6e1423", onPrimary: "#fffaf0", accent: "#9c5b00", onAccent: "#ffffff", highlight: "#f3dfb0", background: "#fffdf8", surface: "#f5efe3", ink: "#2a1a14" },
    font: "source-serif",
    corners: "sharp",
  },
  clear: {
    id: "clear",
    label: "Clear",
    description: "Near-black and strong blue in Atkinson Hyperlegible: the highest contrast, for readers with low vision.",
    colors: { primary: "#111827", onPrimary: "#ffffff", accent: "#0b57d0", onAccent: "#ffffff", highlight: "#ffe500", background: "#ffffff", surface: "#f3f4f6", ink: "#0b0f19" },
    font: "atkinson",
    corners: "sharp",
  },
};

// ── The stored brand ──

/** Folders under public/ (and local uploads) a logo may come from on this site. */
export const LOGO_PATH_PREFIXES = ["/images/", "/uploads/", "/icons/"] as const;

/**
 * A logo address: blank, an https:// URL (an upload in Supabase Storage, or
 * another host), or a path to one of this site's own media files. Anything
 * else (http://, javascript:, data:, "//host", credentials in the URL,
 * "../") is refused.
 */
export function isLogoUrl(value: string): boolean {
  if (value === "") return true;
  if (value.startsWith("/")) {
    if (!LOGO_PATH_PREFIXES.some((p) => value.startsWith(p))) return false;
    if (!/^[A-Za-z0-9._~%/-]+$/.test(value) || /(^|\/)\.\.?(\/|$)/.test(value) || /%2f|%5c|%2e/i.test(value)) return false;
    return true;
  }
  if (!/^https:\/\/[^/]/i.test(value) || /[\s"'<>\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const LOGO_MESSAGE = `Use an https:// address or an uploaded image (a path starting ${LOGO_PATH_PREFIXES.join(", ")})`;
const logoUrl = z.string().trim().max(500).default("").refine(isLogoUrl, LOGO_MESSAGE);

export const brandSchema = z.object({
  preset: z.enum(PRESET_IDS),
  /** Shown in the header when there is no logo, in the admin, and as the logo's alt text. Blank: the organization's name. */
  name: z.string().trim().max(80).default(""),
  /** An uploaded image (Admin → Media) or an https:// URL. Blank: the name as a wordmark. */
  logoUrl,
  /** A version of the logo for dark backgrounds (the footer). Blank: the logo. */
  logoOnDarkUrl: logoUrl,
  colors: z.object(Object.fromEntries(COLOR_FIELDS.map((c) => [c.id, hex])) as Record<ColorId, typeof hex>),
  font: z.enum(FONT_IDS as [FontId, ...FontId[]]),
  corners: z.enum(CORNER_IDS as [CornerId, ...CornerId[]]),
});
export type Brand = z.output<typeof brandSchema>;

/** A preset's brand, with optional name and logo. */
export function brandFromPreset(id: PresetId, extra: Partial<Pick<Brand, "name" | "logoUrl" | "logoOnDarkUrl">> = {}): Brand {
  const p = PRESETS[id];
  return { preset: id, name: extra.name ?? "", logoUrl: extra.logoUrl ?? "", logoOnDarkUrl: extra.logoOnDarkUrl ?? "", colors: { ...p.colors }, font: p.font, corners: p.corners };
}

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

// ── Colour maths ──

type Rgb = [number, number, number];

export function parseHex(value: string): Rgb {
  const v = value.replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb;
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0")).join("")}`;
}

/** `a` moved `t` of the way to `b` (0: a, 1: b). */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [parseHex(a), parseHex(b)];
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(color: string): number {
  const [r, g, b] = parseHex(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `color` darkened in small steps until `text` on it reaches 4.5:1 (at most 45% toward black). */
function fillFor(color: string, text: string): string {
  let fill = color;
  for (let t = 0; t <= 0.45 && contrast(text, fill) < 4.5; t += 0.03) fill = mix(color, "#000000", t);
  return fill;
}

// ── Tokens: the CSS custom properties every stylesheet reads ──

/** Each derived token: how it is computed, and the colours it comes from. */
const DERIVED = {
  primaryDark: { from: ["primary"], make: (c: BrandColors) => mix(c.primary, "#000000", 0.3) },
  primaryPale: { from: ["primary"], make: (c: BrandColors) => mix(c.primary, "#ffffff", 0.82) },
  primaryWash: { from: ["primary"], make: (c: BrandColors) => mix(c.primary, "#ffffff", 0.92) },
  accentHover: { from: ["accent"], make: (c: BrandColors) => mix(c.accent, "#000000", 0.1) },
  accentFill: { from: ["accent", "onAccent"], make: (c: BrandColors) => fillFor(c.accent, c.onAccent) },
  accentFillHover: { from: ["accent", "onAccent"], make: (c: BrandColors) => mix(fillFor(c.accent, c.onAccent), "#000000", 0.16) },
  accentPale: { from: ["accent"], make: (c: BrandColors) => mix(c.accent, "#ffffff", 0.9) },
  highlightHover: { from: ["highlight"], make: (c: BrandColors) => mix(c.highlight, "#ffffff", 0.4) },
  highlightPale: { from: ["highlight"], make: (c: BrandColors) => mix(c.highlight, "#ffffff", 0.7) },
  muted: { from: ["ink", "background"], make: (c: BrandColors) => mix(c.ink, c.background, 0.28) },
  line: { from: ["ink", "background"], make: (c: BrandColors) => mix(c.ink, c.background, 0.88) },
  fieldBorder: { from: ["ink", "background"], make: (c: BrandColors) => mix(c.ink, c.background, 0.52) },
} satisfies Record<string, { from: ColorId[]; make: (c: BrandColors) => string }>;

export type Tokens = Record<`--${string}`, string>;

/** Every derived colour for a brand, using a preset's hand-tuned values while their source colours are unchanged. */
export function derivedColors(brand: Brand): Record<DerivedToken, string> {
  const preset = PRESETS[brand.preset];
  const out = {} as Record<DerivedToken, string>;
  for (const [token, rule] of Object.entries(DERIVED) as [DerivedToken, (typeof DERIVED)[DerivedToken]][]) {
    const exact = preset.exact?.[token];
    const unchanged = rule.from.every((id) => brand.colors[id].toLowerCase() === preset.colors[id].toLowerCase());
    out[token] = exact && unchanged ? exact : rule.make(brand.colors);
  }
  return out;
}

/** The CSS custom properties for a brand (names as in src/app/globals.css). */
export function brandTokens(brand: Brand): Tokens {
  const c = brand.colors;
  const d = derivedColors(brand);
  const font = FONTS[brand.font];
  const corners = CORNERS[brand.corners];
  return {
    "--primary": c.primary,
    "--primary-dark": d.primaryDark,
    "--primary-pale": d.primaryPale,
    "--primary-wash": d.primaryWash,
    "--on-primary": c.onPrimary,
    "--accent": c.accent,
    "--accent-hover": d.accentHover,
    "--accent-fill": d.accentFill,
    "--accent-fill-hover": d.accentFillHover,
    "--accent-pale": d.accentPale,
    "--on-accent": c.onAccent,
    "--highlight": c.highlight,
    "--highlight-hover": d.highlightHover,
    "--highlight-pale": d.highlightPale,
    "--bg": c.background,
    "--surface": c.surface,
    "--ink": c.ink,
    "--muted": d.muted,
    "--line": d.line,
    "--field-border": d.fieldBorder,
    "--radius": corners.radius,
    "--radius-md": corners.md,
    "--radius-sm": corners.sm,
    "--radius-btn": corners.button,
    "--font": `var(${font.cssVar}), ${font.family}, ${font.fallback}`,
  };
}

/** A rule setting the tokens on `selector`, safe to put in a <style> element. */
export function brandCss(brand: Brand, selector = ":root"): string {
  const body = Object.entries(brandTokens(brand))
    .map(([k, v]) => `${k}:${v.replace(/[<>{};]/g, "")}`)
    .join(";");
  return `${selector}{${body}}`;
}

// ── Contrast check ──

export type ContrastPair = { id: string; label: string; text: string; background: string; ratio: number; ok: boolean };

/** The text-and-background pairs the public site uses; each must reach 4.5:1. */
export function contrastPairs(brand: Brand): ContrastPair[] {
  const c = brand.colors;
  const d = derivedColors(brand);
  const pairs: [string, string, string, string][] = [
    ["body", "Body text on the page", c.ink, c.background],
    ["body-surface", "Body text on a surface section", c.ink, c.surface],
    ["muted", "Secondary text on the page", d.muted, c.background],
    ["links", "Links and headings on the page", c.primary, c.background],
    ["links-surface", "Links and headings on a surface section", c.primary, c.surface],
    ["primary-button", "Text on primary buttons and sections", c.onPrimary, c.primary],
    ["footer", "Text in the footer", d.primaryPale, d.primaryDark],
    ["accent-button", "Text on accent buttons (donate)", c.onAccent, d.accentFill],
    ["accent-link", "Accent links on hover", d.accentHover, c.background],
    ["highlight", "Primary text on highlight banners", c.primary, c.highlight],
    ["highlight-on-primary", "Highlighted words on primary sections", c.highlight, c.primary],
  ];
  return pairs.map(([id, label, text, background]) => {
    const ratio = contrast(text, background);
    return { id, label, text, background, ratio: Math.round(ratio * 100) / 100, ok: ratio >= 4.5 };
  });
}

/** The name shown for the brand: its own, else the organization's. */
export function brandName(brand: Brand, orgName: string): string {
  return brand.name.trim() || orgName;
}

/** The colours share images (opengraph-image routes) draw with. */
export function shareImageColors(brand: Brand) {
  const d = derivedColors(brand);
  return { primary: brand.colors.primary, onPrimary: brand.colors.onPrimary, accent: brand.colors.accent, accentFill: d.accentFill, onAccent: brand.colors.onAccent, highlight: brand.colors.highlight, pale: d.primaryPale };
}
