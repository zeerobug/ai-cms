import { z } from "zod";
import { BlocksSchema } from "../content/blocks.js";
import type { ImageAspect } from "../content/media.js";
import type { Palette } from "../themes/palette.js";
import type { AiTheme, ThemeSpec } from "../themes/spec.js";

export const ArticleDraftSchema = z.object({
  title: z.string(),
  summary: z.string().describe("1-2 sentence standfirst shown under the title and on cards"),
  seoDescription: z.string().describe("Meta description, max ~155 characters"),
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
  /** Only image-capable providers implement this (OpenAI, mock); Claude outputs text only. */
  generateImage?(req: ImageRequest): Promise<AiResult<GeneratedImage>>;
}

export class AiRefusalError extends Error {
  constructor(public category: string | null) {
    super(`The AI declined this request${category ? ` (${category})` : ""}. Try rephrasing it.`);
  }
}
