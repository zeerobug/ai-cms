import crypto from "node:crypto";

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
  /** Secret used to sign CSRF tokens. Set it in production so tokens survive restarts. */
  secret: process.env.APP_SECRET ?? crypto.randomBytes(32).toString("hex"),
  /**
   * "anthropic" uses the Claude API; "mock" uses a deterministic offline generator
   * (great for demos and tests). Defaults to anthropic when an API key is present.
   */
  aiProvider: (process.env.AI_PROVIDER ??
    (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "anthropic" : "mock")) as
    | "anthropic"
    | "mock",
  defaultModel: process.env.AI_MODEL ?? "claude-opus-5-5",
  secureCookies: process.env.NODE_ENV === "production",
};
