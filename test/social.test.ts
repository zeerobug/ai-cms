import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { MockProvider } from "../src/ai/mock.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { markdownToBlocks } from "../src/content/blocks.js";
import { openDb } from "../src/db.js";
import { composePost, hashtags, httpPoster, oauth1Header, type SocialPoster } from "../src/social/networks.js";

const article = { title: "Hello world", summary: "A short summary.", tags: ["news", "c#", "big data"] };

test("composePost: X fits 280 with the URL counted as 23; LinkedIn/Facebook keep the link out of the text", () => {
  assert.deepEqual(hashtags(["news", "c#", "big data", "", "a-b", "five"]), ["#news", "#c", "#bigdata", "#ab"]);
  const url = "https://example.com/a/hello-world";
  const x = composePost("x", article, url);
  assert.ok(x.startsWith("Hello world #news #c #bigdata"));
  assert.ok(x.endsWith(`\n\n${url}`));

  const long = composePost("x", { ...article, title: "T".repeat(500) }, url);
  const counted = long.replace(url, "u".repeat(23));
  assert.ok([...counted].length <= 280, `X post too long: ${[...counted].length}`);
  assert.match(long, /…\n\n/);

  const li = composePost("linkedin", article, url);
  assert.equal(li, "Hello world\n\nA short summary.\n\n#news #c #bigdata");
  assert.ok(!li.includes(url));
  assert.ok(composePost("facebook", { ...article, summary: "s".repeat(9000) }, url).length <= 5000);
  assert.ok(composePost("linkedin", article, url, "My own words").startsWith("My own words"));
});

