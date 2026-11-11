import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { MockProvider } from "../src/ai/mock.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { markdownToBlocks } from "../src/content/blocks.js";
import { openDb } from "../src/db.js";
import { NetlifyClient, type NetlifyApi } from "../src/publish/netlify.js";
import { buildStaticSite, sha1, type StaticFile } from "../src/publish/static.js";

// A 1×1 PNG.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3f8c1b80000000049454e44ae426082", "hex");

/** In-memory Netlify: remembers file hashes across deploys, like the real digest API. */
class FakeNetlify implements NetlifyApi {
  known = new Set<string>();
  deploys: { siteId: string; files: Map<string, Buffer>; uploaded: number }[] = [];
  tokens: string[] = [];
  fail: string | null = null;
  async site(siteId: string) {
    if (this.fail) throw new Error(this.fail);
    return { id: "uuid-" + siteId, name: siteId, url: `https://${siteId}.netlify.app` };
  }
  async deploy(siteId: string, files: StaticFile[]) {
    const fresh = files.filter((f) => !this.known.has(sha1(f.data)));
    fresh.forEach((f) => this.known.add(sha1(f.data)));
    this.deploys.push({ siteId, files: new Map(files.map((f) => [f.path, f.data])), uploaded: fresh.length });
    return { id: `d${this.deploys.length}`, deployUrl: "", uploaded: fresh.length };
  }
}

const netlify = new FakeNetlify();
const { app, repo, publish } = createApp({
  db: openDb(":memory:"),
  provider: new MockProvider(),
  netlify: (token) => (netlify.tokens.push(token), netlify),
  publishDebounceMs: 5,
});
const users = {
  owner: repo.createUser("owner@p.com", "Owner", hashPassword("pw-owner-1")),
  editor: repo.createUser("editor@p.com", "Editor", hashPassword("pw-editor-1")),
  author: repo.createUser("author@p.com", "Author", hashPassword("pw-author-1")),
};
const site = repo.createTenant({ slug: "static", name: "Static Site", ownerId: users.owner });
const other = repo.createTenant({ slug: "other", name: "Other", ownerId: users.owner });
repo.setMembership(users.editor, site.id, "editor");
repo.setMembership(users.author, site.id, "author");

let base = "";
let server: ReturnType<typeof app.listen>;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

