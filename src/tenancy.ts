import { z } from "zod";
import { config } from "./config.js";

export const ROLES = ["author", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { author: 1, editor: 2, owner: 3 };

export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

/** Fixed permission matrix; AI-specific thresholds come from tenant settings. */
const PERMISSIONS = {
  "article.create": "author",
  "article.editAny": "editor",
  "article.publish": "editor",
  "article.delete": "editor",
  "media.delete": "editor",
  "design.manage": "editor",
  "settings.manage": "owner",
  "members.manage": "owner",
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, perm: Permission) => atLeast(role, PERMISSIONS[perm]);

// ---------------------------------------------------------------------------
// Per-tenant settings (the AI policy lives here)
// ---------------------------------------------------------------------------

const role = z.enum(ROLES);

/** LLM backends a tenant can choose. "default" (in settings) means the platform's configured provider. */
export const AI_PROVIDERS = ["anthropic", "openai", "mock"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const TenantSettingsSchema = z.object({
  ai: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Which LLM backend this site uses. "default" = the platform provider and key (AI_PROVIDER /
       * ANTHROPIC_API_KEY / OPENAI_API_KEY). A specific provider uses the site's own API key when one is stored
       * (kept encrypted outside these settings), else falls back to the platform key.
       */
      provider: z.enum(["default", ...AI_PROVIDERS]).default("default"),
      model: z.string().min(1).default(config.defaultModel),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
      /** Lowest role allowed to ask the AI for anything. */
      minRoleToGenerate: role.default("author"),
      articles: z
        .object({
          /** Master switch: may AI-written articles go live without human review? */
          autoPublish: z.boolean().default(false),
          /** Even with autoPublish on, only this role (or higher) can request direct publishing. */
          minRoleToAutoPublish: role.default("editor"),
          defaultTone: z.string().max(200).default("informative and engaging"),
          defaultLength: z.enum(["short", "medium", "long"]).default("medium"),
          language: z.string().max(60).default("English"),
          brandVoice: z.string().max(4000).default(""),
          /** Max AI articles per calendar month (0 = unlimited). */
          monthlyLimit: z.number().int().min(0).default(100),
        })
        .prefault({}),
      themes: z
        .object({
          /** May AI-designed themes be applied to the live site immediately? */
          autoApply: z.boolean().default(false),
          minRoleToAutoApply: role.default("editor"),
        })
        .prefault({}),
      images: z
        .object({
          /** Max AI-generated images per calendar month (0 = unlimited). */
          monthlyLimit: z.number().int().min(0).default(50),
        })
        .prefault({}),
      seo: z
        .object({
          /**
           * When an article is published with SEO metadata missing (search title, meta description,
           * image alt text, tags), let the AI fill in the gaps. Never overwrites what's already there.
           */
          autoOptimize: z.boolean().default(true),
          /** Max AI SEO jobs per calendar month (0 = unlimited). A bulk run counts as one job. */
          monthlyLimit: z.number().int().min(0).default(200),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Search-engine settings for the public site (used by the renderer, sitemap and robots.txt). */
  seo: z
    .object({
      /** Home page meta description ('' = use the tagline). The AI can write it. */
      description: z.string().max(300).default(""),
      /** BCP 47 language code of the site's content, for <html lang> and structured data. */
      lang: z
        .string()
        .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/)
        .default("en"),
      /** Allow search engines to index the site (off = robots.txt disallows all + noindex). */
      indexing: z.boolean().default(true),
    })
    .prefault({}),
});
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

export function parseSettings(json: string | null | undefined): TenantSettings {
  let raw: unknown = {};
  try {
    raw = JSON.parse(json || "{}");
  } catch {
    /* fall back to defaults */
  }
  const r = TenantSettingsSchema.safeParse(raw);
  return r.success ? r.data : TenantSettingsSchema.parse({});
}

/** Decide whether an AI article requested by `role` may be published right away. */
export function aiArticlePublishDecision(
  settings: TenantSettings,
  userRole: Role,
  requestedPublish: boolean,
): { publish: boolean; reason: string } {
  if (!requestedPublish) return { publish: false, reason: "Saved as draft for review (publishing not requested)." };
  if (!settings.ai.articles.autoPublish)
    return { publish: false, reason: "Sent to review: this site requires human review of AI articles." };
  if (!atLeast(userRole, settings.ai.articles.minRoleToAutoPublish))
    return { publish: false, reason: `Sent to review: only ${settings.ai.articles.minRoleToAutoPublish}s can auto-publish AI articles.` };
  return { publish: true, reason: "Published automatically (allowed by site settings)." };
}

export function aiThemeApplyDecision(
  settings: TenantSettings,
  userRole: Role,
  requestedApply: boolean,
): { apply: boolean; reason: string } {
  if (!requestedApply) return { apply: false, reason: "Saved as a new theme; not applied." };
  if (!settings.ai.themes.autoApply)
    return { apply: false, reason: "Saved but not applied: this site requires a human to apply AI themes." };
  if (!atLeast(userRole, settings.ai.themes.minRoleToAutoApply))
    return { apply: false, reason: `Saved but not applied: only ${settings.ai.themes.minRoleToAutoApply}s can auto-apply.` };
  return { apply: true, reason: "Applied to the live site (allowed by site settings)." };
}

/** Extract a tenant slug from a Host header using BASE_DOMAIN subdomains. */
export function slugFromHost(host: string | undefined): string | null {
  if (!host || !config.baseDomain) return null;
  const h = host.toLowerCase().split(":")[0];
  if (!h.endsWith("." + config.baseDomain)) return null;
  const sub = h.slice(0, -(config.baseDomain.length + 1));
  return /^[a-z0-9-]+$/.test(sub) && sub !== "www" ? sub : null;
}
