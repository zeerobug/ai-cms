import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { AnthropicProvider } from "../src/ai/anthropic.js";
import { OpenAIProvider } from "../src/ai/openai.js";
import { AiRefusalError } from "../src/ai/provider.js";
import { blocksToMarkdown, markdownToBlocks, renderBlocks, renderInline } from "../src/content/blocks.js";
import { aiArticlePublishDecision, aiThemeApplyDecision, TenantSettingsSchema } from "../src/tenancy.js";
import { renderArticle, renderHome, renderRobots, renderSitemap, type ArticleView } from "../src/themes/render.js";
import { cleanMeta, seoGaps, seoPatch, type SeoFields } from "../src/content/seo.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { MockProvider } from "../src/ai/mock.js";
import { isImageUrl, sniffImage } from "../src/content/media.js";
import { config } from "../src/config.js";
import { decryptSecret, encryptSecret, maskSecret } from "../src/util/secrets.js";
import { raw } from "../src/util/html.js";
import { DEFAULT_THEME, normalizeTheme, PRESETS, ThemeSpecSchema } from "../src/themes/spec.js";

test("markdown round-trips through blocks", () => {
  const md = `Intro with **bold** and a [link](https://example.com).

## Section

- one
- two

1. first
2. second

> A quote — Someone

> [!TIP] Handy tip

\`\`\`ts
const x = 1;
\`\`\`

![Alt](https://img.example/x.png "Caption")

---`;
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "heading", "list", "list", "quote", "callout", "code", "image", "divider"],
  );
  assert.deepEqual(markdownToBlocks(blocksToMarkdown(blocks)), blocks);
});

test("inline rendering escapes HTML and drops unsafe links", () => {
  const out = renderInline(`<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.b) **b** *i* \`<c>\``);
  assert.ok(!out.includes("<script>"));
  assert.ok(!out.includes("javascript:"));
  assert.ok(out.includes('<a href="https://a.b">ok</a>'));
  assert.ok(out.includes("<strong>b</strong>") && out.includes("<em>i</em>") && out.includes("<code>&lt;c&gt;</code>"));
  assert.equal(renderBlocks([{ type: "image", url: "javascript:x", alt: "", caption: "" }]), "");
});

test("normalizeTheme clamps values and falls back on invalid input", () => {
  const spec = normalizeTheme(
    {
      name: "Wild",
      colors: { background: "red", primary: "#ABCDEF" },
      typography: { baseSize: 99, headingFont: "Comic Sans", headingWeight: 1234 },
      layout: { columns: 9, home: "carousel" },
      hero: { style: "image", imageUrl: "javascript:alert(1)" },
    },
    DEFAULT_THEME,
  );
  assert.equal(spec.colors.background, DEFAULT_THEME.colors.background);
  assert.equal(spec.colors.primary, "#abcdef");
  assert.equal(spec.typography.baseSize, 22);
  assert.equal(spec.typography.headingWeight, 900);
  assert.equal(spec.typography.headingFont, DEFAULT_THEME.typography.headingFont);
  assert.equal(spec.layout.columns, 4);
  assert.equal(spec.layout.home, DEFAULT_THEME.layout.home);
  assert.equal(spec.hero.imageUrl, "");
  assert.equal(spec.hero.style, "gradient");
  for (const p of PRESETS) ThemeSpecSchema.parse(p);
});

test("rendered pages carry theme tokens and layout classes", () => {
  const theme = PRESETS.find((p) => p.name === "Midnight")!;
  const page = renderHome({ name: "Site <x>", tagline: "", base: "/s/x" }, theme, []);
  assert.ok(page.includes("--bg:#0d1117"));
  assert.ok(page.includes("home-cards") && page.includes("hdr-split"));
  assert.ok(page.includes("Site &lt;x&gt;"));
});

