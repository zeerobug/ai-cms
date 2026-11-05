import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../src/ai/anthropic.js";
import { AiRefusalError } from "../src/ai/provider.js";
import { blocksToMarkdown, markdownToBlocks, renderBlocks, renderInline } from "../src/content/blocks.js";
import { aiArticlePublishDecision, aiThemeApplyDecision, TenantSettingsSchema } from "../src/tenancy.js";
import { renderHome } from "../src/themes/render.js";
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
