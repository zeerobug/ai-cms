import { describePalette } from "../themes/palette.js";
import { FONTS } from "../themes/spec.js";
import type { ArticleRequest, ThemeRequest } from "./provider.js";

// Prompts shared by every LLM provider, so all backends get the same instructions.

const LENGTH_GUIDE = {
  short: "about 400-600 words",
  medium: "about 900-1300 words",
  long: "about 1800-2500 words",
} as const;

// Stable system prompts (kept byte-identical across requests so they can be cached).
export const ARTICLE_SYSTEM = `You are the staff writer for a website running on a content management system.
You write complete, publish-ready articles and return them as structured content blocks.

Writing rules:
- Open with a strong first paragraph; never start with "In today's world" or similar filler.
- Use "heading" blocks (level 2 for sections, level 3 for sub-sections) to structure the piece.
- Prefer concrete facts, examples and numbers over generic claims. Do not invent statistics, quotes,
  studies or named sources; if you are unsure of a specific fact, write around it.
- Use lists, quotes, callouts and code blocks only where they genuinely help the reader.
- Inline formatting allowed in text fields: **bold**, *italic*, \`code\`, [link](https://...). No HTML.
- Only use "image" blocks if the request supplies image URLs; never make up image URLs.
- Do not repeat the title as the first block. End with a short concluding section or takeaway.
- Match the requested language, tone and length.`;

export const THEME_SYSTEM = `You are a senior web designer. You design the look and feel of a website by filling in a
theme specification for a fixed template system. You cannot write HTML or CSS; every visual decision is
expressed through the spec fields, which a shared layout engine turns into the site.

What the fields do:
- colors: page background, surface (cards/panels), text, muted (secondary text), primary (brand; used for
  links, buttons, hero band/gradient), primaryText (text on primary), accent (highlights, quote bars,
  gradient end), border. All "#rrggbb". Ensure WCAG AA contrast between text/background and
  primaryText/primary.
- typography: heading and body fonts from the allowed list (${Object.keys(FONTS).join(", ")}),
  baseSize px (14-22), scale ratio (1.1-1.6), headingWeight (300-900), headingTransform, lineHeight.
- shape: radius px (0-32), cardStyle (flat | bordered | shadow | elevated), density (compact | comfortable | airy).
- layout: maxWidth px; header (left | centered | split | minimal | bold-band); home page layout
  (grid | list | magazine [big lead story then grid] | cards | minimal [text-only list]); columns 1-4 for
  grid/cards/magazine; article layout (classic | wide | sidebar [with table of contents]); toggles for
  summaries, dates and reading time on cards.
- hero: optional banner on the home page (plain | gradient | band | image) with title/subtitle; leave
  title/subtitle empty to use the site name and tagline. Only use "image" with an image URL the user gave
  or the current theme's imageUrl (keep that unless asked to change or remove it); never invent URLs.
- decoration: background texture (none | dots | grid | gradient | paper), linkStyle (underline | color | highlight).
- nav: up to 8 header links; use "/" for home and "/tag/<tag>" for tag pages; keep existing links unless asked.
- footer: text and whether to show "Powered by" credit.

Start from the current theme and change what the request implies; a request about one aspect (e.g.
"make it darker") should leave unrelated choices alone. Give the theme a short evocative name.`;

// Image prompts (sent to the image model; Claude itself doesn't generate images).

const IMAGE_RULES = "No text, letters, captions, logos or watermarks anywhere in the image.";

export function articleImagePrompt(a: { title: string; summary: string; siteName: string }): string {
  return `Editorial cover image for an article titled "${a.title}" on the website "${a.siteName}". ` +
    (a.summary ? `The article: ${a.summary} ` : "") +
    `A single clear subject, natural lighting, high quality, suitable as a wide header image. ${IMAGE_RULES}`;
}

export function heroImagePrompt(site: { name: string; tagline: string }, brief: string): string {
  return `Wide atmospheric banner image for the home page of the website "${site.name}"` +
    (site.tagline ? ` (${site.tagline})` : "") +
    `. Visual direction: ${brief}. Calm composition with space for a headline overlay, works well darkened. ${IMAGE_RULES}`;
}

export function articleUserPrompt(req: ArticleRequest): string {
  return [
    `Website: ${req.site.name}${req.site.tagline ? ` — ${req.site.tagline}` : ""}`,
    req.brandVoice && `Brand voice / editorial guidelines:\n${req.brandVoice}`,
    `Language: ${req.language}`,
    `Tone: ${req.tone}`,
    `Length: ${LENGTH_GUIDE[req.length]}`,
    req.existingTitles.length &&
      `Already published on this site (avoid duplicating these angles):\n${req.existingTitles.map((t) => `- ${t}`).join("\n")}`,
    `Write an article about: ${req.topic}`,
    req.instructions && `Additional instructions:\n${req.instructions}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function themeUserPrompt(req: ThemeRequest): string {
  return [
    `Website: ${req.site.name}${req.site.tagline ? ` — ${req.site.tagline}` : ""}`,
    `Current theme:\n${JSON.stringify(req.current, null, 2)}`,
    req.palette &&
      `Color palette supplied by the user (${describePalette(req.palette)}).\n` +
        `Build the theme colors from this palette: use assigned colors exactly for their roles and give the other ` +
        `palette colors sensible roles (typically the most saturated as primary/accent). You may derive tints or ` +
        `shades of palette colors for background, surface, muted and border when needed for readability and contrast.`,
    `Design request: ${req.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
