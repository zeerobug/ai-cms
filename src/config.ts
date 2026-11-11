import crypto from "node:crypto";
import fs from "node:fs";

// Load .env if present (Node built-in; never overrides variables already set in the environment).
// Skipped under `node --test` so local secrets/keys don't leak into the test run.
if (fs.existsSync(".env") && !process.env.NODE_TEST_CONTEXT) process.loadEnvFile(".env");

const aiProvider = (process.env.AI_PROVIDER ??
  (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? "anthropic"
    : process.env.OPENAI_API_KEY
      ? "openai"
      : "mock")) as "anthropic" | "openai" | "mock";
const openaiModel = process.env.OPENAI_MODEL ?? "gpt-5.5";
const openaiImageModel = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";

/**
 * Runtime configuration. Everything can be overridden with environment variables.
 */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** SQLite file path. Use ":memory:" for tests. */
  dbPath: process.env.DB_PATH ?? "data/aicms.sqlite",
  /**
   * Optional base domain for subdomain tenancy, e.g. "mycms.com" makes
   * "acme.mycms.com" resolve to tenant "acme". Tenants can also have a custom domain.
   * Path-based access (/s/<slug>) always works, which is handy for local dev.
   */
  baseDomain: (process.env.BASE_DOMAIN ?? "").toLowerCase(),
  /**
   * Secret used to sign CSRF tokens and encrypt per-tenant LLM API keys. Set it in production:
   * if it changes, tokens are invalidated and stored tenant API keys must be re-entered.
   */
  secret: process.env.APP_SECRET ?? crypto.randomBytes(32).toString("hex"),
  secretIsEphemeral: !process.env.APP_SECRET,
  /**
   * "anthropic" uses the Claude API, "openai" the OpenAI API; "mock" uses a deterministic offline
   * generator (great for demos and tests). Defaults to anthropic when an Anthropic key is present,
   * else openai when OPENAI_API_KEY is set, else mock.
   * This is the platform default; each tenant can pick its own provider and API key in Settings.
   */
  aiProvider,
  /** Default model for new sites (follows the platform provider unless AI_MODEL is set). */
  defaultModel: process.env.AI_MODEL ?? (aiProvider === "openai" ? openaiModel : "claude-opus-5-5"),
  /** Model used for OpenAI requests when a site's model setting is a Claude model. */
  openaiModel,
  /** OpenAI model for AI images (Claude only produces text, so images always come from OpenAI or the mock). */
  openaiImageModel,
  /**
   * Whether sites on a text-only provider (Claude) can still generate images with the platform's
   * OpenAI key.
   */
  platformOpenAiImages: !!process.env.OPENAI_API_KEY,
  secureCookies: process.env.NODE_ENV === "production",
};
