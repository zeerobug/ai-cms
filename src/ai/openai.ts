import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { config } from "../config.js";
import { AiThemeSchema } from "../themes/spec.js";
import { ARTICLE_SYSTEM, articleUserPrompt, THEME_SYSTEM, themeUserPrompt } from "./prompts.js";
import {
  AiRefusalError,
  ArticleDraftSchema,
  type AIProvider,
  type AiResult,
  type ArticleRequest,
  type Effort,
  type GeneratedImage,
  type ImageRequest,
  type ThemeRequest,
} from "./provider.js";

const IMAGE_SIZES = { landscape: "1536x1024", square: "1024x1024", portrait: "1024x1536" } as const;

/**
 * Sites default to a Claude model; when such a site switches to OpenAI without changing the
 * model setting, use the OpenAI default instead of sending a model OpenAI doesn't know.
 */
export function openAiModelFor(model: string): string {
  return /^claude/i.test(model) ? config.openaiModel : model;
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private client: OpenAI;

  constructor(client?: OpenAI) {
    // Resolves OPENAI_API_KEY (and OPENAI_BASE_URL / OPENAI_ORG_ID) from the environment.
    this.client = client ?? new OpenAI();
  }

  async writeArticle(req: ArticleRequest) {
    return this.structured(ARTICLE_SYSTEM, articleUserPrompt(req), ArticleDraftSchema, "article", req.model, req.effort);
  }

  async designTheme(req: ThemeRequest) {
    return this.structured(THEME_SYSTEM, themeUserPrompt(req), AiThemeSchema, "theme", req.model, req.effort);
  }

  async generateImage(req: ImageRequest): Promise<AiResult<GeneratedImage>> {
    const model = config.openaiImageModel;
    let response;
    try {
      response = await this.client.images.generate({
        model,
        prompt: req.prompt,
        size: IMAGE_SIZES[req.aspect],
        quality: "medium",
        output_format: "webp",
        output_compression: 85,
        n: 1,
      });
    } catch (err) {
      if (err instanceof OpenAI.BadRequestError && err.code === "moderation_blocked") throw new AiRefusalError("image moderation");
      throw err;
    }
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error("The AI returned no image.");
    return {
      value: { data: Buffer.from(b64, "base64") },
      usage: { model, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 },
    };
  }

  private async structured<S extends z.ZodType>(
    instructions: string,
    user: string,
    schema: S,
    name: string,
    model: string,
    effort: Effort,
  ): Promise<AiResult<z.infer<S>>> {
    const response = await this.client.responses.parse({
      model: openAiModelFor(model),
      max_output_tokens: 16000,
      // Stable instructions first so OpenAI's automatic prompt caching can reuse them.
      instructions,
      input: user,
      reasoning: { effort },
      text: { format: zodTextFormat(schema, name) },
      store: false,
    });

    for (const item of response.output) {
      if (item.type !== "message") continue;
      for (const part of item.content) if (part.type === "refusal") throw new AiRefusalError(null);
    }
    if (response.status === "incomplete") {
      if (response.incomplete_details?.reason === "max_output_tokens")
        throw new Error("The AI response was cut off (max_output_tokens). Try a shorter length.");
      throw new Error(`The AI response was incomplete (${response.incomplete_details?.reason ?? "unknown reason"}).`);
    }
    if (!response.output_parsed) {
      throw new Error("The AI returned output that did not match the expected format.");
    }
    return {
      value: response.output_parsed as z.infer<S>,
      usage: {
        model: response.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}