type Session = { cookie: string; csrf: string };
async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0], csrf: (await res.json()).csrf };
}
const call = (method: string, path: string, s: Session, body?: unknown) =>
  fetch(`${base}/admin/api${path}`, {
    method,
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("static export: pages, feed, sitemap, used images only, root-relative links", () => {
  const used = repo.createMedia(site.id, { data: PNG, type: { mime: "image/png", ext: "png" }, alt: "", source: "upload" });
  repo.createMedia(site.id, { data: PNG, type: { mime: "image/png", ext: "png" }, alt: "", source: "upload" }); // unused
  const foreign = repo.createMedia(other.id, { data: PNG, type: { mime: "image/png", ext: "png" }, alt: "", source: "upload" });
  repo.createArticle(site.id, {
    title: "Hello static",
    blocks: markdownToBlocks(`Body text.\n\n![other](/media/other/${foreign.file})`),
    tags: ["news", "c#"],
    status: "published",
    source: "human",
    image: { url: `/media/static/${used.file}`, alt: "cover" },
  });
  repo.createArticle(site.id, { title: "Secret draft", blocks: markdownToBlocks("draft"), status: "draft", source: "human" });

  const files = new Map(buildStaticSite(repo, repo.tenantById(site.id)!, "https://static.netlify.app/").map((f) => [f.path, f.data.toString("utf8")]));
  for (const p of ["/index.html", "/a/hello-static.html", "/tag/news.html", "/404.html", "/feed.xml", "/sitemap.xml", "/robots.txt", "/_redirects", "/_headers"])
    assert.ok(files.has(p), `missing ${p}`);
  assert.ok(!files.has("/a/secret-draft.html"), "drafts are not exported");
  assert.ok(![...files.keys()].some((p) => p.includes("#")), "tags that aren't valid file names are skipped");
  assert.ok(files.has(`/media/static/${used.file}`), "used image is copied");
  assert.equal([...files.keys()].filter((p) => p.startsWith("/media/")).length, 1, "unused and other tenants' images are not copied");
  const home = files.get("/index.html")!;
  assert.match(home, /href="\/a\/hello-static"/);
  assert.doesNotMatch(home, /\/s\/static/);
  assert.match(files.get("/a/hello-static.html")!, /<link rel="canonical" href="https:\/\/static\.netlify\.app\/a\/hello-static">/);
  assert.match(files.get("/sitemap.xml")!, /https:\/\/static\.netlify\.app\/a\/hello-static/);
  assert.match(files.get("/_redirects")!, /\/a\/:slug\s+\/a\/:slug\.html\s+200/);
});

test("publishing settings: owner configures, token is encrypted and masked, others can't configure", async () => {
  const owner = await login("owner@p.com", "pw-owner-1");
  const editor = await login("editor@p.com", "pw-editor-1");
  const author = await login("author@p.com", "pw-author-1");

  let data = await (await call("GET", "/t/static/publish", owner)).json();
  assert.equal(data.ready, false);
  assert.match(data.reason, /site ID/);

  assert.equal((await call("PUT", "/t/static/publish", owner, { netlifySiteId: "bad id/../x", auto: true })).status, 400);
  assert.equal((await call("PUT", "/t/static/publish", editor, { netlifySiteId: "my-site", auto: true, token: "nfp_x" })).status, 403);
  assert.equal((await call("GET", "/t/static/publish", author)).status, 403);
  assert.equal((await call("POST", "/t/static/publish/deploy", owner, {})).status, 409, "can't deploy before setup");

  const res = await call("PUT", "/t/static/publish", owner, { netlifySiteId: "my-site", auto: true, token: "nfp_secret_token_1234" });
  assert.equal(res.status, 200);
  const stored = repo.tenantPublishToken(site.id)!;
  assert.ok(stored.startsWith("v1:") && !stored.includes("nfp_secret"), "token stored encrypted");
  assert.ok(!JSON.stringify(repo.tenantById(site.id)!.settings).includes("nfp_"), "token not in settings JSON");

  data = await (await call("GET", "/t/static/publish", editor)).json();
  assert.equal(data.ready, true);
  assert.equal(data.canConfigure, false);
  assert.equal(data.token.masked, "nfp_se…1234");
  assert.ok(!JSON.stringify(data).includes("nfp_secret_token_1234"));

  // Saving general settings keeps the publishing settings.
  const s = await (await call("GET", "/t/static/settings", owner)).json();
  assert.equal((await call("PUT", "/t/static/settings", owner, { ...s, apiKey: "" })).status, 200);
  assert.equal(repo.tenantById(site.id)!.settings.publish.netlifySiteId, "my-site");

  await publish.idle();
  assert.ok(netlify.deploys.length >= 1, "configuring with auto on deploys the site");
  assert.equal(netlify.tokens.at(-1), "nfp_secret_token_1234", "the decrypted token is used");
  const d = netlify.deploys.at(-1)!;
  assert.equal(d.siteId, "my-site");
  assert.ok(d.files.has("/a/hello-static.html"));
});

test("auto deploy: publishing an article redeploys; draft edits and unchanged exports are skipped", async () => {
  await publish.idle();
  const before = netlify.deploys.length;

  // A draft doesn't change the public site: no deploy.
  repo.createArticle(site.id, { title: "Another draft", blocks: markdownToBlocks("x"), status: "draft", source: "human" });
  await publish.idle();
  assert.equal(netlify.deploys.length, before, "draft edit doesn't deploy");

  // Publishing (via the admin API) deploys once, even after a burst of changes.
  const editor = await login("editor@p.com", "pw-editor-1");
  const id = repo.createArticle(site.id, { title: "Fresh news", blocks: markdownToBlocks("news"), status: "review", source: "human" });
  assert.equal((await call("POST", `/t/static/articles/${id}/status`, editor, { status: "published" })).status, 200);
  repo.updateTheme(site.id, repo.tenantById(site.id)!.active_theme_id!, { ...repo.activeTheme(repo.tenantById(site.id)!), name: "Renamed" });
  await publish.idle();
  assert.equal(netlify.deploys.length, before + 1);
  const d = netlify.deploys.at(-1)!;
  assert.ok(d.files.has("/a/fresh-news.html"));
  assert.ok(d.uploaded < d.files.size, "unchanged files (images) aren't uploaded again");

  const deploys = await (await call("GET", "/t/static/publish", editor)).json();
  assert.equal(deploys.deploys[0].status, "succeeded");
  assert.equal(deploys.deploys[0].trigger, "auto");
  assert.equal(deploys.siteUrl, "https://my-site.netlify.app");

  // Unpublishing removes the page on the next deploy.
  repo.setArticleStatus(site.id, id, "draft");
  await publish.idle();
  assert.ok(!netlify.deploys.at(-1)!.files.has("/a/fresh-news.html"));
});

test("manual deploy always deploys; failures are recorded; auto can be turned off", async () => {
  const owner = await login("owner@p.com", "pw-owner-1");
  await publish.idle();
  const before = netlify.deploys.length;
  const res = await call("POST", "/t/static/publish/deploy", owner, {});
  assert.equal(res.status, 202);
  const { deployId } = await res.json();
  await publish.idle();
  assert.equal(netlify.deploys.length, before + 1, "manual deploy runs even if nothing changed");
  assert.equal(repo.deploy(site.id, deployId)!.status, "succeeded");
  assert.equal(repo.deploy(other.id, deployId), undefined, "deploy records are tenant-scoped");

  netlify.fail = "Netlify API GET /sites/my-site: boom";
  const { deployId: failedId } = await (await call("POST", "/t/static/publish/deploy", owner, {})).json();
  await publish.idle();
  netlify.fail = null;
  const failed = repo.deploy(site.id, failedId)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /boom/);

  assert.equal((await call("PUT", "/t/static/publish", owner, { netlifySiteId: "my-site", auto: false })).status, 200);
  assert.ok(repo.tenantPublishToken(site.id), "saving without a token keeps it");
  const n = netlify.deploys.length;
  repo.createArticle(site.id, { title: "Quiet", blocks: markdownToBlocks("q"), status: "published", source: "human" });
  await publish.idle();
  assert.equal(netlify.deploys.length, n, "no automatic deploy when auto is off");
});

test("NetlifyClient: digest deploy uploads only required files and waits until ready", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let polls = 0;
  const files: StaticFile[] = [
    { path: "/index.html", data: Buffer.from("<h1>hi</h1>") },
    { path: "/tag/café.html", data: Buffer.from("tag") },
    { path: "/robots.txt", data: Buffer.from("User-agent: *") },
  ];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer tok");
    if (method === "GET" && url.endsWith("/sites/my-site")) return json({ id: "u1", name: "my-site", ssl_url: "https://blog.example.com" });
    if (method === "POST") return json({ id: "dep1", state: "preparing" });
    if (method === "GET" && url.includes("/deploys/dep1")) {
      polls++;
      if (polls === 1) return json({ id: "dep1", state: "prepared", required: [sha1(files[0].data), sha1(files[1].data)] });
      return json({ id: "dep1", state: polls < 3 ? "processing" : "ready", deploy_ssl_url: "https://dep1--my-site.netlify.app" });
    }
    if (method === "PUT") return json({});
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;

  const client = new NetlifyClient("tok", { fetch: fakeFetch, sleep: async () => {} });
  assert.deepEqual(await client.site("my-site"), { id: "u1", name: "my-site", url: "https://blog.example.com" });
  const res = await client.deploy("my-site", files);
  assert.equal(res.uploaded, 2);
  assert.equal(res.deployUrl, "https://dep1--my-site.netlify.app");
  const post = calls.find((c) => c.method === "POST")!;
  assert.deepEqual((post.body as { files: Record<string, string> }).files, Object.fromEntries(files.map((f) => [f.path, sha1(f.data)])));
  assert.deepEqual(
    calls.filter((c) => c.method === "PUT").map((c) => c.url),
    ["https://api.netlify.com/api/v1/deploys/dep1/files/index.html", "https://api.netlify.com/api/v1/deploys/dep1/files/tag/caf%C3%A9.html"],
  );

  const denied = new NetlifyClient("tok", { fetch: (async () => json({ message: "Access Denied" }, 401)) as unknown as typeof fetch, sleep: async () => {} });
  await assert.rejects(denied.site("my-site"), /access token/);
});