test("AI publish/apply policy", () => {
  const strict = TenantSettingsSchema.parse({});
  const open = TenantSettingsSchema.parse({ ai: { articles: { autoPublish: true }, themes: { autoApply: true } } });
  assert.equal(aiArticlePublishDecision(strict, "owner", true).publish, false);
  assert.equal(aiArticlePublishDecision(open, "editor", true).publish, true);
  assert.equal(aiArticlePublishDecision(open, "author", true).publish, false); // below minRoleToAutoPublish
  assert.equal(aiArticlePublishDecision(open, "owner", false).publish, false); // not requested
  assert.equal(aiThemeApplyDecision(strict, "owner", true).apply, false);
  assert.equal(aiThemeApplyDecision(open, "editor", true).apply, true);
});

function fakeClient(response: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return response;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const articleReq = {
  topic: "tea",
  instructions: "",
  tone: "warm",
  length: "short" as const,
  language: "English",
  brandVoice: "Be concise.",
  site: { name: "S", tagline: "" },
  existingTitles: ["Old post"],
  model: "claude-opus-5-5",
  effort: "medium" as const,
};

test("AnthropicProvider sends structured-output request with fallbacks", async () => {
  const draft = { title: "T", summary: "S", seoDescription: "D", tags: ["a"], blocks: [{ type: "paragraph", text: "hi" }] };
  const { client, calls } = fakeClient({
    stop_reason: "end_turn",
    parsed_output: draft,
    model: "claude-opus-5-5",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  });
  const res = await new AnthropicProvider(client).writeArticle(articleReq);
  assert.deepEqual(res.value, draft);
  assert.equal(res.usage.inputTokens, 15);
  const p = calls[0] as any;
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.output_config.effort, "medium");
  assert.equal(p.output_config.format.type, "json_schema");
  assert.ok(p.messages[0].content.includes("Be concise.") && p.messages[0].content.includes("Old post"));
});

test("AnthropicProvider surfaces refusals", async () => {
  const { client } = fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null, usage: {} });
  await assert.rejects(new AnthropicProvider(client).writeArticle(articleReq), AiRefusalError);
});

function fakeOpenAI(response: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    responses: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        return response;
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

test("OpenAIProvider sends a structured-output request and swaps Claude model names", async () => {
  const draft = { title: "T", summary: "S", seoDescription: "D", tags: ["a"], blocks: [{ type: "paragraph", text: "hi" }] };
  const { client, calls } = fakeOpenAI({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] }],
    output_parsed: draft,
    model: "gpt-5.5",
    usage: { input_tokens: 12, output_tokens: 34 },
  });
  const res = await new OpenAIProvider(client).writeArticle(articleReq);
  assert.deepEqual(res.value, draft);
  assert.deepEqual(res.usage, { model: "gpt-5.5", inputTokens: 12, outputTokens: 34 });
  const p = calls[0] as any;
  assert.equal(p.model, config.openaiModel); // "claude-opus-5-5" isn't an OpenAI model
  assert.deepEqual(p.reasoning, { effort: "medium" });
  assert.equal(p.text.format.type, "json_schema");
  assert.equal(p.text.format.strict, true);
  assert.ok(p.input.includes("Be concise.") && p.input.includes("Old post"));

  await new OpenAIProvider(client).writeArticle({ ...articleReq, model: "gpt-5.4-mini" });
  assert.equal((calls[1] as any).model, "gpt-5.4-mini");
});

test("OpenAIProvider surfaces refusals and truncation", async () => {
  const refusal = fakeOpenAI({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_parsed: null });
  await assert.rejects(new OpenAIProvider(refusal.client).writeArticle(articleReq), AiRefusalError);
  const cut = fakeOpenAI({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], output_parsed: null });
  await assert.rejects(new OpenAIProvider(cut.client).writeArticle(articleReq), /cut off/);
});

test("secrets: encrypt/decrypt round-trip, wrong APP_SECRET fails closed", () => {
  const enc = encryptSecret("sk-ant-abc123xyz");
  assert.notEqual(enc, encryptSecret("sk-ant-abc123xyz"), "random IV");
  assert.equal(decryptSecret(enc), "sk-ant-abc123xyz");
  assert.equal(decryptSecret("not-encrypted"), null);
  const saved = config.secret;
  config.secret = "another-secret";
  try {
    assert.equal(decryptSecret(enc), null);
  } finally {
    config.secret = saved;
  }
  assert.equal(maskSecret("sk-ant-abc123xyz"), "sk-ant…3xyz");
});