test("oauth1Header: stable HMAC-SHA1 signature with percent-encoded parts", () => {
  const c = { apiKey: "key", apiSecret: "secret", accessToken: "tok", accessSecret: "tsecret" };
  const a = oauth1Header("POST", "https://api.x.com/2/tweets", c, "nonce1", "1700000000");
  assert.equal(a, oauth1Header("POST", "https://api.x.com/2/tweets", c, "nonce1", "1700000000"));
  assert.match(a, /^OAuth oauth_consumer_key="key", oauth_nonce="nonce1", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1700000000", oauth_token="tok", oauth_version="1.0"$/);
  assert.notEqual(a, oauth1Header("POST", "https://api.x.com/2/tweets", { ...c, accessSecret: "other" }, "nonce1", "1700000000"));
});

test("httpPoster: request shapes and error messages", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (res: Response) => (async (url: string | URL | Request, init?: RequestInit) => (calls.push({ url: String(url), init: init! }), res.clone())) as typeof fetch;
  const ids = { linkedinAuthor: "urn:li:person:abc", facebookPageId: "123" };
  const post = { text: "Hi (there) #x", url: "https://e.com/a/x", title: "T", description: "D" };

  const li = await httpPoster(reply(new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:9" } })))("linkedin", { linkedin: { token: "t" } }, ids, post);
  assert.equal(li.url, "https://www.linkedin.com/feed/update/urn:li:share:9");
  const liBody = JSON.parse(String(calls[0].init.body));
  assert.equal(liBody.author, "urn:li:person:abc");
  assert.equal(liBody.commentary, "Hi \\(there\\) #x");
  assert.equal(liBody.content.article.source, post.url);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer t");

  const x = await httpPoster(reply(Response.json({ data: { id: "42" } }, { status: 201 })))("x", { x: { apiKey: "a", apiSecret: "b", accessToken: "c", accessSecret: "d" } }, ids, post);
  assert.equal(x.url, "https://x.com/i/status/42");
  assert.match((calls[1].init.headers as Record<string, string>).authorization, /^OAuth /);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { text: post.text });

  const fb = await httpPoster(reply(Response.json({ id: "123_456" })))("facebook", { facebook: { token: "pt" } }, ids, post);
  assert.equal(fb.id, "123_456");
  assert.match(calls[2].url, /\/123\/feed$/);
  const form = new URLSearchParams(String(calls[2].init.body));
  assert.equal(form.get("link"), post.url);
  assert.equal(form.get("access_token"), "pt");

  await assert.rejects(
    httpPoster(reply(Response.json({ error: { message: "Invalid OAuth access token" } }, { status: 400 })))("facebook", { facebook: { token: "pt" } }, ids, post),
    /Facebook \(400\): Invalid OAuth access token/,
  );
});

// ---- through the admin API ------------------------------------------------------------

const sent: { network: string; text: string; url: string; creds: unknown }[] = [];
let failNext: string | null = null;
const poster: SocialPoster = async (network, creds, _ids, post) => {
  if (failNext) {
    const msg = failNext;
    failNext = null;
    throw new Error(msg);
  }
  sent.push({ network, text: post.text, url: post.url, creds });
  return { id: `${network}-${sent.length}`, url: `https://${network}.example/post/${sent.length}` };
};
const { app, repo, social } = createApp({ db: openDb(":memory:"), provider: new MockProvider(), socialPoster: poster, socialDebounceMs: 5 });
const users = {
  owner: repo.createUser("o@s.com", "Owner", hashPassword("pw-owner-1")),
  editor: repo.createUser("e@s.com", "Editor", hashPassword("pw-editor-1")),
  author: repo.createUser("a@s.com", "Author", hashPassword("pw-author-1")),
};
const site = repo.createTenant({ slug: "soc", name: "Soc", ownerId: users.owner });
repo.setMembership(users.editor, site.id, "editor");
repo.setMembership(users.author, site.id, "author");
const other = repo.createTenant({ slug: "oth", name: "Oth", ownerId: users.owner });

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
  return { cookie: res.headers.get("set-cookie")!.split(";")[0], csrf: (await res.json()).csrf };
}
const call = (method: string, path: string, s: Session, body?: unknown) =>
  fetch(`${base}/admin/api${path}`, {
    method,
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const publish = (title: string, tenantId = site.id): number =>
  repo.createArticle(tenantId, { title, summary: `About ${title}`, blocks: markdownToBlocks("Body"), tags: ["news"], status: "published", source: "human" });

test("social settings: owner configures, secrets are encrypted and never returned, others can't configure", async () => {
  const owner = await login("o@s.com", "pw-owner-1");
  const editor = await login("e@s.com", "pw-editor-1");
  const author = await login("a@s.com", "pw-author-1");

  const first = await (await call("GET", "/t/soc/social", owner)).json();
  assert.equal(first.effectiveSiteUrl, null);
  assert.equal(first.networks.length, 3);
  assert.ok(first.networks.every((n: { gap: string | null }) => n.gap));
  assert.equal((await call("GET", "/t/soc/social", author)).status, 403);
  assert.equal((await call("PUT", "/t/soc/social", editor, { networks: ["x"], auto: true })).status, 403);
  assert.equal((await call("PUT", "/t/soc/social", owner, { networks: [], siteUrl: "http://insecure.example" })).status, 400);
  assert.equal((await call("PUT", "/t/soc/social", owner, { networks: [], linkedinAuthor: "nope" })).status, 400);

  const res = await call("PUT", "/t/soc/social", owner, {
    networks: ["linkedin", "x", "facebook", "bogus"],
    auto: false,
    siteUrl: "https://blog.example.com/",
    linkedinAuthor: "urn:li:person:abc123",
    facebookPageId: "998877",
    creds: {
      linkedin: { token: "li-secret-token" },
      x: { apiKey: "xk", apiSecret: "xs", accessToken: "xt", accessSecret: "xts" },
      facebook: { token: "fb-secret-token" },
    },
  });
  assert.equal(res.status, 200);
  const stored = repo.tenantSocialCreds(site.id)!;
  assert.ok(stored.startsWith("v1:") && !stored.includes("secret-token"), "credentials stored encrypted");
  assert.ok(!JSON.stringify(repo.tenantById(site.id)!.settings).includes("secret-token"), "no secrets in settings JSON");
  assert.ok(!JSON.stringify(repo.tenantById(site.id)).includes("v1:"), "ciphertext isn't on the Tenant object either");

  const data = await call("GET", "/t/soc/social", owner).then((r) => r.text());
  assert.ok(!data.includes("secret-token") && !data.includes('"xk"'), "secrets are never returned");
  const parsed = JSON.parse(data);
  assert.equal(parsed.effectiveSiteUrl, "https://blog.example.com");
  assert.ok(parsed.networks.every((n: { gap: string | null; enabled: boolean }) => n.enabled && n.gap === null));

  // Empty fields keep stored values; a partial update merges; clear removes one network.
  await call("PUT", "/t/soc/social", owner, { networks: ["x"], auto: false, siteUrl: "https://blog.example.com", linkedinAuthor: "urn:li:person:abc123", facebookPageId: "998877", creds: { x: { apiKey: "", apiSecret: "xs2" } }, clear: ["facebook"] });
  const { creds } = social.credentials(site.id);
  assert.equal(creds.x?.apiSecret, "xs2");
  assert.equal(creds.x?.apiKey, "xk");
  assert.equal(creds.facebook, undefined);
  assert.equal(creds.linkedin?.token, "li-secret-token");

  // PUT /settings must not reset the social configuration.
  const settings = await (await call("GET", "/t/soc/settings", owner)).json();
  assert.equal((await call("PUT", "/t/soc/settings", owner, settings)).status, 200);
  assert.deepEqual(repo.tenantById(site.id)!.settings.social.networks, ["x"]);
});

test("share now: posts to chosen networks with the article link; failures are recorded; drafts and unready networks are refused", async () => {
  const owner = await login("o@s.com", "pw-owner-1");
  const editor = await login("e@s.com", "pw-editor-1");
  await call("PUT", "/t/soc/social", owner, { networks: ["linkedin", "x", "facebook"], auto: false, siteUrl: "https://blog.example.com", linkedinAuthor: "urn:li:person:abc123", facebookPageId: "998877", creds: { facebook: { token: "fb2" } } });
  const a = publish("Shared story");
  const draft = repo.createArticle(site.id, { title: "Draft", blocks: markdownToBlocks("x"), status: "draft", source: "human" });
  const foreign = publish("Foreign", other.id);

  assert.equal((await call("POST", "/t/soc/social/post", owner, { articleId: draft, networks: ["x"] })).status, 409);
  assert.equal((await call("POST", "/t/soc/social/post", owner, { articleId: foreign, networks: ["x"] })).status, 404);
  assert.equal((await call("POST", "/t/soc/social/post", owner, { articleId: a, networks: [] })).status, 400);

  sent.length = 0;
  const ok = await call("POST", "/t/soc/social/post", editor, { articleId: a, networks: ["x", "linkedin"], text: "Custom words" });
  assert.equal(ok.status, 202);
  await social.idle();
  assert.deepEqual(sent.map((s) => s.network).sort(), ["linkedin", "x"]);
  const x = sent.find((s) => s.network === "x")!;
  assert.equal(x.url, "https://blog.example.com/a/shared-story");
  assert.equal(x.text, "Custom words #news\n\nhttps://blog.example.com/a/shared-story");

  failNext = "Facebook (400): token expired";
  await call("POST", "/t/soc/social/post", owner, { articleId: a, networks: ["facebook"] });
  await social.idle();
  const data = await (await call("GET", "/t/soc/social", owner)).json();
  const fb = data.posts.find((p: { network: string }) => p.network === "facebook");
  assert.equal(fb.status, "failed");
  assert.match(fb.error, /token expired/);
  assert.equal(data.posts.filter((p: { status: string }) => p.status === "posted").length, 2);
  assert.equal(data.busy, false);
});

test("auto-post: only articles published after turning it on, once per network, only on ready networks; failures aren't retried", async () => {
  const owner = await login("o@s.com", "pw-owner-1");
  const cfg = { networks: ["x", "linkedin"], siteUrl: "https://blog.example.com", linkedinAuthor: "urn:li:person:abc123", facebookPageId: "998877" };
  publish("Old story, published before auto");
  // The article's published_at has one-second resolution; make sure "after" is strictly later.
  await new Promise((r) => setTimeout(r, 1100));
  sent.length = 0;
  assert.equal((await call("PUT", "/t/soc/social", owner, { ...cfg, auto: true })).status, 200);
  assert.ok(repo.tenantById(site.id)!.settings.social.autoSince);

  const fresh = publish("Fresh story");
  repo.createArticle(site.id, { title: "Still a draft", blocks: markdownToBlocks("x"), status: "draft", source: "human" });
  await social.idle();
  assert.deepEqual(sent.filter((s) => s.url.endsWith("/fresh-story")).map((s) => s.network).sort(), ["linkedin", "x"]);
  assert.equal(sent.filter((s) => !s.url.endsWith("/fresh-story")).length, 0, "old articles and drafts are not posted");

  // Further changes don't repost.
  repo.setArticleStatus(site.id, fresh, "published");
  await social.idle();
  assert.equal(sent.length, 2);

  // A failure is recorded and not retried by later changes.
  failNext = "403: duplicate content"; // consumed by the first network posted (LinkedIn)
  const second = publish("Second fresh story");
  await social.idle();
  publish("Third fresh story");
  await social.idle();
  const rows = repo.socialPosts(site.id, 50).filter((p) => p.article_id === second);
  assert.equal(rows.filter((p) => p.status === "failed").length, 1);
  assert.deepEqual(rows.map((p) => p.network).sort(), ["linkedin", "x"], "one attempt per network, however many later changes");
  assert.equal(rows.find((p) => p.network === "linkedin")!.status, "failed");
  assert.equal(rows.find((p) => p.network === "x")!.status, "posted");

  // Turning auto off stops it.
  await call("PUT", "/t/soc/social", owner, { ...cfg, auto: false });
  sent.length = 0;
  publish("Quiet story");
  await social.idle();
  assert.equal(sent.length, 0);
});
