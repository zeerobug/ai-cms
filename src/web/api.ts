import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { PolicyError, type AiService } from "../ai/service.js";
import { BlocksSchema, markdownToBlocks } from "../content/blocks.js";
import { isImageUrl } from "../content/media.js";
import { safeJson, type Repo } from "../repo.js";
import { can, type Role } from "../tenancy.js";

/**
 * REST API (per-tenant bearer tokens). Lets external tools — or other AI agents — drive the CMS:
 *
 *   GET  /api/v1/articles[?status=published]
 *   GET  /api/v1/articles/:id
 *   POST /api/v1/articles            { title, markdown | blocks, summary?, tags?, status?, imageUrl?, imageAlt? }
 *   POST /api/v1/ai/articles[?wait=1] { topic, instructions?, tone?, length?, publish?, designLook?, coverImage? }
 *   POST /api/v1/ai/themes[?wait=1]   { prompt, apply?, baseThemeId?, palette?, heroImage? }
 *        palette: text in any supported format, ["#hex", …] or { primary: "#hex", … }
 *   GET  /api/v1/jobs/:id
 */
export function apiRouter(repo: Repo, ai: AiService) {
  const r = express.Router();

  r.use((req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
    const tok = m && repo.apiToken(m[1].trim());
    if (!tok) return void res.status(401).json({ error: "Missing or invalid API token" });
    res.locals.tenant = repo.tenantById(tok.tenant_id);
    res.locals.apiRole = tok.role;
    next();
  });

  const role = (res: Response) => res.locals.apiRole as Role;

  r.get("/articles", (req, res) => {
    const status = ["draft", "review", "published"].includes(String(req.query.status)) ? (req.query.status as "published") : undefined;
    const rows = repo.articles(res.locals.tenant!.id, { status, limit: 100 });
    res.json(rows.map((a) => ({ id: a.id, slug: a.slug, title: a.title, summary: a.summary, status: a.status, source: a.source, publishedAt: a.published_at, tags: safeJson(a.tags, []) })));
  });

  r.get("/articles/:id", (req, res) => {
    const a = repo.article(res.locals.tenant!.id, Number(req.params.id));
    if (!a) return void res.status(404).json({ error: "not found" });
    res.json({ id: a.id, ...repo.toView(a), status: a.status, themeId: a.theme_id });
  });

  r.post("/articles", (req, res) => {
    if (!can(role(res), "article.create")) return void res.status(403).json({ error: "forbidden" });
    const b = req.body ?? {};
    if (typeof b.title !== "string" || !b.title.trim()) return void res.status(400).json({ error: "title is required" });
    const blocks = Array.isArray(b.blocks) ? BlocksSchema.parse(b.blocks) : markdownToBlocks(String(b.markdown ?? ""));
    if (b.imageUrl !== undefined && b.imageUrl !== "" && !isImageUrl(b.imageUrl))
      return void res.status(400).json({ error: "imageUrl must be an https URL or a /media/ path" });
    let status = ["draft", "review", "published"].includes(b.status) ? b.status : "draft";
    if (status === "published" && !can(role(res), "article.publish")) status = "review";
    const id = repo.createArticle(res.locals.tenant!.id, {
      title: b.title,
      summary: String(b.summary ?? ""),
      seoDescription: String(b.seoDescription ?? ""),
      tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
      blocks,
      status,
      source: "human",
      image: b.imageUrl ? { url: b.imageUrl, alt: String(b.imageAlt ?? "") } : null,
    });
    res.status(201).json({ id, slug: repo.article(res.locals.tenant!.id, id)!.slug, status });
  });

  const jobJson = (tenantId: number, id: number) => {
    const j = repo.job(tenantId, id)!;
    return { id: j.id, kind: j.kind, status: j.status, result: safeJson(j.result, null), error: j.error, usage: safeJson(j.usage, null) };
  };

  r.post("/ai/articles", async (req, res) => {
    const t = res.locals.tenant!;
    const id = ai.requestArticle(t, { userId: null, role: role(res) }, req.body ?? {});
    if (req.query.wait) await ai.wait(id);
    res.status(req.query.wait ? 200 : 202).json(jobJson(t.id, id));
  });

  r.post("/ai/themes", async (req, res) => {
    const t = res.locals.tenant!;
    if (!can(role(res), "design.manage")) return void res.status(403).json({ error: "forbidden" });
    const id = ai.requestTheme(t, { userId: null, role: role(res) }, req.body ?? {});
    if (req.query.wait) await ai.wait(id);
    res.status(req.query.wait ? 200 : 202).json(jobJson(t.id, id));
  });

  r.get("/jobs/:id", (req, res) => {
    const t = res.locals.tenant!;
    if (!repo.job(t.id, Number(req.params.id))) return void res.status(404).json({ error: "not found" });
    res.json(jobJson(t.id, Number(req.params.id)));
  });

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PolicyError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof ZodError) return void res.status(400).json({ error: "invalid input", issues: err.issues });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return r;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      apiRole?: Role;
    }
  }
}
