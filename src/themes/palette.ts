import type { ThemeSpec } from "./spec.js";

/**
 * COLOR PALETTES
 * --------------
 * A palette is a user-supplied set of colors (pasted values or an uploaded file) that feeds a
 * theme's `colors`. It is never rendered directly: it is parsed into plain #rrggbb values, mapped
 * onto the ThemeSpec color roles, and the result still goes through normalizeTheme.
 *
 * Accepted input (text, any of):
 *   - plain list:     #264653, #2a9d8f, e9c46a  (also #rgb and rgb(r, g, b))
 *   - named values:   primary: #0b6e99 / --primary: #0b6e99; / $primary: … / primary = …
 *   - JSON:           ["#264653", …] | {"primary": "#0b6e99", …} | {"colors": [...]}
 *                     | [{"name": "primary", "hex": "#0b6e99"}, …]
 *   - GIMP palette:   .gpl lines "R G B  Name"
 *   - Coolors URL:    https://coolors.co/264653-2a9d8f-e9c46a
 * Names that match a theme role (see ROLE_ALIASES) pin that role; others are just palette colors.
 */

export type ColorRole = keyof ThemeSpec["colors"];
export const COLOR_ROLES: readonly ColorRole[] = ["background", "surface", "text", "muted", "primary", "primaryText", "accent", "border"];

export interface Palette {
  /** All colors in input order, unique, lowercase #rrggbb. */
  colors: string[];
  /** Colors the user explicitly assigned to a theme role. */
  roles: Partial<Record<ColorRole, string>>;
}

export const MAX_PALETTE_INPUT = 64 * 1024;
const MAX_COLORS = 32;

const ROLE_ALIASES: Record<string, ColorRole> = {};
for (const [role, names] of Object.entries({
  background: ["background", "bg", "page", "base", "canvas", "paper", "page-background"],
  surface: ["surface", "card", "panel", "background-alt", "bg-alt", "surface-background"],
  text: ["text", "foreground", "fg", "ink", "body", "body-text", "on-background", "on-surface"],
  muted: ["muted", "text-muted", "muted-text", "secondary-text", "text-secondary", "subtle", "subtext"],
  primary: ["primary", "brand", "main", "brand-primary"],
  primaryText: ["primary-text", "on-primary", "primary-foreground", "primary-contrast", "text-on-primary"],
  accent: ["accent", "secondary", "highlight", "brand-secondary"],
  border: ["border", "line", "divider", "outline", "stroke", "rule"],
} satisfies Record<ColorRole, string[]>)) {
  for (const n of names) ROLE_ALIASES[n] = role as ColorRole;
}

/** "--color-primaryText" / "$Primary_Text" → "primary-text" → role. */
export function roleForName(name: string): ColorRole | undefined {
  const key = name
    .trim()
    .replace(/^(--|\$|@)/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/^(theme-)?(colou?rs?-)/, "");
  return ROLE_ALIASES[key];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const to2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** Parse a single color literal (#rgb, #rrggbb, rrggbb, rgb(...)) to #rrggbb, or null. */
export function parseColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) return `#${m[1].toLowerCase()}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/][^)]*)?\)$/i.exec(s);
  if (m) return `#${to2(+m[1])}${to2(+m[2])}${to2(+m[3])}`;
  return null;
}

class Collector {
  palette: Palette = { colors: [], roles: {} };
  add(hex: string | null, name?: string) {
    if (!hex) return;
    if (!this.palette.colors.includes(hex) && this.palette.colors.length < MAX_COLORS) this.palette.colors.push(hex);
    const role = name ? roleForName(name) : undefined;
    if (role && !this.palette.roles[role]) this.palette.roles[role] = hex;
  }
}

function fromJson(value: unknown, c: Collector, name?: string, depth = 0): void {
  if (depth > 4) return;
  if (typeof value === "string") return c.add(parseColor(value), name);
  if (Array.isArray(value)) return value.forEach((v) => fromJson(v, c, undefined, depth + 1));
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // {name, hex|color|value} entry
    const literal = o.hex ?? o.color ?? o.colour ?? o.value;
    if (typeof literal === "string" && parseColor(literal)) {
      return c.add(parseColor(literal), typeof o.name === "string" ? o.name : typeof o.role === "string" ? o.role : name);
    }
    for (const [k, v] of Object.entries(o)) fromJson(v, c, k, depth + 1);
  }
}

const COLOR_TOKEN = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi;

