import { z } from "zod";

/**
 * THE TEMPLATE SYSTEM
 * -------------------
 * Every site and every theme is rendered by the same layout engine (themes/render.ts).
 * A "theme" is just a ThemeSpec: design tokens + a set of layout choices from a fixed
 * vocabulary. The AI designs a site by producing a ThemeSpec, never raw HTML/CSS,
 * so every generated look is safe, consistent, responsive and works with all content.
 */

export const FONTS = {
  "Inter": "sans-serif",
  "Work Sans": "sans-serif",
  "Poppins": "sans-serif",
  "Space Grotesk": "sans-serif",
  "IBM Plex Sans": "sans-serif",
  "DM Sans": "sans-serif",
  "Bebas Neue": "sans-serif",
  "Merriweather": "serif",
  "Lora": "serif",
  "Playfair Display": "serif",
  "DM Serif Display": "serif",
  "Source Serif 4": "serif",
  "Libre Baskerville": "serif",
  "Fraunces": "serif",
  "JetBrains Mono": "monospace",
  "IBM Plex Mono": "monospace",
  "system-ui": "sans-serif",
} as const;
export type FontName = keyof typeof FONTS;
const fontNames = Object.keys(FONTS) as [FontName, ...FontName[]];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb");

export const HEADER_STYLES = ["left", "centered", "split", "minimal", "bold-band"] as const;
export const HOME_LAYOUTS = ["grid", "list", "magazine", "cards", "minimal"] as const;
export const ARTICLE_LAYOUTS = ["classic", "wide", "sidebar"] as const;
export const CARD_STYLES = ["flat", "bordered", "shadow", "elevated"] as const;
export const DENSITIES = ["compact", "comfortable", "airy"] as const;
export const HERO_STYLES = ["plain", "gradient", "band", "image"] as const;
export const BACKGROUNDS = ["none", "dots", "grid", "gradient", "paper"] as const;
export const LINK_STYLES = ["underline", "color", "highlight"] as const;

export const ThemeSpecSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400),
  colors: z.object({
    background: hex,
    surface: hex,
    text: hex,
    muted: hex,
    primary: hex,
    primaryText: hex,
    accent: hex,
    border: hex,
  }),
  typography: z.object({
    headingFont: z.enum(fontNames),
    bodyFont: z.enum(fontNames),
    baseSize: z.number().min(14).max(22),
    scale: z.number().min(1.1).max(1.6),
    headingWeight: z.number().int().min(300).max(900),
    headingTransform: z.enum(["none", "uppercase"]),
    lineHeight: z.number().min(1.3).max(2),
  }),
  shape: z.object({
    radius: z.number().min(0).max(32),
    cardStyle: z.enum(CARD_STYLES),
    density: z.enum(DENSITIES),
  }),
  layout: z.object({
    maxWidth: z.number().int().min(640).max(1440),
    header: z.enum(HEADER_STYLES),
    home: z.enum(HOME_LAYOUTS),
    columns: z.number().int().min(1).max(4),
    article: z.enum(ARTICLE_LAYOUTS),
    showSummaries: z.boolean(),
    showDates: z.boolean(),
    showReadingTime: z.boolean(),
  }),
  hero: z.object({
    enabled: z.boolean(),
    title: z.string().max(140),
    subtitle: z.string().max(300),
    style: z.enum(HERO_STYLES),
    align: z.enum(["left", "center"]),
    imageUrl: z.string().max(500),
  }),
  decoration: z.object({
    background: z.enum(BACKGROUNDS),
    linkStyle: z.enum(LINK_STYLES),
  }),
  nav: z.array(z.object({ label: z.string().max(40), href: z.string().max(300) })).max(8),
  footer: z.object({ text: z.string().max(300), showPoweredBy: z.boolean() }),
});
export type ThemeSpec = z.infer<typeof ThemeSpecSchema>;

/**
 * Schema handed to the model. It has the same shape as ThemeSpec but without numeric
 * bounds (structured outputs don't enforce them) - normalizeTheme() clamps afterwards.
 */
