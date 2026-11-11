import { renderBlocks, readingMinutes, slugify, type Block } from "../content/blocks.js";
import { escapeHtml, html, raw, safeUrl, type Raw } from "../util/html.js";
import { FONTS, type ThemeSpec } from "./spec.js";

/**
 * The single layout engine shared by every theme. Themes only change CSS variables and
 * modifier classes; the markup stays the same, so any content works with any theme.
 */

export interface SiteInfo {
  name: string;
  tagline: string;
  /** Prefix for internal links: "" for host-based tenancy, "/s/<slug>" for path-based. */
  base: string;
}

export interface ArticleView {
  slug: string;
  title: string;
  summary: string;
  seoDescription: string;
  blocks: Block[];
  tags: string[];
  publishedAt: string | null;
  source: "human" | "ai";
  /** Cover image shown on the article page and on cards. */
  image: { url: string; alt: string } | null;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function fontStack(name: string) {
  const generic = FONTS[name as keyof typeof FONTS] ?? "sans-serif";
  return name === "system-ui"
    ? "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    : `"${name}", ${generic}`;
}

function googleFontsHref(t: ThemeSpec): string | null {
  const fams = [...new Set([t.typography.headingFont, t.typography.bodyFont])].filter((f) => f !== "system-ui");
  if (!fams.length) return null;
  const q = fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@300;400;500;600;700;800;900`);
  return `https://fonts.googleapis.com/css2?${q.join("&")}&display=swap`;
}

export function themeVariables(t: ThemeSpec): string {
  const c = t.colors;
  const ty = t.typography;
  const gap = { compact: 0.75, comfortable: 1.25, airy: 2 }[t.shape.density];
  return `:root{
--bg:${c.background};--surface:${c.surface};--text:${c.text};--muted:${c.muted};
--primary:${c.primary};--on-primary:${c.primaryText};--accent:${c.accent};--border:${c.border};
--font-heading:${fontStack(ty.headingFont)};--font-body:${fontStack(ty.bodyFont)};
--base:${ty.baseSize}px;--scale:${ty.scale};--hw:${ty.headingWeight};--lh:${ty.lineHeight};
--ht:${ty.headingTransform};--radius:${t.shape.radius}px;--gap:${gap}rem;
--maxw:${t.layout.maxWidth}px;--cols:${t.layout.columns};
}`;
}

/** Base stylesheet: identical for every tenant/theme. */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{font-size:var(--base)}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-body);line-height:var(--lh);-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{font-family:var(--font-heading);font-weight:var(--hw);text-transform:var(--ht);line-height:1.2;margin:1.6em 0 .5em}
h1{font-size:calc(1rem * var(--scale) * var(--scale) * var(--scale) * var(--scale))}
h2{font-size:calc(1rem * var(--scale) * var(--scale))}
h3{font-size:calc(1rem * var(--scale))}
a{color:var(--primary)}
.link-color a{text-decoration:none}.link-color a:hover{text-decoration:underline}
.link-highlight .prose a{text-decoration:none;background:linear-gradient(transparent 60%, color-mix(in srgb,var(--accent) 45%,transparent) 0);color:inherit}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 1.25rem}
.bg-dots{background-image:radial-gradient(color-mix(in srgb,var(--text) 12%,transparent) 1px,transparent 1px);background-size:22px 22px}
.bg-grid{background-image:linear-gradient(color-mix(in srgb,var(--text) 6%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--text) 6%,transparent) 1px,transparent 1px);background-size:40px 40px}
.bg-gradient{background:linear-gradient(180deg,color-mix(in srgb,var(--primary) 10%,var(--bg)) 0,var(--bg) 600px) no-repeat,var(--bg)}
.bg-paper{background-image:radial-gradient(color-mix(in srgb,var(--text) 5%,transparent) .6px,transparent .6px);background-size:4px 4px}

/* Header variants */
.site-header{padding:calc(var(--gap)*1.2) 0;border-bottom:1px solid var(--border)}
.site-header .wrap{display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap}
.brand{font-family:var(--font-heading);font-weight:var(--hw);text-transform:var(--ht);font-size:1.4rem;color:var(--text);text-decoration:none!important}
.tagline{color:var(--muted);font-size:.9rem}
.nav{display:flex;gap:1.1rem;flex-wrap:wrap;margin-left:auto}
.nav a{color:var(--text);text-decoration:none;font-size:.95rem}.nav a:hover{color:var(--primary)}
.hdr-centered .site-header .wrap{flex-direction:column;gap:.4rem;text-align:center}
.hdr-centered .brand{font-size:2.4rem}.hdr-centered .nav{margin:0 auto;padding-top:.5rem;border-top:1px solid var(--border)}
.hdr-split .site-header .wrap{justify-content:space-between}
.hdr-minimal .site-header{border:0}.hdr-minimal .tagline{display:none}
.hdr-bold-band .site-header{background:var(--primary);border:0}
.hdr-bold-band .brand,.hdr-bold-band .nav a,.hdr-bold-band .tagline{color:var(--on-primary)}