function fromText(text: string, c: Collector) {
  // Coolors-style URL: …/264653-2a9d8f-e9c46a
  const coolors = /coolors\.co\/(?:palette\/)?([0-9a-f]{6}(?:-[0-9a-f]{6})+)/i.exec(text);
  if (coolors) return coolors[1].split("-").forEach((h) => c.add(parseColor(h)));

  const anyHash = /#[0-9a-f]{3,6}\b|rgba?\(/i.test(text);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\*.*?\*\/|\/\/.*$/g, "").trim();
    if (!line || /^(GIMP Palette|Name:|Columns:|#\s|#$)/i.test(line)) continue;

    // GIMP .gpl: "R G B<tab>Name"
    const gpl = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s+(.*))?$/.exec(line);
    if (gpl) {
      c.add(`#${to2(+gpl[1])}${to2(+gpl[2])}${to2(+gpl[3])}`, gpl[4]);
      continue;
    }

    // "name: value" / "--name: value;" / "name = value"
    const named = /^([$@]?-{0,2}[a-z][\w\s.-]*?)\s*[:=]\s*(.+?);?$/i.exec(line);
    if (named) {
      const tok = named[2].match(COLOR_TOKEN)?.[0] ?? (anyHash ? null : named[2].trim());
      const hex = parseColor(tok ?? "");
      if (hex) {
        c.add(hex, named[1]);
        continue;
      }
    }

    for (const tok of line.match(COLOR_TOKEN) ?? []) c.add(parseColor(tok));
    // Bare hex lists ("264653, 2a9d8f") only when the input uses no #/rgb() notation at all.
    if (!anyHash) for (const tok of line.match(/\b[0-9a-f]{6}\b/gi) ?? []) c.add(parseColor(tok));
  }
}

/**
 * Parse palette input (pasted text, file contents or an already-structured JSON value).
 * Returns an empty palette when nothing usable was found.
 */
export function parsePalette(input: unknown): Palette {
  const c = new Collector();
  if (typeof input !== "string") {
    fromJson(input, c);
    return c.palette;
  }
  const text = input.slice(0, MAX_PALETTE_INPUT).replace(/^﻿/, "");
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      fromJson(JSON.parse(trimmed), c);
      return c.palette;
    } catch {
      /* not JSON - fall through to text parsing */
    }
  }
  fromText(text, c);
  return c.palette;
}

// ---------------------------------------------------------------------------
// Mapping a palette onto theme colors
// ---------------------------------------------------------------------------

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

export function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const chroma = (hex: string) => {
  const v = rgb(hex);
  return (Math.max(...v) - Math.min(...v)) / 255;
};

/** Blend `a` toward `b` by t (0..1). */
export function mix(a: string, b: string, t: number) {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x.map((v, i) => to2(v + (y[i] - v) * t)).join("")}`;
}

const bestTextOn = (bg: string) => (contrast(bg, "#ffffff") >= contrast(bg, "#111111") ? "#ffffff" : "#111111");

/**
 * Map a palette onto all eight theme color roles. Explicitly named roles always win; the rest
 * are assigned by lightness / saturation and contrast, falling back to `base` or derived tints
 * so the result stays readable.
 */
export function paletteToColors(p: Palette, base: ThemeSpec["colors"]): ThemeSpec["colors"] {
  const r = { ...p.roles };
  const used = new Set(Object.values(r));
  const pool = () => p.colors.filter((c) => !used.has(c));
  const take = (role: ColorRole, c: string | undefined) => {
    if (c && !r[role]) {
      r[role] = c;
      used.add(c);
    }
  };

  // Background: keep the base theme's light/dark mode; only use a palette color if it's a real
  // page color (very light or very dark), otherwise keep the base background.
  if (!r.background) {
    const dark = luminance(base.background) < 0.4;
    const sorted = [...pool()].sort((a, b) => luminance(a) - luminance(b));
    const cand = dark ? sorted[0] : sorted.at(-1);
    take("background", cand && (dark ? luminance(cand) < 0.06 : luminance(cand) > 0.8) ? cand : base.background);
  }
  const bg = r.background!;

  if (!r.text) {
    const cand = [...pool()].sort((a, b) => contrast(b, bg) - contrast(a, bg))[0];
    take("text", cand && contrast(cand, bg) >= 7 ? cand : contrast(base.text, bg) >= 4.5 ? base.text : bestTextOn(bg));
  }
  const text = r.text!;

  // Brand colors: the most saturated remaining colors.
  const vivid = () => [...pool()].sort((a, b) => chroma(b) - chroma(a));
  take("primary", vivid()[0] ?? base.primary);
  take("accent", vivid()[0] ?? base.accent);

  if (!r.surface) {
    const near = pool().find((c) => contrast(c, bg) < 1.15 && c !== bg);
    take("surface", near ?? mix(bg, text, 0.035));
  }
  take("primaryText", bestTextOn(r.primary!));
  take("muted", mix(text, bg, 0.35));
  take("border", mix(bg, text, 0.12));
  return r as ThemeSpec["colors"];
}

/** Short human description, e.g. for prompts and job pages. */
export function describePalette(p: Palette) {
  const named = Object.entries(p.roles).map(([k, v]) => `${k}=${v}`);
  const free = p.colors.filter((c) => !Object.values(p.roles).includes(c));
  return [named.length ? `assigned: ${named.join(", ")}` : "", free.length ? `colors: ${free.join(", ")}` : ""].filter(Boolean).join("; ");
}
