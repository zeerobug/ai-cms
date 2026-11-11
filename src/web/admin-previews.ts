import express, { type NextFunction, type Request, type Response } from "express";
import type { Repo } from "../repo.js";
import { renderArticle, renderHome } from "../themes/render.js";
import { html } from "../util/html.js";
import { siteInfo } from "./site.js";

/**
 * Server-rendered previews of articles and themes. They use the public theme renderer
 * (one renderer for every theme), so they stay outside the React admin and open in a new tab.
 *
 *   GET /admin/:tenant/articles/:id/preview
 *   GET /admin/:tenant/design/:id/preview
 */
export function adminPreviewRouter(repo: Repo) {
  const r = express.Router({ mergeParams: true });

  r.use("/:tenant", (req: Request, res: Response, next: NextFunction) => {
    if (!/^\/(articles|design)\/\d+\/preview$/.test(req.path)) return next("router");
    if (!res.locals.user) return res.redirect(303, "/admin/login");
    const tenant = repo.tenantBySlug(String(req.params.tenant));
    if (!tenant) return void res.status(404).send("Site not found");
    if (!repo.roleFor(res.locals.user.id, tenant.id)) return void res.status(403).send("You don't have access to this site.");
    res.locals.tenant = tenant;
    next();
  });

  r.get("/:tenant/articles/:id/preview", (req, res) => {
    const tn = res.locals.tenant!;
    const a = repo.article(tn.id, Number(req.params.id));
    if (!a) return void res.status(404).send("Not found");
    const theme = a.theme_id ? repo.themeSpec(repo.theme(tn.id, a.theme_id)) : repo.activeTheme(tn);
    res.send(renderArticle(siteInfo(tn, `/s/${tn.slug}`), theme, repo.toView(a), {
      preview: html`<div class="preview-bar">Preview · status: ${a.status} · <a href="/admin/${tn.slug}/articles/${a.id}">back to editor</a></div>`,
    }));
  });

  r.get("/:tenant/design/:id/preview", (req, res) => {
    const tn = res.locals.tenant!;
    const row = repo.theme(tn.id, Number(req.params.id));
    if (!row) return void res.status(404).send("Not found");
    const articles = repo.articles(tn.id, { status: "published", limit: 12 }).map((a) => repo.toView(a));
    res.send(renderHome(siteInfo(tn, `/s/${tn.slug}`), repo.themeSpec(row), articles, {
      preview: html`<div class="preview-bar">Previewing theme “${row.name}” · <a href="/admin/${tn.slug}/design">back to Design</a></div>`,
    }));
  });

  return r;
}
