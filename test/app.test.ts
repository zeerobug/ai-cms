import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { MockProvider } from "../src/ai/mock.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/auth.js";
import { markdownToBlocks } from "../src/content/blocks.js";
import { openDb } from "../src/db.js";
import { TenantSettingsSchema } from "../src/tenancy.js";

/** Records which provider/key tenants with their own LLM settings resolve to. */
const factoryCalls: { name: string; apiKey: string | undefined }[] = [];
const { app, repo, ai } = createApp({
  db: openDb(":memory:"),
  provider: new MockProvider(),
  providerFactory: (name, apiKey) => {
    factoryCalls.push({ name, apiKey });
    // Like the real Claude provider, "anthropic" here can't generate images.
    return name === "anthropic" ? Object.assign(new MockProvider(), { generateImage: undefined }) : new MockProvider();
  },
});
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

type Session = { cookie: string; csrf: string };

/** Logs in through the admin JSON API; returns the session cookie and CSRF token. */
async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const { csrf } = await res.json();
  return { cookie, csrf };
}

/** Calls /admin/api<path> as the given session. */
function call(method: string, path: string, s: Session, body?: unknown) {
  return fetch(`${base}/admin/api${path}`, {
    method,
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const post = (path: string, s: Session, body: unknown = {}) => call("POST", path, s, body);
async function getJson<T = any>(path: string, s: Session): Promise<T> {
  const res = await call("GET", path, s);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Starts an AI job, waits for it, returns its id. */
async function runJob(path: string, s: Session, body: unknown) {
  const res = await post(path, s, body);
  assert.equal(res.status, 202, await res.clone().text());
  const { jobId } = await res.json();
  await ai.wait(jobId);
  return jobId as number;
}
const jobResult = (tenantId: number, jobId: number) => JSON.parse(repo.job(tenantId, jobId)!.result!);

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

test("AI article is published directly when tenant policy allows", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const jobId = await runJob("/t/open/ai/article", s, { topic: "sourdough baking at home", publish: true });
  const job = await getJson(`/t/open/jobs/${jobId}`, s);
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
  const result = jobResult(strict.id, await runJob("/t/strict/ai/article", s, { topic: "kubernetes cost control", publish: true }));
  assert.equal(result.status, "review");
  assert.equal((await fetch(`${base}/s/strict/a/${result.slug}`)).status, 404);
});

test("authors cannot auto-publish even on permissive tenants", async () => {
  const s = await login("author@x.com", "pw-author-1");
  const jobId = await runJob("/t/open/ai/article", s, { topic: "indoor plants", publish: true });
  assert.equal(jobResult(open.id, jobId).status, "review");
  const info = await getJson("/t/open", s);
  assert.equal(info.role, "author");
  assert.equal(info.ai.canAutoPublish, false);
  assert.equal(info.can["settings.manage"], false);
  assert.equal((await call("GET", "/t/open/settings", s)).status, 403);
});

test("AI can design an article-specific look", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const result = jobResult(open.id, await runJob("/t/open/ai/article", s, { topic: "deep sea creatures", publish: true, designLook: true, designBrief: "dark ocean mood" }));
  assert.ok(result.themeId);
  const page = await (await fetch(`${base}/s/open/a/${result.slug}`)).text();
  assert.ok(page.includes("--bg:#0b0f19"), "article renders with its own AI theme");
});

test("AI theme is applied only when policy allows", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  assert.equal(jobResult(open.id, await runJob("/t/open/ai/theme", s, { prompt: "retro 70s magazine", apply: true })).applied, true);
  assert.ok((await (await fetch(`${base}/s/open`)).text()).includes("home-magazine"));

  const before = repo.tenantById(strict.id)!.active_theme_id;
  assert.equal(jobResult(strict.id, await runJob("/t/strict/ai/theme", s, { prompt: "dark neon tech", apply: true })).applied, false);
  assert.equal(repo.tenantById(strict.id)!.active_theme_id, before);
});

test("themes can be built from a palette, manually or by the AI", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const res = await post("/t/open/themes/palette", s, { palette: "--primary: #123abc;\n--accent: #ff8800;\n#fbfaf7", name: "Paletted" });
  assert.equal(res.status, 201);
  assert.match((await res.json()).message, /created from 3 colors/);
  const manual = repo.themes(open.id).find((t) => t.name === "Paletted")!;
  const spec = repo.themeSpec(manual);
  assert.equal(spec.colors.primary, "#123abc");
  assert.equal(spec.colors.accent, "#ff8800");
  assert.equal(spec.colors.background, "#fbfaf7");

  const bad = await post("/t/open/themes/palette", s, { palette: "nothing useful" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /No colors found/);

  const jobId = await runJob("/t/open/ai/theme", s, { prompt: "dark neon tech", palette: '{"primary":"#00ff99","background":"#050505"}' });
  const ai1 = repo.themeSpec(repo.theme(open.id, jobResult(open.id, jobId).themeId));
  assert.equal(ai1.colors.primary, "#00ff99", "pinned palette roles survive the AI");
  assert.equal(ai1.colors.background, "#050505");
});

test("articles: create, edit, publish, delete through the admin API", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const created = await post("/t/open/articles", s, { title: "Hand written", markdown: "## Hello\n\nBody text", tags: "one, two", status: "draft" });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const detail = await getJson(`/t/open/articles/${id}`, s);
  assert.equal(detail.title, "Hand written");
  assert.deepEqual(detail.tags, ["one", "two"]);
  assert.ok(detail.markdown.includes("## Hello"));
  assert.equal((await call("PUT", `/t/open/articles/${id}`, s, { ...detail, title: "Hand written v2" })).status, 200);
  assert.equal((await post(`/t/open/articles/${id}/status`, s, { status: "published" })).status, 200);
  assert.equal((await fetch(`${base}/s/open/a/hand-written`)).status, 200);
  assert.equal((await fetch(`${base}/admin/open/articles/${id}/preview`, { headers: { cookie: s.cookie } })).status, 200);
  assert.equal((await call("DELETE", `/t/open/articles/${id}`, s)).status, 200);
  assert.equal(repo.article(open.id, id), undefined);
});