test("parsePalette reads lists, CSS vars, JSON, GIMP and Coolors formats", async () => {
  const { parsePalette } = await import("../src/themes/palette.js");
  assert.deepEqual(parsePalette("#264653, #2A9D8F\n#fff rgb(233, 196, 106)").colors, ["#264653", "#2a9d8f", "#ffffff", "#e9c46a"]);
  assert.deepEqual(parsePalette("264653-2a9d8f e9c46a").colors, ["#264653", "#2a9d8f", "#e9c46a"]);
  const css = parsePalette(":root {\n  --color-primary: #0b6e99;\n  --bg: #f3f8fb; /* page */\n  --on-primary: #fff;\n  --extra: #123456;\n}");
  assert.deepEqual(css.roles, { primary: "#0b6e99", background: "#f3f8fb", primaryText: "#ffffff" });
  assert.equal(css.colors.length, 4);
  assert.deepEqual(parsePalette('{"colors":{"primaryText":"#000000","accent":"#ff0000"}}').roles, { primaryText: "#000000", accent: "#ff0000" });
  assert.deepEqual(parsePalette('[{"name":"Brand","hex":"#112233"},"#445566"]'), { colors: ["#112233", "#445566"], roles: { primary: "#112233" } });
  assert.deepEqual(parsePalette("GIMP Palette\nName: Test\n#\n 38  70  83\tBackground\n255 255 255 Text").roles, { background: "#264653", text: "#ffffff" });
  assert.deepEqual(parsePalette("https://coolors.co/264653-2a9d8f-e9c46a").colors, ["#264653", "#2a9d8f", "#e9c46a"]);
  assert.deepEqual(parsePalette(["#abc", "nope"]).colors, ["#aabbcc"]);
  assert.equal(parsePalette("no colors here <script>").colors.length, 0);
});

test("paletteToColors honours named roles and keeps text readable", async () => {
  const { contrast, paletteToColors, parsePalette } = await import("../src/themes/palette.js");
  const colors = paletteToColors(parsePalette("#264653 #2a9d8f #e9c46a #f4a261 #e76f51 #fdfcf8"), DEFAULT_THEME.colors);
  assert.equal(colors.background, "#fdfcf8");
  assert.ok(contrast(colors.text, colors.background) >= 4.5);
  assert.ok(contrast(colors.primaryText, colors.primary) >= 3);
  assert.ok(["#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"].includes(colors.primary));
  // Mid-tone palette: background stays the base page color instead of a saturated color.
  assert.equal(paletteToColors(parsePalette("#e76f51 #2a9d8f"), DEFAULT_THEME.colors).background, DEFAULT_THEME.colors.background);
  const pinned = paletteToColors(parsePalette("primary: #000000\nbackground: #222222"), DEFAULT_THEME.colors);
  assert.equal(pinned.primary, "#000000");
  assert.equal(pinned.background, "#222222");
  assert.ok(ThemeSpecSchema.shape.colors.safeParse(pinned).success);
});

test("sniffImage recognises raster formats by their bytes and rejects everything else", async () => {
  const png = (await new MockProvider().generateImage({ prompt: "a lighthouse", aspect: "landscape" })).value.data;
  assert.deepEqual(sniffImage(png), { mime: "image/png", ext: "png" });
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext, "jpg");
  assert.equal(sniffImage(Buffer.from("GIF89a......"))?.ext, "gif");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))?.ext, "webp");
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("isImageUrl allows https and own media paths only, and nothing that can break out of CSS", () => {
  assert.ok(isImageUrl("https://images.example.com/a.jpg?w=1200"));
  assert.ok(isImageUrl("/media/demo/AbCdEfGhIjKlMn_-.webp"));
  for (const bad of ["http://x.com/a.png", "javascript:alert(1)", "/media/demo/../x.png", "/admin/api/x", "https://x.com/a.png'),url(x", 'https://x.com/"a', "https://x.com/a b"])
    assert.equal(isImageUrl(bad), false, bad);
});

