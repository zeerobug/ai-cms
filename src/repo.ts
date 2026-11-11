import crypto from "node:crypto";
import { BlocksSchema, slugify, type Block } from "./content/blocks.js";
import type { ImageType } from "./content/media.js";
import type { SeoFields } from "./content/seo.js";
import { all, one, run, type DB } from "./db.js";
import { parseSettings, type Role, type TenantSettings } from "./tenancy.js";
import { DEFAULT_THEME, normalizeTheme, PRESETS, type ThemeSpec } from "./themes/spec.js";
import type { ArticleView } from "./themes/render.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface TenantRow {
  id: number;
  slug: string;
  name: string;
  tagline: string;
  domain: string | null;
  settings: string;
  active_theme_id: number | null;
  /** Encrypted per-tenant LLM API key (see util/secrets.ts). Never leaves the repo/AI service. */
  ai_api_key: string | null;
}
export interface Tenant extends Omit<TenantRow, "settings" | "ai_api_key"> {
  settings: TenantSettings;
  /** Whether the tenant has its own LLM API key stored. */
  hasAiKey: boolean;
}
export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  is_superadmin: number;
}
export interface ArticleRow {
  id: number;
  tenant_id: number;
  slug: string;
  title: string;
  summary: string;
  seo_description: string;
  /** Title tag for search results ('' = the article title). */
  seo_title: string;
  blocks: string;
  tags: string;
  status: "draft" | "review" | "published";
  source: "human" | "ai";
  ai_prompt: string | null;
  theme_id: number | null;
  author_id: number | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  /** Cover image URL ('' = none) and alt text. */
  image_url: string;
  image_alt: string;
}
export interface ThemeRow {
  id: number;
  tenant_id: number;
  name: string;
  spec: string;
  source: "preset" | "manual" | "ai";
  prompt: string | null;
  created_at: string;
}
export interface JobRow {
  id: number;
  tenant_id: number;
  user_id: number | null;
  kind: "article" | "theme" | "seo";
  input: string;
  status: "queued" | "running" | "succeeded" | "failed";
  result: string | null;
  error: string | null;
  usage: string | null;
  created_at: string;
  finished_at: string | null;
}

/** A media row without its bytes. */
export interface MediaRow {
  id: number;
  tenant_id: number;
  file: string;
  mime: string;
  size: number;
  alt: string;
  source: "upload" | "ai";
  prompt: string | null;
  created_at: string;
}
const MEDIA_COLS = "id, tenant_id, file, mime, size, alt, source, prompt, created_at";

/** Cover image of an article. */
export interface ArticleImage {
  url: string;
  alt: string;
}

export class Repo {
  constructor(public db: DB) {}

  // ---- tenants -------------------------------------------------------------

  private hydrate(row: TenantRow | undefined): Tenant | undefined {
    if (!row) return undefined;
    const { ai_api_key, settings, ...rest } = row;
    return { ...rest, settings: parseSettings(settings), hasAiKey: !!ai_api_key };
  }
  tenantBySlug(slug: string) {
    return this.hydrate(one<TenantRow>(this.db, "SELECT * FROM tenants WHERE slug = ?", slug));
  }
  tenantByDomain(domain: string) {
    return this.hydrate(one<TenantRow>(this.db, "SELECT * FROM tenants WHERE domain = ?", domain.toLowerCase()));
  }
  tenantById(id: number) {
    return this.hydrate(one<TenantRow>(this.db, "SELECT * FROM tenants WHERE id = ?", id));
  }

  createTenant(input: { slug: string; name: string; tagline?: string; ownerId?: number }): Tenant {
    const slug = slugify(input.slug);
    const r = run(this.db, "INSERT INTO tenants (slug, name, tagline) VALUES (?, ?, ?)", slug, input.name, input.tagline ?? "");
    const tenantId = Number(r.lastInsertRowid);
    // Seed every tenant with the preset themes; first preset is active.
    let first: number | null = null;
    for (const p of PRESETS) {
      const id = this.createTheme(tenantId, p, "preset");
      first ??= id;
    }
    run(this.db, "UPDATE tenants SET active_theme_id = ? WHERE id = ?", first, tenantId);
    if (input.ownerId) this.setMembership(input.ownerId, tenantId, "owner");
    return this.tenantById(tenantId)!;
  }

  updateTenantSettings(id: number, settings: TenantSettings) {
    run(this.db, "UPDATE tenants SET settings = ? WHERE id = ?", JSON.stringify(settings), id);
  }