test("tenants are isolated", async () => {
  repo.createArticle(strict.id, { title: "Strict only", blocks: markdownToBlocks("secret"), status: "published", source: "human" });
  assert.equal((await fetch(`${base}/s/strict/a/strict-only`)).status, 200);
  assert.equal((await fetch(`${base}/s/open/a/strict-only`)).status, 404);
  const s = await login("out@x.com", "pw-out-1");
  assert.equal((await call("GET", "/t/open", s)).status, 403);
  assert.equal((await call("GET", "/t/open/articles", s)).status, 403);
  const strictArticle = repo.articles(strict.id)[0];
  const owner = await login("owner@x.com", "pw-owner-1");
  assert.equal((await call("GET", `/t/open/articles/${strictArticle.id}`, owner)).status, 404, "ids from another tenant don't resolve");
});

test("admin API requires a session, CSRF token and JSON", async () => {
  const anon = await fetch(`${base}/admin/api/t/open`);
  assert.equal(anon.status, 401);
  const s = await login("owner@x.com", "pw-owner-1");
  assert.equal((await post("/t/open/ai/article", { cookie: s.cookie, csrf: "nope" }, { topic: "x y z" })).status, 403);
  assert.equal((await call("DELETE", "/t/open/themes/1", { cookie: s.cookie, csrf: "nope" })).status, 403);
  const form = await fetch(`${base}/admin/api/t/open/ai/article`, {
    method: "POST",
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/x-www-form-urlencoded" },
    body: "topic=hello+world",
  });
  assert.equal(form.status, 415);
  const session = await getJson("/session", s);
  assert.equal(session.user.email, "owner@x.com");
  assert.equal(session.csrf, s.csrf);
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

test("admin API pages return data", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  for (const p of ["/sites", "/t/open", "/t/open/dashboard", "/t/open/articles", "/t/open/articles/new", "/t/open/themes", "/t/open/settings"]) await getJson(p, s);
  for (const p of ["/s/open", "/s/open/feed.xml"]) assert.equal((await fetch(base + p)).status, 200, p);
});

test("tenant LLM provider and API key: stored encrypted, used for jobs, platform default otherwise", async () => {
  const t = repo.createTenant({ slug: "byok", name: "BYOK", ownerId: users.owner });
  const s = await login("owner@x.com", "pw-owner-1");
  const settings = await getJson("/t/byok/settings", s);
  const save = (ai: object, extra: object = {}) => call("PUT", "/t/byok/settings", s, { name: "BYOK", tagline: "", domain: null, ai: { ...settings.ai, ...ai }, ...extra });

  // Default: platform provider, factory not used.
  assert.equal(settings.ai.provider, "default");
  factoryCalls.length = 0;
  await runJob("/t/byok/ai/article", s, { topic: "platform default provider" });
  assert.equal(factoryCalls.length, 0);

  // Choose Anthropic with the site's own key.
  const key = "sk-ant-tenant-secret-1234";
  assert.equal((await save({ provider: "anthropic" }, { apiKey: key })).status, 200);
  const tn = repo.tenantById(t.id)!;
  assert.equal(tn.settings.ai.provider, "anthropic");
  assert.equal(tn.hasAiKey, true);
  assert.ok(!JSON.stringify(tn).includes(key), "key is not in tenant settings");
  assert.ok(!repo.tenantAiKey(t.id)!.includes(key), "key is encrypted at rest");
  const raw = await (await call("GET", "/t/byok/settings", s)).text();
  assert.ok(!raw.includes(key) && raw.includes("…1234"), "settings API only returns a masked key");

  await runJob("/t/byok/ai/article", s, { topic: "tenant key provider" });
  assert.deepEqual(factoryCalls, [{ name: "anthropic", apiKey: key }]);

  // Saving again without a key keeps it; clearing falls back to the platform key.
  await save({ provider: "anthropic" });
  assert.equal(repo.tenantById(t.id)!.hasAiKey, true);
  await save({ provider: "anthropic" }, { clearKey: true });
  assert.equal(repo.tenantById(t.id)!.hasAiKey, false);
  factoryCalls.length = 0;
  await runJob("/t/byok/ai/article", s, { topic: "platform key fallback" });
  assert.deepEqual(factoryCalls, [{ name: "anthropic", apiKey: undefined }]);

  // Switch to OpenAI with its own key; the provider list offers it.
  assert.ok(settings.providers.some((p: { value: string }) => p.value === "openai"));
  const oaKey = "sk-proj-openai-secret-5678";
  assert.equal((await save({ provider: "openai" }, { apiKey: oaKey })).status, 200);
  factoryCalls.length = 0;
  await runJob("/t/byok/ai/article", s, { topic: "openai tenant key" });
  assert.deepEqual(factoryCalls, [{ name: "openai", apiKey: oaKey }]);
  assert.equal((await getJson("/t/byok/settings", s)).apiKey.masked.endsWith("5678"), true);

  // Undecryptable key (e.g. APP_SECRET changed) is rejected up front.
  repo.setTenantAiKey(t.id, "v1:garbage");
  const res = await post("/t/byok/ai/article", s, { topic: "broken key" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /can't be decrypted/);
});

// ---- images ------------------------------------------------------------------

const PNG = (await new MockProvider().generateImage({ prompt: "fixture", aspect: "square" })).value.data;

function uploadImage(tenant: string, s: Session, body: Uint8Array | string, type = "image/png", alt = "") {
  return fetch(`${base}/admin/api/t/${tenant}/media${alt ? `?alt=${encodeURIComponent(alt)}` : ""}`, {
    method: "POST",
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": type },
    body: body as BodyInit,
  });
}

test("images: upload, serve publicly on every host, reject non-images, list and delete", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const res = await uploadImage("open", s, PNG, "image/png", "A gradient");
  assert.equal(res.status, 201, await res.clone().text());
  const item = await res.json();
  assert.match(item.url, /^\/media\/open\/[A-Za-z0-9_-]{16}\.png$/);
  assert.equal(item.alt, "A gradient");
  assert.equal(item.source, "upload");

  const file = await fetch(base + item.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(PNG));
  assert.equal((await getWithHost(item.url, "open.example.com")).status, 200, "works on custom domains too");

  // The declared type isn't trusted: an SVG (or anything else) sent as image/png is refused.
  const svg = await uploadImage("open", s, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  assert.equal(svg.status, 415);
  assert.equal((await uploadImage("open", s, PNG, "text/plain")).status, 415, "non-image content types still need JSON");
  assert.equal((await uploadImage("open", { cookie: s.cookie, csrf: "nope" }, PNG)).status, 403, "CSRF applies to uploads");
  const big = await uploadImage("open", s, new Uint8Array(9 * 1024 * 1024));
  assert.equal(big.status, 413);

  const list = await getJson("/t/open/media", s);
  assert.ok(list.some((m: { id: number }) => m.id === item.id));
  assert.equal((await call("DELETE", `/t/open/media/${item.id}`, s)).status, 200);
  assert.equal((await fetch(base + item.url)).status, 404);
});

test("images are tenant-isolated", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const item = await (await uploadImage("strict", s, PNG)).json();
  assert.equal((await fetch(base + item.url)).status, 200);
  assert.equal((await fetch(base + item.url.replace("/strict/", "/open/"))).status, 404, "file only resolves under its own tenant");
  assert.equal((await call("DELETE", `/t/open/media/${item.id}`, s)).status, 404, "ids from another tenant don't resolve");
  assert.ok(!(await getJson("/t/open/media", s)).some((m: { id: number }) => m.id === item.id));
  const outsider = await login("out@x.com", "pw-out-1");
  assert.equal((await uploadImage("open", outsider, PNG)).status, 403);
  const author = await login("author@x.com", "pw-author-1");
  assert.equal((await call("DELETE", `/t/strict/media/${item.id}`, author)).status, 403);
});

test("images: AI generation stores into the library and respects the monthly limit", async () => {
  const t = repo.createTenant({ slug: "pics", name: "Pics", ownerId: users.owner });
  repo.updateTenant(t.id, { name: t.name, tagline: "", domain: null, settings: TenantSettingsSchema.parse({ ai: { images: { monthlyLimit: 1 } } }) });
  const s = await login("owner@x.com", "pw-owner-1");
  assert.equal((await getJson("/t/pics", s)).ai.imageProvider, "mock");
  const res = await post("/t/pics/media/generate", s, { prompt: "a misty harbour at dawn", aspect: "landscape", alt: "Harbour" });
  assert.equal(res.status, 201, await res.clone().text());
  const item = await res.json();
  assert.equal(item.source, "ai");
  assert.equal(item.prompt, "a misty harbour at dawn");
  assert.equal((await fetch(base + item.url)).headers.get("content-type"), "image/png");
  const again = await post("/t/pics/media/generate", s, { prompt: "another one" });
  assert.equal(again.status, 429);
  assert.equal((await post("/t/pics/media/generate", s, { prompt: "" })).status, 400);
});

test("articles: cover image from upload or AI, shown on the article and on cards", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const item = await (await uploadImage("open", s, PNG)).json();
  const created = await post("/t/open/articles", s, { title: "With a cover", markdown: "Body", status: "published", imageUrl: item.url, imageAlt: "Cover alt" });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const detail = await getJson(`/t/open/articles/${id}`, s);
  assert.equal(detail.imageUrl, item.url);
  assert.equal(detail.imageAlt, "Cover alt");
  const page = await (await fetch(`${base}/s/open/a/with-a-cover`)).text();
  assert.ok(page.includes(`<img src="${item.url}" alt="Cover alt">`));
  assert.ok((await (await fetch(`${base}/s/open`)).text()).includes(`class="card-img" src="${item.url}"`));

  const bad = await call("PUT", `/t/open/articles/${id}`, s, { ...detail, imageUrl: "javascript:alert(1)" });
  assert.equal(bad.status, 400);
  assert.equal((await call("PUT", `/t/open/articles/${id}`, s, { ...detail, imageUrl: "" })).status, 200);
  assert.equal((await getJson(`/t/open/articles/${id}`, s)).imageUrl, "");

  const result = jobResult(open.id, await runJob("/t/open/ai/article", s, { topic: "lighthouses of brittany", publish: true, coverImage: true }));
  assert.match(result.imageUrl, /^\/media\/open\//);
  assert.ok((await (await fetch(`${base}/s/open/a/${result.slug}`)).text()).includes(`<figure class="cover"><img src="${result.imageUrl}"`));
});

test("themes: hero image set from the library or by the AI theme job", async () => {
  const s = await login("owner@x.com", "pw-owner-1");
  const item = await (await uploadImage("open", s, PNG)).json();
  const active = repo.tenantById(open.id)!.active_theme_id!;
  assert.equal((await call("PUT", `/t/open/themes/${active}/hero-image`, s, { url: item.url })).status, 200);
  assert.equal((await getJson(`/t/open/themes/${active}`, s)).heroImageUrl, item.url);
  const home = await (await fetch(`${base}/s/open`)).text();
  assert.ok(home.includes("hero-image") && home.includes(`url('${item.url}')`));
  assert.equal((await call("PUT", `/t/open/themes/${active}/hero-image`, s, { url: "https://x.com/a.png');x:url('" })).status, 400);
  assert.equal((await call("PUT", `/t/open/themes/${active}/hero-image`, s, { url: null })).status, 200);
  assert.ok(!(await (await fetch(`${base}/s/open`)).text()).includes(item.url));

  const result = jobResult(open.id, await runJob("/t/open/ai/theme", s, { prompt: "sunny seaside", heroImage: true }));
  const spec = repo.themeSpec(repo.theme(open.id, result.themeId));
  assert.equal(spec.hero.style, "image");
  assert.match(spec.hero.imageUrl, /^\/media\/open\//);
});

test("images: sites on a text-only provider (Claude) get a clear error, and AI articles still succeed", { skip: config.platformOpenAiImages && "OPENAI_API_KEY is set" }, async () => {
  const t = repo.createTenant({ slug: "claude-only", name: "Claude only", ownerId: users.owner });
  repo.updateTenant(t.id, { name: t.name, tagline: "", domain: null, settings: TenantSettingsSchema.parse({ ai: { provider: "anthropic" } }) });
  const s = await login("owner@x.com", "pw-owner-1");
  assert.equal((await getJson("/t/claude-only", s)).ai.imageProvider, null);
  const res = await post("/t/claude-only/media/generate", s, { prompt: "a forest" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Claude only writes text/);
  assert.equal((await uploadImage("claude-only", s, PNG)).status, 201, "uploads always work");

  const result = jobResult(t.id, await runJob("/t/claude-only/ai/article", s, { topic: "mushroom foraging", coverImage: true }));
  assert.equal(result.imageUrl, null);
  assert.match(result.message, /Cover image skipped/);
  assert.ok(repo.article(t.id, result.articleId));
});
