/**
 * Creates two demo tenants with users and sample content.
 *   npm run seed
 */
import { hashPassword } from "./auth.js";
import { markdownToBlocks } from "./content/blocks.js";
import { openDb } from "./db.js";
import { Repo } from "./repo.js";
import { TenantSettingsSchema } from "./tenancy.js";

const repo = new Repo(openDb());
const PASSWORD = "password123";

function user(email: string, name: string) {
  return repo.userByEmail(email)?.id ?? repo.createUser(email, name, hashPassword(PASSWORD));
}

const admin = user("admin@example.com", "Admin");
const editor = user("editor@example.com", "Eddie Editor");
const author = user("author@example.com", "Ana Author");

if (!repo.tenantBySlug("demo")) {
  const t = repo.createTenant({ slug: "demo", name: "Demo Journal", tagline: "Ideas worth reading", ownerId: admin });
  repo.setMembership(editor, t.id, "editor");
  repo.setMembership(author, t.id, "author");
  // This tenant trusts the AI: editors+ can auto-publish articles and apply themes.
  repo.updateTenant(t.id, {
    name: t.name,
    tagline: t.tagline,
    domain: null,
    settings: TenantSettingsSchema.parse({ ai: { articles: { autoPublish: true }, themes: { autoApply: true } } }),
  });
  repo.createArticle(t.id, {
    title: "Welcome to your AI-powered CMS",
    summary: "What this site can do, in two minutes.",
    tags: ["meta", "getting-started"],
    status: "published",
    source: "human",
    authorId: admin,
    blocks: markdownToBlocks(`Every article on this site is stored as structured blocks and rendered by **one shared template engine**.

## Ask the AI to write
Go to the admin dashboard, type a topic and press *Write it*. Depending on this site's AI policy the article is published immediately or sent to the review queue.

## Ask the AI to design
On the **Design** page, describe the look you want — "a calm, zen look with serif headings" — and the AI produces a theme.

> [!TIP] Themes are just JSON specs, so any theme works with any content.

- Multi-tenant: each site has its own users, roles, content, themes and AI policy
- REST API with per-site tokens
- RSS feed at \`/feed.xml\``),
  });
  console.log("Created tenant 'demo' (AI may auto-publish)");
}

if (!repo.tenantBySlug("acme")) {
  const t = repo.createTenant({ slug: "acme", name: "Acme Engineering Blog", tagline: "Notes from the build", ownerId: admin });
  repo.setMembership(author, t.id, "author");
  // Default policy: AI articles always go to review, themes are never auto-applied.
  console.log("Created tenant 'acme' (AI output requires review)");
}

console.log(`\nLog in at http://localhost:3000/admin with any of:
  admin@example.com / ${PASSWORD}  (owner of both sites)
  editor@example.com / ${PASSWORD} (editor on demo)
  author@example.com / ${PASSWORD} (author on both)`);
