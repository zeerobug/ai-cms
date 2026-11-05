import { z } from "zod";
import { escapeHtml, safeUrl } from "../util/html.js";

/**
 * Articles are stored as an array of typed content blocks rather than raw HTML.
 * This gives us:
 *  - safe rendering (no arbitrary HTML from users or the AI),
 *  - a format the AI can produce reliably via structured outputs,
 *  - one renderer that every theme styles the same way.
 *
 * Text fields support a small inline-markdown subset: **bold**, *italic*, `code`, [link](url).
 */
export const BlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.number().int().describe("2 or 3"), text: z.string() }),
  z.object({ type: z.literal("paragraph"), text: z.string() }),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal("quote"), text: z.string(), cite: z.string().describe("May be empty") }),
  z.object({ type: z.literal("code"), language: z.string(), code: z.string() }),
  z.object({ type: z.literal("callout"), tone: z.enum(["info", "tip", "warning"]), text: z.string() }),
  z.object({
    type: z.literal("image"),
    url: z.string(),
    alt: z.string(),
    caption: z.string().describe("May be empty"),
  }),
  z.object({ type: z.literal("divider") }),
]);
export type Block = z.infer<typeof BlockSchema>;
export const BlocksSchema = z.array(BlockSchema);

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

export function renderInline(src: string): string {
  const codes: string[] = [];
  let s = escapeHtml(src).replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => {
      const url = safeUrl(unescapeAttr(href));
      return url ? `<a href="${escapeHtml(url)}">${text}</a>` : text;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

function unescapeAttr(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// Blocks -> HTML (theme-agnostic markup; themes style these classes)
// ---------------------------------------------------------------------------

export function renderBlocks(blocks: Block[]): string {
  return blocks.map(renderBlock).join("\n");
}

function renderBlock(b: Block): string {
  switch (b.type) {
    case "heading": {
      const lvl = b.level <= 2 ? 2 : 3;
      return `<h${lvl} id="${slugify(b.text)}">${renderInline(b.text)}</h${lvl}>`;
    }
    case "paragraph":
      return `<p>${renderInline(b.text)}</p>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${tag}>`;
    }
    case "quote":
      return `<blockquote><p>${renderInline(b.text)}</p>${b.cite ? `<cite>${escapeHtml(b.cite)}</cite>` : ""}</blockquote>`;
    case "code":
      return `<pre class="code"><code data-lang="${escapeHtml(b.language)}">${escapeHtml(b.code)}</code></pre>`;
    case "callout":
      return `<aside class="callout callout-${b.tone}">${renderInline(b.text)}</aside>`;
    case "image": {
      const url = safeUrl(b.url);
      if (!url) return "";
      return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(b.alt)}" loading="lazy">${
        b.caption ? `<figcaption>${renderInline(b.caption)}</figcaption>` : ""
      }</figure>`;
    }
    case "divider":
      return `<hr>`;
  }
}

// ---------------------------------------------------------------------------
// Markdown <-> Blocks (so humans can edit comfortably in the admin)
// ---------------------------------------------------------------------------

const CALLOUT_RE = /^\[!(INFO|NOTE|TIP|WARNING)\]\s*/i;

export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", text: para.join(" ").trim() });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^```(\w*)/))) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i]);
      blocks.push({ type: "code", language: m[1] || "text", code: code.join("\n") });
    } else if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      blocks.push({ type: "heading", level: m[1].length <= 2 ? 2 : 3, text: m[2].trim() });
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      flush();
      blocks.push({ type: "divider" });
    } else if ((m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/))) {
      flush();
      blocks.push({ type: "image", alt: m[1], url: m[2], caption: m[3] ?? "" });
    } else if (t.startsWith(">")) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        q.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      let text = q.join(" ").trim();
      const cm = text.match(CALLOUT_RE);
      if (cm) {
        const kind = cm[1].toUpperCase();
        const tone = kind === "WARNING" ? "warning" : kind === "TIP" ? "tip" : "info";
        blocks.push({ type: "callout", tone, text: text.replace(CALLOUT_RE, "") });
      } else {
        let cite = "";
        const cit = text.match(/\s+—\s+([^—]+)$/);
        if (cit) {
          cite = cit[1].trim();
          text = text.slice(0, cit.index).trim();
        }
        blocks.push({ type: "quote", text, cite });
      }
    } else if (/^([-*+]|\d+[.)])\s+/.test(t)) {
      flush();
      const ordered = /^\d/.test(t);
      const items: string[] = [];
      while (i < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, ""));
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, items });
    } else {
      para.push(t);
    }
  }
  flush();
  return blocks;
}

export function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading":
          return `${b.level <= 2 ? "##" : "###"} ${b.text}`;
        case "paragraph":
          return b.text;
        case "list":
          return b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join("\n");
        case "quote":
          return `> ${b.text}${b.cite ? ` — ${b.cite}` : ""}`;
        case "code":
          return "```" + b.language + "\n" + b.code + "\n```";
        case "callout":
          return `> [!${b.tone.toUpperCase()}] ${b.text}`;
        case "image":
          return `![${b.alt}](${b.url}${b.caption ? ` "${b.caption}"` : ""})`;
        case "divider":
          return "---";
      }
    })
    .join("\n\n");
}

export function plainText(blocks: Block[]): string {
  return blocks
    .map((b) => ("text" in b ? b.text : "items" in b ? b.items.join(" ") : ""))
    .join(" ")
    .replace(/[*`[\]]/g, "");
}

export function readingMinutes(blocks: Block[]): number {
  return Math.max(1, Math.round(plainText(blocks).split(/\s+/).length / 220));
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}
