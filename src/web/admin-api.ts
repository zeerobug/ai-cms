import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { PolicyError, type AiService } from "../ai/service.js";
import { csrfToken as csrfFor, hashPassword, SESSION_COOKIE, setSessionCookie, verifyPassword } from "../auth.js";
import { blocksToMarkdown, markdownToBlocks, slugify } from "../content/blocks.js";
import { safeJson, type ArticleRow, type JobRow, type Repo, type Tenant } from "../repo.js";
import { AI_PROVIDERS, atLeast, can, ROLES, TenantSettingsSchema, type Role } from "../tenancy.js";
import { MAX_PALETTE_INPUT, paletteToColors, parsePalette } from "../themes/palette.js";
import { normalizeTheme } from "../themes/spec.js";
import { decryptSecret, encryptSecret, maskSecret } from "../util/secrets.js";
import {
  PERMISSION_LIST,
  type ArticleDetail,
  type ArticleInput,
  type ArticleSummary,
  type Dashboard,
  type JobDetail,
  type JobSummary,
  type Permission,
  type SessionInfo,
  type SettingsData,
  type SettingsInput,
  type SiteSummary,
  type TenantInfo,
  type ThemeDetail,
  type ThemeSummary,
} from "./admin-types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      role?: Role;
    }
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v);
const STATUSES = ["draft", "review", "published"] as const;

/** Sends a JSON error and stops the handler. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const PROVIDER_LABELS: Record<(typeof AI_PROVIDERS)[number], string> = {
  anthropic: "Anthropic (Claude)",
  mock: "Mock (offline, for testing)",
};

/**
 * JSON API behind the React admin, mounted at /admin/api (session cookie + CSRF header).
 * Mutations must be `application/json` (blocks cross-site form posts) and carry `X-CSRF-Token`
 * once logged in (enforced by sessionMiddleware).
 */