export const AiThemeSchema = z.object({
  name: z.string(),
  description: z.string().describe("One sentence describing the look and mood"),
  colors: z.object({
    background: z.string().describe("#rrggbb page background"),
    surface: z.string().describe("#rrggbb card/panel background"),
    text: z.string().describe("#rrggbb main text; must contrast strongly with background"),
    muted: z.string().describe("#rrggbb secondary text"),
    primary: z.string().describe("#rrggbb brand color for buttons, hero, accents"),
    primaryText: z.string().describe("#rrggbb text drawn on top of primary"),
    accent: z.string().describe("#rrggbb secondary highlight color"),
    border: z.string().describe("#rrggbb hairline borders"),
  }),
  typography: z.object({
    headingFont: z.enum(fontNames),
    bodyFont: z.enum(fontNames),
    baseSize: z.number().describe("Body font size in px, 14-22"),
    scale: z.number().describe("Heading type scale ratio, 1.1-1.6"),
    headingWeight: z.number().describe("300-900"),
    headingTransform: z.enum(["none", "uppercase"]),
    lineHeight: z.number().describe("1.3-2.0"),
  }),
  shape: z.object({
    radius: z.number().describe("Corner radius in px, 0-32"),
    cardStyle: z.enum(CARD_STYLES),
    density: z.enum(DENSITIES),
  }),
  layout: z.object({
    maxWidth: z.number().describe("Content max width in px, 640-1440"),
    header: z.enum(HEADER_STYLES),
    home: z.enum(HOME_LAYOUTS),
    columns: z.number().describe("Columns for grid/cards home layouts, 1-4"),
    article: z.enum(ARTICLE_LAYOUTS),
    showSummaries: z.boolean(),
    showDates: z.boolean(),
    showReadingTime: z.boolean(),
  }),
  hero: z.object({
    enabled: z.boolean(),
    title: z.string(),
    subtitle: z.string(),
    style: z.enum(HERO_STYLES),
    align: z.enum(["left", "center"]),
    imageUrl: z.string().describe("https image URL for the 'image' hero style, otherwise empty"),
  }),
  decoration: z.object({ background: z.enum(BACKGROUNDS), linkStyle: z.enum(LINK_STYLES) }),
  nav: z.array(z.object({ label: z.string(), href: z.string() })),
  footer: z.object({ text: z.string(), showPoweredBy: z.boolean() }),
});
export type AiTheme = z.infer<typeof AiThemeSchema>;

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(hi, Math.max(lo, v));
};
const color = (c: unknown, fallback: string) =>
  typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c.trim()) ? c.trim().toLowerCase() : fallback;
const str = (s: unknown, max: number, fallback = "") =>
  typeof s === "string" ? s.slice(0, max) : fallback;
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Turn any partial / slightly-off theme (from the AI or a hand-edited JSON) into a valid
 * ThemeSpec, filling gaps from `base`.
 */
