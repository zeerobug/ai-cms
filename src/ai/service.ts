import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import { blocksToMarkdown } from "../content/blocks.js";
import { IMAGE_ASPECTS, mediaUrl, sniffImage, type ImageAspect } from "../content/media.js";
import { cleanMeta, SEO_LIMITS, seoGaps, seoPatch, type SeoMode } from "../content/seo.js";
import type { ArticleImage, MediaRow, Repo, Tenant } from "../repo.js";
import { aiArticlePublishDecision, aiThemeApplyDecision, atLeast, parseSettings, type AiProviderName, type Role } from "../tenancy.js";
import { describePalette, parsePalette, type Palette } from "../themes/palette.js";
import { normalizeTheme } from "../themes/spec.js";
import { decryptSecret } from "../util/secrets.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import { articleImagePrompt, heroImagePrompt } from "./prompts.js";
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
  /** Also generate a cover image (needs an image-capable provider; skipped with a note otherwise). */
  coverImage: z.boolean().optional().default(false),
});
export type ArticleJobInput = z.input<typeof ArticleJobInput>;

export const ThemeJobInput = z.object({
  prompt: z.string().trim().min(3).max(2000),
  /** Apply to the live site immediately (still subject to site policy). */
  apply: z.boolean().optional().default(false),
  /** Theme to start from; defaults to the active theme. */
  baseThemeId: z.number().int().optional(),
  /** Also generate a hero image for the home page and switch the hero to the "image" style. */
  heroImage: z.boolean().optional().default(false),
  /**
   * Optional color palette to design with: raw text in any supported format (hex list, CSS
   * variables, JSON, GIMP .gpl, Coolors URL), a list of colors, or a role → color map.
   */
  palette: z
    .union([z.string().max(64 * 1024), z.array(z.string().max(100)).max(64), z.record(z.string().max(60), z.string().max(100))])
    .optional(),
});
export type ThemeJobInput = z.input<typeof ThemeJobInput>;

export const ImageJobInput = z.object({
  prompt: z.string().trim().min(3).max(2000),
  aspect: z.enum(IMAGE_ASPECTS as [ImageAspect, ...ImageAspect[]]).optional().default("landscape"),
  alt: z.string().max(300).optional(),
});
export type ImageJobInput = z.input<typeof ImageJobInput>;

export const SeoJobInput = z.discriminatedUnion("target", [
  /** One article. "replace" rewrites its metadata; "fill" only fills empty fields. */
  z.object({ target: z.literal("article"), articleId: z.number().int().positive(), mode: z.enum(["fill", "replace"]).optional().default("replace") }),
  /** Every published article with missing metadata (fill mode), up to MAX_BULK_SEO per run. */
  z.object({ target: z.literal("articles") }),
  /** The home page meta description (stored in the site's SEO settings). */
  z.object({ target: z.literal("site") }),
]);
export type SeoJobInput = z.input<typeof SeoJobInput>;
const MAX_BULK_SEO = 50;

/** Providers that implement generateImage (Claude only writes text). */
const IMAGE_PROVIDERS = new Set(["openai", "mock"]);

export interface Actor {
  userId: number | null;
  role: Role;
}

/**
 * Builds a provider instance. `apiKey` undefined = use the platform credentials
 * (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / profile, or OPENAI_API_KEY).
 */
export type ProviderFactory = (name: AiProviderName, apiKey: string | undefined) => AIProvider;

