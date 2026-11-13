import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "../config.js";
import type { Repo, Tenant } from "../repo.js";
import { slugFromHost } from "../tenancy.js";
import { renderArticle, renderFeed, renderHome, renderNotFound, renderRobots, renderSitemap, type SiteInfo } from "../themes/render.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      tenant?: Tenant;
      base?: string;
    }
  }
}

export const requestOrigin = (req: Request) => `${req.protocol}://${req.get("host")}`;

/**
 * The one URL search engines should index a site under, whichever way the request came in:
 * the custom domain (assumed to serve HTTPS), else the BASE_DOMAIN subdomain, else the current
 * origin + path prefix. Same content reachable at /s/<slug> then points its canonical link there.
 */
export function canonicalRoot(t: Tenant, origin: string, base: string): string {
  if (t.domain) return `https://${t.domain}`;
  if (config.baseDomain) {
    const u = new URL(origin);
    return `${u.protocol}//${t.slug}.${config.baseDomain}${u.port ? `:${u.port}` : ""}`;
  }
  return origin + base;
}

export function siteInfo(t: Tenant, base: string, origin: string): SiteInfo & { url: string } {
  return {
    name: t.name,
    tagline: t.tagline,
    base,
    url: canonicalRoot(t, origin, base),
    lang: t.settings.seo.lang,
    description: t.settings.seo.description,
    indexable: t.settings.seo.indexing,
    gtagId: t.settings.analytics.gtagId,
  };
}

/** Public website for a tenant. Mounted both for host-based and /s/:slug access. */
export function siteRouter(repo: Repo) {
  const r = express.Router({ mergeParams: true });
  const site = (req: Request, res: Response) => siteInfo(res.locals.tenant!, res.locals.base!, requestOrigin(req));

  r.get("/", (req, res) => {
    const t = res.locals.tenant!;
    const articles = repo.articles(t.id, { status: "published", limit: 50 }).map((a) => repo.toView(a));
    res.send(renderHome(site(req, res), repo.activeTheme(t), articles));
  });

  r.get("/a/:slug", (req, res) => {
    const t = res.locals.tenant!;
    const row = repo.publishedArticle(t.id, req.params.slug);
    if (!row) return void res.status(404).send(renderNotFound(site(req, res), repo.activeTheme(t)));
    const theme = row.theme_id ? repo.themeSpec(repo.theme(t.id, row.theme_id)) : repo.activeTheme(t);
    res.send(renderArticle(site(req, res), theme, repo.toView(row)));
  });

  r.get("/tag/:tag", (req, res) => {
    const t = res.locals.tenant!;
    const tag = req.params.tag.toLowerCase();
    const articles = repo.articles(t.id, { status: "published", tag }).map((a) => repo.toView(a));
    res.send(renderHome(site(req, res), repo.activeTheme(t), articles, { heading: `#${tag}`, path: `/tag/${encodeURIComponent(tag)}` }));
  });

  r.get("/feed.xml", (req, res) => {
    const t = res.locals.tenant!;
    const articles = repo.articles(t.id, { status: "published", limit: 30 }).map((a) => repo.toView(a));
    res.type("application/rss+xml").send(renderFeed(site(req, res), articles));
  });

  r.get("/sitemap.xml", (req, res) => {
    const t = res.locals.tenant!;
    const articles = repo.articles(t.id, { status: "published", limit: 50_000 }).map((a) => repo.toView(a));
    res.type("application/xml").send(renderSitemap(site(req, res), articles, repo.publishedTags(t.id)));
  });

  r.get("/robots.txt", (req, res) => void res.type("text/plain").send(renderRobots(site(req, res))));

  r.use((req, res) => {
    const t = res.locals.tenant!;
    res.status(404).send(renderNotFound(site(req, res), repo.activeTheme(t)));
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