  updateTenant(id: number, patch: { name: string; tagline: string; domain: string | null; settings: TenantSettings }) {
    run(
      this.db,
      "UPDATE tenants SET name = ?, tagline = ?, domain = ?, settings = ? WHERE id = ?",
      patch.name,
      patch.tagline,
      patch.domain ? patch.domain.toLowerCase() : null,
      JSON.stringify(patch.settings),
      id,
    );
  }

  /** Encrypted API key for the tenant's LLM provider, or null. */
  tenantAiKey(tenantId: number): string | null {
    return one<{ ai_api_key: string | null }>(this.db, "SELECT ai_api_key FROM tenants WHERE id = ?", tenantId)?.ai_api_key ?? null;
  }
  setTenantAiKey(tenantId: number, encrypted: string | null) {
    run(this.db, "UPDATE tenants SET ai_api_key = ? WHERE id = ?", encrypted, tenantId);
  }

  tenantsForUser(userId: number) {
    return all<Omit<TenantRow, "ai_api_key"> & { role: Role }>(
      this.db,
      "SELECT t.id, t.slug, t.name, t.tagline, t.domain, t.settings, t.active_theme_id, m.role FROM tenants t JOIN memberships m ON m.tenant_id = t.id WHERE m.user_id = ? ORDER BY t.name",
      userId,
    );
  }

  // ---- users & memberships -------------------------------------------------

  userByEmail(email: string) {
    return one<UserRow>(this.db, "SELECT * FROM users WHERE email = ?", email.toLowerCase().trim());
  }
  userById(id: number) {
    return one<UserRow>(this.db, "SELECT * FROM users WHERE id = ?", id);
  }
  createUser(email: string, name: string, passwordHash: string, superadmin = false) {
    const r = run(
      this.db,
      "INSERT INTO users (email, name, password_hash, is_superadmin) VALUES (?, ?, ?, ?)",
      email.toLowerCase().trim(),
      name,
      passwordHash,
      superadmin ? 1 : 0,
    );
    return Number(r.lastInsertRowid);
  }
  roleFor(userId: number, tenantId: number): Role | null {
    const m = one<{ role: Role }>(this.db, "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?", userId, tenantId);
    if (m) return m.role;
    const u = this.userById(userId);
    return u?.is_superadmin ? "owner" : null;
  }
  setMembership(userId: number, tenantId: number, role: Role) {
    run(
      this.db,
      "INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role",
      userId,
      tenantId,
      role,
    );
  }
  removeMembership(userId: number, tenantId: number) {
    run(this.db, "DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?", userId, tenantId);
  }
  members(tenantId: number) {
    return all<{ id: number; email: string; name: string; role: Role }>(
      this.db,
      "SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY u.email",
      tenantId,
    );
  }

  // ---- sessions ------------------------------------------------------------

  createSession(userId: number, days = 14) {
    const id = crypto.randomBytes(32).toString("base64url");
    run(this.db, "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', ?))", id, userId, `+${days} days`);
    return id;
  }
  sessionUser(id: string) {
    return one<UserRow>(
      this.db,
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime('now')",
      id,
    );
  }
  deleteSession(id: string) {
    run(this.db, "DELETE FROM sessions WHERE id = ?", id);
  }

  // ---- API tokens ----------------------------------------------------------

  createApiToken(tenantId: number, name: string, role: Role) {
    const token = "cms_" + crypto.randomBytes(24).toString("base64url");
    run(this.db, "INSERT INTO api_tokens (tenant_id, name, token_hash, role) VALUES (?, ?, ?, ?)", tenantId, name, sha256(token), role);
    return token;
  }
  apiToken(token: string) {
    return one<{ id: number; tenant_id: number; name: string; role: Role }>(
      this.db,
      "SELECT id, tenant_id, name, role FROM api_tokens WHERE token_hash = ?",
      sha256(token),
    );
  }
  apiTokens(tenantId: number) {
    return all<{ id: number; name: string; role: Role; created_at: string }>(
      this.db,
      "SELECT id, name, role, created_at FROM api_tokens WHERE tenant_id = ? ORDER BY id DESC",
      tenantId,
    );
  }
  deleteApiToken(tenantId: number, id: number) {
    run(this.db, "DELETE FROM api_tokens WHERE tenant_id = ? AND id = ?", tenantId, id);
  }

