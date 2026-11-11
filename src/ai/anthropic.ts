import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AiThemeSchema } from "../themes/spec.js";
import { ARTICLE_SYSTEM, articleUserPrompt, THEME_SYSTEM, themeUserPrompt } from "./prompts.js";
import {
  AiRefusalError,
  ArticleDraftSchema,
  type AIProvider,
  type AiResult,
  type ArticleRequest,
  type Effort,
  type ThemeRequest,
} from "./provider.js";

/** A site that used another provider may still have e.g. a GPT model set; use the Claude default then. */
export const anthropicModelFor = (model: string) => (/^claude/i.test(model) ? model : "claude-opus-5-5");

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // Resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile.
    this.client = client ?? new Anthropic();
  }

  async writeArticle(req: ArticleRequest) {
    return this.structured(ARTICLE_SYSTEM, articleUserPrompt(req), ArticleDraftSchema, req.model, req.effort);
  }

  async designTheme(req: ThemeRequest) {
    return this.structured(THEME_SYSTEM, themeUserPrompt(req), AiThemeSchema, req.model, req.effort);
  }

  private async structured<S extends z.ZodType>(
    system: string,
    user: string,
    schema: S,
    model: string,
    effort: Effort,
  ): Promise<AiResult<z.infer<S>>> {
    const response = await this.client.beta.messages.parse({
      model: anthropicModelFor(model),
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
      // If the model declines for policy reasons, let the API retry on its default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      throw new AiRefusalError(response.stop_details?.category ?? null);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("The AI response was cut off (max_tokens). Try a shorter length.");
    }
    if (!response.parsed_output) {
      throw new Error("The AI returned output that did not match the expected format.");
    }
    return {
      value: response.parsed_output as z.infer<S>,
      usage: {
        model: response.model,
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_read_input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
