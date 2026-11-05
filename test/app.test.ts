import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { MockProvider } from "../src/ai/mock.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { markdownToBlocks } from "../src/content/blocks.js";
import { openDb } from "../src/db.js";
import { TenantSettingsSchema } from "../src/tenancy.js";

const { app, repo, ai } = createApp({ db: openDb(":memory:"), provider: new MockProvider() });
let base = "";
let server: ReturnType<typeof app.listen>;

const users = {
  owner: repo.createUser("owner@x.com", "Owner", hashPassword("pw-owner-1")),
  author: repo.createUser("author@x.com", "Author", hashPassword("pw-author-1")),
  outsider: repo.createUser("out@x.com", "Out", hashPassword("pw-out-1")),
};
const open = repo.createTenant({ slug: "open", name: "Open Site", ownerId: users.owner });
const strict = repo.createTenant({ slug: "strict", name: "Strict Site", ownerId: users.owner });
repo.setMembership(users.author, open.id, "author");
repo.updateTenant(open.id, {
  name: open.name,
  tagline: "",
  domain: "open.example.com",
  settings: TenantSettingsSchema.parse({ ai: { articles: { autoPublish: true }, themes: { autoApply: true } } }),
});

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function login(email: string, password: string) {
  const res = await fetch(`${base}/admin/login`, {
    method: "POST",
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1];
  return { cookie, csrf };
}

function post(path: string, s: { cookie: string; csrf: string }, body: Record<string, string>) {
  return fetch(base + path, {
    method: "POST",
    headers: { cookie: s.cookie },
    body: new URLSearchParams({ _csrf: s.csrf, ...body }),
    redirect: "manual",
  });
}

/** fetch() can't override Host, so use node:http for host-based tenancy checks. */
function getWithHost(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const jobIdFrom = (res: Response) => Number(/\/jobs\/(\d+)/.exec(res.headers.get("location") ?? "")![1]);

test("AI article is published directly when tenant policy allows", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const res = await post("/admin/open/ai/article", s, { topic: "sourdough baking at home", publish: "on" });
  assert.equal(res.status, 303);
  const jobId = jobIdFrom(res);
  await ai.wait(jobId);
  const job = await (await fetch(`${base}/admin/open/jobs/${jobId}.json`, { headers: { cookie: s.cookie } })).json();
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.status, "published");
  const page = await (await fetch(`${base}/s/open/a/${job.result.slug}`)).text();
  assert.ok(page.includes("sourdough baking at home"));
  // Host-based tenancy via custom domain serves the same article at the root.
  const viaHost = await getWithHost(`/a/${job.result.slug}`, "open.example.com");
  assert.equal(viaHost.status, 200);
  assert.ok(!viaHost.body.includes('/s/open'), "links have no /s/ prefix on custom domains");
});

test("AI article goes to review when tenant policy requires it", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const jobId = jobIdFrom(await post("/admin/strict/ai/article", s, { topic: "kubernetes cost control", publish: "on" }));
  await ai.wait(jobId);
  const job = repo.job(strict.id, jobId)!;
  const result = JSON.parse(job.result!);
  assert.equal(result.status, "review");
  assert.equal((await fetch(`${base}/s/strict/a/${result.slug}`)).status, 404);
});

test("authors cannot auto-publish even on permissive tenants", async () => {
  const s = await login("author@x.com", "pw-author-1");
  const jobId = jobIdFrom(await post("/admin/open/ai/article", s, { topic: "indoor plants", publish: "on" }));
  await ai.wait(jobId);
  assert.equal(JSON.parse(repo.job(open.id, jobId)!.result!).status, "review");
});

test("AI can design an article-specific look", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const jobId = jobIdFrom(await post("/admin/open/ai/article", s, { topic: "deep sea creatures", publish: "on", designLook: "on", designBrief: "dark ocean mood" }));
  await ai.wait(jobId);
  const result = JSON.parse(repo.job(open.id, jobId)!.result!);
  assert.ok(result.themeId);
  const page = await (await fetch(`${base}/s/open/a/${result.slug}`)).text();
  assert.ok(page.includes("--bg:#0b0f19"), "article renders with its own AI theme");
});