  // ---- themes --------------------------------------------------------------

  createTheme(tenantId: number, spec: ThemeSpec, source: ThemeRow["source"], prompt?: string) {
    const r = run(
      this.db,
      "INSERT INTO themes (tenant_id, name, spec, source, prompt) VALUES (?, ?, ?, ?, ?)",
      tenantId,
      spec.name,
      JSON.stringify(spec),
      source,
      prompt ?? null,
    );
    return Number(r.lastInsertRowid);
  }
  updateTheme(tenantId: number, id: number, spec: ThemeSpec) {
    run(this.db, "UPDATE themes SET name = ?, spec = ? WHERE tenant_id = ? AND id = ?", spec.name, JSON.stringify(spec), tenantId, id);
  }
  theme(tenantId: number, id: number) {
    return one<ThemeRow>(this.db, "SELECT * FROM themes WHERE tenant_id = ? AND id = ?", tenantId, id);
  }
  themes(tenantId: number) {
    return all<ThemeRow>(this.db, "SELECT * FROM themes WHERE tenant_id = ? ORDER BY id DESC", tenantId);
  }
  deleteTheme(tenantId: number, id: number) {
    run(this.db, "DELETE FROM themes WHERE tenant_id = ? AND id = ?", tenantId, id);
  }
  activateTheme(tenantId: number, id: number) {
    run(this.db, "UPDATE tenants SET active_theme_id = ? WHERE id = ?", id, tenantId);
  }
  themeSpec(row: ThemeRow | undefined): ThemeSpec {
    if (!row) return DEFAULT_THEME;
    try {
      return normalizeTheme(JSON.parse(row.spec), DEFAULT_THEME);
    } catch {
      return DEFAULT_THEME;
    }
  }
  activeTheme(t: Tenant): ThemeSpec {
    return this.themeSpec(t.active_theme_id ? this.theme(t.id, t.active_theme_id) : undefined);
  }

  // ---- articles ------------------------------------------------------------

  uniqueSlug(tenantId: number, base: string, exceptId?: number) {
    const root = slugify(base);
    let slug = root;
    for (let n = 2; ; n++) {
      const hit = one<{ id: number }>(this.db, "SELECT id FROM articles WHERE tenant_id = ? AND slug = ?", tenantId, slug);
      if (!hit || hit.id === exceptId) return slug;
      slug = `${root}-${n}`;
    }
  }

  createArticle(
    tenantId: number,
    a: {
      title: string;
      slug?: string;
      summary?: string;
      seoTitle?: string;
      seoDescription?: string;
      blocks: Block[];
      tags?: string[];
      status: ArticleRow["status"];
      source: ArticleRow["source"];
      aiPrompt?: string;
      themeId?: number | null;
      authorId?: number | null;
      image?: ArticleImage | null;
    },
  ) {
    const slug = this.uniqueSlug(tenantId, a.slug || a.title);
    const r = run(
      this.db,
      `INSERT INTO articles (tenant_id, slug, title, summary, seo_title, seo_description, blocks, tags, status, source, ai_prompt, theme_id, author_id, image_url, image_alt, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${a.status === "published" ? "datetime('now')" : "NULL"})`,
      tenantId,
      slug,
      a.title,
      a.summary ?? "",
      a.seoTitle ?? "",
      a.seoDescription ?? "",
      JSON.stringify(a.blocks),
      JSON.stringify(normalizeTags(a.tags ?? [])),
      a.status,
      a.source,
      a.aiPrompt ?? null,
      a.themeId ?? null,
      a.authorId ?? null,
      a.image?.url ?? "",
      a.image?.alt ?? "",
    );
    return Number(r.lastInsertRowid);
  }

  updateArticle(
    tenantId: number,
    id: number,
    a: {
      title: string;
      slug: string;
      summary: string;
      seoTitle: string;
      seoDescription: string;
      blocks: Block[];
      tags: string[];
      status: ArticleRow["status"];
      themeId: number | null;
      image: ArticleImage | null;
    },
  ) {
    const slug = this.uniqueSlug(tenantId, a.slug || a.title, id);
    run(
      this.db,
      `UPDATE articles SET title = ?, slug = ?, summary = ?, seo_title = ?, seo_description = ?, blocks = ?, tags = ?, status = ?, theme_id = ?, image_url = ?, image_alt = ?,
         published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, datetime('now')) ELSE NULL END,
         updated_at = datetime('now')
       WHERE tenant_id = ? AND id = ?`,
      a.title,
      slug,
      a.summary,
      a.seoTitle,
      a.seoDescription,
      JSON.stringify(a.blocks),
      JSON.stringify(normalizeTags(a.tags)),
      a.status,
      a.themeId,
      a.image?.url ?? "",
      a.image?.alt ?? "",
      a.status,
      tenantId,
      id,
    );
  }

