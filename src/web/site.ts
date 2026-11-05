import express, { type NextFunction, type Request, type Response } from "express";
import type { Repo, Tenant } from "../repo.js";
import { slugFromHost } from "../tenancy.js";
import { renderArticle, renderFeed, renderHome, renderNotFound, type SiteInfo } from "../themes/render.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      tenant?: Tenant;
      base?: string;
    }
  }
}

export function siteInfo(t: Tenant, base: string): SiteInfo {
  return { name: t.name, tagline: t.tagline, base };
}

/** Public website for a tenant. Mounted both for host-based and /s/:slug access. */
export function siteRouter(repo: Repo) {
  const r = express.Router({ mergeParams: true });

  r.get("/", (_req, res) => {
    const t = res.locals.tenant!;
    const articles = repo.articles(t.id, { status: "published", limit: 50 }).map((a) => repo.toView(a));
    res.send(renderHome(siteInfo(t, res.locals.base!), repo.activeTheme(t), articles));
  });

  r.get("/a/:slug", (req, res) => {
    const t = res.locals.tenant!;
    const row = repo.publishedArticle(t.id, req.params.slug);
    const site = siteInfo(t, res.locals.base!);
    if (!row) return void res.status(404).send(renderNotFound(site, repo.activeTheme(t)));
    const theme = row.theme_id ? repo.themeSpec(repo.theme(t.id, row.theme_id)) : repo.activeTheme(t);
    res.send(renderArticle(site, theme, repo.toView(row)));
  });

  r.get("/tag/:tag", (req, res) => {
    const t = res.locals.tenant!;
    const tag = req.params.tag.toLowerCase();
    const articles = repo.articles(t.id, { status: "published", tag }).map((a) => repo.toView(a));
    res.send(renderHome(siteInfo(t, res.locals.base!), repo.activeTheme(t), articles, { heading: `#${tag}` }));
  });

  r.get("/feed.xml", (req, res) => {
    const t = res.locals.tenant!;
    const articles = repo.articles(t.id, { status: "published", limit: 30 }).map((a) => repo.toView(a));
    res.type("application/rss+xml").send(renderFeed(siteInfo(t, res.locals.base!), `${req.protocol}://${req.get("host")}`, articles));
  });

  r.use((_req, res) => {
    const t = res.locals.tenant!;
    res.status(404).send(renderNotFound(siteInfo(t, res.locals.base!), repo.activeTheme(t)));
  });
  return r;
}

/** Resolve tenant from custom domain or BASE_DOMAIN subdomain. */
export function hostTenant(repo: Repo) {
  return (req: Request, res: Response, next: NextFunction) => {
    const host = (req.get("host") ?? "").split(":")[0].toLowerCase();
    const sub = slugFromHost(host);
    const t = (sub && repo.tenantBySlug(sub)) || (host && repo.tenantByDomain(host)) || undefined;
    if (!t) return next();
    res.locals.tenant = t;
    res.locals.base = "";
    next();
  };
}

/** Resolve tenant from /s/:tenant path prefix. */
export function pathTenant(repo: Repo) {
  return (req: Request, res: Response, next: NextFunction) => {
    const t = repo.tenantBySlug(String(req.params.tenant));
    if (!t) return void res.status(404).send("Site not found");
    res.locals.tenant = t;
    res.locals.base = `/s/${t.slug}`;
    next();
  };
}