test("AI theme is applied only when policy allows", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const j1 = jobIdFrom(await post("/admin/open/ai/theme", s, { prompt: "retro 70s magazine", apply: "on" }));
  await ai.wait(j1);
  const r1 = JSON.parse(repo.job(open.id, j1)!.result!);
  assert.equal(r1.applied, true);
  assert.ok((await (await fetch(`${base}/s/open`)).text()).includes("home-magazine"));

  const before = repo.tenantById(strict.id)!.active_theme_id;
  const j2 = jobIdFrom(await post("/admin/strict/ai/theme", s, { prompt: "dark neon tech", apply: "on" }));
  await ai.wait(j2);
  assert.equal(JSON.parse(repo.job(strict.id, j2)!.result!).applied, false);
  assert.equal(repo.tenantById(strict.id)!.active_theme_id, before);
});

test("tenants are isolated", async () => {
  repo.createArticle(strict.id, { title: "Strict only", blocks: markdownToBlocks("secret"), status: "published", source: "human" });
  assert.equal((await fetch(`${base}/s/strict/a/strict-only`)).status, 200);
  assert.equal((await fetch(`${base}/s/open/a/strict-only`)).status, 404);
  const s = await login("out@x.com", "pw-out-1");
  assert.equal((await fetch(`${base}/admin/open`, { headers: { cookie: s.cookie } })).status, 403);
});

test("CSRF token is required for admin POSTs", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const res = await post("/admin/open/ai/article", { cookie: s.cookie, csrf: "nope" }, { topic: "x y z" });
  assert.equal(res.status, 403);
});

test("REST API: token auth, AI article with wait, role limits", async () => {
  const editorTok = repo.createApiToken(open.id, "ci", "editor");
  const authorTok = repo.createApiToken(open.id, "bot", "author");
  assert.equal((await fetch(`${base}/api/v1/articles`)).status, 401);

  const res = await fetch(`${base}/api/v1/ai/articles?wait=1`, {
    method: "POST",
    headers: { authorization: `Bearer ${editorTok}`, "content-type": "application/json" },
    body: JSON.stringify({ topic: "electric bikes in winter", publish: true }),
  });
  const job = await res.json();
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.status, "published");

  const themeRes = await fetch(`${base}/api/v1/ai/themes`, {
    method: "POST",
    headers: { authorization: `Bearer ${authorTok}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "minimal" }),
  });
  assert.equal(themeRes.status, 403);

  const bad = await fetch(`${base}/api/v1/ai/articles`, {
    method: "POST",
    headers: { authorization: `Bearer ${editorTok}`, "content-type": "application/json" },
    body: JSON.stringify({ topic: "" }),
  });
  assert.equal(bad.status, 400);

  const list = await (await fetch(`${base}/api/v1/articles?status=published`, { headers: { authorization: `Bearer ${editorTok}` } })).json();
  assert.ok(list.some((a: { title: string }) => a.title.includes("electric bikes")));
});

test("monthly AI limit is enforced", async () => {
  const t = repo.createTenant({ slug: "limited", name: "Limited", ownerId: users.owner });
  repo.updateTenant(t.id, { name: t.name, tagline: "", domain: null, settings: TenantSettingsSchema.parse({ ai: { articles: { monthlyLimit: 1 } } }) });
  const tok = repo.createApiToken(t.id, "x", "owner");
  const call = () =>
    fetch(`${base}/api/v1/ai/articles?wait=1`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ topic: "one two three" }),
    });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
});

test("admin pages render", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  for (const p of ["/admin/open", "/admin/open/articles", "/admin/open/design", "/admin/open/settings", "/s/open", "/s/open/feed.xml"]) {
    const res = await fetch(base + p, { headers: { cookie: s.cookie } });
    assert.equal(res.status, 200, p);
  }
});