  /** Updates only the SEO metadata of an article (alt text lives in the blocks and the cover). */
  updateArticleSeo(
    tenantId: number,
    id: number,
    p: { seoTitle: string; seoDescription: string; tags: string[]; slug: string; imageAlt: string; blocks: Block[] },
  ) {
    const slug = this.uniqueSlug(tenantId, p.slug, id);
    run(
      this.db,
      `UPDATE articles SET seo_title = ?, seo_description = ?, tags = ?, slug = ?, image_alt = ?, blocks = ?, updated_at = datetime('now')
       WHERE tenant_id = ? AND id = ?`,
      p.seoTitle,
      p.seoDescription,
      JSON.stringify(normalizeTags(p.tags)),
      slug,
      p.imageAlt,
      JSON.stringify(p.blocks),
      tenantId,
      id,
    );
  }

  /** The SEO-relevant fields of an article (see content/seo.ts). */
  seoFields(row: ArticleRow): SeoFields {
    const v = this.toView(row);
    return {
      status: row.status,
      slug: row.slug,
      seoTitle: row.seo_title,
      seoDescription: row.seo_description,
      tags: v.tags,
      imageUrl: row.image_url,
      imageAlt: row.image_alt,
      blocks: v.blocks,
    };
  }

  /** Every tag used by published articles (for the sitemap). */
  publishedTags(tenantId: number) {
    return all<{ value: string }>(
      this.db,
      "SELECT DISTINCT j.value FROM articles a, json_each(a.tags) j WHERE a.tenant_id = ? AND a.status = 'published' ORDER BY j.value",
      tenantId,
    ).map((r) => r.value);
  }

