import zlib from "node:zlib";
import { markdownToBlocks, plainText, slugify, type Block } from "../content/blocks.js";
import { paletteToColors } from "../themes/palette.js";
import type { AiTheme } from "../themes/spec.js";
import type { AIProvider, ArticleDraft, ArticleRequest, ImageRequest, SeoDraft, SeoRequest, SiteSeo, SiteSeoRequest, ThemeRequest } from "./provider.js";

/**
 * Deterministic, offline stand-in for the real model. Used for demos without an API key
 * and in tests. It produces plausible structure (not real prose).
 */
export class MockProvider implements AIProvider {
  readonly name = "mock";
  delayMs: number;
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  async writeArticle(req: ArticleRequest) {
    await sleep(this.delayMs);
    const topic = req.topic.trim().replace(/\.$/, "");
    const Topic = topic.charAt(0).toUpperCase() + topic.slice(1);
    const sections = { short: 2, medium: 3, long: 5 }[req.length];
    const blocks: Block[] = [
      {
        type: "paragraph",
        text: `${Topic} is one of those subjects that rewards a closer look. This piece walks through the essentials, the common misconceptions, and what it means for readers of **${req.site.name}**.`,
      },
    ];
    const names = ["Why it matters", "How it works", "Common mistakes", "Getting started", "What's next"];
    for (let i = 0; i < sections; i++) {
      blocks.push({ type: "heading", level: 2, text: names[i] });
      blocks.push({
        type: "paragraph",
        text: `When it comes to ${topic}, ${names[i].toLowerCase()} is where most people begin. Written in a ${req.tone} tone, this section would contain the substance a real model generates.`,
      });
      if (i === 1) blocks.push({ type: "list", ordered: false, items: ["Start small", "Measure what matters", "Iterate often"] });
      if (i === 2) blocks.push({ type: "callout", tone: "tip", text: `Choose Anthropic or OpenAI in Settings (or set an API key) to get real articles about ${topic}.` });
    }
    blocks.push({ type: "heading", level: 2, text: "The takeaway" });
    blocks.push({ type: "paragraph", text: `${Topic} is approachable once you break it down. ${req.instructions ? `(Instructions noted: ${req.instructions})` : ""}`.trim() });

    const value: ArticleDraft = {
      title: `A practical guide to ${topic}`,
      summary: `Everything you need to know about ${topic}, without the jargon.`,
      seoTitle: `${Topic}: a practical guide`.slice(0, 55),
      seoDescription: `A clear, practical guide to ${topic}.`.slice(0, 155),
      slug: slugify(`${topic} guide`),
      tags: topic
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3)
        .slice(0, 3),
      blocks,
    };
    return { value, usage: { model: "mock", inputTokens: 0, outputTokens: 0 } };
  }

  async designTheme(req: ThemeRequest) {
    await sleep(this.delayMs);
    const p = req.prompt.toLowerCase();
    const cur = req.current;
    const theme: AiTheme = structuredClone(cur);
    theme.name = req.prompt.split(/\s+/).slice(0, 3).join(" ").replace(/^\w/, (c) => c.toUpperCase()) || "Custom";
    theme.description = `Generated from: ${req.prompt}`;

    const palettes: [RegExp, Partial<AiTheme["colors"]>][] = [
      [/dark|night|midnight|tech|cyber|neon/, { background: "#0b0f19", surface: "#131a2a", text: "#e8ecf4", muted: "#94a0b8", border: "#263046", primary: "#8b5cf6", primaryText: "#ffffff", accent: "#22d3ee" }],
      [/nature|green|forest|eco|garden|organic/, { background: "#f6f8f2", surface: "#ffffff", text: "#1f2a1c", muted: "#5d6b57", border: "#dde5d4", primary: "#2f6b3a", primaryText: "#ffffff", accent: "#c08a2d" }],
      [/ocean|sea|blue|calm|travel/, { background: "#f3f8fb", surface: "#ffffff", text: "#0e2230", muted: "#55707f", border: "#d6e4ec", primary: "#0b6e99", primaryText: "#ffffff", accent: "#f2a65a" }],
      [/retro|vintage|70s|80s|warm/, { background: "#fbf1e3", surface: "#fff8ee", text: "#3b2314", muted: "#7c5a43", border: "#ecd8bd", primary: "#d9480f", primaryText: "#ffffff", accent: "#f59f00" }],
      [/luxury|elegant|gold|fashion/, { background: "#faf8f5", surface: "#ffffff", text: "#1b1b1b", muted: "#6f6a62", border: "#e8e2d8", primary: "#1b1b1b", primaryText: "#f4e3b2", accent: "#b08d57" }],
      [/playful|fun|kids|colorful|pop/, { background: "#fffaf0", surface: "#ffffff", text: "#22223b", muted: "#5c5c7a", border: "#ffe1a8", primary: "#ff4d6d", primaryText: "#ffffff", accent: "#4cc9f0" }],
    ];
    const palette = palettes.find(([re]) => re.test(p));
    if (palette) Object.assign(theme.colors, palette[1]);
    if (req.palette) theme.colors = paletteToColors(req.palette, theme.colors);

    if (/serif|editorial|newspaper|magazine|classic|elegant|luxury/.test(p)) {
      theme.typography.headingFont = "Playfair Display";
      theme.typography.bodyFont = "Source Serif 4";
    }
    if (/tech|code|developer|mono/.test(p)) {
      theme.typography.headingFont = "Space Grotesk";
      theme.typography.bodyFont = "IBM Plex Sans";
    }
    if (/retro|vintage/.test(p)) theme.typography.headingFont = "Fraunces";
    if (/bold|loud|poster/.test(p)) {
      theme.typography.headingFont = "Bebas Neue";
      theme.typography.headingTransform = "uppercase";
      theme.layout.header = "bold-band";
    }
    if (/minimal|clean|simple/.test(p)) Object.assign(theme.layout, { home: "minimal", header: "minimal", maxWidth: 780 });
    if (/magazine|newspaper|editorial/.test(p)) Object.assign(theme.layout, { home: "magazine", header: "centered" });
    if (/round|soft|friendly|playful/.test(p)) theme.shape.radius = 20;
    if (/sharp|brutal|square/.test(p)) theme.shape.radius = 0;
    if (/gradient|vibrant/.test(p)) Object.assign(theme.hero, { enabled: true, style: "gradient" });
    if (/sidebar|docs|documentation/.test(p)) theme.layout.article = "sidebar";

    return { value: theme, usage: { model: "mock", inputTokens: 0, outputTokens: 0 } };
  }

  async optimizeSeo(req: SeoRequest) {
    await sleep(this.delayMs);
    const { title, summary, markdown } = req.article;
    const blocks = markdownToBlocks(markdown);
    const words = title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const keyword = words.slice(0, 3).join(" ") || title.toLowerCase();
    const text = summary || plainText(blocks);
    const suggestions: string[] = [];
    if (!blocks.some((b) => b.type === "heading")) suggestions.push("Add section headings that name the topic so readers and search engines can scan the article.");
    if (plainText(blocks).split(/\s+/).length < 300) suggestions.push(`Expand the article: cover the questions people search for about ${keyword}.`);
    const value: SeoDraft = {
      focusKeyword: keyword,
      seoTitle: title.slice(0, 55),
      seoDescription: (text || `Read ${title} on ${req.site.name}.`).replace(/\s+/g, " ").slice(0, 155),
      slug: slugify(keyword),
      tags: req.article.tags.length ? req.article.tags : words.slice(0, 3),
      imageAlts: req.images.map((i, n) => ({ url: i.url, alt: n === 0 ? `Illustration for “${title}”` : `Image ${n + 1} in “${title}”` })),
      suggestions,
    };
    return { value, usage: { model: "mock", inputTokens: 0, outputTokens: 0 } };
  }

  async optimizeSiteSeo(req: SiteSeoRequest) {
    await sleep(this.delayMs);
    const topics = req.siteTags.slice(0, 3).join(", ");
    const value: SiteSeo = {
      description: `${req.site.name}${req.site.tagline ? `: ${req.site.tagline}` : ""}. ${topics ? `Articles about ${topics}.` : "Articles, guides and news."}`.slice(0, 155),
      suggestions: req.recentTitles.length < 5 ? ["Publish more articles so search engines have more pages to rank."] : [],
    };
    return { value, usage: { model: "mock", inputTokens: 0, outputTokens: 0 } };
  }

  /** A gradient PNG whose colors are derived from the prompt (same prompt → same image). */
  async generateImage(req: ImageRequest) {
    await sleep(this.delayMs);
    const [w, h] = { landscape: [480, 320], square: [400, 400], portrait: [320, 480] }[req.aspect];
    let hash = 2166136261;
    for (const ch of req.prompt) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    const hue = (hash >>> 0) % 360;
    const data = gradientPng(w, h, hsl(hue, 0.65, 0.55), hsl((hue + 70) % 360, 0.7, 0.35));
    return { value: { data }, usage: { model: "mock", inputTokens: 0, outputTokens: 0 } };
  }
}

type Rgb = [number, number, number];

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as Rgb;
}

/** Minimal PNG encoder (8-bit RGB, diagonal gradient from `a` to `b`). */
function gradientPng(w: number, h: number, a: Rgb, b: Rgb): Buffer {
  const stride = w * 3 + 1;
  const pixels = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    pixels[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      for (let c = 0; c < 3; c++) pixels[y * stride + 1 + x * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * t);
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sleep = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
