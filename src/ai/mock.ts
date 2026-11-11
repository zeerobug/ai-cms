import type { Block } from "../content/blocks.js";
import { paletteToColors } from "../themes/palette.js";
import type { AiTheme } from "../themes/spec.js";
import type { AIProvider, ArticleDraft, ArticleRequest, ThemeRequest } from "./provider.js";

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
      if (i === 2) blocks.push({ type: "callout", tone: "tip", text: `Set \`AI_PROVIDER=anthropic\` and an API key to get real articles about ${topic}.` });
    }
    blocks.push({ type: "heading", level: 2, text: "The takeaway" });
    blocks.push({ type: "paragraph", text: `${Topic} is approachable once you break it down. ${req.instructions ? `(Instructions noted: ${req.instructions})` : ""}`.trim() });

    const value: ArticleDraft = {
      title: `A practical guide to ${topic}`,
      summary: `Everything you need to know about ${topic}, without the jargon.`,
      seoDescription: `A clear, practical guide to ${topic}.`.slice(0, 155),
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
}

const sleep = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