  setArticleStatus(tenantId: number, id: number, status: ArticleRow["status"]) {
    run(
      this.db,
      `UPDATE articles SET status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, datetime('now')) ELSE NULL END,
       updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`,
      status,
      status,
      tenantId,
      id,
    );
  }
  deleteArticle(tenantId: number, id: number) {
    run(this.db, "DELETE FROM articles WHERE tenant_id = ? AND id = ?", tenantId, id);
  }
  article(tenantId: number, id: number) {
    return one<ArticleRow>(this.db, "SELECT * FROM articles WHERE tenant_id = ? AND id = ?", tenantId, id);
  }
  publishedArticle(tenantId: number, slug: string) {
    return one<ArticleRow>(this.db, "SELECT * FROM articles WHERE tenant_id = ? AND slug = ? AND status = 'published'", tenantId, slug);
  }
  articles(tenantId: number, opts: { status?: ArticleRow["status"]; tag?: string; limit?: number } = {}) {
    const where = ["tenant_id = ?"];
    const params: (string | number)[] = [tenantId];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(articles.tags) WHERE value = ?)");
      params.push(opts.tag);
    }
    params.push(opts.limit ?? 200);
    return all<ArticleRow>(
      this.db,
      `SELECT * FROM articles WHERE ${where.join(" AND ")} ORDER BY COALESCE(published_at, updated_at) DESC, id DESC LIMIT ?`,
      ...params,
    );
  }
  aiArticlesThisMonth(tenantId: number) {
    return (
      one<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM ai_jobs WHERE tenant_id = ? AND kind = 'article' AND status != 'failed' AND created_at >= datetime('now', 'start of month')",
        tenantId,
      )?.n ?? 0
    );
  }

  toView(row: ArticleRow): ArticleView {
    let blocks: Block[] = [];
    try {
      const parsed = BlocksSchema.safeParse(JSON.parse(row.blocks));
      if (parsed.success) blocks = parsed.data;
    } catch {
      /* corrupt row: render empty */
    }
    return {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      seoTitle: row.seo_title,
      seoDescription: row.seo_description,
      blocks,
      tags: safeJson<string[]>(row.tags, []),
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
      source: row.source,
      image: row.image_url ? { url: row.image_url, alt: row.image_alt } : null,
    };
  }

  // ---- media ---------------------------------------------------------------

  createMedia(
    tenantId: number,
    m: { data: Uint8Array; type: ImageType; alt: string; source: MediaRow["source"]; prompt?: string | null; userId?: number | null },
  ): MediaRow {
    const file = `${crypto.randomBytes(12).toString("base64url")}.${m.type.ext}`;
    const r = run(
      this.db,
      "INSERT INTO media (tenant_id, file, mime, size, data, alt, source, prompt, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      tenantId,
      file,
      m.type.mime,
      m.data.byteLength,
      m.data,
      m.alt.slice(0, 300),
      m.source,
      m.prompt ?? null,
      m.userId ?? null,
    );
    return this.media(tenantId, Number(r.lastInsertRowid))!;
  }
  media(tenantId: number, id: number) {
    return one<MediaRow>(this.db, `SELECT ${MEDIA_COLS} FROM media WHERE tenant_id = ? AND id = ?`, tenantId, id);
  }
  mediaList(tenantId: number, limit = 60) {
    return all<MediaRow>(this.db, `SELECT ${MEDIA_COLS} FROM media WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`, tenantId, limit);
  }
  /** Bytes of a media file, looked up by its public URL parts (tenant slug + file). */
  mediaFile(tenantSlug: string, file: string) {
    return one<{ mime: string; data: Uint8Array }>(
      this.db,
      "SELECT m.mime, m.data FROM media m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = ? AND m.file = ?",
      tenantSlug,
      file,
    );
  }
  deleteMedia(tenantId: number, id: number) {
    run(this.db, "DELETE FROM media WHERE tenant_id = ? AND id = ?", tenantId, id);
  }
  /** AI-generated image prompt for one of the tenant's media files, used as context for alt text. */
  mediaPrompt(tenantId: number, file: string) {
    return one<{ prompt: string | null }>(this.db, "SELECT prompt FROM media WHERE tenant_id = ? AND file = ?", tenantId, file)?.prompt ?? null;
  }
  aiImagesThisMonth(tenantId: number) {
    return (
      one<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM media WHERE tenant_id = ? AND source = 'ai' AND created_at >= datetime('now', 'start of month')",
        tenantId,
      )?.n ?? 0
    );
  }

  // ---- AI jobs -------------------------------------------------------------

  createJob(tenantId: number, userId: number | null, kind: JobRow["kind"], input: unknown) {
    const r = run(this.db, "INSERT INTO ai_jobs (tenant_id, user_id, kind, input) VALUES (?, ?, ?, ?)", tenantId, userId, kind, JSON.stringify(input));
    return Number(r.lastInsertRowid);
  }
  job(tenantId: number, id: number) {
    return one<JobRow>(this.db, "SELECT * FROM ai_jobs WHERE tenant_id = ? AND id = ?", tenantId, id);
  }
  jobs(tenantId: number, limit = 20) {
    return all<JobRow>(this.db, "SELECT * FROM ai_jobs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?", tenantId, limit);
  }
  aiJobsThisMonth(tenantId: number, kind: JobRow["kind"]) {
    return (
      one<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM ai_jobs WHERE tenant_id = ? AND kind = ? AND status != 'failed' AND created_at >= datetime('now', 'start of month')",
        tenantId,
        kind,
      )?.n ?? 0
    );
  }
  /** Whether an SEO job for this article (or a bulk run) is queued or running. */
  seoJobPending(tenantId: number, articleId: number) {
    return !!one(
      this.db,
      `SELECT 1 FROM ai_jobs WHERE tenant_id = ? AND kind = 'seo' AND status IN ('queued','running')
         AND (json_extract(input, '$.articleId') = ? OR json_extract(input, '$.target') = 'articles')`,
      tenantId,
      articleId,
    );
  }
  setJobRunning(id: number) {
    run(this.db, "UPDATE ai_jobs SET status = 'running' WHERE id = ?", id);
  }
  finishJob(id: number, ok: boolean, payload: { result?: unknown; error?: string; usage?: unknown }) {
    run(
      this.db,
      "UPDATE ai_jobs SET status = ?, result = ?, error = ?, usage = ?, finished_at = datetime('now') WHERE id = ?",
      ok ? "succeeded" : "failed",
      payload.result === undefined ? null : JSON.stringify(payload.result),
      payload.error ?? null,
      payload.usage === undefined ? null : JSON.stringify(payload.usage),
      id,
    );
  }
}

export function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))].slice(0, 8);
}
export function safeJson<T>(s: string | null, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