test("hero and cover images render; unsafe hero URLs are dropped", () => {
  const media = "/media/demo/AbCdEfGhIjKlMn_-.png";
  const theme = normalizeTheme({ hero: { enabled: true, style: "image", imageUrl: media } }, DEFAULT_THEME);
  assert.equal(theme.hero.imageUrl, media);
  assert.ok(renderHome({ name: "S", tagline: "", base: "" }, theme, []).includes(`url('${media}')`));

  const injected = normalizeTheme({ hero: { enabled: true, style: "image", imageUrl: "https://x.com/a.png');color:red;x:url('" } }, DEFAULT_THEME);
  assert.equal(injected.hero.imageUrl, "");
  assert.equal(injected.hero.style, "gradient");

  const article = { slug: "a", title: "T", summary: "", seoTitle: "", seoDescription: "", blocks: [], tags: [], publishedAt: null, updatedAt: "2026-01-01 00:00:00", source: "human" as const, image: { url: media, alt: 'A "quoted" lighthouse' } };
  const home = renderHome({ name: "S", tagline: "", base: "" }, DEFAULT_THEME, [article]);
  assert.ok(home.includes(`<img class="card-img" src="${media}"`));
  const page = renderArticle({ name: "S", tagline: "", base: "" }, DEFAULT_THEME, article);
  assert.ok(page.includes(`<figure class="cover"><img src="${media}" alt="A &quot;quoted&quot; lighthouse">`));
});

test("OpenAIProvider generates images with the configured image model and size", async () => {
  const calls: unknown[] = [];
  const client = {
    images: {
      generate: async (p: unknown) => {
        calls.push(p);
        return { data: [{ b64_json: Buffer.from("RIFF\0\0\0\0WEBPVP8 ").toString("base64") }], usage: { input_tokens: 5, output_tokens: 99 } };
      },
    },
  } as unknown as OpenAI;
  const res = await new OpenAIProvider(client).generateImage({ prompt: "a fox", aspect: "portrait" });
  assert.equal(sniffImage(res.value.data)?.ext, "webp");
  assert.deepEqual(res.usage, { model: config.openaiImageModel, inputTokens: 5, outputTokens: 99 });
  const p = calls[0] as any;
  assert.equal(p.model, config.openaiImageModel);
  assert.equal(p.size, "1024x1536");
  assert.equal(p.prompt, "a fox");
});

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

test("cleanMeta collapses whitespace and cuts at a word boundary", () => {
  assert.equal(cleanMeta("  a\n\tb  ", 10), "a b");
  const cut = cleanMeta("The quick brown fox jumps over the lazy dog", 20);
  assert.ok(cut.length <= 20 && !cut.endsWith(" "));
  assert.equal(cut, "The quick brown fox");
});

const seoBase: SeoFields = {
  status: "published",
  slug: "old-slug",
  seoTitle: "",
  seoDescription: "Written by a human",
  tags: [],
  imageUrl: "/media/x/cover.png",
  imageAlt: "",
  blocks: [
    { type: "paragraph", text: "Hi" },
    { type: "image", url: "https://img.example/a.jpg", alt: "kept", caption: "" },
    { type: "image", url: "https://img.example/b.jpg", alt: "", caption: "" },
  ],
};
const suggestion = {
  seoTitle: "  New   title  ",
  seoDescription: "AI description",
  slug: "Better Slug!",
  tags: ["Sourdough Bread", "baking"],
  imageAlts: [
    { url: "/media/x/cover.png", alt: "A loaf" },
    { url: "https://img.example/a.jpg", alt: "AI alt a" },
    { url: "https://img.example/b.jpg", alt: "AI alt b" },
  ],
};

test("seoGaps lists missing metadata", () => {
  assert.deepEqual(seoGaps(seoBase), ["title", "tags", "alt"]);
  const complete = seoPatch(seoBase, suggestion, "fill");
  assert.deepEqual(seoGaps({ ...seoBase, ...complete }), []);
});