export const defaultProviderFactory: ProviderFactory = (name, apiKey) => {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(apiKey ? new Anthropic({ apiKey }) : undefined);
    case "openai":
      return new OpenAIProvider(apiKey ? new OpenAI({ apiKey }) : undefined);
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

  /**
   * Name of the provider that would generate this tenant's images, or null when none is available:
   * the tenant's provider if it can make images, else the platform OpenAI key (if configured).
   */
  imageProviderNameFor(t: Tenant): string | null {
    const name = this.providerNameFor(t);
    if (IMAGE_PROVIDERS.has(name)) return name;
    return config.platformOpenAiImages ? "openai" : null;
  }

  private imageProviderFor(t: Tenant): AIProvider {
    const p = this.providerFor(t);
    if (p.generateImage) return p;
    if (config.platformOpenAiImages) return this.factory("openai", undefined);
    throw new PolicyError(
      "AI images need an image-capable provider, and Claude only writes text. Choose OpenAI in Settings (or set OPENAI_API_KEY on the server), or upload an image instead.",
      409,
    );
  }

  private assertImageQuota(t: Tenant) {
    const limit = t.settings.ai.images.monthlyLimit;
    if (limit > 0 && this.repo.aiImagesThisMonth(t.id) >= limit) throw new PolicyError(`Monthly AI image limit (${limit}) reached.`, 429);
  }

  /** Generates an image and stores it in the tenant's media library. */
  private async makeImage(t: Tenant, actor: Actor, req: { prompt: string; aspect: ImageAspect; alt: string }) {
    this.assertImageQuota(t);
    const provider = this.imageProviderFor(t);
    const res = await provider.generateImage!({ prompt: req.prompt, aspect: req.aspect });
    // Provider output is untrusted too: store it only if it really is a supported raster image.
    const type = sniffImage(res.value.data);
    if (!type) throw new Error("The AI returned an image in an unsupported format.");
    const media = this.repo.createMedia(t.id, { data: res.value.data, type, alt: req.alt, source: "ai", prompt: req.prompt, userId: actor.userId });
    return { media, usage: res.usage };
  }

  /** Generate one image right away (the admin waits for it; image models take seconds, not minutes). */
  async generateImage(t: Tenant, actor: Actor, rawInput: ImageJobInput): Promise<MediaRow> {
    this.assertCanGenerate(t, actor);
    const input = ImageJobInput.parse(rawInput);
    const { media } = await this.makeImage(t, actor, { prompt: input.prompt, aspect: input.aspect, alt: input.alt ?? "" });
    return media;
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

  private assertSeoQuota(t: Tenant) {
    const limit = t.settings.ai.seo.monthlyLimit;
    if (limit > 0 && this.repo.aiJobsThisMonth(t.id, "seo") >= limit) throw new PolicyError(`Monthly AI SEO limit (${limit}) reached.`, 429);
  }

  /** Published articles that are missing SEO metadata. */
  articlesNeedingSeo(t: Tenant, limit = MAX_BULK_SEO) {
    return this.repo
      .articles(t.id, { status: "published", limit: 1000 })
      .filter((a) => seoGaps(this.repo.seoFields(a)).length)
      .slice(0, limit);
  }

  /**
   * Queue an SEO job. Callers check who may change the target (editing the article, editAny for
   * bulk runs, settings.manage for the site); this checks the site's AI policy and quota.
   */
  requestSeo(t: Tenant, actor: Actor, rawInput: SeoJobInput): number {
    this.assertCanGenerate(t, actor);
    const input = SeoJobInput.parse(rawInput);
    let label: string;
    if (input.target === "article") {
      const a = this.repo.article(t.id, input.articleId);
      if (!a) throw new PolicyError("Article not found.", 404);
      label = `SEO for “${a.title}”`;
    } else if (input.target === "articles") {
      const n = this.articlesNeedingSeo(t).length;
      if (!n) throw new PolicyError("Every published article already has its SEO metadata.", 409);
      label = `SEO for ${n} published article${n === 1 ? "" : "s"} with missing metadata`;
    } else {
      label = "SEO for the home page";
    }
    this.assertSeoQuota(t);
    const provider = this.providerFor(t);
    const jobId = this.repo.createJob(t.id, actor.userId, "seo", { ...input, label });
    this.start(jobId, () => this.runSeo(t, provider, input));
    return jobId;
  }

  /**
   * Called when an article gets published: if it lacks SEO metadata and the site allows it, queue a
   * "fill" job. Best effort: returns the job id, or null when skipped (policy, quota, nothing missing).
   */
  autoSeo(t: Tenant, actor: Actor, articleId: number): number | null {
    if (!t.settings.ai.enabled || !t.settings.ai.seo.autoOptimize) return null;
    const a = this.repo.article(t.id, articleId);
    if (!a || a.status !== "published" || !seoGaps(this.repo.seoFields(a)).length) return null;
    if (this.repo.seoJobPending(t.id, articleId)) return null;
    try {
      return this.requestSeo(t, actor, { target: "article", articleId, mode: "fill" });
    } catch (err) {
      if (!(err instanceof PolicyError)) console.error("[ai] auto SEO skipped:", err);
      return null;
    }
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

    let image: ArticleImage | null = null;
    let imageNote = "";
    if (input.coverImage) {
      // A missing cover shouldn't throw away a finished article: save it without one and say why.
      try {
        const alt = draft.value.title;
        const prompt = articleImagePrompt({ title: draft.value.title, summary: draft.value.summary, siteName: t.name });
        const res = await this.makeImage(t, actor, { prompt, aspect: "landscape", alt });
        usage.push(res.usage);
        image = { url: mediaUrl(t.slug, res.media.file), alt };
      } catch (err) {
        imageNote = ` Cover image skipped: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const decision = aiArticlePublishDecision(t.settings, actor.role, input.publish);
    const status = decision.publish ? "published" : input.publish ? "review" : "draft";
    const articleId = this.repo.createArticle(t.id, {
      title: draft.value.title,
      slug: draft.value.slug,
      summary: draft.value.summary,
      seoTitle: cleanMeta(draft.value.seoTitle, SEO_LIMITS.title),
      seoDescription: cleanMeta(draft.value.seoDescription, SEO_LIMITS.description),
      blocks: draft.value.blocks,
      tags: draft.value.tags,
      status,
      source: "ai",
      aiPrompt: input.topic + (input.instructions ? `\n\n${input.instructions}` : ""),
      themeId,
      authorId: actor.userId,
      image,
    });
    const slug = this.repo.article(t.id, articleId)!.slug;
    return { result: { articleId, slug, status, themeId, imageUrl: image?.url ?? null, message: decision.reason + imageNote }, usage };
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
    const usage = [res.usage];
    let imageNote = "";
    if (input.heroImage) {
      try {
        const img = await this.makeImage(t, actor, { prompt: heroImagePrompt(t, input.prompt), aspect: "landscape", alt: "" });
        usage.push(img.usage);
        spec.hero = { ...spec.hero, enabled: true, style: "image", imageUrl: mediaUrl(t.slug, img.media.file) };
      } catch (err) {
        imageNote = ` Hero image skipped: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const themeId = this.repo.createTheme(t.id, spec, "ai", palette ? `${input.prompt}\n\nPalette: ${describePalette(palette)}` : input.prompt);
    const decision = aiThemeApplyDecision(t.settings, actor.role, input.apply);
    if (decision.apply) this.repo.activateTheme(t.id, themeId);
    return { result: { themeId, applied: decision.apply, message: decision.reason + imageNote }, usage };
  }

  private async runSeo(t: Tenant, provider: AIProvider, input: z.output<typeof SeoJobInput>) {
    if (input.target === "site") return this.runSiteSeo(t, provider);
    if (input.target === "article") {
      const r = await this.optimizeArticle(t, provider, input.articleId, input.mode);
      const message = r.changed.length ? `Updated ${r.changed.join(", ")}.` : "The SEO metadata was already complete; nothing changed.";
      return { result: { message, articleId: input.articleId, slug: r.slug, changed: r.changed, focusKeyword: r.focusKeyword, suggestions: r.suggestions }, usage: r.usage };
    }
    // Bulk: one article at a time; a failure on one article doesn't stop the others.
    const usage: Usage[] = [];
    let optimized = 0;
    const failures: string[] = [];
    for (const a of this.articlesNeedingSeo(t)) {
      try {
        const r = await this.optimizeArticle(t, provider, a.id, "fill");
        usage.push(...r.usage);
        if (r.changed.length) optimized++;
      } catch (err) {
        failures.push(`“${a.title}”: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!optimized && failures.length) throw new Error(`SEO failed for every article. ${failures[0]}`);
    const message = `Filled in missing SEO metadata on ${optimized} article${optimized === 1 ? "" : "s"}.` + (failures.length ? ` Failed: ${failures.join("; ")}` : "");
    return { result: { message, optimized }, usage };
  }

  private async optimizeArticle(t: Tenant, provider: AIProvider, articleId: number, mode: SeoMode) {
    const row = this.repo.article(t.id, articleId);
    if (!row) throw new Error("The article no longer exists.");
    const view = this.repo.toView(row);
    const s = t.settings.ai;

    // The model can't see images: give it what we know about each (AI prompt, caption, current alt).
    const mediaPrefix = `/media/${t.slug}/`;
    const promptFor = (url: string) => (url.startsWith(mediaPrefix) ? this.repo.mediaPrompt(t.id, url.slice(mediaPrefix.length)) : null);
    const images = new Map<string, string[]>();
    const addImage = (url: string, ...hints: (string | null)[]) => {
      const ctx = images.get(url) ?? [];
      for (const h of hints) if (h?.trim()) ctx.push(h.trim());
      images.set(url, ctx);
    };
    if (view.image) addImage(view.image.url, "Cover image of the article.", promptFor(view.image.url) && `Generated from: ${promptFor(view.image.url)}`, view.image.alt && `Current alt: ${view.image.alt}`);
    for (const b of view.blocks) {
      if (b.type === "image") addImage(b.url, promptFor(b.url) && `Generated from: ${promptFor(b.url)}`, b.caption && `Caption: ${b.caption}`, b.alt && `Current alt: ${b.alt}`);
    }

    const others = this.repo.articles(t.id, { status: "published", limit: 30 }).filter((a) => a.id !== row.id).map((a) => a.title);
    const res = await provider.optimizeSeo({
      site: { name: t.name, tagline: t.tagline },
      language: s.articles.language,
      article: { title: row.title, summary: row.summary, tags: view.tags, markdown: blocksToMarkdown(view.blocks) },
      images: [...images].map(([url, ctx]) => ({ url, context: ctx.join(" ") })),
      otherTitles: others,
      siteTags: this.repo.publishedTags(t.id).slice(0, 60),
      model: s.model,
      effort: s.effort,
    });

    // Re-read after the (slow) AI call and patch only the SEO fields, so edits made meanwhile survive.
    const fresh = this.repo.article(t.id, articleId);
    if (!fresh) throw new Error("The article was deleted while the AI was working.");
    const patch = seoPatch(this.repo.seoFields(fresh), res.value, mode);
    if (patch.changed.length) this.repo.updateArticleSeo(t.id, articleId, patch);
    return {
      changed: patch.changed,
      slug: this.repo.article(t.id, articleId)!.slug,
      focusKeyword: cleanMeta(res.value.focusKeyword, 100),
      suggestions: res.value.suggestions.map((x) => cleanMeta(x, 400)).filter(Boolean).slice(0, 5),
      usage: [res.usage],
    };
  }

  private async runSiteSeo(t: Tenant, provider: AIProvider) {
    const s = t.settings.ai;
    const res = await provider.optimizeSiteSeo({
      site: { name: t.name, tagline: t.tagline },
      language: s.articles.language,
      currentDescription: t.settings.seo.description,
      recentTitles: this.repo.articles(t.id, { status: "published", limit: 30 }).map((a) => a.title),
      siteTags: this.repo.publishedTags(t.id).slice(0, 60),
      model: s.model,
      effort: s.effort,
    });
    const description = cleanMeta(res.value.description, SEO_LIMITS.description);
    if (!description) throw new Error("The AI returned an empty description.");
    // Settings may have been edited while the AI worked: change only this one field.
    const fresh = this.repo.tenantById(t.id);
    if (!fresh) throw new Error("The site no longer exists.");
    const settings = parseSettings(JSON.stringify({ ...fresh.settings, seo: { ...fresh.settings.seo, description } }));
    this.repo.updateTenantSettings(t.id, settings);
    const suggestions = res.value.suggestions.map((x) => cleanMeta(x, 400)).filter(Boolean).slice(0, 5);
    return { result: { message: "Home page description updated.", description, suggestions }, usage: [res.usage] };
  }
}
