import crypto from "node:crypto";
import type { Repo, Tenant } from "../repo.js";
import { renderArticle, renderFeed, renderHome, renderNotFound, renderRobots, renderSitemap, type SiteInfo } from "../themes/render.js";

/**
 * Static export of a tenant's public site: the same pages the live server renders (render.ts),
 * written as files for a static host. Links stay root-relative (base ""), so the export must be
 * served at the root of its domain. Pages use `.html` files plus a Netlify `_redirects` rewrite,
 * so `/a/<slug>` and `/tag/<tag>` keep the URLs of the live site.
 */

export interface StaticFile {
  /** Root-relative path, e.g. "/index.html", "/a/hello.html", "/media/demo/abc.png". */
  path: string;
  data: Buffer;
}

/** Tags that are safe as file names on static hosts (Netlify rejects `#` and `?`, `/` would nest). */
const STATIC_TAG_RE = /^[\p{L}\p{N}._~+-]{1,100}$/u;
/** Media references in rendered pages: /media/<slug>/<file>. */
const MEDIA_REF_RE = /\/media\/([a-z0-9-]+)\/([A-Za-z0-9_-]{16}\.(?:png|jpg|webp|gif))/g;

export function staticSiteInfo(t: Tenant, siteUrl: string): SiteInfo & { url: string } {
  return {
    name: t.name,
    tagline: t.tagline,
    base: "",
    url: siteUrl.replace(/\/+$/, ""),
    lang: t.settings.seo.lang,
    description: t.settings.seo.description,
    indexable: t.settings.seo.indexing,
    gtagId: t.settings.analytics.gtagId,
  };
}

/**
 * Renders every public page of the tenant, plus the feed, sitemap, robots.txt, 404 page,
 * the images the pages reference, and Netlify's `_headers` / `_redirects` files.
 * @param siteUrl absolute URL the export will be served at (canonical links, sitemap, feed).
 */
export function buildStaticSite(repo: Repo, t: Tenant, siteUrl: string): StaticFile[] {
  const site = staticSiteInfo(t, siteUrl);
  const theme = repo.activeTheme(t);
  const files = new Map<string, string | Buffer>();

  const rows = repo.articles(t.id, { status: "published", limit: 50_000 });
  const views = rows.map((a) => repo.toView(a));
  files.set("/index.html", renderHome(site, theme, views.slice(0, 50)));
  rows.forEach((row, i) => {
    const articleTheme = row.theme_id ? repo.themeSpec(repo.theme(t.id, row.theme_id)) : theme;
    files.set(`/a/${row.slug}.html`, renderArticle(site, articleTheme, views[i]));
  });

  const tags = repo.publishedTags(t.id).filter((tag) => STATIC_TAG_RE.test(tag));
  for (const tag of tags) {
    const tagged = views.filter((v) => v.tags.includes(tag));
    files.set(`/tag/${tag}.html`, renderHome(site, theme, tagged, { heading: `#${tag}`, path: `/tag/${encodeURIComponent(tag)}` }));
  }

  files.set("/404.html", renderNotFound(site, theme));
  files.set("/feed.xml", renderFeed(site, views.slice(0, 30)));
  files.set("/sitemap.xml", renderSitemap(site, views, tags));
  files.set("/robots.txt", renderRobots(site));

  // Copy the tenant's images that the pages actually use (other tenants' paths are ignored).
  const used = new Set<string>();
  for (const body of files.values()) for (const m of String(body).matchAll(MEDIA_REF_RE)) if (m[1] === t.slug) used.add(m[2]);
  for (const file of [...used].sort()) {
    const row = repo.mediaData(t.id, file);
    if (row) files.set(`/media/${t.slug}/${file}`, Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength));
  }

  files.set(
    "/_headers",
    [
      "/*",
      "  X-Content-Type-Options: nosniff",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      "/media/*",
      "  Cache-Control: public, max-age=31536000, immutable",
      "/feed.xml",
      "  Content-Type: application/rss+xml; charset=utf-8",
      "",
    ].join("\n"),
  );
  // Rewrites (status 200) only apply when no file matches the path, e.g. /a/<slug> → /a/<slug>.html.
  files.set("/_redirects", ["/a/:slug  /a/:slug.html  200", "/tag/:tag  /tag/:tag.html  200", ""].join("\n"));

  return [...files].map(([path, body]) => ({ path, data: typeof body === "string" ? Buffer.from(body, "utf8") : body }));
}

export const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");

/** Fingerprint of a whole export: changes iff some file's path or content changes. */
export function exportHash(files: StaticFile[]): string {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`${f.path}\0${sha1(f.data)}\n`);
  return h.digest("hex");
}
