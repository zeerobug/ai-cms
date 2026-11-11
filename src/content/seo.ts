import { slugify, type Block } from "./blocks.js";

/**
 * SEO metadata rules shared by the AI service, the admin API and the renderer.
 * AI output is untrusted: everything it suggests goes through `seoPatch`, which cleans and clamps
 * values and decides what may be changed.
 */

export const SEO_LIMITS = { title: 70, description: 160, alt: 300 } as const;

/** Collapse whitespace and cut to `max` characters at a word boundary (no HTML, no newlines). */
export function cleanMeta(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "");
}

/** The SEO-relevant parts of an article. */
export interface SeoFields {
  status: "draft" | "review" | "published";
  slug: string;
  seoTitle: string;
  seoDescription: string;
  tags: string[];
  /** Cover image ('' = none) and its alt text. */
  imageUrl: string;
  imageAlt: string;
  blocks: Block[];
}

export type SeoGap = "title" | "description" | "tags" | "alt";

/** What an article is missing for search engines (empty = complete). */
export function seoGaps(a: SeoFields): SeoGap[] {
  const gaps: SeoGap[] = [];
  if (!a.seoTitle.trim()) gaps.push("title");
  if (!a.seoDescription.trim()) gaps.push("description");
  if (!a.tags.length) gaps.push("tags");
  const missingAlt = (a.imageUrl && !a.imageAlt.trim()) || a.blocks.some((b) => b.type === "image" && !b.alt.trim());
  if (missingAlt) gaps.push("alt");
  return gaps;
}

/** What the AI proposes (see SeoDraftSchema). */
export interface SeoSuggestion {
  seoTitle: string;
  seoDescription: string;
  slug: string;
  tags: string[];
  imageAlts: { url: string; alt: string }[];
}

/**
 * "fill" only fills empty fields (used automatically on publish and for bulk runs);
 * "replace" rewrites the metadata (an editor explicitly asked for it).
 */
export type SeoMode = "fill" | "replace";

export interface SeoPatch {
  seoTitle: string;
  seoDescription: string;
  tags: string[];
  /** Desired slug (made unique by the repo); unchanged for published articles so links never break. */
  slug: string;
  imageAlt: string;
  blocks: Block[];
  /** Human-readable list of what changed. */
  changed: string[];
}

export function seoPatch(current: SeoFields, ai: SeoSuggestion, mode: SeoMode): SeoPatch {
  const changed: string[] = [];
  const pick = (label: string, cur: string, next: string) => {
    if (!next || next === cur || (mode === "fill" && cur.trim())) return cur;
    changed.push(label);
    return next;
  };

  const seoTitle = pick("search title", current.seoTitle, cleanMeta(ai.seoTitle, SEO_LIMITS.title));
  const seoDescription = pick("meta description", current.seoDescription, cleanMeta(ai.seoDescription, SEO_LIMITS.description));

  let tags = current.tags;
  // Same normalization as the repo's normalizeTags, so unchanged tags compare equal.
  const aiTags = [...new Set(ai.tags.map((t) => cleanMeta(t, 40).toLowerCase().replace(/\s+/g, "-")).filter(Boolean))].slice(0, 8);
  if (aiTags.length && (mode === "replace" || !current.tags.length) && aiTags.join() !== current.tags.join()) {
    tags = aiTags;
    changed.push("tags");
  }

  let slug = current.slug;
  const aiSlug = slugify(ai.slug);
  if (mode === "replace" && current.status !== "published" && aiSlug && aiSlug !== current.slug) {
    slug = aiSlug;
    changed.push("URL slug");
  }

  const alts = new Map(ai.imageAlts.map((i) => [i.url, cleanMeta(i.alt, SEO_LIMITS.alt)]));
  const altFor = (url: string, cur: string) => {
    const next = alts.get(url);
    return next && next !== cur && (mode === "replace" || !cur.trim()) ? next : cur;
  };
  let altCount = 0;
  const imageAlt = current.imageUrl ? altFor(current.imageUrl, current.imageAlt) : current.imageAlt;
  if (imageAlt !== current.imageAlt) altCount++;
  const blocks = current.blocks.map((b) => {
    if (b.type !== "image") return b;
    const alt = altFor(b.url, b.alt);
    if (alt === b.alt) return b;
    altCount++;
    return { ...b, alt };
  });
  if (altCount) changed.push(`alt text (${altCount} image${altCount === 1 ? "" : "s"})`);

  return { seoTitle, seoDescription, tags, slug, imageAlt, blocks, changed };
}
