/**
 * JSON contract between the admin API (src/web/admin-api.ts) and the React admin (admin/).
 * Keep this file free of imports so the browser bundle can `import type` it without pulling in
 * server code. The server assigns its own types to these, so drift fails `tsc` on the server side.
 */

export type Role = "author" | "editor" | "owner";
export type ArticleStatus = "draft" | "review" | "published";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ArticleLength = "short" | "medium" | "long";
export type JobKind = "article" | "theme" | "seo";

export const ROLE_LIST: readonly Role[] = ["author", "editor", "owner"];
export const PERMISSION_LIST = [
  "article.create",
  "article.editAny",
  "article.publish",
  "article.delete",
  "media.delete",
  "design.manage",
  "settings.manage",
  "members.manage",
] as const;
export type Permission = (typeof PERMISSION_LIST)[number];

export interface ApiError {
  error: string;
}

export interface SessionInfo {
  user: { id: number; email: string; name: string } | null;
  csrf: string | null;
}

export interface SiteSummary {
  slug: string;
  name: string;
  role: Role;
}

export interface TenantInfo {
  slug: string;
  name: string;
  tagline: string;
  role: Role;
  can: Record<Permission, boolean>;
  ai: {
    enabled: boolean;
    /** Effective provider name for this site ("anthropic", "mock", …). */
    provider: string;
    canAutoPublish: boolean;
    canAutoApply: boolean;
    /** Provider that generates images for this site, or null if AI images aren't available. */
    imageProvider: string | null;
    defaultTone: string;
    defaultLength: ArticleLength;
    /** AI fills in missing SEO metadata when an article is published. */
    seoAuto: boolean;
  };
}

export interface ArticleSummary {
  id: number;
  title: string;
  status: ArticleStatus;
  source: "human" | "ai";
  updatedAt: string;
  /** Published but missing search-engine metadata (title, description, tags or alt text). */
  seoMissing: boolean;
}

export interface JobSummary {
  id: number;
  kind: JobKind;
  request: string;
  status: JobStatus;
  error: string | null;
  createdAt: string;
}

export interface Dashboard {
  recentArticles: ArticleSummary[];
  jobs: JobSummary[];
}

export interface ArticleDetail {
  /** null for a new article. */
  id: number | null;
  title: string;
  slug: string;
  summary: string;
  /** Title tag for search results ('' = the title). */
  seoTitle: string;
  seoDescription: string;
  tags: string[];
  status: ArticleStatus;
  source: "human" | "ai";
  aiPrompt: string | null;
  themeId: number | null;
  /** Cover image URL ('' = none). */
  imageUrl: string;
  imageAlt: string;
  markdown: string;
  editable: boolean;
  /** Statuses this user may pick in the editor. */
  statuses: ArticleStatus[];
  themes: { id: number; name: string }[];
}

export interface ArticleInput {
  title: string;
  slug?: string;
  summary?: string;
  seoTitle?: string;
  seoDescription?: string;
  markdown: string;
  tags?: string[] | string;
  status?: ArticleStatus;
  themeId?: number | null;
  /** https URL or /media/... path; empty = no cover image. */
  imageUrl?: string;
  imageAlt?: string;
}

export type ImageAspect = "landscape" | "square" | "portrait";

/** An image in the site's media library (uploaded or AI-generated). */
export interface MediaItem {
  id: number;
  url: string;
  alt: string;
  source: "upload" | "ai";
  prompt: string | null;
  size: number;
  createdAt: string;
}

export interface ImageGenerateInput {
  prompt: string;
  aspect?: ImageAspect;
  alt?: string;
}

export interface JobDetail {
  id: number;
  kind: JobKind;
  status: JobStatus;
  request: string;
  result: {
    message?: string;
    articleId?: number;
    slug?: string;
    status?: string;
    themeId?: number | null;
    applied?: boolean;
    imageUrl?: string | null;
    /** SEO jobs: what changed, the keyword chosen, and advice for the editor. */
    changed?: string[];
    focusKeyword?: string;
    suggestions?: string[];
    /** Site SEO job: the new home page description. */
    description?: string;
    /** Bulk SEO job: how many articles were updated. */
    optimized?: number;
  } | null;
  error: string | null;
  usage: { model: string; inputTokens: number; outputTokens: number }[] | null;
}

export interface ThemeSummary {
  id: number;
  name: string;
  source: "preset" | "manual" | "ai";
  prompt: string | null;
  active: boolean;
  swatch: string[];
  description: string;
}

export interface ThemeDetail {
  id: number;
  name: string;
  spec: unknown;
  /** The hero image ('' = none). */
  heroImageUrl: string;
}

export interface AiSettings {
  enabled: boolean;
  provider: string;
  model: string;
  effort: Effort;
  minRoleToGenerate: Role;
  articles: {
    autoPublish: boolean;
    minRoleToAutoPublish: Role;
    defaultTone: string;
    defaultLength: ArticleLength;
    language: string;
    brandVoice: string;
    monthlyLimit: number;
  };
  themes: { autoApply: boolean; minRoleToAutoApply: Role };
  images: { monthlyLimit: number };
  seo: { autoOptimize: boolean; monthlyLimit: number };
}

/** Search-engine settings of the public site. */
export interface SeoSettings {
  /** Home page meta description ('' = the tagline). */
  description: string;
  /** BCP 47 language code, e.g. "en", "fr-CA". */
  lang: string;
  indexing: boolean;
}

/** POST /t/:tenant/ai/seo */
export type SeoRequestInput =
  | { target: "article"; articleId: number; mode?: "fill" | "replace" }
  | { target: "articles" }
  | { target: "site" };

export interface SettingsData {
  name: string;
  tagline: string;
  domain: string | null;
  ai: AiSettings;
  seo: SeoSettings;
  /** Public URLs of the sitemap and robots.txt. */
  sitemapUrl: string;
  robotsUrl: string;
  /** Published articles missing SEO metadata. */
  seoMissing: number;
  /** Provider choices: "default" plus concrete providers. */
  providers: { value: string; label: string }[];
  platformProvider: string;
  apiKey: { stored: boolean; masked: string | null; unreadable: boolean };
  members: { id: number; email: string; name: string; role: Role }[];
  tokens: { id: number; name: string; role: Role; created_at: string }[];
  currentUserId: number;
}

export interface SettingsInput {
  name: string;
  tagline: string;
  domain: string | null;
  ai: AiSettings;
  seo: SeoSettings;
  /** New key to store; omit/empty to keep the current one. */
  apiKey?: string;
  clearKey?: boolean;
}
