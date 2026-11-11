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

export const ROLE_LIST: readonly Role[] = ["author", "editor", "owner"];
export const PERMISSION_LIST = [
  "article.create",
  "article.editAny",
  "article.publish",
  "article.delete",
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
    defaultTone: string;
    defaultLength: ArticleLength;
  };
}

export interface ArticleSummary {
  id: number;
  title: string;
  status: ArticleStatus;
  source: "human" | "ai";
  updatedAt: string;
}

export interface JobSummary {
  id: number;
  kind: "article" | "theme";
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
  seoDescription: string;
  tags: string[];
  status: ArticleStatus;
  source: "human" | "ai";
  aiPrompt: string | null;
  themeId: number | null;
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
  seoDescription?: string;
  markdown: string;
  tags?: string[] | string;
  status?: ArticleStatus;
  themeId?: number | null;
}

export interface JobDetail {
  id: number;
  kind: "article" | "theme";
  status: JobStatus;
  request: string;
  result: { message?: string; articleId?: number; slug?: string; status?: string; themeId?: number | null; applied?: boolean } | null;
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
}

export interface SettingsData {
  name: string;
  tagline: string;
  domain: string | null;
  ai: AiSettings;
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
  /** New key to store; omit/empty to keep the current one. */
  apiKey?: string;
  clearKey?: boolean;
}
