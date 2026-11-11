import crypto from "node:crypto";
import fs from "node:fs";

// Load .env if present (Node built-in; never overrides variables already set in the environment).
// Skipped under `node --test` so local secrets/keys don't leak into the test run.
if (fs.existsSync(".env") && !process.env.NODE_TEST_CONTEXT) process.loadEnvFile(".env");

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
   * "anthropic" uses the Claude API; "mock" uses a deterministic offline generator
   * (great for demos and tests). Defaults to anthropic when an API key is present.
   * This is the platform default; each tenant can pick its own provider and API key in Settings.
   */
  aiProvider: (process.env.AI_PROVIDER ??
    (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "anthropic" : "mock")) as
    | "anthropic"
    | "mock",
  defaultModel: process.env.AI_MODEL ?? "claude-opus-5-5",
  secureCookies: process.env.NODE_ENV === "production",
};