export function normalizeTheme(input: unknown, base: ThemeSpec): ThemeSpec {
  const i = (input ?? {}) as Partial<Record<keyof ThemeSpec, any>>;
  const c = i.colors ?? {};
  const t = i.typography ?? {};
  const sh = i.shape ?? {};
  const l = i.layout ?? {};
  const h = i.hero ?? {};
  const d = i.decoration ?? {};
  const f = i.footer ?? {};
  const spec: ThemeSpec = {
    name: str(i.name, 80) || base.name,
    description: str(i.description, 400, base.description),
    colors: {
      background: color(c.background, base.colors.background),
      surface: color(c.surface, base.colors.surface),
      text: color(c.text, base.colors.text),
      muted: color(c.muted, base.colors.muted),
      primary: color(c.primary, base.colors.primary),
      primaryText: color(c.primaryText, base.colors.primaryText),
      accent: color(c.accent, base.colors.accent),
      border: color(c.border, base.colors.border),
    },
    typography: {
      headingFont: pick(t.headingFont, fontNames, base.typography.headingFont),
      bodyFont: pick(t.bodyFont, fontNames, base.typography.bodyFont),
      baseSize: clamp(t.baseSize, 14, 22, base.typography.baseSize),
      scale: clamp(t.scale, 1.1, 1.6, base.typography.scale),
      headingWeight: Math.round(clamp(t.headingWeight, 300, 900, base.typography.headingWeight) / 100) * 100,
      headingTransform: pick(t.headingTransform, ["none", "uppercase"] as const, base.typography.headingTransform),
      lineHeight: clamp(t.lineHeight, 1.3, 2, base.typography.lineHeight),
    },
    shape: {
      radius: clamp(sh.radius, 0, 32, base.shape.radius),
      cardStyle: pick(sh.cardStyle, CARD_STYLES, base.shape.cardStyle),
      density: pick(sh.density, DENSITIES, base.shape.density),
    },
    layout: {
      maxWidth: Math.round(clamp(l.maxWidth, 640, 1440, base.layout.maxWidth)),
      header: pick(l.header, HEADER_STYLES, base.layout.header),
      home: pick(l.home, HOME_LAYOUTS, base.layout.home),
      columns: Math.round(clamp(l.columns, 1, 4, base.layout.columns)),
      article: pick(l.article, ARTICLE_LAYOUTS, base.layout.article),
      showSummaries: typeof l.showSummaries === "boolean" ? l.showSummaries : base.layout.showSummaries,
      showDates: typeof l.showDates === "boolean" ? l.showDates : base.layout.showDates,
      showReadingTime: typeof l.showReadingTime === "boolean" ? l.showReadingTime : base.layout.showReadingTime,
    },
    hero: {
      enabled: typeof h.enabled === "boolean" ? h.enabled : base.hero.enabled,
      title: str(h.title, 140, base.hero.title),
      subtitle: str(h.subtitle, 300, base.hero.subtitle),
      style: pick(h.style, HERO_STYLES, base.hero.style),
      align: pick(h.align, ["left", "center"] as const, base.hero.align),
      imageUrl: typeof h.imageUrl === "string" && /^https:\/\//.test(h.imageUrl) ? h.imageUrl.slice(0, 500) : "",
    },
    decoration: {
      background: pick(d.background, BACKGROUNDS, base.decoration.background),
      linkStyle: pick(d.linkStyle, LINK_STYLES, base.decoration.linkStyle),
    },
    nav: Array.isArray(i.nav)
      ? i.nav
          .filter((n: any) => n && typeof n.label === "string" && typeof n.href === "string")
          .slice(0, 8)
          .map((n: any) => ({ label: n.label.slice(0, 40), href: n.href.slice(0, 300) }))
      : base.nav,
    footer: {
      text: str(f.text, 300, base.footer.text),
      showPoweredBy: typeof f.showPoweredBy === "boolean" ? f.showPoweredBy : base.footer.showPoweredBy,
    },
  };
  if (spec.hero.style === "image" && !spec.hero.imageUrl) spec.hero.style = "gradient";
  return ThemeSpecSchema.parse(spec);
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const DEFAULT_THEME: ThemeSpec = {
  name: "Clean",
  description: "A clean, neutral editorial look.",
  colors: {
    background: "#ffffff",
    surface: "#f7f7f8",
    text: "#1a1a1f",
    muted: "#62626e",
    primary: "#3b5bdb",
    primaryText: "#ffffff",
    accent: "#f08c00",
    border: "#e4e4e9",
  },
  typography: {
    headingFont: "Inter",
    bodyFont: "Inter",
    baseSize: 17,
    scale: 1.25,
    headingWeight: 700,
    headingTransform: "none",
    lineHeight: 1.65,
  },
  shape: { radius: 10, cardStyle: "bordered", density: "comfortable" },
  layout: {
    maxWidth: 1120,
    header: "left",
    home: "grid",
    columns: 3,
    article: "classic",
    showSummaries: true,
    showDates: true,
    showReadingTime: true,
  },
  hero: { enabled: true, title: "", subtitle: "", style: "plain", align: "left", imageUrl: "" },
  decoration: { background: "none", linkStyle: "color" },
  nav: [],
  footer: { text: "", showPoweredBy: true },
};

export const PRESETS: ThemeSpec[] = [
  DEFAULT_THEME,
  normalizeTheme(
    {
      name: "Editorial",
      description: "Classic newspaper-style serif magazine.",
      colors: { background: "#fbf8f3", surface: "#ffffff", text: "#1d1b18", muted: "#6b645a", primary: "#8b1e1e", primaryText: "#ffffff", accent: "#c9a227", border: "#e6dfd3" },
      typography: { headingFont: "Playfair Display", bodyFont: "Source Serif 4", baseSize: 18, scale: 1.33, headingWeight: 700, headingTransform: "none", lineHeight: 1.7 },
      shape: { radius: 0, cardStyle: "flat", density: "comfortable" },
      layout: { header: "centered", home: "magazine", columns: 3, article: "classic", maxWidth: 1180 },
      hero: { enabled: false, style: "plain", align: "center" },
      decoration: { background: "paper", linkStyle: "underline" },
    },
    DEFAULT_THEME,
  ),
  normalizeTheme(
    {
      name: "Midnight",
      description: "Dark, techy, high-contrast.",
      colors: { background: "#0d1117", surface: "#161b22", text: "#e6edf3", muted: "#8b949e", primary: "#7c3aed", primaryText: "#ffffff", accent: "#22d3ee", border: "#30363d" },
      typography: { headingFont: "Space Grotesk", bodyFont: "IBM Plex Sans", baseSize: 17, scale: 1.25, headingWeight: 700, headingTransform: "none", lineHeight: 1.65 },
      shape: { radius: 14, cardStyle: "elevated", density: "comfortable" },
      layout: { header: "split", home: "cards", columns: 3, article: "sidebar" },
      hero: { enabled: true, style: "gradient", align: "left" },
      decoration: { background: "grid", linkStyle: "highlight" },
    },
    DEFAULT_THEME,
  ),
  normalizeTheme(
    {
      name: "Minimal",
      description: "Quiet, typographic, lots of whitespace.",
      colors: { background: "#ffffff", surface: "#ffffff", text: "#111111", muted: "#777777", primary: "#111111", primaryText: "#ffffff", accent: "#ff5a36", border: "#eeeeee" },
      typography: { headingFont: "DM Sans", bodyFont: "Lora", baseSize: 19, scale: 1.2, headingWeight: 600, headingTransform: "none", lineHeight: 1.8 },
      shape: { radius: 0, cardStyle: "flat", density: "airy" },
      layout: { header: "minimal", home: "minimal", columns: 1, article: "classic", maxWidth: 760 },
      hero: { enabled: false },
      decoration: { background: "none", linkStyle: "underline" },
    },
    DEFAULT_THEME,
  ),
];