export function adminApiRouter(repo: Repo, ai: AiService) {
  const r = express.Router();

  r.use((req, _res, next) => {
    // HTML forms can only POST, so requiring JSON on POST/PUT blocks cross-site form submissions.
    if ((req.method === "POST" || req.method === "PUT") && !req.is("application/json"))
      return next(new HttpError(415, "Expected application/json"));
    next();
  });

  // ---- session ------------------------------------------------------------

  const session = (res: Response): SessionInfo => {
    const u = res.locals.user;
    return { user: u ? { id: u.id, email: u.email, name: u.name } : null, csrf: res.locals.csrf ?? null };
  };

  r.get("/session", (_req, res) => void res.json(session(res)));

  r.post("/login", (req, res) => {
    const user = repo.userByEmail(str(req.body.email));
    if (!user || !verifyPassword(str(req.body.password), user.password_hash)) throw new HttpError(401, "Invalid email or password.");
    loginAs(res, user.id);
    res.json(session(res));
  });

  r.post("/signup", (req, res) => {
    const email = str(req.body.email).trim().toLowerCase();
    const password = str(req.body.password);
    const slug = slugify(str(req.body.slug));
    if (!email.includes("@")) throw new HttpError(400, "Please enter a valid email.");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
    if (!slug) throw new HttpError(400, "Please choose a site address.");
    if (repo.userByEmail(email)) throw new HttpError(409, "That email already has an account; log in instead.");
    if (repo.tenantBySlug(slug)) throw new HttpError(409, "That site address is taken.");
    const userId = repo.createUser(email, str(req.body.name), hashPassword(password));
    const t = repo.createTenant({ slug, name: str(req.body.site) || slug, ownerId: userId });
    loginAs(res, userId);
    res.status(201).json({ ...session(res), site: t.slug });
  });

  r.post("/logout", (_req, res) => {
    if (res.locals.sid) repo.deleteSession(res.locals.sid);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ user: null, csrf: null } satisfies SessionInfo);
  });

  function loginAs(res: Response, userId: number) {
    const sid = repo.createSession(userId);
    setSessionCookie(res, sid);
    res.locals.user = repo.userById(userId)!;
    res.locals.sid = sid;
    res.locals.csrf = csrfFor(sid);
  }

  // Everything below requires a logged-in user.
  r.use((_req, res, next) => (res.locals.user ? next() : next(new HttpError(401, "Not logged in."))));

  r.get("/sites", (_req, res) => {
    const sites: SiteSummary[] = repo.tenantsForUser(res.locals.user!.id).map((s) => ({ slug: s.slug, name: s.name, role: s.role }));
    res.json(sites);
  });

  r.post("/sites", (req, res) => {
    const slug = slugify(str(req.body.slug));
    if (!slug) throw new HttpError(400, "Please choose a slug.");
    if (repo.tenantBySlug(slug)) throw new HttpError(409, "That slug is taken.");
    const t = repo.createTenant({ slug, name: str(req.body.name) || slug, ownerId: res.locals.user!.id });
    res.status(201).json({ slug: t.slug });
  });

  // ---- tenant scope ---------------------------------------------------------

  const t = express.Router({ mergeParams: true });
  r.use("/t/:tenant", (req: Request, res: Response, next: NextFunction) => {
    const tenant = repo.tenantBySlug(String(req.params.tenant));
    if (!tenant) return next(new HttpError(404, "Site not found."));
    const role = repo.roleFor(res.locals.user!.id, tenant.id);
    if (!role) return next(new HttpError(403, "You don't have access to this site."));
    res.locals.tenant = tenant;
    res.locals.role = role;
    next();
  }, t);

  const need = (perm: Permission) => (_req: Request, res: Response, next: NextFunction) =>
    can(res.locals.role!, perm) ? next() : next(new HttpError(403, `Your role (${res.locals.role}) can't do that.`));
  const tenantOf = (res: Response) => res.locals.tenant!;
  const roleOf = (res: Response) => res.locals.role!;
  const actor = (res: Response) => ({ userId: res.locals.user!.id, role: roleOf(res) });
  const canEditArticle = (res: Response, a: ArticleRow) =>
    can(roleOf(res), "article.editAny") || (a.author_id === res.locals.user!.id && a.status !== "published");
  const findArticle = (res: Response, id: unknown) => {
    const a = repo.article(tenantOf(res).id, num(id));
    if (!a) throw new HttpError(404, "Article not found.");
    return a;
  };
  const findTheme = (res: Response, id: unknown) => {
    const row = repo.theme(tenantOf(res).id, num(id));
    if (!row) throw new HttpError(404, "Theme not found.");
    return row;
  };

  t.get("/", (_req, res) => void res.json(tenantInfo(tenantOf(res), roleOf(res), ai)));

  t.get("/dashboard", (_req, res) => {
    const tn = tenantOf(res);
    const body: Dashboard = { recentArticles: repo.articles(tn.id, { limit: 8 }).map(articleSummary), jobs: repo.jobs(tn.id, 8).map(jobSummary) };
    res.json(body);
  });

  // ---- AI requests --------------------------------------------------------

  t.post("/ai/article", (req, res) => {
    const b = req.body ?? {};
    const brief = str(b.designBrief).trim();
    const jobId = ai.requestArticle(tenantOf(res), actor(res), {
      topic: str(b.topic),
      instructions: str(b.instructions),
      tone: str(b.tone) || undefined,
      length: (["short", "medium", "long"] as const).find((l) => l === b.length),
      publish: b.publish === true,
      designLook: b.designLook === true ? brief || true : false,
    });
    res.status(202).json({ jobId });
  });

  t.post("/ai/theme", need("design.manage"), (req, res) => {
    const b = req.body ?? {};
    const jobId = ai.requestTheme(tenantOf(res), actor(res), {
      prompt: str(b.prompt),
      apply: b.apply === true,
      baseThemeId: num(b.baseThemeId) || undefined,
      palette: str(b.palette).trim() || undefined,
    });
    res.status(202).json({ jobId });
  });

  t.get("/jobs/:id", (req, res) => {
    const job = repo.job(tenantOf(res).id, num(req.params.id));
    if (!job) throw new HttpError(404, "Job not found.");
    const body: JobDetail = {
      id: job.id,
      kind: job.kind,
      status: job.status,
      request: jobRequest(job),
      result: safeJson(job.result, null),
      error: job.error,
      usage: safeJson(job.usage, null),
    };
    res.json(body);
  });

  // ---- articles -----------------------------------------------------------

  t.get("/articles", (req, res) => {
    const status = STATUSES.find((s) => s === req.query.status);
    res.json(repo.articles(tenantOf(res).id, { status }).map(articleSummary));
  });

  t.get("/articles/:id", (req, res) => {
    const tn = tenantOf(res);
    const role = roleOf(res);
    const base = {
      statuses: can(role, "article.publish") ? [...STATUSES] : STATUSES.filter((s) => s !== "published"),
      themes: repo.themes(tn.id).map((th) => ({ id: th.id, name: th.name })),
    };
    if (req.params.id === "new") {
      if (!can(role, "article.create")) throw new HttpError(403, "Your role can't create articles.");
      const body: ArticleDetail = { id: null, title: "", slug: "", summary: "", seoDescription: "", tags: [], status: "draft", source: "human", aiPrompt: null, themeId: null, markdown: "", editable: true, ...base };
      return void res.json(body);
    }
    const a = findArticle(res, req.params.id);
    const view = repo.toView(a);
    const body: ArticleDetail = {
      id: a.id,
      title: a.title,
      slug: a.slug,
      summary: a.summary,
      seoDescription: a.seo_description,
      tags: view.tags,
      status: a.status,
      source: a.source,
      aiPrompt: a.ai_prompt,
      themeId: a.theme_id,
      markdown: blocksToMarkdown(view.blocks),
      editable: canEditArticle(res, a),
      ...base,
    };
    res.json(body);
  });

  t.post("/articles", need("article.create"), (req, res) => {
    const tn = tenantOf(res);
    const id = repo.createArticle(tn.id, { ...readArticle(req.body, roleOf(res)), source: "human", authorId: res.locals.user!.id });
    res.status(201).json({ id });
  });

  t.put("/articles/:id", (req, res) => {
    const a = findArticle(res, req.params.id);
    if (!canEditArticle(res, a)) throw new HttpError(403, "You can't edit this article.");
    repo.updateArticle(tenantOf(res).id, a.id, readArticle(req.body, roleOf(res)));
    res.json({ id: a.id });
  });

  t.post("/articles/:id/status", (req, res) => {
    const a = findArticle(res, req.params.id);
    const status = STATUSES.find((s) => s === req.body?.status);
    if (!status) throw new HttpError(400, "Bad status.");
    const role = roleOf(res);
    const allowed = status === "published" ? can(role, "article.publish") : canEditArticle(res, a) || can(role, "article.publish");
    if (!allowed) throw new HttpError(403, "Your role can't do that.");
    repo.setArticleStatus(tenantOf(res).id, a.id, status);
    res.json({ id: a.id, status });
  });

  t.delete("/articles/:id", need("article.delete"), (req, res) => {
    repo.deleteArticle(tenantOf(res).id, findArticle(res, req.params.id).id);
    res.json({ ok: true });
  });

  // ---- themes -------------------------------------------------------------

  t.get("/themes", (_req, res) => {
    const tn = tenantOf(res);
    const body: ThemeSummary[] = repo.themes(tn.id).map((th) => {
      const spec = repo.themeSpec(th);
      return {
        id: th.id,
        name: th.name,
        source: th.source,
        prompt: th.prompt,
        active: th.id === tn.active_theme_id,
        swatch: [spec.colors.background, spec.colors.surface, spec.colors.primary, spec.colors.accent, spec.colors.text],
        description: `${spec.typography.headingFont} / ${spec.typography.bodyFont} · ${spec.layout.home} · ${spec.layout.header} header`,
      };
    });
    res.json(body);
  });

  t.get("/themes/:id", need("design.manage"), (req, res) => {
    const row = findTheme(res, req.params.id);
    const body: ThemeDetail = { id: row.id, name: row.name, spec: repo.themeSpec(row) };
    res.json(body);
  });

  /** Body: { spec, asCopy? }. Invalid values are clamped/reset by normalizeTheme. */
  t.put("/themes/:id", need("design.manage"), (req, res) => {
    const tn = tenantOf(res);
    const row = findTheme(res, req.params.id);
    if (req.body?.spec === undefined || typeof req.body.spec !== "object") throw new HttpError(400, "Expected a theme spec object.");
    const spec = normalizeTheme(req.body.spec, repo.themeSpec(row));
    if (req.body.asCopy === true) {
      const id = repo.createTheme(tn.id, { ...spec, name: `${spec.name} (copy)` }, "manual");
      return void res.status(201).json({ id, message: "Saved as a new theme." });
    }
    repo.updateTheme(tn.id, row.id, spec);
    res.json({ id: row.id, message: "Theme saved." });
  });

  t.post("/themes/palette", need("design.manage"), (req, res) => {
    const tn = tenantOf(res);
    const b = req.body ?? {};
    const text = str(b.palette);
    if (text.length > MAX_PALETTE_INPUT) throw new HttpError(413, "That palette is too large (64 KB max).");
    const palette = parsePalette(text);
    if (!palette.colors.length) throw new HttpError(400, "No colors found in the palette. Use values like #1d3557, rgb(29, 53, 87) or a palette file.");
    const baseRow = num(b.baseThemeId) ? findTheme(res, b.baseThemeId) : undefined;
    const current = baseRow ? repo.themeSpec(baseRow) : repo.activeTheme(tn);
    const name = str(b.name).trim() || `${current.name} (palette)`;
    const spec = normalizeTheme({ ...current, name, colors: paletteToColors(palette, current.colors) }, current);
    const id = repo.createTheme(tn.id, spec, "manual");
    const apply = b.apply === true;
    if (apply) repo.activateTheme(tn.id, id);
    const n = palette.colors.length;
    res.status(201).json({ id, message: `Theme “${spec.name}” created from ${n} color${n === 1 ? "" : "s"}${apply ? " and applied" : ""}.` });
  });

  t.post("/themes/:id/activate", need("design.manage"), (req, res) => {
    const row = findTheme(res, req.params.id);
    repo.activateTheme(tenantOf(res).id, row.id);
    res.json({ message: `“${row.name}” is now live.` });
  });

  t.delete("/themes/:id", need("design.manage"), (req, res) => {
    const tn = tenantOf(res);
    const row = findTheme(res, req.params.id);
    if (row.id === tn.active_theme_id) throw new HttpError(409, "Can't delete the live theme.");
    repo.deleteTheme(tn.id, row.id);
    res.json({ ok: true });
  });

  // ---- settings, members, tokens ------------------------------------------

  t.get("/settings", need("settings.manage"), (_req, res) => {
    const tn = tenantOf(res);
    const stored = repo.tenantAiKey(tn.id);
    const plain = stored ? decryptSecret(stored) : null;
    const body: SettingsData = {
      name: tn.name,
      tagline: tn.tagline,
      domain: tn.domain,
      ai: tn.settings.ai,
      providers: [
        { value: "default", label: `Platform default (${ai.provider.name})` },
        ...AI_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] })),
      ],
      platformProvider: ai.provider.name,
      apiKey: { stored: !!stored, masked: plain ? maskSecret(plain) : null, unreadable: !!stored && !plain },
      members: repo.members(tn.id),
      tokens: repo.apiTokens(tn.id),
      currentUserId: res.locals.user!.id,
    };
    res.json(body);
  });

  t.put("/settings", need("settings.manage"), (req, res) => {
    const tn = tenantOf(res);
    const b = (req.body ?? {}) as Partial<SettingsInput>;
    const parsed = TenantSettingsSchema.safeParse({ ai: b.ai });
    if (!parsed.success) throw new HttpError(400, "Invalid settings: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
    const domain = str(b.domain).trim().toLowerCase() || null;
    if (domain) {
      const other = repo.tenantByDomain(domain);
      if (other && other.id !== tn.id) throw new HttpError(409, "That domain is used by another site.");
    }
    const apiKey = str(b.apiKey).trim();
    if (apiKey && (apiKey.length > 500 || /\s/.test(apiKey))) throw new HttpError(400, "That API key doesn't look valid.");
    repo.updateTenant(tn.id, { name: str(b.name).trim() || tn.name, tagline: str(b.tagline), domain, settings: parsed.data });
    if (apiKey) repo.setTenantAiKey(tn.id, encryptSecret(apiKey));
    else if (b.clearKey === true) repo.setTenantAiKey(tn.id, null);
    res.json({ message: "Settings saved." });
  });

  const roleParam = (v: unknown): Role => ROLES.find((r) => r === v) ?? "author";

  t.post("/members", need("members.manage"), (req, res) => {
    const tn = tenantOf(res);
    const email = str(req.body?.email).trim().toLowerCase();
    if (!email.includes("@")) throw new HttpError(400, "Please enter a valid email.");
    const role = roleParam(req.body?.role);
    let user = repo.userByEmail(email);
    let message = `${email} is now ${role}.`;
    if (!user) {
      const temp = crypto.randomBytes(9).toString("base64url");
      repo.createUser(email, email.split("@")[0], hashPassword(temp));
      user = repo.userByEmail(email)!;
      message += ` New account created with temporary password: ${temp}`;
    }
    repo.setMembership(user.id, tn.id, role);
    res.json({ message });
  });

  t.delete("/members/:uid", need("members.manage"), (req, res) => {
    if (num(req.params.uid) === res.locals.user!.id) throw new HttpError(400, "You can't remove yourself.");
    repo.removeMembership(num(req.params.uid), tenantOf(res).id);
    res.json({ message: "Member removed." });
  });

  t.post("/tokens", need("settings.manage"), (req, res) => {
    const token = repo.createApiToken(tenantOf(res).id, str(req.body?.name).trim() || "token", roleParam(req.body?.role));
    res.status(201).json({ token });
  });

  t.delete("/tokens/:id", need("settings.manage"), (req, res) => {
    repo.deleteApiToken(tenantOf(res).id, num(req.params.id));
    res.json({ message: "Token revoked." });
  });

  // ---- fallthrough + errors -------------------------------------------------

  r.use((_req, _res, next) => next(new HttpError(404, "Not found.")));
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError || err instanceof PolicyError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof ZodError) return void res.status(400).json({ error: "Please check the form: " + err.issues.map((i) => i.message).join("; ") });
    console.error("[admin-api]", err);
    res.status(500).json({ error: "Internal error." });
  });

  return r;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function tenantInfo(tn: Tenant, role: Role, ai: AiService): TenantInfo {
  const s = tn.settings.ai;
  return {
    slug: tn.slug,
    name: tn.name,
    tagline: tn.tagline,
    role,
    can: Object.fromEntries(PERMISSION_LIST.map((p) => [p, can(role, p)])) as Record<Permission, boolean>,
    ai: {
      enabled: s.enabled,
      provider: ai.providerNameFor(tn),
      canAutoPublish: s.articles.autoPublish && can(role, "article.create") && atLeast(role, s.articles.minRoleToAutoPublish),
      canAutoApply: s.themes.autoApply && atLeast(role, s.themes.minRoleToAutoApply),
      defaultTone: s.articles.defaultTone,
      defaultLength: s.articles.defaultLength,
    },
  };
}

const articleSummary = (a: ArticleRow): ArticleSummary => ({ id: a.id, title: a.title, status: a.status, source: a.source, updatedAt: a.updated_at });

function jobRequest(j: JobRow) {
  const input = safeJson<Record<string, unknown>>(j.input, {});
  return String(input.topic ?? input.prompt ?? "");
}

const jobSummary = (j: JobRow): JobSummary => ({ id: j.id, kind: j.kind, request: jobRequest(j).slice(0, 120), status: j.status, error: j.error, createdAt: j.created_at });

function readArticle(body: Partial<ArticleInput> | undefined, role: Role) {
  const b = body ?? {};
  let status = STATUSES.find((s) => s === b.status) ?? "draft";
  if (status === "published" && !can(role, "article.publish")) status = "review";
  const tags = Array.isArray(b.tags) ? b.tags.map(String) : str(b.tags).split(",");
  return {
    title: str(b.title).trim() || "Untitled",
    slug: str(b.slug).trim(),
    summary: str(b.summary),
    seoDescription: str(b.seoDescription),
    blocks: markdownToBlocks(str(b.markdown)),
    tags,
    status,
    themeId: num(b.themeId) || null,
  };
}
