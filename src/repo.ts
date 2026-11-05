import crypto from "node:crypto";
import { BlocksSchema, slugify, type Block } from "./content/blocks.js";
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
}
export interface Tenant extends Omit<TenantRow, "settings"> {
  settings: TenantSettings;
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
  kind: "article" | "theme";
  input: string;
  status: "queued" | "running" | "succeeded" | "failed";
  result: string | null;
  error: string | null;
  usage: string | null;
  created_at: string;
  finished_at: string | null;
}

export class Repo {
  constructor(public db: DB) {}

  // ---- tenants -------------------------------------------------------------

  private hydrate(row: TenantRow | undefined): Tenant | undefined {
    return row && { ...row, settings: parseSettings(row.settings) };
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

  tenantsForUser(userId: number) {
    return all<TenantRow & { role: Role }>(
      this.db,
      "SELECT t.*, m.role FROM tenants t JOIN memberships m ON m.tenant_id = t.id WHERE m.user_id = ? ORDER BY t.name",
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
      seoDescription?: string;
      blocks: Block[];
      tags?: string[];
      status: ArticleRow["status"];
      source: ArticleRow["source"];
      aiPrompt?: string;
      themeId?: number | null;
      authorId?: number | null;
    },
  ) {
    const slug = this.uniqueSlug(tenantId, a.slug || a.title);
    const r = run(
      this.db,
      `INSERT INTO articles (tenant_id, slug, title, summary, seo_description, blocks, tags, status, source, ai_prompt, theme_id, author_id, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${a.status === "published" ? "datetime('now')" : "NULL"})`,
      tenantId,
      slug,
      a.title,
      a.summary ?? "",
      a.seoDescription ?? "",
      JSON.stringify(a.blocks),
      JSON.stringify(normalizeTags(a.tags ?? [])),
      a.status,
      a.source,
      a.aiPrompt ?? null,
      a.themeId ?? null,
      a.authorId ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  updateArticle(
    tenantId: number,
    id: number,
    a: { title: string; slug: string; summary: string; seoDescription: string; blocks: Block[]; tags: string[]; status: ArticleRow["status"]; themeId: number | null },
  ) {
    const slug = this.uniqueSlug(tenantId, a.slug || a.title, id);
    run(
      this.db,
      `UPDATE articles SET title = ?, slug = ?, summary = ?, seo_description = ?, blocks = ?, tags = ?, status = ?, theme_id = ?,
         published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, datetime('now')) ELSE NULL END,
         updated_at = datetime('now')
       WHERE tenant_id = ? AND id = ?`,
      a.title,
      slug,
      a.summary,
      a.seoDescription,
      JSON.stringify(a.blocks),
      JSON.stringify(normalizeTags(a.tags)),
      a.status,
      a.themeId,
      a.status,
      tenantId,
      id,
    );
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
      seoDescription: row.seo_description,
      blocks,
      tags: safeJson<string[]>(row.tags, []),
      publishedAt: row.published_at,
      source: row.source,
    };
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