test("seoPatch fill mode only fills empty fields and never touches published slugs", () => {
  const p = seoPatch(seoBase, suggestion, "fill");
  assert.equal(p.seoTitle, "New title");
  assert.equal(p.seoDescription, "Written by a human");
  assert.deepEqual(p.tags, ["sourdough-bread", "baking"]);
  assert.equal(p.slug, "old-slug");
  assert.equal(p.imageAlt, "A loaf");
  assert.equal((p.blocks[1] as { alt: string }).alt, "kept");
  assert.equal((p.blocks[2] as { alt: string }).alt, "AI alt b");
  assert.deepEqual(p.changed, ["search title", "tags", "alt text (2 images)"]);
});

test("seoPatch replace mode rewrites metadata; slug only changes before publishing", () => {
  const live = seoPatch(seoBase, suggestion, "replace");
  assert.equal(live.seoDescription, "AI description");
  assert.equal((live.blocks[1] as { alt: string }).alt, "AI alt a");
  assert.equal(live.slug, "old-slug");
  const draft = seoPatch({ ...seoBase, status: "draft" }, suggestion, "replace");
  assert.equal(draft.slug, "better-slug");
  // Over-long AI output is clamped.
  const long = seoPatch(seoBase, { ...suggestion, seoDescription: "word ".repeat(100) }, "replace");
  assert.ok(long.seoDescription.length <= 160);
});

const seoSite = { name: "Bakery", tagline: "Bread notes", base: "/s/bakery", url: "https://bakery.example", lang: "fr", description: "Home description" };
const seoArticle: ArticleView = {
  slug: "pain",
  title: "Pain </script><script>alert(1)</script>",
  summary: "Sum",
  seoTitle: "Pain au levain maison",
  seoDescription: "Desc",
  blocks: [{ type: "paragraph", text: "one two three" }],
  tags: ["bread"],
  publishedAt: "2026-03-01 10:00:00",
  updatedAt: "2026-03-02 10:00:00",
  source: "human",
  image: { url: "/media/bakery/c.png", alt: "Loaf" },
};

test("article pages carry canonical, Open Graph and safe JSON-LD", () => {
  const page = renderArticle(seoSite, DEFAULT_THEME, seoArticle);
  assert.ok(page.includes('<html lang="fr">'));
  assert.ok(page.includes("<title>Pain au levain maison · Bakery</title>"));
  assert.ok(page.includes('<link rel="canonical" href="https://bakery.example/a/pain">'));
  assert.ok(page.includes('<meta property="og:image" content="https://bakery.example/media/bakery/c.png">'));
  assert.ok(page.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(page.includes('<meta property="article:published_time" content="2026-03-01T10:00:00.000Z">'));
  assert.ok(!page.includes('name="robots"'));
  const scripts = [...page.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0]["@type"], "BlogPosting");
  assert.equal(scripts[0].mainEntityOfPage, "https://bakery.example/a/pain");
  assert.equal(scripts[0].wordCount, 3);
  assert.equal(scripts[1]["@type"], "BreadcrumbList");
  assert.equal(scripts[1].itemListElement[1].name, seoArticle.title, "title survives the escaping");
  assert.ok(!page.includes("<script>alert(1)"), "no script injection through JSON-LD");

  const hidden = renderArticle({ ...seoSite, indexable: false }, DEFAULT_THEME, seoArticle);
  assert.ok(hidden.includes('<meta name="robots" content="noindex">'));
  const home = renderHome(seoSite, DEFAULT_THEME, [seoArticle]);
  assert.ok(home.includes('<meta name="description" content="Home description">'));
  assert.ok(home.includes('<link rel="canonical" href="https://bakery.example/">'));
  assert.ok(home.includes('"@type":"WebSite"'));
});

