import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";
import type { Repo, Tenant } from "../repo.js";
import { aiArticlePublishDecision, aiThemeApplyDecision, atLeast, type AiProviderName, type Role } from "../tenancy.js";
import { describePalette, parsePalette, type Palette } from "../themes/palette.js";
import { normalizeTheme } from "../themes/spec.js";
import { decryptSecret } from "../util/secrets.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import type { AIProvider, Usage } from "./provider.js";

export class PolicyError extends Error {
  constructor(message: string, public status = 403) {
    super(message);
  }
}

export const ArticleJobInput = z.object({
  topic: z.string().trim().min(3).max(500),
  instructions: z.string().max(4000).optional().default(""),
  tone: z.string().max(200).optional(),
  length: z.enum(["short", "medium", "long"]).optional(),
  /** Ask for the article to go live immediately (still subject to site policy). */
  publish: z.boolean().optional().default(false),
  /** Also design a dedicated look for this article. true = let the AI decide; string = design brief. */
  designLook: z.union([z.boolean(), z.string().max(1000)]).optional().default(false),
});
export type ArticleJobInput = z.input<typeof ArticleJobInput>;

export const ThemeJobInput = z.object({
  prompt: z.string().trim().min(3).max(2000),
  /** Apply to the live site immediately (still subject to site policy). */
  apply: z.boolean().optional().default(false),
  /** Theme to start from; defaults to the active theme. */
  baseThemeId: z.number().int().optional(),
  /**
   * Optional color palette to design with: raw text in any supported format (hex list, CSS
   * variables, JSON, GIMP .gpl, Coolors URL), a list of colors, or a role → color map.
   */
  palette: z
    .union([z.string().max(64 * 1024), z.array(z.string().max(100)).max(64), z.record(z.string().max(60), z.string().max(100))])
    .optional(),
});
export type ThemeJobInput = z.input<typeof ThemeJobInput>;

export interface Actor {
  userId: number | null;
  role: Role;
}

/**
 * Builds a provider instance. `apiKey` undefined = use the platform credentials
 * (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / profile).
 */
export type ProviderFactory = (name: AiProviderName, apiKey: string | undefined) => AIProvider;

export const defaultProviderFactory: ProviderFactory = (name, apiKey) => {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(apiKey ? new Anthropic({ apiKey }) : undefined);
    case "mock":
      return new MockProvider(800);
  }
};

/** The platform default provider, from env configuration. */
export function createProvider(): AIProvider {
  return defaultProviderFactory(config.aiProvider, undefined);
}

/**
 * Orchestrates AI work for a tenant: checks policy, queues a job, runs it in the
 * background and stores the result (article / theme) according to tenant settings.
 */
export class AiService {
  private running = new Map<number, Promise<void>>();

  /**
   * @param provider platform default provider (used by tenants whose provider setting is "default")
   * @param factory  builds providers for tenants that pick a specific provider / their own key
   */
  constructor(
    private repo: Repo,
    public provider: AIProvider,
    private factory: ProviderFactory = defaultProviderFactory,
  ) {}

  /** Name of the provider a tenant's AI requests will use (no secrets are touched). */
  providerNameFor(t: Tenant): string {
    return t.settings.ai.provider === "default" ? this.provider.name : t.settings.ai.provider;
  }

  /**
   * Resolve the tenant's provider: "default" → platform provider and key; otherwise the chosen
   * provider with the tenant's own API key, falling back to the platform key when none is stored.
   */
  providerFor(t: Tenant): AIProvider {
    const choice = t.settings.ai.provider;
    if (choice === "default") return this.provider;
    const stored = this.repo.tenantAiKey(t.id);
    let apiKey: string | undefined;
    if (stored) {
      const plain = decryptSecret(stored);
      if (plain === null)
        throw new PolicyError("This site's stored AI API key can't be decrypted (APP_SECRET changed?). Re-enter it in Settings.", 409);
      apiKey = plain;
    }
    return this.factory(choice, apiKey);
  }

  /** Await a job (used by `?wait=1` in the API and by tests). */
  wait(jobId: number) {
    return this.running.get(jobId) ?? Promise.resolve();
  }

  private assertCanGenerate(t: Tenant, actor: Actor) {
    if (!t.settings.ai.enabled) throw new PolicyError("AI features are disabled for this site.");
    if (!atLeast(actor.role, t.settings.ai.minRoleToGenerate))
      throw new PolicyError(`Only ${t.settings.ai.minRoleToGenerate}s and above can use AI on this site.`);
  }

  requestArticle(t: Tenant, actor: Actor, rawInput: ArticleJobInput): number {
    this.assertCanGenerate(t, actor);
    const input = ArticleJobInput.parse(rawInput);
    const limit = t.settings.ai.articles.monthlyLimit;
    if (limit > 0 && this.repo.aiArticlesThisMonth(t.id) >= limit)
      throw new PolicyError(`Monthly AI article limit (${limit}) reached.`, 429);
    const provider = this.providerFor(t);
    const jobId = this.repo.createJob(t.id, actor.userId, "article", input);
    this.start(jobId, () => this.runArticle(t, actor, provider, input));
    return jobId;
  }

