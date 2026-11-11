/**
 * Writes a site's static export to a folder (to inspect it, or to upload it to any static host).
 *   pnpm export <site-slug> [out-dir] [--url https://blog.example.com]
 * --url is the address the files will be served at (canonical links, sitemap, feed); it defaults
 * to the site's custom domain, else http://localhost:8080. Serve the folder at the root of a domain.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "./db.js";
import { buildStaticSite } from "./publish/static.js";
import { Repo } from "./repo.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { url: { type: "string" } } });
const [slug, outArg] = positionals;
if (!slug) {
  console.error("Usage: pnpm export <site-slug> [out-dir] [--url https://blog.example.com]");
  process.exit(1);
}
const repo = new Repo(openDb());
const tenant = repo.tenantBySlug(slug);
if (!tenant) {
  console.error(`No site with slug "${slug}".`);
  process.exit(1);
}
const url = values.url ?? (tenant.domain ? `https://${tenant.domain}` : "http://localhost:8080");
if (!/^https?:\/\/[^/]+/.test(url)) {
  console.error("--url must be an absolute http(s) URL.");
  process.exit(1);
}
const out = path.resolve(outArg ?? `dist/sites/${slug}`);
fs.rmSync(out, { recursive: true, force: true });
const files = buildStaticSite(repo, tenant, url);
for (const f of files) {
  const dest = path.join(out, f.path);
  if (!dest.startsWith(out + path.sep)) throw new Error(`Unsafe path in export: ${f.path}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.data);
}
console.log(`Exported ${files.length} files for "${tenant.name}" to ${out} (canonical URL: ${url}).`);