/* Hero */
.hero{padding:calc(var(--gap)*3) 0 calc(var(--gap)*2)}
.hero h1{margin:0 0 .4em}.hero p{color:var(--muted);font-size:1.2rem;max-width:44rem;margin:0}
.hero-center{text-align:center}.hero-center p{margin:0 auto}
.hero-band{background:var(--primary);color:var(--on-primary)}.hero-band p{color:var(--on-primary);opacity:.85}
.hero-gradient{background:linear-gradient(135deg,var(--primary),var(--accent));color:var(--on-primary)}
.hero-gradient p{color:var(--on-primary);opacity:.9}
.hero-image{background-size:cover;background-position:center;color:#fff;padding:calc(var(--gap)*6) 0}
.hero-image p{color:#fff}

/* Cards */
.card{display:block;color:inherit;text-decoration:none!important;background:var(--surface);border-radius:var(--radius);padding:calc(var(--gap)*1.1);transition:transform .15s,box-shadow .15s}
.card-flat .card{background:transparent;padding-left:0;padding-right:0;border-radius:0;border-bottom:1px solid var(--border)}
.card-bordered .card{border:1px solid var(--border)}
.card-shadow .card{box-shadow:0 1px 3px rgb(0 0 0/.08),0 4px 14px rgb(0 0 0/.06)}
.card-elevated .card{border:1px solid var(--border);box-shadow:0 10px 30px rgb(0 0 0/.18)}
.card:hover{transform:translateY(-2px)}
.card h2,.card h3{margin:.2em 0 .35em;font-size:calc(1rem * var(--scale));color:var(--text)}
.card p{margin:0;color:var(--muted);font-size:.95rem}
.card-img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:calc(var(--radius)*.7);margin-bottom:.8rem;background:var(--border)}
.card-flat .card-img{border-radius:var(--radius)}
.home-list .card{display:grid;grid-template-columns:minmax(0,1fr);column-gap:1.2rem}
.home-list .card:has(.card-img){grid-template-columns:12rem minmax(0,1fr)}
.home-list .card-img{grid-row:1/span 4;margin:0}
.home-minimal .card-img{display:none}
.home-magazine .posts>.card:first-child .card-img{aspect-ratio:21/9}
.meta{color:var(--muted);font-size:.8rem;display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
.tag{display:inline-block;color:var(--primary);font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;text-decoration:none}

/* Home layouts */
.posts{display:grid;gap:calc(var(--gap)*1.4);padding:calc(var(--gap)*2) 0}
.home-grid .posts,.home-cards .posts{grid-template-columns:repeat(var(--cols),minmax(0,1fr))}
.home-cards .card{padding:calc(var(--gap)*1.6)}
.home-list .posts,.home-minimal .posts{grid-template-columns:1fr;max-width:48rem}
.home-minimal .card{background:none;border:0;box-shadow:none;padding:0}
.home-minimal .card h2{font-size:calc(1rem * var(--scale) * var(--scale))}
.home-magazine .posts{grid-template-columns:repeat(var(--cols),minmax(0,1fr))}
.home-magazine .posts>.card:first-child{grid-column:1/-1;padding:calc(var(--gap)*2)}
.home-magazine .posts>.card:first-child h2{font-size:calc(1rem * var(--scale) * var(--scale) * var(--scale))}
.empty{padding:4rem 0;color:var(--muted);text-align:center}

/* Article */
.article{padding:calc(var(--gap)*2) 0 calc(var(--gap)*3)}
.article header h1{margin:.3em 0 .3em}
.article .lede{font-size:1.2rem;color:var(--muted);margin:0 0 1rem}
.cover{margin:1.5rem 0 0}.cover img{display:block;width:100%;max-height:34rem;object-fit:cover;border-radius:var(--radius)}
.prose{max-width:42rem}
.art-classic .article{max-width:46rem;margin:0 auto}
.art-wide .prose{max-width:none}
.art-sidebar .article-body{display:grid;grid-template-columns:minmax(0,1fr) 15rem;gap:3rem}
.toc{position:sticky;top:1rem;align-self:start;font-size:.85rem;border-left:2px solid var(--border);padding-left:1rem}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:.2rem 0}.toc a:hover{color:var(--primary)}
.toc strong{display:block;margin-bottom:.4rem}
.prose img{max-width:100%;border-radius:var(--radius)}
.prose figure{margin:2rem 0}.prose figcaption{color:var(--muted);font-size:.85rem;text-align:center;margin-top:.5rem}
.prose blockquote{margin:1.6rem 0;padding:.2rem 0 .2rem 1.2rem;border-left:4px solid var(--accent);font-style:italic;font-size:1.1rem}
.prose blockquote cite{display:block;font-style:normal;color:var(--muted);font-size:.85rem}
.prose pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;overflow:auto;font-size:.85rem}
.prose code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.9em}
.prose :not(pre)>code{background:var(--surface);padding:.1em .35em;border-radius:4px}
.prose hr{border:0;border-top:1px solid var(--border);margin:2.5rem 0}
.callout{border-radius:var(--radius);padding:1rem 1.2rem;margin:1.5rem 0;border:1px solid var(--border);background:var(--surface)}
.callout-tip{border-left:4px solid #2f9e44}.callout-info{border-left:4px solid var(--primary)}.callout-warning{border-left:4px solid #e67700}
.ai-badge{font-size:.7rem;border:1px solid var(--border);border-radius:99px;padding:.05rem .5rem}

.site-footer{border-top:1px solid var(--border);padding:2rem 0;color:var(--muted);font-size:.85rem}
.site-footer .wrap{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.preview-bar{position:sticky;top:0;z-index:10;background:#111;color:#fff;font:13px system-ui;padding:.5rem 1rem;text-align:center}
.preview-bar a{color:#9cf}

@media (max-width:860px){
  .home-grid .posts,.home-cards .posts,.home-magazine .posts{grid-template-columns:1fr}
  .art-sidebar .article-body{grid-template-columns:1fr}.toc{display:none}
  .home-list .card:has(.card-img){grid-template-columns:minmax(0,1fr)}.home-list .card-img{grid-row:auto;margin-bottom:.8rem}
  .nav{margin-left:0}
}
`;

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

interface ShellOpts {
  title: string;
  description?: string;
  body: Raw;
  preview?: Raw;
  feedHref?: string;
}

function bodyClasses(t: ThemeSpec) {
  return [
    `hdr-${t.layout.header}`,
    `home-${t.layout.home}`,
    `art-${t.layout.article}`,
    `card-${t.shape.cardStyle}`,
    `bg-${t.decoration.background}`,
    `link-${t.decoration.linkStyle}`,
  ].join(" ");
}

function shell(site: SiteInfo, theme: ThemeSpec, o: ShellOpts): string {
  const fonts = googleFontsHref(theme);
  const nav = theme.nav
    .map((n) => {
      const href = safeUrl(n.href.startsWith("/") ? site.base + n.href : n.href);
      return href ? html`<a href="${href}">${n.label}</a>` : "";
    });
  return `<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>
${o.description ? html`<meta name="description" content="${o.description}"><meta property="og:description" content="${o.description}">` : ""}
<meta property="og:title" content="${o.title}">
${o.feedHref ? html`<link rel="alternate" type="application/rss+xml" title="${site.name}" href="${o.feedHref}">` : ""}
${fonts ? html`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${fonts}">` : ""}
<style>${raw(themeVariables(theme))}${raw(BASE_CSS)}</style>
</head><body class="${bodyClasses(theme)}">
${o.preview ?? ""}
<header class="site-header"><div class="wrap">
  <a class="brand" href="${site.base || "/"}">${site.name}</a>
  ${site.tagline ? html`<span class="tagline">${site.tagline}</span>` : ""}
  <nav class="nav">${nav}</nav>
</div></header>
<main>${o.body}</main>
<footer class="site-footer"><div class="wrap">
  <span>${theme.footer.text || `© ${new Date().getFullYear()} ${site.name}`}</span>
  ${theme.footer.showPoweredBy ? html`<span>Powered by AICMS</span>` : ""}
</div></footer>
</body></html>`}`;
}

function fmtDate(d: string | null) {
  if (!d) return "";
  const dt = new Date(d.replace(" ", "T") + (d.endsWith("Z") ? "" : "Z"));
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function meta(a: ArticleView, t: ThemeSpec): Raw {
  return html`<div class="meta">
    ${t.layout.showDates && a.publishedAt ? html`<time>${fmtDate(a.publishedAt)}</time>` : ""}
    ${t.layout.showReadingTime ? html`<span>${readingMinutes(a.blocks)} min read</span>` : ""}
  </div>`;
}

function coverUrl(a: ArticleView): string | null {
  return a.image ? safeUrl(a.image.url) : null;
}

function card(site: SiteInfo, t: ThemeSpec, a: ArticleView): Raw {
  const img = coverUrl(a);
  return html`<a class="card" href="${site.base}/a/${a.slug}">
    ${img ? html`<img class="card-img" src="${img}" alt="" loading="lazy">` : ""}
    ${a.tags[0] ? html`<span class="tag">${a.tags[0]}</span>` : ""}
    <h2>${a.title}</h2>
    ${t.layout.showSummaries && a.summary ? html`<p>${a.summary}</p>` : ""}
    ${meta(a, t)}
  </a>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function renderHome(
  site: SiteInfo,
  theme: ThemeSpec,
  articles: ArticleView[],
  opts: { heading?: string; preview?: Raw } = {},
): string {
  const h = theme.hero;
  const heroTitle = opts.heading ?? (h.title || site.name);
  const heroSub = opts.heading ? "" : h.subtitle || site.tagline;
  const showHero = opts.heading !== undefined || h.enabled;
  const heroStyle = h.style === "image" && h.imageUrl ? raw(` style="background-image:linear-gradient(rgb(0 0 0/.45),rgb(0 0 0/.45)),url('${escapeHtml(h.imageUrl)}')"`) : "";
  const body = html`
    ${showHero ? html`<section class="hero hero-${opts.heading ? "plain" : h.style} hero-${h.align}"${heroStyle}><div class="wrap">
      <h1>${heroTitle}</h1>${heroSub ? html`<p>${heroSub}</p>` : ""}
    </div></section>` : ""}
    <div class="wrap">
      ${articles.length
        ? html`<div class="posts">${articles.map((a) => card(site, theme, a))}</div>`
        : html`<p class="empty">Nothing published yet.</p>`}
    </div>`;
  return shell(site, theme, {
    title: opts.heading ? `${opts.heading} · ${site.name}` : site.name,
    description: site.tagline,
    body,
    preview: opts.preview,
    feedHref: `${site.base}/feed.xml`,
  });
}

export function renderArticle(site: SiteInfo, theme: ThemeSpec, a: ArticleView, opts: { preview?: Raw } = {}): string {
  const headings = a.blocks.filter((b): b is Extract<Block, { type: "heading" }> => b.type === "heading" && b.level <= 2);
  const toc =
    theme.layout.article === "sidebar" && headings.length
      ? html`<nav class="toc"><strong>On this page</strong>${headings.map(
          (h) => html`<a href="#${raw(slugify(h.text))}">${h.text}</a>`,
        )}</nav>`
      : "";
  const body = html`<div class="wrap"><article class="article">
    <header>
      <div class="meta">${a.tags.map((t) => html`<a class="tag" href="${site.base}/tag/${encodeURIComponent(t)}">${t}</a>`)}
        ${a.source === "ai" ? html`<span class="ai-badge" title="Written with AI assistance">AI-assisted</span>` : ""}</div>
      <h1>${a.title}</h1>
      ${a.summary ? html`<p class="lede">${a.summary}</p>` : ""}
      ${meta(a, theme)}
      ${coverUrl(a) ? html`<figure class="cover"><img src="${coverUrl(a)}" alt="${a.image!.alt}"></figure>` : ""}
    </header>
    <div class="article-body"><div class="prose">${raw(renderBlocks(a.blocks))}</div>${toc}</div>
  </article></div>`;
  return shell(site, theme, {
    title: `${a.title} · ${site.name}`,
    description: a.seoDescription || a.summary,
    body,
    preview: opts.preview,
    feedHref: `${site.base}/feed.xml`,
  });
}

export function renderNotFound(site: SiteInfo, theme: ThemeSpec): string {
  return shell(site, theme, {
    title: `Not found · ${site.name}`,
    body: html`<div class="wrap"><p class="empty">That page doesn't exist. <a href="${site.base || "/"}">Go home</a></p></div>`,
  });
}

export function renderFeed(site: SiteInfo, origin: string, articles: ArticleView[]): string {
  const items = articles
    .map(
      (a) => `<item><title>${escapeHtml(a.title)}</title><link>${escapeHtml(origin + site.base)}/a/${escapeHtml(a.slug)}</link>` +
        `<guid>${escapeHtml(origin + site.base)}/a/${escapeHtml(a.slug)}</guid><description>${escapeHtml(a.summary)}</description>` +
        (a.publishedAt ? `<pubDate>${new Date(a.publishedAt.replace(" ", "T") + "Z").toUTCString()}</pubDate>` : "") +
        `</item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeHtml(site.name)}</title>` +
    `<link>${escapeHtml(origin + site.base)}</link><description>${escapeHtml(site.tagline)}</description>${items}</channel></rss>`;
}