  requestTheme(t: Tenant, actor: Actor, rawInput: ThemeJobInput): number {
    this.assertCanGenerate(t, actor);
    const { palette: rawPalette, ...input } = ThemeJobInput.parse(rawInput);
    let palette: Palette | undefined;
    if (rawPalette !== undefined && (typeof rawPalette !== "string" || rawPalette.trim())) {
      palette = parsePalette(rawPalette);
      if (!palette.colors.length) throw new PolicyError("No colors found in the palette. Use values like #1d3557, rgb(29, 53, 87) or a palette file.", 400);
    }
    const provider = this.providerFor(t);
    const jobId = this.repo.createJob(t.id, actor.userId, "theme", { ...input, palette });
    this.start(jobId, () => this.runTheme(t, actor, provider, input, palette));
    return jobId;
  }

  private start(jobId: number, fn: () => Promise<{ result: unknown; usage: Usage[] }>) {
    const p = (async () => {
      this.repo.setJobRunning(jobId);
      try {
        const { result, usage } = await fn();
        this.repo.finishJob(jobId, true, { result, usage });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ai] job ${jobId} failed:`, message);
        this.repo.finishJob(jobId, false, { error: message });
      } finally {
        this.running.delete(jobId);
      }
    })();
    this.running.set(jobId, p);
  }

  private async runArticle(t: Tenant, actor: Actor, provider: AIProvider, input: z.output<typeof ArticleJobInput>) {
    const s = t.settings.ai;
    const usage: Usage[] = [];
    const existing = this.repo.articles(t.id, { status: "published", limit: 30 }).map((a) => a.title);

    const draft = await provider.writeArticle({
      topic: input.topic,
      instructions: input.instructions,
      tone: input.tone || s.articles.defaultTone,
      length: input.length || s.articles.defaultLength,
      language: s.articles.language,
      brandVoice: s.articles.brandVoice,
      site: { name: t.name, tagline: t.tagline },
      existingTitles: existing,
      model: s.model,
      effort: s.effort,
    });
    usage.push(draft.usage);

    let themeId: number | null = null;
    if (input.designLook) {
      const brief =
        typeof input.designLook === "string" && input.designLook.trim()
          ? input.designLook
          : `Design a distinctive look for a single article page titled "${draft.value.title}" (topic: ${input.topic}). Keep it readable.`;
      const current = this.repo.activeTheme(t);
      const theme = await provider.designTheme({ prompt: brief, site: t, current, model: s.model, effort: s.effort });
      usage.push(theme.usage);
      const spec = normalizeTheme(theme.value, current);
      themeId = this.repo.createTheme(t.id, spec, "ai", brief);
    }

    const decision = aiArticlePublishDecision(t.settings, actor.role, input.publish);
    const status = decision.publish ? "published" : input.publish ? "review" : "draft";
    const articleId = this.repo.createArticle(t.id, {
      title: draft.value.title,
      summary: draft.value.summary,
      seoDescription: draft.value.seoDescription,
      blocks: draft.value.blocks,
      tags: draft.value.tags,
      status,
      source: "ai",
      aiPrompt: input.topic + (input.instructions ? `\n\n${input.instructions}` : ""),
      themeId,
      authorId: actor.userId,
    });
    const slug = this.repo.article(t.id, articleId)!.slug;
    return { result: { articleId, slug, status, themeId, message: decision.reason }, usage };
  }

  private async runTheme(
    t: Tenant,
    actor: Actor,
    provider: AIProvider,
    input: Omit<z.output<typeof ThemeJobInput>, "palette">,
    palette?: Palette,
  ) {
    const s = t.settings.ai;
    const baseRow = input.baseThemeId ? this.repo.theme(t.id, input.baseThemeId) : undefined;
    const current = baseRow ? this.repo.themeSpec(baseRow) : this.repo.activeTheme(t);
    const res = await provider.designTheme({ prompt: input.prompt, site: t, current, palette, model: s.model, effort: s.effort });
    const spec = normalizeTheme(res.value, current);
    // Colors the user pinned to a role are a hard requirement, whatever the model returned.
    if (palette) Object.assign(spec.colors, palette.roles);
    const themeId = this.repo.createTheme(t.id, spec, "ai", palette ? `${input.prompt}\n\nPalette: ${describePalette(palette)}` : input.prompt);
    const decision = aiThemeApplyDecision(t.settings, actor.role, input.apply);
    if (decision.apply) this.repo.activateTheme(t.id, themeId);
    return { result: { themeId, applied: decision.apply, message: decision.reason }, usage: [res.usage] };
  }
}