test("sitemap lists canonical URLs; robots.txt points to it or blocks everything", () => {
  const xml = renderSitemap(seoSite, [seoArticle], ["bread", "a&b"]);
  assert.ok(xml.includes("<loc>https://bakery.example/</loc><lastmod>2026-03-02T10:00:00.000Z</lastmod>"));
  assert.ok(xml.includes("<loc>https://bakery.example/a/pain</loc>"));
  assert.ok(xml.includes("<loc>https://bakery.example/tag/a%26b</loc>"));
  assert.equal(renderRobots(seoSite), "User-agent: *\nAllow: /\n\nSitemap: https://bakery.example/sitemap.xml\n");
  assert.equal(renderRobots({ ...seoSite, indexable: false }), "User-agent: *\nDisallow: /\n");
});

test("openDb upgrades an old ai_jobs table so it accepts SEO jobs, keeping existing rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicms-"));
  const file = path.join(dir, "old.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    INSERT INTO tenants (slug, name) VALUES ('t', 'T');
    CREATE TABLE ai_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id INTEGER, kind TEXT NOT NULL CHECK (kind IN ('article','theme')), input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
      result TEXT, error TEXT, usage TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
    INSERT INTO ai_jobs (tenant_id, kind, input, status) VALUES (1, 'article', '{}', 'succeeded');`);
  old.close();
  const db = openDb(file);
  try {
    db.prepare("INSERT INTO ai_jobs (tenant_id, kind, input) VALUES (1, 'seo', '{}')").run();
    const kinds = db.prepare("SELECT kind FROM ai_jobs ORDER BY id").all().map((r) => (r as { kind: string }).kind);
    assert.deepEqual(kinds, ["article", "seo"]);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_jobs_tenant'").get());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AnthropicProvider sends SEO requests with the SEO system prompt and image list", async () => {
  const seo = { focusKeyword: "k", seoTitle: "T", seoDescription: "D", slug: "s", tags: [], imageAlts: [], suggestions: [] };
  const { client, calls } = fakeClient({ stop_reason: "end_turn", parsed_output: seo, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } });
  const res = await new AnthropicProvider(client).optimizeSeo({
    site: { name: "S", tagline: "" },
    language: "English",
    article: { title: "Bread", summary: "", tags: [], markdown: "Body" },
    images: [{ url: "https://img.example/a.jpg", context: "Caption: a loaf" }],
    otherTitles: [],
    siteTags: ["baking"],
    model: "claude-opus-5-5",
    effort: "low",
  });
  assert.deepEqual(res.value, seo);
  const p = calls[0] as any;
  assert.ok(p.system[0].text.startsWith("You are an SEO editor"));
  assert.ok(p.messages[0].content.includes("https://img.example/a.jpg") && p.messages[0].content.includes("baking"));
  assert.equal(p.output_config.effort, "low");
});

test("Google tag: only valid IDs are accepted and rendered, never in previews", () => {
  assert.equal(TenantSettingsSchema.parse({}).analytics.gtagId, "");
  assert.equal(TenantSettingsSchema.parse({ analytics: { gtagId: " G-ABC123XYZ " } }).analytics.gtagId, "G-ABC123XYZ");
  for (const bad of ["<script>", "G-AB'C", "UA", "G-ABC123XYZ');alert(1)//"]) {
    assert.equal(TenantSettingsSchema.safeParse({ analytics: { gtagId: bad } }).success, false, bad);
  }
  const site = { name: "S", tagline: "", base: "", gtagId: "G-ABC123XYZ" };
  const page = renderHome(site, DEFAULT_THEME, []);
  assert.ok(page.includes("googletagmanager.com/gtag/js?id=G-ABC123XYZ"));
  assert.ok(page.includes("gtag('config','G-ABC123XYZ')"));
  assert.ok(!renderHome({ ...site, gtagId: "" }, DEFAULT_THEME, []).includes("gtag"));
  assert.ok(!renderHome({ ...site, gtagId: "x');evil()//" }, DEFAULT_THEME, []).includes("evil"));
  assert.ok(!renderHome(site, DEFAULT_THEME, [], { preview: raw("<b>p</b>") }).includes("gtag"));
});
