import { z } from "zod";
import { BlocksSchema } from "../content/blocks.js";
import type { ImageAspect } from "../content/media.js";
import type { Palette } from "../themes/palette.js";
import type { AiTheme, ThemeSpec } from "../themes/spec.js";

export const ArticleDraftSchema = z.object({
  title: z.string(),
  summary: z.string().describe("1-2 sentence standfirst shown under the title and on cards"),
  seoTitle: z.string().describe("Title tag for search results: at most 55 characters, main keyword near the start, no site name"),
  seoDescription: z.string().describe("Meta description: 120-155 characters, includes the main keyword, invites the click"),
  slug: z.string().describe("Short lowercase URL slug with the main keyword, words separated by hyphens (3-6 words)"),
  tags: z.array(z.string()).describe("2-5 short lowercase topic tags"),
  blocks: BlocksSchema.describe("The article body as ordered content blocks. Do not repeat the title."),
});
export type ArticleDraft = z.infer<typeof ArticleDraftSchema>;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ArticleLength = "short" | "medium" | "long";

export interface ArticleRequest {
  topic: string;
  instructions: string;
  tone: string;
  length: ArticleLength;
  language: string;
  brandVoice: string;
  site: { name: string; tagline: string };
  existingTitles: string[];
  model: string;
  effort: Effort;
}

export interface ThemeRequest {
  prompt: string;
  site: { name: string; tagline: string };
  current: ThemeSpec;
  /** User-supplied palette to build the colors from (already parsed and sanitized). */
  palette?: Palette;
  model: string;
  effort: Effort;
}

/** Search-engine metadata for an existing article. */
export const SeoDraftSchema = z.object({
  focusKeyword: z.string().describe("The main search phrase this article should rank for"),
  seoTitle: z.string().describe("Title tag for search results: at most 55 characters, focus keyword near the start, no site name"),
  seoDescription: z.string().describe("Meta description: 120-155 characters, includes the focus keyword, accurate and inviting"),
  slug: z.string().describe("Short lowercase URL slug with the focus keyword, words separated by hyphens (3-6 words)"),
  tags: z.array(z.string()).describe("3-5 short lowercase topic tags; reuse the site's existing tags where they fit"),
  imageAlts: z
    .array(z.object({ url: z.string(), alt: z.string().describe("Concise, specific description of the image, under 125 characters") }))
    .describe("Alt text for every image listed in the request, identified by its exact URL"),
  suggestions: z
    .array(z.string())
    .describe("Up to 5 concrete changes to the article itself that would help search ranking; empty if none are needed"),
});
export type SeoDraft = z.infer<typeof SeoDraftSchema>;

/** Search-engine metadata for the site's home page. */
export const SiteSeoSchema = z.object({
  description: z.string().describe("Home page meta description: 120-155 characters, says what the site offers and to whom"),
  suggestions: z.array(z.string()).describe("Up to 5 concrete SEO improvements for the site as a whole; empty if none"),
});
export type SiteSeo = z.infer<typeof SiteSeoSchema>;

export interface SeoRequest {
  site: { name: string; tagline: string };
  language: string;
  article: { title: string; summary: string; tags: string[]; markdown: string };
  /** Images in the article (cover first). `context` is what's known about each: AI prompt, caption, current alt. */
  images: { url: string; context: string }[];
  /** Other article titles on the site (to keep titles distinct). */
  otherTitles: string[];
  /** Tags already used on the site. */
  siteTags: string[];
  model: string;
  effort: Effort;
}

export interface SiteSeoRequest {
  site: { name: string; tagline: string };
  language: string;
  currentDescription: string;
  recentTitles: string[];
  siteTags: string[];
  model: string;
  effort: Effort;
}

export interface ImageRequest {
  prompt: string;
  aspect: ImageAspect;
}

export interface GeneratedImage {
  /** Encoded image bytes (PNG/JPEG/WebP); the format is detected from the bytes. */
  data: Uint8Array;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiResult<T> {
  value: T;
  usage: Usage;
}

export interface AIProvider {
  readonly name: string;
  writeArticle(req: ArticleRequest): Promise<AiResult<ArticleDraft>>;
  designTheme(req: ThemeRequest): Promise<AiResult<AiTheme>>;
  optimizeSeo(req: SeoRequest): Promise<AiResult<SeoDraft>>;
  optimizeSiteSeo(req: SiteSeoRequest): Promise<AiResult<SiteSeo>>;
  /** Only image-capable providers implement this (OpenAI, mock); Claude outputs text only. */
  generateImage?(req: ImageRequest): Promise<AiResult<GeneratedImage>>;
}

export class AiRefusalError extends Error {
  constructor(public category: string | null) {
    super(`The AI declined this request${category ? ` (${category})` : ""}. Try rephrasing it.`);
  }
}
